//! 「WorkBuddy 成长任务」路由处理器（路由在 http.rs 由主会话接线，本文件
//! 只提供 handler 与响应形状）。
//!
//!   GET  /api/growth-tasks/scan     全账号任务扫描（只读；全部任务带状态）
//!   POST /api/growth-tasks/run      启动执行队列 {concurrency?}（running 时 409）
//!   GET  /api/growth-tasks/queue    队列进度（前端 3s 轮询）
//!   POST /api/growth-tasks/stop     尽力取消（当前项完成后停）
//!   POST /api/growth-tasks/trial    国际版一次性 trial 加油包 {accountId}
//!   POST /api/growth-tasks/gift     新手礼包/活动补偿 {accountId, kind}
//!   GET  /api/growth-tasks/schedule 调度设置（开关/时点，默认全关）
//!   PUT  /api/growth-tasks/schedule 保存调度设置 {streakEnabled?, growthEnabled?,
//!                                    growthTime?, travelEnabled?, travelHours?,
//!                                    blackcatEnabled?, blackcatTime?}
//!
//! ── 响应形状 ────────────────────────────────────────────────
//! 全部走管理 API 信封 `{success:true, data}` / `management_error`：
//! 这些都是本壳新增端点（无 Node 版对齐项），与 probe_api / scheduled_tasks
//! 的管理信封一致，**不**沿用 api::billing 的 OpenAI 风格 body（那是 Node
//! 大 try 落点的复刻，仅存量计费路由保持）。
//!
//! ── 审计埋点 ────────────────────────────────────────────────
//! scan / run / stop / schedule / trial / gift 在 handler 层埋
//! （`audit_api::audit`，事件标识 `growth.*`）；队列跑完的 `growth.complete`
//! 在 core::growth_queue 的收尾任务里埋（那里才知道真正的完成时刻）；
//! 定时调度触发（growth/blackcat/travel）在 core::growth_schedule 落 [Growth]
//! 日志（低频后台动作，不入审计流）。
//!
//! ── trial / gift 的 edition 闸 ─────────────────────────────
//! trial 仅国际版（refs trial.go:2-3：CN 无 /billing/ide/trial 端点）；
//! gift 仅国内版（refs scheduler/streak.go 的 D4 门控：global 不发起 CN
//! 计费域调用）。非对应版本直接 400，不发上游请求。

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::api::audit_api::audit;
use crate::server::core::billing::gift::GiftKind;
use crate::server::core::billing::{gift, trial};
use crate::server::core::growth_queue::{self, GrowthQueue};
use crate::server::core::growth_schedule;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// 取全局队列句柄（首次调用以 ServerState 的 store/billing 初始化）。
fn queue_of(state: &ServerState) -> GrowthQueue {
    growth_queue::global(state.store().clone(), state.billing().clone())
}

/// 解析 body 里的对象；空 body 视为 {}。
fn parse_object(body: &Bytes) -> Result<Value, Response> {
    match parse_body(body) {
        Ok(value) if value.is_object() => Ok(value),
        Ok(_) => Err(errors::management_error(400, "请求体必须是 JSON 对象")),
        Err(error) => Err(errors::management_error(400, error.message)),
    }
}

/// GET /api/growth-tasks/scan —— 全账号任务扫描（只读）
pub async fn scan(State(state): State<ServerState>) -> Response {
    let data = queue_of(&state).scan().await;
    let accounts = data
        .get("results")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    audit("growth.scan", &format!("扫描 {accounts} 个账号的成长任务"));
    ok_json(data)
}

