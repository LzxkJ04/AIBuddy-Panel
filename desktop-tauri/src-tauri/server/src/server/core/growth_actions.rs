//! 成长任务的动作实现（对照 refs workbuddy2api-panel internal/panel/autotask.go
//! 的 autoActions 表逐项移植；执行编排与队列在 `core::growth_queue`）。
//!
//! ── 判据来源（autotask.go 模块头，2026-09-12 桌面指纹协议逆向 + 实测）──
//!   - chat_5（+100 分）：累计 5 条 chat_request_send 上报（自动补差额）
//!   - first_buddy（+300 分）：report（前置解锁）→ agreement → buddy/first
//!   - Model_chat_GLM5.2（+100 分）：accept → glm-5.2 真实对话一次 → 对齐模型上报
//!   - RichMeow_Chat：桌面指纹完整对话事件链（纯 API 可点亮，三账号实测）
//!   - Buddy_App / Buddy_App_QQ：buddyapp 五连事件（纯 API 可点亮）
//!   - automation_1：automated_task_create_suc 事件
//!   - Library_read：web 域 web_element_click(library_doc_intro_click)
//!   - template_5 / playbook_prompt / create_canvas：asar 逆向判据事件组
//!   - expert_5 / Expert_team_use_3：真实专家列表 + 召唤链 + 真实 chat（服务端
//!     requestId）+ expert_actual_use（专家链 6s 间隔，autotask.go:1050-1051）
//!   - Expert_lighthouse：轻量云专家 LOCAL 变体（has_expert + type 空 + cost 0）
//!   - skill_1：真实对话 + skill_info 技能加载事件（finishReason=tool_calls）
//!   - black_cat：夜猫子 23:00–08:00 窗口内 glm-5.2 真实对话 + 上报（每条 4s，
//!     blackcat.go:66；窗口外不做）
//!   - school_season / Sequential_Tasks_1..7：mp 口径链（accept 验证 → mini
//!     chat 事件 45s+0~10s 抖动 → 回读 → 领奖；连发会被反作弊判无效回滚，
//!     autotask.go:320-326）
//!
//! 所有动作幂等：已 claimed/已达标的任务由队列在执行前跳过，不重复消耗配额。

use std::time::Duration;

use chrono::Timelike;
use serde_json::{json, Value};

use crate::server::core::billing::expert::{market_expert_list, MarketExpert};
use crate::server::core::billing::growth::{self};
use crate::server::core::billing::report;
use crate::server::core::billing::travel;
use crate::server::core::billing::{BillingError, BillingService};
use crate::server::core::providers::workbuddy::growth_chat_request_id;
use crate::server::logging;

// ─── 节流常量（全部照抄 refs，出处逐条标注）────────────────────

/// 主题 set 与皮肤生效事件之间的等待（refs autotask.go:996 `2s`）。
const APPEARANCE_APPLY_GAP_MS: u64 = 2_000;

/// mp 对话事件的真人节奏间隔（refs autotask.go:326 `mpChatEventGap = 45s`：
/// 数秒级连发的事件先被计入进度、随后被反作弊判定无效整体回滚——45s 间隔
/// 逐条上报全存活）。
const MP_CHAT_EVENT_GAP_MS: u64 = 45_000;

/// mp 对话事件的抖动上限（refs autotask.go:370 `rand.Int64N(10s)`：
/// 每条上报前 sleep 45s + 0~10s 抖动）。
const MP_CHAT_JITTER_MS: u64 = 10_000;

/// 专家召唤链的间隔（refs autotask.go:1050-1051 `expertSummonGap = 6s`，
/// 真实使用节奏，v11 实测 8s 成功率 100%）。
const EXPERT_SUMMON_GAP_MS: u64 = 6_000;

/// 夜猫子每条对话的上报间隔（refs blackcat.go:66 `time.Sleep(4s)`）。
const NIGHT_CHAT_GAP_MS: u64 = 4_000;

/// Expert_lighthouse 的固定专家 id（refs autotask.go:946：轻量云专家）。
const LIGHTHOUSE_ID: &str = "ex_2cvvUZQhDyeJ";

