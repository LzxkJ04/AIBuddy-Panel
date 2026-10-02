//! 「WorkBuddy 成长任务」执行队列：全账号扫描 → 待办入队 → 并发执行 →
//! 异步计分回读 → 自动领奖 → 进度状态（供前端轮询）。
//!
//! 对照 refs workbuddy2api-panel internal/panel/taskcenter.go 的扫描
//! （tasksScanAll）+ 执行队列（tasksRunQueue / queueState）与
//! autotask.go 的单任务流水线（accountTaskAuto），按面板的账号存储 /
//! BillingService 重新落位：
//!
//!   - **扫描**：并发拉取每个账号的成长任务列表（默认 + mp 口径合并），
//!     过滤出「未完成且可自动化」的待办（[`billing::growth::growth_pending`]，
//!     对照 taskcenter.go:38-55 growthPending）；
//!   - **入队**：待办按账号分组，账号内按 autoActions 依赖顺序排
//!     （[`billing::growth::ACTION_ORDER`]），账号间受 tokio Semaphore
//!     并发限制（1-4，默认 1）；
//!   - **执行**：单账号串行 —— accept（mp 口径带回读验证）→ 判据事件上报
//!     （纯上报零消耗族，见 [`run_action`]）→ 回读（4×3s 有界轮询，
//!     autotask.go:241-244）→ 达标即领奖（mp → web 降级）；
//!   - **互斥**：全局 running 复用 core::auto_checkin 的 RunningGuard 模式
//!     （CAS 抢标记 + Drop 复位，任务被 abort 也不会永久卡死）；同一轮里
//!     账号内天然串行，与「per-account 互斥」等价。
//!
//! ── 账号范围 ────────────────────────────────────────────────
//! CN 成长体系是 WorkBuddy 国内版专属：非 workbuddy 提供商与国际版账号一律
//! 跳过、不发起任何上游调用（refs taskcenter.go:76-79 的 D4 门控；
//! scheduler/streak.go:29-31 同口径）。禁用账号（available=false）同跳过
//! （与签到批量路径的 available 过滤一致）。
//!
//! ── 队列状态是**内存态** ────────────────────────────────────
//! 与 refs queueState 同款：重启即清空（任务本身幂等，重跑一轮即可补上），
//! 不落库 —— 落库的收益（断点续跑）抵不过状态陈旧带来的误展示。

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::Semaphore;

use crate::server::core::account_store::AccountStore;
use crate::server::core::billing::growth::{self, ACTION_ORDER};
use crate::server::core::billing::BillingService;
use crate::server::core::growth_actions::{self, ActionOutcome};
use crate::server::core::providers::DEFAULT_PROVIDER_ID;
use crate::server::logging;

/// 并发上限（1-4，默认 1；协调者契约）。默认 1 = 全部账号串行，
/// 与签到/旅行的「串行防风」口径一致。
pub const DEFAULT_CONCURRENCY: usize = 1;
pub const MAX_CONCURRENCY: usize = 4;

/// 账号执行前的错峰间隔（refs scheduler/travel.go:26 的 800ms 口径；
/// 并发 >1 时给每个账号组按序错开，避免同瞬齐发）。
const ACCOUNT_STAGGER_MS: u64 = 800;

/// 队列里的一个执行单元（对照 refs taskcenter.go:119-126 queueItem）。
#[derive(Debug, Clone)]
struct QueueItem {
    account_id: String,
    account_name: String,
    task_code: String,
    /// pending | running | ok | failed | skipped
    status: &'static str,
    message: String,
}

/// 一个账号的执行计划（同一账号的待办 + 会话）。
struct AccountPlan {
    account_name: String,
    session: Option<Value>,
    /// (items 下标, 任务码) —— 下标用于状态回写
    items: Vec<(usize, String)>,
    /// 阶段 0 待接受清单（扫描时按 accept_status 过滤，对照 refs
    /// autotask.go:1124 `!Claimed && !Locked && status 不在 accepted/completed`）
    accept_default: Vec<String>,
    accept_mp: Vec<String>,
}

