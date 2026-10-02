//! growth 任务域「任务三件套」：列表查询 / 接受 / 领奖（对照 refs
//! workbuddy2api-panel internal/upstream/tasks.go 全量移植，口径以其实测为准）。
//!
//! ── 端点与域（打错域即 400，tasks.go:223-225 前科）─────────────
//!   GET  {chatBase}/v2/activity/growth/tasks          任务列表（默认口径）
//!   GET  {chatBase}/v2/activity/growth/tasks          任务列表（mp 口径，加头）
//!   POST {chatBase}/v2/activity/growth/tasks/accept   {"task_codes":[…]}
//!   POST {chatBase}/activity/growth/tasks/{code}/claim  领奖（mp 口径）
//!   POST {webBase}/activity/growth/tasks/{code}/claim   领奖（web 口径，降级）
//!
//! ── 语义要点（tasks.go 模块头 + autotask.go 实测）──────────────
//!   - accept 是「报名」不产生进度；进度由服务端行为事件点亮，可幂等重放；
//!   - mp 口径列表是默认口径的**超集**（tasks.go:70-75），合并按 task_code 去重；
//!   - claim 走 chat 域 mp 口径，HTTP 400 时降级 web 域同路径（tasks.go:122-127，
//!     此前误用 CLI 域 reward/claim 一直是 400 "task not completed"）；
//!   - 上游存在「200+OK 但 accept 未落账」形态（autotask.go:287-304），mp 口径
//!     accept 必须回读 accept_status 验证，未生效重试一次；
//!   - 计分是**异步**的：上报后进度数秒后才刷新（autotask.go:237-244），回读
//!     用 4 次 × 3s 的有界轮询，一次性回读会误判「未达标」跳过领奖。

use std::time::Duration;

use serde_json::{json, Value};

use super::request::{
    growth_extra, raw_json_call, BillingBase, BillingSpec, CallOptions, CHAT_BASE, WEB_BASE,
};
use super::{BillingError, BillingService};
use crate::server::logging;

// ─── 端点表（base 固定 chatBase；BillingHeaders 形态头见 growth_extra）──

