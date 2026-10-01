//! 账号探活：定时对**启用账号**逐个发一次最小上游请求，成功清零连败计数、
//! 失败 +1；连败达到阈值时调用 store 的既有禁用逻辑自动停用账号（只禁用、
//! 不删除），并在事件日志留痕。
//!
//! ── 这个模块解决什么问题 ─────────────────────────────────────
//! 转发链路只在「有人请求」时才会暴露死账号：一个 token 被吊销 / 套餐过期 /
//! 上游封禁的账号要等到用户请求轮到它才报错。探活是「没人请求的时候」那一面：
//! 周期性地把每个启用账号碰一次，坏账号在用户踩到之前就被发现并停用，
//! 让轮换链路不再把请求派给必死的账号。
//!
//! ── 探活动作用的是哪个既有方法（重要，逐家分档）────────────────
//! 探活必须走**既有转发路径**的现成入口，不新造任何请求构造：
//!   - **目录探活**（`ProviderAdapter::refresh_models(store, id, force=true)`）：
//!     「该家支持远程目录刷新 且 刷新走账号维度」的家（WorkBuddy / 小浣熊 /
//!     CatPaw / AutoClaw 两地 / Qoder / CodeArts / Accio 两地 / Trae）用这一条
//!     —— 它就是对**这个账号**的凭证发的一次真实上游请求（各家目录接口），
//!     返回 [`providers::adapter::ModelRefreshOutcome`]：
//!       · `refreshed = true` → 探活成功；
//!       · `message = Some(原因)` → 探活失败（HTTP 非 2xx / 网络错误 / 目录为空）；
//!       · `unchanged()`（无 message）→ **跳过**：这一档在 force=true 且点名账号
//!         时只剩「没有可用登录态」一种成因（各家对空凭证统一不打网络、不报
//!         失败，见 `catpaw::catalog` / `autoclaw::catalog` 的跳过分支）——
//!         那是配置缺口而不是账号故障，计失败会把没配凭证的账号探成停用。
//!   - **最小对话探活**（`build_chat_request` + `upstream::request::
//!     send_chat_request`）：目录刷新对账号维度不成立的两家用这条 ——
//!     Cline（目录接口无鉴权、清单是全局的，`refresh_uses_account() = false`）
//!     与 ZCode（静态清单，`refresh_models` 是空操作）。它们的转发是
//!     非会话式的（`is_stateful() = false`），因此按转发链路同一形态构造：
//!     会话形态（`store.get_session_by_id`）+ 家目录里的第一个模型 id +
//!     `stream:true` 的一条 1 token 消息，只看响应头状态码（SSE 建立即到达，
//!     不读流、不等生成完成）。
//!
//! ── 为什么不用 scheduled_tasks 注册表 ─────────────────────────
//! 那份注册表是 `core::scheduled_tasks::TASKS` 里的**定长静态数组**，增删任务
//! 必须改那个文件；本模块保持自包含，只复用它的**排期原语**
//! （`core::task_state` 的 claim / finish / reschedule / schedule_now）自己起
//! 循环 —— 排期状态同样落库（`backgroundTaskState` 的保留键内，配置写入不会
//! 动它），于是「重启不重置节奏」「在途占位」「失败冷却」与注册表任务同款。
//! 代价是调度循环要由第一个 API 调用惰性拉起（[`ensure_loop`]，幂等；
//! `api::account_test` 的账号入口与 `api::probe_api` 的两条都会调它）——
//! 重启后到第一次有人触账号 / 探活接口之间，定时那一轮不会起跑。
//!
//! ── 设置与连败计数存哪里 ─────────────────────────────────────
//! 都在 `core::task_state` 的 kv 值里（**不新造表、不动 schema**）：
//!   - `probeSettings`：`{enabled, intervalMinutes, threshold, concurrency}`；
//!   - `probeFailures`：`{<账号 id>: 连败次数}`；
//!   - `accountProbe`：排期与运行状态本体（claim/finish 写的那份）。
//! 三个键都是 `backgroundTaskState` 这一行**内部**的条目，天然避开
//! 「新增顶层 kv 键要登记 `db::schema::RESERVED_KV_KEYS`」的约束。
//!
//! ── 硬约束（与 credential_maintenance 同两条）──────────────────
//!   1. **不持锁跨 await**：账号快照与逐账号判定都是同步取数，网络动作在锁外；
//!   2. **不 unwrap/expect**：本模块在后台循环与 HTTP handler 两条路径上跑，
//!      release 是 `panic = "abort"`，任何一处 panic 都会带走整个应用。

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use serde_json::{json, Map, Value};