/// 动作结果：`Done` = 判据链跑完（队列做回读 + 领奖）；`Skipped` = 无需/无法
/// 执行（带可读原因，直接落队列项，不做回读）。
#[derive(Debug, Clone)]
pub enum ActionOutcome {
    Done,
    Skipped(String),
}

use ActionOutcome::{Done, Skipped};

/// GatewayError → BillingError（`growth_chat_request_id` 返回的是 GatewayError，
/// 动作链统一用 BillingError 传播；刻意不给 errors.rs 加 `From` 实现 —— 那会
/// 暗示两种错误类型全局互通，实际只有这一处转换）。
fn gateway_into_billing(error: crate::server::errors::GatewayError) -> BillingError {
    BillingError::new(error.message, error.status_code)
}

/// 按任务码执行判据链。`task` 是执行前的任务快照（补差额用）。
pub async fn run_action(
    service: &BillingService,
    session: &Value,
    code: &str,
    task: &growth::Task,
) -> Result<ActionOutcome, BillingError> {
    let conversation = |tag: &str| format!("wb2api-{tag}-{}", logging::now_ms());
    match code {
        // chat_5：按差额上报 chat_request_send（refs autotask.go:747-774）
        "chat_5" => {
            let target = if task.target > 0 { task.target } else { 5 };
            let need = (target - task.current).max(0);
            if need == 0 {
                return Ok(Done);
            }
            for index in 0..need {
                let conversation_id = format!("{}-{index}", conversation("chat5"));
                report::report_chat_activity(service, session, &conversation_id, "", "", "").await?;
                // 连续上报之间保持 1.05s（refs autotask.go:745；最后一条后不等）
                if index < need - 1 {
                    tokio::time::sleep(Duration::from_millis(growth::REPORT_GAP_MS)).await;
                }
            }
            Ok(Done)
        }
        // first_buddy：解锁上报 → 同意协议 → 领养（refs autotask.go:777-792）
        "first_buddy" => {
            let conversation_id = conversation("adopt");
            report::report_chat_activity(service, session, &conversation_id, "", "", "").await?;
            tokio::time::sleep(Duration::from_millis(growth::REPORT_GAP_MS)).await;
            travel::buddy_agreement(service, session).await?;
            // 门槛未过（400 + first_buddy 关键词）属预期，错误文案透出给队列
            travel::buddy_first(service, session).await?;
            Ok(Done)
        }
        // Model_chat_GLM5.2：accept → 真实对话 → 对齐模型上报
        // （refs autotask.go:794-827 runModelChat）
        "Model_chat_GLM5.2" => {
            // 1. accept（报名；失败不阻塞——行为事件才是判据，refs:797-799）
            let codes = [code.to_string()];
            if let Err(error) = growth::accept_tasks(service, session, &codes, false).await {
                logging::log(
                    "[Growth]",
                    &format!("accept {code} 失败（继续走行为链路）: {}", error.message),
                );
            }
            tokio::time::sleep(Duration::from_millis(growth::REPORT_GAP_MS)).await;
            // 2. 真实对话一次（判据的最直接证据，refs:802-821）
            growth_chat_request_id(session, "glm-5.2", "hi，请回复一句话", "")
                .await
                .map_err(gateway_into_billing)?;
            tokio::time::sleep(Duration::from_millis(growth::REPORT_GAP_MS)).await;
            // 3. 对齐模型的上报（触发进度，refs:822-825）
            let conversation_id = format!("wb2api-glm52-{}", logging::now_ms());
            report::report_chat_activity(service, session, &conversation_id, "", "glm-5.2", "GLM-5.2")
                .await?;
            Ok(Done)
        }
        // RichMeow_Chat：桌面指纹完整对话事件链（refs autotask.go:829-845）
        "RichMeow_Chat" => {
            let conversation_id = conversation("rm");
            let request_id = format!("{}-req", conversation_id);
            let message_id = format!("req-{}-user", logging::now_ms());
            let events = report::desktop_chat_sequence(
                &conversation_id,
                &request_id,
                &message_id,
                "fast-model",
                "fast-model",
            );
            report::report_desktop_events(session, events).await.map(|_| Done)
        }
        // Buddy_App / Buddy_App_QQ：buddyapp 五连事件，共用一组（refs
        // autotask.go:847-858 —— 企鹅教师助手同时满足「进入任一应用」）
        "Buddy_App" | "Buddy_App_QQ" => {
            let events =
                report::desktop_buddy_app_sequence(report::BUDDY_APP_QQ_ID, report::BUDDY_APP_QQ_NAME);
            report::report_desktop_events(session, events).await.map(|_| Done)
        }
        // automation_1：定时任务创建成功事件（refs autotask.go:860-869）
        "automation_1" => {
            let events = vec![report::desktop_automation_create_event("wb2api 自动化")];
            report::report_desktop_events(session, events).await.map(|_| Done)
        }
        // Library_read：web 域资料库阅读点击（refs autotask.go:871-881）
        "Library_read" => {
            report::report_web_event(
                session,
                "web_element_click",
                report::LIBRARY_DOC_URL,
                report::LIBRARY_ELEMENT_ID,
                report::LIBRARY_ELEMENT_NAME,
            )
            .await
            .map(|_| Done)
        }
        // template_5：模板事件组 ×差额（refs autotask.go:1006-1022）
        "template_5" => {
            let target = if task.target > 0 { task.target } else { 5 };
            let need = (target - task.current).max(0);
            let templates = [
                ("1", "深度研究"),
                ("2", "周报生成"),
                ("3", "竞品分析"),
                ("4", "活动策划"),
                ("5", "代码评审"),
            ];
            for index in 0..need {
                let template = templates[(index as usize) % templates.len()];
                let conversation_id = format!("{}-{index}", conversation("tpl"));
                let request_id = format!("{}-req", conversation_id);
                let events = report::desktop_template_use_sequence(
                    &conversation_id,
                    &request_id,
                    template.0,
                    template.1,
                );
                report::report_desktop_events(session, events).await?;
                // 组间 300ms（refs autotask.go:1019；最后一组后不等）
                if index < need - 1 {
                    tokio::time::sleep(Duration::from_millis(growth::TEMPLATE_GAP_MS)).await;
                }
            }
            Ok(Done)
        }
        // playbook_prompt：灵感案例「做同款」发送事件组（refs autotask.go:1024-1035）
        "playbook_prompt" => {
            let conversation_id = conversation("pb");
            let request_id = format!("{}-req", conversation_id);
            let events = report::desktop_playbook_prompt_sequence(
                &conversation_id,
                &request_id,
                "pm-gtm-launch-plan",
                "新产品上市 GTM 发布计划一页纸",
            );
            report::report_desktop_events(session, events).await.map(|_| Done)
        }
        // create_canvas：设计创意画布事件组（refs autotask.go:1037-1048）
        "create_canvas" => {
            let conversation_id = conversation("canvas");
            let request_id = format!("{}-req", conversation_id);
            let events = report::desktop_design_canvas_sequence(&conversation_id, &request_id);
            report::report_desktop_events(session, events).await.map(|_| Done)
        }
        // Hp_Appearance：主题 set API → 2s → 皮肤生效事件
        // （refs autotask.go:986-1004 runAppearance）
        "Hp_Appearance" => {
            report::set_appearance_theme(session, report::APPEARANCE_THEME_KEY).await?;
            tokio::time::sleep(Duration::from_millis(APPEARANCE_APPLY_GAP_MS)).await;
            let events = vec![report::appearance_skin_apply_event(report::APPEARANCE_THEME_KEY)];
            report::report_desktop_events(session, events).await.map(|_| Done)
        }
        // expert_5：使用 5 个平台专家（refs autotask.go:1053-1059）
        "expert_5" => run_expert_batch(service, session, "agent", 5).await,
        // Expert_team_use_3：使用 3 个专家团（refs autotask.go:1061-1064）
        "Expert_team_use_3" => run_expert_batch(service, session, "team", 3).await,
        // Expert_lighthouse：轻量云专家（refs autotask.go:945-984）
        "Expert_lighthouse" => run_lighthouse(service, session).await,
        // skill_1：真实对话 + skill_info（refs autotask.go:910-938）
        "skill_1" => run_skill_fresh(service, session).await,
        // black_cat：夜猫子（refs autotask.go:886-902 + blackcat.go:19-69）
        "black_cat" => run_black_cat(service, session, task).await,
        // school_season / Sequential 链：mp 口径（refs autotask.go:407-541）
        "school_season" => run_mp_mini_chat(service, session, "school_season", true).await,
        "Sequential_Tasks_1" | "Sequential_Tasks_3" | "Sequential_Tasks_6" => {
            run_mp_mini_chat(service, session, code, false).await
        }
        "Sequential_Tasks_2" => run_mp_mini_expert(service, session, code).await,
        "Sequential_Tasks_4" => run_sequential_event(service, session, code, SequentialKind::Automation).await,
        "Sequential_Tasks_5" => run_sequential_event(service, session, code, SequentialKind::ModelChat).await,
        "Sequential_Tasks_7" => run_sequential_event(service, session, code, SequentialKind::Playbook).await,
        other => Err(BillingError::new(
            format!("该任务暂无自动化动作（{other}）"),
            400,
        )),
    }
}

