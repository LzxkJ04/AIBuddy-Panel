//! 成长中心连登兑换 + 抽奖（对照 refs upstream/streak.go + internal/scheduler/
//! streak.go:36-116 的单账号状态机移植）。
//!
//! 机制（refs streak.go 模块头，2026-09-12 成长中心 bundle 逆向 + 页面实测）：
//! 连登档位（7d/14d/28d）按**连续登录天数**解锁；兑换（POST /activity/growth/redeem）
//! 发 credit/energy/补签卡/**抽奖次数**；抽奖（POST /activity/growth/lottery/draw）
//! 每次消耗 1 次 chances。未解锁兑换返回 HTTP 403「连续登录天数不足」。
//! `client_token` 为前端生成的幂等令牌（randomUUID 同款语义）。
//!
//! 端点全部挂在 chatBase（growth 域，refs travel.go:24 streakPath 同源）：
//!   GET  /activity/growth/streak            连登完整状态
//!   POST /activity/growth/redeem            {tier, client_token}
//!   GET  /activity/growth/lottery/summary   当前抽奖次数
//!   POST /activity/growth/lottery/draw      {client_token}
//!   GET  /activity/growth/heatmap           签到热力图（漏签检测）
//!   POST /activity/growth/makeup-cards/use  {target_date} 补签卡
//!
//! 生产调用点：[`super::super::growth_schedule::run_streak_after_checkin`]
//! （挂定时/手动签到的 fire 完成后顺跑，streakEnabled 开关控制；
//! 对照 refs scheduler/streak.go 的 RunStreakBonusNow）。

use serde_json::{json, Value};

use super::request::{growth_extra, BillingBase, BillingSpec, CallOptions};
use super::{BillingError, BillingService};
use crate::server::logging;

// ─── 端点表（refs streak.go:20-24，chatBase）────────────────

