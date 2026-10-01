//! 配置导入导出 + 定时备份设置（安全与运维切片，功能四的接口层）。
//!
//! ```text
//! GET  /api/backup/export    导出 JSON 快照（kv 全表 + accounts 全表）
//! POST /api/backup/import    导入快照（覆盖语义：body 须带 confirm:true）
//! GET  /api/backup/settings  定时备份设置 + 上次执行状态
//! PUT  /api/backup/settings  改设置（body `{enabled?, keep?}`，允许部分字段）
//! POST /api/backup/run       立即执行一次备份
//! ```
//!
//! 全部挂 protected：导出是**全量数据外带**（含管理员哈希、API Key 明文、
//! 账号凭证 —— 等于把整台网关装进口袋），导入是**整表覆盖**。这是全系统
//! 最敏感的一组接口，与 /api/keys 同组、语义上更重。
//!
//! ── 两条备份路径的分工 ──────────────────────────────────────
//!   - **JSON 快照（本文件）**：kv 全表 + accounts 全表的行级导出与恢复，
//!     服务「配置搬家 / 坏库重建」。kv 行里**已经包含**全部设置 —— 网关
//!     配置（apiKeys / modelRules…）、桌面设置、管理员（panelAdmin）、
//!     刷新令牌（panelTokens）、本切片的维护开关与备份设置，都是 kv 的行；
//!     「设置」不另立小节，就是这些行的子集。
//!   - **整库快照文件（`core::backup`）**：`VACUUM INTO` 的 .db 文件，服务
//!     本机定时兜底与灾难恢复（连日志统计一起带上）。两者互不替代。
//!
//! ── 导入的覆盖语义 ──────────────────────────────────────────
//! 一个事务内：`DELETE FROM kv` + `DELETE FROM accounts` 后按快照逐行重插
//! —— 是「恢复到快照那一刻」，不是合并。请求体必须带 `"confirm": true`
//! 才执行（缺省一律 400），这是需求明确的覆盖确认护栏。导入完成后：
//!   - `config::reload()` 重读配置快照（内存里的生效配置立刻与库对齐）；
//!   - `access::load_refresh_tokens()` 重载会话链表（panelTokens 被替换了
//!     —— **调用方的刷新令牌可能已不在其中**，access 过期后要用快照里的
//!     管理员账号重新登录；响应里的 `warning` 字段会说明这一点）；
//!   - `maintenance_api::refresh_from_config()` 对齐维护开关的内存标志。
//!
//! ── 导入为什么直写 SQL 而不走 AccountStore ──────────────────
//! AccountStore 的导入路径是**合并**（保留现有账号、按 id 去重并入），
//! 而本接口的语义是**整表替换**；且 `AccountStore::load` 每次都从库现读
//! （无独立内存快照），事务提交后的下一笔账号请求看到的就是导入结果。
//! 行的六个列原样搬（`data` 列是权威副本），不经过 StoredAccount 解析
//! —— 快照本身来自同一张表，逐列回写是无损的。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use rusqlite::params;
use serde_json::{json, Value};

use crate::server::access;
use crate::server::api::audit_api;
use crate::server::api::maintenance_api;
use crate::server::config;
use crate::server::core::{backup, task_state};
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// 快照格式标识与版本（导入时校验，防止把随手贴来的 JSON 当快照执行覆盖）
const SNAPSHOT_KIND: &str = "agent2api-backup";
const SNAPSHOT_VERSION: i64 = 1;

// ─── 导出 ───────────────────────────────────────────────────

