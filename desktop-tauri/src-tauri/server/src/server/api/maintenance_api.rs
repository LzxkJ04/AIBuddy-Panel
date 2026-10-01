//! 维护模式（安全与运维切片，功能三）。
//!
//! ```text
//! GET /api/maintenance   读当前开关
//! PUT /api/maintenance   开 / 关（body `{enabled: bool}`），持久化到配置
//! ```
//!
//! 开启后**转发面**（`/v1/*`）对一切请求返回 503「系统维护中」，面板与
//! `/api/*` 管理接口不受影响 —— 管理员必须还能进面板把它关掉。拦截点在
//! `http.rs` 的 `require_api_key`（与 `/v1` fail-closed 同一处判定链），
//! 由主会话接线，代码片段见本函数 [`maintenance_response`] 的文档。
//!
//! ── 状态的三个形态（内存原子 + 配置键）──────────────────────
//!   - **内存**：`AtomicBool`。拦截在转发热路径上，判定只能是一次原子读
//!     （对照 `access::v1_fail_closed` 的同一手法）—— 不能每请求去克隆
//!     整份配置快照；
//!   - **落盘**：配置键 [`KEY_MAINTENANCE_MODE`]（`config` 顶层键 → `kv`
//!     表的一行，与 `debugMode` 同类开关），经 `config::update_raw_field`
//!     写入 —— 走既有配置管线，不新增保留键、不动 schema；
//!   - **初始化**：进程内首次读到开关时（`get_or_init`）从配置快照装一次，
//!     之后读不再碰配置。配置导入会整表替换 `kv`，导入路径要调
//!     [`refresh_from_config`] 让内存标志与库对齐（backup_api 已接）。
//!
//! 写盘失败时内存标志照样生效（本次运行内维护中），只打一行 ⚠️ 日志 ——
//! 与 queue / timeouts 等 setter 的「内存先生效、落盘尽力而为」同一取向。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::server::api::audit_api;
use crate::server::config;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// 维护开关的配置键（config 顶层键，即 kv 表的行名）。
///
/// 键名核对过不与 `db::schema::RESERVED_KV_KEYS` 相撞 —— 它是配置项
/// （要进 config 快照的 raw 底稿），与保留键分属两类，撞名反而会被
/// 配置写入删掉。
pub const KEY_MAINTENANCE_MODE: &str = "maintenanceMode";

/// 维护中的内存标志（转发热路径判定用）
static MAINTENANCE: AtomicBool = AtomicBool::new(false);
/// 配置只装一次的标记
static LOADED: OnceLock<()> = OnceLock::new();

/// 从配置快照读落盘值
fn read_config() -> bool {
    config::current()
        .raw()
        .get(KEY_MAINTENANCE_MODE)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// 维护模式当前是否开启（http.rs 的 /v1 拦截点调用；一次原子读）。
///
/// 首次调用时从配置快照装载（`get_or_init` 保证只装一次，此后热路径
/// 零配置开销）。配置尚未初始化时读到的自然是「关」—— 与其它配置项
/// 的未初始化语义一致。
pub fn maintenance_enabled() -> bool {
    LOADED.get_or_init(|| MAINTENANCE.store(read_config(), Ordering::Relaxed));
    MAINTENANCE.load(Ordering::Relaxed)
}

/// 让内存标志与配置重新对齐（**配置导入后必须调用**：导入整表替换 kv，
/// 落盘的开关可能被快照改写，内存标志不会自己知道）。
pub fn refresh_from_config() {
    MAINTENANCE.store(read_config(), Ordering::Relaxed);
    let _ = LOADED.set(());
}

/// GET /api/maintenance
pub async fn get_maintenance(State(_state): State<ServerState>) -> Response {
    ok_json(json!({ "enabled": maintenance_enabled() }))
}

/// PUT /api/maintenance —— body `{enabled: bool}`（仅接受布尔，缺省给 400：
/// 「改成开还是关」没有合理的缺省语义，静默忽略会让按钮看起来没反应）。
pub async fn put_maintenance(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(enabled) = payload.get("enabled").and_then(Value::as_bool) else {
        return errors::management_error(400, "请求体必须包含布尔字段 enabled");
    };
    MAINTENANCE.store(enabled, Ordering::Relaxed);
    if !config::update_raw_field(KEY_MAINTENANCE_MODE, Value::Bool(enabled)) {
        logging::log("[Config]", "⚠️  维护模式写入失败，本次运行内仍生效");
    }
    audit_api::audit(
        "maintenance.toggle",
        &format!("维护模式已{}", if enabled { "开启（/v1/* 暂停转发）" } else { "关闭" }),
    );
    logging::log(
        "[Security]",
        &format!("维护模式已{}", if enabled { "开启" } else { "关闭" }),
    );
    ok_json(json!({ "enabled": enabled }))
}

/// 维护中给 `/v1/*` 的 503 响应（http.rs 拦截点用）。
///
/// `/v1/*` 的客户端是 OpenAI 兼容程序，错误体用 **OpenAI 风格**（与
/// `errors::v1_fail_closed_response` 同一形状），不是管理 API 信封。
/// 本函数不判条件 —— 条件判断与放行逻辑都在拦截点，这里只负责形状：
///
/// ```ignore
/// // http.rs · require_api_key 开头（fail-closed 判定之前）：
/// let path = request.uri().path();
/// if crate::server::api::maintenance_api::maintenance_enabled()
///     && path.starts_with("/v1/")
/// {
///     return crate::server::api::maintenance_api::maintenance_response();
/// }
/// ```
pub fn maintenance_response() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": {
                "message": "系统维护中：网关已暂停转发，请稍后重试，或联系管理员在面板关闭维护模式",
                "type": "maintenance_mode",
            }
        })),
    )
        .into_response()
}