// ─── 专家系（真实专家列表 + 召唤链 + 真实 chat + 使用事件）────────

/// 专家召唤+使用的公共实现（refs autotask.go:1067-1106 runExpertBatch）。
/// 自造专家 id 或自造 requestId 均不计数 —— id 来自市场真实列表、requestId
/// 来自真实对话的服务端回执。失败逐个继续（refs fail++ 口径）。
async fn run_expert_batch(
    service: &BillingService,
    session: &Value,
    expert_type: &str,
    count: usize,
) -> Result<ActionOutcome, BillingError> {
    let experts = market_expert_list(service, session, expert_type).await?;
    if experts.is_empty() {
        return Err(BillingError::new("专家市场列表为空", 502));
    }
    let mut ok = 0usize;
    for (index, expert) in experts.iter().enumerate() {
        if ok >= count {
            break;
        }
        // ① 召唤链（web_element_click + summon_click + summoned）
        if report::report_desktop_events(session, report::desktop_expert_summon_sequence(expert))
            .await
            .is_err()
        {
            continue;
        }
        // ② 真实 chat（带 X-Expert-Id）→ 服务端 requestId
        let (conversation_id, request_id) = match growth_chat_request_id(
            session,
            "fast-model",
            "1+1等于几？直接回答。",
            &expert.expert_id,
        )
        .await
        {
            Ok(pair) => pair,
            Err(_) => continue,
        };
        // ③ 使用事件（JOIN 服务端 requestId）+ chat 链
        let mut events = report::desktop_chat_sequence(
            &conversation_id,
            &request_id,
            &format!("msg-{}", tail8(&request_id)),
            "fast-model",
            "fast-model",
        );
        events.push(report::desktop_expert_actual_use_event(
            expert,
            &conversation_id,
            &request_id,
        ));
        if report::report_desktop_events(session, events).await.is_err() {
            continue;
        }
        ok += 1;
        if index < experts.len() - 1 {
            tokio::time::sleep(Duration::from_millis(EXPERT_SUMMON_GAP_MS)).await;
        }
    }
    Ok(Done)
}