use crate::server::config;
use crate::server::core::account_store::AccountStore;
use crate::server::core::models::model_id;
use crate::server::core::providers::adapter::{adapter_for, ProviderAdapter};
use crate::server::core::providers::{kind_from_id, DEFAULT_PROVIDER_ID};
use crate::server::core::proxies::{resolve_account_proxy, ProxyResolution};
use crate::server::core::task_state::{self, Claim, ManualBackoff};
use crate::server::core::upstream::request::{
    read_upstream_error, send_chat_request, TransportRequest,
};
use crate::server::logging;

/// 事件日志标签：与账号管理同一分类（logging.rs 的 TAG_CATEGORY 把
/// `[Accounts]` 归到 account 类；新标签不登记会落到 server 类）。
const TAG: &str = "[Accounts]";

/// task_state 里的三个键（都是 `backgroundTaskState` 行内部的条目，见模块头）
const TASK_KEY: &str = "accountProbe";
const SETTINGS_KEY: &str = "probeSettings";
const FAILURES_KEY: &str = "probeFailures";

/// 调度循环的判定间隔：与 `scheduled_tasks::TICK_MS` 同一粒度（间隔下限是
/// 1 分钟，10 秒的判定误差用户感知不到）。
const TICK_MS: u64 = 10_000;

/// 探活设置的默认值与边界。间隔边界沿用定时任务页的全局口径
/// （`config::INTERVAL_MIN_MINUTES` = 1、`INTERVAL_MAX_MINUTES` = 1440）。
pub const DEFAULT_INTERVAL_MINUTES: i64 = 30;
pub const DEFAULT_THRESHOLD: i64 = 3;
pub const DEFAULT_CONCURRENCY: i64 = 3;
pub const MIN_INTERVAL_MINUTES: i64 = config::INTERVAL_MIN_MINUTES;
pub const MAX_INTERVAL_MINUTES: i64 = config::INTERVAL_MAX_MINUTES;
pub const MAX_THRESHOLD: i64 = 20;
pub const MAX_CONCURRENCY: i64 = 10;

/// 探活结果的失败分类（`detail.category` 的取值；前端与日志按它区分
/// 「网络错误 / HTTP 状态 / 上游业务错误」，与任务要求的错误分类对应）。
pub const CATEGORY_OK: &str = "ok";
pub const CATEGORY_SKIPPED: &str = "skipped";
pub const CATEGORY_NETWORK: &str = "network";
pub const CATEGORY_HTTP: &str = "http";
pub const CATEGORY_UPSTREAM: &str = "upstream";

// ─── 设置 ────────────────────────────────────────────────────

/// 探活设置（`/api/probe/settings` 的读写单元）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProbeSettings {
    /// 是否开启定时探活（默认关闭）
    pub enabled: bool,
    /// 探活间隔（分钟；1–1440）
    pub interval_minutes: i64,
    /// 连败多少次后自动停用（1–20）
    pub threshold: i64,
    /// 单轮内并发探测的账号数（1–10，避免打爆上游）
    pub concurrency: i64,
}

impl Default for ProbeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_minutes: DEFAULT_INTERVAL_MINUTES,
            threshold: DEFAULT_THRESHOLD,
            concurrency: DEFAULT_CONCURRENCY,
        }
    }
}

