//! growth 域「猫猫旅行」+ 领养链路（对照 refs upstream/travel.go +
//! internal/scheduler/travel.go:68-100 的单趟状态机移植）。
//!
//! 端点全部走 chatBase（copilot.tencent.com，不带 /v2 前缀）+ BillingHeaders
//! （refs travel.go 模块头），信封 {code,msg,data}：
//!   GET  /activity/growth/buddy/info              猫档案（buddy null=无猫）
//!   POST /activity/growth/buddy/agreement         {agree:true}（幂等）
//!   POST /activity/growth/buddy/first             领养（400=当日门槛未过）
//!   GET  /activity/growth/buddy/travel/status     state: idle|traveling|arrived
//!   POST /activity/growth/buddy/travel/depart     {location_id:4}
//!   POST /activity/growth/buddy/travel/claim      {record_id}
//!
//! 状态机（refs scheduler/travel.go:68-100 travelOne）：单账号单趟最多一个动作，
//! 不轮询不等待；无猫 → 领养链（前置上报解锁 first_buddy 任务，门槛未过当日
//! 不重试）；有猫 → arrived 领奖 / idle 派出 / traveling 跳过。
//!
//! 本模块当前无生产调用点（M4 定时调度接线，对照 refs RunTravelNow 的
//! travel_hours 排程），先落端点封装与单账号状态机。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use super::request::{growth_extra, BillingBase, BillingSpec, CallOptions};
use super::{BillingError, BillingService};
use crate::server::logging;

// ─── 端点表（refs travel.go:17-25，chatBase）────────────────

