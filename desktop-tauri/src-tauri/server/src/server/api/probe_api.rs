//! 账号探活的设置与手动执行（`GET/PUT /api/probe/settings`、
//! `POST /api/probe/run`）。
//!
//! ── 形态照 queue_api ────────────────────────────────────────
//! 与 `/api/queue` 同一模式：独立端点、PUT 允许部分字段、返回**生效后**的
//! 全量值（前端直接用响应刷新，不必再 GET 一次）、保存后对下一轮立即生效
//! （调度循环每 tick 重读设置）。设置体是
//! `{enabled, intervalMinutes, threshold, concurrency}`：数值三项缺失或
//! null = 不改；`enabled` 与 `scheduled_tasks::configure` 同一口径（出现时
//! 只认严格 true，其余一律置 false）。响应另带排期状态
//! （lastRunAt / nextRunAt / lastResult / running）与连败计数表（`failures`，
//! 只含非零项），前端一张卡片能画完 —— 形状见 `core::probe::settings_json`。
//!
//! ── 错误信封 ────────────────────────────────────────────────
//! 校验失败与「正在执行中」都返回**管理信封**的 400（`{success:false,error}`）
//! —— 与 `/api/scheduled-tasks` 的 run 同一口径（纯新增的管理 API，没有需要
//! 对齐的旧客户端）。`POST /api/probe/run` 立即执行一轮并返回逐账号结果。
//!
//! ── 与定时任务页的关系 ──────────────────────────────────────
//! 探活是自包含任务（`core::probe`），不进 `core::scheduled_tasks` 的静态
//! 注册表，因此开关与间隔走本端点而不是 `/api/scheduled-tasks/{id}`；
//! 排期原语（占位 / 失败冷却 / 重启不重置节奏）与其余后端任务同款。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::server::core::probe;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// GET /api/probe/settings
pub async fn get_settings(State(state): State<ServerState>) -> Response {
    probe::ensure_loop(state.store().clone());
    ok_json(probe::settings_json())
}

/// PUT /api/probe/settings —— body `{enabled?, intervalMinutes?, threshold?, concurrency?}`
///
/// 允许部分字段；校验失败整体不落盘（不会出现「间隔改了、阈值没改」的半套
/// 设置）。开启时沿用「开启即跑一次」的既有语义，改间隔按新间隔重排。
pub async fn put_settings(State(state): State<ServerState>, body: Bytes) -> Response {
    probe::ensure_loop(state.store().clone());
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return bad_request(error.message),
    };
    match probe::update_settings(&payload) {
        Ok(settings) => ok_json(settings),
        Err(message) => bad_request(message),
    }
}

/// POST /api/probe/run —— 立即执行一轮探活
///
/// 响应带 `{summary, results, settings}`：summary 与定时那轮同源，`results`
/// 是逐账号明细（id / success / skipped / latencyMs / category / message），
/// 界面点完按钮就能就地展示本轮谁通谁不通。
pub async fn run_now(State(state): State<ServerState>) -> Response {
    probe::ensure_loop(state.store().clone());
    let store = state.store().clone();
    match probe::run_now(&store).await {
        Ok(report) => ok_json(report),
        Err(message) => bad_request(message),
    }
}

/// 管理信封的 400（`{success:false,error}`），并打一行日志 ——
/// 与 `api::scheduled_tasks::bad_request` 同一形状与理由。
fn bad_request(message: impl Into<String>) -> Response {
    let message = message.into();
    logging::log("[Accounts]", &format!("❌ 探活接口参数或状态错误: {message}"));
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(json!({ "success": false, "error": message })),
    )
        .into_response()
}
