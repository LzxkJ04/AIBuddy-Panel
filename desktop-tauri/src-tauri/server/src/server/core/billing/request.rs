//! 计费请求的构造素材：端点表、调用选项、请求头与 JS 语义工具。
//!
//! 从 billing/mod.rs 拆出（单文件行数约定）。这里的东西**只被同层的
//! usage.rs / activity.rs / mod.rs 用**，不对外暴露。
//!
//!   - `BillingSpec` / 各端点常量：URL、方法、固定请求体、是否要白名单头
//!   - `CallOptions` / `BillingCall`：callBilling 的入参与返回
//!   - `build_headers` / `whitelist_headers`：计费接口的头集合
//!   - 一串 JS 语义工具（真值判定、Number()、parseTime 的时区语义…）

use serde_json::{json, Map, Value};

use crate::server::core::endpoints::{resolve_edition, user_agent_for_edition, RESPONSE_CODE_OK};
use crate::server::core::proxies::ResolvedProxy;

// ─── 请求描述 ───────────────────────────────────────────────

/// 上游「三域 base」（对照 workbuddy2api-panel internal/upstream/client.go:693-695、
/// 840-857：成长任务/连登/猫猫旅行这类接口挂在**固定域**上，不跟会话端点走 ——
/// 打错域即 400（tasks.go:223-225 前科：把领奖打到 copilot 域稳定
/// "task not completed"）。
///
///   - chatBase    = https://copilot.tencent.com（growth 任务 / streak / travel / 桌面指纹上报）
///   - billingBase = https://www.codebuddy.cn   （CLI 指纹上报 / 小程序指纹上报 / report.go billingJSON）
///   - webBase     = https://www.workbuddy.cn   （Web 成长中心领奖 / web 指纹上报）
///
/// 三个常量都只服务**国内版**账号：成长体系是 CN 专属（refs taskcenter.go:76-79
/// 的 D4 门控——global 账号不发起任何此类调用），调用方（growth 队列）负责先排除
/// 国际版，这里不再按 edition 分叉。
pub(super) enum BillingBase {
    /// 既有口径（全部存量端点的缺省）：跟随会话端点（session.endpoint，
    /// 国内版缺省即 chatBase）——保持 checkin/usage 等既有路径逐字不变。
    Session,
    /// chatBase（client.go ChatBaseCN）
    Chat,
    /// billingBase（client.go BillingBaseCN）
    Billing,
    /// webBase（client.go WebBaseCN）。当前 web 域动作（Library_read 上报、web
    /// 领奖降级）都经 `extra` 追加 `x-client-platform: web` 头在 chatBase 上发
    /// （refs tasks.go:216-272 的降级口径），没有端点以本变体为 base —— 保留
    /// 是为了三域常量在类型层齐全（refs client.go:693-695），补签卡/校园券码
    /// 等 web 专属端点接入时直接用。
    #[allow(dead_code)]
    Web,
}

/// chatBase（refs client.go:693）
pub(super) const CHAT_BASE: &str = "https://copilot.tencent.com";
/// billingBase（refs client.go:694）
pub(super) const BILLING_BASE: &str = "https://www.codebuddy.cn";
/// webBase（refs client.go:695 / 856）
pub(super) const WEB_BASE: &str = "https://www.workbuddy.cn";

/// 一个计费端点的描述（对应 Node 版 BILLING / ACTIVITY 表里的条目）
pub(super) struct BillingSpec {
    pub(super) method: &'static str,
    pub(super) path: &'static str,
    /// 固定请求体（Node 的 `spec.body`；userResource 是那个 PageNumber 常量体）。
    /// 用函数而不是常量值：`json!` 无法在 const 上下文求值。
    pub(super) body: fn() -> Value,
    /// 是否需要客户端白名单头（只有 banner 需要）
    pub(super) whitelist_headers: bool,
    /// 挂在哪个域上（缺省 Session = 既有会话端点派生；growth 域端点按
    /// refs 的三域分别固定）
    pub(super) base: BillingBase,
}