const GROWTH_TASKS_LIST: BillingSpec = BillingSpec {
    method: "GET",
    path: "/v2/activity/growth/tasks",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

const GROWTH_TASKS_ACCEPT: BillingSpec = BillingSpec {
    method: "POST",
    path: "/v2/activity/growth/tasks/accept",
    body: super::request::empty_body,
    whitelist_headers: false,
    base: BillingBase::Chat,
};

// ─── 节流参数（全部照抄 refs，出处逐条标注）────────────────────

/// 连续上报/accept 批间的间隔（refs autotask.go:745 `reportGap = 1050ms`，
/// 对齐上游脚本实测口径，避免风控）。队列编排（core::growth_queue）也用它。
pub const REPORT_GAP_MS: u64 = 1050;

/// mp 口径写动作（accept/上报/领奖）之间的间隔（refs autotask.go:318
/// `mpActionGap = 2s`，防频控）。队列的阶段 0b 批量接受（core::growth_queue）
/// 也用它。
pub const MP_ACTION_GAP_MS: u64 = 2_000;

/// 达标回读的有界轮询：最多 4 次、每次间隔 3s（refs autotask.go:241-244
/// `claimPollAttempts=4 / claimPollGap=3s`，总预算约 12s —— 上游异步计分）。
/// 间隔常量同时供 Sequential 链动作内的紧凑回读使用（core::growth_actions）。
pub(super) const CLAIM_POLL_ATTEMPTS: usize = 4;
pub const CLAIM_POLL_GAP_MS: u64 = 3_000;

/// 模板事件组之间的间隔（refs autotask.go:1019 `time.Sleep(300ms)`）。
/// 队列编排（core::growth_queue）也用它。
pub const TEMPLATE_GAP_MS: u64 = 300;

/// accept 单批上限（协调者契约：每批 ≤20、批间 1.05s；间隔同 REPORT_GAP_MS）。
pub(super) const ACCEPT_BATCH_SIZE: usize = 20;

// ─── 任务口径 ───────────────────────────────────────────────

/// mp 口径专属下发的成长任务（refs autotask.go:201-213 `mpTaskCodes`）：
/// 默认列表不出现，accept/claim 均要求 X-Client-Platform: miniprogram。
const MP_TASK_CODES: &[&str] = &[
    "school_season",
    "Sequential_Tasks_1",
    "Sequential_Tasks_2",
    "Sequential_Tasks_3",
    "Sequential_Tasks_4",
    "Sequential_Tasks_5",
    "Sequential_Tasks_6",
    "Sequential_Tasks_7",
];

/// 队列可执行的任务族全量（执行顺序照 refs autotask.go:50-177 autoActions
/// 的相对顺序 —— first_buddy 依赖活跃上报解锁故排前；mp 链在队尾）。
/// 各族的判据载体见 `core::growth_actions` 的模块头。
pub const ACTION_ORDER: &[&str] = &[
    "chat_5",
    "first_buddy",
    "Model_chat_GLM5.2",
    "RichMeow_Chat",
    "Buddy_App",
    "Buddy_App_QQ",
    "automation_1",
    "Library_read",
    "template_5",
    "playbook_prompt",
    "create_canvas",
    "expert_5",
    "Expert_team_use_3",
    "Hp_Appearance",
    "skill_1",
    "Expert_lighthouse",
    "black_cat",
    "school_season",
    "Sequential_Tasks_1",
    "Sequential_Tasks_2",
    "Sequential_Tasks_3",
    "Sequential_Tasks_4",
    "Sequential_Tasks_5",
    "Sequential_Tasks_6",
    "Sequential_Tasks_7",
];

/// 任务在执行顺序中的位置（未知码排到队尾，对照 autotask.go:190-197）。
pub fn action_order(code: &str) -> usize {
    ACTION_ORDER
        .iter()
        .position(|item| *item == code)
        .unwrap_or(usize::MAX)
}

/// 任务是否有对应的自动化动作（本实现的裁剪版 `autoActionFor`）。
pub fn is_actionable(code: &str) -> bool {
    ACTION_ORDER.contains(&code)
}

/// 是否 mp 口径专属任务（决定回读/接受/领奖走 mp 变体，autotask.go:216）。
pub fn is_mp_task_code(code: &str) -> bool {
    MP_TASK_CODES.contains(&code)
}

/// 任务是否「未完成且可自动化」（对照 refs taskcenter.go:38-55 `growthPending`：
/// 未领 & !locked & 有自动化动作；达标未领的也入队 —— 队列执行会自动领）。
pub fn growth_pending(task: &Task) -> bool {
    if task.claimed || task.locked {
        return false;
    }
    is_actionable(&task.task_code)
}

// ─── Task 结构 ──────────────────────────────────────────────

/// growth 任务的对外视图（字段与上游 JSON / refs tasks.go:38-57 对齐）。
#[derive(Debug, Clone, Default)]
pub struct Task {
    pub task_code: String,
    pub title: String,
    pub task_desc: String,
    /// 奖励积分（上游 reward_credit）
    pub credit: i64,
    /// 奖励能量（上游 reward_energy）
    pub energy: i64,
    pub has_reward: bool,
    pub task_type: String,
    pub tag: String,
    /// 上游标记未解锁（Sequential 族每日零点解锁一环）
    pub locked: bool,
    /// 目标次数（恒输出：0 是有效进度值）
    pub target: i64,
    /// 当前进度（恒输出：0 是有效进度值）
    pub current: i64,
    pub accept_status: String,
    pub status: String,
    /// 进度达标且未领取（本地推算，tasks.go:203）
    pub claimable: bool,
    /// 已领取（accept_status == "claimed"）
    pub claimed: bool,
}

/// 解析任务列表 data.tasks[]（对照 refs tasks.go:147-208 `parseGrowthTasks`）。
///
/// 宽松解析：progress 可能是 `{current,target}` 对象（实测口径）或平铺字段，
/// 对象形态有值时覆盖平铺值。
fn parse_tasks(data: &Value) -> Vec<Task> {
    let Some(items) = data.get("tasks").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| {
            let text_of = |key: &str| {
                item.get(key)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            let int_of = |key: &str| item.get(key).and_then(Value::as_i64).unwrap_or(0);
            let mut current = int_of("current");
            let mut target = int_of("target");
            // progress 对象形态覆盖（refs tasks.go:175-184）
            if let Some(progress) = item.get("progress").filter(|value| value.is_object()) {
                let pr_current = progress.get("current").and_then(Value::as_i64).unwrap_or(0);
                let pr_target = progress.get("target").and_then(Value::as_i64).unwrap_or(0);
                if pr_target > 0 || pr_current > 0 {
                    current = pr_current;
                    target = pr_target;
                }
            }
            let accept_status = text_of("accept_status");
            let claimed = accept_status == "claimed";
            Task {
                task_code: text_of("task_code"),
                title: text_of("title"),
                task_desc: text_of("task_desc"),
                credit: int_of("reward_credit"),
                energy: int_of("reward_energy"),
                has_reward: item
                    .get("has_reward")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                task_type: text_of("task_type"),
                tag: text_of("tag"),
                locked: item.get("locked").and_then(Value::as_bool).unwrap_or(false),
                target,
                current,
                claimable: !claimed && target > 0 && current >= target,
                claimed,
                accept_status,
                status: text_of("status"),
            }
        })
        .collect()
}

/// 任务的中文展示名（映射表照 refs README.md:79-95 的任务表写死；
/// 未知码回落上游 title，再回落原码 —— 不编造任务名）。
pub fn task_label(task: &Task) -> String {
    let mapped = match task.task_code.as_str() {
        "first_buddy" => "领养第一只 Buddy",
        "create_canvas" => "设计创意画布创建",
        "chat_5" => "累计完成 5 次对话",
        "Model_chat_GLM5.2" => "体验 GLM-5.2 模型",
        "RichMeow_Chat" => "桌面端完成 1 次对话",
        "Buddy_App" => "进入 Buddy 应用",
        "Buddy_App_QQ" => "进入企鹅教师助手",
        "automation_1" => "创建定时任务",
        "Library_read" => "体验资料库",
        "template_5" => "使用模板创建任务 ×5",
        "playbook_prompt" => "灵感案例做同款",
        "expert_5" => "使用 5 个平台专家",
        "Expert_team_use_3" => "使用专家团 ×3",
        "Hp_Appearance" => "更换主题外观",
        "Expert_lighthouse" => "体验轻量云专家",
        "skill_1" => "尝鲜热门技能",
        "black_cat" => "夜猫子任务",
        "Expert_Philanthropy" => "公益捐赠",
        "school_season" => "校园日（小程序）",
        "Sequential_Tasks_1" => "小程序首对话",
        "Sequential_Tasks_2" => "小程序选中专家并对话",
        "Sequential_Tasks_3" => "小程序完成 5 次对话",
        "Sequential_Tasks_4" => "小程序创建定时任务",
        "Sequential_Tasks_5" => "小程序使用 GLM5.2",
        "Sequential_Tasks_6" => "小程序完成 10 次对话",
        "Sequential_Tasks_7" => "小程序体验灵感功能",
        _ => "",
    };
    if !mapped.is_empty() {
        return mapped.to_string();
    }
    if !task.title.is_empty() {
        return task.title.clone();
    }
    task.task_code.clone()
}

/// 任务的扫描视图 JSON（/api/growth-tasks/scan 的 tasks[] 元素形状）。
pub fn task_scan_json(task: &Task) -> Value {
    json!({
        "code": task.task_code,
        "label": task_label(task),
        "rewardCredit": task.credit,
        "rewardEnergy": task.energy,
        "claimed": task.claimed,
        "claimable": task.claimable,
        "locked": task.locked,
        "current": task.current,
        "target": task.target,
    })
}

// ─── 请求选项 ───────────────────────────────────────────────

/// growth 域调用的公共选项：固定会话 + BillingHeaders 差集头（growth_extra）。
/// `mp` 决定是否叠加 X-Client-Platform: miniprogram（tasks.go:100）。
fn growth_options<'a>(
    session: &'a Value,
    mp: bool,
    expect_code_ok: bool,
) -> CallOptions<'a> {
    CallOptions {
        session: Some(session),
        expect_code_ok,
        extra: growth_extra(session, mp),
        ..Default::default()
    }
}