/// 从 kv 值解析设置（缺键回落默认、越界按边界收敛：手改库不该让探活跑飞）。
fn settings_from_value(value: Option<&Value>) -> ProbeSettings {
    let Some(object) = value.and_then(Value::as_object) else {
        return ProbeSettings::default();
    };
    let int_of = |key: &str, fallback: i64, min: i64, max: i64| {
        object
            .get(key)
            .and_then(Value::as_i64)
            .map(|number| number.clamp(min, max))
            .unwrap_or(fallback)
    };
    ProbeSettings {
        enabled: object
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        interval_minutes: int_of(
            "intervalMinutes",
            DEFAULT_INTERVAL_MINUTES,
            MIN_INTERVAL_MINUTES,
            MAX_INTERVAL_MINUTES,
        ),
        threshold: int_of("threshold", DEFAULT_THRESHOLD, 1, MAX_THRESHOLD),
        concurrency: int_of("concurrency", DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    }
}

/// 当前生效的探活设置（每次读取都从库里取：设置是低频读点，不值得再开缓存）。
pub fn settings() -> ProbeSettings {
    match task_state::read(SETTINGS_KEY) {
        Ok(state) => settings_from_value(state.value.as_ref()),
        Err(error) => {
            logging::verbose(TAG, &format!("读取探活设置失败，使用默认值：{error}"));
            ProbeSettings::default()
        }
    }
}

fn interval_ms(settings: &ProbeSettings) -> i64 {
    settings.interval_minutes.max(1) * 60_000
}

fn persist_settings(settings: &ProbeSettings) -> Result<(), String> {
    task_state::store_value(
        SETTINGS_KEY,
        json!({
            "enabled": settings.enabled,
            "intervalMinutes": settings.interval_minutes,
            "threshold": settings.threshold,
            "concurrency": settings.concurrency,
        }),
    )
}

/// 读取连败计数表（缺失 / 读库失败都按空表处理：计数只是探活的辅助状态）。
fn load_failures() -> Map<String, Value> {
    match task_state::read(FAILURES_KEY) {
        Ok(state) => state
            .value
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default(),
        Err(error) => {
            logging::verbose(TAG, &format!("读取探活连败计数失败，按零处理：{error}"));
            Map::new()
        }
    }
}

/// 写回连败计数表（失败只降级成 verbose 日志：少一轮计数不影响下一轮重算）。
fn save_failures(failures: &Map<String, Value>) {
    if let Err(error) = task_state::store_value(FAILURES_KEY, Value::Object(failures.clone())) {
        logging::verbose(TAG, &format!("保存探活连败计数失败：{error}"));
    }
}

/// 连败计数表的响应形态（`{<账号 id>: 次数}`，只含非零项）。
fn failure_counts_json() -> Value {
    let counts: Map<String, Value> = load_failures()
        .into_iter()
        .filter(|(_, count)| count.as_i64().unwrap_or(0) > 0)
        .collect();
    Value::Object(counts)
}

/// GET /api/probe/settings 的响应体：设置 + 当前排期状态 + 连败计数，
/// 前端一张卡片就能画完（不必再调一次任务状态接口）。
pub fn settings_json() -> Value {
    let settings = settings();
    // 库不可用时按「从未跑过」展示：设置页要能打开，而不是报错
    let state = task_state::read(TASK_KEY).unwrap_or_default();
    let timestamp = |at: i64| if at > 0 { json!(at) } else { Value::Null };
    json!({
        "enabled": settings.enabled,
        "intervalMinutes": settings.interval_minutes,
        "threshold": settings.threshold,
        "concurrency": settings.concurrency,
        "bounds": {
            "minIntervalMinutes": MIN_INTERVAL_MINUTES,
            "maxIntervalMinutes": MAX_INTERVAL_MINUTES,
            "maxThreshold": MAX_THRESHOLD,
            "maxConcurrency": MAX_CONCURRENCY,
            "defaultIntervalMinutes": DEFAULT_INTERVAL_MINUTES,
            "defaultThreshold": DEFAULT_THRESHOLD,
            "defaultConcurrency": DEFAULT_CONCURRENCY,
        },
        "running": state.running(),
        "lastRunAt": timestamp(state.last_run_at),
        "lastResult": state.last_result,
        "lastError": state.last_error,
        "nextRunAt": if settings.enabled {
            timestamp(state.due_at().max(logging::now_ms()))
        } else {
            Value::Null
        },
        "failures": failure_counts_json(),
    })
}

/// PUT /api/probe/settings：允许部分字段，校验通过后整份落盘并按
/// scheduled_tasks::configure 的同一语义联动排期（开启 → 立即到点跑一轮；
/// 改间隔 → 从上次尝试起按新间隔重排）。数值三项缺失或 null = 不改；
/// `enabled` 出现时只认严格 true（与 `scheduled_tasks::configure` 的口径
/// 逐字一致）。返回**生效后**的完整状态（前端直接用响应刷新，不必再 GET）。
pub fn update_settings(patch: &Value) -> Result<Value, String> {
    let Some(object) = patch.as_object() else {
        return Err("请求体必须是 JSON 对象".to_string());
    };
    let current = settings();
    let mut next = current;
    let mut enabled_changed = false;
    let mut interval_changed = false;
    if let Some(value) = object.get("enabled") {
        // 与 scheduled_tasks::configure 同一口径：只认严格 true，其余一律 false
        let enabled = value == &Value::Bool(true);
        enabled_changed = enabled != current.enabled;
        next.enabled = enabled;
    }
    if let Some(value) = object.get("intervalMinutes").filter(|value| !value.is_null()) {
        let interval =
            parse_bounded_int(value, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, "探活间隔（分钟）")?;
        interval_changed = interval != current.interval_minutes;
        next.interval_minutes = interval;
    }
    if let Some(value) = object.get("threshold").filter(|value| !value.is_null()) {
        next.threshold = parse_bounded_int(value, 1, MAX_THRESHOLD, "连败停用阈值")?;
    }
    if let Some(value) = object.get("concurrency").filter(|value| !value.is_null()) {
        next.concurrency = parse_bounded_int(value, 1, MAX_CONCURRENCY, "并发数")?;
    }
    persist_settings(&next)?;
    if next.enabled && enabled_changed {
        // 刚开启：沿用「开启即跑一次」的既有语义（失败冷却仍优先，见
        // task_state::due_at 的取大者）
        if let Err(error) = task_state::schedule_now(TASK_KEY) {
            logging::verbose(TAG, &format!("探活排期置为立即执行失败：{error}"));
        }
    } else if next.enabled && interval_changed {
        // 改间隔：按新间隔从上次尝试起重新计时（要马上跑有手动入口）
        if let Err(error) = task_state::reschedule(TASK_KEY, interval_ms(&next)) {
            logging::verbose(TAG, &format!("探活排期重算失败：{error}"));
        }
    }
    logging::log(
        TAG,
        &format!(
            "账号探活设置已更新：{}，间隔 {} 分钟，连败 {} 次停用，并发 {}",
            if next.enabled { "开启" } else { "关闭" },
            next.interval_minutes,
            next.threshold,
            next.concurrency,
        ),
    );
    Ok(settings_json())
}

/// 单个整数的校验（与 queue_api::parse_bounded_int 同一口径：只认 JSON 数字，
/// 容忍 `2.0` 这类整值浮点；字符串 `"2"` 视为非法）。
fn parse_bounded_int(value: &Value, min: i64, max: i64, label: &str) -> Result<i64, String> {
    let number = match value {
        Value::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|raw| raw.is_finite() && raw.fract() == 0.0)
                .map(|raw| raw as i64)
        }),
        _ => None,
    };
    let Some(number) = number else {
        return Err(format!("{label}必须是整数"));
    };
    if !(min..=max).contains(&number) {
        return Err(format!("{label}必须在 {min}~{max} 之间"));
    }
    Ok(number)
}

