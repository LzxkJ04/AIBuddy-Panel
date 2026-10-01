//! GET /health —— 壳侧就绪探测与前端首屏健康摘要。
//!
//! shape 逐字段对齐 Node 版 server.mjs handleHealth（562-584 行）：
//!   status 按「上游是否配置」（configured 才 ok，否则 degraded）/
//!   upstreamBaseUrl / authApiBase / chatApiUrl / authSource / currentAccountId /
//!   tokenExpiresAt / canRefresh 全来自 `auth.get_config_summary()`；
//!   login 为 `auth.get_status()` 的完整形态（已登录/未登录两分支）；
//!   authRequired 按是否配置了 API Key / defaultModel / models 数量。
//!
//! 注意 /health 返回**裸对象**（不是 `{success,data}` 信封）—— Node 版这里
//! 用的是 sendJson 直接发对象，与 /api/* 不同。
//!
//! `get_config_summary()` 是纯本地的（只查凭证是否存在，不发网络请求），
//! 所以 health 不需要等转发链路。
//!
//! `models` 是目录条数（切片 4 起为真值）：Node 版取 `modelCatalog.list().length`，
//! 目录未刷新过时就是内置清单的条数，刷新后是远程清单的条数 ——
//! 这个字段只反映「当前内存里的目录」，不触发刷新（刷新由启动流程与
//! GET /v1/models 负责，/health 保持纯本地语义）。
//!
//! `channels` 是**每 provider 一键**的渠道健康（对照 Buddy2API 的
//! health.channels，见 `channels_json`）：账号库的本地统计，纯只读。
//! 门控形态（panel_gate / fail-closed 的 `{"status":"ok"}`）**不带**它 ——
//! 公网上不泄漏渠道结构。

use std::collections::BTreeMap;

use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Map, Value};

use crate::server::config;
use crate::server::core::{custom_providers, providers};
use crate::server::http::raw_json;
use crate::server::ServerState;

/// 进程启动时刻（首次取用即记录）：/health 的 uptimeSeconds 数据源。
fn process_start() -> std::time::Instant {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    *START.get_or_init(std::time::Instant::now)
}

/// 进程已运行秒数（/health 展示用；面板「网关健康」面板读取）。
pub fn health_uptime_seconds() -> u64 {
    process_start().elapsed().as_secs()
}

/// 上游未配置时的说明文案。
///
/// 与 `core::auth::UNCONFIGURED_REASON` 同一份 —— Node 版这条有两处措辞：
/// `getConfigSummary()` 的「尚未登录（node server.mjs --login）」与启动横幅的
/// 「暂无可用登录态」。壳内 Rust 版没有那个命令行入口（登录走 UI 的
/// /api/session/login/*），指向一个不存在的命令只会误导用户，因此统一取后者。
pub const UNCONFIGURED_REASON: &str = crate::server::core::auth::UNCONFIGURED_REASON;

/// 处理 GET /health
pub async fn handle(State(state): State<ServerState>) -> Response {
    // headless 的安全形态（未注册闸门 / /v1 fail-closed）下只回答「进程活着」：
    // 完整摘要会把上游地址、登录状态、模型数量递给公网上的探测者。
    // 探活方（Docker HEALTHCHECK / 反代）只看状态码与 status 字段，不受影响；
    // 桌面壳与面板首屏不受影响 —— 那两种形态下闸门与 fail-closed 都不会开启。
    if crate::server::access::panel_gate() || crate::server::access::v1_fail_closed() {
        return raw_json(json!({ "status": "ok" }));
    }
    let snapshot = config::current();
    let summary = state.auth().get_config_summary();
    let status = state.auth().get_status();
    let healthy = summary
        .get("configured")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    raw_json(json!({
        "status": if healthy { "ok" } else { "degraded" },
        "transport": "upstream-api",
        "product": "AIBuddy Panel",
        "version": env!("CARGO_PKG_VERSION"),
        "uptimeSeconds": (health_uptime_seconds()) as i64,
        "upstreamConfigured": healthy,
        "upstreamBaseUrl": summary.get("baseUrl").cloned().unwrap_or(Value::Null),
        "authApiBase": summary.get("authApiBase").cloned().unwrap_or(Value::Null),
        "chatApiUrl": summary.get("chatApiUrl").cloned().unwrap_or(Value::Null),
        "authSource": summary.get("authSource").cloned().unwrap_or(Value::Null),
        "currentAccountId": summary.get("currentAccountId").cloned().unwrap_or(Value::Null),
        "tokenExpiresAt": summary.get("tokenExpiresAt").cloned().unwrap_or(Value::Null),
        "canRefresh": summary.get("canRefresh").and_then(Value::as_bool).unwrap_or(false),
        "login": status,
        "unavailableReason": if healthy {
            Value::Null
        } else {
            summary
                .get("unavailableReason")
                .cloned()
                .unwrap_or_else(|| Value::String(UNCONFIGURED_REASON.to_string()))
        },
        "authRequired": snapshot.api_key_set(),
        "defaultModel": snapshot.default_model(),
        // 模型目录条数（对照 Node 的 `models: modelCatalog.list().length`）——
        // 切片 4 起是真值：目录未刷新过时是内置清单条数，刷新后是远程清单条数
        "models": state.models().count(),
        // 每 provider 一键的渠道健康（对照 Buddy2API 的 health.channels）；
        // 门控形态在上面提前返回，公网看不到这个结构
        "channels": channels_json(&state),
    }))
}