// ─── 列表 / 定位 ────────────────────────────────────────────

/// 拉取全量任务列表（默认口径，无端标记头；refs tasks.go:62-68 ListTasks）。
pub async fn list_tasks(
    service: &BillingService,
    session: &Value,
) -> Result<Vec<Task>, BillingError> {
    let call = service
        .call_billing(GROWTH_TASKS_LIST, growth_options(session, false, true))
        .await?;
    Ok(parse_tasks(&call.data))
}

/// 拉取小程序口径的任务列表（X-Client-Platform: miniprogram；refs tasks.go:76-82）。
pub async fn list_tasks_mp(
    service: &BillingService,
    session: &Value,
) -> Result<Vec<Task>, BillingError> {
    let call = service
        .call_billing(GROWTH_TASKS_LIST, growth_options(session, true, true))
        .await?;
    Ok(parse_tasks(&call.data))
}

/// 双口径合并列表：默认口径优先，mp 口径按 task_code 去重补齐
/// （对照 refs taskcenter.go:80-102 的扫描合并；mp 是超集，重叠时保留默认口径）。
pub async fn list_tasks_merged(
    service: &BillingService,
    session: &Value,
) -> Result<Vec<Task>, BillingError> {
    let default_result = list_tasks(service, session).await;
    let mp_result = list_tasks_mp(service, session).await;
    match (default_result, mp_result) {
        (Ok(mut tasks), Ok(mp_tasks)) => {
            let mut seen: Vec<String> = tasks.iter().map(|t| t.task_code.clone()).collect();
            for task in mp_tasks {
                if !seen.contains(&task.task_code) {
                    seen.push(task.task_code.clone());
                    tasks.push(task);
                }
            }
            Ok(tasks)
        }
        // 单边失败时取成功的那份（refs taskcenter 的扫描对两口径分别容错）：
        // mp 列表失败在「无 mp 任务的部署 / 活动结束」时是常态，静默回落。
        (Ok(tasks), Err(_)) | (Err(_), Ok(tasks)) => Ok(tasks),
        (Err(default_error), Err(_)) => Err(default_error),
    }
}