impl BillingSpec {
    pub(super) fn body(&self) -> Value {
        (self.body)()
    }
}

/// 没有固定请求体的端点：Node 里 `spec.body` 缺省 → `{}`
pub(super) fn empty_body() -> Value {
    json!({})
}

/// 个人积分包的固定请求体（对照 workbuddy-endpoints.mjs 的 BILLING.userResource.body，
/// ProductCode=p_tcaca 为 WorkBuddy 产品码）
fn user_resource_body() -> Value {
    json!({
        "PageNumber": 1,
        "PageSize": 100,
        "ProductCode": "p_tcaca",
        "Status": [0, 3],
        "OnlyValidPeriod": true,
    })
}

/// 调用选项：会话、请求体、查询串、是否要求 code===0、语言、追加头
pub(super) struct CallOptions<'a> {
    pub(super) session: Option<&'a Value>,
    pub(super) body: Option<&'a Value>,
    pub(super) query: Option<&'a str>,
    /// false 时非 0 code 也返回（签到重复领取要读 msg）
    pub(super) expect_code_ok: bool,
    pub(super) locale: Option<&'a str>,
    /// 追加头（growth 域专用：X-CodeBuddy-Request / X-Client-Platform 等）。
    /// 追加在白名单头之后、条件头（X-Enterprise-Id 等）之前 —— 与 Node 的
    /// `{...base, ...extra, X-Enterprise-Id}` 展开顺序一致。**只能加新键**，
    /// 不要用来覆盖 build_headers 已有的键（reqwest 重复 header 是追加不是覆盖）。
    pub(super) extra: Vec<(String, String)>,
}

impl Default for CallOptions<'_> {
    fn default() -> Self {
        Self {
            session: None,
            body: None,
            query: None,
            // Node 的默认值是 true（`expectCodeOk = true`）
            expect_code_ok: true,
            locale: None,
            extra: Vec::new(),
        }
    }
}

/// callBilling 的返回（对应 Node 的 `{ data, code, msg, requestId, raw }`）
pub(super) struct BillingCall {
    pub(super) code: Option<i64>,
    pub(super) msg: Option<String>,
    /// 上游 requestId；None 表示上游没给（签到的失败分支据此不出这个键）
    pub(super) request_id: Option<Value>,
    pub(super) data: Value,
    /// 原始 payload（企业额度那条路径要遍历 data.data 等嵌套字段）
    pub(super) raw: Option<Value>,
}

// 端点表（对照 workbuddy-endpoints.mjs 的 BILLING / ACTIVITY；不带 prefixPath）

pub(super) const BILLING_CHECKIN_STATUS: BillingSpec = BillingSpec {
    method: "POST",
    path: "/v2/billing/meter/checkin-activity-status",
    body: empty_body,
    whitelist_headers: false,
    base: BillingBase::Session,
};

pub(super) const BILLING_DAILY_CHECKIN: BillingSpec = BillingSpec {
    method: "POST",
    path: "/v2/billing/meter/daily-checkin",
    body: empty_body,
    whitelist_headers: false,
    base: BillingBase::Session,
};

pub(super) const BILLING_USER_RESOURCE: BillingSpec = BillingSpec {
    method: "POST",
    path: "/v2/billing/meter/get-user-resource",
    body: user_resource_body,
    whitelist_headers: false,
    base: BillingBase::Session,
};

pub(super) const BILLING_ENTERPRISE_USAGE: BillingSpec = BillingSpec {
    method: "POST",
    path: "/v2/billing/meter/get-enterprise-user-usage",
    body: empty_body,
    whitelist_headers: false,
    base: BillingBase::Session,
};