// ─── 单账号探活 ──────────────────────────────────────────────

/// 一次探活的结果。
///
/// `skipped` 表达「这次没有探」而不是「探过是好的」：连败计数对它**不动**
/// （没探到不代表失败，与 credential_maintenance 的 skipped 同一取向）；
/// `category` 给出失败分类（[`CATEGORY_NETWORK`] 等），成功 / 跳过时是
/// [`CATEGORY_OK`] / [`CATEGORY_SKIPPED`]，`detail` 是给人看的说明。
#[derive(Clone, Debug)]
pub struct ProbeOutcome {
    pub success: bool,
    pub skipped: bool,
    /// 本次请求的耗时（毫秒；跳过时为 0）
    pub latency_ms: i64,
    pub category: &'static str,
    pub detail: String,
}

impl ProbeOutcome {
    fn success(latency_ms: i64) -> Self {
        Self {
            success: true,
            skipped: false,
            latency_ms,
            category: CATEGORY_OK,
            detail: String::new(),
        }
    }

    fn failed(category: &'static str, detail: impl Into<String>, latency_ms: i64) -> Self {
        Self {
            success: false,
            skipped: false,
            latency_ms,
            category,
            detail: detail.into(),
        }
    }

    fn skipped(detail: impl Into<String>) -> Self {
        Self {
            success: false,
            skipped: true,
            latency_ms: 0,
            category: CATEGORY_SKIPPED,
            detail: detail.into(),
        }
    }
}

