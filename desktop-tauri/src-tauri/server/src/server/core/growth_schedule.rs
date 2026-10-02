//! 成长任务定时调度（M4）：把 streak/lottery 闭环、travel 巡检与成长队列
//! 挂进面板既有的「轮询 + 当天去重 + 启动补跑」定时框架（框架语义照抄
//! core::auto_checkin —— 每 30s 比对墙上时钟，唤醒后自然补上错过的时点）。
//!
//! ── 四条调度线（时点缺省照 refs cmd/server/config.go:55-63 的 Schedule）──
//!   - **growth 队列**：每日 `growthTime`（缺省 01:00）跑一轮执行队列
//!     （refs growth_hours=[1]：「Sequential 族每日零点解锁，01:00 自动扫描执行」）；
//!   - **blackcat 补跑**：每日 `blackcatTime`（缺省 23:00）再跑一轮队列 ——
//!     夜猫子计数窗口 23:00–08:00（refs blackcat.go:19-23）在 01:00 轮之外
//!     覆盖（refs blackcat_hours=[23]）；
//!   - **travel 巡检**：每日 `travelHours`（缺省 [9,21]）各时点对全部可用账号
//!     单趟推进（refs scheduler/travel.go:47-66 RunTravelNow，账号间 800ms）；
//!   - **streak 管家**：不设独立时点，挂在定时/手动签到的 fire 完成后顺跑
//!     （refs scheduler/streak.go:1-8「由签到排程末尾调用」；
//!     `core::auto_checkin::fire` 尾部调用 [`run_streak_after_checkin`]）。
//!
//! ── 默认全关（有意）────────────────────────────────────────
//! refs 的 *_enabled 缺省 true 是多号网关场景；面板是**个人端**，四条线都
//! 写上游、消耗真实权益，默认关闭、由设置页显式开启（UI 由主会话接，
//! 读写端点为 `GET/PUT /api/growth-tasks/schedule`）。
//!
//! ── 配置与游标落 task_state（kv）──────────────────────────
//! 开关/时点/当日游标整份存 kv（键 `growthSchedule`，经 `core::task_state`
//! 的 backgroundTaskState 对象，无需新增 schema 保留键）。游标按
//! auto_checkin 的「先落日期再执行」次序写入：进程中途被杀也不会反复补跑。

use std::sync::OnceLock;
use std::time::Duration;

use chrono::Timelike;
use serde_json::{json, Map, Value};

use crate::server::core::account_store::AccountStore;
use crate::server::core::billing::streak;
use crate::server::core::billing::travel;
use crate::server::core::billing::BillingService;
use crate::server::core::growth_queue::{self};
use crate::server::core::task_state;
use crate::server::logging;

/// task_state（kv `backgroundTaskState` 对象）里承载本调度配置与游标的键
const KV_KEY: &str = "growthSchedule";

/// 轮询间隔：30s（core::auto_checkin.rs:45 的 TICK_MS 同一口径 —— 精确到
/// 分钟、又不让计时器显得忙）
pub const TICK_MS: u64 = 30_000;

/// 成长队列的默认时点（refs config.go:62 growth_hours=[1]）
pub const DEFAULT_GROWTH_TIME: &str = "01:00";
/// travel 巡检的默认时点（refs config.go:59 travel_hours=[9,21]）
pub const DEFAULT_TRAVEL_HOURS: &[u32] = &[9, 21];
/// 夜猫子补跑的默认时点（refs config.go:62 blackcat_hours=[23]）
pub const DEFAULT_BLACKCAT_TIME: &str = "23:00";

/// 调度配置 + 当日游标（游标由 tick 写，API 不接受改写）。
#[derive(Debug, Clone)]
pub struct ScheduleConfig {
    /// 连登管家挂签到 fire 完成后顺跑（refs scheduler/streak.go:1-8）
    pub streak_enabled: bool,
    /// 成长任务队列每日 growthTime 自动跑
    pub growth_enabled: bool,
    pub growth_time: String,
    /// travel 巡检每日 travelHours 各时点
    pub travel_enabled: bool,
    pub travel_hours: Vec<u32>,
    /// 夜猫子窗口（23:00–08:00）补跑一轮队列
    pub blackcat_enabled: bool,
    pub blackcat_time: String,
    /// 游标：growth 队列最近一次触发的日期（YYYY-MM-DD）
    pub fired_growth_date: String,
    /// 游标：blackcat 补跑最近一次触发的日期
    pub fired_blackcat_date: String,
    /// 游标：travel 最近一次触发的「日期-小时」键
    pub fired_travel_key: String,
}