/// 用量提示端点（Node 版 BILLING.dosageNotify 的对等物）。
/// 由 `usage.rs` 的 `get_dosage_notify` 使用（该方法当前无生产调用点）。
pub(super) const BILLING_DOSAGE_NOTIFY: BillingSpec = BillingSpec {
    method: "POST",
    path: "/v2/billing/meter/get-dosage-notify",
    body: empty_body,
    whitelist_headers: false,
    base: BillingBase::Session,
};

pub(super) const ACTIVITY_BANNER: BillingSpec = BillingSpec {
    method: "GET",
    path: "/v2/activity/workbuddy/banner",
    body: empty_body,
    whitelist_headers: true,
    base: BillingBase::Session,
};

pub(super) const ACTIVITY_AMBASSADOR: BillingSpec = BillingSpec {
    method: "GET",
    path: "/v2/activity/ambassador/status",
    body: empty_body,
    whitelist_headers: false,
    base: BillingBase::Session,
};

// ─── 请求头 ─────────────────────────────────────────────────

/// AuthService.buildHeaders(session) 的等价实现 + extra 条件头。
///
/// 与 `auth::build_auth_headers` 的差别（注意，两者**不能互相替换**）：
///   - 计费版固定带 `Content-Type: application/json` 与 `Accept: application/json`
///   - 计费版**不**带 `X-Department-Info`（转发需要，计费不需要）
///   - 计费版 `X-User-Id` 缺失时给空串（转发版直接不给这个头）
///   - 计费版无 Authorization 时也会给 `Bearer `（转发版跳过）
///
/// 这些差别是 Node 版两个 buildHeaders 各自的实现决定的，逐条保留。
pub(super) fn build_headers(session: &Value, extra: &[(String, String)]) -> Vec<(String, String)> {
    let auth = session.get("auth").cloned().unwrap_or(Value::Null);
    let account = session.get("account").cloned().unwrap_or(Value::Null);
    let access_token = auth
        .get("accessToken")
        .and_then(Value::as_str)
        .unwrap_or("");

    let mut headers: Vec<(String, String)> = vec![
        ("Accept".to_string(), "application/json".to_string()),
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Authorization".to_string(), format!("Bearer {access_token}")),
        (
            "X-User-Id".to_string(),
            account.get("uid").and_then(Value::as_str).unwrap_or("").to_string(),
        ),
    ];
    // extra 在 Node 里是 `...extra` 插在 X-User-Id 之后的展开，
    // 因此同名的情况不存在（extra 只有 Accept-Language 与白名单头）
    for (key, value) in extra {
        headers.push((key.clone(), value.clone()));
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

/// 运营活动接口需要的客户端白名单头（getActivityBanner 专用）；
/// 按账号版本区分身份 —— 国际版与国内版的 productName / 版本号不同。
pub(super) fn whitelist_headers(session: &Value) -> Vec<(String, String)> {
    let edition = session.get("edition").and_then(Value::as_str);
    let info = resolve_edition(edition);
    vec![
        ("User-Agent".to_string(), user_agent_for_edition(edition)),
        ("X-IDE-Type".to_string(), info.ua_platform.to_string()),
        ("X-IDE-Name".to_string(), info.product_name.to_string()),
        ("X-IDE-Version".to_string(), info.client_version.to_string()),
        ("X-Product".to_string(), info.product_name.to_string()),
    ]
}

// ─── 工具函数 ───────────────────────────────────────────────

/// JS 真值判定（`Boolean(x)`）：null/false/0/"" 为假，空数组/空对象为真
pub(super) fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|item| item != 0.0).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JS `Number(x) || 0`：非数字/NaN/0/缺失都得到 0
pub(super) fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    match number {
        Some(number) if number.is_finite() => number,
        _ => 0.0,
    }
}

/// JS `toInt(value)`：`Math.floor(Number(value))`，NaN → null
pub(super) fn to_int(value: &Value) -> Option<i64> {
    let number = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    match number {
        Some(number) if number.is_finite() => Some(number.floor() as i64),
        _ => None,
    }
}