/// Expert_lighthouse：轻量云专家（refs autotask.go:945-984 runExpertLighthouse）。
/// 与 expert_5 同构，差异：chat 链的 agent_task_created 带 has_expert:true、
/// expert_actual_use 为 LOCAL 且 type 空 / cost 0（对齐真实样本 row 868）。
async fn run_lighthouse(
    service: &BillingService,
    session: &Value,
) -> Result<ActionOutcome, BillingError> {
    let mut lighthouse = MarketExpert {
        expert_id: LIGHTHOUSE_ID.to_string(),
        expert_type: "agent".to_string(),
        display_name_zh: "腾讯轻量云专家".to_string(),
        profession_zh: "腾讯轻量云专家".to_string(),
        version: "1.0.2".to_string(),
        categories: Vec::new(),
    };
    // 市场列表若命中真实条目则用其信息（version 等以服务端为准，refs:952-959）
    if let Ok(experts) = market_expert_list(service, session, "agent").await {
        if let Some(found) = experts.iter().find(|expert| expert.expert_id == LIGHTHOUSE_ID) {
            lighthouse = found.clone();
        }
    }
    // 召唤链
    report::report_desktop_events(session, report::desktop_expert_summon_sequence(&lighthouse)).await?;
    // 真实对话（带 X-Expert-Id）→ 服务端 requestId
    let (conversation_id, request_id) = growth_chat_request_id(
        session,
        "fast-model",
        "1+1等于几？直接回答。",
        LIGHTHOUSE_ID,
    )
    .await
    .map_err(gateway_into_billing)?;
    let mut events = report::desktop_chat_sequence(
        &conversation_id,
        &request_id,
        &format!("msg-{}", tail8(&request_id)),
        "fast-model",
        "fast-model",
    );
    // chat 链的 agent_task_created 带 has_expert（refs autotask.go:969-975）
    for event in events.iter_mut() {
        if event.get("eventCode").and_then(Value::as_str) == Some("agent_task_created") {
            if let Some(object) = event.as_object_mut() {
                object.insert("has_expert".to_string(), json!(true));
                object.insert("expert_id".to_string(), json!(lighthouse.expert_id));
                object.insert("expert_name".to_string(), json!(lighthouse.display_name_zh));
                object.insert("expert_industry_id".to_string(), json!(""));
            }
        }
    }
    events.push(report::desktop_expert_actual_use_local(
        &lighthouse,
        &conversation_id,
        &request_id,
    ));
    // 对齐真实样本：轻量云专家 actual_use 的 type 为空、cost=0（refs:977-979）
    if let Some(last) = events.last_mut() {
        if let Some(object) = last.as_object_mut() {
            object.insert("type".to_string(), json!(""));
            object.insert("cost".to_string(), json!(0));
        }
    }
    report::report_desktop_events(session, events).await.map(|_| Done)
}