/// 探活一个账号（探活动作按 provider 的能力自动分档，见模块头）。
///
/// `account` 是 `AccountStore::list_accounts()` 里的**公开形态**（含
/// `id` / `provider` / `hasCredentials`；探活只读它，不回读账号文件）。
pub async fn probe_account(store: &AccountStore, account: &Value) -> ProbeOutcome {
    let id = account
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() {
        return ProbeOutcome::skipped("账号缺少 id");
    }
    // 自定义提供商（`custom-` 前缀）不进 ProviderKind（注册表口径见
    // providers::mod 的模块头），如实说「不支持」而不是误报「未注册」。
    let provider_id = account
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_PROVIDER_ID);
    if crate::server::core::custom_providers::is_custom_provider_id(provider_id) {
        return ProbeOutcome::skipped("自定义提供商暂不支持探活");
    }
    let Some(kind) = kind_from_id(provider_id) else {
        return ProbeOutcome::skipped(format!("未注册的提供商 {provider_id}"));
    };
    // 没有凭证的账号探不出任何结论（两类动作都要凭证）——跳过是唯一诚实答案
    if account.get("hasCredentials").and_then(Value::as_bool) == Some(false) {
        return ProbeOutcome::skipped("没有可用凭证");
    }
    let adapter = adapter_for(kind);
    if adapter.supports_model_refresh() && adapter.refresh_uses_account() {
        probe_via_catalog(store, &id, adapter).await
    } else {
        probe_via_chat(&id, adapter, store).await
    }
}

/// 目录探活：对**这个账号**的凭证发一次真实的目录请求（各家的现成
/// `refresh_models`，force=true 绕过缓存/TTL —— 探活要的是「现在通不通」，
/// 拿缓存回答等于什么都没测）。三档返回的语义见模块头。
async fn probe_via_catalog(
    store: &AccountStore,
    id: &str,
    adapter: &'static dyn ProviderAdapter,
) -> ProbeOutcome {
    let started = Instant::now();
    let outcome = adapter.refresh_models(store, id, true).await;
    let latency = elapsed_ms(started);
    if outcome.refreshed {
        return ProbeOutcome::success(latency);
    }
    if let Some(message) = outcome.message {
        // 目录刷新的失败原因已经过各家适配器的措辞（401 会给「登录态已失效」
        // 这类可操作文案），原样透传，不在这里二次包装
        return ProbeOutcome::failed(CATEGORY_UPSTREAM, message, latency);
    }
    // force=true + 点名账号时 unchanged 只剩「没有可用登录态」一种成因
    // （见模块头「三档返回」的分析）
    ProbeOutcome::skipped("该账号没有可用于探活的登录凭证")
}