/// 解析时间字段为毫秒时间戳（对照 Node 版 `parseTime` 的**原始返回值**）。
///
/// 语义逐条对齐：
///   - 缺失 / null / 空串 → 0（不是 None）
///   - 纯数字字符串（`/^\d+$/`）→ 数字本身（上游有时把时间戳给成字符串）
///   - 其余交给 `new Date(x).getTime()`；解析不出 → 0
///
/// ── 时区语义必须逐字对齐（实测踩过）────────────────────────
/// JS 的 `new Date(str)` 对**无时区**的格式分两类，差 8 小时（东八区实测）：
///   `"2026-09-30"`（仅日期）      → **UTC** 零点（ECMAScript 规范规定）
///   `"2026-09-30 23:59:59"`       → **本地时区**（实现相关的宽松解析）
///   `"2026-09-30T23:59:59"`       → **本地时区**
/// 上游的 `CycleEndTime` / `CycleStartTime` 正是 `"YYYY-MM-DD HH:MM:SS"` 形态，
/// 若在这里按 UTC 解析，`refreshAt` 会整体偏 8 小时，前端显示的「额度刷新时间」
/// 就与 Node 版对不上。因此这里对「无时区的日期时间」用 `Local` 解析，
/// 「仅日期」用 UTC。
///
/// 返回 i64 而不是 Option：调用方需要的正是「0 为失败哨兵」这件事，
/// 好让 `|| 0` / `|| null` 这些 JS 假值判断在 Rust 侧一目了然。
pub(super) fn parse_time(value: Option<&Value>) -> i64 {
    time_or_null(value).unwrap_or(0)
}

/// `parseTime(x) || null` 的等价物：解析不出（得到 0）时给 None。
///
/// 单独一个函数是因为 Node 里这两种写法混用：`parseTime(x) || parseTime(y)`
/// 会跳过第一个解不出的，而 `parseTime(x) || 0` 会退化成 0。把「0 = 失败」
/// 显式化成 None 之后，Rust 侧的 `or_else` / `unwrap_or` 就能一一对应上去。
pub(super) fn time_or_null(value: Option<&Value>) -> Option<i64> {
    let text = match value {
        None | Some(Value::Null) => return None,
        Some(Value::Number(number)) => {
            let parsed = number.as_f64()? as i64;
            return if parsed == 0 { None } else { Some(parsed) };
        }
        Some(Value::String(text)) => text.trim().to_string(),
        Some(_) => return None,
    };
    if text.is_empty() {
        return None;
    }
    // `/^\d+$/` 的等价判断：全数字按时间戳读
    let parsed = if text.chars().all(|ch| ch.is_ascii_digit()) {
        text.parse::<i64>().ok()
    } else {
        parse_date_text(&text)
    };
    // 0 是「解不出」的哨兵值（与 parseTime 返回 0 等价）
    parsed.filter(|value| *value != 0)
}

/// 日期文本 → 毫秒时间戳，时区语义与 JS 的 `new Date(str)` 对齐（见 `parse_time`）。
///
/// 只覆盖上游真会给到的几种形态；认不出的一律 None（JS 会得到 NaN → 0）。
fn parse_date_text(text: &str) -> Option<i64> {
    use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone, Utc};

    // 带时区偏移：交给 chrono 直接按绝对时间解析（与 JS 一致）
    if let Ok(value) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(value.timestamp_millis());
    }
    // 仅日期：JS 规范规定按 **UTC** 解读（不是本地！）
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|value| value.and_utc().timestamp_millis());
    }
    // 无时区的日期时间：按**本地时区**解读（"YYYY-MM-DD HH:MM:SS" 与 ISO 的 T 形态）
    let naive = NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S"))
        .ok()?;
    // 本地时刻可能因夏令时不存在（春季跳变）或重复（秋季回落）：
    // 不存在时退化为 UTC 解读（宁可偏一点，也不要整条链路上报错）
    Local
        .from_local_datetime(&naive)
        .single()
        .map(|value| value.timestamp_millis())
        .or_else(|| Some(Utc.from_utc_datetime(&naive).timestamp_millis()))
}