/// 服务句柄：全局一把锁 + Clone（与 auto_checkin 同构）。
/// 锁只用来读写队列状态这类微秒级操作；执行全程在锁外（持锁不 await）。
#[derive(Clone)]
pub struct GrowthQueue {
    store: AccountStore,
    billing: BillingService,
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    /// 是否已有一轮在执行（RunningGuard 模式）
    running: bool,
    /// 尽力取消标记：置位后，每个账号在**当前项完成后**停止
    stop: bool,
    total: usize,
    done: usize,
    started_at: i64,
    concurrency: usize,
    items: Vec<QueueItem>,
}

impl GrowthQueue {
    pub fn new(store: AccountStore, billing: BillingService) -> Self {
        Self {
            store,
            billing,
            inner: Arc::new(Mutex::new(Inner {
                running: false,
                stop: false,
                total: 0,
                done: 0,
                started_at: 0,
                concurrency: DEFAULT_CONCURRENCY,
                items: Vec::new(),
            })),
        }
    }

    /// 取锁；锁中毒（持锁 panic）不致命，接管内部数据继续用
    /// （与账号存储、auto_checkin 同一策略）
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    // ─── 扫描（只读，/api/growth-tasks/scan 与 run 共用）────────

    /// 有资格参与 CN 成长体系的账号才拉会话（见模块头「账号范围」）。
    fn growth_eligible(account: &Value) -> bool {
        let provider = account
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_PROVIDER_ID);
        if provider != DEFAULT_PROVIDER_ID {
            return false;
        }
        // D4 门控：国际版账号无 CN 成长任务体系，不发起任何上游调用
        // （refs taskcenter.go:76-79）
        account.get("edition").and_then(Value::as_str) != Some("intl")
    }

    fn is_available(account: &Value) -> bool {
        account
            .get("available")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    /// 收集待扫描账号（id、显示名、会话）。同步段：账号存储的快照与
    /// 会话派生都是内存/本地操作。pub(crate)：travel 巡检（growth_schedule）
    /// 复用同一份「CN 成长体系账号」过滤口径，不另抄一份。
    pub(crate) fn collect_accounts(&self) -> Vec<(String, String, Option<Value>)> {
        self.store
            .list_accounts()
            .get("accounts")
            .and_then(Value::as_array)
            .map(|accounts| {
                accounts
                    .iter()
                    .filter(|account| Self::growth_eligible(account) && Self::is_available(account))
                    .filter_map(|account| {
                        let id = account.get("id").and_then(Value::as_str)?.to_string();
                        let name = account
                            .get("name")
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty())
                            .unwrap_or(&id)
                            .to_string();
                        let session = self
                            .store
                            .get_session_by_id(&id)
                            .map(|entry| entry.session);
                        Some((id, name, session))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 并发拉取每个账号的合并任务列表（默认 + mp 口径；refs taskcenter.go:59-104
    /// 的并发扫描同款）。返回 (账号 id, 显示名, 会话, 任务列表或错误)。
    async fn scan_accounts(&self) -> Vec<(String, String, Option<Value>, Result<Vec<growth::Task>, String>)> {
        let accounts = self.collect_accounts();
        let billing = self.billing.clone();
        let handles: Vec<_> = accounts
            .into_iter()
            .map(|(id, name, session)| {
                let billing = billing.clone();
                crate::spawn_task(async move {
                    let result = match &session {
                        Some(session) => growth::list_tasks_merged(&billing, session)
                            .await
                            .map_err(|error| error.message),
                        None => Err("没有可用凭证".to_string()),
                    };
                    (id, name, session, result)
                })
            })
            .collect();
        let mut out = Vec::with_capacity(handles.len());
        for handle in handles {
            // 任务自身不返回 Err（结果装在元组里）；JoinError 只在 panic 时出现，
            // release 是 panic=abort —— 到这里进程已经没了，这个分支实际不可达
            if let Ok(row) = handle.await {
                out.push(row);
            }
        }
        out
    }

    /// 扫描结果 → /api/growth-tasks/scan 的 data（全部任务带状态，供展示）。
    pub async fn scan(&self) -> Value {
        let scanned_at = logging::now_ms();
        let mut results = Vec::new();
        let mut pending = 0usize;
        for (id, name, _session, tasks) in self.scan_accounts().await {
            match tasks {
                Ok(tasks) => {
                    // filter 的谓词拿到的是 &&Task，这里用闭包做一层解引用
                    pending += tasks.iter().filter(|task| growth::growth_pending(task)).count();
                    results.push(json!({
                        "id": id,
                        "name": name,
                        "error": Value::Null,
                        "tasks": tasks.iter().map(growth::task_scan_json).collect::<Vec<_>>(),
                    }));
                }
                Err(message) => {
                    results.push(json!({
                        "id": id,
                        "name": name,
                        "error": message,
                        "tasks": [],
                    }));
                }
            }
        }
        logging::log(
            "[Growth]",
            &format!("任务扫描完成：{pending} 项待办（{} 个账号）", results.len()),
        );
        json!({ "results": results, "scannedAt": scanned_at })
    }

    // ─── 入队与执行 ─────────────────────────────────────────

    /// 扫描待办并组队（写 items、返回账号组）。已在 RunningGuard 持有期调用。
    async fn plan_pending(&self, concurrency: usize) -> Vec<AccountPlan> {
        let mut items = Vec::new();
        let mut plans = Vec::new();
        for (id, name, session, tasks) in self.scan_accounts().await {
            let mut pending: Vec<growth::Task> = match tasks {
                Ok(tasks) => tasks.into_iter().filter(growth::growth_pending).collect(),
                Err(message) => {
                    logging::log("[Growth]", &format!("账号 {name} 扫描失败，本轮跳过: {message}"));
                    Vec::new()
                }
            };
            // 账号内按 autoActions 依赖顺序排（first_buddy 依赖活跃上报解锁）
            pending.sort_by_key(|task| growth::action_order(&task.task_code));
            let mut accept_default = Vec::new();
            let mut accept_mp = Vec::new();
            let entries: Vec<(usize, String)> = pending
                .iter()
                .map(|task| {
                    let index = items.len();
                    items.push(QueueItem {
                        account_id: id.clone(),
                        account_name: name.clone(),
                        task_code: task.task_code.clone(),
                        status: "pending",
                        message: String::new(),
                    });
                    // 阶段 0 只接受「尚未接受」的（refs autotask.go:1124 的状态过滤）
                    if task.accept_status != "accepted" && task.accept_status != "completed" {
                        if growth::is_mp_task_code(&task.task_code) {
                            accept_mp.push(task.task_code.clone());
                        } else {
                            accept_default.push(task.task_code.clone());
                        }
                    }
                    (index, task.task_code.clone())
                })
                .collect();
            plans.push(AccountPlan {
                account_name: name,
                session,
                items: entries,
                accept_default,
                accept_mp,
            });
        }
        let total = items.len();
        let mut inner = self.lock();
        inner.items = items;
        inner.total = total;
        inner.done = 0;
        inner.concurrency = concurrency;
        plans
    }

    /// 启动一轮执行。已有轮次在跑时返回 Err（api 层翻成 409）。
    /// 返回 Ok(本轮入队的待办总数)。
    pub async fn run(&self, concurrency: usize) -> Result<usize, ()> {
        let concurrency = concurrency.clamp(DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
        // ① CAS 抢「执行中」标记（RunningGuard 模式，auto_checkin.rs:349-360）
        let guard = {
            let mut inner = self.lock();
            if inner.running {
                return Err(());
            }
            inner.running = true;
            inner.stop = false;
            RunningGuard { inner: self.inner.clone() }
        };
        // ② 扫描待办并组队（异步段在锁外）
        let plans = self.plan_pending(concurrency).await;
        let total = self.lock().total;
        if total == 0 {
            logging::log("[Growth]", "没有待执行的成长任务，本轮结束");
            drop(guard); // Drop 复位 running
            return Ok(0);
        }
        logging::log(
            "[Growth]",
            &format!("成长任务队列启动：{total} 项待办，并发 {concurrency}"),
        );
        // ③ 账号组并发执行（Semaphore 限并发；账号内串行）
        let queue = self.clone();
        let semaphore = Arc::new(Semaphore::new(concurrency));
        let mut handles = Vec::new();
        for (group_index, plan) in plans.into_iter().enumerate() {
            let queue = queue.clone();
            let semaphore = semaphore.clone();
            handles.push(crate::spawn_task(async move {
                // 并发 >1 时按组序错峰，避免所有账号同瞬齐发
                if group_index > 0 {
                    tokio::time::sleep(Duration::from_millis(ACCOUNT_STAGGER_MS)).await;
                }
                // Semaphore 永不 close，acquire 只在关闭时 Err —— 不会发生
                if let Ok(_permit) = semaphore.acquire_owned().await {
                    queue.run_account_group(plan).await;
                }
            }));
        }
        // ④ 收尾：等全部账号组结束 → 汇总日志 + 审计；guard 随任务结束 Drop
        // （running 复位），期间重复触发 run 会被 409 挡住
        crate::spawn_task(async move {
            for handle in handles {
                let _ = handle.await;
            }
            let inner = queue.lock();
            let summary = format!(
                "队列完成: ok {} / failed {} / skipped {} / 共 {}",
                inner.items.iter().filter(|item| item.status == "ok").count(),
                inner.items.iter().filter(|item| item.status == "failed").count(),
                inner.items.iter().filter(|item| item.status == "skipped").count(),
                inner.total,
            );
            drop(inner);
            logging::log("[Growth]", &format!("成长任务{summary}"));
            // 审计埋点（完成时）。audit_api::audit 只是 logging 的标签封装
            //（不依赖 axum），core 引用它仅为复用 `[Audit]` 前缀与事件格式。
            crate::server::api::audit_api::audit("growth.complete", &summary);
            drop(guard); // 最后才放 running
        });
        Ok(total)
    }

    /// 尽力取消：置位后每个账号在当前项完成后停止（剩余项标 skipped）。
    pub fn stop(&self) {
        let mut inner = self.lock();
        inner.stop = true;
    }

    /// 队列状态（前端 3s 轮询 /api/growth-tasks/queue）。
    pub fn state(&self) -> Value {
        let inner = self.lock();
        json!({
            "running": inner.running,
            "total": inner.total,
            "done": inner.done,
            "concurrency": inner.concurrency,
            "startedAt": if inner.started_at > 0 { Value::from(inner.started_at) } else { Value::Null },
            "items": inner
                .items
                .iter()
                .map(|item| {
                    json!({
                        "accountId": item.account_id,
                        "accountName": item.account_name,
                        "taskCode": item.task_code,
                        "status": item.status,
                        "message": item.message,
                    })
                })
                .collect::<Vec<_>>(),
        })
    }

    fn stop_requested(&self) -> bool {
        self.lock().stop
    }

    /// 回写一个队列项的状态；终态计入 done。
    fn set_item(&self, index: usize, status: &'static str, message: String) {
        let mut inner = self.lock();
        // 终态判定与「该项还开放」判定都要在可变借用前算好：items 与 done 都经
        // MutexGuard 的 Deref 访问，字段间互斥对借用检查器不可见，必须顺序化
        let reached_final = matches!(status, "ok" | "failed" | "skipped");
        let was_open = inner
            .items
            .get(index)
            .is_some_and(|item| item.status == "pending" || item.status == "running");
        if was_open {
            if reached_final {
                inner.done += 1;
            }
            if let Some(item) = inner.items.get_mut(index) {
                item.status = status;
                item.message = message;
            }
        }
    }

    /// 单账号组：阶段 0 批量接受 → 串行执行全部待办（stop 在项间检查 ——
    /// 当前项完成后停；429/11128/登录态失效则整账号冷却，剩余项跳过）。
    async fn run_account_group(self, plan: AccountPlan) {
        let AccountPlan {
            account_name,
            session,
            items,
            accept_default,
            accept_mp,
        } = plan;
        let Some(session) = session else {
            for (index, _code) in items {
                self.set_item(index, "skipped", "没有可用凭证".to_string());
            }
            return;
        };
        // 阶段 0：批量接受「尚未接受」的待办（对照 refs autotask.go:1117-1166
        // runAutoAll 的阶段 0/0b，清单在扫描时已按 accept_status 过滤；accept 是
        // 「报名」不产生进度且幂等，失败不阻塞 —— 行为事件才是进度唯一判据）。
        // 拆默认 / mp 两个口径：mp 专属任务的 accept 要求
        // X-Client-Platform: miniprogram（refs tasks.go:104-109）。
        if !accept_default.is_empty() {
            match growth::accept_tasks_batched(&self.billing, &session, &accept_default, false).await
            {
                Ok(()) => {
                    // 批量接受后等 1.05s（refs autotask.go:1139 time.Sleep(reportGap)）
                    tokio::time::sleep(Duration::from_millis(growth::REPORT_GAP_MS)).await;
                }
                Err(error) => {
                    logging::log(
                        "[Growth]",
                        &format!("批量接受任务失败（不阻塞后续）: {}", error.message),
                    );
                }
            }
        }
        if !accept_mp.is_empty() {
            match growth::accept_tasks(&self.billing, &session, &accept_mp, true).await {
                Ok(()) => {
                    // mp 写动作间隔 2s（refs autotask.go:318 mpActionGap）
                    tokio::time::sleep(Duration::from_millis(growth::MP_ACTION_GAP_MS)).await;
                }
                Err(error) => {
                    logging::log(
                        "[Growth]",
                        &format!("批量接受 mp 任务失败（不阻塞后续）: {}", error.message),
                    );
                }
            }
        }
        for position in 0..items.len() {
            let (index, code) = items[position].clone();
            if self.stop_requested() {
                self.set_item(index, "skipped", "已取消（收到停止请求）".to_string());
                continue;
            }
            self.set_item(index, "running", String::new());
            let (status, message) = self.execute_task(&session, &code).await;
            // 风控判定要在 message 被 set_item 消耗（move）之前做
            let risk_hit = Self::account_risk_hit(&message);
            logging::log(
                "[Growth]",
                &format!("账号 {account_name} · {code}: [{status}] {message}"),
            );
            self.set_item(index, status, message);
            // 风控纪律：429 / 11128 / 登录态失效命中后**整账号冷却**——
            // 剩余项本轮跳过，不重试轰炸（换号重试是转发层的事，任务域不适用）
            if risk_hit {
                logging::log(
                    "[Growth]",
                    &format!(
                        "账号 {account_name} 命中上游风控/登录态失效，剩余 {} 项本轮冷却跳过",
                        items.len() - position - 1
                    ),
                );
                for (rest_index, _rest_code) in &items[position + 1..] {
                    self.set_item(
                        *rest_index,
                        "skipped",
                        "同账号命中上游风控/登录态失效（429/11128），本轮冷却跳过".to_string(),
                    );
                }
                break;
            }
        }
    }

    /// 「整账号冷却」信号判定：429（限额）/ 11128（风控拦截）/ 401（登录态
    /// 已过期）—— 出现在动作或领奖的错误文案里即视为该账号本轮不可用。
    fn account_risk_hit(message: &str) -> bool {
        message.contains("429") || message.contains("11128") || message.contains("登录态已过期")
    }

    /// 单任务流水线（对照 refs autotask.go:618-716 accountTaskAuto）：
    /// 前置读取（claimed/locked 跳过）→ 判据动作（growth_actions）→
    /// 回读（4×3s 有界轮询）→ 达标即领奖。
    async fn execute_task(&self, session: &Value, code: &str) -> (&'static str, String) {
        let task = match growth::task_by_code(&self.billing, session, code).await {
            Ok(Some(task)) => task,
            Ok(None) => return ("skipped", "该账号未下发此任务".to_string()),
            Err(error) => return ("failed", format!("查询任务失败: {}", error.message)),
        };
        if task.claimed {
            return ("skipped", "该任务已领取过奖励".to_string());
        }
        if task.locked {
            // Sequential 族每日零点解锁一环；locked 期间 accept 不落账
            //（refs taskcenter.go:42-48），等解锁后自然回到待办
            return ("skipped", "任务未解锁（上游锁定）".to_string());
        }
        let mp = growth::is_mp_task_code(code);
        // 判据动作（accept 在阶段 0 批量完成；mp 口径动作自带 acceptWithVerify
        // 回读验证 —— 上游存在 200+OK 但未落账形态，refs autotask.go:287-304）
        match growth_actions::run_action(&self.billing, session, code, &task).await {
            Ok(ActionOutcome::Done) => {}
            Ok(ActionOutcome::Skipped(message)) => return ("skipped", message),
            Err(error) => return ("failed", error.message),
        }
        // ③ 回读：上报 200 ≠ 计分（异步 + 可能静默丢弃），有界轮询等落定
        let after = match growth::task_by_code_waiting(&self.billing, session, code).await {
            Ok(after) => after,
            Err(error) => return ("failed", format!("回读任务进度失败: {}", error.message)),
        };
        let before_text = growth::task_progress_text(Some(&task));
        let after_text = growth::task_progress_text(after.as_ref());
        let progress = format!("进度 {before_text} → {after_text}");
        let claimable = after.as_ref().map(|task| task.claimable).unwrap_or(false);
        let claimed = after.as_ref().map(|task| task.claimed).unwrap_or(false);
        if !claimable {
            if claimed {
                return ("ok", format!("本轮已入账（claimed）；{progress}"));
            }
            return (
                "ok",
                format!("动作已完成，进度未达标（异步计分未归账，下次重试）；{progress}"),
            );
        }
        // ④ 达标即自动领奖（mp 口径 400 时降级 web 域，growth.rs 内处理）
        match growth::claim_reward(session, code, mp).await {
            Ok(reward) if reward.credit > 0 || reward.energy > 0 => (
                "ok",
                format!(
                    "已自动领奖 +{} 分 +{} 能；{progress}",
                    reward.credit, reward.energy
                ),
            ),
            Ok(_) => ("ok", format!("奖励此前已领取；{progress}")),
            Err(error) => (
                "ok",
                format!("达标但领奖失败: {}（可下次重试）；{progress}", error.message),
            ),
        }
    }

}

// ─── RunningGuard（复用 auto_checkin.rs:349-360 的模式）────────

/// 抢到「执行中」标记的守卫：无论正常结束还是任务被 abort，
/// Drop 时都会把 running 复位，避免 abort 把 running 永久卡在 true。
struct RunningGuard {
    inner: Arc<Mutex<Inner>>,
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        match self.inner.lock() {
            Ok(mut guard) => guard.running = false,
            Err(poisoned) => poisoned.into_inner().running = false,
        }
    }
}

// ─── 进程级句柄（api 层懒初始化；不进 ServerState，见交付说明）────

static GLOBAL: OnceLock<GrowthQueue> = OnceLock::new();

/// 取全局队列句柄（首次调用用传入的 store/billing 初始化，此后返回同一实例 ——
/// 两份句柄本来就是同一底层服务的克隆）。
pub fn global(store: AccountStore, billing: BillingService) -> GrowthQueue {
    let service = GrowthQueue::new(store, billing);
    match GLOBAL.set(service.clone()) {
        Ok(()) => service,
        Err(_) => GLOBAL.get().cloned().unwrap_or(service),
    }
}

/// ACTION_ORDER 的只读再导出（api 层文档/前端提示用，暂无调用点）。
#[allow(dead_code)]
pub fn action_order() -> &'static [&'static str] {
    ACTION_ORDER
}