/// 拉取任务列表并定位单个任务；未找到返回 None（不视为错误）。
/// 双口径：mp 专属任务在默认列表查不到，自动回落 mp 列表
/// （对照 refs autotask.go:221-235 `taskByCode`，未知码不多打一次上游）。
pub async fn task_by_code(
    service: &BillingService,
    session: &Value,
    code: &str,
) -> Result<Option<Task>, BillingError> {
    for task in list_tasks(service, session).await? {
        if task.task_code == code {
            return Ok(Some(task));
        }
    }
    if is_mp_task_code(code) {
        for task in list_tasks_mp(service, session).await? {
            if task.task_code == code {
                return Ok(Some(task));
            }
        }
    }
    Ok(None)
}

// ─── accept ────────────────────────────────────────────────

/// 接受任务（单批；幂等：已 accepted 时上游返回成功或业务提示）。
/// 对照 refs tasks.go:211-214 `AcceptTasks` / :106-109 `AcceptTasksMP`。
pub async fn accept_tasks(
    service: &BillingService,
    session: &Value,
    codes: &[String],
    mp: bool,
) -> Result<(), BillingError> {
    if codes.is_empty() {
        return Ok(());
    }
    let body = json!({ "task_codes": codes });
    service
        .call_billing(
            GROWTH_TASKS_ACCEPT,
            CallOptions {
                body: Some(&body),
                ..growth_options(session, mp, true)
            },
        )
        .await?;
    Ok(())
}

/// 分批接受：每批 ≤ [`ACCEPT_BATCH_SIZE`]，批间 [`REPORT_GAP_MS`]
/// （最后一批之后不等待 —— 调用方的下一步动作自带间隔）。
pub async fn accept_tasks_batched(
    service: &BillingService,
    session: &Value,
    codes: &[String],
    mp: bool,
) -> Result<(), BillingError> {
    let total = codes.len();
    let mut start = 0;
    while start < total {
        let end = (start + ACCEPT_BATCH_SIZE).min(total);
        accept_tasks(service, session, &codes[start..end], mp).await?;
        if end < total {
            tokio::time::sleep(Duration::from_millis(REPORT_GAP_MS)).await;
        }
        start = end;
    }
    Ok(())
}