/// 时间戳 → JSON（None → null；整数形态）
pub(super) fn timestamp_json(value: Option<i64>) -> Value {
    value.map(Value::from).unwrap_or(Value::Null)
}

/// JS `String(Math.floor(n))` 的近似：整数输出整数形态，
/// 浮点（理论上是小数额度）保留一位小数 —— 上游额度是整数，
/// 这里只是不让 `0.0` 这种形态漏到界面上。
pub(super) fn js_int_string(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_string();
    }
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        let text = format!("{value}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// 签到结果归一化。上游字段随活动配置变化，这里做「宽进」处理：
/// 保留原始 data，同时尽力抽出常见字段供 UI 直接展示。
///
/// ── 一个容易踩的细节：undefined 的键要**整个丢掉** ──────────
/// Node 的 `pick(...)` 全都找不到时返回 `undefined`，而 `JSON.stringify`
/// 会丢掉值为 undefined 的键。所以真实响应里 `checkedIn` / `online` 在
/// 上游没这些字段时**根本不出现在 JSON 里**（而不是 null）。前端用
/// `'checkedIn' in result` 之类的判空会因此分叉，所以这里也只在该键有值时放进去。
///
/// 相反，`toInt(pick(...))` 那条路径返回的是 `null`
/// （`Number.isFinite(NaN)` 为假 → 显式 null），因此天数/积分这类**数值键
/// 永远存在**，值可能是 null。两种语义不能混。
pub(super) fn normalize_checkin(data: &Value) -> Value {
    if !data.is_object() {
        return data.clone();
    }
    // `pick(...)` 的等价物：按候选键名取第一个**存在且非 null** 的值
    let pick = |keys: &[&str]| -> Option<Value> {
        for key in keys {
            if let Some(value) = data.get(*key) {
                if !value.is_null() {
                    return Some(value.clone());
                }
            }
        }
        None
    };
    // `toInt(pick(...))`：解不出时是 null（键仍然存在）
    let int_of = |keys: &[&str]| -> Value {
        pick(keys)
            .and_then(|value| to_int(&value))
            .map(Value::from)
            .unwrap_or(Value::Null)
    };

    let mut result = Map::new();
    // 今日是否已签到（pick 失败 → 不出键）
    if let Some(value) = pick(&[
        "checked_in",
        "checkedIn",
        "is_checked_in",
        "isCheckedIn",
        "signed",
        "is_signed",
    ]) {
        result.insert("checkedIn".to_string(), value);
    }
    // 连续签到天数（toInt 失败 → null，键保留）
    result.insert(
        "continuousDays".to_string(),
        int_of(&[
            "continuous_days",
            "continuousDays",
            "continuous_checkin_days",
            "streak",
            "serial_days",
        ]),
    );
    // 累计签到天数
    result.insert(
        "totalDays".to_string(),
        int_of(&["total_days", "totalDays", "total_checkin_days", "accumulate_days"]),
    );
    // 本次/今日可领积分
    result.insert(
        "points".to_string(),
        int_of(&["points", "credit", "reward_points", "rewardPoints", "daily_points"]),
    );
    // 活动周期 / 活动是否在线：同 checkedIn，取不到就不出键
    if let Some(value) = pick(&["start_time", "startTime"]) {
        result.insert("startTime".to_string(), value);
    }
    if let Some(value) = pick(&["end_time", "endTime"]) {
        result.insert("endTime".to_string(), value);
    }
    if let Some(value) = pick(&["activity_online_status", "activityOnlineStatus", "online"]) {
        result.insert("online".to_string(), value);
    }
    result.insert("raw".to_string(), data.clone());
    Value::Object(result)
}

// ─── 原始请求（growth 域 / 指纹上报专用）────────────────────

/// `raw_json_call` 的返回：与 BillingCall 的差别是**保留 HTTP 状态码** ——
/// growth 域有几个「非 2xx 属预期」的分支（claim 400 → web 降级、streak 兑换
/// 未解锁 403、buddy/first 门槛未过 400），调用方要按状态码与 msg 分派。
pub(super) struct RawCall {
    /// HTTP 状态码：claim 降级/门槛未过按 status 分派的**预留诊断位** —— 当前
    /// 调用方以 msg 文案为准（幂等/门槛类上游以文案表达更稳定），状态码保留
    /// 在结构体里供统一诊断，不做逐调用方 allow。
    #[allow(dead_code)]
    pub(super) status: u16,
    /// 上游业务码（信封 code）；多数调用方只用 status/msg 分派，保留是为
    /// 「非 2xx 且信封里带码」的分支（如 claim-gift 的幂等码）诊断时免二次抓包。
    #[allow(dead_code)]
    pub(super) code: Option<i64>,
    /// 上游 msg 原文：幂等类分支（已领取/已领过）按文案翻成中性结果的依据，
    /// 部分调用方未读属正常 —— 留作统一诊断通道，不做逐字段 allow。
    #[allow(dead_code)]
    pub(super) msg: Option<String>,
    pub(super) data: Value,
}

/// mpPlatform 小程序口径头值（refs tasks.go:35）：mp 专属任务的列表下发、
/// accept、claim 全链路要求 `X-Client-Platform: miniprogram`。
pub(super) const MP_PLATFORM: &str = "miniprogram";

/// client_token 幂等令牌（refs streak.go:27-33：16 随机字节 → 8-4-4-4-12 hex，
/// 前端 randomUUID 同款语义）。连登兑换/抽奖与 mp 判据事件共用。
pub(super) fn client_token() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        // 随机源不可用时退化到时间戳熵（令牌只要求「每次调用不同」即可）
        let now = crate::server::logging::now_ms().to_le_bytes();
        bytes[..8].copy_from_slice(&now);
    }
    let hex = |slice: &[u8]| -> String {
        slice.iter().map(|byte| format!("{byte:02x}")).collect()
    };
    format!(
        "{}-{}-{}-{}-{}",
        hex(&bytes[0..4]),
        hex(&bytes[4..6]),
        hex(&bytes[6..8]),
        hex(&bytes[8..10]),
        hex(&bytes[10..16])
    )
}

