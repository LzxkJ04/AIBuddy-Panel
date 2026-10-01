//! 网关 Key 的**额度计量与准入判定** —— `quotaTokens` / `expiresAt` 两个限制
//! 的唯一消费点（存储在 `core::api_keys`，随 `KeyScope` 传播见 `core::key_scope`）。
//!
//! ── 两个限制各自的判定口径 ───────────────────────────────────
//!   - **有效期**（`expiresAt`，毫秒时间戳）：纯时间比较，`now >= expiresAt`
//!     即过期（见 `key_scope::KeyScope::expired` 的说明）。不落库、不计量。
//!   - **Token 配额**（`quotaTokens`）：需要**累计**每把 Key 消耗的 Token，
//!     所以落库；判定是「已用 ≥ 配额 → 拒绝」。
//!
//! ── 计量点与判定点是分开的（故意）────────────────────────────
//! 判定（[`check_scope`]）发生在转发**开始前**：超配额 / 过期的请求连上游都
//! 不该碰。计量（[`add_usage`]）发生在**收尾记账**时：此刻才知道这次真实用了
//! 多少 Token（采集点在 `core::upstream::usage` 的旁路槽）。两条各接各的埋点
//! （见 `api::key_quota_api` 的模块头），中间靠 `KeyScope::key_id` 对上号。
//!
//! ── 计量为什么允许「事后补记」而不是预扣 ──────────────────────
//! 预扣（请求开始先记一个估计值、结束再冲正）要处理「请求失败要不要回冲」
//! 「冲正自身失败怎么办」两套补偿状态；事后补记最坏情形是「最后一个大请求
//! 冲破配额一点」—— 对本地铁额语义完全可以接受，换来的是零补偿状态。
//!
//! ── 存储：kv 的 `keyQuotaUsage` 键（不是独立表）───────────────
//! 形态 `{"<keyId>": {"usedTokens": n, "updatedAt": ms}}`，整份读写。条目数量
//! 就是 Key 的数量（几个到几十个）、永远是整份进出，与 `core::proxy_pool` /
//! `core::task_state` 同一类「kv 固定键 + 整份读写」的零散状态 —— 已登记进
//! `db::schema::RESERVED_KV_KEYS`（否则 `config::save_raw` 写一次配置就会把它
//! 删掉）。不新增表也就**不动 schema 版本**（理由同 `proxy_pool` 的模块头）。
//!
//! ── 原子性：读改写必须在一个 IMMEDIATE 事务里 ─────────────────
//! 两个并发请求同时收尾时，「读已用 → 加 → 写回」若不进同一把写锁，就会互相
//! 覆盖、丢一次累计。桌面壳允许开发版与正式版并存且**共用同一个库文件**，
//! 所以用 `TransactionBehavior::Immediate` 先拿写锁再读（与 `core::task_state`
//! 的 `change` 同一手法、同一理由），跨进程也不会丢计数。
//!
//! ── 数据库不可用时宁可放行 ──────────────────────────────────
//! 判定读不到已用数（`used_tokens` 返回 0）会让带配额的 Key 暂时不受限 ——
//! 这是有意的：本项目「数据库的问题不该让服务崩，但也绝不悄悄给出错误答案」
//! （见 `db` 模块头），配额计量挂了就如实降级成「暂不限制」，每次都打一行
//! verbose 日志（控制台恒可见），不静默。删除 Key 不清理计量行：残留几行
//! 无害（Key 已不存在就没有判定会读它），下次同一 id 也不会复活（id 含时间戳）。

use std::sync::OnceLock;

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{Map, Value};

use crate::server::core::key_scope::KeyScope;
use crate::server::db::Db;
use crate::server::logging;

/// `kv` 表里的键名（保留键，见 `db::schema::RESERVED_KV_KEYS`）
pub const KV_KEY: &str = "keyQuotaUsage";

/// 进程级库句柄（照 `core::task_state` / `core::proxy_pool` 的形态：
/// `ServerState::bootstrap` 时 install 一次）
static DB: OnceLock<Option<Db>> = OnceLock::new();

/// 接线（`ServerState::bootstrap` 调用）。重复调用无副作用。
pub fn install(db: Option<Db>) {
    let _ = DB.set(db);
}

fn database() -> Result<&'static Db, String> {
    DB.get()
        .and_then(Option::as_ref)
        .ok_or_else(|| "额度计量数据库不可用".to_string())
}