/// mp 口径 accept 并回读验证登记生效（对照 refs autotask.go:287-304
/// `acceptWithVerifyMP`）：上游存在 200+OK 但 accept 未真正登记的形态
/// （此时上报事件全部不归账）—— 判定以回读 accept_status 为准，未生效重试一次。
/// 返回 true = 登记生效。
pub async fn accept_with_verify(
    service: &BillingService,
    session: &Value,
    code: &str,
) -> bool {
    for attempt in 1..=2 {
        let codes = [code.to_string()];
        if let Err(error) = accept_tasks(service, session, &codes, true).await {
            logging::log(
                "[Growth]",
                &format!("accept {code} 尝试{attempt} 失败: {}", error.message),
            );
            continue;
        }
        tokio::time::sleep(Duration::from_millis(MP_ACTION_GAP_MS)).await;
        match task_by_code(service, session, code).await {
            Ok(Some(task))
                if task.accept_status != "not_accepted" && !task.accept_status.is_empty() =>
            {
                return true;
            }
            Ok(Some(task)) => {
                // refs acceptStatusOr：空状态显示 "?"
                let status_text = if task.accept_status.is_empty() {
                    "?".to_string()
                } else {
                    task.accept_status.clone()
                };
                logging::log(
                    "[Growth]",
                    &format!("accept {code} 尝试{attempt} 未登记生效（回读={status_text}）"),
                );
            }
            _ => logging::log(
                "[Growth]",
                &format!("accept {code} 尝试{attempt} 未登记生效（回读=任务不存在）"),
            ),
        }
    }
    false
}

// ─── claim（领奖，mp → web 降级）────────────────────────────

/// 领奖结果（refs tasks.go:133-144 parseClaimReward）。
#[derive(Debug, Clone, Default)]
pub struct ClaimReward {
    /// 已领取过（幂等：不算错误，但无新增奖励）
    pub already_claimed: bool,
    pub credit: i64,
    pub energy: i64,
}

/// 领取单个任务奖励（对照 refs tasks.go:114-131 `ClaimRewardMP`）：
/// mp 口径走 chat 域 /activity/growth/tasks/{code}/claim + mp 头，HTTP 400 时
/// 降级 Web 域同路径（x-client-platform: web + Origin/Referer）；
/// 默认口径直接走 web 域（tasks.go:227-272）。
pub async fn claim_reward(
    session: &Value,
    code: &str,
    mp: bool,
) -> Result<ClaimReward, BillingError> {
    if mp {
        match claim_via_chat(session, code).await {
            Ok(reward) => Ok(reward),
            // chat 域对该路径 400（部分任务/租户形态）→ Web 域降级（已实测可领）
            Err(error) if error.status_code == 400 => {
                logging::verbose(
                    "[Growth]",
                    &format!("chat 域领奖 {code} 返回 400，降级 web 域"),
                );
                claim_via_web(session, code).await
            }
            Err(error) => Err(error),
        }
    } else {
        claim_via_web(session, code).await
    }
}

/// 任务码的路径安全性检查：refs 用 url.PathEscape（tasks.go:116/229）。
/// 上游任务码实测是 `[A-Za-z0-9_]` 标识符；出现分隔字符说明数据异常，
/// 拒绝拼路径而不是默默转义。
fn safe_path_code(code: &str) -> Result<(), BillingError> {
    if code.is_empty()
        || code
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || byte == b'_'))
    {
        return Err(BillingError::new(
            format!("任务码含非法字符，拒绝领奖: {code}"),
            400,
        ));
    }
    Ok(())
}

/// chat 域 mp 口径领奖（refs tasks.go:114-131）。走 raw_json_call，不需要
/// BillingService 实例（出网代理与会话都从 session 取）。
async fn claim_via_chat(
    session: &Value,
    code: &str,
) -> Result<ClaimReward, BillingError> {
    safe_path_code(code)?;
    let url = format!("{CHAT_BASE}/activity/growth/tasks/{code}/claim");
    let headers = super::request::growth_headers(
        session,
        &[(
            "X-Client-Platform".to_string(),
            super::request::MP_PLATFORM.to_string(),
        )],
    );
    let proxy = BillingService::proxy_of(session);
    // 无请求体（refs http.NewRequest(..., nil)）
    let call = raw_json_call("POST", &url, None, &headers, proxy.as_ref()).await?;
    Ok(parse_claim(&call.data))
}

/// web 域领奖（refs tasks.go:227-272 `ClaimReward`，头逐条对齐浏览器实测形状）。
async fn claim_via_web(
    session: &Value,
    code: &str,
) -> Result<ClaimReward, BillingError> {
    safe_path_code(code)?;
    let url = format!("{WEB_BASE}/activity/growth/tasks/{code}/claim");
    let headers = web_claim_headers(session);
    let proxy = BillingService::proxy_of(session);
    let call = raw_json_call("POST", &url, None, &headers, proxy.as_ref()).await?;
    Ok(parse_claim(&call.data))
}