/// GET /api/backup/export —— JSON 快照。
///
/// `kv[].value` 是**落库的 JSON 原文**（字符串，与库里逐字节一致），
/// `accounts[].data` 解析成对象（它是权威副本，原文就是 JSON）。
/// 导入接受本响应的 `data` 部分，也接受整份信封（见 `extract_snapshot`）。
pub async fn get_export(State(state): State<ServerState>) -> Response {
    let Some(db) = state.db() else {
        return errors::management_error(503, "数据库不可用，无法导出");
    };
    let snapshot = match db.with(|conn| -> Result<Value, String> {
        let mut kv_rows = Vec::new();
        {
            let mut stmt = conn
                .prepare("SELECT key, value FROM kv ORDER BY key")
                .map_err(|error| format!("读取 kv 表失败: {error}"))?;
            let rows = stmt
                .query_map(params![], |row| {
                    Ok(json!({
                        "key": row.get::<_, String>(0)?,
                        "value": row.get::<_, String>(1)?,
                    }))
                })
                .map_err(|error| format!("读取 kv 表失败: {error}"))?;
            for row in rows {
                kv_rows.push(row.map_err(|error| format!("读取 kv 表失败: {error}"))?);
            }
        }
        let mut accounts = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT id, provider, priority, enabled, added_at, data
                     FROM accounts ORDER BY id",
                )
                .map_err(|error| format!("读取账号表失败: {error}"))?;
            let rows = stmt
                .query_map(params![], |row| {
                    let raw: String = row.get(5)?;
                    let data = match serde_json::from_str::<Value>(&raw) {
                        Ok(value) => value,
                        // 手改过的库可能出现非法 JSON：原样带出，导入端
                        // 按字符串回写，保证导出导入一个来回不丢字节
                        Err(_) => Value::String(raw),
                    };
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "provider": row.get::<_, String>(1)?,
                        "priority": row.get::<_, i64>(2)?,
                        "enabled": row.get::<_, i64>(3)?,
                        "addedAt": row.get::<_, i64>(4)?,
                        "data": data,
                    }))
                })
                .map_err(|error| format!("读取账号表失败: {error}"))?;
            for row in rows {
                accounts.push(row.map_err(|error| format!("读取账号表失败: {error}"))?);
            }
        }
        let kv_count = kv_rows.len();
        let account_count = accounts.len();
        Ok(json!({
            "kind": SNAPSHOT_KIND,
            "version": SNAPSHOT_VERSION,
            "exportedAt": logging::now_ms(),
            "sourceFile": db.file().to_string_lossy(),
            "counts": { "kv": kv_count, "accounts": account_count },
            "kv": kv_rows,
            "accounts": accounts,
        }))
    }) {
        Some(Ok(value)) => value,
        Some(Err(message)) => return errors::management_error(500, message),
        None => return errors::management_error(503, "数据库不可用，无法导出"),
    };
    audit_api::audit(
        "backup.export",
        &format!(
            "导出快照（kv {} 行、账号 {} 条）",
            snapshot["counts"]["kv"].as_u64().unwrap_or(0),
            snapshot["counts"]["accounts"].as_u64().unwrap_or(0),
        ),
    );
    ok_json(snapshot)
}

// ─── 导入 ───────────────────────────────────────────────────

/// POST /api/backup/import —— 覆盖导入（body 须带 `confirm: true`）。
///
/// 快照可以在请求体顶层（与 confirm 并列），也可以把导出接口的整份信封
/// 原样贴回（快照在 `data` 里）。
pub async fn post_import(State(state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    if payload.get("confirm").and_then(Value::as_bool) != Some(true) {
        return errors::management_error(
            400,
            "导入会整表覆盖现有配置与账号：请在请求体中携带 \"confirm\": true 明确确认",
        );
    }
    let Some(snapshot) = extract_snapshot(&payload) else {
        return errors::management_error(
            400,
            "请求体中未找到备份快照（需要 kind 为 \"agent2api-backup\" 的对象，或导出接口的完整响应）",
        );
    };
    if snapshot.get("version").and_then(Value::as_i64) != Some(SNAPSHOT_VERSION) {
        return errors::management_error(400, "快照版本不受支持，请用同版本网关导出的快照");
    }
    // 先全部解析成自有数据再进事务：校验错误在 400 里逐条指路，
    // 事务闭包里只剩「纯写入」，不碰 Value 的借用
    let kv_rows = match parse_kv_rows(snapshot) {
        Ok(rows) => rows,
        Err(message) => return errors::management_error(400, message),
    };
    let account_rows = match parse_account_rows(snapshot) {
        Ok(rows) => rows,
        Err(message) => return errors::management_error(400, message),
    };

    let Some(db) = state.db() else {
        return errors::management_error(503, "数据库不可用，导入未执行");
    };
    let outcome = db.with_mut(|conn| -> Result<(usize, usize), String> {
        // IMMEDIATE：与 task_state 同一理由 —— 双实例共用库时先拿写锁，
        // 避免「清空 → 重插」中途被另一个进程的写入插进半套状态
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("开启导入事务失败: {error}"))?;
        tx.execute("DELETE FROM kv", params![])
            .map_err(|error| format!("清空 kv 表失败: {error}"))?;
        tx.execute("DELETE FROM accounts", params![])
            .map_err(|error| format!("清空账号表失败: {error}"))?;
        for row in &kv_rows {
            tx.execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2)",
                params![row.0, row.1],
            )
            .map_err(|error| format!("写入 kv 行失败: {error}"))?;
        }
        for row in &account_rows {
            tx.execute(
                "INSERT INTO accounts (id, provider, priority, enabled, added_at, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![row.id, row.provider, row.priority, row.enabled, row.added_at, row.data],
            )
            .map_err(|error| format!("写入账号行失败: {error}"))?;
        }
        tx.commit().map_err(|error| format!("提交导入事务失败: {error}"))?;
        Ok((kv_rows.len(), account_rows.len()))
    });

    let (kv_count, account_count) = match outcome {
        Some(Ok(counts)) => counts,
        Some(Err(message)) => {
            logging::log("[Backup]", &format!("❌ 配置导入失败：{message}"));
            return errors::management_error(500, message);
        }
        None => return errors::management_error(503, "数据库不可用，导入未执行"),
    };

    // 三个内存态与库对齐（细节见模块头）。日志在所有锁外打。
    config::reload();
    access::load_refresh_tokens();
    maintenance_api::refresh_from_config();
    audit_api::audit(
        "backup.import",
        &format!("覆盖导入完成（kv {kv_count} 行、账号 {account_count} 条）"),
    );
    logging::log(
        "[Backup]",
        &format!("✅ 配置导入完成（kv {kv_count} 行、账号 {account_count} 条）"),
    );
    ok_json(json!({
        "imported": { "kv": kv_count, "accounts": account_count },
        "warning": "导入已整表覆盖：当前登录的刷新令牌可能已失效，access 过期后需用快照中的管理员账号重新登录",
    }))
}