/// `channels` 结构：`{ "<providerId>": {"accounts": N, "active": N, "loaded": bool} }`。
///
/// ── 数据来源 ────────────────────────────────────────────────
/// 账号库的本地统计（纯只读、不发网络请求，与 /health 的其余字段同语义）：
/// `store().list_accounts()` 一次快照（storage_api 同款读法），公开形态里
/// `provider` / `enabled` 恒有（`store_view::public_account` 统一注入，
/// provider 缺失时按 workbuddy 兜底），按 provider 分组计数即可：
///   - `accounts`：该 provider 名下账号**总数**（含禁用，与账号页分组标题同口径）；
///   - `active`：其中 `enabled` 为真的条数（选路会跳过禁用账号，
///     「这一家现在还有几发可用」看它）；
///   - `loaded`：账号库是否打开（`db()` 可用）。库打不开时各计数都是回落
///     的 0，与「真的没有账号」无法区分 —— 与 storage_api 的 `available`
///     同一处理：让读者知道「0 是没读到，不是没有」。
///
/// ── 为什么 0 也列出 ─────────────────────────────────────────
/// 照 Buddy2API 的 health.channels 全渠道罗列：键集取「内置注册表
/// （`providers::PROVIDERS`，顺序稳定）∪ 自定义提供商 ∪ 账号里出现过的
/// 陌生 id」—— 注册了的渠道哪怕一个账号都没有也在场（监控一眼看出
/// 「这家还没配」），只列有账号的家会让「渠道消失」与「账号清空」混淆。
/// 陌生 id 照 `provider_summary` 的容错口径原样透出，不静默吞掉。
///
/// 键序：serde_json 的 Map 按字典序输出（本 crate 未开 preserve_order），
/// 与注册表顺序无关但**稳定**，监控按键取值不受影响。
fn channels_json(state: &ServerState) -> Value {
    let snapshot = state.store().list_accounts();
    let empty = Vec::new();
    let accounts = snapshot
        .get("accounts")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    // (总数, 启用数)，按 provider 分组 —— BTreeMap 只为去重，键序由上面的
    // 键集合并顺序决定
    let mut totals: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for record in accounts {
        let provider = record
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or(crate::server::core::providers::DEFAULT_PROVIDER_ID);
        let enabled = record.get("enabled").and_then(Value::as_bool).unwrap_or(false);
        let entry = totals.entry(provider.to_string()).or_insert((0, 0));
        entry.0 += 1;
        if enabled {
            entry.1 += 1;
        }
    }
    let loaded = state.db().is_some();
    let mut channels = Map::new();
    for meta in providers::PROVIDERS {
        insert_channel(&mut channels, meta.id, &totals, loaded);
    }
    for custom in custom_providers::list() {
        if let Some(id) = custom.get("id").and_then(Value::as_str) {
            insert_channel(&mut channels, id, &totals, loaded);
        }
    }
    // 账号里出现、但不属于上面两份清单的 id（手改数据塞进来的陌生家）：
    // 照列而不是丢弃 —— 渠道健康要对得上账号页看到的分组
    for id in totals.keys() {
        insert_channel(&mut channels, id, &totals, loaded);
    }
    Value::Object(channels)
}

/// 把一个 provider 的渠道行写进 `channels`（已有同名键不覆盖 —— 内置注册表
/// 与自定义清单理论不相交，这里只为防御将来清单重叠时后写覆盖先写）。
fn insert_channel(
    channels: &mut Map<String, Value>,
    id: &str,
    totals: &BTreeMap<String, (usize, usize)>,
    loaded: bool,
) {
    if channels.contains_key(id) {
        return;
    }
    let (accounts, active) = totals.get(id).copied().unwrap_or((0, 0));
    channels.insert(
        id.to_string(),
        json!({
            "accounts": accounts as u64,
            "active": active as u64,
            "loaded": loaded,
        }),
    );
}