/// growth 域调用经 `call_billing` 时要**追加**的头（BillingHeaders 与面板
/// 既有 build_headers 的差集）：
///   - `X-CodeBuddy-Request: 1`（refs headers.go:380，官方客户端风控闸门头）
///   - `Accept-Language: zh-CN`（refs headers.go:382，growth 域只服务国内账号）
///   - `User-Agent: WorkBuddy/<版本>`（refs billingUA，headers.go:85-93）
///   - mp 口径再叠加 `X-Client-Platform: miniprogram`（refs tasks.go:100）
pub(super) fn growth_extra(session: &Value, mp: bool) -> Vec<(String, String)> {
    let mut extra = vec![
        ("X-CodeBuddy-Request".to_string(), "1".to_string()),
        ("Accept-Language".to_string(), "zh-CN".to_string()),
        ("User-Agent".to_string(), billing_user_agent(session)),
    ];
    if mp {
        extra.push(("X-Client-Platform".to_string(), MP_PLATFORM.to_string()));
    }
    extra
}

/// growth 域**原始请求**（不走 call_billing）的头集合：build_headers 之上
/// 叠加 growth_extra。供领奖与指纹上报组装自己的头时打底。
pub(super) fn growth_headers(
    session: &Value,
    extra: &[(String, String)],
) -> Vec<(String, String)> {
    let mut appended = growth_extra(session, false);
    appended.extend(extra.iter().cloned());
    build_headers(session, &appended)
}