/// skill_1：真实对话 + skill_info 技能加载事件（refs autotask.go:910-938）。
/// 判据：skill_info 事件（桌面指纹）JOIN 真实会话（服务端 requestId），
/// chat 链的 chat_message_response 带 finishReason=tool_calls（工具调用语义）。
async fn run_skill_fresh(
    _service: &BillingService,
    session: &Value,
) -> Result<ActionOutcome, BillingError> {
    let (conversation_id, request_id) =
        growth_chat_request_id(session, "fast-model", "1+1等于几？直接回答。", "")
            .await
            .map_err(gateway_into_billing)?;
    let message_id = format!("msg-{}", tail8(&request_id));
    let mut events = report::desktop_chat_sequence(
        &conversation_id,
        &request_id,
        &message_id,
        "fast-model",
        "fast-model",
    );
    for event in events.iter_mut() {
        if event.get("eventCode").and_then(Value::as_str) == Some("chat_message_response") {
            if let Some(object) = event.as_object_mut() {
                object.insert("finishReason".to_string(), json!("tool_calls"));
            }
        }
    }
    // skill_info 事件（refs autotask.go:922-933 的实测样本形状）
    events.push(json!({
        "eventCode": "skill_info",
        "id": "润泽小馆·日报撰写",
        "skillId": "skill_2097350077599879168",
        "skillVersion": "1.0.0",
        "toolStatus": "success",
        "fileCount": 56,
        "source": "workbuddy-desktop",
        "conversationId": conversation_id, "requestId": request_id, "messageId": message_id,
        "requestModelId": "fast-model", "requestModelName": "fast-model",
        "traceId": request_id,
    }));
    report::report_desktop_events(session, events).await.map(|_| Done)
}

// ─── 夜猫子（窗口判断 + 差额补足）───────────────────────────