/// 最小对话探活（Cline / ZCode）：按转发链路的同一形态发一条 1 token 的
/// 流式请求，**只等响应头**——2xx 即通（SSE 在响应头阶段就建立，流不读、
/// 随 future 丢弃，与转发「恒带 stream:true」的口径一致）。
async fn probe_via_chat(id: &str, adapter: &'static dyn ProviderAdapter, store: &AccountStore) -> ProbeOutcome {
    let started = Instant::now();
    // 会话形态（含 auth.accessToken 与代理），与转发链路取的是同一份
    let Some(entry) = store.get_session_by_id(id) else {
        return ProbeOutcome::skipped("没有可用凭证");
    };
    // 模型名取家目录里的第一个可用 id：转发入口会按广告视图校验模型名
    // （`api::pipeline::resolve_model`），目录里的名字就是上游认识的名字
    let model = adapter
        .list_models()
        .iter()
        .find_map(|item| {
            let name = model_id(item);
            (!name.is_empty()).then_some(name)
        });
    let Some(model) = model else {
        return ProbeOutcome::skipped("该提供商当前没有可用模型");
    };
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": "ping" }],
        "stream": true,
        "max_tokens": 1,
    });
    let plan = match adapter.build_chat_request(&entry.session, &body, &HeaderMap::new()) {
        Ok(plan) => plan,
        Err(error) => {
            return ProbeOutcome::failed(CATEGORY_UPSTREAM, error.message, elapsed_ms(started))
        }
    };
    let payload = match serde_json::to_string(&plan.body) {
        Ok(payload) => payload,
        Err(error) => {
            return ProbeOutcome::failed(
                CATEGORY_UPSTREAM,
                format!("请求体序列化失败: {error}"),
                elapsed_ms(started),
            )
        }
    };
    // 出口：会话里的账号级代理。解析失败按直连兜底（与出网侧「可用性优先」
    // 的既有取舍一致，见 proxies::ResolvedProxy::from_json 的说明）
    let proxy = match resolve_account_proxy(Some(&entry.proxy)) {
        Some(ProxyResolution::Resolved(proxy)) => Some(proxy),
        _ => None,
    };
    let transport = TransportRequest {
        url: plan.url,
        headers: plan.headers,
        payload,
        proxy,
    };
    match send_chat_request(&transport).await {
        Ok(response) => {
            let status = response.status().as_u16();
            if (200..300).contains(&status) {
                return ProbeOutcome::success(elapsed_ms(started));
            }
            // 非 2xx：归一化读一次错误体（HTTP 状态 + 上游业务码 / 文案），
            // 响应体在此被读掉，不透传给任何下游
            let detail = read_upstream_error(response, None).await;
            ProbeOutcome::failed(
                CATEGORY_HTTP,
                format!("上游返回 {status}: {}", detail.message),
                elapsed_ms(started),
            )
        }
        Err(error) => ProbeOutcome::failed(CATEGORY_NETWORK, error.message, elapsed_ms(started)),
    }
}

fn elapsed_ms(started: Instant) -> i64 {
    i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX)
}

// ─── 功能一：一键连通性测试（POST /api/accounts/{id}/test）────

/// 测试错误（core 不认识 axum，由 api 层转成管理信封；形状与
/// `usage_query::TargetError` 同一分工）。
#[derive(Clone, Debug)]
pub struct ProbeError {
    pub message: String,
    pub status_code: u16,
}

/// 对指定账号做一次连通性测试并返回响应体
/// （`{id, name, provider, success, skipped, latencyMs, detail}`）。
///
/// **不改账号状态、不动连败计数**：这是用户对某一行的一次提问，不是探活
/// 那一轮的证据 —— 手动点一次「测试失败」就把账号探停用，等于把诊断工具
/// 变成了断路器。结果只进事件日志（成功 ✅ / 失败 ❌ / 跳过 verbose）。
///
/// 显式指定 id 时**不看启用状态**（与 `/api/accounts/usage?id=` 同一语义：
/// 禁用只表示「不参与转发」，用户仍可能想知道它现在通不通）。
pub async fn test_account(store: &AccountStore, id: &str) -> Result<Value, ProbeError> {
    let snapshot = store.list_accounts();
    let accounts: Vec<Value> = snapshot
        .get("accounts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(account) = accounts
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
    else {
        return Err(ProbeError {
            message: "账号不存在".to_string(),
            status_code: 404,
        });
    };
    let name = account
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let provider_id = account
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_PROVIDER_ID)
        .to_string();
    let outcome = probe_account(store, account).await;
    let label = if name.is_empty() {
        id.to_string()
    } else {
        format!("{name}（{id}）")
    };
    if outcome.skipped {
        logging::verbose(
            TAG,
            &format!("账号 {label} 连通性测试未执行：{}", outcome.detail),
        );
    } else if outcome.success {
        logging::log(
            TAG,
            &format!(
                "✅ 账号 {label} 连通性测试通过（{provider_id}，{} 毫秒）",
                outcome.latency_ms
            ),
        );
    } else {
        logging::log(
            TAG,
            &format!(
                "❌ 账号 {label} 连通性测试失败（{provider_id}，{}）：{}",
                outcome.category, outcome.detail
            ),
        );
    }
    Ok(json!({
        "id": id,
        "name": account.get("name").cloned().unwrap_or(Value::Null),
        "provider": provider_id,
        "success": outcome.success,
        "skipped": outcome.skipped,
        "latencyMs": outcome.latency_ms,
        "detail": { "category": outcome.category, "message": outcome.detail },
    }))
}

