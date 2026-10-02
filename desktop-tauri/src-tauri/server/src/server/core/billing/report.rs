//! 四指纹行为上报器：同一 `POST /v2/report` 通道上的**四套客户端指纹**
//! （照抄 refs upstream/report.go / desktop.go / school.go，勿自创字段）。
//!
//!   - **CLI**（refs report.go）：billingBase + BillingHeaders；事件必须带
//!     `userId`（=账号 uid），缺失则服务端 200 但**静默丢弃**（report.go 模块头）。
//!   - **桌面**（refs desktop.go）：chatBase + 桌面 UA
//!     `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1` + ideName/extName 指纹字段；
//!     点亮「需电脑端」类任务（RichMeow / Buddy_App / automation / template…）。
//!   - **web**（refs desktop.go ReportWebEvent）：webBase + `x-client-platform: web`
//!     + 浏览器形状事件（os/machineId/userAgent）—— Library_read 等页面行为类。
//!   - **mp**（refs school.go ReportMPEvent）：billingBase + X-Client-Platform:
//!     mp-weixin / X-Platform: wechatmp / extName=workbuddy-mp —— 小程序口径
//!     （M4 的小程序链路预留，本切片无调用点）。
//!
//! 事件序列构造器逐字段照抄各 go 文件（实测点亮记录见 desktop.go 模块头），
//! 只暴露「按任务 code 构造事件序列」的纯函数 —— 上报动作的编排（accept →
//! 上报 → 回读 → 领奖）在 `core::growth_queue`。

use serde_json::{json, Value};

use super::request::{
    client_token, growth_extra, raw_json_call, BillingBase, BillingSpec, CallOptions, BILLING_BASE,
    CHAT_BASE, WEB_BASE,
};
use super::{BillingError, BillingService};

// ─── 端点 ───────────────────────────────────────────────────

/// CLI 指纹上报端点（refs report.go:22 reportPath），billing 域。
const REPORT_ACTIVITY: BillingSpec = BillingSpec {
    method: "POST",
    path: "/v2/report",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Billing,
};

/// 桌面/web/mp 共用的上报路径（refs desktop.go:40 / school.go:56）。
const REPORT_PATH: &str = "/v2/report";

/// 外观主题设置端点（refs desktop.go:41，chat 域；Hp_Appearance 组合动作用）。
pub(super) const APPEARANCE_SET_PATH: &str = "/v2/user-asset/appearance/set";

// ─── 指纹常量（照抄 refs，勿改值）───────────────────────────

/// 桌面客户端 UA（refs desktop.go:43，5.5.6 内嵌 CLI 2.137.1）；
/// 专家市场（expert.rs）复用。
pub(super) const DESKTOP_UA: &str = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1";
/// web 端浏览器 UA（refs desktop.go:267）。
const WEB_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
/// 桌面指纹固定字段（refs desktop.go:69-70 实测抓包值）。
const DESKTOP_RELEASE_DATE: i64 = 1_789_036_585_355;
const DESKTOP_COMMIT: &str = "5f9692923c93033111c51ad7b003eb80204a9b75";
/// 桌面指纹环境字段（refs desktop.go:78-82 实测抓包值）。
const DESKTOP_OS_VERSION: &str = "10.0.26220";
const DESKTOP_CPU_CORES: i64 = 20;
const DESKTOP_MEMORY_SIZE: i64 = 24;

// ─── 动作常量（队列编排用，值照抄 refs autotask.go 的各动作实现）────

/// Buddy_App / Buddy_App_QQ 共用的判据应用：企鹅教师助手
/// （refs autotask.go:853，同一组事件同时满足「进入任一应用」）。
pub const BUDDY_APP_QQ_ID: &str = "cb_y5Dy46tPQGGWtueMxXbe";
/// 企鹅教师助手展示名（refs autotask.go:853）。
pub const BUDDY_APP_QQ_NAME: &str = "企鹅教师助手";
/// Library_read 的判据页面（refs autotask.go:875：资料库介绍文档 URL）。
pub const LIBRARY_DOC_URL: &str = "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm";
/// Library_read 的判据元素（refs autotask.go:876-877）。
pub const LIBRARY_ELEMENT_ID: &str = "library_doc_intro_click";
/// Library_read 的判据元素名（refs autotask.go:877）。
pub const LIBRARY_ELEMENT_NAME: &str = "WorkBuddy资料库介绍";
/// Hp_Appearance 的判据主题（refs autotask.go:992：和平精英激战金秋）。
pub const APPEARANCE_THEME_KEY: &str = "theme-tkmw7j";