/// web 领奖头（refs tasks.go:235-252 逐条对齐）：Origin/Referer 指向
/// workbuddy.cn 成长中心，x-client-platform: web 标记来源端。
/// 刻意**不**走 growth_headers（refs 的 web 形态不带 X-CodeBuddy-Request，
/// Accept 也是浏览器三段式）。
fn web_claim_headers(session: &Value) -> Vec<(String, String)> {
    let auth = session.get("auth").cloned().unwrap_or(Value::Null);
    let account = session.get("account").cloned().unwrap_or(Value::Null);
    let access_token = auth
        .get("accessToken")
        .and_then(Value::as_str)
        .unwrap_or("");
    let uid = account.get("uid").and_then(Value::as_str).unwrap_or("");
    let mut headers = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {access_token}"),
        ),
        (
            "Accept".to_string(),
            "application/json, text/plain, */*".to_string(),
        ),
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Origin".to_string(), WEB_BASE.to_string()),
        (
            "Referer".to_string(),
            format!("{WEB_BASE}/profile/growth-center"),
        ),
        ("x-client-platform".to_string(), "web".to_string()),
        // refs 用 c.userAgent(a)（三段式客户端 UA，按 realm 取）
        (
            "User-Agent".to_string(),
            crate::server::core::endpoints::user_agent_for_edition(
                session.get("edition").and_then(Value::as_str),
            ),
        ),
    ];
    if !uid.is_empty() {
        headers.push(("X-User-Id".to_string(), uid.to_string()));
    }
    if let Some(enterprise_id) = account
        .get("enterpriseId")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        headers.push(("X-Enterprise-Id".to_string(), enterprise_id.to_string()));
        headers.push(("X-Tenant-Id".to_string(), enterprise_id.to_string()));
    }
    if let Some(domain) = auth
        .get("domain")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        headers.push(("X-Domain".to_string(), domain.to_string()));
    }
    headers
}

/// 解析领奖响应 data：{"already_claimed":bool,"credit":n,"energy":n}
/// （refs tasks.go:133-144）。
fn parse_claim(data: &Value) -> ClaimReward {
    ClaimReward {
        already_claimed: data
            .get("already_claimed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        credit: data.get("credit").and_then(Value::as_i64).unwrap_or(0),
        energy: data.get("energy").and_then(Value::as_i64).unwrap_or(0),
    }
}

// ─── 回读工具（供队列与动作实现共用）────────────────────────

/// 回读任务，若未达标则在有界预算内轮询等待（对照 refs autotask.go:246-270
/// `taskByCodeWaiting`：上游异步计分，上报后 5-8 秒才归账；预算耗尽返回
/// 最后一次结果，可能仍未达标）。
pub async fn task_by_code_waiting(
    service: &BillingService,
    session: &Value,
    code: &str,
) -> Result<Option<Task>, BillingError> {
    let mut task = task_by_code(service, session, code).await?;
    let Some(current) = task.clone() else {
        return Ok(None);
    };
    if current.claimable || current.claimed {
        return Ok(task);
    }
    for _ in 1..CLAIM_POLL_ATTEMPTS {
        tokio::time::sleep(Duration::from_millis(CLAIM_POLL_GAP_MS)).await;
        match task_by_code(service, session, code).await {
            // 轮询期间的查询失败不覆盖已拿到的结果（refs 同款语义）
            Err(_) => return Ok(task),
            Ok(Some(next)) => {
                let done = next.claimable || next.claimed;
                task = Some(next);
                if done {
                    return Ok(task);
                }
            }
            Ok(None) => return Ok(task),
        }
    }
    Ok(task)
}

/// 任务进度的可读表示（对照 refs autotask.go:718-730 `taskProgressText`）。
pub fn task_progress_text(task: Option<&Task>) -> String {
    match task {
        None => "?".to_string(),
        Some(task) => {
            if task.target > 0 {
                return format!("{}/{}", task.current, task.target);
            }
            if task.claimed {
                return "claimed".to_string();
            }
            if task.accept_status.is_empty() {
                "?".to_string()
            } else {
                task.accept_status.clone()
            }
        }
    }
}