// ─── 功能二：探活一轮 + 连败自动停用 ─────────────────────────

/// 手动触发一轮探活（POST /api/probe/run）。
///
/// 与定时那轮共用 [`run_round`]；手动跳过普通排期与失败冷却
/// （[`ManualBackoff::Bypass`]：用户按按钮的预期就是「现在探一轮」），在途
/// 占位与最短间隔不越过（与 scheduled_tasks::run_now 同一取舍）。
/// 返回 `{summary, results, settings}`；撞上正在跑的一轮时 Err（api 层给 400）。
pub async fn run_now(store: &AccountStore) -> Result<Value, String> {
    let settings = settings();
    let interval = interval_ms(&settings);
    let guard = match task_state::claim(TASK_KEY, interval, true, ManualBackoff::Bypass, 1_000)? {
        Claim::Acquired(guard) => guard,
        Claim::Deferred(state) => return Err(state.waiting_message()),
    };
    let (summary, results) = run_round(store, &settings, "手动").await;
    // 任务级一律按成功收尾（排期照走、不进失败退避）：探活的职责就是发现
    // 坏账号，「这轮发现了 2 个坏账号」是正常履职而不是任务失败——若按
    // 「有失败就退避」，坏账号反而会把后续探活轮次越推越远
    guard.finish(true, summary.clone(), None, 0, interval)?;
    Ok(json!({
        "summary": summary,
        "results": results,
        "settings": settings_json(),
    }))
}