/// 由 uid 稳定派生 36 位 hex 设备标识（refs desktop.go:51-54 `deriveID`：
/// sha256(salt + ":" + uid) 截 18 字节 hex），幂等：同一账号每次生成相同值。
fn derive_id(salt: &str, uid: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":");
    hasher.update(uid.as_bytes());
    let out = hasher.finalize();
    out.iter()
        .take(18)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 会话里的账号 uid（缺失空串）。
fn uid_of(session: &Value) -> String {
    session
        .get("account")
        .and_then(|account| account.get("uid"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// 会话里的账号昵称（缺失空串；桌面指纹的 username/userNickname）。
fn nickname_of(session: &Value) -> String {
    session
        .get("account")
        .and_then(|account| account.get("nickname"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// 会话里的 accessToken（缺失空串）。
fn access_token_of(session: &Value) -> String {
    session
        .get("auth")
        .and_then(|auth| auth.get("accessToken"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

// ─── CLI 指纹（refs report.go，走 call_billing 复用信封纪律）────

/// 发一条 CLI 指纹的对话活跃上报（chat_request_send）。
/// conversationID 由调用方生成（无需真实会话，服务端不校验一致性）；
/// requestID 空时回落 conversationID（refs report.go:152-154）；
/// 模型缺省 deepseek-v4-flash / DeepSeek V4 Flash（refs report.go:145-147）。
pub async fn report_chat_activity(
    service: &BillingService,
    session: &Value,
    conversation_id: &str,
    request_id: &str,
    model_id: &str,
    model_name: &str,
) -> Result<(), BillingError> {
    let request_id = if request_id.is_empty() { conversation_id } else { request_id };
    let model_id = if model_id.is_empty() { "deepseek-v4-flash" } else { model_id };
    let model_name = if model_name.is_empty() { model_id } else { model_name };
    let now = crate::server::logging::now_ms();
    // 事件字段全量照抄 refs report.go:102-139 chatRequestEvent（勿用最小 3 字段，
    // 防上游后续加严）
    let event = json!({
        "eventCode": "chat_request_send",
        "timestamp": now,
        "reportDelay": 0,
        "mode": "craft",
        "conversationId": conversation_id,
        "requestId": request_id,
        "inputLength": 12,
        "requestModelId": model_id,
        "requestModelName": model_name,
        "isPlan": false,
        "isAutoExecuteTerminal": false,
        "isAutoModify": false,
        "codebaseEnable": false,
        "maxToken": 0,
        "maxSteps": 0,
        "temperature": 0,
        "maxRetries": 0,
        "mentionContexts": [],
        "knowledgeId": [],
        "knowledgeName": [],
        "codebaseId": "",
        "mentionContextCount": 0,
        "command": "",
        "expertId": "",
        "recommendId": "",
        "skillId": "",
        "skillCount": 0,
        "totalCount": 0,
        "fileUri": "",
        "presentAt": now,
        "traceId": "",
        "rootRequestId": request_id,
        "parentConversationId": conversation_id,
        "agentName": "default",
        "agentType": "conversation",
        // userId 必填：缺失服务端 200 但静默丢弃（refs report.go 模块头）
        "userId": uid_of(session),
    });
    let body = json!([event]);
    let options = CallOptions {
        session: Some(session),
        body: Some(&body),
        // BillingHeaders 差集头（X-CodeBuddy-Request / zh-CN / billingUA）
        extra: growth_extra(session, false),
        ..Default::default()
    };
    service.call_billing(REPORT_ACTIVITY, options).await?;
    Ok(())
}

// ─── 桌面指纹（refs desktop.go）─────────────────────────────

/// 桌面事件公共指纹（refs desktop.go:60-86 `desktopFingerprint`），
/// 注入每个事件，业务字段可覆盖同名键。
fn desktop_fingerprint(session: &Value) -> Value {
    let uid = uid_of(session);
    let nickname = nickname_of(session);
    let now = crate::server::logging::now_ms();
    json!({
        "timezone": "Asia/Shanghai",
        "reportDelay": 2000,
        "userId": uid,
        "username": nickname,
        "userNickname": nickname,
        "product": "SaaS",
        "releaseDate": DESKTOP_RELEASE_DATE,
        "commit": DESKTOP_COMMIT,
        "ideName": "WorkBuddy",
        "ideType": "WorkBuddy",
        "ideVersion": "5.5.6",
        "machineId": derive_id("machine", &uid),
        "sessionId": derive_id("session", &uid),
        "extName": "workbuddy-desktop",
        "extVersion": "5.5.6",
        "os": "win32",
        "arch": "x64",
        "osVersion": DESKTOP_OS_VERSION,
        "cpuCores": DESKTOP_CPU_CORES,
        "memorySize": DESKTOP_MEMORY_SIZE,
        "timestamp": now,
        "presentAt": now,
    })
}

/// 对象合并：指纹打底、业务字段覆盖（refs desktop.go:97-104 的 map 拷贝顺序）。
fn merge_event(base: &Value, event: Value) -> Value {
    let mut merged = match base {
        Value::Object(map) => map.clone(),
        _ => serde_json::Map::new(),
    };
    if let Value::Object(fields) = event {
        for (key, value) in fields {
            merged.insert(key, value);
        }
    }
    Value::Object(merged)
}

/// 以桌面客户端指纹向 copilot.tencent.com/v2/report 批量上报事件
/// （refs desktop.go:91-127 `ReportDesktopEvent`）。
pub async fn report_desktop_events(
    session: &Value,
    events: Vec<Value>,
) -> Result<(), BillingError> {
    if events.is_empty() {
        return Err(BillingError::new("desktop report: no events", 400));
    }
    let fingerprint = desktop_fingerprint(session);
    let body = Value::Array(
        events
            .into_iter()
            .map(|event| merge_event(&fingerprint, event))
            .collect(),
    );
    let uid = uid_of(session);
    let mut headers = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", access_token_of(session)),
        ),
        (
            "Accept".to_string(),
            "application/json, text/plain, */*".to_string(),
        ),
        (
            "Content-Type".to_string(),
            "application/json;charset=UTF-8".to_string(),
        ),
        ("User-Agent".to_string(), DESKTOP_UA.to_string()),
        // X-Domain = chatBase（refs desktop.go:119）
        ("X-Domain".to_string(), CHAT_BASE.to_string()),
        ("X-Product".to_string(), "SaaS".to_string()),
        (
            "X-Request-ID".to_string(),
            format!(
                "{}{}",
                derive_id("req", &uid),
                unique_suffix()
            ),
        ),
    ];
    if !uid.is_empty() {
        headers.push(("X-User-Id".to_string(), uid));
    }
    let proxy = BillingService::proxy_of(session);
    let url = format!("{CHAT_BASE}{REPORT_PATH}");
    raw_json_call("POST", &url, Some(&body), &headers, proxy.as_ref()).await?;
    Ok(())
}

/// X-Request-ID 的尾缀（refs desktop.go:121：`UnixNano() % 1e6`）。
fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos() as i64)
        .unwrap_or(0);
    format!("{}", nanos % 1_000_000)
}

/// 构造一次「桌面端成功对话」的完整事件链（refs desktop.go:133-201
/// `DesktopChatSequence`，实测点亮 RichMeow_Chat）。
pub fn desktop_chat_sequence(
    conversation_id: &str,
    request_id: &str,
    message_id: &str,
    model_id: &str,
    model_name: &str,
) -> Vec<Value> {
    // refs 的 uuid 闭包就是返回 requestID
    let uuid = request_id;
    let now = crate::server::logging::now_ms();
    vec![
        json!({
            "eventCode": "agent_task_created",
            "source": "LOCAL", "name": "working", "task_target": "local", "mode": "craft",
            "requestModelId": model_id, "requestModelName": model_name,
            "has_repo": false, "repo_type": "none", "workspace_type": "empty",
            "has_connector": false, "connector_types": [],
            "has_mention": false, "mention_types": [],
            "has_template": false, "action": "", "template_name": "",
            "has_expert": false, "expert_id": "", "expert_name": "", "expert_industry_id": "",
            "has_skill": false, "skill_names": [],
            "conversationId": conversation_id, "messageId": message_id,
            "buddyId": "", "buddyName": "",
        }),
        json!({
            "eventCode": "chat_message_send",
            "messageId": format!("{message_id}-assistant"), "historyCount": 0,
            "isContextTruncated": false, "currentStepCount": 1,
            "traceId": uuid, "rootRequestId": request_id,
            "parentConversationId": conversation_id,
            "agentName": "cli", "agentType": "main",
        }),
        json!({
            "eventCode": "chat_request_send",
            "inputLength": 24, "isPlan": false, "isAutoExecuteTerminal": false,
            "isAutoModify": false, "codebaseEnable": false, "maxToken": 0,
            "maxSteps": 500, "temperature": 0, "maxRetries": 0,
            "mentionContexts": [], "knowledgeId": [], "knowledgeName": [],
            "codebaseId": "", "mentionContextCount": 0, "command": "",
            "recommendId": "", "skillId": "", "skillCount": 0, "totalCount": 0,
            "traceId": uuid, "rootRequestId": request_id,
            "parentConversationId": conversation_id,
            "agentName": "cli", "agentType": "main",
            "codebuddy.session_id": conversation_id,
            "codebuddy.conversation_request_id": request_id,
        }),
        json!({
            "eventCode": "chat_message_response",
            "messageId": format!("{message_id}-assistant"), "responseModelId": model_id,
            "inputToken": 120, "outputToken": 80, "totalToken": 200,
            "cachedTokens": 0, "cachedWriteTokens": 0, "cachedMissTokens": 0,
            "isSuccessful": true, "messageErrorCode": "", "finishReason": "stop",
            "firstTokenAt": now, "traceId": uuid,
            "conversationId": conversation_id,
            "rootRequestId": request_id, "parentConversationId": conversation_id,
            "agentName": "cli", "agentType": "main",
            "codebuddy.session_id": conversation_id,
            "codebuddy.conversation_request_id": request_id,
        }),
        json!({
            "eventCode": "chat_message_status",
            "messageId": format!("{message_id}-assistant"), "messageErrorCode": "0",
            "traceId": uuid, "rootRequestId": request_id,
            "parentConversationId": conversation_id,
            "agentName": "cli", "agentType": "main",
        }),
        json!({
            "eventCode": "chat_request_response",
            "mode": "craft", "toolCallCount": 0,
            "inputToken": 120, "outputToken": 80, "totalToken": 200,
            "cachedTokens": 0, "cachedWriteTokens": 0, "cachedMissTokens": 0,
            "isSuccessful": true, "messageErrorCode": "", "finishReason": "stop",
            "rootRequestId": request_id, "parentConversationId": conversation_id,
        }),
    ]
}

/// 「进入 Buddy 应用」五连事件（refs desktop.go:232-250 `DesktopBuddyAppSequence`，
/// 实测两账号纯 API 点亮 Buddy_App 与 Buddy_App_QQ）：discover → show →
/// enter_click → auth_confirm → bindaccount_skip。
pub fn desktop_buddy_app_sequence(buddy_id: &str, buddy_name: &str) -> Vec<Value> {
    vec![
        json!({ "eventCode": "buddyapp_discover_click", "mode": "LOCAL",
                "buddyId": buddy_id, "buddyName": buddy_name }),
        json!({ "eventCode": "buddyapp_show", "mode": "LOCAL",
                "buddyId": buddy_id, "buddyName": buddy_name,
                "elementId": buddy_id, "elementName": buddy_name, "position": 2 }),
        json!({ "eventCode": "buddyapp_enter_click", "mode": "LOCAL",
                "buddyId": buddy_id, "buddyName": buddy_name,
                "elementId": buddy_id, "elementName": buddy_name,
                "position": 2, "isFirstPage": "1" }),
        json!({ "eventCode": "buddyapp_auth_confirm_click", "mode": "LOCAL",
                "buddyId": buddy_id, "buddyName": buddy_name,
                "elementId": buddy_id, "elementName": buddy_name }),
        json!({ "eventCode": "buddyapp_bindaccount_skip_click", "mode": "LOCAL",
                "buddyId": buddy_id, "buddyName": buddy_name,
                "elementId": buddy_id, "elementName": buddy_name }),
    ]
}

/// 「定时任务创建成功」事件（refs desktop.go:254-261，实测点亮 automation_1）。
pub fn desktop_automation_create_event(name: &str) -> Value {
    json!({
        "eventCode": "automated_task_create_suc", "name": name,
        "source": "manually", "modelId": "fast-model", "modelIsThinking": true,
        "connectorCount": 0, "skills": "", "skillCount": 0,
        "scheduleType": "once", "mode": "LOCAL",
    })
}

/// 「使用模板创建任务」事件组（refs desktop.go:307-317
/// `DesktopTemplateUseSequence`：agent_task_created_with_template +
/// template_used JOIN 一条完整 chat 链；5 组不同模板 → 5/5 点亮）。
pub fn desktop_template_use_sequence(
    conversation_id: &str,
    request_id: &str,
    template_id: &str,
    template_name: &str,
) -> Vec<Value> {
    let mut events = desktop_chat_sequence(conversation_id, request_id, &format!("msg-{template_id}"), "fast-model", "fast-model");
    events.push(json!({
        "eventCode": "agent_task_created_with_template", "mode": "working",
        "isCustomModel": false, "id": template_id, "name": template_name,
        "requestId": request_id,
    }));
    events.push(json!({
        "eventCode": "template_used", "template_id": template_id,
        "task_mode": "working",
    }));
    events
}

/// 「灵感案例做同款」事件组（refs desktop.go:322-349
/// `DesktopPlaybookPromptSequence`：playbook_cta_click + playbook_prompt_send
/// JOIN chat 链）。
pub fn desktop_playbook_prompt_sequence(
    conversation_id: &str,
    request_id: &str,
    case_id: &str,
    case_name: &str,
) -> Vec<Value> {
    let mut events = desktop_chat_sequence(conversation_id, request_id, "msg-pb", "fast-model", "fast-model");
    events.push(json!({
        "eventCode": "web_element_click", "pageName": "playbook_detail",
        "elementId": "playbook_ctaClick", "elementName": case_name, "source": "discover",
    }));
    events.push(json!({
        "eventCode": "playbook_cta_click", "source": "discover", "position": 0,
        "id": case_id, "name": case_name, "type": "document",
        "categoryId": "", "categoryName": "",
    }));
    events.push(json!({
        "eventCode": "playbook_prompt_send", "source": "discover",
        "conversationId": conversation_id, "requestId": request_id,
        "id": case_id, "name": case_name, "type": "document",
        "categoryId": "", "categoryName": "",
    }));
    events
}

/// 「设计创意画布」事件组（refs desktop.go:354-367
/// `DesktopDesignCanvasSequence`：wbx_design_canvas_task_create/open）。
pub fn desktop_design_canvas_sequence(
    conversation_id: &str,
    request_id: &str,
) -> Vec<Value> {
    let mut events = desktop_chat_sequence(conversation_id, request_id, "msg-canvas", "fast-model", "fast-model");
    events.push(json!({
        "eventCode": "wbx_design_canvas_task_create", "conversationId": conversation_id,
        "requestId": request_id, "source": "summon_keyword", "cost": 12000,
        "isSuccessful": true,
    }));
    events.push(json!({
        "eventCode": "wbx_design_canvas_open", "conversationId": conversation_id,
        "requestId": request_id, "id": format!("ardot-file-{}", request_id.get(request_id.len().saturating_sub(8)..).unwrap_or(request_id)),
        "source": "summon_keyword", "type": "page", "cost": 13000,
        "isSuccessful": true,
    }));
    events
}

/// 「皮肤生效」事件（refs autotask.go:997-999 runAppearance 的事件形状）。
pub fn appearance_skin_apply_event(theme_key: &str) -> Value {
    json!({
        "eventCode": "appearance_skin_apply", "action": "apply",
        "source": "settings_close", "id": theme_key,
        "vipLevel": 0, "series": "", "type": "unknown",
    })
}

// ─── web 指纹（refs desktop.go ReportWebEvent）──────────────

/// 以 Web 端指纹向 www.workbuddy.cn/v2/report 上报单事件
/// （refs desktop.go:266-295；Library_read 实测 4 秒点亮）。
pub async fn report_web_event(
    session: &Value,
    event_code: &str,
    page_url: &str,
    element_id: &str,
    element_name: &str,
) -> Result<(), BillingError> {
    let uid = uid_of(session);
    let now = crate::server::logging::now_ms();
    let event = json!({
        "eventCode": event_code, "timestamp": now, "reportDelay": 0,
        "pageURL": page_url, "elementId": element_id, "elementName": element_name,
        "os": "Win32", "arch": "", "osVersion": "10.0", "userAgent": WEB_UA,
        "machineId": derive_id("webmachine", &uid), "userId": uid,
        "userNickname": nickname_of(session),
        "enterpriseId": session
            .get("account")
            .and_then(|account| account.get("enterpriseId"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    });
    let body = json!([event]);
    let mut headers = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", access_token_of(session)),
        ),
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Accept".to_string(), "application/json".to_string()),
        ("x-client-platform".to_string(), "web".to_string()),
        ("Origin".to_string(), WEB_BASE.to_string()),
        ("Referer".to_string(), page_url.to_string()),
        ("User-Agent".to_string(), WEB_UA.to_string()),
    ];
    if !uid.is_empty() {
        headers.push(("X-User-Id".to_string(), uid));
    }
    let proxy = BillingService::proxy_of(session);
    let url = format!("{WEB_BASE}{REPORT_PATH}");
    raw_json_call("POST", &url, Some(&body), &headers, proxy.as_ref()).await?;
    Ok(())
}

// ─── mp 指纹（refs school.go ReportMPEvent，M4 小程序链路预留）──

/// 小程序埋点公共指纹（refs school.go:62-80 `mpEventBase`）。
fn mp_fingerprint(session: &Value) -> Value {
    let uid = uid_of(session);
    let now = crate::server::logging::now_ms();
    json!({
        "timestamp": now,
        "ideType": "WorkBuddy_MP",
        "ideVersion": "2.4.0",
        "extName": "workbuddy-mp",
        "extVersion": "2.4.0",
        "product": "SaaS",
        "ideName": "wx_app_cloud",
        "platform": "mini_program",
        "os": "windows",
        "osVersion": "11",
        "arch": "x64",
        "machineId": "0655736a-607f-4d9d-b430-58176ee9a090",
        "timezone": "Asia/Shanghai",
        "userId": uid,
        "userNickname": nickname_of(session),
    })
}

/// 以小程序指纹向 www.codebuddy.cn/v2/report 批量上报事件
/// （refs school.go:83-119；头集合 X-Client-Platform: mp-weixin /
/// X-Platform: wechatmp / extName=workbuddy-mp 指纹）。
pub async fn report_mp_events(
    session: &Value,
    events: Vec<Value>,
) -> Result<(), BillingError> {
    if events.is_empty() {
        return Err(BillingError::new("mp report: no events", 400));
    }
    let fingerprint = mp_fingerprint(session);
    let body = Value::Array(
        events
            .into_iter()
            .map(|event| merge_event(&fingerprint, event))
            .collect(),
    );
    let uid = uid_of(session);
    let mut headers = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", access_token_of(session)),
        ),
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Accept".to_string(), "application/json".to_string()),
        ("X-Client-Product".to_string(), "workbuddy-mp".to_string()),
        ("X-Client-Version".to_string(), "2.4.0".to_string()),
        ("X-Client-Platform".to_string(), "mp-weixin".to_string()),
        ("X-Platform".to_string(), "wechatmp".to_string()),
    ];
    if !uid.is_empty() {
        headers.push(("X-User-Id".to_string(), uid));
    }
    let proxy = BillingService::proxy_of(session);
    let url = format!("{BILLING_BASE}{REPORT_PATH}");
    raw_json_call("POST", &url, Some(&body), &headers, proxy.as_ref()).await?;
    Ok(())
}

// ─── 外观主题（refs desktop.go SetAppearanceTheme）──────────

/// 应用外观主题（refs desktop.go:203-226：POST chat 域
/// /v2/user-asset/appearance/set）。Hp_Appearance 的组合动作：
/// set API 留痕 + appearance_skin_apply 事件上报（autotask.go:986-1004）。
pub async fn set_appearance_theme(
    session: &Value,
    resource_key: &str,
) -> Result<(), BillingError> {
    let body = json!({ "kind": "theme", "resource_key": resource_key });
    let uid = uid_of(session);
    let mut headers = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", access_token_of(session)),
        ),
        (
            "Accept".to_string(),
            "application/json, text/plain, */*".to_string(),
        ),
        (
            "Content-Type".to_string(),
            "application/json;charset=UTF-8".to_string(),
        ),
        ("User-Agent".to_string(), DESKTOP_UA.to_string()),
        ("X-Product".to_string(), "SaaS".to_string()),
    ];
    if !uid.is_empty() {
        headers.push(("X-User-Id".to_string(), uid));
    }
    let proxy = BillingService::proxy_of(session);
    let url = format!("{CHAT_BASE}{APPEARANCE_SET_PATH}");
    raw_json_call("POST", &url, Some(&body), &headers, proxy.as_ref()).await?;
    Ok(())
}

// ─── mp 指纹事件载荷构造器（refs school.go，判据事件的业务字段部分）────
// （公共指纹在 mp_fingerprint，由 report_mp_events 注入；此处只造业务载荷）

/// 一条 mp chat_request_send 事件（refs school.go:122-139
/// `SchoolChatTimesEvents`：chat_3_times / Sequential 链的计数判据）。
pub fn mini_chat_event(conversation_id: &str) -> Value {
    let rid = format!("wb2api-{}", client_token());
    let message_tail = rid.get(rid.len().saturating_sub(8)..).unwrap_or(&rid).to_string();
    json!({
        "eventCode": "chat_request_send",
        "inputLength": 14, "isPlan": false, "isAutoExecuteTerminal": false,
        "isAutoModify": false, "codebaseEnable": false, "maxToken": 0,
        "maxSteps": 500, "temperature": 0, "maxRetries": 0,
        "mentionContexts": [], "knowledgeId": [], "knowledgeName": [],
        "codebaseId": "", "mentionContextCount": 0, "command": "",
        "recommendId": "", "skillId": "", "skillCount": 0, "totalCount": 0,
        "traceId": rid, "rootRequestId": rid,
        "parentConversationId": conversation_id, "conversationId": conversation_id,
        "messageId": format!("msg-{message_tail}"),
        "agentName": "mp", "agentType": "main",
        "codebuddy.session_id": conversation_id,
        "codebuddy.conversation_request_id": rid,
    })
}

/// growth 域「校园日」判据事件（refs school.go:145-149
/// `SchoolSeasonChatEvent`：mini chat + activityId，无 activityId 不点亮）。
pub fn school_season_chat_event(conversation_id: &str) -> Value {
    let mut event = mini_chat_event(conversation_id);
    if let Some(object) = event.as_object_mut() {
        // refs school.go:59 schoolOpenDayActivityID（两域共用）
        object.insert("activityId".to_string(), json!("school_open_day_2026"));
    }
    event
}

/// mp 对话事件 + 模型字段（refs school.go:180-185 `MiniChatModelEvent`：
/// Sequential_Tasks_5「使用 GLM5.2」判据载体，裸对话事件不带模型）。
pub fn mini_chat_model_event(conversation_id: &str, model_id: &str, model_name: &str) -> Value {
    let mut event = mini_chat_event(conversation_id);
    if let Some(object) = event.as_object_mut() {
        object.insert("requestModelId".to_string(), json!(model_id));
        object.insert("requestModelName".to_string(), json!(model_name));
    }
    event
}

/// mp 指纹 expert_actual_use（refs school.go:160-174 `MiniExpertUseEvent`：
/// Sequential_Tasks_2 判据；不带 conversationId/activityId、extVersion=2.2.8、
/// source=mini_program、type 恒 "send_message"；expertID 必须是市场真实 ex_ id）。
pub fn mini_expert_use_event(expert_id: &str, expert_name: &str, expert_type: &str) -> Value {
    let expert_type = if expert_type.is_empty() { "agent" } else { expert_type };
    let expert_name = if expert_name.is_empty() { expert_id } else { expert_name };
    json!({
        "eventCode": "expert_actual_use", "reportDelay": 0,
        "extVersion": "2.2.8", "source": "mini_program",
        "id": expert_id, "name": expert_id,
        "expertTitle": expert_name, "type": "send_message",
        "characterCount": 12, "expertType": expert_type,
    })
}

/// mp 指纹灵感事件组（refs school.go:192-215 `MiniPlaybookEvents`：
/// Sequential_Tasks_7 判据载体，playbook_cta_click → playbook_prompt_send）。
pub fn mini_playbook_events(case_id: &str, case_name: &str) -> Vec<Value> {
    let base = json!({
        "id": case_id, "name": case_name, "type": "document",
        "categoryId": "", "categoryName": "",
        "skills": "", "skillNames": "",
    });
    let with_base = |extra: Value| -> Value {
        let mut merged = base.as_object().cloned().unwrap_or_default();
        if let Some(fields) = extra.as_object() {
            for (key, value) in fields {
                merged.insert(key.clone(), value.clone());
            }
        }
        Value::Object(merged)
    };
    let send_conversation = format!("wb2api-mp-pb-{}", client_token());
    vec![
        with_base(json!({
            "eventCode": "playbook_cta_click", "source": "discover", "position": 1,
            "extVersion": "2.2.8",
        })),
        with_base(json!({
            "eventCode": "playbook_prompt_send", "source": "discover",
            "promptLength": 96, "isOfficial": 1,
            "conversationId": send_conversation,
            "extVersion": "2.2.8",
        })),
    ]
}

// ─── 桌面指纹专家事件（refs desktop.go，expert_5 / 团 / 轻量云判据）────

/// 「召唤平台专家」事件组（refs desktop.go:523-550
/// `DesktopExpertSummonSequence`：web_element_click + expert_summon_click +
/// expert_summoned，载荷对齐真实抓包样本 row 2644）。
pub fn desktop_expert_summon_sequence(expert: &super::expert::MarketExpert) -> Vec<Value> {
    let category = expert.first_category();
    let version = expert.version_or_default();
    vec![
        json!({
            "eventCode": "web_element_click", "source": expert.expert_id,
            "type": category, "version": version,
            "elementId": "expert_summon_click", "elementName": "立即召唤",
            "pageURL": "/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html",
        }),
        json!({
            "eventCode": "expert_summon_click", "id": expert.expert_id,
            "name": expert.display_name_zh, "expertTitle": expert.profession_zh,
            "type": "expert-all", "position": 0,
            "expertType": expert.expert_type, "version": version, "mode": "LOCAL",
        }),
        json!({
            "eventCode": "expert_summoned", "id": expert.expert_id,
            "name": expert.display_name_zh, "expertTitle": expert.profession_zh,
            "type": "expert-all",
        }),
    ]
}

/// expert_actual_use 公共载荷（refs desktop.go:569-588）。
fn desktop_expert_actual_use(expert: &super::expert::MarketExpert, conversation_id: &str, request_id: &str) -> Value {
    let category = expert.first_category();
    let version = expert.version_or_default();
    json!({
        "eventCode": "expert_actual_use",
        "id": expert.expert_id, "name": expert.display_name_zh,
        "expertTitle": expert.profession_zh,
        "type": category, "expertType": expert.expert_type, "source": "builtin",
        "version": version,
        "cost": 9000, "characterCount": 14,
        "conversationId": conversation_id, "requestId": request_id,
        "messageId": format!("msg-{}", request_id.get(request_id.len().saturating_sub(8)..).unwrap_or(request_id)),
        "requestModelId": "fast-model", "requestModelName": "fast-model",
    })
}

/// 「专家真实使用」事件 mode:"craft" 变体（refs desktop.go:554-558，
/// expert_5/Expert_team_use_3 计数；requestID 必须是真实对话的服务端 id）。
pub fn desktop_expert_actual_use_event(expert: &super::expert::MarketExpert, conversation_id: &str, request_id: &str) -> Value {
    let mut event = desktop_expert_actual_use(expert, conversation_id, request_id);
    if let Some(object) = event.as_object_mut() {
        object.insert("mode".to_string(), json!("craft"));
    }
    event
}

/// mode:"LOCAL" 变体（refs desktop.go:560-566：Expert_lighthouse 判据要求
/// LOCAL，对齐真实样本 row 868：type 空、cost=0 由调用方覆盖）。
pub fn desktop_expert_actual_use_local(expert: &super::expert::MarketExpert, conversation_id: &str, request_id: &str) -> Value {
    let mut event = desktop_expert_actual_use(expert, conversation_id, request_id);
    if let Some(object) = event.as_object_mut() {
        object.insert("mode".to_string(), json!("LOCAL"));
    }
    event
}
