//! 面板会话管理（安全与运维切片，功能二）。
//!
//! ```text
//! GET  /api/sessions/list    当前活跃的面板登录会话（会话链、创建 / 最近活动时刻）
//! POST /api/sessions/revoke  强制下线指定会话（body `{sessionId}`）
//! ```
//!
//! 两条都挂 protected：会话清单会透出「这台面板上有几个登录端、各自何时
//! 动过」，吊销则直接把别人的登录态作废 —— 都是管理员操作，与 /api/keys
//! 同级敏感。
//!
//! ── 会话数据从哪来 ──────────────────────────────────────────
//! 会话是 access.rs 的**内存态**（access token 重启即失效，refresh 链在
//! 库里但展示的是「现在活跃的登录」）。本文件不碰令牌模型：列表与吊销都
//! 委托给 access.rs 新增的三个最小公共函数（`list_sessions` /
//! `session_id_of` / `revoke_session_by_id`，见该文件「会话管理」一节）。
//!
//! ── 「当前会话不可吊销」────────────────────────────────────
//! 管理员把自己的会话吊销掉是自断退路（下一个请求就 401，而界面上看起来
//! 像「功能坏了」）。用 access cookie 定位调用方自己的会话链，与目标一致
//! 就给 400 并引导走退出登录 —— 退出有完整的清 cookie 流程，吊销没有。

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::access;
use crate::server::api::audit_api;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::ServerState;

/// GET /api/sessions/list —— 列出活跃会话。
///
/// 响应里的 `current` 是**调用方自己**的会话链 id（前端据此标出
/// 「本机」这一行）；`sessions` 每项含 `sessionId` / `createdAt` /
/// `lastActivity`（毫秒 Unix 时间戳，重启前的历史为 0）。
pub async fn list_sessions(State(_state): State<ServerState>, headers: HeaderMap) -> Response {
    let current = access::session_id_of(&headers);
    let sessions = access::list_sessions();
    ok_json(json!({ "current": current, "sessions": sessions }))
}

/// POST /api/sessions/revoke —— 强制下线指定会话（body `{sessionId}`）。
///
/// 目标会话的所有 access token 当场作废、refresh 链整条撤销并落盘 ——
/// 那个端的下一次请求（哪怕还揣着旧 cookie）就是 401，只能重新登录。
pub async fn revoke_session(
    State(_state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let target = payload
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let Some(target) = target else {
        return errors::management_error(400, "请求体必须包含非空的 sessionId 字段");
    };
    if access::session_id_of(&headers).as_deref() == Some(target) {
        return errors::management_error(
            400,
            "不能吊销当前登录正在使用的会话，请改用「退出登录」",
        );
    }
    if !access::revoke_session_by_id(target) {
        return errors::management_error(404, "会话不存在或已失效");
    }
    audit_api::audit("session.revoke", &format!("会话 {target} 已被强制下线"));
    ok_json(json!({ "revoked": target }))
}