/// 快照定位：顶层（与 confirm 并列）或导出信封的 `data` 字段里
fn extract_snapshot(payload: &Value) -> Option<&Value> {
    if payload.get("kind").and_then(Value::as_str) == Some(SNAPSHOT_KIND) {
        return Some(payload);
    }
    let inner = payload.get("data")?;
    if inner.get("kind").and_then(Value::as_str) == Some(SNAPSHOT_KIND) {
        return Some(inner);
    }
    None
}

struct AccountRow {
    id: String,
    provider: String,
    priority: i64,
    enabled: i64,
    added_at: i64,
    data: String,
}

/// kv 行解析：key 非空字符串、value 是落库的 JSON 原文（字符串）
fn parse_kv_rows(snapshot: &Value) -> Result<Vec<(String, String)>, String> {
    let array = snapshot
        .get("kv")
        .and_then(Value::as_array)
        .ok_or_else(|| "快照缺少 kv 数组".to_string())?;
    let mut rows = Vec::with_capacity(array.len());
    for (index, item) in array.iter().enumerate() {
        let key = item
            .get("key")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .ok_or_else(|| format!("kv[{index}] 缺少非空的 key 字段"))?
            .to_string();
        let value = item
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("kv[{index}] 缺少 value 字段（应为落库的 JSON 原文）"))?
            .to_string();
        rows.push((key, value));
    }
    Ok(rows)
}

/// 账号行解析：id 必填；其余列缺失回落默认（provider 空 / priority 0 /
/// enabled 1 / addedAt 0）；data 接受对象（权威副本）或字符串（导出端
/// 解析失败时的原样回传）
fn parse_account_rows(snapshot: &Value) -> Result<Vec<AccountRow>, String> {
    let array = snapshot
        .get("accounts")
        .and_then(Value::as_array)
        .ok_or_else(|| "快照缺少 accounts 数组（没有账号也要给空数组）".to_string())?;
    let mut rows = Vec::with_capacity(array.len());
    for (index, item) in array.iter().enumerate() {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| format!("accounts[{index}] 缺少非空的 id 字段"))?
            .to_string();
        let provider = item
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let priority = item.get("priority").and_then(Value::as_i64).unwrap_or(0);
        let enabled = boolish(item.get("enabled"), true) as i64;
        let added_at = item.get("addedAt").and_then(Value::as_i64).unwrap_or(0);
        let data = match item.get("data") {
            Some(data) if data.is_object() => data.to_string(),
            Some(Value::String(text)) => text.clone(),
            _ => {
                return Err(format!(
                    "accounts[{index}] 缺少 data 字段（账号记录的 JSON 原文）"
                ))
            }
        };
        rows.push(AccountRow { id, provider, priority, enabled, added_at, data });
    }
    Ok(rows)
}