const BUDDY_INFO: BillingSpec = BillingSpec {
    method: "GET",
    path: "/activity/growth/buddy/info",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

const BUDDY_AGREEMENT: BillingSpec = BillingSpec {
    method: "POST",
    path: "/activity/growth/buddy/agreement",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

const BUDDY_FIRST: BillingSpec = BillingSpec {
    method: "POST",
    path: "/activity/growth/buddy/first",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

const TRAVEL_STATUS: BillingSpec = BillingSpec {
    method: "GET",
    path: "/activity/growth/buddy/travel/status",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

const TRAVEL_DEPART: BillingSpec = BillingSpec {
    method: "POST",
    path: "/activity/growth/buddy/travel/depart",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

const TRAVEL_CLAIM: BillingSpec = BillingSpec {
    method: "POST",
    path: "/activity/growth/buddy/travel/claim",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

// ─── 常量（出处逐条标注）────────────────────────────────────

/// 派出地点固定 4（古镇客栈）：4 个地点收益/时长区间完全相同，无最优解
/// （refs scheduler/travel.go:16-17）。
pub const TRAVEL_LOCATION_ID: i64 = 4;

/// 账号间限速（refs scheduler/travel.go:26 `travelAccountDelay = 800ms`）。
/// 全量巡检调度（M4）在账号间使用；本模块的并发编排不在这里管。
pub const TRAVEL_ACCOUNT_DELAY_MS: u64 = 800;

/// 领养前置上报后的等待（refs scheduler/travel.go:33 `adoptReportGap = 1050ms`，
/// 给上游事件处理留时间再发 buddy/first）。
pub const ADOPT_REPORT_GAP_MS: u64 = 1050;

/// 领养门槛未达标的业务错误关键词（refs travel.go:28，HTTP 400 时出现）。
const BUDDY_TASK_INCOMPLETE_MARKER: &str = "first_buddy task not completed yet";

// ─── 状态结构（refs travel.go:31-42）────────────────────────

/// 账号当前猫档案；`buddy/info` 的 data.buddy 为 null 表示无猫。
#[derive(Debug, Clone)]
pub struct Buddy {
    pub id: i64,
    pub name: String,
}

/// 猫猫旅行状态。
#[derive(Debug, Clone, Default)]
pub struct TravelState {
    /// idle（空闲可派出）/ traveling（在途）/ arrived（到站可领奖）
    pub state: String,
    /// 今日已派出过（自然日 00:00 CST 重置）
    pub daily_limit_reached: bool,
    /// 在途/到站记录 id，claim 必带
    pub record_id: i64,
    /// 到站可领奖励积分
    pub reward_credit: i64,
}

// ─── 请求选项与端点封装 ─────────────────────────────────────

fn travel_options<'a>(session: &'a Value) -> CallOptions<'a> {
    CallOptions {
        session: Some(session),
        extra: growth_extra(session, false),
        ..Default::default()
    }
}

/// 查询当前猫档案；返回 None 表示无猫（data.buddy 为 null / 缺字段 / 空对象，
/// refs travel.go:99-120 BuddyInfo）。
pub async fn buddy_info(
    service: &BillingService,
    session: &Value,
) -> Result<Option<Buddy>, BillingError> {
    let call = service.call_billing(BUDDY_INFO, travel_options(session)).await?;
    let buddy = call.data.get("buddy").cloned().unwrap_or(Value::Null);
    // null / 缺字段 / 非对象都按无猫处理（refs 的 trimmed == "" | "null" 口径）
    let Some(buddy) = buddy.as_object() else {
        return Ok(None);
    };
    Ok(Some(Buddy {
        id: buddy.get("id").and_then(Value::as_i64).unwrap_or(0),
        name: buddy
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }))
}

/// 同意协议（幂等，重复调用无副作用；refs travel.go:129-133）。
pub async fn buddy_agreement(
    service: &BillingService,
    session: &Value,
) -> Result<(), BillingError> {
    let body = json!({ "agree": true });
    let options = CallOptions {
        body: Some(&body),
        ..travel_options(session)
    };
    service.call_billing(BUDDY_AGREEMENT, options).await?;
    Ok(())
}

/// 领养第一只猫（refs travel.go:123-127 BuddyFirst）。门槛未达标返回
/// HTTP 400（[`is_buddy_task_incomplete`]），属预期行为，调用方当日不再重试。
pub async fn buddy_first(
    service: &BillingService,
    session: &Value,
) -> Result<(), BillingError> {
    service.call_billing(BUDDY_FIRST, travel_options(session)).await?;
    Ok(())
}

/// 判定「领养门槛未达标」：HTTP 400 + 关键词（refs travel.go:155-166）。
/// 该错误当日不应重试（避免对上游重试轰炸）。
pub fn is_buddy_task_incomplete(error: &BillingError) -> bool {
    error.status_code == 400 && error.message.to_lowercase().contains(BUDDY_TASK_INCOMPLETE_MARKER)
}

/// 查询猫猫旅行状态（refs travel.go:64-74 TravelStatus）。
pub async fn travel_status(
    service: &BillingService,
    session: &Value,
) -> Result<TravelState, BillingError> {
    let call = service.call_billing(TRAVEL_STATUS, travel_options(session)).await?;
    Ok(TravelState {
        state: call
            .data
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        daily_limit_reached: call
            .data
            .get("daily_limit_reached")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        record_id: call
            .data
            .get("record_id")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        reward_credit: call
            .data
            .get("reward_credit")
            .and_then(Value::as_i64)
            .unwrap_or(0),
    })
}

/// 派出猫旅行（refs travel.go:77-80；locationID 实测 1~4 收益/时长相同）。
pub async fn travel_depart(
    service: &BillingService,
    session: &Value,
) -> Result<(), BillingError> {
    let body = json!({ "location_id": TRAVEL_LOCATION_ID });
    let options = CallOptions {
        body: Some(&body),
        ..travel_options(session)
    };
    service.call_billing(TRAVEL_DEPART, options).await?;
    Ok(())
}

/// 领取到站奖励（refs travel.go:83-96 TravelClaim），返回 reward_credit。
/// 奖励字段缺失不视为失败（调用方按 0 记日志即可）。
pub async fn travel_claim(
    service: &BillingService,
    session: &Value,
    record_id: i64,
) -> Result<i64, BillingError> {
    let body = json!({ "record_id": record_id });
    let options = CallOptions {
        body: Some(&body),
        ..travel_options(session)
    };
    let call = service.call_billing(TRAVEL_CLAIM, options).await?;
    Ok(call
        .data
        .get("reward_credit")
        .and_then(Value::as_i64)
        .unwrap_or(0))
}

// ─── 领养「当日已试」登记（跨调用进程内记忆）────────────────

/// 该账号当日是否已判定领养门槛未达（refs scheduler/travel.go:157-168 的
/// adoptTried map；键 = uid，值 = 上游自然日）。进程内存态：重启即忘，
/// 最坏情况是重启后对当日未过门槛的账号多试一次 —— 可接受。
static ADOPT_TRIED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn adopt_tried_map() -> &'static Mutex<HashMap<String, String>> {
    ADOPT_TRIED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 上游自然日（CST，UTC+8 固定偏移；refs scheduler/travel.go:35-42 ——
/// 上游每日重置按自然日 00:00 CST，中国无夏令时）。
fn cst_day_key() -> String {
    (chrono::Utc::now() + chrono::Duration::hours(8))
        .format("%Y-%m-%d")
        .to_string()
}

fn adopt_tried_today(uid: &str) -> bool {
    let map = adopt_tried_map();
    let day_key = cst_day_key();
    match map.lock() {
        Ok(guard) => guard.get(uid).map(|day| day == &day_key).unwrap_or(false),
        Err(poisoned) => poisoned
            .into_inner()
            .get(uid)
            .map(|day| day == &day_key)
            .unwrap_or(false),
    }
}

fn mark_adopt_tried(uid: &str) {
    let map = adopt_tried_map();
    let write = |guard: &mut HashMap<String, String>| {
        guard.insert(uid.to_string(), cst_day_key());
    };
    match map.lock() {
        Ok(mut guard) => write(&mut guard),
        Err(poisoned) => write(&mut poisoned.into_inner()),
    }
}

// ─── 单账号单趟状态机（对照 refs scheduler/travel.go:68-100）────

/// 单账号单趟旅行巡检：查有无猫 + 查状态 + 最多一个动作，不轮询不等待。
/// 返回可读结果（供调用方记日志/展示）。
pub async fn travel_account_once(
    service: &BillingService,
    session: &Value,
    uid: &str,
) -> String {
    let buddy = match buddy_info(service, session).await {
        Ok(buddy) => buddy,
        Err(error) => return format!("查询猫档案失败: {}", error.message),
    };
    let Some(buddy) = buddy else {
        return travel_adopt(service, session, uid).await;
    };
    let state = match travel_status(service, session).await {
        Ok(state) => state,
        Err(error) => return format!("查询旅行状态失败: {}", error.message),
    };
    match state.state.as_str() {
        "arrived" => {
            // 到站领奖（必须带 record_id，refs scheduler/travel.go:110-121）
            if state.record_id == 0 {
                return format!("猫猫「{}」到站但缺少 record_id，跳过领奖", buddy.name);
            }
            match travel_claim(service, session, state.record_id).await {
                Ok(reward) => format!(
                    "猫猫「{}」到站奖励已领取（record {}，+{reward}c）",
                    buddy.name, state.record_id
                ),
                Err(error) => format!(
                    "猫猫「{}」领奖失败（record {}）: {}",
                    buddy.name, state.record_id, error.message
                ),
            }
        }
        "idle" => {
            if state.daily_limit_reached {
                return "今日已派出过（每日 1 次，CST 自然日重置）".to_string();
            }
            match travel_depart(service, session).await {
                Ok(()) => format!("猫猫「{}」已派出（location={TRAVEL_LOCATION_ID}）", buddy.name),
                Err(error) => format!("派出失败: {}", error.message),
            }
        }
        "traveling" => {
            format!("猫猫「{}」在途中（record {}），跳过", buddy.name, state.record_id)
        }
        other => format!("未知旅行状态 {other}，跳过"),
    }
}

/// 无猫时的领养链（refs scheduler/travel.go:123-154 travelAdopt）：
/// report（解锁 first_buddy 任务）→ 1.05s → agreement → buddy/first。
/// 门槛未达标（400 + 关键词）当日不再重试。
async fn travel_adopt(service: &BillingService, session: &Value, uid: &str) -> String {
    if adopt_tried_today(uid) {
        return "领养门槛今日已试过，明日再试".to_string();
    }
    // 前置上报：点亮 growth 连登并解锁 first_buddy 任务（失败不阻塞，
    // 让 buddy/first 按既有错误路径暴露，refs 同款语义）
    let conversation = format!("wb2api-adopt-{}", logging::now_ms());
    if let Err(error) =
        super::report::report_chat_activity(service, session, &conversation, "", "", "").await
    {
        logging::log("[Growth]", &format!("领养前置上报失败: {}", error.message));
    } else {
        tokio::time::sleep(Duration::from_millis(ADOPT_REPORT_GAP_MS)).await;
    }
    if let Err(error) = buddy_agreement(service, session).await {
        return format!("同意协议失败: {}", error.message);
    }
    match buddy_first(service, session).await {
        Ok(()) => "已领取 Buddy（+300 分 +8 能量）".to_string(),
        Err(error) if is_buddy_task_incomplete(&error) => {
            mark_adopt_tried(uid);
            "领养门槛未过（上游要求当日活跃），明日自动重试".to_string()
        }
        Err(error) => format!("领取 Buddy 失败: {}", error.message),
    }
}