/// POST /api/growth-tasks/run —— 启动执行队列（{concurrency?: 1-4}）
pub async fn run(State(state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_object(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let concurrency = payload
        .get("concurrency")
        .and_then(Value::as_u64)
        .unwrap_or(growth_queue::DEFAULT_CONCURRENCY as u64) as usize;
    match queue_of(&state).run(concurrency).await {
        Ok(total) => {
            audit(
                "growth.run",
                &format!("成长任务队列启动（{total} 项待办，并发 {concurrency}）"),
            );
            ok_json(json!({ "started": true, "total": total }))
        }
        Err(()) => {
            logging::log("[Growth]", "❌ 队列已在执行中，拒绝重复启动");
            errors::management_error(409, "成长任务队列正在执行中，请等本轮结束后再试")
        }
    }
}

/// GET /api/growth-tasks/queue —— 队列进度（前端 3s 轮询）
pub async fn queue(State(state): State<ServerState>) -> Response {
    ok_json(queue_of(&state).state())
}

/// POST /api/growth-tasks/stop —— 尽力取消（当前项完成后停）
pub async fn stop(State(state): State<ServerState>) -> Response {
    queue_of(&state).stop();
    audit("growth.stop", "请求停止成长任务队列（当前项完成后停）");
    ok_json(json!({ "stopped": true }))
}

/// GET /api/growth-tasks/schedule —— 调度设置回显（开关/时点/默认全关）
pub async fn get_schedule(State(_state): State<ServerState>) -> Response {
    match growth_schedule::read_config() {
        Ok(config) => ok_json(growth_schedule::config_json(&config)),
        Err(error) => errors::management_error(503, format!("调度配置不可用: {error}")),
    }
}

/// PUT /api/growth-tasks/schedule —— 保存调度设置（部分字段可省）
pub async fn put_schedule(State(_state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_object(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match growth_schedule::write_config(&payload) {
        Ok(config) => {
            audit("growth.schedule", "调度设置已更新");
            ok_json(config)
        }
        Err(error) => errors::management_error(400, error),
    }
}

/// POST /api/growth-tasks/trial —— 国际版一次性 trial 加油包（{accountId}）
pub async fn trial(State(state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_object(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(account_id) = payload
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
    else {
        return errors::management_error(400, "accountId 必填");
    };
    let Some(entry) = state.store().get_session_by_id(&account_id) else {
        return errors::management_error(404, "账号不存在或没有可用凭证");
    };
    // edition 闸：trial 仅国际版（CN 无此端点，refs trial.go:2-3）
    if entry.session.get("edition").and_then(Value::as_str) != Some("intl") {
        return errors::management_error(400, "该动作仅限国际版账号");
    }
    match trial::claim_trial(state.billing(), &entry.session).await {
        Ok(outcome) => {
            audit(
                "growth.trial",
                &format!("账号 {account_id} trial 加油包: {}", outcome.message),
            );
            ok_json(json!({
                "claimed": outcome.claimed,
                "message": outcome.message,
            }))
        }
        Err(error) => errors::management_error(error.status_code, error.message),
    }
}

/// POST /api/growth-tasks/gift —— 新手礼包/活动补偿（{accountId, kind}）
pub async fn gift(State(state): State<ServerState>, body: Bytes) -> Response {
    let payload = match parse_object(&body) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(account_id) = payload
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
    else {
        return errors::management_error(400, "accountId 必填");
    };
    let Some(kind) = payload
        .get("kind")
        .and_then(Value::as_str)
        .and_then(GiftKind::parse)
    else {
        return errors::management_error(400, "kind 必须是 gift 或 compensation");
    };
    let Some(entry) = state.store().get_session_by_id(&account_id) else {
        return errors::management_error(404, "账号不存在或没有可用凭证");
    };
    // edition 闸：礼包/补偿挂 CN 计费域（refs scheduler/streak.go 的 D4 门控：
    // 国际版账号不发起 CN 计费调用）
    if entry.session.get("edition").and_then(Value::as_str) == Some("intl") {
        return errors::management_error(400, "该动作仅限国内版账号");
    }
    match gift::claim_gift(state.billing(), &entry.session, kind).await {
        Ok(outcome) => {
            audit(
                "growth.gift",
                &format!("账号 {account_id} {}: {}", kind_label(kind), outcome.message),
            );
            ok_json(json!({
                "claimed": outcome.claimed,
                "already": outcome.already,
                "credit": outcome.credit,
                "message": outcome.message,
            }))
        }
        Err(error) => errors::management_error(error.status_code, error.message),
    }
}

/// 审计文案里的动作名。
fn kind_label(kind: GiftKind) -> &'static str {
    match kind {
        GiftKind::Gift => "新手礼包",
        GiftKind::Compensation => "活动补偿",
    }
}
