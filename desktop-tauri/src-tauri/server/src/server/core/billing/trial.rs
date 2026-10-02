//! global 专属「一次性 trial 加油包」领取（对照 refs upstream/trial.go 全量移植）。
//!
//! 端点（refs trial.go:16）：`POST {billingBase}/billing/ide/trial`（Maquer/
//! workbuddy-checkin 实测）。**仅国际版（global）账号适用** —— CN 无此端点
//! （refs trial.go:2-3：这是 global 唯一天然的积分增益动作，无签到/任务中心）；
//! 幂等码 14051 = 已领过（视为正常，非错误）。
//!
//! ── 域的取法（与 growth 域的固定三域不同）────────────────────
//! refs 走 `c.billingBase(a)`，它对 global 账号返回国际站
//! （client.go:712-729：global realm 下 chat/billing 两域收敛为
//! https://www.workbuddy.ai）。面板国际版账号的 session.endpoint 恰是
//! https://www.workbuddy.ai（endpoints.rs EDITION_INTL），因此这里用
//! `BillingBase::Session`（会话端点派生）即等价于 refs 的 global billingBase；
//! CN 账号不会走到这条路径（handler 层有 edition 闸，见 api::growth_tasks）。

use serde_json::Value;

use super::request::{growth_extra, BillingBase, BillingSpec, CallOptions};
use super::{BillingError, BillingService};

/// global trial 加油包端点（refs trial.go:16）。
const TRIAL_CLAIM: BillingSpec = BillingSpec {
    method: "POST",
    path: "/billing/ide/trial",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Session,
};

/// 幂等码 14051「已领取过」（refs trial.go:21）。
const TRIAL_ALREADY_CODE: i64 = 14_051;

/// 领取结果。
#[derive(Debug, Clone)]
pub struct TrialOutcome {
    /// true = 本次成功新领；false = 已领过（幂等成功，非错误）
    pub claimed: bool,
    /// 给前端展示的一句话
    pub message: String,
}

/// 领取一次性 trial 加油包。仅国际版账号可调（CN 无此端点）——
/// 调用方（api 层）负责 edition 闸，这里不重复判（与 refs 的客户端侧防线
/// 对应的是 api 层的 400「该动作仅限国际版账号」）。
///
/// 两种「已领过」形态都识别（refs trial.go:18-21）：
///   - HTTP 200 + 业务 code=14051（`expect_code_ok=false` 直接拿到 code）；
///   - HTTP ≥400 且 body 带 `"code":14051`（call_billing 把业务码放进
///     `upstream_code`，与 refs doJSON 把原始 body 塞进 Msg 的两种指纹等价）。
pub async fn claim_trial(
    service: &BillingService,
    session: &Value,
) -> Result<TrialOutcome, BillingError> {
    let options = CallOptions {
        session: Some(session),
        // 幂等码要从非 0 业务码里读，不能让 call_billing 替我们报错
        expect_code_ok: false,
        extra: growth_extra(session, false),
        ..Default::default()
    };
    match service.call_billing(TRIAL_CLAIM, options).await {
        Ok(call) => {
            if call.code == Some(0) {
                return Ok(TrialOutcome {
                    claimed: true,
                    message: "trial 加油包领取成功".to_string(),
                });
            }
            if call.code == Some(TRIAL_ALREADY_CODE) {
                return Ok(TrialOutcome {
                    claimed: false,
                    message: "trial 加油包已领取过（一次性权益）".to_string(),
                });
            }
            Err(BillingError::with_code(
                call.msg
                    .unwrap_or_else(|| format!("trial 领取返回 code={:?}", call.code)),
                502,
                call.code,
            ))
        }
        // HTTP ≥400 形态：refs 的 `"code":14051` 指纹 —— call_billing 把
        // payload.code 放进 upstream_code 透出
        Err(error) if error.upstream_code == Some(TRIAL_ALREADY_CODE) => Ok(TrialOutcome {
            claimed: false,
            message: "trial 加油包已领取过（一次性权益）".to_string(),
        }),
        Err(error) => Err(error),
    }
}