// ─── 配置读写（task_state / kv）─────────────────────────────

fn load_raw() -> Result<Map<String, Value>, String> {
    let state = task_state::read(KV_KEY)?;
    match state.value {
        Some(Value::Object(map)) => Ok(map),
        _ => Ok(Map::new()),
    }
}

/// 读配置（缺失/未配置的字段按「默认全关 + refs 缺省时点」回落）。
/// 数据库不可用时返回 Err（调用方记日志跳过本轮，不打断调度循环）。
pub fn read_config() -> Result<ScheduleConfig, String> {
    let raw = load_raw()?;
    let bool_of = |key: &str| raw.get(key).and_then(Value::as_bool).unwrap_or(false);
    let text_of = |key: &str, default: &str| {
        raw.get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or(default)
            .to_string()
    };
    let travel_hours = match raw.get("travelHours").and_then(Value::as_array) {
        Some(items) if !items.is_empty() => items
            .iter()
            .filter_map(|value| value.as_u64().map(|number| number as u32))
            .collect(),
        _ => DEFAULT_TRAVEL_HOURS.to_vec(),
    };
    Ok(ScheduleConfig {
        streak_enabled: bool_of("streakEnabled"),
        growth_enabled: bool_of("growthEnabled"),
        growth_time: text_of("growthTime", DEFAULT_GROWTH_TIME),
        travel_enabled: bool_of("travelEnabled"),
        travel_hours,
        blackcat_enabled: bool_of("blackcatEnabled"),
        blackcat_time: text_of("blackcatTime", DEFAULT_BLACKCAT_TIME),
        fired_growth_date: text_of("firedGrowthDate", ""),
        fired_blackcat_date: text_of("firedBlackcatDate", ""),
        fired_travel_key: text_of("firedTravelKey", ""),
    })
}

/// 配置的 JSON 形态（api 层 schedule 端点复用 —— 同一份形状，勿另抄）。
pub fn config_json(config: &ScheduleConfig) -> Value {
    json!({
        "streakEnabled": config.streak_enabled,
        "growthEnabled": config.growth_enabled,
        "growthTime": config.growth_time,
        "travelEnabled": config.travel_enabled,
        "travelHours": config.travel_hours,
        "blackcatEnabled": config.blackcat_enabled,
        "blackcatTime": config.blackcat_time,
        "firedGrowthDate": config.fired_growth_date,
        "firedBlackcatDate": config.fired_blackcat_date,
        "firedTravelKey": config.fired_travel_key,
    })
}

fn save_config(config: &ScheduleConfig) -> Result<(), String> {
    task_state::store_value(KV_KEY, config_json(config))
}