/// 夜猫子计数窗口：23:00–08:00 **本地时区**（refs blackcat.go:19-23）。
/// 窗口外行为不计分，不做（避免白报）。
fn in_night_window() -> bool {
    let hour = chrono::Local::now().hour();
    hour >= 23 || hour < 8
}

/// black_cat：窗口内按差额补 glm-5.2 真实对话 + chat 事件上报
/// （refs autotask.go:886-902 runBlackCat + blackcat.go:43-69 RunNightChats）。
async fn run_black_cat(
    service: &BillingService,
    session: &Value,
    task: &growth::Task,
) -> Result<ActionOutcome, BillingError> {
    if !in_night_window() {
        return Ok(Skipped(
            "当前不在 23:00–08:00 计数窗口，行为不计分；定时任务会在每日 23 点自动补足".to_string(),
        ));
    }
    let need = (task.target - task.current).max(0);
    if need <= 0 {
        return Ok(Skipped("进度已达标，无需补足".to_string()));
    }
    for index in 0..need {
        // 真实 glm-5.2 对话（判据的最直接证据）+ chat 事件上报
        growth_chat_request_id(session, "glm-5.2", "1+1等于几？直接回答。", "")
            .await
            .map_err(gateway_into_billing)?;
        let conversation_id = format!("wb2api-night-{}-{}", logging::now_ms(), index);
        report::report_chat_activity(service, session, &conversation_id, "", "glm-5.2", "GLM-5.2")
            .await?;
        // 每条间隔 4s（refs blackcat.go:66）
        tokio::time::sleep(Duration::from_millis(NIGHT_CHAT_GAP_MS)).await;
    }
    Ok(Done)
}

// ─── mp 口径（school_season / Sequential_Tasks_1..7）────────

/// Sequential 链预留任务的判据形态（refs autotask.go:442-541）：
/// 判据疑为 PC 口径时 primary 用桌面指纹事件、未点亮后补一轮 mp 形态。
#[derive(Debug, Clone, Copy)]
enum SequentialKind {
    /// Sequential_Tasks_4「创建定时任务」：复用 automation_1 同源事件
    Automation,
    /// Sequential_Tasks_5「使用 GLM5.2」：mp 模型事件 primary + PC 模型上报 fallback
    ModelChat,
    /// Sequential_Tasks_7「体验灵感功能」：PC 灵感事件组 primary + mp 形态 fallback
    Playbook,
}

/// mp 口径通用闭环（refs autotask.go:332-405 runMPMiniChatTask）：
/// mp 查询 → accept（带登记回读验证）→ 按差额补 mini chat 事件（45s+抖动
/// 真人节奏，连发会被反作弊判无效回滚）→ 回读 → 达标由队列领奖。
/// `with_activity_id`：school_season 必带开学季 activityId，Sequential_Tasks_1
/// 等不带（服务端按 source=mini_program 指纹关联）。
async fn run_mp_mini_chat(
    service: &BillingService,
    session: &Value,
    code: &str,
    with_activity_id: bool,
) -> Result<ActionOutcome, BillingError> {
    let mut task = match growth::task_by_code(service, session, code).await? {
        Some(task) => task,
        None => return Ok(Skipped("mp 口径未下发该任务（活动可能已结束）".to_string())),
    };
    if task.claimed {
        return Ok(Skipped("已领取".to_string()));
    }
    if task.accept_status == "not_accepted" || task.accept_status.is_empty() {
        if !growth::accept_with_verify(service, session, code).await {
            return Ok(Skipped(
                "accept 未登记生效（上游 200+OK 但未落账形态），待下次重试".to_string(),
            ));
        }
        // accept 前的任务进度为 null（target 下发 0），接受后回读拿真实
        // target/current（refs autotask.go:347-353）
        if let Ok(Some(fresh)) = growth::task_by_code(service, session, code).await {
            task = fresh;
        }
    }
    let target = if task.target > 0 { task.target } else { 1 };
    // 已达标（含 completed 未领）：直接交给队列回读领奖
    if task.current >= target || task.accept_status == "completed" {
        return Ok(Done);
    }
    // 判据上报：按差额补 mini chat 事件。每条前 sleep 45s+抖动 —— 首条也等
    // （refs autotask.go:369-370：上一轮残留进度被回滚后立即重报同样无效）
    let need = (target - task.current).max(0);
    for index in 0..need {
        tokio::time::sleep(Duration::from_millis(MP_CHAT_EVENT_GAP_MS + chat_jitter_ms())).await;
        let conversation_id = format!("wb2api-mp-{}-{}", logging::now_ms(), index);
        let event = if with_activity_id {
            report::school_season_chat_event(&conversation_id)
        } else {
            report::mini_chat_event(&conversation_id)
        };
        report::report_mp_events(session, vec![event]).await?;
    }
    // 回读交给队列（task_by_code 对 mp 码自动回落 mp 列表，4×3s 预算比
    // refs 的紧凑版 2×3s 更宽）
    Ok(Done)
}