/// 一轮探活：对**全部启用账号**并发度受限地各探一次，维护连败计数并在达到
/// 阈值时自动停用。返回 `(摘要, 逐账号结果)`。
///
/// ── 并发度 ──────────────────────────────────────────────────
/// 按 `settings.concurrency` 分批（`join_all` 逐批等待）：一批全部发出、
/// 等齐再发下一批 —— 实现最短、并发上界严格，探活的节奏要求也就这么多。
///
/// ── 连败计数与自动停用 ──────────────────────────────────────
/// 计数表每轮**按本轮目标集重建**（旧表 ∩ 本轮目标）：被删 / 被停用账号的
/// 计数随之清掉，表不会无限增长；成功清零、失败 +1、跳过不动。计数达到
/// 阈值时走 `store.batch_update(enabled:false)` —— 与界面「批量禁用」完全
/// 同一条 store 路径（只禁用、不删除），并打一条事件日志说明原因。
async fn run_round(store: &AccountStore, settings: &ProbeSettings, trigger: &str) -> (String, Value) {
    let targets: Vec<Value> = store
        .list_accounts()
        .get("accounts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|account| account.get("enabled").and_then(Value::as_bool).unwrap_or(true))
        .collect();
    if targets.is_empty() {
        logging::verbose(TAG, &format!("账号探活（{trigger}）：没有启用的账号，无事可做"));
        return (
            "没有启用的账号，本轮探活无事可做".to_string(),
            json!([]),
        );
    }
    let concurrency = settings.concurrency.max(1) as usize;
    let old_failures = load_failures();
    // 只保留本轮目标集的旧计数（清理被删 / 被停用账号的残留项）
    let mut failures: Map<String, Value> = old_failures
        .into_iter()
        .filter(|(id, _)| {
            targets
                .iter()
                .any(|account| account.get("id").and_then(Value::as_str) == Some(id.as_str()))
        })
        .collect();
    let mut results: Vec<Value> = Vec::with_capacity(targets.len());
    let (mut ok_count, mut failed_count, mut skipped_count) = (0usize, 0usize, 0usize);
    let mut disabled: Vec<String> = Vec::new();

    for chunk in targets.chunks(concurrency) {
        let probes: Vec<_> = chunk
            .iter()
            .map(|account| probe_account(store, account))
            .collect();
        let outcomes = futures::future::join_all(probes).await;
        for (account, outcome) in chunk.iter().zip(outcomes) {
            let id = account
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let name = account
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let provider = account
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_PROVIDER_ID);
            let label = if name.is_empty() {
                id.clone()
            } else {
                format!("{name}（{id}）")
            };
            let count = failures.get(&id).and_then(Value::as_i64).unwrap_or(0);
            if outcome.skipped {
                // 跳过 = 这轮没探到证据，计数原样保留
                skipped_count += 1;
                logging::verbose(TAG, &format!("账号 {label} 探活跳过：{}", outcome.detail));
            } else if outcome.success {
                ok_count += 1;
                if count != 0 {
                    failures.insert(id.clone(), Value::from(0));
                }
            } else {
                failed_count += 1;
                let count = count + 1;
                if count >= settings.threshold.max(1) {
                    // 达到阈值：走既有禁用路径（与界面「批量禁用」同一条
                    // store 路径），并把计数清零 —— 用户排查后重新启用时
                    // 从头计起，不会因旧计数一次失败就再被停用
                    match store.batch_update(std::slice::from_ref(&id), &json!({ "enabled": false })) {
                        Ok(_) => {
                            logging::log(
                                TAG,
                                &format!(
                                    "🚫 探活连续 {count} 次失败，已自动停用账号 {label}：{}",
                                    outcome.detail
                                ),
                            );
                            disabled.push(id.clone());
                            failures.insert(id.clone(), Value::from(0));
                        }
                        Err(error) => {
                            logging::log(
                                TAG,
                                &format!("⚠️  账号 {label} 探活失败后自动停用未完成: {}", error.message),
                            );
                            failures.insert(id.clone(), Value::from(count));
                        }
                    }
                } else {
                    failures.insert(id.clone(), Value::from(count));
                    logging::log(
                        TAG,
                        &format!(
                            "❌ 账号 {label} 探活失败（连续 {count}/{}，{}）：{}",
                            settings.threshold, provider, outcome.detail
                        ),
                    );
                }
            }
            results.push(json!({
                "id": id,
                "name": if name.is_empty() { Value::Null } else { Value::String(name) },
                "provider": provider,
                "success": outcome.success,
                "skipped": outcome.skipped,
                "latencyMs": outcome.latency_ms,
                "category": outcome.category,
                "message": if outcome.detail.is_empty() { Value::Null } else { Value::String(outcome.detail) },
            }));
        }
    }
    save_failures(&failures);
    let summary = format!(
        "探活完成：成功 {ok_count}，失败 {failed_count}，跳过 {skipped_count}，自动停用 {}",
        disabled.len()
    );
    // 汇总级别跟结果走（与 credential_maintenance 同一口径）：发现坏账号并
    // 停用是「值得注意」的事件；单纯有失败行只是探活的常规产出
    logging::log_with_level(
        TAG,
        &format!("账号探活（{trigger}）：{summary}"),
        if disabled.is_empty() { "info" } else { "error" },
    );
    (summary, Value::Array(results))
}

// ─── 调度循环（惰性启动）─────────────────────────────────────

/// 拉起探活的调度循环（幂等：进程内只起一次；重复调用是空操作）。
///
/// 调用点见模块头「为什么不用 scheduled_tasks 注册表」—— 本模块无法在
/// bootstrap 里接线，因此由账号 / 探活的 API 入口惰性拉起。循环体每
/// [`TICK_MS`] 醒一次：读设置 → 判断开关 → 尝试占位（`claim` 内部含「到点
/// 了吗」与跨进程占位判定，没到点的轮次以 Deferred 返回）→ 到点则跑一轮。
/// 排期状态全部在库里，重启不重置节奏。
pub fn ensure_loop(store: AccountStore) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    crate::spawn_task(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
            let settings = settings();
            if !settings.enabled {
                continue;
            }
            let interval = interval_ms(&settings);
            match task_state::claim(TASK_KEY, interval, false, ManualBackoff::Respect, 1_000) {
                Ok(Claim::Acquired(guard)) => {
                    let (summary, _) = run_round(&store, &settings, "定时").await;
                    // 与 run_now 同一收尾口径：轮次跑完即成功，不进失败退避
                    if let Err(error) = guard.finish(true, summary, None, 0, interval) {
                        logging::verbose(TAG, &format!("探活排期收尾失败：{error}"));
                    }
                }
                Ok(Claim::Deferred(_)) => {}
                Err(error) => logging::verbose(TAG, &format!("探活排期判定失败：{error}")),
            }
        }
    });
}