const STREAK_GET: BillingSpec = BillingSpec {
    method: "GET",
    path: "/activity/growth/streak",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

const STREAK_REDEEM: BillingSpec = BillingSpec {
    method: "POST",
    path: "/activity/growth/redeem",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

const LOTTERY_SUMMARY: BillingSpec = BillingSpec {
    method: "GET",
    path: "/activity/growth/lottery/summary",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

const LOTTERY_DRAW: BillingSpec = BillingSpec {
    method: "POST",
    path: "/activity/growth/lottery/draw",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

/// 签到热力图（refs blackcat.go:100：`GET /activity/growth/heatmap`，
/// data.cells[] 的 cell.score==0 即该日漏签）。
const HEATMAP: BillingSpec = BillingSpec {
    method: "GET",
    path: "/activity/growth/heatmap",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

/// 补签卡使用（refs blackcat.go:122-126：`POST /activity/growth/makeup-cards/use`
/// {target_date}，无卡返回业务错误）。
const MAKEUP_CARD_USE: BillingSpec = BillingSpec {
    method: "POST",
    path: "/activity/growth/makeup-cards/use",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

// ─── 幂等令牌 ───────────────────────────────────────────────

// client_token 移到 `request.rs`（mp 判据事件构造器也要用它），此处直接复用。
use super::request::client_token;

// ─── 状态结构（refs streak.go:36-61 StreakFull 的裁剪视图）────

/// 一个连登档位的可兑换信息。
#[derive(Debug, Clone)]
pub struct StreakTier {
    /// "7d" | "14d" | "28d"
    pub tier: String,
    pub credit: i64,
    pub energy: i64,
    pub cards: i64,
    pub chances: i64,
    /// redemption_status 的档位状态（locked / claimed / 可兑换）
    pub status: String,
}

/// 连登完整状态（GET /activity/growth/streak 的裁剪解析）。
#[derive(Debug, Clone, Default)]
pub struct StreakFull {
    /// 连续登录天数
    pub days: i64,
    /// 补签卡余额
    pub makeup_balance: i64,
    pub tiers: Vec<StreakTier>,
}

fn parse_streak_full(data: &Value) -> StreakFull {
    let days = data
        .get("streak")
        .and_then(|streak| streak.get("days"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let makeup_balance = data
        .get("makeup_cards")
        .and_then(|cards| cards.get("balance"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let redemption = data.get("redemption_status").cloned().unwrap_or(Value::Null);
    // refs streak.go:53-57：档位状态按 tier 名从 tier_7d_status 等键读取
    let status_of = |tier: &str| -> String {
        let key = format!("tier_{tier}_status");
        redemption
            .get(key.as_str())
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let tiers = redemption
        .get("tiers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let tier = item
                        .get("tier")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    StreakTier {
                        status: status_of(&tier),
                        tier,
                        credit: item.get("credit").and_then(Value::as_i64).unwrap_or(0),
                        energy: item.get("energy").and_then(Value::as_i64).unwrap_or(0),
                        cards: item.get("cards").and_then(Value::as_i64).unwrap_or(0),
                        chances: item.get("chances").and_then(Value::as_i64).unwrap_or(0),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    StreakFull { days, makeup_balance, tiers }
}

// ─── 请求选项 ───────────────────────────────────────────────

fn streak_options<'a>(session: &'a Value) -> CallOptions<'a> {
    CallOptions {
        session: Some(session),
        extra: growth_extra(session, false),
        ..Default::default()
    }
}

// ─── 端点封装 ───────────────────────────────────────────────

/// 拉取连登完整状态（refs streak.go:64-74 GrowthStreakFull）。
pub async fn streak_full(
    service: &BillingService,
    session: &Value,
) -> Result<StreakFull, BillingError> {
    let call = service.call_billing(STREAK_GET, streak_options(session)).await?;
    Ok(parse_streak_full(&call.data))
}

/// 兑换连登档位（refs streak.go:78-82 GrowthRedeemTier）。
/// 未解锁返回 403（call_billing 归一为登录态错误 —— 调用方按 locked 状态跳过，
/// 兜底不重试）。
pub async fn redeem_tier(
    service: &BillingService,
    session: &Value,
    tier: &str,
) -> Result<(), BillingError> {
    let body = json!({ "tier": tier, "client_token": client_token() });
    let options = CallOptions {
        body: Some(&body),
        ..streak_options(session)
    };
    service.call_billing(STREAK_REDEEM, options).await?;
    Ok(())
}

/// 当前抽奖次数（refs streak.go:85-100 LotteryChances）。
pub async fn lottery_chances(
    service: &BillingService,
    session: &Value,
) -> Result<i64, BillingError> {
    let call = service
        .call_billing(LOTTERY_SUMMARY, streak_options(session))
        .await?;
    Ok(call
        .data
        .get("chances")
        .and_then(Value::as_i64)
        .unwrap_or(0))
}

/// 抽奖一次，返回原始奖品载荷（refs streak.go:103-106 LotteryDraw；
/// prize 字段形状由活动期决定，透传给调用方）。
pub async fn lottery_draw(
    service: &BillingService,
    session: &Value,
) -> Result<Value, BillingError> {
    let body = json!({ "client_token": client_token() });
    let options = CallOptions {
        body: Some(&body),
        ..streak_options(session)
    };
    let call = service.call_billing(LOTTERY_DRAW, options).await?;
    Ok(call.data)
}

/// 检查昨日是否漏签（refs blackcat.go:97-119 `HeatmapYesterdayMissed`：
/// heatmap cell score==0 = 漏签；cells 里找不到昨日按未漏签处理）。
pub async fn heatmap_yesterday_missed(
    service: &BillingService,
    session: &Value,
) -> Result<bool, BillingError> {
    // refs 用本地时区的昨日日期（time.Now().AddDate(0,0,-1)）
    let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    let call = service.call_billing(HEATMAP, streak_options(session)).await?;
    let cells = call.data.get("cells").and_then(Value::as_array);
    for cell in cells.into_iter().flatten() {
        let date = cell.get("date").and_then(Value::as_str).unwrap_or("");
        // refs：取 cell.date 前 10 位比对（date 可能带时间部分）
        if date.get(..10) == Some(yesterday.as_str()) {
            let score = cell.get("score").and_then(Value::as_i64).unwrap_or(0);
            return Ok(score == 0);
        }
    }
    Ok(false)
}

/// 对指定日期使用补签卡（refs blackcat.go:121-126 `UseMakeupCard`；
/// 无卡 / 无漏签返回业务错误，调用方静默跳过）。
pub async fn use_makeup_card(
    service: &BillingService,
    session: &Value,
    date: &str,
) -> Result<(), BillingError> {
    let body = json!({ "target_date": date });
    let options = CallOptions {
        body: Some(&body),
        ..streak_options(session)
    };
    service.call_billing(MAKEUP_CARD_USE, options).await?;
    Ok(())
}

// ─── 单账号幂等状态机（对照 refs scheduler/streak.go:36-88）────

/// 单账号连登管家（对照 refs scheduler/streak.go:36-88 streakBonusAccount）：
/// 补签保连登 → 礼包/补偿 → 兑换所有已解锁档位 → 按抽奖次数抽完。
/// 幂等：locked/claimed 档位跳过、无 chances 不抽、无卡不补签；403（未解锁）
/// 属预期，记日志跳过 —— 可在任意时机重复执行。
///
/// 注：refs 的 ClaimGift/ClaimCompensation（每号一次，无则业务错误静默跳过）
/// 由 [`super::gift`] 承担，本状态机顺带调用，与 refs 的步骤顺序一致。
pub async fn streak_bonus_account(service: &BillingService, session: &Value) -> Vec<String> {
    let mut messages = Vec::new();
    // 0. 补签保连登（refs scheduler/streak.go:99-116 makeupYesterday）：
    //    昨日漏签且有补签卡则补上（连续天数一断就要重攒 7 天）
    makeup_yesterday(service, session, &mut messages).await;
    // 0.5 礼包/补偿（每号一次，无则业务错误静默跳过，refs scheduler/streak.go:40-46）
    for (kind, label) in [
        (super::gift::GiftKind::Gift, "新手礼包"),
        (super::gift::GiftKind::Compensation, "活动补偿"),
    ] {
        match super::gift::claim_gift(service, session, kind).await {
            Ok(outcome) => {
                if outcome.claimed {
                    logging::log("[Growth]", &format!("🎊 {label}: {}", outcome.message));
                    messages.push(outcome.message);
                }
            }
            Err(error) => {
                logging::verbose("[Growth]", &format!("{label}静默跳过: {}", error.message));
            }
        }
    }
    let full = match streak_full(service, session).await {
        Ok(full) => full,
        Err(error) => {
            logging::log("[Growth]", &format!("连登状态查询失败: {}", error.message));
            return messages;
        }
    };
    // 兑换所有已解锁档位（refs scheduler/streak.go:58-70）
    for tier in &full.tiers {
        if tier.status == "locked" || tier.status == "claimed" || tier.tier.is_empty() {
            continue;
        }
        match redeem_tier(service, session, &tier.tier).await {
            Ok(()) => {
                let message = format!(
                    "兑换 {} 档（+{}c +{}e 卡×{} 抽奖×{}）",
                    tier.tier, tier.credit, tier.energy, tier.cards, tier.chances
                );
                logging::log("[Growth]", &format!("★ 连登{message}"));
                messages.push(message);
            }
            // 未解锁（403）属预期，静默跳过；其余记日志（refs 同款语义）
            Err(error) => {
                logging::log(
                    "[Growth]",
                    &format!("连登兑换 {} 跳过（未解锁或上游拒绝）: {}", tier.tier, error.message),
                );
            }
        }
    }
    // 抽奖：按当前 chances 全抽完（兑换刚发的次数已在服务端累加，refs:71-87）
    let chances = match lottery_chances(service, session).await {
        Ok(chances) => chances,
        Err(error) => {
            logging::log("[Growth]", &format!("抽奖次数查询失败: {}", error.message));
            return messages;
        }
    };
    for index in 0..chances {
        match lottery_draw(service, session).await {
            Ok(prize) => {
                let text = prize.to_string();
                let snippet = text.get(..text.len().min(220)).unwrap_or(&text).to_string();
                logging::log("[Growth]", &format!("🎲 第{}抽 {snippet}", index + 1));
                messages.push(format!("第{}抽 {snippet}", index + 1));
            }
            Err(error) => {
                logging::log("[Growth]", &format!("第{}抽失败: {}", index + 1, error.message));
                return messages;
            }
        }
        // 抽奖动作间隔：refs scheduler 未加间隔；抽奖本身低频，保持一致不加。
    }
    if chances > 0 {
        messages.push(format!("抽奖完成 {chances} 次"));
    }
    messages
}

/// 昨日漏签且有补签卡时自动补签（保住连登连续天数；对照 refs
/// scheduler/streak.go:99-116 makeupYesterday）。
/// 无卡 / 无漏签 / 查询失败均静默（不影响主流程）。
async fn makeup_yesterday(service: &BillingService, session: &Value, messages: &mut Vec<String>) {
    let missed = match heatmap_yesterday_missed(service, session).await {
        Ok(missed) => missed,
        Err(_) => return, // 查询失败静默（refs 同款）
    };
    if !missed {
        return;
    }
    let balance = match streak_full(service, session).await {
        Ok(full) => full.makeup_balance,
        Err(_) => return,
    };
    if balance <= 0 {
        return;
    }
    let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    if let Err(error) = use_makeup_card(service, session, &yesterday).await {
        logging::log("[Growth]", &format!("补签 {yesterday} 失败: {}", error.message));
        return;
    }
    let message = format!("已用补签卡补签 {yesterday}（保连登）");
    logging::log("[Growth]", &format!("★ {message}"));
    messages.push(message);
}