/// 读整份用量表（库损坏 / 手工改坏 → 空表重开：这一行只影响计量，
/// 从零重计比整条链路报错更可恢复，理由同 `proxy_pool::read_items`）
fn read_usage(conn: &rusqlite::Connection) -> Map<String, Value> {
    let text: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key = ?1", [KV_KEY], |row| row.get(0))
        .optional()
        .ok()
        .flatten();
    let Some(text) = text else {
        return Map::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// 单条用量记录的「已用 Token」读数（记录缺失 / 形态不对 → 0）
fn used_of(entry: Option<&Value>) -> i64 {
    entry
        .and_then(|value| value.get("usedTokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0)
}

/// 当前已用 Token（Key 还没消耗过 / 库不可用 → 0）。
///
/// 判定入口 [`check_scope`] 用它做**放行**方向的兜底（见模块头「宁可放行」），
/// 所以失败不返回 `Result`，而是返回 0 并打一行 verbose —— 调用方不必处理
/// 「读失败要不要拦」这个没有正确答案的问题。
pub fn used_tokens(key_id: &str) -> i64 {
    let Ok(db) = database() else {
        logging::verbose("[Quota]", "❌ 额度计量数据库不可用，本次按 0 已用放行");
        return 0;
    };
    let used = db.with(|conn| {
        let map = read_usage(conn);
        used_of(map.get(key_id))
    });
    match used {
        Some(used) => used,
        None => {
            logging::verbose("[Quota]", "❌ 读取 Key 用量失败（连接锁异常），本次按 0 已用放行");
            0
        }
    }
}

/// 累计一次用量（`tokens` 为本次请求消耗的 Token 总数），返回累计后的值。
///
/// 收尾记账埋点调用（建议接线点：`api::pipeline::record_entry`，那里刚拿到
/// telemetry 快照里的 `total_tokens`）。`key_id` 为空（免鉴权 / 环境变量 Key，
/// 本来就没有记录可挂）或 `tokens <= 0`（没发出去 / 没有用量读数）时是
/// no-op —— 不给空 Key 计量，也避免全零行把表越写越大。
///
/// 返回 `Err` 只可能是库不可用 / 写盘失败：**记账失败绝不影响请求本身**
/// （调用点在收尾路径，请求已经结束），照 `RequestStats::record` 的口径
/// 由调用方打一行日志即可。
pub fn add_usage(key_id: &str, tokens: i64) -> Result<i64, String> {
    if key_id.is_empty() || tokens <= 0 {
        return Ok(used_tokens(key_id));
    }
    let db = database()?;
    let now = logging::now_ms();
    let key = key_id.to_string();
    db.with_mut(|conn| {
        // 先拿写锁再读（Immediate），「读已用 → 加 → 写回」整体原子，
        // 并发收尾与双实例都不会丢计数（见模块头）
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("锁定额度计量失败: {error}"))?;
        let mut usage = read_usage(&tx);
        let used = used_of(usage.get(&key)).saturating_add(tokens);
        usage.insert(
            key,
            serde_json::json!({ "usedTokens": used, "updatedAt": now }),
        );
        let text = serde_json::to_string(&Value::Object(usage))
            .map_err(|error| format!("编码额度计量失败: {error}"))?;
        tx.execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![KV_KEY, text],
        )
        .map_err(|error| format!("保存额度计量失败: {error}"))?;
        tx.commit().map_err(|error| format!("提交额度计量失败: {error}"))?;
        Ok(used)
    })
    .ok_or_else(|| "额度计量数据库不可用".to_string())?
}

/// 清零一把 Key 的用量（管理页改配额时勾选「重置用量」走这里）。
///
/// 直接整键移除而不是写 0：没有记录 = 从未消耗，与清零同义且少一行数据。
pub fn reset_usage(key_id: &str) -> Result<(), String> {
    if key_id.is_empty() {
        return Ok(());
    }
    let db = database()?;
    let key = key_id.to_string();
    db.with_mut(|conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("锁定额度计量失败: {error}"))?;
        let mut usage = read_usage(&tx);
        usage.remove(&key);
        let text = serde_json::to_string(&Value::Object(usage))
            .map_err(|error| format!("编码额度计量失败: {error}"))?;
        tx.execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![KV_KEY, text],
        )
        .map_err(|error| format!("保存额度计量失败: {error}"))?;
        tx.commit().map_err(|error| format!("提交额度计量失败: {error}"))?;
        Ok(())
    })
    .ok_or_else(|| "额度计量数据库不可用".to_string())?
}

/// 转发**开始前**的准入判定：过期 / 超配额 → `Err(给客户端的文案)`。
///
/// 转发链路埋点调用（建议接线点：`api::chat` / `api::protocol` 三个入口
/// handler 取出 `scope` 之后、解析模型之前；`Err` 映射成
/// `GatewayError::with_status(403, message)` 并走 `record_early_failure`）。
///
/// 三条「没有命中的 Key」的情形（免鉴权 / 环境变量 Key / 未知 Key）里
/// `scope` 是 `None` —— 与白名单同一语义：**不限制**（见 `core::key_scope`
/// 模块头），直接放行。
pub fn check_scope(scope: Option<&KeyScope>) -> Result<(), String> {
    let Some(scope) = scope else {
        return Ok(());
    };
    if scope.key_id().is_empty() {
        return Ok(());
    }
    // 有效期先判：过期了连配额读数都不必看
    if scope.expired(logging::now_ms()) {
        return Err("Key 已过期".to_string());
    }
    // 配额只在真的设了限（>0）时才去读库 —— 不限量的 Key 零额外开销
    if let Some(quota) = scope.quota_tokens().filter(|quota| *quota > 0) {
        let used = used_tokens(scope.key_id());
        if used >= quota {
            return Err("Key 配额已用尽".to_string());
        }
    }
    Ok(())
}

/// 记账键：`KeyScope` 里的 Key 记录 id（`None` = 免鉴权 / 环境变量 Key /
/// 未知 Key → 空串，[`add_usage`] 对空串是 no-op）。
///
/// 三个协议入口在 `scope` 被 move 进转发层**之前**调它一次，取出的串随
/// `RecordContext` 带到收尾记账（见 `api::pipeline` 的字段说明）——
/// 收尾时 handler 栈帧早已不在，`KeyScope` 拿不回来，所以必须提前抄走。
pub fn key_id_of(scope: Option<&KeyScope>) -> String {
    scope
        .map(|scope| scope.key_id().to_string())
        .unwrap_or_default()
}
