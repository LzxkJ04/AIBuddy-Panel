//! 审计日志（安全与运维切片，功能一）。
//!
//! ```text
//! GET /api/audit?limit=&offset=   最近的审计日志条目（倒序，最新在前）
//! ```
//!
//! ── 审计事件落在哪 ──────────────────────────────────────────
//! 审计**不另建存储**：敏感操作的审计事件经由本模块的 [`audit`] 写进既有
//! 事件日志体系（`logging::log` → `logs` 表，标签 `[Audit]`），日志页 / 日志
//! 下载天然能看到它们，本模块只补一个**只看审计条目**的查询入口。
//!
//! ── 埋点方式 ────────────────────────────────────────────────
//! 敏感操作分散在各路由模块里，本切片不改那些文件 —— 各模块在动作成功 /
//! 失败的分支上调用 [`audit`]（`crate::server::api::audit_api::audit`）即可，
//! 参数约定：`event` 用稳定的点分标识（`panel.login` / `apikey.delete`…），
//! `detail` 是给人看的一句话（含操作对象与来源）。条目的完整形态是
//! `[Audit] <event>: <detail>`，查询端按这个前缀识别审计条目。
//!
//! ── 深度上限（调用方要知道的约束）───────────────────────────
//! 事件日志库有两条既有裁剪：保留天数（`config::retention_settings`）与
//! 容量上限（`logs_store::MAX_ENTRIES` = 500 条，**全部日志共享**）。审计条目
//! 因此只保证「最近的一批」可查 —— 转发量大的部署里 `[HTTP]` / `[Upstream]`
//! 条目会把审计条目较快挤出容量窗口。要更长的审计留存，需要给 logs 表单独
//! 的保留策略，那是后续切片的事（本切片按「写入既有日志体系」的约定实现）。
//!
//! ── 分页 ────────────────────────────────────────────────────
//! `LogStore::query` 只有 limit 没有 offset，而日志条目 id 与位置并不连续
//! （其它类别的条目混在其中），所以 offset 语义在本模块内实现：一次取回
//! 库内全部条目（上限 `MAX_ENTRIES`，已经是这个存储的绝对上限），在内存里
//! 过滤出审计条目后按 `offset` / `limit` 切片。库内条目总量 ≤ 500，
//! 这一跳没有性能问题。

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::response::Response;
use serde_json::json;

use crate::server::errors;
use crate::server::http::ok_json;
use crate::server::logging;
use crate::server::logs_store::{self, Query as LogQuery};
use crate::server::ServerState;

/// 审计条目的统一标签。`logging::log` 会把它与正文拼成
/// `[Audit] <event>: <detail>` 落库 —— 查询端按 `[Audit] ` 前缀识别。
pub const AUDIT_TAG: &str = "[Audit]";

/// 落库后的条目消息前缀（`logging::log` 的拼接结果，含尾随空格）
const AUDIT_MESSAGE_PREFIX: &str = "[Audit] ";

/// 记一条审计日志（各路由模块埋点的唯一入口）。
///
/// 双通道与普通日志一致（控制台 + logs 表），级别由文案推断（含「失败」
/// 即 error，`logging::infer_level` 的既有语义）。**不吞错误也不返回结果**：
/// 审计与普通日志同为「尽力而为」—— 日志库不可用时 `logging::log` 静默
/// 丢弃（只剩控制台一行），调用方不需要为「审计没写进去」改变业务流程。
pub fn audit(event: &str, detail: &str) {
    let detail = detail.trim();
    let text = if detail.is_empty() {
        event.trim().to_string()
    } else {
        format!("{}: {detail}", event.trim())
    };
    logging::log(AUDIT_TAG, &text);
}

/// GET /api/audit?limit=&offset= —— 最近的审计条目（倒序）。
///
/// 信封照 logs_api 的管理 API 形状（`{success:true, data:{...}}`）；
/// `total` 是**当前库内**审计条目总数（供前端分页），`max` 透传日志容量
/// 上限（与 /api/logs 的 `max` 字段同一含义）。
pub async fn query_audit(
    State(_state): State<ServerState>,
    Query(params): Query<Params>,
) -> Response {
    let Some(store) = logging::store_ref() else {
        return errors::management_error(503, "日志模块未启用");
    };
    let limit = parse_usize(&params, "limit", 100).clamp(1, logs_store::MAX_ENTRIES);
    let offset = parse_usize(&params, "offset", 0);

    // limit 给满上限 = 取回库内全部条目（容量裁剪保证了它的量级），过滤与
    // 分页都在内存里做 —— 见模块头的「分页」一节
    let result = store.query(&LogQuery {
        limit: Some(logs_store::MAX_ENTRIES),
        ..Default::default()
    });
    let matched: Vec<logs_store::LogEntry> = result
        .entries
        .into_iter()
        .filter(|entry| entry.message.starts_with(AUDIT_MESSAGE_PREFIX))
        .collect();
    let total = matched.len();
    let entries: Vec<logs_store::LogEntry> =
        matched.into_iter().skip(offset).take(limit).collect();

    ok_json(json!({
        "entries": entries,
        "total": total,
        "limit": limit,
        "offset": offset,
        "max": logs_store::MAX_ENTRIES,
    }))
}

/// 查询串参数（与 logs_api 同一形态：HashMap 接收，缺省按默认值）
type Params = HashMap<String, String>;

/// 解析查询串里的非负整数：缺失 / 空串 / 非数字 → 默认值（不报错，
/// 与 logs_api 对 limit 的「NaN 视作缺省」口径一致）
fn parse_usize(params: &HashMap<String, String>, key: &str, default: usize) -> usize {
    params
        .get(key)
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(default)
}