/// billingUA 的等价物（refs headers.go:85-93）：单段 `WorkBuddy/<版本>`，
/// 版本号按账号 edition 取（国内 5.5.4）。
pub(super) fn billing_user_agent(session: &Value) -> String {
    let edition = session.get("edition").and_then(Value::as_str);
    format!("WorkBuddy/{}", resolve_edition(edition).client_version)
}

/// 发一次**不走 call_billing 信封纪律**的原始请求并解统一信封。
///
/// 出口与 call_billing 完全一致（session.proxy → send_raw → 20s 超时），差别只在
/// **失败语义**：call_billing 把 401/403 一律折成 401「登录态过期」——对存量
/// 计费路径那是正确契约，对 growth 域的「403 未解锁 / 400 门槛未过 / claim 400
/// 降级」这些预期分支则会丢状态码与上游 msg。这里逐条对齐 refs doJSON
/// （client.go:859-888）：非 2xx → 带状态码与 body 片段的错误；code != 0 →
/// 带上游 msg 的错误；成功 → 解出 data。
///
/// 供领奖（claim 的 mp→web 降级要认 400）与四指纹上报（desktop/web/mp 的头
/// 集合在 build_headers 的模型之外）使用。
pub(super) async fn raw_json_call(
    method: &str,
    url: &str,
    body: Option<&Value>,
    headers: &[(String, String)],
    proxy: Option<&ResolvedProxy>,
) -> Result<RawCall, super::BillingError> {
    use crate::server::core::auth_http::send_raw;

    let response = send_raw(method, url, body, headers, proxy, Some(super::REQUEST_TIMEOUT_MS))
        .await
        .map_err(|error| {
            if error.is_timeout() {
                super::BillingError::new("计费接口请求超时", 504)
            } else {
                super::BillingError::new(format!("计费接口请求失败: {error}"), 502)
            }
        })?;

    let payload = response.payload.clone();
    let code = payload
        .as_ref()
        .and_then(|value| value.get("code"))
        .and_then(Value::as_i64);
    // 与 call_billing 同口径：空串当「没有」
    let msg = payload
        .as_ref()
        .and_then(|value| {
            value
                .get("msg")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .or_else(|| {
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                })
        })
        .map(str::to_string);

    if response.status == 401 {
        return Err(super::BillingError::with_code(
            "登录态已过期或被拒绝，无法调用计费接口",
            401,
            code,
        ));
    }
    if !response.ok {
        // refs doJSON 的错误形态：HTTP 状态 + body 片段（client.go:874 把原始
        // body 截 200 字符塞进 Msg）——上游 msg 优先，缺失时退回 body 片段，
        // 保证「first_buddy task not completed yet」这类关键词判据在
        // 非 msg 字段里也能命中
        let body_snippet = payload.as_ref().map(|value| {
            let text = value.to_string();
            let cut = text.len().min(200);
            text.get(..cut).map(str::to_string).unwrap_or(text)
        });
        let detail = msg
            .clone()
            .or(body_snippet)
            .unwrap_or_default();
        let message = if detail.is_empty() {
            format!("计费接口返回 HTTP {}", response.status)
        } else {
            format!("计费接口返回 HTTP {}: {detail}", response.status)
        };
        return Err(super::BillingError::with_code(
            message,
            response.status as i32,
            code,
        ));
    }
    if let Some(code_value) = code {
        if code_value != RESPONSE_CODE_OK {
            let message = msg
                .clone()
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| format!("计费接口返回 code={code_value}"));
            return Err(super::BillingError::with_code(
                message,
                response.status as i32,
                Some(code_value),
            ));
        }
    }
    let data = payload
        .as_ref()
        .and_then(|value| value.get("data"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(RawCall { status: response.status, code, msg, data })
}