/// 宽容的布尔读取：布尔用它、整数非零为真、其余回落默认
fn boolish(value: Option<&Value>, default: bool) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_i64().map_or(default, |raw| raw != 0),
        _ => default,
    }
}

// ─── 定时备份设置与手动执行 ─────────────────────────────────

/// GET /api/backup/settings —— 设置 + 上次执行状态（照定时任务列表的字段口径）
pub async fn get_settings(State(_state): State<ServerState>) -> Response {
    let settings = backup::settings();
    let state = task_state::read(backup::TASK_KEY).unwrap_or_default();
    ok_json(json!({
        "enabled": settings.enabled,
        "keep": settings.keep,
        "intervalHours": backup::BACKUP_INTERVAL_MS / 3_600_000,
        "dir": backup::backup_dir().to_string_lossy(),
        "lastRunAt": ts(state.last_run_at),
        "lastSuccessAt": ts(state.last_success_at),
        "lastResult": state.last_result,
        "lastError": state.last_error,
        "nextRunAt": if settings.enabled { ts(state.due_at()) } else { Value::Null },
    }))
}

/// PUT /api/backup/settings —— body `{enabled?, keep?}`（允许部分字段，
/// null 同义于「这项不改」，与 /api/queue 同一口径）。
/// 从关拨到开时照定时任务框架「开启即跑一次」的语义排到现在。
pub async fn put_settings(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };
    let mut patch = backup::BackupPatch::default();
    if let Some(value) = object.get("enabled") {
        if !value.is_null() {
            match value.as_bool() {
                Some(flag) => patch.enabled = Some(flag),
                None => return errors::management_error(400, "enabled 必须是布尔值"),
            }
        }
    }
    if let Some(value) = object.get("keep") {
        if !value.is_null() {
            match parse_bounded_int("keep", value, backup::KEEP_MIN, backup::KEEP_MAX) {
                Ok(number) => patch.keep = Some(number),
                Err(message) => return errors::management_error(400, message),
            }
        }
    }
    if patch.enabled.is_none() && patch.keep.is_none() {
        return errors::management_error(400, "没有需要更新的字段");
    }
    let before = backup::settings();
    let settings = backup::apply_settings(patch);
    if patch.enabled == Some(true) && !before.enabled {
        let _ = backup::schedule_now();
    }
    audit_api::audit(
        "backup.settings",
        &format!(
            "定时备份已{}，保留 {} 份",
            if settings.enabled { "开启" } else { "关闭" },
            settings.keep,
        ),
    );
    ok_json(json!({ "enabled": settings.enabled, "keep": settings.keep }))
}

/// POST /api/backup/run —— 立即执行一次备份（占位被占 / 冷却中给 400，
/// 与 `/api/scheduled-tasks/{id}/run` 同一口径）
pub async fn post_run(State(_state): State<ServerState>) -> Response {
    match backup::run_now() {
        Ok(summary) => {
            audit_api::audit("backup.run", &summary);
            ok_json(json!({
                "summary": summary,
                "dir": backup::backup_dir().to_string_lossy(),
            }))
        }
        Err(message) => errors::management_error(400, message),
    }
}

/// 单个整数的校验（照 `queue_api::parse_bounded_int` 的口径：只认 JSON
/// 数字，容忍 `2.0` 这类整值浮点；字符串视为非法）
fn parse_bounded_int(key: &str, value: &Value, min: i64, max: i64) -> Result<i64, String> {
    let number = match value {
        Value::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|raw| raw.is_finite() && raw.fract() == 0.0)
                .map(|raw| raw as i64)
        }),
        _ => None,
    };
    let Some(number) = number else {
        return Err(format!("{key} 必须是整数"));
    };
    if !(min..=max).contains(&number) {
        return Err(format!("{key} 必须在 {min}~{max} 之间"));
    }
    Ok(number)
}

/// 毫秒时间戳 → JSON（0 = 从未发生，给 null，与定时任务列表同一形态）
fn ts(at: i64) -> Value {
    if at > 0 {
        json!(at)
    } else {
        Value::Null
    }
}