/// Sequential_Tasks_2「小程序内选中专家并完成有效对话」
/// （refs autotask.go:550-616 runMiniExpert）。专家 id 必须是市场真实 ex_ id
/// —— **accept 之前**先解析市场列表，拉不到就整任务不动作，避免留下
/// 「已登记未上报」的半程态（refs autotask.go:549 同款）。
async fn run_mp_mini_expert(
    service: &BillingService,
    session: &Value,
    code: &str,
) -> Result<ActionOutcome, BillingError> {
    let task = match growth::task_by_code(service, session, code).await? {
        Some(task) => task,
        None => return Ok(Skipped("mp 口径未下发该任务（活动可能已结束）".to_string())),
    };
    if task.claimed {
        return Ok(Skipped("已领取".to_string()));
    }
    let target = if task.target > 0 { task.target } else { 1 };
    if task.current >= target || task.accept_status == "completed" {
        return Ok(Done);
    }
    // 判据载体前置（accept 之前）：市场真实专家 id（refs autotask.go:574-583）
    let experts = match market_expert_list(service, session, "").await {
        Ok(experts) => experts,
        Err(error) => {
            return Ok(Skipped(format!(
                "专家市场不可用（{}），跳过以防半程态",
                error.message
            )))
        }
    };
    let Some(first) = experts.first() else {
        return Ok(Skipped("专家市场列表为空，跳过以防半程态".to_string()));
    };
    let name = if first.display_name_zh.is_empty() {
        &first.profession_zh
    } else {
        &first.display_name_zh
    };
    if task.accept_status == "not_accepted" || task.accept_status.is_empty() {
        if !growth::accept_with_verify(service, session, code).await {
            return Ok(Skipped(
                "accept 未登记生效（上游 200+OK 但未落账形态），待下次重试".to_string(),
            ));
        }
    }
    // 判据上报：mp 指纹 expert_actual_use（真实 ex_ id，上报即 completed）
    let event = report::mini_expert_use_event(&first.expert_id, name, &first.expert_type);
    report::report_mp_events(session, vec![event]).await?;
    Ok(Done)
}