/// 校验并合并设置补丁（API 层 PUT 的实现体；游标键不接受写入 —— 被显式忽略）。
/// 返回合并后的完整配置（给前端回显）。
pub fn write_config(patch: &Value) -> Result<Value, String> {
    let mut config = read_config()?;
    let bool_field = |patch: &Value, key: &str| -> Result<Option<bool>, String> {
        match patch.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_bool()
                .map(Some)
                .ok_or_else(|| format!("{key} 必须是布尔值")),
        }
    };
    if let Some(flag) = bool_field(patch, "streakEnabled")? {
        config.streak_enabled = flag;
    }
    if let Some(flag) = bool_field(patch, "growthEnabled")? {
        config.growth_enabled = flag;
    }
    if let Some(flag) = bool_field(patch, "travelEnabled")? {
        config.travel_enabled = flag;
    }
    if let Some(flag) = bool_field(patch, "blackcatEnabled")? {
        config.blackcat_enabled = flag;
    }
    // 时点复用 auto_checkin 的 HH:MM 校验（同一套「非法一律 400」口径）
    if let Some(time) = patch.get("growthTime").filter(|value| !value.is_null()) {
        config.growth_time =
            crate::server::core::auto_checkin::normalize_time(Some(time)).map_err(|e| e.message)?;
    }
    if let Some(time) = patch.get("blackcatTime").filter(|value| !value.is_null()) {
        config.blackcat_time =
            crate::server::core::auto_checkin::normalize_time(Some(time)).map_err(|e| e.message)?;
    }
    if let Some(hours) = patch.get("travelHours").filter(|value| !value.is_null()) {
        let items = hours
            .as_array()
            .ok_or_else(|| "travelHours 必须是 0-23 的整数数组".to_string())?;
        if items.is_empty() {
            // 空数组 = 回落默认（与 refs 的 emptyarr 口径一致，config_test:528）
            config.travel_hours = DEFAULT_TRAVEL_HOURS.to_vec();
        } else {
            let mut parsed = Vec::with_capacity(items.len());
            for value in items {
                let number = value
                    .as_u64()
                    .filter(|number| *number <= 23)
                    .ok_or_else(|| "travelHours 必须是 0-23 的整数数组".to_string())?;
                parsed.push(number as u32);
            }
            parsed.sort_unstable();
            parsed.dedup();
            config.travel_hours = parsed;
        }
    }
    save_config(&config)?;
    Ok(config_json(&config))
}

// ─── 调度循环 ───────────────────────────────────────────────

/// 起调度循环（由 `server::bootstrap` 与 `core::scheduled_tasks::spawn` 同点
/// 接线；进程级幂等，重复调用不会叠循环）。
pub fn spawn(store: AccountStore, billing: BillingService) {
    static SPAWNED: OnceLock<()> = OnceLock::new();
    if SPAWNED.set(()).is_err() {
        return;
    }
    logging::log(
        "[Growth]",
        "成长任务调度循环已启动（30s tick；默认全关，可在设置页开启）",
    );
    crate::spawn_task(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
            tick(&store, &billing).await;
        }
    });
}

/// 一次轮询：比对四条调度线的到点情况（auto_checkin 的 dueNow 语义 ——
/// 「今天已过时点且今日未触发」即触发，启动补跑由此自然获得）。
/// 配置读取失败只跳过本轮（kv 不可用不该打断循环）。
async fn tick(store: &AccountStore, billing: &BillingService) {
    let mut config = match read_config() {
        Ok(config) => config,
        Err(error) => {
            logging::verbose("[Growth]", &format!("调度配置读取失败，跳过本轮: {error}"));
            return;
        }
    };
    let now = chrono::Local::now();
    let today = now.format("%Y-%m-%d").to_string();

    // ① 成长任务队列（每日 growthTime）
    if config.growth_enabled
        && config.fired_growth_date != today
        && due_daily(&config.growth_time, now)
    {
        // 先落游标再执行（auto_checkin 同款）：中途被杀不会反复补跑
        config.fired_growth_date = today.clone();
        if let Err(error) = save_config(&config) {
            // 游标没落盘就不执行：否则 kv 恢复前的每个 tick 都会重复触发
            logging::log("[Growth]", &format!("调度游标写入失败: {error}"));
            return;
        }
        fire_growth_queue(store, billing, "growth 每日队列").await;
    }
    // ② 夜猫子窗口补跑（每日 blackcatTime 再跑一轮队列）
    if config.blackcat_enabled
        && config.fired_blackcat_date != today
        && due_daily(&config.blackcat_time, now)
    {
        config.fired_blackcat_date = today.clone();
        if let Err(error) = save_config(&config) {
            // 游标没落盘就不执行：否则 kv 恢复前的每个 tick 都会重复触发
            logging::log("[Growth]", &format!("调度游标写入失败: {error}"));
            return;
        }
        fire_growth_queue(store, billing, "blackcat 夜间补跑").await;
    }
    // ③ travel 巡检（每日 travelHours 各时点；账号间 800ms）
    let hour_key = format!("{today}-{}", now.hour());
    if config.travel_enabled
        && config.fired_travel_key != hour_key
        && config
            .travel_hours
            .iter()
            .any(|hour| *hour == now.hour() as u32)
    {
        config.fired_travel_key = hour_key;
        if let Err(error) = save_config(&config) {
            // 游标没落盘就不执行：否则 kv 恢复前的每个 tick 都会重复触发
            logging::log("[Growth]", &format!("调度游标写入失败: {error}"));
            return;
        }
        run_travel_sweep(store, billing).await;
    }
    // ④ streak 管家不在此处：挂在 auto_checkin::fire 完成后（见模块头）
}

