//! 专家市场列表（expert_5 / Expert_team_use_3 / Expert_lighthouse /
//! Sequential_Tasks_2 的**判据载体前置**：expert_actual_use 的判据校验要求
//! id 是平台上真实存在的专家——编造 id 不计数，空 id 服务端不入账）。
//!
//! 端点（refs desktop.go:390）：`POST {chatBase}/portal/operation-platform/
//! market/expert/list`，body {page, page_size, sort_by, sort_order[, expert_type]}，
//! 头集合为桌面指纹形态（desktop.go:394-401），信封 {code,msg,data} 同 doJSON。

use serde_json::{json, Value};

use super::request::{raw_json_call, CHAT_BASE};
use super::{BillingError, BillingService};

/// 专家市场的单个专家（refs desktop.go:369-377 MarketExpert 字段子集）。
#[derive(Debug, Clone, Default)]
pub struct MarketExpert {
    pub expert_id: String,
    pub expert_type: String,
    pub display_name_zh: String,
    pub profession_zh: String,
    pub version: String,
    pub categories: Vec<Value>,
}

impl MarketExpert {
    /// 首个分类（refs desktop.go:524-527：categories[0]，缺省 "expert-all"）。
    pub fn first_category(&self) -> String {
        self.categories
            .first()
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or("expert-all")
            .to_string()
    }

    /// 版本（refs desktop.go:528-531：缺省 "1.0.0"）。
    pub fn version_or_default(&self) -> String {
        if self.version.is_empty() {
            "1.0.0".to_string()
        } else {
            self.version.clone()
        }
    }
}

/// 拉取专家市场真实专家列表（refs desktop.go:381-413 `MarketExpertList`）。
/// `expert_type`：`"agent"` 单专家 / `"team"` 专家团 / 空串不过滤
/// （Sequential_Tasks_2 用空串，refs autotask.go:575）。
pub async fn market_expert_list(
    _service: &BillingService,
    session: &Value,
    expert_type: &str,
) -> Result<Vec<MarketExpert>, BillingError> {
    let mut body = json!({
        "page": 1, "page_size": 20,
        "sort_by": "reco_rank", "sort_order": "desc",
    });
    if !expert_type.is_empty() {
        if let Some(object) = body.as_object_mut() {
            object.insert("expert_type".to_string(), json!(expert_type));
        }
    }
    // 头集合照抄 refs desktop.go:394-401（桌面指纹形态，非 BillingHeaders）
    let uid = session
        .get("account")
        .and_then(|account| account.get("uid"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let token = session
        .get("auth")
        .and_then(|auth| auth.get("accessToken"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut headers = vec![
        ("Authorization".to_string(), format!("Bearer {token}")),
        ("Content-Type".to_string(), "application/json".to_string()),
        ("User-Agent".to_string(), super::report::DESKTOP_UA.to_string()),
        ("X-Domain".to_string(), CHAT_BASE.to_string()),
        ("X-Product".to_string(), "SaaS".to_string()),
    ];
    if !uid.is_empty() {
        headers.push(("X-User-Id".to_string(), uid));
    }
    let proxy = super::BillingService::proxy_of(session);
    let url = format!("{CHAT_BASE}/portal/operation-platform/market/expert/list");
    let call = raw_json_call("POST", &url, Some(&body), &headers, proxy.as_ref()).await?;
    let experts = call.data.get("experts").and_then(Value::as_array);
    let mut out = Vec::new();
    for expert in experts.into_iter().flatten() {
        out.push(MarketExpert {
            expert_id: expert
                .get("expert_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            expert_type: expert
                .get("expert_type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            display_name_zh: expert
                .get("display_name_zh")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            profession_zh: expert
                .get("profession_zh")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            version: expert
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            categories: expert
                .get("categories")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        });
    }
    Ok(out)
}