/// Sequential 链预留任务通用骨架（refs autotask.go:442-500
/// runSequentialEventTask）：mp 查询 → accept（带验证）→ 判据事件上报
/// （primary；未点亮且 fallback 非空时补一轮）→ 回读 → 达标领奖。
/// 每日零点解锁一环：locked 期间 accept 不落账（队列在执行前已按 locked 跳过）。
async fn run_sequential_event(
    service: &BillingService,
    session: &Value,
    code: &str,
    kind: SequentialKind,
) -> Result<ActionOutcome, BillingError> {
    let task = match growth::task_by_code(service, session, code).await? {
        Some(task) => task,
        None => {
            return Ok(Skipped(
                "mp 口径未下发该任务（前置任务未完成或活动未开始）".to_string(),
            ))
        }
    };
    if task.claimed {
        return Ok(Skipped("已领取".to_string()));
    }
    let target = if task.target > 0 { task.target } else { 1 };
    if task.current >= target || task.accept_status == "completed" {
        return Ok(Done);
    }
    if task.accept_status == "not_accepted" || task.accept_status.is_empty() {
        if !growth::accept_with_verify(service, session, code).await {
            return Ok(Skipped(
                "accept 未登记生效（任务可能处于每日锁定窗口，等解锁后自动重试）".to_string(),
            ));
        }
    }
    // primary 判据上报（refs autotask.go:469-471 / 505-541）
    match kind {
        SequentialKind::Automation => {
            // mp 源码无 automation 事件发射点 → 判据疑为 PC 口径：复用
            // automation_1 同源事件（refs autotask.go:502-510）
            report::report_desktop_events(
                session,
                vec![report::desktop_automation_create_event("wb2api 自动化")],
            )
            .await?;
        }
        SequentialKind::ModelChat => {
            // mp 对话事件带 requestModelId/Name（mpsrc main 32904 发射点形状）
            let conversation_id = format!("wb2api-mp-glm-{}", logging::now_ms());
            report::report_mp_events(
                session,
                vec![report::mini_chat_model_event(
                    &conversation_id,
                    "glm-5.2",
                    "GLM-5.2",
                )],
            )
            .await?;
        }
        SequentialKind::Playbook => {
            // PC 灵感事件组（playbook_prompt 已实测点亮，refs autotask.go:529-537）
            let stamp = logging::now_ms();
            let conversation_id = format!("wb2api-pb-{stamp}");
            let request_id = format!("{stamp}-req");
            report::report_desktop_events(
                session,
                report::desktop_playbook_prompt_sequence(
                    &conversation_id,
                    &request_id,
                    "pm-gtm-launch-plan",
                    "新产品上市 GTM 发布计划一页纸",
                ),
            )
            .await?;
        }
    }
    // 回读两轮（3s 间隔）；round 0 未点亮且有 fallback 时补一轮（refs:473-488）
    for round in 0..2 {
        tokio::time::sleep(Duration::from_millis(growth::CLAIM_POLL_GAP_MS)).await;
        if let Ok(Some(fresh)) = growth::task_by_code(service, session, code).await {
            if fresh.claimable || fresh.claimed || fresh.current >= target {
                return Ok(Done);
            }
        }
        if round == 0 {
            match kind {
                SequentialKind::Automation => {}
                SequentialKind::ModelChat => {
                    // fallback：PC 域模型活跃上报（Model_chat_GLM5.2 同源，
                    // refs autotask.go:521-523）
                    let conversation_id = format!("wb2api-mp-glm-{}", logging::now_ms());
                    report::report_chat_activity(
                        service,
                        session,
                        &conversation_id,
                        "",
                        "glm-5.2",
                        "GLM-5.2",
                    )
                    .await?;
                }
                SequentialKind::Playbook => {
                    // fallback：mp 指纹灵感事件组（refs autotask.go:538-540）
                    report::report_mp_events(
                        session,
                        report::mini_playbook_events(
                            "pm-gtm-launch-plan",
                            "新产品上市 GTM 发布计划一页纸",
                        ),
                    )
                    .await?;
                }
            }
        }
    }
    // 未点亮也返回 Done：队列的 4×3s 回读再等一轮，仍未点亮按「进度未达标」
    // 落队列消息，下次重试
    Ok(Done)
}

// ─── 小工具 ────────────────────────────────────────────────

/// mp 对话事件的 0~10s 抖动（refs autotask.go:370 `rand.Int64N(10s)`）。
fn chat_jitter_ms() -> u64 {
    let mut bytes = [0u8; 4];
    if getrandom::getrandom(&mut bytes).is_err() {
        return 0;
    }
    u64::from(u32::from_le_bytes(bytes) % (MP_CHAT_JITTER_MS as u32))
}

/// 取字符串末 8 位（refs autotask.go:915 `"msg-" + req[len(req)-8:]` 的
/// 消息 id 派生；panic-free 版本，非法边界回落全文）。
fn tail8(text: &str) -> String {
    text.get(text.len().saturating_sub(8)..)
        .unwrap_or(text)
        .to_string()
}