/// 「今天已过 HH:MM」判定（auto_checkin 的 dueNow 口径）。time 文本非法
/// 一律 false（normalize_time 已在写入时挡过，这里只是兜底）。
fn due_daily(time_text: &str, now: chrono::DateTime<chrono::Local>) -> bool {
    let normalized =
        match crate::server::core::auto_checkin::normalize_time(Some(&Value::String(
            time_text.to_string(),
        ))) {
            Ok(normalized) => normalized,
            Err(_) => return false,
        };
    let Some((hour, minute)) = normalized.split_once(':') else {
        return false;
    };
    let (Ok(hour), Ok(minute)) = (hour.parse::<u32>(), minute.parse::<u32>()) else {
        return false;
    };
    now.hour() * 60 + now.minute() >= hour * 60 + minute
}

/// 跑一轮成长任务队列（并发取默认 1 —— 与「串行防风」口径一致；
/// 队列已在执行（手动 run / 另一条调度线占用）时按 409 语义静默跳过）。
async fn fire_growth_queue(store: &AccountStore, billing: &BillingService, reason: &str) {
    let queue = growth_queue::global(store.clone(), billing.clone());
    match queue.run(growth_queue::DEFAULT_CONCURRENCY).await {
        Ok(total) => logging::log(
            "[Growth]",
            &format!("定时调度（{reason}）启动队列：{total} 项待办"),
        ),
        Err(()) => logging::log(
            "[Growth]",
            &format!("定时调度（{reason}）：队列已在执行中，本轮跳过"),
        ),
    }
}

/// travel 巡检：对全部可用 CN 账号单趟推进（refs scheduler/travel.go:47-66
/// RunTravelNow —— 查询失败只跳过该账号；账号间 800ms，refs travel.go:26）。
/// 无猫 → 领养链、到站 → 领奖、空闲 → 派出（状态机在 `travel::travel_account_once`）。
async fn run_travel_sweep(store: &AccountStore, billing: &BillingService) {
    let queue = growth_queue::global(store.clone(), billing.clone());
    let accounts = queue.collect_accounts();
    let mut first = true;
    for (id, name, session) in accounts {
        if !first {
            tokio::time::sleep(Duration::from_millis(travel::TRAVEL_ACCOUNT_DELAY_MS)).await;
        }
        first = false;
        let Some(session) = session else {
            continue;
        };
        // 领养「当日已试」登记按 uid 记（travel.rs 的 adoptTried map）
        let uid = session
            .get("account")
            .and_then(|account| account.get("uid"))
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string();
        let message = travel::travel_account_once(billing, &session, &uid).await;
        logging::log("[Growth]", &format!("travel {name}: {message}"));
    }
}

/// 连登管家：挂定时/手动签到的 fire 完成后顺跑（refs scheduler/streak.go:1-8）。
/// streakEnabled 关闭时直接返回（一次 kv 读，开销可忽略）；逐账号执行
/// 补签 → 礼包/补偿 → 兑换 → 抽奖的幂等闭环（`streak::streak_bonus_account`）。
pub async fn run_streak_after_checkin(store: &AccountStore, billing: &BillingService) {
    let config = match read_config() {
        Ok(config) => config,
        Err(error) => {
            logging::verbose("[Growth]", &format!("连登管家跳过（配置读取失败）: {error}"));
            return;
        }
    };
    if !config.streak_enabled {
        return;
    }
    let queue = growth_queue::global(store.clone(), billing.clone());
    for (_id, name, session) in queue.collect_accounts() {
        let Some(session) = session else {
            continue;
        };
        let messages = streak::streak_bonus_account(billing, &session).await;
        if !messages.is_empty() {
            logging::log(
                "[Growth]",
                &format!("streak {name}: {}", messages.join("；")),
            );
        } else {
            logging::verbose("[Growth]", &format!("streak {name}: 本轮无可兑现项"));
        }
    }
}
