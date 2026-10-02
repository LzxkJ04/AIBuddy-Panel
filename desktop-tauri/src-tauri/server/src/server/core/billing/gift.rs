//! 新手礼包与活动补偿领取（对照 refs upstream/blackcat.go:71-95 移植）。
//!
//! 端点（refs blackcat.go:73 / :86，billingBase = www.codebuddy.cn，CN 现状）：
//!   POST /billing/meter/claim-gift            领取新手礼包（每号一次）
//!   POST /billing/meter/claim-compensation    领取活动补偿（有则领）
//!
//! 语义（refs blackcat.go 与 scheduler/streak.go:40-46 的用法）：code=0 成功，
//! 响应 data 带 `credit`；重复领取/无可领项返回**业务错误**（refs 的
//! streakBonusAccount 对其「无则业务错误静默跳过」）。
//!
//! 注意（与 trial 的差别，勿混）：refs 没有为礼包/补偿定义幂等码，这里是把
//! 上游返回的非 0 code + msg 原样透出；调用方（api 层）用面板既有的
//! 「msg 含 已领取/已领过 即完成态」口径（core::billing::checkin 的
//! `checkin_completed_today` 同款文案判据）把重复领取翻成中性结果，
//! 不在协议层编造幂等码。

use serde_json::{json, Value};

use super::request::{growth_extra, BillingBase, BillingSpec, CallOptions};
use super::{BillingError, BillingService};

/// 新手礼包端点（refs blackcat.go:73；路径不带 /v2 —— refs 原样照抄）。
const CLAIM_GIFT: BillingSpec = BillingSpec {
    method: "POST",
    path: "/billing/meter/claim-gift",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Billing,
};

/// 活动补偿端点（refs blackcat.go:86）。
const CLAIM_COMPENSATION: BillingSpec = BillingSpec {
    method: "POST",
    path: "/billing/meter/claim-compensation",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Billing,
};

/// 礼包/补偿的动作种类（API 层 `kind` 字段的合法值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GiftKind {
    /// 新手礼包（每号一次）
    Gift,
    /// 活动补偿（有则领）
    Compensation,
}

impl GiftKind {
    /// 从 API 的 kind 字符串解析（'gift' | 'compensation'）。
    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "gift" => Some(Self::Gift),
            "compensation" => Some(Self::Compensation),
            _ => None,
        }
    }

    fn spec(self) -> BillingSpec {
        match self {
            Self::Gift => CLAIM_GIFT,
            Self::Compensation => CLAIM_COMPENSATION,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Gift => "新手礼包",
            Self::Compensation => "活动补偿",
        }
    }
}

/// 领取结果。
#[derive(Debug, Clone)]
pub struct GiftOutcome {
    /// true = 本次领取成功（credit 为到账积分）
    pub claimed: bool,
    /// true = 已领过/无可领（幂等中性结果，非错误）
    pub already: bool,
    /// 到账积分（成功时）
    pub credit: i64,
    /// 给前端展示的一句话
    pub message: String,
}

/// 领取礼包/补偿（逐账号调用；code=0 成功、非 0 code 视上游 msg 而定）。
pub async fn claim_gift(
    service: &BillingService,
    session: &Value,
    kind: GiftKind,
) -> Result<GiftOutcome, BillingError> {
    // refs blackcat.go:73/86 传的是空对象 body
    let body = json!({});
    let options = CallOptions {
        session: Some(session),
        body: Some(&body),
        // 非 0 code 也要拿回来自己判（幂等形态在 msg 文案里）
        expect_code_ok: false,
        extra: growth_extra(session, false),
        ..Default::default()
    };
    let call = service.call_billing(kind.spec(), options).await?;
    if call.code == Some(0) {
        let credit = call.data.get("credit").and_then(Value::as_i64).unwrap_or(0);
        return Ok(GiftOutcome {
            claimed: true,
            already: false,
            credit,
            message: format!("{}领取成功（+{credit}c）", kind.label()),
        });
    }
    // 非 0 code：上游 msg 含「已领取/已领过」时按面板既有口径翻成中性结果
    // （core::billing::checkin 的 checkin_completed_today 同款文案判据）；
    // 其余按失败透出
    let message = call.msg.clone().unwrap_or_default();
    if message.contains("已领取") || message.contains("已领过") {
        return Ok(GiftOutcome {
            claimed: false,
            already: true,
            credit: 0,
            message: format!("{}此前已领取过", kind.label()),
        });
    }
    Err(BillingError::with_code(
        if message.is_empty() {
            format!("{}领取返回 code={:?}", kind.label(), call.code)
        } else {
            format!("{}领取失败: {message}", kind.label())
        },
        502,
        call.code,
    ))
}
