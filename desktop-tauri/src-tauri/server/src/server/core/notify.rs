//! 多渠道通知（Webhook / Telegram / 钉钉 / 飞书 / 企业微信 / Bark / …）与
//! **账号异常告警**的公共入口。
//!
//! ── 渠道配置存哪、长什么样 ──────────────────────────────────
//! 配置库（kv）里配置顶层键 `notifyChannels`：一个 JSON 数组，每条
//! `{id, name, type, enabled, config}` —— `config` 是**整段 JSON**，字段集
//! 随 `type` 走（前端按类型出表单；各类型的字段清单见下方每个 provider
//! 函数的注释，`api::notify_api` 的 GET 会原样带出）。存配置顶层键而不是
//! 保留键：它与 `autoCheckin` / `modelRules` 同类 —— 是「用户在界面上配的
//! 设置」，走 `config::update_raw_field` 读写，重启后随配置快照自然回来，
//! 也不需要在 `db::schema::RESERVED_KV_KEYS` 里另立门户。
//!
//! ── 分发模型：一次事件 → 并发打全部启用渠道 ──────────────────
//! [`dispatch`] 把消息**同时**发给所有启用渠道（`tokio::task::JoinSet` 并发
//! spawn）：一条渠道挂了 / 慢了不该拖住别的渠道，更不该拖住调用方 ——
//! dispatch 本身立刻返回，发送全部在后台任务里做；每个渠道各自记成功 /
//! 失败日志（`[Notify]`），失败只记日志、绝不向上抛。渠道的失败概率天然
//! 偏高（webhook 地址是用户手填的），通知系统自己的故障不允许传染主链路。
//!
//! ── 发送器：进程级共享一个 reqwest Client（10 秒总超时）──────
//! 全部渠道都是出站 HTTP，共用一个带 10 秒超时的 Client（连接池顺带复用）。
//! **不关系统代理探测**（与 `core::egress` 的直连 Client 相反）：通知要发的
//! Telegram / Discord / ntfy 在部分网络下直连不可达，环境变量代理（HTTPS_PROXY）
//! 对它们是救命的而不是干扰的 —— 这是有意差异，不要「顺手对齐」。
//!
//! ── 每种 type 一个发送实现 ─────────────────────────────────
//! 照 Uptime-Kuma 的 notification-providers 体系：每个 provider 一个独立
//! async 函数，入参统一 `(config: &Value, title: &str, body: &str)`，返回
//! `Result<(), String>`（错误文案直接可读、可进日志与测试按钮的结果面板）。
//! 未识别的 `type` 在分发处记日志跳过（[`is_known_kind`] 是唯一白名单）。
//! config 字段的读取一律宽容（缺失 = 空串），**必填缺失在发送时报错**而不是
//! 在保存时拦截 —— 保存侧只校验「type 认不认识、config 是不是对象」，让
//! 「测试」按钮成为校验入口（错误文案能直接看到差什么）。
//!
//! ── 告警（账号异常事件的入口）────────────────────────────────
//! [`notify_account_event`] 是给「账号出事」的各埋点调用的公共函数：按
//! `notifyAlerts` 配置里的事件开关过滤、静默时段（quietStart/quietEnd，本地
//! 时区 HH:mm）内只记日志不发送，其余走 [`dispatch`]。事件源（429 降级、
//! 账号掉线、探活自动禁用）分散在各自模块里，本模块不回头 import 它们。

use std::time::Duration;

use chrono::Timelike;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::Sha256;

use crate::server::config;
use crate::server::logging;

/// 配置库（kv）里的键名：渠道列表（配置顶层键，见模块头）
pub const KEY_CHANNELS: &str = "notifyChannels";
/// 配置库（kv）里的键名：告警开关与静默时段
pub const KEY_ALERTS: &str = "notifyAlerts";

// ── 渠道类型常量（既有 16 种的 `type` 取值）──────────────────────
// 后续按 Uptime-Kuma notification-providers 全量移植的渠道不再逐个立常量，
// type 名直接以小写字面量列在 [`KNOWN_KINDS`] 里、与 [`send_channel`] 的
// match 分支一一对应（命名规则：provider 文件名去连字符转小写）。
pub const KIND_WEBHOOK: &str = "webhook";
pub const KIND_WEBHOOK_CUSTOM: &str = "webhook-custom";
pub const KIND_TELEGRAM: &str = "telegram";
pub const KIND_DISCORD: &str = "discord";
pub const KIND_SLACK: &str = "slack";
pub const KIND_DINGTALK: &str = "dingtalk";
pub const KIND_FEISHU: &str = "feishu";
pub const KIND_WECOM: &str = "wecom";
pub const KIND_BARK: &str = "bark";
pub const KIND_GOTIFY: &str = "gotify";
pub const KIND_PUSHOVER: &str = "pushover";
pub const KIND_PUSHBULLET: &str = "pushbullet";
pub const KIND_NTFY: &str = "ntfy";
pub const KIND_TEAMS: &str = "teams";
pub const KIND_SERVERCHAN: &str = "serverchan";
pub const KIND_LINE: &str = "line";

/// 全部认识的渠道类型（未在表中的 `type`：分发时记日志跳过、保存时 400）。
/// 前 16 项对应上方常量；其余为 Uptime-Kuma notification-providers 的全量
/// 移植（跳过 webpush / apprise / smtp / nostr / aliyun-sms，原因见各自
/// 实现区段头部的注释）。
pub const KNOWN_KINDS: &[&str] = &[
    KIND_WEBHOOK,
    KIND_WEBHOOK_CUSTOM,
    KIND_TELEGRAM,
    KIND_DISCORD,
    KIND_SLACK,
    KIND_DINGTALK,
    KIND_FEISHU,
    KIND_WECOM,
    KIND_BARK,
    KIND_GOTIFY,
    KIND_PUSHOVER,
    KIND_PUSHBULLET,
    KIND_NTFY,
    KIND_TEAMS,
    KIND_SERVERCHAN,
    KIND_LINE,
    // ── Uptime-Kuma 全量移植（与 send_channel 的 match 分支一一对应）──
    "360messenger",
    "46elks",
    "alerta",
    "alertnow",
    "amootsms",
    "bale",
    "bearsms",
    "bitrix24",
    "brevo",
    "callmebot",
    "cellsynt",
    "clicksendsms",
    "clickup",
    "egosms",
    "evolution",
    "flashduty",
    "flowtriq",
    "fluxer",
    "freemobile",
    "goalert",
    "googlechat",
    "googlesheets",
    "gorush",
    "grafanaoncall",
    "gtxmessaging",
    "halopsa",
    "heiioncall",
    "homeassistant",
    "indigo",
    "jirasm",
    "keep",
    "kook",
    "lunasea",
    "matrix",
    "mattermost",
    "max",
    "milky",
    "nextcloudtalk",
    "notifery",
    "notifyapp",
    "octopush",
    "onebot",
    "onechat",
    "onesender",
    "ooredoo",
    "openwa",
    "opsgenie",
    "pagerduty",
    "pagertree",
    "pinglet",
    "plivo",
    "promosms",
    "pumble",
    "pushdeer",
    "pushplus",
    "pushy",
    "resend",
    "rocketchat",
    "sendgrid",
    "serwersms",
    "sevenio",
    "signal",
    "signalgrid",
    "signl4",
    "smsgateway",
    "smsir",
    "smsmanager",
    "smspartner",
    "smsplanet",
    "smsc",
    "smseagle",
    "splunk",
    "spugpush",
    "squadcast",
    "stackfield",
    "techuluspush",
    "telnyx",
    "teltonika",
    "threema",
    "turbosmtp",
    "twilio",
    "vk",
    "vkteams",
    "waha",
    "whapi",
    "wpush",
    "wxpusher",
    "yzj",
    "zohocliq",
];

// ── 账号告警的事件种类（`notify_account_event` 的 `kind` 取值）────────
/// 429 降级事件（内容拦截降级 / 上游限流触发降级）
pub const EVENT_DEGRADE: &str = "degrade";
/// 账号掉线 / 转发失败（凭证失效、上游持续报错等）
pub const EVENT_ACCOUNT_OFFLINE: &str = "account_offline";
/// 探活 / 自动维护把账号停用
pub const EVENT_HEALTH_DISABLED: &str = "health_disabled";

/// 渠道数量上限：本地面板的通知渠道没有理由超过这个数（防误导入巨表）
pub const MAX_CHANNELS: usize = 32;
/// url / 文案的长度上限（防误填超长串把 kv 行撑大）
const MAX_URL_LENGTH: usize = 2048;

/// 一条通知渠道（存储形态见模块头）
#[derive(Clone, Debug)]
pub struct NotifyChannel {
    pub id: String,
    pub name: String,
    /// 渠道类型（`KNOWN_KINDS` 之一；存储里的小写归一形态）
    pub kind: String,
    pub enabled: bool,
    /// 类型自定义的整段配置 JSON（各类型字段清单见 provider 函数注释）
    pub config: Value,
}

impl NotifyChannel {
    /// 日志与测试结果里显示的名字（没起名就回落到类型）
    pub fn label(&self) -> String {
        if self.name.is_empty() {
            self.kind.clone()
        } else {
            self.name.clone()
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "type": self.kind,
            "enabled": self.enabled,
            "config": self.config,
        })
    }

    /// 管理接口的输出形态（与存储同形；`config` 原样带出 —— 字段集随 type
    /// 走，前端按类型出表单，后端不逐字段翻译）
    pub fn public_json(&self) -> Value {
        self.to_json()
    }

    /// 从存储的一条 JSON 解析（宽容：缺字段给默认值）。
    ///
    /// `id` 缺失时丢弃该条：id 是渠道的身份（测试单渠道 / 编辑都按它找），
    /// 没有 id 的条目只可能来自手工改坏的配置 —— 保存路径永远会补 id
    /// （见 [`normalize_channel`]），所以这个分支实际不可达，留着是防御。
    fn from_value(value: &Value) -> Option<Self> {
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string)?;
        Some(Self {
            id,
            name: value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            kind: value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_lowercase(),
            enabled: !matches!(value.get("enabled"), Some(Value::Bool(false))),
            config: value.get("config").cloned().unwrap_or(Value::Null),
        })
    }
}

/// 当前全部渠道（按存储顺序）
pub fn channels() -> Vec<NotifyChannel> {
    let snapshot = config::current();
    let Some(Value::Array(items)) = snapshot.raw().get(KEY_CHANNELS) else {
        return Vec::new();
    };
    items.iter().filter_map(NotifyChannel::from_value).collect()
}

/// 整份保存渠道列表（`config::update_raw_field` 写配置顶层键，见模块头）
pub fn save_channels(channels: &[NotifyChannel]) -> bool {
    let list: Vec<Value> = channels.iter().map(NotifyChannel::to_json).collect();
    config::update_raw_field(KEY_CHANNELS, Value::Array(list))
}

/// 是否认识的渠道类型（唯一白名单；分发跳过与保存校验都用它）
pub fn is_known_kind(kind: &str) -> bool {
    KNOWN_KINDS.contains(&kind)
}

/// 随机生成渠道 id：`n` + 16 位十六进制（与 `api_keys::generate` 同一手法：
/// sha256(时间戳 + 进程 id + 序号)，本地工具的标识符，够防撞即可）
pub fn generate_id() -> String {
    use sha2::{Digest, Sha256};
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut hasher = Sha256::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(counter.to_le_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("n{hex}")
}

// ─── config 字段与文本的小工具（provider 共用）────────────────────

/// 读一个字符串字段（缺失 / 类型不对 / 空白 → 空串；`config` 为 null 也安全）
fn cfg_string(config: &Value, key: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

/// 依次尝试多个键名，取第一个非空的（兼容用户从各工具抄来的字段名）
fn cfg_first(config: &Value, keys: &[&str]) -> String {
    for key in keys {
        let value = cfg_string(config, key);
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

/// 读一个整数字段（缺失 / 类型不对 → `None`；整值浮点容忍）
fn cfg_int(config: &Value, key: &str) -> Option<i64> {
    config.get(key)?.as_i64().or_else(|| {
        config
            .get(key)?
            .as_f64()
            .filter(|raw| raw.is_finite() && raw.fract() == 0.0)
            .map(|raw| raw as i64)
    })
}

/// 必填字符串字段：按候选键取，全空则报可读错误
fn require_field(config: &Value, keys: &[&str], kind: &str, field: &str) -> Result<String, String> {
    let value = cfg_first(config, keys);
    if value.is_empty() {
        return Err(format!("{kind} 渠道缺少必填配置: {field}"));
    }
    Ok(value)
}

/// http(s) URL：校验 + 截断（错误文案里给用户可读的原因）
fn require_url(config: &Value, keys: &[&str], kind: &str, field: &str) -> Result<String, String> {
    let url = require_field(config, keys, kind, field)?;
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("{kind} 渠道的 {field} 必须以 http:// 或 https:// 开头"));
    }
    Ok(url.chars().take(MAX_URL_LENGTH).collect())
}

/// 标题 + 正文的合并文案（标题为空 / 正文为空时不再多出空行）
fn message_text(title: &str, body: &str) -> String {
    match (title.is_empty(), body.is_empty()) {
        (true, true) => String::new(),
        (false, true) => title.to_string(),
        (true, false) => body.to_string(),
        (false, false) => format!("{title}\n{body}"),
    }
}

/// 把文本转成「JSON 字符串引号内的安全内容」（不带首尾引号）：
/// webhook-custom 的模板替换用 —— 直接塞原文的话，标题里的引号 / 换行
/// 会把用户的 JSON 模板撑破
fn json_string_content(text: &str) -> String {
    let encoded = serde_json::to_string(text).unwrap_or_default();
    // to_string 的输出至少是 `""`（两个引号），这个切片只会在空串时短路
    if encoded.len() >= 2 {
        encoded[1..encoded.len() - 1].to_string()
    } else {
        encoded
    }
}

/// 最小百分号编码（RFC 3986 unreserved 之外全编码）：钉钉加签的 sign
/// 参数、以及将来任何要拼进 URL 的片段都用它（不为此引 url crate 的
/// percent-encoding，本函数二十行、语义自明）
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// HMAC-SHA256 → Base64（钉钉加签；hmac / sha2 / base64 都是既有依赖，
/// 用法与 `server::altcha` 的 hmac_hex 同源）
fn hmac_sha256_base64(secret: &str, message: &str) -> Result<String, String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|error| format!("钉钉加签密钥无效: {error}"))?;
    mac.update(message.as_bytes());
    Ok(base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes()))
}

// ─── Uptime-Kuma 全量移植共用的助手（下面的新 provider 用）────────

/// HMAC-SHA256 → 小写十六进制（Nextcloud Talk 机器人的签名头用）
fn hmac_sha256_hex(secret: &str, message: &str) -> Result<String, String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|error| format!("Nextcloud Talk 密钥无效: {error}"))?;
    mac.update(message.as_bytes());
    Ok(mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// 读一个「标量」字段：字符串去空白直接用；数字转十进制串 —— 群号 / 手机号 /
/// 模板 ID 这类字段用户在 JSON 配置里可能填成数字（与 [`cfg_string`] 的差别
/// 只在数字上；既有 16 种渠道继续走原助手，行为不变）
fn cfg_scalar(config: &Value, key: &str) -> String {
    match config.get(key) {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

/// 依次尝试多个键名取第一个非空标量（新 provider 版的 [`cfg_first`]）
fn cfg_first_scalar(config: &Value, keys: &[&str]) -> String {
    for key in keys {
        let value = cfg_scalar(config, key);
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

/// 必填标量字段：按候选键取，全空则报可读错误（新 provider 版的 [`require_field`]）
fn require_scalar(config: &Value, keys: &[&str], kind: &str, field: &str) -> Result<String, String> {
    let value = cfg_first_scalar(config, keys);
    if value.is_empty() {
        return Err(format!("{kind} 渠道缺少必填配置: {field}"));
    }
    Ok(value)
}

/// 从 JSON 对象里取一个字段的文本（字符串直接用，其它类型 JSON 序列化；
/// 缺失 / 类型不对 → 空串）—— 用于拼接远端返回的业务错误信息
fn json_text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .map(|item| match item {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

/// 去掉全部非 ASCII 字符：多家 SMS 网关只收 GSM-7 / ASCII 文本（照 Uptime-Kuma
/// 源码的 `msg.replace(/[^\x00-\x7F]/g, "")`）
fn ascii_only(text: &str) -> String {
    text.chars().filter(|character| character.is_ascii()).collect()
}

/// 按逗号 / 分号 / 空白拆出非空的收件人列表（多家 SMS / 群发渠道的收件人
/// 字段都是「分隔符串」，源码各自用正则拆，这里统一一份）
fn split_recipients(text: &str) -> Vec<String> {
    text.split([',', ';', ' ', '\t', '\r', '\n'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

/// 带前缀的凭证头（`Bearer x` / `Bot x` / `GenieKey x` / `Key x` …）。
/// 同 [`header_value`]：token 是用户手填的，非法字符先拦下，避免
/// `RequestBuilder::header` 对非法头值 panic
fn schemed_header(scheme: &str, token: &str) -> Option<reqwest::header::HeaderValue> {
    header_value(&format!("{scheme} {token}"))
}

/// 当前 UTC 时间的 RFC3339 字符串（HaloPSA / GoogleSheets 等要 ISO 时间戳）
fn iso_now() -> String {
    chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 德黑兰当前时间 `YYYY-MM-DD HH:MM:SS`（AmootSMS 接口按伊朗时间收
/// SendDateTime；伊朗自 2022 年取消夏令时，固定 +03:30）
fn tehran_now() -> String {
    match chrono::FixedOffset::east_opt(3 * 3600 + 30 * 60) {
        Some(offset) => chrono::Utc::now()
            .with_timezone(&offset)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string(),
        // 常数偏移不会失败，这里兜底成 UTC 只为不写 expect
        None => chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    }
}

/// 从用户填的 URL 里取 origin（`scheme://host[:port]`）—— Teltonika 的登录
/// 与发信端点都挂在 origin 下，用户多填的路径一律忽略
fn url_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{authority}"))
}

/// 一个伪随机的非负 int32（VK 的 random_id 防重放参数）：纳秒时钟取模
fn random_id_i32() -> i64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos() as i64 ^ (duration.as_secs() as i64).wrapping_mul(1_000_000_007))
        .unwrap_or(0);
    nanos.rem_euclid(2_147_483_647)
}

/// 追加一个查询参数到 URL（已有 `?` 用 `&` 否则用 `?`；值走百分号编码）。
/// 用于 CallMeBot 这类「端点已自带鉴权参数、只能往里追加」的渠道
fn with_query(url: &str, key: &str, value: &str) -> String {
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}{key}={}", percent_encode(value))
}

/// 发送并返回 2xx 响应正文（HTTP 层校验与 [`send`] 相同；响应体里带业务
/// 成败字段的渠道 —— SMS 网关普遍如此 —— 用它拿正文再做业务校验）
async fn send_and_read(request: reqwest::RequestBuilder) -> Result<String, String> {
    let response = request
        .send()
        .await
        .map_err(|error| format!("请求失败: {error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("远端返回 {status}: {}", truncate_text(&text, 200)));
    }
    Ok(text)
}

/// 解析响应 JSON（失败给 `None`，调用方按「业务校验失败」报错）
fn parse_json(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

/// 截断错误文案里的响应正文（远端 500 的 HTML 不该整页进日志）
fn truncate_text(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

/// 合法的 HTTP 头值（`HeaderValue::from_str` 失败 → `None`）。
///
/// ── 为什么必须过这一道 ─────────────────────────────────────
/// `RequestBuilder::header` / `bearer_auth` 对**非法头值是 panic**（本项目
/// release 是 panic=abort，等于带走整个网关），而 token 是用户手填的，
/// 填进个中文或空格完全可能 —— 所以所有「拿用户输入当请求头」的地方都先
/// 过这个函数，`None` 时给出可读的错误而不是发出去。
fn header_value(text: &str) -> Option<reqwest::header::HeaderValue> {
    reqwest::header::HeaderValue::from_str(text).ok()
}

/// `Authorization: Bearer <token>` 头值（同上，非法字符 → `None`）
fn bearer_header(token: &str) -> Option<reqwest::header::HeaderValue> {
    header_value(&format!("Bearer {token}"))
}

/// 进程级共享发送器（10 秒总超时；见模块头「不关系统代理探测」的理由）
fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("AIBuddy-Panel")
            .build()
            // 构造失败只可能是 TLS 后端初始化失败（与 egress 的兜底同判据）：
            // 没有别的退路，退到「请求时才报错」的裸 Client
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// 发送并校验 2xx；非 2xx 时带上（截断后的）响应正文，方便排障
async fn send(request: reqwest::RequestBuilder) -> Result<(), String> {
    let response = request
        .send()
        .await
        .map_err(|error| format!("请求失败: {error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("远端返回 {status}: {}", truncate_text(&text, 200)));
    }
    Ok(())
}

// ─── 各渠道的发送实现（每种 type 一个函数；字段清单写在各自注释里）──

/// **webhook** —— 通用 POST JSON。
/// config：`url`（必填）、`secret`（可选，随请求头 `X-Webhook-Secret` 透传）。
/// 请求体：`{"title": …, "body": …, "timestamp": 毫秒}`。
async fn send_webhook(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["url"], KIND_WEBHOOK, "url")?;
    let payload = json!({
        "title": title,
        "body": body,
        "timestamp": logging::now_ms(),
    });
    let mut request = http_client().post(&url).json(&payload);
    let secret = cfg_string(config, "secret");
    if !secret.is_empty() {
        // 头值不合法（如含非 ASCII）时静默省略：secret 本来就是可选的，
        // 一个填错的 secret 不该让整条通知发不出去
        if let Some(value) = header_value(&secret) {
            request = request.header("X-Webhook-Secret", value);
        }
    }
    send(request).await
}

/// **webhook-custom** —— 自定义 URL + 自定义 JSON 模板 + 自定义请求头。
/// config：`url`（必填）、`template`（JSON 字符串模板，支持 `{{title}}` /
/// `{{body}}` / `{{timestamp}}` 占位符；缺省
/// `{"title":"{{title}}","body":"{{body}}"}`）、`headers`（对象，键值对随请求头透传）。
/// 占位符替换时标题 / 正文会做 **JSON 转义**（`json_string_content`）——
/// 否则文案里的引号会撑破模板；替换后原样作为请求体发出。
async fn send_webhook_custom(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["url"], KIND_WEBHOOK_CUSTOM, "url")?;
    let template = {
        let given = cfg_string(config, "template");
        if given.is_empty() {
            r#"{"title":"{{title}}","body":"{{body}}"}"#.to_string()
        } else {
            given
        }
    };
    let payload = template
        .replace("{{title}}", &json_string_content(title))
        .replace("{{body}}", &json_string_content(body))
        .replace("{{timestamp}}", &logging::now_ms().to_string());
    let mut request = http_client()
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(payload);
    if let Some(headers) = config.get("headers").and_then(Value::as_object) {
        for (key, value) in headers {
            let Some(value) = value.as_str() else { continue };
            // 头名 / 头值不合法（非 token 字符、非 ASCII）就跳过这一对：
            // 自定义头是增强项，不值得为它让整条通知失败
            if let (Ok(name), Ok(value)) = (
                reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                reqwest::header::HeaderValue::from_str(value),
            ) {
                request = request.header(name, value);
            }
        }
    }
    send(request).await
}

/// **telegram** —— Bot API sendMessage。
/// config：`token`（必填，Bot Token）、`chatId`（必填，字符串或数字都收 ——
/// 群组 id 是负数）、`silent`（可选布尔，静默通知）。
async fn send_telegram(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let token = require_field(config, &["token", "botToken"], KIND_TELEGRAM, "token")?;
    let chat_id = config
        .get("chatId")
        .cloned()
        .filter(|value| !value.is_null())
        .filter(|value| value.as_str().map(|text| !text.trim().is_empty()).unwrap_or(true))
        .ok_or_else(|| format!("{} 渠道缺少必填配置: chatId", KIND_TELEGRAM))?;
    let mut payload = json!({
        "chat_id": chat_id,
        "text": message_text(title, body),
        "disable_web_page_preview": true,
    });
    if let Some(map) = payload.as_object_mut() {
        if config.get("silent").and_then(Value::as_bool).unwrap_or(false) {
            map.insert("disable_notification".to_string(), Value::Bool(true));
        }
    }
    send(
        http_client()
            .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
            .json(&payload),
    )
    .await
}

/// **bale** —— Bale Bot API（bale.ai；对照 Uptime-Kuma bale.js 逐字段移植：
/// 端点 `https://tapi.bale.ai/bot{token}/sendMessage`，请求体只有
/// `chat_id` / `text` 两键 —— Telegram 的扩展字段这里不发）。
/// config：`baleBotToken`（必填）、`baleChatID`（必填，字符串或数字都收）。
async fn send_bale(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let token = require_field(config, &["baleBotToken"], "bale", "baleBotToken")?;
    let chat_id = config
        .get("baleChatID")
        .cloned()
        .filter(|value| !value.is_null())
        .filter(|value| value.as_str().map(|text| !text.trim().is_empty()).unwrap_or(true))
        .ok_or_else(|| "bale 渠道缺少必填配置: baleChatID".to_string())?;
    let payload = json!({
        "chat_id": chat_id,
        "text": message_text(title, body),
    });
    send(
        http_client()
            .post(format!("https://tapi.bale.ai/bot{token}/sendMessage"))
            .json(&payload),
    )
    .await
}

/// **discord** —— Discord Webhook。
/// config：`url`（必填，频道 Webhook 地址）。请求体 `{"content": 标题+正文}`。
async fn send_discord(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["url"], KIND_DISCORD, "url")?;
    let payload = json!({ "content": message_text(title, body) });
    send(http_client().post(&url).json(&payload)).await
}

/// **slack** —— Slack Incoming Webhook。
/// config：`url`（必填）。请求体 `{"text": 标题+正文}`。
async fn send_slack(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["url"], KIND_SLACK, "url")?;
    let payload = json!({ "text": message_text(title, body) });
    send(http_client().post(&url).json(&payload)).await
}

/// **dingtalk** —— 钉钉群机器人。
/// config：`accessToken`（必填，机器人 access_token；兼容键 `token`）、
/// `secret`（可选，**加签**密钥：`{毫秒时间戳}\n{secret}` 做 HMAC-SHA256，
/// Base64 + URL 编码后附在 `&timestamp=…&sign=…`，安全设置选「加签」时必填）。
async fn send_dingtalk(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let token = require_field(config, &["accessToken", "token"], KIND_DINGTALK, "accessToken")?;
    let mut url = format!("https://oapi.dingtalk.com/robot/send?access_token={token}");
    let secret = cfg_string(config, "secret");
    if !secret.is_empty() {
        let timestamp = logging::now_ms();
        let sign = hmac_sha256_base64(&secret, &format!("{timestamp}\n{secret}"))?;
        url.push_str(&format!(
            "&timestamp={timestamp}&sign={}",
            percent_encode(&sign)
        ));
    }
    let payload = json!({ "msgtype": "text", "text": { "content": message_text(title, body) } });
    send(http_client().post(&url).json(&payload)).await
}

/// **feishu** —— 飞书群机器人（自定义机器人 webhook）。
/// config：`url`（必填，形如 https://open.feishu.cn/open-apis/bot/v2/hook/…）。
async fn send_feishu(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["url"], KIND_FEISHU, "url")?;
    let payload = json!({ "msg_type": "text", "content": { "text": message_text(title, body) } });
    send(http_client().post(&url).json(&payload)).await
}

/// **wecom** —— 企业微信群机器人。
/// config：`url`（必填，形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…）。
async fn send_wecom(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["url"], KIND_WECOM, "url")?;
    let payload = json!({ "msgtype": "text", "text": { "content": message_text(title, body) } });
    send(http_client().post(&url).json(&payload)).await
}

/// **bark** —— iOS Bark 推送。
/// config：`key`（必填，设备 Key；兼容键 `deviceKey`）、`server`（可选，
/// 自建服务地址，默认 `https://api.day.app`；兼容键 `endpoint`）、
/// `sound` / `group`（可选，随请求透传）。
/// 走官方支持的 **POST JSON** 形态（`POST {server}/{key}`）而不是 GET 路径段：
/// 中文长文案塞 URL 会撞长度与编码的坑，POST 没有这些问题。
async fn send_bark(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let key = require_field(config, &["key", "deviceKey"], KIND_BARK, "key")?;
    let server = {
        let given = cfg_first(config, &["server", "endpoint"]);
        if given.is_empty() {
            "https://api.day.app".to_string()
        } else {
            given.trim_end_matches('/').to_string()
        }
    };
    let mut payload = json!({ "title": title, "body": body });
    if let Some(map) = payload.as_object_mut() {
        for field in ["sound", "group"] {
            let value = cfg_string(config, field);
            if !value.is_empty() {
                map.insert(field.to_string(), Value::String(value));
            }
        }
    }
    send(http_client().post(format!("{server}/{key}")).json(&payload)).await
}

/// **gotify** —— self-hosted Gotify。
/// config：`url`（必填，服务基地址，如 https://push.example.com）、
/// `token`（必填，应用 token）、`priority`（可选整数）。
/// token 走请求头 `X-Gotify-Key`（官方等价形态之一），消息发到 `{url}/message`。
async fn send_gotify(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let base = require_url(config, &["url"], KIND_GOTIFY, "url")?
        .trim_end_matches('/')
        .to_string();
    let token = require_field(config, &["token", "appToken"], KIND_GOTIFY, "token")?;
    let mut payload = json!({ "title": title, "message": body });
    if let Some(priority) = cfg_int(config, "priority") {
        if let Some(map) = payload.as_object_mut() {
            map.insert("priority".to_string(), Value::from(priority));
        }
    }
    let Some(key_header) = header_value(&token) else {
        return Err("gotify 渠道的 token 含非法字符".to_string());
    };
    send(
        http_client()
            .post(format!("{base}/message"))
            .header("X-Gotify-Key", key_header)
            .json(&payload),
    )
    .await
}

/// **pushover** —— Pushover（表单提交）。
/// config：`token`（必填，应用 token）、`user`（必填，用户 / 组 key）、
/// `priority`（可选整数）、`sound`（可选）。
async fn send_pushover(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let token = require_field(config, &["token", "appToken"], KIND_PUSHOVER, "token")?;
    let user = require_field(config, &["user", "userKey"], KIND_PUSHOVER, "user")?;
    let mut form = vec![
        ("token".to_string(), token),
        ("user".to_string(), user),
        ("title".to_string(), title.to_string()),
        ("message".to_string(), body.to_string()),
    ];
    if let Some(priority) = cfg_int(config, "priority") {
        form.push(("priority".to_string(), priority.to_string()));
    }
    let sound = cfg_string(config, "sound");
    if !sound.is_empty() {
        form.push(("sound".to_string(), sound));
    }
    send(
        http_client()
            .post("https://api.pushover.net/1/messages.json")
            .form(&form),
    )
    .await
}

/// **pushbullet** —— Pushbullet note 推送。
/// config：`token`（必填，Access Token）。请求体 `{"type":"note","title":…,"body":…}`，
/// token 随请求头 `Access-Token` 透传。
async fn send_pushbullet(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let token = require_field(config, &["token", "apiKey"], KIND_PUSHBULLET, "token")?;
    // token 是用户手填的，直接塞请求头会在非法字符上 panic（见 header_value
    // 的说明），先过这道闸
    let Some(access_token) = header_value(&token) else {
        return Err("pushbullet 渠道的 token 含非法字符".to_string());
    };
    let payload = json!({ "type": "note", "title": title, "body": body });
    send(
        http_client()
            .post("https://api.pushbullet.com/v2/pushes")
            .header("Access-Token", access_token)
            .json(&payload),
    )
    .await
}

/// **ntfy** —— self-hosted / 官方 ntfy。
/// config：`url`（必填，**含主题**，如 https://ntfy.sh/my-topic）、
/// `token`（可选，访问控制开启时的发布 token）、`priority`（可选 1-5）。
/// 主题从 url 路径取，发布走 **JSON 形态**（POST 到服务根）：标题是中文时
/// 塞 `Title` 请求头会被 HTTP 头的 ASCII 限制拒掉，JSON 形态没有这个坑。
async fn send_ntfy(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["url"], KIND_NTFY, "url")?;
    let (base, topic) = match url.strip_suffix('/') {
        Some(base) => (base.to_string(), String::new()),
        None => match url.rsplit_once('/') {
            // 最后一段非空 = 主题；基地址是它前面的部分
            Some((base, topic)) if !topic.is_empty() && !topic.contains('.') => {
                (base.to_string(), topic.to_string())
            }
            _ => (url.clone(), String::new()),
        },
    };
    if topic.is_empty() {
        return Err(format!("{KIND_NTFY} 渠道的 url 必须带上主题（如 https://ntfy.sh/my-topic）"));
    }
    let mut payload = json!({ "topic": topic, "title": title, "message": body });
    if let Some(priority) = cfg_int(config, "priority") {
        if let Some(map) = payload.as_object_mut() {
            map.insert("priority".to_string(), Value::from(priority));
        }
    }
    let mut request = http_client().post(&base).json(&payload);
    let token = cfg_string(config, "token");
    if !token.is_empty() {
        // 同 pushbullet：用户手填的 token 先过非法字符这道闸（bearer_auth
        // 对非法头值是 panic）
        let Some(bearer) = bearer_header(&token) else {
            return Err("ntfy 渠道的 token 含非法字符".to_string());
        };
        request = request.header(reqwest::header::AUTHORIZATION, bearer);
    }
    send(request).await
}

/// **teams** —— Microsoft Teams（Workflows / 连接器 Webhook，MessageCard）。
/// config：`url`（必填）。
async fn send_teams(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["url"], KIND_TEAMS, "url")?;
    let payload = json!({
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        "themeColor": "0076D7",
        "summary": title,
        "sections": [{ "activityTitle": title, "text": body }],
    });
    send(http_client().post(&url).json(&payload)).await
}

/// **serverchan** —— Server 酱（ServerChan）。
/// config：`key`（必填，SendKey，形如 SCT…）。表单 POST `{title, desp}`。
async fn send_serverchan(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let key = require_field(config, &["key", "sendKey"], KIND_SERVERCHAN, "key")?;
    let url = format!("https://sctapi.ftqq.com/{key}.send");
    let form = [
        ("title".to_string(), title.to_string()),
        ("desp".to_string(), body.to_string()),
    ];
    send(http_client().post(&url).form(&form)).await
}

/// **line** —— LINE Notify。
/// config：`token`（必填，Personal Access Token）。表单 POST `message`，
/// token 随 `Authorization: Bearer` 透传。
async fn send_line(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let token = require_field(config, &["token", "accessToken"], KIND_LINE, "token")?;
    // 同 pushbullet / ntfy：token 先过非法字符这道闸（bearer_auth 对非法头值
    // 是 panic）
    let Some(bearer) = bearer_header(&token) else {
        return Err("line 渠道的 token 含非法字符".to_string());
    };
    let form = [("message".to_string(), message_text(title, body))];
    send(
        http_client()
            .post("https://notify-api.line.me/api/notify")
            .header(reqwest::header::AUTHORIZATION, bearer)
            .form(&form),
    )
    .await
}

// ─── Uptime-Kuma notification-providers 全量移植 ─────────────────
// 逐个照 refs/uptime-kuma/server/notification-providers/*.js 的 HTTP 调用
// 方式移植（方法 / URL / 认证 / payload 字段名一致）；监视器相关的字段
// （monitorJSON / heartbeatJSON）在本面板没有对应物，统一用面板自己的
// 标题 / 正文填充或留空。以下 type 名 = provider 文件名去连字符转小写。

/// **360messenger** —— 360messenger WhatsApp。
/// config：`Whatsapp360messengerAuthToken`（必填）、`Whatsapp360messengerRecipient`
/// （收件人，逗号 / 分号分隔）、`Whatsapp360messengerGroupId` 或
/// `Whatsapp360messengerGroupIds`（群 ID，字符串 / 分隔串 / 数组都收）。
/// 两类至少配一个，都配就都发（照源码行为）。
async fn send_360messenger(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "360messenger";
    let token = require_field(config, &["Whatsapp360messengerAuthToken"], KIND, "Whatsapp360messengerAuthToken")?;
    let message = message_text(title, body);
    let Some(bearer) = bearer_header(&token) else {
        return Err("360messenger 渠道的 token 含非法字符".to_string());
    };
    let recipients = split_recipients(&cfg_string(config, "Whatsapp360messengerRecipient"));
    let group_ids: Vec<String> = match config
        .get("Whatsapp360messengerGroupIds")
        .or_else(|| config.get("Whatsapp360messengerGroupId"))
    {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
                Value::Object(map) => map
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string),
                _ => None,
            })
            .collect(),
        Some(Value::String(text)) => split_recipients(text),
        _ => Vec::new(),
    };
    if recipients.is_empty() && group_ids.is_empty() {
        return Err("360messenger 渠道缺少收件人或群 ID".to_string());
    }
    for recipient in &recipients {
        send(
            http_client()
                .post("https://api.360messenger.com/v2/sendMessage")
                .header(reqwest::header::AUTHORIZATION, bearer.clone())
                .json(&json!({ "phonenumber": recipient, "text": message })),
        )
        .await?;
    }
    for group_id in &group_ids {
        send(
            http_client()
                .post("https://api.360messenger.com/v2/sendGroup")
                .header(reqwest::header::AUTHORIZATION, bearer.clone())
                .json(&json!({ "groupId": group_id, "text": message })),
        )
        .await?;
    }
    Ok(())
}

/// **46elks** —— 46elks SMS（表单提交 + Basic 认证）。
/// config：`elksUsername` / `elksAuthToken`（必填）、`elksFromNumber` /
/// `elksToNumber`（必填）。
async fn send_46elks(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "46elks";
    let username = require_scalar(config, &["elksUsername"], KIND, "elksUsername")?;
    let token = require_scalar(config, &["elksAuthToken"], KIND, "elksAuthToken")?;
    let from = require_scalar(config, &["elksFromNumber"], KIND, "elksFromNumber")?;
    let to = require_scalar(config, &["elksToNumber"], KIND, "elksToNumber")?;
    let message = message_text(title, body);
    send(
        http_client()
            .post("https://api.46elks.com/a1/sms")
            .basic_auth(username, Some(token))
            .form(&[("from", from.as_str()), ("to", to.as_str()), ("message", message.as_str())]),
    )
    .await
}

/// **halopsa** —— Halo PSA webhook。
/// config：`halowebhookurl`（必填）、`haloUsername` / `haloPassword`
/// （可选，都填才带 Basic 认证）。
async fn send_halopsa(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["halowebhookurl"], "halopsa", "halowebhookurl")?;
    let payload = json!({
        "title": title,
        "status": "NOTIFICATION",
        "monitor": "No Monitor",
        "monitor_id": Value::Null,
        "message": body,
        "timestamp": iso_now(),
        "uptime_kuma_version": "unknown",
    });
    let mut request = http_client().post(&url).json(&payload);
    let username = cfg_string(config, "haloUsername");
    let password = cfg_string(config, "haloPassword");
    if !username.is_empty() && !password.is_empty() {
        request = request.basic_auth(username, Some(password));
    }
    send(request).await
}

/// **alerta** —— Alerta API（exceptionAlert 事件）。
/// config：`alertaApiEndpoint` / `alertaApiKey`（必填）、`alertaEnvironment`（可选）。
async fn send_alerta(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "alerta";
    let url = require_url(config, &["alertaApiEndpoint"], KIND, "alertaApiEndpoint")?;
    let key = require_field(config, &["alertaApiKey"], KIND, "alertaApiKey")?;
    let Some(key_header) = schemed_header("Key", &key) else {
        return Err("alerta 渠道的 apiKey 含非法字符".to_string());
    };
    let payload = json!({
        "environment": cfg_string(config, "alertaEnvironment"),
        "severity": "critical",
        "correlate": [],
        "service": ["UptimeKuma"],
        "value": "Timeout",
        "tags": ["uptimekuma"],
        "attributes": {},
        "origin": "aibuddy-panel",
        "type": "exceptionAlert",
        "event": "msg",
        "text": message_text(title, body),
        "group": "uptimekuma-msg",
        "resource": "Message",
    });
    send(
        http_client()
            .post(&url)
            .header(reqwest::header::AUTHORIZATION, key_header)
            .json(&payload),
    )
    .await
}

/// **alertnow** —— AlertNow webhook（事件固定为 open / ERROR）。
/// config：`alertNowWebhookURL`（必填）。
async fn send_alertnow(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["alertNowWebhookURL"], "alertnow", "alertNowWebhookURL")?;
    let date = chrono::Local::now().format("%Y%m%d").to_string();
    let payload = json!({
        "summary": message_text(title, body),
        "status": "open",
        "event_type": "ERROR",
        "event_id": format!("{date}_aibuddy"),
    });
    send(http_client().post(&url).json(&payload)).await
}

/// **amootsms** —— AmootSMS（伊朗）。
/// config：`amootApiToken` / `amootMobiles`（逗号分隔，必填）、
/// `amootUsePattern`（布尔：走模板）、`amootPatternCodeId`（模板 ID，模板必填）、
/// `amootUseOwnLine`（布尔：模板走自有线路）、`amootLineNumber`（非「模板且
/// 非自有线路」时必填）。
async fn send_amootsms(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "amootsms";
    let token = require_field(config, &["amootApiToken"], KIND, "amootApiToken")?;
    let mobiles = split_recipients(&cfg_string(config, "amootMobiles"));
    if mobiles.is_empty() {
        return Err("amootsms 渠道缺少收件手机号 (amootMobiles)".to_string());
    }
    let message = message_text(title, body);
    let use_pattern = config.get("amootUsePattern").and_then(Value::as_bool).unwrap_or(false);
    let use_own_line = config.get("amootUseOwnLine").and_then(Value::as_bool).unwrap_or(false);
    let line_number = cfg_string(config, "amootLineNumber");
    if (!use_pattern || use_own_line) && line_number.is_empty() {
        return Err("amootsms 渠道缺少线路号 (amootLineNumber)".to_string());
    }
    // 业务失败在响应体 Status 字段里，HTTP 仍可能 200
    let check_status = |text: &str| -> Result<(), String> {
        let Some(value) = parse_json(text) else {
            return Err("amootsms 返回了无法解析的响应".to_string());
        };
        match value.get("Status").and_then(Value::as_str) {
            Some(status) if status != "Success" => Err(format!("amootsms 发送失败: {status}")),
            None => Err("amootsms 返回了意外响应".to_string()),
            _ => Ok(()),
        }
    };
    if !use_pattern {
        let form = [
            ("SendDateTime", tehran_now()),
            ("SMSMessageText", message),
            ("LineNumber", line_number),
            ("Mobiles", mobiles.join(",")),
        ];
        let text = send_and_read(
            http_client()
                .post("https://portal.amootsms.com/rest/SendSimple")
                .header(reqwest::header::AUTHORIZATION, header_value(&token).ok_or_else(|| "amootsms 渠道的 token 含非法字符".to_string())?)
                .form(&form),
        )
        .await?;
        return check_status(&text);
    }
    let pattern_id = require_field(config, &["amootPatternCodeId"], KIND, "amootPatternCodeId")?;
    for mobile in &mobiles {
        let text = if use_own_line {
            // 自有线路走 JSON 接口，Bearer 认证
            let Some(bearer) = schemed_header("Bearer", &token) else {
                return Err("amootsms 渠道的 token 含非法字符".to_string());
            };
            send_and_read(
                http_client()
                    .post("https://portal.amootsms.com/rest/SendWithPatternOWN")
                    .header(reqwest::header::AUTHORIZATION, bearer)
                    .json(&json!({
                        "Token": token,
                        "LineNumber": line_number,
                        "Mobile": mobile,
                        "PatternCodeID": pattern_id.parse::<i64>().unwrap_or(0),
                        "PatternValues": message,
                    })),
            )
            .await?
        } else {
            send_and_read(
                http_client()
                    .post("https://portal.amootsms.com/rest/SendWithPattern")
                    .header(
                        reqwest::header::AUTHORIZATION,
                        header_value(&token).ok_or_else(|| "amootsms 渠道的 token 含非法字符".to_string())?,
                    )
                    .form(&[
                        ("Token", token.as_str()),
                        ("Mobile", mobile.as_str()),
                        ("PatternCodeID", pattern_id.as_str()),
                        ("PatternValues", message.as_str()),
                    ]),
            )
            .await?
        };
        check_status(&text)?;
    }
    Ok(())
}

/// **bearsms** —— BearSMS（GET 查询参数提交；HTTP 200 也可能业务失败）。
/// config：`bearsmsUsername` / `bearsmsHashKey` / `bearsmsPhoneNumber`（必填）、
/// `bearsmsSenderId`（可选）。
async fn send_bearsms(config: &Value, _title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "bearsms";
    let username = require_scalar(config, &["bearsmsUsername"], KIND, "bearsmsUsername")?;
    let hash = require_scalar(config, &["bearsmsHashKey"], KIND, "bearsmsHashKey")?;
    let to = require_scalar(config, &["bearsmsPhoneNumber"], KIND, "bearsmsPhoneNumber")?;
    let mut params: Vec<(&str, String)> = vec![
        ("app", "ws".to_string()),
        ("u", username),
        ("h", hash),
        ("op", "pv".to_string()),
        ("to", to),
        ("msg", body.to_string()),
    ];
    let sender = cfg_string(config, "bearsmsSenderId");
    if !sender.is_empty() {
        params.push(("from", sender));
    }
    // 非 GSM-7 文本（如希伯来文 / 中文）必须标记 unicode
    if !body.is_ascii() {
        params.push(("unicode", "1".to_string()));
    }
    let text = send_and_read(http_client().get("https://app.bearsms.com/index.php").query(&params)).await?;
    let Some(value) = parse_json(&text) else {
        return Err("bearsms 返回了无法解析的响应".to_string());
    };
    if value.get("status").and_then(Value::as_str) == Some("ERR") {
        return Err(format!("bearsms 发送失败: {}", json_text(&value, "error_string")));
    }
    let ok = value
        .get("data")
        .and_then(Value::as_array)
        .map(|items| items.iter().any(|item| item.get("status").and_then(Value::as_str) == Some("OK")))
        .unwrap_or(false);
    if !ok {
        return Err(format!("bearsms 发送失败: {}", truncate_text(&text, 200)));
    }
    Ok(())
}

/// **bitrix24** —— Bitrix24 入站 webhook（im.notify.system.add）。
/// config：`bitrix24WebhookURL`（必填）、`bitrix24UserID`（必填）。
async fn send_bitrix24(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "bitrix24";
    let base = require_url(config, &["bitrix24WebhookURL"], KIND, "bitrix24WebhookURL")?
        .trim_end_matches('/')
        .to_string();
    let user_id = require_scalar(config, &["bitrix24UserID"], KIND, "bitrix24UserID")?;
    send(
        http_client()
            .get(format!("{base}/im.notify.system.add.json"))
            .query(&[
                ("user_id", user_id.as_str()),
                ("message", title),
                ("ATTACH[COLOR]", "#67b518"),
                ("ATTACH[BLOCKS][0][MESSAGE]", body),
            ]),
    )
    .await
}

/// **brevo** —— Brevo（原 Sendinblue）事务邮件 API。
/// config：`brevoApiKey` / `brevoToEmail` / `brevoFromEmail`（必填）、
/// `brevoFromName` / `brevoSubject`（可选）、`brevoCcEmail` / `brevoBccEmail`
/// （可选，逗号分隔）。
async fn send_brevo(config: &Value, _title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "brevo";
    let key = require_field(config, &["brevoApiKey"], KIND, "brevoApiKey")?;
    let to = require_field(config, &["brevoToEmail"], KIND, "brevoToEmail")?;
    let from = require_field(config, &["brevoFromEmail"], KIND, "brevoFromEmail")?;
    let Some(api_key) = header_value(&key) else {
        return Err("brevo 渠道的 apiKey 含非法字符".to_string());
    };
    let from_name = {
        let given = cfg_string(config, "brevoFromName");
        if given.is_empty() { "AIBuddy Panel".to_string() } else { given }
    };
    let subject = {
        let given = cfg_string(config, "brevoSubject");
        if given.is_empty() { "AIBuddy Panel 通知".to_string() } else { given }
    };
    let html = format!(
        "<html><head></head><body><p>{}</p></body></html>",
        body.replace('\n', "<br>")
    );
    let mut payload = json!({
        "sender": { "email": from, "name": from_name },
        "to": [{ "email": to }],
        "subject": subject,
        "htmlContent": html,
    });
    if let Some(map) = payload.as_object_mut() {
        let cc: Vec<Value> = split_recipients(&cfg_string(config, "brevoCcEmail"))
            .iter()
            .map(|email| json!({ "email": email }))
            .collect();
        let bcc: Vec<Value> = split_recipients(&cfg_string(config, "brevoBccEmail"))
            .iter()
            .map(|email| json!({ "email": email }))
            .collect();
        if !cc.is_empty() {
            map.insert("cc".to_string(), Value::Array(cc));
        }
        if !bcc.is_empty() {
            map.insert("bcc".to_string(), Value::Array(bcc));
        }
    }
    send(
        http_client()
            .post("https://api.brevo.com/v3/smtp/email")
            .header("api-key", api_key)
            .json(&payload),
    )
    .await
}

/// **callmebot** —— CallMeBot（GET，端点自带鉴权参数，text 往里追加）。
/// config：`callMeBotEndpoint`（必填）。
async fn send_callmebot(config: &Value, _title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["callMeBotEndpoint"], "callmebot", "callMeBotEndpoint")?;
    send(http_client().get(with_query(&url, "text", body))).await
}

/// **cellsynt** —— Cellsynt SMS（查询参数提交的 POST；文本只留 ASCII）。
/// config：`cellsyntLogin` / `cellsyntPassword` / `cellsyntDestination`（必填）、
/// `cellsyntOriginatortype` / `cellsyntOriginator`（必填）、
/// `cellsyntAllowLongSMS`（可选布尔）。
async fn send_cellsynt(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "cellsynt";
    let login = require_scalar(config, &["cellsyntLogin"], KIND, "cellsyntLogin")?;
    let password = require_scalar(config, &["cellsyntPassword"], KIND, "cellsyntPassword")?;
    let destination = require_scalar(config, &["cellsyntDestination"], KIND, "cellsyntDestination")?;
    let originatortype = require_scalar(config, &["cellsyntOriginatortype"], KIND, "cellsyntOriginatortype")?;
    let originator = require_scalar(config, &["cellsyntOriginator"], KIND, "cellsyntOriginator")?;
    let allowconcat = if config.get("cellsyntAllowLongSMS").and_then(Value::as_bool).unwrap_or(false) {
        "6"
    } else {
        "1"
    };
    let message = ascii_only(&message_text(title, body));
    let params = [
        ("username", login.as_str()),
        ("password", password.as_str()),
        ("destination", destination.as_str()),
        ("text", message.as_str()),
        ("originatortype", originatortype.as_str()),
        ("originator", originator.as_str()),
        ("allowconcat", allowconcat),
    ];
    let text = send_and_read(
        http_client()
            .post("https://se-1.cellsynt.net/sms.php")
            .query(&params),
    )
    .await?;
    // 出错时响应正文形如 "Error: 具体原因"，2xx 不代表成功
    if text.contains("Error:") {
        return Err(format!(
            "cellsynt 发送失败: {}",
            truncate_text(text.replace("Error:", "").trim(), 200)
        ));
    }
    Ok(())
}

/// **clicksendsms** —— ClickSend SMS（Basic 认证；业务结果在响应体里）。
/// config：`clicksendsmsLogin` / `clicksendsmsPassword` / `clicksendsmsToNumber`
/// （必填）、`clicksendsmsSenderName`（可选）。
async fn send_clicksendsms(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "clicksendsms";
    let login = require_scalar(config, &["clicksendsmsLogin"], KIND, "clicksendsmsLogin")?;
    let password = require_scalar(config, &["clicksendsmsPassword"], KIND, "clicksendsmsPassword")?;
    let to = require_scalar(config, &["clicksendsmsToNumber"], KIND, "clicksendsmsToNumber")?;
    let message = ascii_only(&message_text(title, body));
    let payload = json!({
        "messages": [{
            "body": message,
            "to": to,
            "source": "aibuddy-panel",
            "from": cfg_string(config, "clicksendsmsSenderName"),
        }],
    });
    let text = send_and_read(
        http_client()
            .post("https://rest.clicksend.com/v3/sms/send")
            .basic_auth(login, Some(password))
            .json(&payload),
    )
    .await?;
    let ok = parse_json(&text)
        .and_then(|value| {
            value
                .get("data")
                .and_then(|data| data.get("messages"))
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("status"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .map(|status| status == "SUCCESS")
        .unwrap_or(false);
    if !ok {
        return Err(format!("clicksendsms 发送失败: {}", truncate_text(&text, 200)));
    }
    Ok(())
}

/// **clickup** —— ClickUp 聊天频道消息（v3 API）。
/// config：`clickupToken`（必填）、`clickupWorkspaceId` / `clickupChannelId`（必填）。
async fn send_clickup(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "clickup";
    let token = require_field(config, &["clickupToken"], KIND, "clickupToken")?;
    let workspace = require_scalar(config, &["clickupWorkspaceId"], KIND, "clickupWorkspaceId")?;
    let channel = require_scalar(config, &["clickupChannelId"], KIND, "clickupChannelId")?;
    let Some(auth) = header_value(&token) else {
        return Err("clickup 渠道的 token 含非法字符".to_string());
    };
    let payload = json!({
        "type": "message",
        "content": message_text(title, body),
        "content_format": "text/md",
    });
    send(
        http_client()
            .post(format!(
                "https://api.clickup.com/api/v3/workspaces/{}/chat/channels/{}/messages",
                percent_encode(&workspace),
                percent_encode(&channel)
            ))
            .header(reqwest::header::AUTHORIZATION, auth)
            .json(&payload),
    )
    .await
}

/// **egosms** —— EgoSMS（乌干达，GET 查询参数提交）。
/// config：`egosmsPhoneNumber` / `egosmsUsername` / `egosmsPassword`（必填）、
/// `egosmsSender`（可选，默认 EGOSMS）。
async fn send_egosms(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "egosms";
    let number = require_scalar(config, &["egosmsPhoneNumber"], KIND, "egosmsPhoneNumber")?;
    let username = require_scalar(config, &["egosmsUsername"], KIND, "egosmsUsername")?;
    let password = require_scalar(config, &["egosmsPassword"], KIND, "egosmsPassword")?;
    let sender = {
        let given = cfg_string(config, "egosmsSender");
        if given.is_empty() { "EGOSMS".to_string() } else { given }
    };
    let message = message_text(title, body);
    send(
        http_client()
            .get("https://www.egosms.co/api/v1/plain/")
            .query(&[
                ("number", number.as_str()),
                ("message", message.as_str()),
                ("username", username.as_str()),
                ("password", password.as_str()),
                ("sender", sender.as_str()),
                ("priority", "0"),
            ]),
    )
    .await
}

/// **evolution** —— Evolution API（WhatsApp，自建 / 云端）。
/// config：`evolutionApiUrl`（可选，默认 https://evolapicloud.com）、
/// `evolutionInstanceName` / `evolutionAuthToken` / `evolutionRecipient`（必填）。
async fn send_evolution(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "evolution";
    let base = {
        let given = cfg_string(config, "evolutionApiUrl");
        if given.is_empty() { "https://evolapicloud.com".to_string() } else { given }
    };
    let instance = require_field(config, &["evolutionInstanceName"], KIND, "evolutionInstanceName")?;
    let token = require_field(config, &["evolutionAuthToken"], KIND, "evolutionAuthToken")?;
    let recipient = require_field(config, &["evolutionRecipient"], KIND, "evolutionRecipient")?;
    let Some(api_key) = header_value(&token) else {
        return Err("evolution 渠道的 token 含非法字符".to_string());
    };
    let payload = json!({ "number": recipient, "text": message_text(title, body) });
    send(
        http_client()
            .post(format!(
                "{}/message/sendText/{}",
                base.trim_end_matches('/'),
                percent_encode(&instance)
            ))
            .header("apikey", api_key)
            .json(&payload),
    )
    .await
}

/// **flashduty** —— FlashDuty 事件推送（integration_key 即可换算端点）。
/// config：`flashdutyIntegrationKey`（必填，key 或整个 URL）、
/// `flashdutySeverity`（可选：Info / Warning / Critical / Ok，默认 Info）。
async fn send_flashduty(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "flashduty";
    let key = require_field(config, &["flashdutyIntegrationKey"], KIND, "flashdutyIntegrationKey")?;
    let url = if key.starts_with("http") {
        key
    } else {
        format!(
            "https://api.flashcat.cloud/event/push/alert/standard?integration_key={}",
            percent_encode(&key)
        )
    };
    let severity = {
        let given = cfg_string(config, "flashdutySeverity");
        if given.is_empty() { "Info".to_string() } else { given }
    };
    let payload = json!({
        "description": format!("[{title}] {body}"),
        "title": title,
        "event_status": severity,
        "alert_key": generate_id(),
        "labels": { "resource": "aibuddy-panel", "check": title },
    });
    send(http_client().post(&url).json(&payload)).await
}

/// **flowtriq** —— Flowtriq webhook（带可选 X-API-Key）。
/// config：`flowtriqWebhookUrl`（必填）、`flowtriqApiKey`（可选）。
async fn send_flowtriq(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["flowtriqWebhookUrl"], "flowtriq", "flowtriqWebhookUrl")?;
    let payload = json!({
        "source": "aibuddy-panel",
        "status": "info",
        "monitor": title,
        "msg": message_text(title, body),
    });
    let mut request = http_client().post(&url).json(&payload);
    let key = cfg_string(config, "flowtriqApiKey");
    if !key.is_empty() {
        if let Some(value) = header_value(&key) {
            request = request.header("X-API-Key", value);
        }
    }
    send(request).await
}

/// **fluxer** —— Fluxer webhook（Discord 风格，只发文本形态）。
/// config：`fluxerWebhookUrl`（必填）、`fluxerUsername`（可选，显示名）、
/// `fluxerPrefixMessage`（可选，随正文附发的附加行）。
async fn send_fluxer(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["fluxerWebhookUrl"], "fluxer", "fluxerWebhookUrl")?;
    let username = {
        let given = cfg_string(config, "fluxerUsername");
        if given.is_empty() { "AIBuddy Panel".to_string() } else { given }
    };
    let prefix = cfg_string(config, "fluxerPrefixMessage");
    let mut content = message_text(title, body);
    if !prefix.is_empty() {
        content = format!("{prefix}\n{content}");
    }
    let payload = json!({ "username": username, "content": content });
    send(http_client().post(&url).json(&payload)).await
}

/// **freemobile** —— 法国 Free Mobile SMS（凭据放请求体，正文放查询串）。
/// config：`freemobileUser` / `freemobilePass`（必填）。
async fn send_freemobile(config: &Value, _title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "freemobile";
    let user = require_field(config, &["freemobileUser"], KIND, "freemobileUser")?;
    let pass = require_field(config, &["freemobilePass"], KIND, "freemobilePass")?;
    let payload = json!({ "user": user, "pass": pass });
    send(
        http_client()
            .post(format!("https://smsapi.free-mobile.fr/sendmsg?msg={}", percent_encode(body)))
            .json(&payload),
    )
    .await
}

/// **goalert** —— GoAlert 通用入站端点（表单提交）。
/// config：`goAlertBaseURL`（必填，服务基地址）、`goAlertToken`（必填）。
async fn send_goalert(config: &Value, _title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "goalert";
    let base = require_url(config, &["goAlertBaseURL"], KIND, "goAlertBaseURL")?
        .trim_end_matches('/')
        .to_string();
    let token = require_field(config, &["goAlertToken"], KIND, "goAlertToken")?;
    send(
        http_client()
            .post(format!(
                "{base}/api/v2/generic/incoming?token={}",
                percent_encode(&token)
            ))
            .form(&[("summary", body)]),
    )
    .await
}

/// **googlechat** —— Google Chat webhook（cardsV2 卡片 + fallbackText）。
/// config：`googleChatWebhookURL`（必填）。源码的 429 重试（60-180 秒退避）
/// 不移植 —— dispatch 有 10 秒总超时，长退避只会拖垮发送任务。
async fn send_googlechat(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["googleChatWebhookURL"], "googlechat", "googleChatWebhookURL")?;
    let payload = json!({
        "fallbackText": message_text(title, body),
        "cardsV2": [{
            "card": {
                "header": { "title": title },
                "sections": [{
                    "widgets": [{
                        "textParagraph": { "text": format!("<b>Message:</b>\n{body}") },
                    }],
                }],
            },
        }],
    });
    send(http_client().post(&url).json(&payload)).await
}

/// **googlesheets** —— Google Sheets（经 Apps Script webhook 转写）。
/// config：`googleSheetsWebhookUrl`（必填）。
async fn send_googlesheets(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["googleSheetsWebhookUrl"], "googlesheets", "googleSheetsWebhookUrl")?;
    let payload = json!({
        "timestamp": iso_now(),
        "status": "N/A",
        "monitorName": "N/A",
        "monitorUrl": "N/A",
        "message": message_text(title, body),
        "responseTime": "N/A",
        "statusCode": "N/A",
    });
    send(http_client().post(&url).json(&payload)).await
}

/// **gorush** —— Gorush 推送网关（自建）。
/// config：`gorushServerURL`（必填，基地址）、`gorushDeviceToken`（必填）、
/// `gorushPlatform`（必填：ios / android / huawei）、`gorushTitle` /
/// `gorushPriority` / `gorushRetry` / `gorushTopic`（可选）。
async fn send_gorush(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "gorush";
    let base = require_url(config, &["gorushServerURL"], KIND, "gorushServerURL")?
        .trim_end_matches('/')
        .to_string();
    let device_token = require_field(config, &["gorushDeviceToken"], KIND, "gorushDeviceToken")?;
    let platform = match cfg_string(config, "gorushPlatform").as_str() {
        "ios" => 1,
        "android" => 2,
        "huawei" => 3,
        other => return Err(format!("gorush 渠道的 gorushPlatform 无效: {other}（可选 ios / android / huawei）")),
    };
    let mut notification = json!({
        "tokens": [device_token],
        "platform": platform,
        "message": message_text(title, body),
    });
    if let Some(map) = notification.as_object_mut() {
        let notify_title = cfg_string(config, "gorushTitle");
        if !notify_title.is_empty() {
            map.insert("title".to_string(), Value::String(notify_title));
        }
        if let Some(priority) = config.get("gorushPriority").filter(|value| !value.is_null()) {
            map.insert("priority".to_string(), priority.clone());
        }
        if let Some(retry) = cfg_int(config, "gorushRetry").filter(|retry| *retry > 0) {
            map.insert("retry".to_string(), Value::from(retry));
        }
        let topic = cfg_string(config, "gorushTopic");
        if !topic.is_empty() {
            map.insert("topic".to_string(), Value::String(topic));
        }
    }
    send(
        http_client()
            .post(format!("{base}/api/push"))
            .json(&json!({ "notifications": [notification] })),
    )
    .await
}

/// **grafanaoncall** —— Grafana OnCall webhook。
/// config：`GrafanaOncallURL`（必填）。
async fn send_grafanaoncall(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["GrafanaOncallURL"], "grafanaoncall", "GrafanaOncallURL")?;
    let payload = json!({
        "title": title,
        "message": body,
        "state": "alerting",
    });
    send(http_client().post(&url).json(&payload)).await
}

/// **gtxmessaging** —— GTX Messaging SMS（API key 在路径里）。
/// config：`gtxMessagingFrom` / `gtxMessagingTo` / `gtxMessagingApiKey`（必填）。
async fn send_gtxmessaging(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "gtxmessaging";
    let from = require_field(config, &["gtxMessagingFrom"], KIND, "gtxMessagingFrom")?;
    let to = require_field(config, &["gtxMessagingTo"], KIND, "gtxMessagingTo")?;
    let key = require_field(config, &["gtxMessagingApiKey"], KIND, "gtxMessagingApiKey")?;
    let message = ascii_only(&message_text(title, body));
    send(
        http_client()
            .post(format!(
                "https://rest.gtx-messaging.net/smsc/sendsms/{}/json",
                percent_encode(&key)
            ))
            .form(&[
                ("from", from.trim().to_string()),
                ("to", to.trim().to_string()),
                ("text", message),
            ]),
    )
    .await
}

/// **heiioncall** —— Heii OnCall 手动触发器（alert）。
/// config：`heiiOnCallApiKey` / `heiiOnCallTriggerId`（必填）。
async fn send_heiioncall(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "heiioncall";
    let key = require_field(config, &["heiiOnCallApiKey"], KIND, "heiiOnCallApiKey")?;
    let trigger = require_field(config, &["heiiOnCallTriggerId"], KIND, "heiiOnCallTriggerId")?;
    let Some(bearer) = bearer_header(&key) else {
        return Err("heiioncall 渠道的 apiKey 含非法字符".to_string());
    };
    let payload = json!({ "msg": message_text(title, body) });
    send(
        http_client()
            .post(format!(
                "https://heiioncall.com/triggers/{}/alert",
                percent_encode(&trigger)
            ))
            .header(reqwest::header::AUTHORIZATION, bearer)
            .json(&payload),
    )
    .await
}

/// **homeassistant** —— Home Assistant 通知服务。
/// config：`homeAssistantUrl` / `longLivedAccessToken`（必填）、
/// `notificationService`（可选，默认 notify；persistent_notification 时不带
/// data 扩展块）。
async fn send_homeassistant(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "homeassistant";
    let base = require_url(config, &["homeAssistantUrl"], KIND, "homeAssistantUrl")?
        .trim_end_matches('/')
        .to_string();
    let token = require_field(config, &["longLivedAccessToken"], KIND, "longLivedAccessToken")?;
    let service = {
        let given = cfg_string(config, "notificationService");
        if given.is_empty() { "notify".to_string() } else { given }
    };
    let Some(bearer) = bearer_header(&token) else {
        return Err("homeassistant 渠道的 token 含非法字符".to_string());
    };
    let mut payload = json!({
        "title": "AIBuddy Panel",
        "message": message_text(title, body),
    });
    if service != "persistent_notification" {
        if let Some(map) = payload.as_object_mut() {
            map.insert(
                "data".to_string(),
                json!({ "channel": "AIBuddy Panel" }),
            );
        }
    }
    send(
        http_client()
            .post(format!("{base}/api/services/notify/{service}"))
            .header(reqwest::header::AUTHORIZATION, bearer)
            .json(&payload),
    )
    .await
}

/// **indigo** —— Indigo Home Automation（variable 写值 + action group 执行）。
/// config：`indigoUrl` / `indigoApiKey`（必填）、`indigoVariableId` /
/// `indigoActionGroupId`（至少填一个）。源码的 `indigoIgnoreTlsError` 不移植：
/// 进程级共享 Client 没法按请求关证书校验。
async fn send_indigo(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "indigo";
    let base = require_url(config, &["indigoUrl"], KIND, "indigoUrl")?
        .trim_end_matches('/')
        .to_string();
    let key = require_field(config, &["indigoApiKey"], KIND, "indigoApiKey")?;
    let Some(bearer) = bearer_header(&key) else {
        return Err("indigo 渠道的 apiKey 含非法字符".to_string());
    };
    let variable_id = cfg_int(config, "indigoVariableId");
    let action_group_id = cfg_int(config, "indigoActionGroupId");
    if variable_id.is_none() && action_group_id.is_none() {
        return Err("indigo 渠道至少要填 indigoVariableId 或 indigoActionGroupId 之一".to_string());
    }
    let mut commands: Vec<Value> = Vec::new();
    if let Some(object_id) = variable_id {
        commands.push(json!({
            "id": "aibuddy-panel",
            "message": "indigo.variable.updateValue",
            "objectId": object_id,
            "parameters": { "value": message_text(title, body) },
        }));
    }
    if let Some(object_id) = action_group_id {
        commands.push(json!({
            "id": "aibuddy-panel",
            "message": "indigo.actionGroup.execute",
            "objectId": object_id,
        }));
    }
    for command in &commands {
        let text = send_and_read(
            http_client()
                .post(format!("{base}/v2/api/command"))
                .header(reqwest::header::AUTHORIZATION, bearer.clone())
                .json(command),
        )
        .await?;
        if let Some(value) = parse_json(&text) {
            if value.get("error").and_then(Value::as_str).map(|error| !error.is_empty()).unwrap_or(false) {
                return Err(format!("indigo 拒绝了命令: {}", json_text(&value, "error")));
            }
            if value.get("validationErrors").map(|errors| !errors.is_null()).unwrap_or(false) {
                return Err(format!("indigo 拒绝了命令: {}", json_text(&value, "validationErrors")));
            }
        }
    }
    Ok(())
}

/// **jirasm** —— Jira Service Management Ops（原 Opsgenie 的 Atlassian 版）。
/// config：`jsmCloudId` / `jsmEmail` / `jsmApiToken`（必填）、
/// `jsmPriority`（可选，P1-P5，默认 P5）。
async fn send_jirasm(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "jirasm";
    let cloud_id = require_field(config, &["jsmCloudId"], KIND, "jsmCloudId")?;
    let email = require_field(config, &["jsmEmail"], KIND, "jsmEmail")?;
    let token = require_field(config, &["jsmApiToken"], KIND, "jsmApiToken")?;
    let priority = format!("P{}", cfg_int(config, "jsmPriority").unwrap_or(5));
    let payload = json!({
        "message": message_text(title, body),
        "alias": "aibuddy-panel-notification",
        "source": "AIBuddy Panel",
        "priority": priority,
        "tags": ["AIBuddy Panel"],
    });
    send(
        http_client()
            .post(format!(
                "https://api.atlassian.com/jsm/ops/api/{}/v1/alerts",
                percent_encode(&cloud_id)
            ))
            .basic_auth(email, Some(token))
            .json(&payload),
    )
    .await
}

/// **keep** —— Keep 告警事件（x-api-key 可选）。
/// config：`webhookURL`（必填）、`webhookAPIKey`（可选）。
async fn send_keep(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["webhookURL"], "keep", "webhookURL")?;
    let base = url.trim_end_matches('/');
    let payload = json!({
        "heartbeat": Value::Null,
        "monitor": Value::Null,
        "msg": message_text(title, body),
    });
    let mut request = http_client()
        .post(format!("{base}/alerts/event/uptimekuma"))
        .json(&payload);
    let key = cfg_string(config, "webhookAPIKey");
    if !key.is_empty() {
        if let Some(value) = header_value(&key) {
            request = request.header("x-api-key", value);
        }
    }
    send(request).await
}

/// **kook** —— KOOK（开黑啦）机器人消息。
/// config：`kookBotToken` / `kookGuildID`（必填）。
async fn send_kook(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "kook";
    let token = require_field(config, &["kookBotToken"], KIND, "kookBotToken")?;
    let target = config
        .get("kookGuildID")
        .cloned()
        .filter(|value| !value.is_null())
        .filter(|value| value.as_str().map(|text| !text.trim().is_empty()).unwrap_or(true))
        .ok_or_else(|| format!("{KIND} 渠道缺少必填配置: kookGuildID"))?;
    let Some(bot_header) = schemed_header("Bot", &token) else {
        return Err("kook 渠道的 botToken 含非法字符".to_string());
    };
    let payload = json!({ "target_id": target, "content": message_text(title, body) });
    send(
        http_client()
            .post("https://www.kookapp.cn/api/v3/message/create")
            .header(reqwest::header::AUTHORIZATION, bot_header)
            .json(&payload),
    )
    .await
}

/// **lunasea** —— LunaSea App 推送。
/// config：`lunaseaTarget`（user / device）、`lunaseaUserID`（user 目标时必填）、
/// `lunaseaDevice`（device 目标时必填）。
async fn send_lunasea(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "lunasea";
    let target = if cfg_string(config, "lunaseaTarget") == "user" {
        let user_id = require_field(config, &["lunaseaUserID"], KIND, "lunaseaUserID")?;
        format!("user/{}", percent_encode(&user_id))
    } else {
        let device = require_field(config, &["lunaseaDevice"], KIND, "lunaseaDevice")?;
        format!("device/{}", percent_encode(&device))
    };
    let payload = json!({ "title": title, "body": body });
    send(http_client().post(format!("https://notify.lunasea.app/v1/custom/{target}")).json(&payload)).await
}

/// **matrix** —— Matrix 房间消息（client-server r0 API）。
/// config：`homeserverUrl` / `internalRoomId` / `accessToken`（必填）。
async fn send_matrix(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "matrix";
    let base = require_url(config, &["homeserverUrl"], KIND, "homeserverUrl")?
        .trim_end_matches('/')
        .to_string();
    let room = require_field(config, &["internalRoomId"], KIND, "internalRoomId")?;
    let token = require_field(config, &["accessToken"], KIND, "accessToken")?;
    let Some(bearer) = bearer_header(&token) else {
        return Err("matrix 渠道的 accessToken 含非法字符".to_string());
    };
    let payload = json!({ "msgtype": "m.text", "body": message_text(title, body) });
    send(
        http_client()
            .put(format!(
                "{base}/_matrix/client/r0/rooms/{}/send/m.room.message/{}",
                percent_encode(&room),
                generate_id()
            ))
            .header(reqwest::header::AUTHORIZATION, bearer)
            .json(&payload),
    )
    .await
}

/// **mattermost** —— Mattermost 入站 webhook（文本形态 + 可选频道 / 头像）。
/// config：`mattermostWebhookUrl`（必填）、`mattermostusername` /
/// `mattermostchannel` / `mattermosticonemo` / `mattermosticonurl`（可选）。
async fn send_mattermost(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["mattermostWebhookUrl"], "mattermost", "mattermostWebhookUrl")?;
    let username = {
        let given = cfg_string(config, "mattermostusername");
        if given.is_empty() { "AIBuddy Panel".to_string() } else { given }
    };
    let mut payload = json!({
        "username": username,
        "text": message_text(title, body),
    });
    if let Some(map) = payload.as_object_mut() {
        let channel = cfg_string(config, "mattermostchannel").to_lowercase();
        if !channel.is_empty() {
            map.insert("channel".to_string(), Value::String(channel));
        }
        let icon_emoji = cfg_string(config, "mattermosticonemo");
        if !icon_emoji.is_empty() {
            map.insert("icon_emoji".to_string(), Value::String(icon_emoji));
        }
        let icon_url = cfg_string(config, "mattermosticonurl");
        if !icon_url.is_empty() {
            map.insert("icon_url".to_string(), Value::String(icon_url));
        }
    }
    send(http_client().post(&url).json(&payload)).await
}

/// **max** —— MAX（vk 团队的俄区 IM）机器人消息。
/// config：`maxApiUrl`（可选，默认 https://platform-api.max.ru）、
/// `maxChatID` / `maxBotToken`（必填）。
async fn send_max(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "max";
    let base = {
        let given = cfg_string(config, "maxApiUrl");
        if given.is_empty() { "https://platform-api.max.ru".to_string() } else { given }
    }
    .trim_end_matches('/')
    .to_string();
    let chat_id = require_scalar(config, &["maxChatID"], KIND, "maxChatID")?;
    let token = require_field(config, &["maxBotToken"], KIND, "maxBotToken")?;
    let Some(auth) = header_value(&token) else {
        return Err("max 渠道的 botToken 含非法字符".to_string());
    };
    let payload = json!({ "text": message_text(title, body) });
    send(
        http_client()
            .post(format!("{base}/messages?chat_id={}", percent_encode(&chat_id)))
            .header(reqwest::header::AUTHORIZATION, auth)
            .json(&payload),
    )
    .await
}

/// **milky** —— Milky（QQ 协议端）私聊 / 群聊文本消息。
/// config：`httpAddr`（必填，协议端地址）、`accessToken`（必填）、
/// `msgType`（group / private）、`recieverId`（必填，群号或 QQ 号 —— 字段名
/// 照源码的单 r 拼写）。
async fn send_milky(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "milky";
    let mut base = require_field(config, &["httpAddr"], KIND, "httpAddr")?;
    if !base.starts_with("http") {
        base = format!("http://{base}");
    }
    let token = require_field(config, &["accessToken"], KIND, "accessToken")?;
    let receiver = config
        .get("recieverId")
        .cloned()
        .filter(|value| !value.is_null())
        .ok_or_else(|| format!("{KIND} 渠道缺少必填配置: recieverId"))?;
    let Some(bearer) = bearer_header(&token) else {
        return Err("milky 渠道的 accessToken 含非法字符".to_string());
    };
    let is_group = cfg_string(config, "msgType") == "group";
    let mut payload = json!({
        "message": [{ "type": "text", "data": { "text": message_text(title, body) } }],
    });
    if let Some(map) = payload.as_object_mut() {
        map.insert(
            if is_group { "group_id".to_string() } else { "user_id".to_string() },
            receiver,
        );
    }
    send(
        http_client()
            .post(format!(
                "{}/api/{}",
                base.trim_end_matches('/'),
                if is_group { "send_group_message" } else { "send_private_message" }
            ))
            .header(reqwest::header::AUTHORIZATION, bearer)
            .json(&payload),
    )
    .await
}

/// **nextcloudtalk** —— Nextcloud Talk 机器人消息（HMAC 签名头）。
/// config：`host` / `conversationToken` / `botSecret`（必填）。随机串 +
/// HMAC-SHA256 签名随 `X-Nextcloud-Talk-Bot-Random` / `-Signature` 透传。
async fn send_nextcloudtalk(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "nextcloudtalk";
    let host = require_url(config, &["host"], KIND, "host")?
        .trim_end_matches('/')
        .to_string();
    let conversation = require_field(config, &["conversationToken"], KIND, "conversationToken")?;
    let secret = require_field(config, &["botSecret"], KIND, "botSecret")?;
    let message = message_text(title, body);
    // 64 位十六进制随机串（源码用 crypto.randomBytes(64).hex 的前 64 字符）
    let random = format!("{}{}{}{}", generate_id(), generate_id(), generate_id(), generate_id());
    let signature = hmac_sha256_hex(&secret, &format!("{random}{message}"))?;
    let Some(random_header) = header_value(&random) else {
        return Err("nextcloudtalk 生成随机串失败".to_string());
    };
    let Some(signature_header) = header_value(&signature) else {
        return Err("nextcloudtalk 生成签名失败".to_string());
    };
    let payload = json!({ "message": message, "silent": false });
    send(
        http_client()
            .post(format!(
                "{host}/ocs/v2.php/apps/spreed/api/v1/bot/{}/message",
                percent_encode(&conversation)
            ))
            .header("X-Nextcloud-Talk-Bot-Random", random_header)
            .header("X-Nextcloud-Talk-Bot-Signature", signature_header)
            .header("OCS-APIRequest", "true")
            .json(&payload),
    )
    .await
}

/// **notifery** —— Notifery 事件推送。
/// config：`notiferyApiKey`（必填）、`notiferyTitle` / `notiferyGroup`（可选）。
async fn send_notifery(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "notifery";
    let key = require_field(config, &["notiferyApiKey"], KIND, "notiferyApiKey")?;
    let Some(api_key) = header_value(&key) else {
        return Err("notifery 渠道的 apiKey 含非法字符".to_string());
    };
    let notify_title = {
        let given = cfg_string(config, "notiferyTitle");
        if given.is_empty() { title.to_string() } else { given }
    };
    let mut payload = json!({
        "title": notify_title,
        "message": message_text(title, body),
    });
    let group = cfg_string(config, "notiferyGroup");
    if !group.is_empty() {
        if let Some(map) = payload.as_object_mut() {
            map.insert("group".to_string(), Value::String(group));
        }
    }
    send(
        http_client()
            .post("https://api.notifery.com/event")
            .header("x-api-key", api_key)
            .json(&payload),
    )
    .await
}

/// **notifyapp** —— Notify! App 推送。
/// config：`notifyAppDeviceId` / `notifyAppToken`（必填）、
/// `notifyAppIconUrl`（可选）。
async fn send_notifyapp(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "notifyapp";
    let device_id = require_field(config, &["notifyAppDeviceId"], KIND, "notifyAppDeviceId")?;
    let token = require_field(config, &["notifyAppToken"], KIND, "notifyAppToken")?;
    let mut payload = json!({ "text": body, "title": title });
    if let Some(map) = payload.as_object_mut() {
        let icon = cfg_string(config, "notifyAppIconUrl");
        if !icon.is_empty() {
            map.insert("iconUrl".to_string(), Value::String(icon));
        }
    }
    send(
        http_client()
            .post(format!(
                "https://push.getnotifyapp.com/notify-json/{}?token={}",
                percent_encode(&device_id),
                percent_encode(&token)
            ))
            .json(&payload),
    )
    .await
}

/// **octopush** —— Octopush SMS（V2 默认；V1 走旧 DM 接口，业务码在响应体）。
/// config（V2）：`octopushAPIKey` / `octopushLogin` / `octopushPhoneNumber`（必填）、
/// `octopushSMSType` / `octopushSenderName`（可选）、`octopushVersion`（"1" / "2"）。
/// config（V1）：`octopushDMLogin` / `octopushDMAPIKey` / `octopushDMPhoneNumber`（必填）、
/// `octopushDMSenderName` / `octopushDMSMSType`（可选）。
async fn send_octopush(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "octopush";
    let message = ascii_only(&message_text(title, body));
    if cfg_string(config, "octopushVersion") == "1" {
        let login = require_field(config, &["octopushDMLogin"], KIND, "octopushDMLogin")?;
        let key = require_field(config, &["octopushDMAPIKey"], KIND, "octopushDMAPIKey")?;
        let phone = require_field(config, &["octopushDMPhoneNumber"], KIND, "octopushDMPhoneNumber")?;
        let sms_type = if cfg_string(config, "octopushDMSMSType") == "sms_premium" { "FR" } else { "XXX" };
        let text = send_and_read(
            http_client()
                .post("https://www.octopush-dm.com/api/sms/json")
                .query(&[
                    ("user_login", login.as_str()),
                    ("api_key", key.as_str()),
                    ("sms_recipients", phone.as_str()),
                    ("sms_sender", cfg_string(config, "octopushDMSenderName").as_str()),
                    ("sms_type", sms_type),
                    ("transactional", "1"),
                    ("sms_text", message.as_str()),
                ]),
        )
        .await?;
        let value = parse_json(&text).ok_or_else(|| "octopush 返回了无法解析的响应".to_string())?;
        if let Some(error_code) = value.get("error_code") {
            if error_code != "000" {
                return Err(format!("octopush 发送失败: {}", truncate_text(&text, 200)));
            }
        }
        return Ok(());
    }
    let key = require_field(config, &["octopushAPIKey"], KIND, "octopushAPIKey")?;
    let login = require_field(config, &["octopushLogin"], KIND, "octopushLogin")?;
    let phone = require_field(config, &["octopushPhoneNumber"], KIND, "octopushPhoneNumber")?;
    let Some(api_key) = header_value(&key) else {
        return Err("octopush 渠道的 apiKey 含非法字符".to_string());
    };
    let Some(api_login) = header_value(&login) else {
        return Err("octopush 渠道的 login 含非法字符".to_string());
    };
    let payload = json!({
        "recipients": [{ "phone_number": phone }],
        "text": message,
        "type": cfg_string(config, "octopushSMSType"),
        "purpose": "alert",
        "sender": cfg_string(config, "octopushSenderName"),
    });
    send(
        http_client()
            .post("https://api.octopush.com/v1/public/sms-campaign/send")
            .header("api-key", api_key)
            .header("api-login", api_login)
            .json(&payload),
    )
    .await
}

/// **onebot** —— OneBot（QQ 协议端）私聊 / 群聊消息。
/// config：`httpAddr` / `accessToken`（必填）、`msgType`（group / private）、
/// `recieverId`（必填，群号或 QQ 号 —— 字段名照源码的单 r 拼写）。
async fn send_onebot(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "onebot";
    let mut base = require_field(config, &["httpAddr"], KIND, "httpAddr")?;
    if !base.starts_with("http") {
        base = format!("http://{base}");
    }
    let token = require_field(config, &["accessToken"], KIND, "accessToken")?;
    let receiver = config
        .get("recieverId")
        .cloned()
        .filter(|value| !value.is_null())
        .ok_or_else(|| format!("{KIND} 渠道缺少必填配置: recieverId"))?;
    let Some(bearer) = bearer_header(&token) else {
        return Err("onebot 渠道的 accessToken 含非法字符".to_string());
    };
    let is_group = cfg_string(config, "msgType") == "group";
    let mut payload = json!({
        "auto_escape": true,
        "message": message_text(title, body),
        "message_type": if is_group { "group" } else { "private" },
    });
    if let Some(map) = payload.as_object_mut() {
        map.insert(
            if is_group { "group_id".to_string() } else { "user_id".to_string() },
            receiver,
        );
    }
    send(
        http_client()
            .post(format!("{}/send_msg", base.trim_end_matches('/')))
            .header(reqwest::header::AUTHORIZATION, bearer)
            .json(&payload),
    )
    .await
}

/// **onechat** —— OneChat（泰国）机器人消息。
/// config：`accessToken` / `recieverId` / `botId`（必填）。
async fn send_onechat(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "onechat";
    let token = require_field(config, &["accessToken"], KIND, "accessToken")?;
    let receiver = require_field(config, &["recieverId"], KIND, "recieverId")?;
    let bot_id = require_field(config, &["botId"], KIND, "botId")?;
    let Some(bearer) = bearer_header(&token) else {
        return Err("onechat 渠道的 accessToken 含非法字符".to_string());
    };
    let payload = json!({
        "to": receiver,
        "bot_id": bot_id,
        "type": "text",
        "message": message_text(title, body),
    });
    send(
        http_client()
            .post("https://chat-api.one.th/message/api/v1/push_message")
            .header(reqwest::header::AUTHORIZATION, bearer)
            .json(&payload),
    )
    .await
}

/// **onesender** —— Onesender（WhatsApp 网关）。
/// config：`onesenderURL` / `onesenderToken` / `onesenderReceiver`（必填）、
/// `onesenderTypeReceiver`（private / group，决定收件人后缀）。
async fn send_onesender(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "onesender";
    let url = require_url(config, &["onesenderURL"], KIND, "onesenderURL")?;
    let token = require_field(config, &["onesenderToken"], KIND, "onesenderToken")?;
    let receiver = require_field(config, &["onesenderReceiver"], KIND, "onesenderReceiver")?;
    let Some(bearer) = bearer_header(&token) else {
        return Err("onesender 渠道的 token 含非法字符".to_string());
    };
    let is_group = cfg_string(config, "onesenderTypeReceiver") != "private";
    let payload = json!({
        "to": format!("{receiver}{}", if is_group { "@g.us" } else { "@s.whatsapp.net" }),
        "type": "text",
        "recipient_type": if is_group { "group" } else { "individual" },
        "text": { "body": message_text(title, body) },
    });
    send(http_client().post(&url).header(reqwest::header::AUTHORIZATION, bearer).json(&payload)).await
}

/// **ooredoo** —— Ooredoo（马尔代夫）批量 SMS（Bearer 认证 + access_key Base64；
/// 每请求最多 20 个号码，超出分批）。config：`ooredooBearerToken` /
/// `ooredooUsername` / `ooredooAccessKey` / `ooredooToNumber`（必填）、
/// `ooredooServerUrl`（可选）。
async fn send_ooredoo(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "ooredoo";
    let token = require_field(config, &["ooredooBearerToken"], KIND, "ooredooBearerToken")?;
    let username = require_field(config, &["ooredooUsername"], KIND, "ooredooUsername")?;
    let access_key = require_field(config, &["ooredooAccessKey"], KIND, "ooredooAccessKey")?;
    let raw_numbers = require_field(config, &["ooredooToNumber"], KIND, "ooredooToNumber")?;
    let Some(bearer) = bearer_header(&token) else {
        return Err("ooredoo 渠道的 bearerToken 含非法字符".to_string());
    };
    let url = {
        let given = cfg_string(config, "ooredooServerUrl");
        if given.is_empty() { "https://o-papi1-lb01.ooredoo.mv/bulk_sms/v2".to_string() } else { given }
    };
    let message = message_text(title, body);
    // 号码归一照源码：去掉空白与 +，纯 7 位本地号补马尔代夫国家码 960
    let recipients: Vec<String> = split_recipients(&raw_numbers)
        .iter()
        .map(|number| number.replace([' ', '+'], ""))
        .filter(|number| !number.is_empty())
        .map(|number| {
            if number.len() == 7 && number.chars().all(|c| c.is_ascii_digit()) {
                format!("960{number}")
            } else {
                number
            }
        })
        .collect();
    if recipients.is_empty() {
        return Err("ooredoo 渠道没有有效的收件号码".to_string());
    }
    let access_key_encoded = base64::engine::general_purpose::STANDARD.encode(access_key.as_bytes());
    for batch in recipients.chunks(20) {
        // join 出的串要活到 .form(&form) 借用结束：临时值不能留在数组字面量里
        let batch_recipients = batch.join(" ");
        let form = [
            ("username", username.as_str()),
            ("access_key", access_key_encoded.as_str()),
            ("message", message.as_str()),
            ("batch", batch_recipients.as_str()),
        ];
        let text = send_and_read(
            http_client()
                .post(&url)
                .header(reqwest::header::AUTHORIZATION, bearer.clone())
                .form(&form),
        )
        .await?;
        // 网关 200 也可能失败，真实结果在 response_code（0 = 成功）
        let code = parse_json(&text).and_then(|value| value.get("response_code").cloned());
        let ok = match code {
            Some(Value::Number(number)) => number.as_i64() == Some(0),
            Some(Value::String(text)) => text == "0",
            _ => false,
        };
        if !ok {
            return Err(format!("ooredoo 拒绝了消息: {}", truncate_text(&text, 200)));
        }
    }
    Ok(())
}

/// **openwa** —— OpenWA（WhatsApp 自建 web API）逐会话发文本。
/// config：`openwaApiUrl` / `openwaSession` / `openwaApiKey` / `openwaChatId`
/// （必填，chatId 逗号分隔逐个发）。
async fn send_openwa(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "openwa";
    let base = require_url(config, &["openwaApiUrl"], KIND, "openwaApiUrl")?
        .trim_end_matches('/')
        .to_string();
    let session = require_field(config, &["openwaSession"], KIND, "openwaSession")?;
    let key = require_field(config, &["openwaApiKey"], KIND, "openwaApiKey")?;
    let chat_ids = split_recipients(&cfg_string(config, "openwaChatId"));
    if chat_ids.is_empty() {
        return Err("openwa 渠道缺少 chatId".to_string());
    }
    let Some(api_key) = header_value(&key) else {
        return Err("openwa 渠道的 apiKey 含非法字符".to_string());
    };
    let message = message_text(title, body);
    for chat_id in &chat_ids {
        send(
            http_client()
                .post(format!(
                    "{base}/api/sessions/{}/messages/send-text",
                    percent_encode(&session)
                ))
                .header("X-Api-Key", api_key.clone())
                .json(&json!({ "chatId": chat_id, "text": message })),
        )
        .await?;
    }
    Ok(())
}

/// **opsgenie** —— Opsgenie 告警（us / eu 两区）。
/// config：`opsgenieApiKey`（必填）、`opsgenieRegion`（us / eu，默认 us）、
/// `opsgeniePriority`（可选 P1-P5，默认 P3）。
async fn send_opsgenie(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "opsgenie";
    let key = require_field(config, &["opsgenieApiKey"], KIND, "opsgenieApiKey")?;
    let Some(genie_key) = schemed_header("GenieKey", &key) else {
        return Err("opsgenie 渠道的 apiKey 含非法字符".to_string());
    };
    let url = match cfg_string(config, "opsgenieRegion").as_str() {
        "eu" => "https://api.eu.opsgenie.com/v2/alerts",
        _ => "https://api.opsgenie.com/v2/alerts",
    };
    let payload = json!({
        "message": message_text(title, body),
        "alias": "aibuddy-panel",
        "source": "AIBuddy Panel",
        "priority": format!("P{}", cfg_int(config, "opsgeniePriority").unwrap_or(3)),
    });
    send(
        http_client()
            .post(url)
            .header(reqwest::header::AUTHORIZATION, genie_key)
            .json(&payload),
    )
    .await
}

/// **pagerduty** —— PagerDuty Events API v2（routing_key + integration URL）。
/// config：`pagerdutyIntegrationUrl` / `pagerdutyIntegrationKey`（必填）、
/// `pagerdutyPriority`（可选：warning / error / critical / info）。
async fn send_pagerduty(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "pagerduty";
    let url = require_url(config, &["pagerdutyIntegrationUrl"], KIND, "pagerdutyIntegrationUrl")?;
    let key = require_field(config, &["pagerdutyIntegrationKey"], KIND, "pagerdutyIntegrationKey")?;
    let severity = {
        let given = cfg_string(config, "pagerdutyPriority");
        if given.is_empty() { "warning".to_string() } else { given }
    };
    let payload = json!({
        "payload": {
            "summary": format!("[{title}] {body}"),
            "severity": severity,
            "source": "aibuddy-panel",
        },
        "routing_key": key,
        "event_action": "trigger",
        "dedup_key": "aibuddy-panel/test",
    });
    send(http_client().post(&url).json(&payload)).await
}

/// **pagertree** —— PagerTree 集成端点。
/// config：`pagertreeIntegrationUrl`（必填）、`pagertreeUrgency`（可选：low /
/// medium / high / critical）。
async fn send_pagertree(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["pagertreeIntegrationUrl"], "pagertree", "pagertreeIntegrationUrl")?;
    let mut payload = json!({
        "event_type": "create",
        "id": "aibuddy-panel",
        "title": title,
        "heartbeat": Value::Null,
        "monitor": Value::Null,
    });
    if let Some(map) = payload.as_object_mut() {
        map.insert(
            "description".to_string(),
            Value::String(message_text(title, body)),
        );
        let urgency = cfg_string(config, "pagertreeUrgency");
        if !urgency.is_empty() {
            map.insert("urgency".to_string(), Value::String(urgency));
        }
    }
    send(http_client().post(&url).json(&payload)).await
}

/// **pinglet** —— Pinglet（rewrite=uptimekuma 的服务端改写器）。
/// config：`pingletPublishUrl` / `pingletApiKey`（必填）。
async fn send_pinglet(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "pinglet";
    let url = require_url(config, &["pingletPublishUrl"], KIND, "pingletPublishUrl")?;
    let key = require_field(config, &["pingletApiKey"], KIND, "pingletApiKey")?;
    let Some(bearer) = bearer_header(&key) else {
        return Err("pinglet 渠道的 apiKey 含非法字符".to_string());
    };
    let payload = json!({
        "heartbeat": Value::Null,
        "monitor": Value::Null,
        "msg": message_text(title, body),
    });
    send(
        http_client()
            .post(with_query(url.trim_end_matches('/'), "rewrite", "uptimekuma"))
            .header(reqwest::header::AUTHORIZATION, bearer)
            .json(&payload),
    )
    .await
}

/// **plivo** —— Plivo SMS（Basic 认证；可选语音呼叫形态）。
/// config：`plivoAuthID` / `plivoAuthToken` / `plivoFromNumber` / `plivoToNumber`
/// （必填）、`plivoMessageType`（sms / call）、`plivoAnswerUrl`（call 时必填）。
async fn send_plivo(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "plivo";
    let auth_id = require_field(config, &["plivoAuthID"], KIND, "plivoAuthID")?;
    let auth_token = require_field(config, &["plivoAuthToken"], KIND, "plivoAuthToken")?;
    let from = require_field(config, &["plivoFromNumber"], KIND, "plivoFromNumber")?;
    let to = require_field(config, &["plivoToNumber"], KIND, "plivoToNumber")?;
    let base = format!("https://api.plivo.com/v1/Account/{}", percent_encode(&auth_id));
    let message = message_text(title, body);
    let url = if cfg_string(config, "plivoMessageType") == "call" {
        let answer_url = require_field(config, &["plivoAnswerUrl"], KIND, "plivoAnswerUrl")?;
        (
            format!("{base}/Call/"),
            json!({
                "from": from,
                "to": to,
                "answer_url": with_query(&answer_url, "message", &message),
                "answer_method": "GET",
            }),
        )
    } else {
        (
            format!("{base}/Message/"),
            json!({ "src": from, "dst": to, "text": message }),
        )
    };
    send(http_client().post(url.0).basic_auth(auth_id, Some(auth_token)).json(&url.1)).await
}

/// **promosms** —— PromoSMS（波兰）SMS（Basic 认证；响应体带业务状态码）。
/// config：`promosmsLogin` / `promosmsPassword` / `promosmsPhoneNumber`（必填）、
/// `promosmsAllowLongSMS`（可选布尔）、`promosmsSMSType`（数字）、
/// `promosmsSenderName`（可选）。
async fn send_promosms(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "promosms";
    let login = require_field(config, &["promosmsLogin"], KIND, "promosmsLogin")?;
    let password = require_field(config, &["promosmsPassword"], KIND, "promosmsPassword")?;
    let phone = require_field(config, &["promosmsPhoneNumber"], KIND, "promosmsPhoneNumber")?;
    let allow_long = config
        .get("promosmsAllowLongSMS")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let clean = ascii_only(&message_text(title, body));
    let message: String = clean
        .chars()
        .take(if allow_long { 639 } else { 159 })
        .collect();
    let mut payload = json!({
        "recipients": [phone],
        "text": message,
        "long-sms": allow_long,
    });
    if let Some(map) = payload.as_object_mut() {
        if let Some(sms_type) = cfg_int(config, "promosmsSMSType") {
            map.insert("type".to_string(), Value::from(sms_type));
        }
        let sender = cfg_string(config, "promosmsSenderName");
        if !sender.is_empty() {
            map.insert("sender".to_string(), Value::String(sender));
        }
    }
    let text = send_and_read(
        http_client()
            .post("https://promosms.com/api/rest/v3_2/sms")
            .basic_auth(login, Some(password))
            .json(&payload),
    )
    .await?;
    let status = parse_json(&text)
        .and_then(|value| value.get("response").and_then(|response| response.get("status")).cloned());
    let ok = match status {
        Some(Value::Number(number)) => number.as_i64() == Some(0),
        Some(Value::String(text)) => text == "0",
        _ => false,
    };
    if !ok {
        return Err(format!("promosms 发送失败: {}", truncate_text(&text, 200)));
    }
    Ok(())
}

/// **pumble** —— Pumble（Chat by CAKE.com）webhook（附件形态）。
/// config：`webhookURL`（必填）。
async fn send_pumble(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["webhookURL"], "pumble", "webhookURL")?;
    let payload = json!({
        "attachments": [{
            "title": title,
            "text": body,
            "color": "#5BDD8B",
        }],
    });
    send(http_client().post(&url).json(&payload)).await
}

/// **pushdeer** —— PushDeer（自建 / 官方，markdown 形态）。
/// config：`pushdeerKey`（必填）、`pushdeerServer`（可选，默认
/// https://api2.pushdeer.com）。响应体带 error / 空 result 时为失败。
async fn send_pushdeer(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "pushdeer";
    let key = require_field(config, &["pushdeerKey"], KIND, "pushdeerKey")?;
    let base = {
        let given = cfg_string(config, "pushdeerServer");
        if given.is_empty() { "https://api2.pushdeer.com".to_string() } else { given }
    }
    .trim_end_matches('/')
    .to_string();
    // 照源码：正文里的单个换行放宽成空行（markdown 段落）
    let desp = body.replace('\n', "\n\n");
    let payload = json!({
        "pushkey": key,
        "text": format!("## {title}"),
        "desp": desp,
        "type": "markdown",
    });
    let text = send_and_read(http_client().post(format!("{base}/message/push")).json(&payload)).await?;
    let Some(value) = parse_json(&text) else {
        return Err("pushdeer 返回了无法解析的响应".to_string());
    };
    if value.get("error").map(|error| !error.is_null()).unwrap_or(false) {
        return Err(format!("pushdeer 发送失败: {}", json_text(&value, "error")));
    }
    let has_result = value
        .get("content")
        .and_then(|content| content.get("result"))
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    if !has_result {
        return Err("pushdeer 发送失败: 无效的 pushkey".to_string());
    }
    Ok(())
}

/// **pushplus** —— PushPlus（微信公众号推送）。
/// config：`pushPlusSendKey`（必填）。
async fn send_pushplus(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "pushplus";
    let key = require_field(config, &["pushPlusSendKey"], KIND, "pushPlusSendKey")?;
    let payload = json!({
        "token": key,
        "title": title,
        "content": body,
        "template": "html",
    });
    send(http_client().post("https://www.pushplus.plus/send").json(&payload)).await
}

/// **pushy** —— Pushy 设备推送（api_key 在查询串）。
/// config：`pushyAPIKey` / `pushyToken`（必填）。
async fn send_pushy(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "pushy";
    let key = require_field(config, &["pushyAPIKey"], KIND, "pushyAPIKey")?;
    let token = require_field(config, &["pushyToken"], KIND, "pushyToken")?;
    let payload = json!({
        "to": token,
        "data": { "message": "AIBuddy-Panel" },
        "notification": {
            "body": message_text(title, body),
            "badge": 1,
            "sound": "ping.aiff",
        },
    });
    send(
        http_client()
            .post(format!("https://api.pushy.me/push?api_key={}", percent_encode(&key)))
            .json(&payload),
    )
    .await
}

/// **resend** —— Resend 事务邮件 API。
/// config：`resendApiKey` / `resendToEmail` / `resendFromEmail`（必填）、
/// `resendFromName` / `resendSubject`（可选）。
async fn send_resend(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "resend";
    let key = require_field(config, &["resendApiKey"], KIND, "resendApiKey")?;
    let to = require_field(config, &["resendToEmail"], KIND, "resendToEmail")?;
    let from = require_field(config, &["resendFromEmail"], KIND, "resendFromEmail")?;
    let Some(bearer) = bearer_header(&key) else {
        return Err("resend 渠道的 apiKey 含非法字符".to_string());
    };
    let from_name = {
        let given = cfg_string(config, "resendFromName");
        if given.is_empty() { "AIBuddy Panel".to_string() } else { given }
    };
    let subject = {
        let given = cfg_string(config, "resendSubject");
        if given.is_empty() { "AIBuddy Panel 通知".to_string() } else { given }
    };
    let payload = json!({
        "from": format!("{from_name} <{from}>"),
        "to": to,
        "subject": subject,
        "text": message_text(title, body),
    });
    send(
        http_client()
            .post("https://api.resend.com/emails")
            .header(reqwest::header::AUTHORIZATION, bearer)
            .json(&payload),
    )
    .await
}

/// **rocketchat** —— Rocket.Chat 入站 webhook。
/// config：`rocketwebhookURL`（必填）、`rocketchannel` / `rocketusername` /
/// `rocketiconemo`（可选）。
async fn send_rocketchat(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["rocketwebhookURL"], "rocketchat", "rocketwebhookURL")?;
    let mut payload = json!({ "text": message_text(title, body) });
    if let Some(map) = payload.as_object_mut() {
        for field in ["rocketchannel", "rocketusername", "rocketiconemo"] {
            let key = match field {
                "rocketchannel" => "channel",
                "rocketusername" => "username",
                _ => "icon_emoji",
            };
            let value = cfg_string(config, field);
            if !value.is_empty() {
                map.insert(key.to_string(), Value::String(value));
            }
        }
    }
    send(http_client().post(&url).json(&payload)).await
}

/// **sendgrid** —— SendGrid 邮件 API（Bearer 认证）。
/// config：`sendgridApiKey` / `sendgridToEmail` / `sendgridFromEmail`（必填）、
/// `sendgridCcEmail` / `sendgridBccEmail` / `sendgridSubject`（可选，抄送逗号分隔）。
async fn send_sendgrid(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "sendgrid";
    let key = require_field(config, &["sendgridApiKey"], KIND, "sendgridApiKey")?;
    let to = require_field(config, &["sendgridToEmail"], KIND, "sendgridToEmail")?;
    let from = require_field(config, &["sendgridFromEmail"], KIND, "sendgridFromEmail")?;
    let Some(bearer) = bearer_header(&key) else {
        return Err("sendgrid 渠道的 apiKey 含非法字符".to_string());
    };
    let mut personalization = json!({ "to": [{ "email": to }] });
    if let Some(map) = personalization.as_object_mut() {
        let cc: Vec<Value> = split_recipients(&cfg_string(config, "sendgridCcEmail"))
            .iter()
            .map(|email| json!({ "email": email }))
            .collect();
        let bcc: Vec<Value> = split_recipients(&cfg_string(config, "sendgridBccEmail"))
            .iter()
            .map(|email| json!({ "email": email }))
            .collect();
        if !cc.is_empty() {
            map.insert("cc".to_string(), Value::Array(cc));
        }
        if !bcc.is_empty() {
            map.insert("bcc".to_string(), Value::Array(bcc));
        }
    }
    let subject = {
        let given = cfg_string(config, "sendgridSubject");
        if given.is_empty() { "AIBuddy Panel 通知".to_string() } else { given }
    };
    let payload = json!({
        "personalizations": [personalization],
        "from": { "email": from },
        "subject": subject,
        "content": [{ "type": "text/plain", "value": message_text(title, body) }],
    });
    send(
        http_client()
            .post("https://api.sendgrid.com/v3/mail/send")
            .header(reqwest::header::AUTHORIZATION, bearer)
            .json(&payload),
    )
    .await
}

/// **serwersms** —— SerwerSMS（波兰，凭据放请求体；响应体带 success）。
/// config：`serwersmsUsername` / `serwersmsPassword`（必填）、
/// `serwersmsPhoneNumber`（phone 形态必填）或 `serwersmsGroupId`（group 形态）、
/// `serwersmsRecipientType`（phone / group）、`serwersmsSenderName`（可选）。
async fn send_serwersms(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "serwersms";
    let username = require_field(config, &["serwersmsUsername"], KIND, "serwersmsUsername")?;
    let password = require_field(config, &["serwersmsPassword"], KIND, "serwersmsPassword")?;
    let is_group = cfg_string(config, "serwersmsRecipientType") == "group";
    let mut payload = json!({
        "username": username,
        "password": password,
        "text": ascii_only(&message_text(title, body)),
        "sender": cfg_string(config, "serwersmsSenderName"),
    });
    if let Some(map) = payload.as_object_mut() {
        let recipient = if is_group {
            cfg_string(config, "serwersmsGroupId")
        } else {
            require_field(config, &["serwersmsPhoneNumber"], KIND, "serwersmsPhoneNumber")?
        };
        map.insert(
            if is_group { "group_id".to_string() } else { "phone".to_string() },
            Value::String(recipient),
        );
    }
    let text = send_and_read(http_client().post("https://api2.serwersms.pl/messages/send_sms").json(&payload)).await?;
    let success = parse_json(&text)
        .map(|value| value.get("success").map(|success| !success.is_null() && *success != Value::Bool(false)).unwrap_or(false))
        .unwrap_or(false);
    if !success {
        return Err(format!("serwersms 发送失败: {}", truncate_text(&text, 200)));
    }
    Ok(())
}

/// **sevenio** —— Seven（七号）SMS API（X-API-Key 头）。
/// config：`sevenioApiKey` / `sevenioReceiver`（必填）、`sevenioSender`（可选）。
async fn send_sevenio(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "sevenio";
    let key = require_field(config, &["sevenioApiKey"], KIND, "sevenioApiKey")?;
    let to = require_field(config, &["sevenioReceiver"], KIND, "sevenioReceiver")?;
    let Some(api_key) = header_value(&key) else {
        return Err("sevenio 渠道的 apiKey 含非法字符".to_string());
    };
    let from = {
        let given = cfg_string(config, "sevenioSender");
        if given.is_empty() { "AIBuddy Panel".to_string() } else { given }
    };
    let payload = json!({ "to": to, "from": from, "text": message_text(title, body) });
    send(
        http_client()
            .post("https://gateway.seven.io/api/sms")
            .header("X-API-Key", api_key)
            .json(&payload),
    )
    .await
}

/// **signal** —— Signal（signal-cli REST API 网关）。
/// config：`signalURL` / `signalNumber` / `signalRecipients`（必填，收件人逗号分隔）。
async fn send_signal(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "signal";
    let url = require_url(config, &["signalURL"], KIND, "signalURL")?;
    let number = require_field(config, &["signalNumber"], KIND, "signalNumber")?;
    let raw_recipients = require_field(config, &["signalRecipients"], KIND, "signalRecipients")?;
    // 照源码：整串去掉所有空白再按逗号拆
    let recipients: Vec<String> = raw_recipients
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .split(',')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    if recipients.is_empty() {
        return Err("signal 渠道缺少收件人".to_string());
    }
    let payload = json!({
        "message": message_text(title, body),
        "number": number,
        "recipients": recipients,
    });
    send(http_client().post(&url).json(&payload)).await
}

/// **signalgrid** —— SignalGrid 推送（表单提交；响应体带业务 code）。
/// config：`signalgridClientKey` / `signalgridChannel`（必填）。
async fn send_signalgrid(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "signalgrid";
    let client_key = require_field(config, &["signalgridClientKey"], KIND, "signalgridClientKey")?;
    let channel = require_field(config, &["signalgridChannel"], KIND, "signalgridChannel")?;
    let form = [
        ("client_key", client_key),
        ("channel", channel),
        ("title", title.to_string()),
        ("body", message_text(title, body)),
        ("type", "INFO".to_string()),
        ("critical", "false".to_string()),
    ];
    let text = send_and_read(
        http_client()
            .post("https://api.signalgrid.co/v1/push")
            .form(&form),
    )
    .await?;
    let code = parse_json(&text).and_then(|value| value.get("code").cloned());
    let ok = match code {
        Some(Value::Number(number)) => number.as_i64() == Some(200),
        Some(Value::String(text)) => text == "200",
        // 没有 code 字段视为成功（照源码 `response.data?.code && …` 的语义）
        None => true,
        _ => false,
    };
    if !ok {
        return Err(format!("signalgrid 发送失败: {}", truncate_text(&text, 200)));
    }
    Ok(())
}

/// **signl4** —— SIGNL4 团队告警 webhook。
/// config：`webhookURL`（必填）。
async fn send_signl4(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["webhookURL"], "signl4", "webhookURL")?;
    let payload = json!({
        "title": title,
        "message": body,
        "msg": message_text(title, body),
        "X-S4-SourceSystem": "AIBuddyPanel",
    });
    send(http_client().post(&url).json(&payload)).await
}

/// **smsgateway** —— SMS-Gateway（Android 应用网关，逐收件人发）。
/// config：`smsgatewayUrl` / `smsgatewayApiKey` / `smsgatewayTo`（必填，逗号分隔）。
async fn send_smsgateway(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "smsgateway";
    let base = require_url(config, &["smsgatewayUrl"], KIND, "smsgatewayUrl")?
        .trim_end_matches('/')
        .to_string();
    let key = require_field(config, &["smsgatewayApiKey"], KIND, "smsgatewayApiKey")?;
    let raw_recipients = require_field(config, &["smsgatewayTo"], KIND, "smsgatewayTo")?;
    let Some(api_key) = header_value(&key) else {
        return Err("smsgateway 渠道的 apiKey 含非法字符".to_string());
    };
    let message = message_text(title, body);
    let recipients: Vec<String> = raw_recipients
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    if recipients.is_empty() {
        return Err("smsgateway 渠道缺少收件号码".to_string());
    }
    for to in &recipients {
        let text = send_and_read(
            http_client()
                .post(format!("{base}/api/v1/sms/send"))
                .header("X-API-Key", api_key.clone())
                .json(&json!({ "to": to, "body": message })),
        )
        .await?;
        // 网关 200 也可能失败（调制解调器发送失败），status=failed 时报错
        if parse_json(&text)
            .and_then(|value| value.get("status").and_then(Value::as_str).map(str::to_string))
            .map(|status| status == "failed")
            .unwrap_or(false)
        {
            return Err(format!("smsgateway 发送失败（{to}）: {}", truncate_text(&text, 200)));
        }
    }
    Ok(())
}

/// **smsir** —— SMS.ir 验证码接口（模板参数，单条正文上限 20 字符）。
/// config：`smsirApiKey` / `smsirNumber`（逗号分隔）/ `smsirTemplate`（必填）。
async fn send_smsir(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "smsir";
    let key = require_field(config, &["smsirApiKey"], KIND, "smsirApiKey")?;
    let raw_numbers = require_field(config, &["smsirNumber"], KIND, "smsirNumber")?;
    let template = require_field(config, &["smsirTemplate"], KIND, "smsirTemplate")?;
    let Some(api_key) = header_value(&key) else {
        return Err("smsir 渠道的 apiKey 含非法字符".to_string());
    };
    let template_id = template
        .parse::<i64>()
        .map_err(|_| format!("{KIND} 渠道的 smsirTemplate 必须是数字"))?;
    // 照源码的 20 字符压缩：先去空白，仍超长就截断加省略号
    let mut message = message_text(title, body);
    if message.chars().count() > 20 {
        message = message.replace([' ', '\t', '\n', '\r'], "");
    }
    if message.chars().count() > 20 {
        message = format!("{}...", message.chars().take(16).collect::<String>());
    }
    for raw in raw_numbers.split(',') {
        let mobile = raw.trim();
        if mobile.is_empty() {
            continue;
        }
        // 09xxxxxxxxx 归一成 9xxxxxxxxx（源码行为）
        let mobile = if mobile.len() == 11
            && mobile.starts_with("09")
            && mobile[1..].chars().all(|character| character.is_ascii_digit())
        {
            &mobile[1..]
        } else {
            mobile
        };
        send(
            http_client()
                .post("https://api.sms.ir/v1/send/verify")
                .header("X-API-Key", api_key.clone())
                .json(&json!({
                    "mobile": mobile,
                    "templateId": template_id,
                    "parameters": [{ "name": "uptkumaalert", "value": message }],
                })),
        )
        .await?;
    }
    Ok(())
}

/// **smsmanager** —— SMSManager（捷克，GET 查询参数提交）。
/// config：`smsmanagerApiKey` / `numbers` / `messageType`（必填，gateway 值）。
async fn send_smsmanager(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "smsmanager";
    let key = require_field(config, &["smsmanagerApiKey"], KIND, "smsmanagerApiKey")?;
    let number = require_field(config, &["numbers"], KIND, "numbers")?;
    let gateway = require_field(config, &["messageType"], KIND, "messageType")?;
    let message = ascii_only(&message_text(title, body));
    send(
        http_client()
            .get("https://http-api.smsmanager.cz/Send")
            .query(&[
                ("apikey", key.as_str()),
                ("message", message.as_str()),
                ("number", number.as_str()),
                ("gateway", gateway.as_str()),
            ]),
    )
    .await
}

/// **smspartner** —— SMSPartner（法国；ASCII、正文上限 639）。
/// config：`smspartnerApikey` / `smspartnerPhoneNumber`（必填）、
/// `smspartnerSenderName`（可选，最长 11 字符）。
async fn send_smspartner(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "smspartner";
    let key = require_field(config, &["smspartnerApikey"], KIND, "smspartnerApikey")?;
    let phone = require_field(config, &["smspartnerPhoneNumber"], KIND, "smspartnerPhoneNumber")?;
    let sender: String = cfg_string(config, "smspartnerSenderName").chars().take(11).collect();
    let message: String = ascii_only(&message_text(title, body)).chars().take(639).collect();
    let payload = json!({
        "apiKey": key,
        "sender": sender,
        "phoneNumbers": phone,
        "message": message,
    });
    let text = send_and_read(http_client().post("https://api.smspartner.fr/v1/send").json(&payload)).await?;
    let success = parse_json(&text)
        .and_then(|value| value.get("success").and_then(Value::as_bool))
        .unwrap_or(false);
    if !success {
        return Err(format!("smspartner 发送失败: {}", truncate_text(&text, 200)));
    }
    Ok(())
}

/// **smsplanet** —— SMSPlanet（波兰，表单提交 + Bearer 认证）。
/// config：`smsplanetApiToken` / `smsplanetPhoneNumbers`（必填）、
/// `smsplanetSenderName`（可选）。
async fn send_smsplanet(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "smsplanet";
    let token = require_field(config, &["smsplanetApiToken"], KIND, "smsplanetApiToken")?;
    let numbers = require_field(config, &["smsplanetPhoneNumbers"], KIND, "smsplanetPhoneNumbers")?;
    let Some(bearer) = bearer_header(&token) else {
        return Err("smsplanet 渠道的 apiToken 含非法字符".to_string());
    };
    let form = [
        ("from", cfg_string(config, "smsplanetSenderName")),
        ("to", numbers),
        ("msg", message_text(title, body)),
    ];
    let text = send_and_read(
        http_client()
            .post("https://api2.smsplanet.pl/sms")
            .header(reqwest::header::AUTHORIZATION, bearer)
            .form(&form),
    )
    .await?;
    // 源码只认响应里的 messageId
    if !parse_json(&text)
        .map(|value| value.get("messageId").map(|id| !id.is_null()).unwrap_or(false))
        .unwrap_or(false)
    {
        return Err(format!("smsplanet 发送失败: {}", truncate_text(&text, 200)));
    }
    Ok(())
}

/// **smsc** —— SMSC（哈萨克，GET 查询参数提交）。
/// config：`smscLogin` / `smscPassword` / `smscToNumber`（必填）、
/// `smscTranslit`（0/1）、`smscSenderName`（可选）。
async fn send_smsc(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "smsc";
    let login = require_field(config, &["smscLogin"], KIND, "smscLogin")?;
    let password = require_field(config, &["smscPassword"], KIND, "smscPassword")?;
    let phones = require_field(config, &["smscToNumber"], KIND, "smscToNumber")?;
    let mut params: Vec<(&str, String)> = vec![
        ("fmt", "3".to_string()),
        ("login", login),
        ("psw", password),
        ("phones", phones),
        ("mes", ascii_only(&message_text(title, body))),
    ];
    let translit = cfg_string(config, "smscTranslit");
    if !translit.is_empty() {
        params.push(("translit", translit));
    }
    let sender = cfg_string(config, "smscSenderName");
    if !sender.is_empty() {
        params.push(("sender", sender));
    }
    let text = send_and_read(http_client().get("https://smsc.kz/sys/send.php").query(&params)).await?;
    let value = parse_json(&text).ok_or_else(|| "smsc 返回了无法解析的响应".to_string())?;
    if value.get("id").and_then(Value::as_i64).is_none() {
        return Err(format!(
            "smsc 发送失败: {} {}",
            json_text(&value, "error_code"),
            json_text(&value, "error")
        ));
    }
    Ok(())
}

/// **smseagle** —— SMSEagle 硬件短信网关（API v1 GET / API v2 JSON 双形态）。
/// config：`smseagleUrl` / `smseagleToken`（必填）、`smseagleApiType`
/// （smseagle-apiv1 / smseagle-apiv2，缺省 v2）、`smseagleRecipient`（v1 必填），
/// v2 用 `smseagleRecipientTo`（号码，逗号分隔）/ `smseagleRecipientContact` /
/// `smseagleRecipientGroup`（联系人 / 分组，逗号分隔，至少填一个）、
/// `smseagleEncoding`（布尔）、`smseaglePriority`（数字）。v1 只移植纯短信
/// 形态（联系人 / 分组 / 语音呼叫的变体与 v2 的 ring / tts 一样少见，先不搬）。
async fn send_smseagle(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "smseagle";
    let base = require_url(config, &["smseagleUrl"], KIND, "smseagleUrl")?
        .trim_end_matches('/')
        .to_string();
    let token = require_field(config, &["smseagleToken"], KIND, "smseagleToken")?;
    let message = message_text(title, body);
    if cfg_string(config, "smseagleApiType") == "smseagle-apiv1" {
        let recipient = require_field(config, &["smseagleRecipient"], KIND, "smseagleRecipient")?;
        let unicode = if config.get("smseagleEncoding").and_then(Value::as_bool).unwrap_or(false) {
            "1"
        } else {
            "0"
        };
        let params = [
            ("access_token", token),
            ("to", recipient),
            ("unicode", unicode.to_string()),
            ("highpriority", cfg_int(config, "smseaglePriority").unwrap_or(0).to_string()),
            ("message", message),
        ];
        let text = send_and_read(
            http_client()
                .get(format!("{base}/http_api/send_sms"))
                .query(&params),
        )
        .await?;
        if !text.contains("OK") {
            return Err(format!("smseagle 发送失败: {}", truncate_text(&text, 200)));
        }
        return Ok(());
    }
    let Some(access_token) = header_value(&token) else {
        return Err("smseagle 渠道的 token 含非法字符".to_string());
    };
    let mut payload = json!({
        "text": message,
        "encoding": if config.get("smseagleEncoding").and_then(Value::as_bool).unwrap_or(false) { "unicode" } else { "standard" },
        "priority": cfg_int(config, "smseaglePriority").unwrap_or(0),
    });
    if let Some(map) = payload.as_object_mut() {
        let to: Vec<String> = cfg_string(config, "smseagleRecipientTo")
            .split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect();
        let contacts: Vec<i64> = cfg_string(config, "smseagleRecipientContact")
            .split(',')
            .filter_map(|part| part.trim().parse().ok())
            .collect();
        let groups: Vec<i64> = cfg_string(config, "smseagleRecipientGroup")
            .split(',')
            .filter_map(|part| part.trim().parse().ok())
            .collect();
        if !to.is_empty() {
            map.insert("to".to_string(), json!(to));
        }
        if !contacts.is_empty() {
            map.insert("contacts".to_string(), json!(contacts));
        }
        if !groups.is_empty() {
            map.insert("groups".to_string(), json!(groups));
        }
    }
    send(
        http_client()
            .post(format!("{base}/api/v2/messages/sms"))
            .header("access-token", access_token)
            .json(&payload),
    )
    .await
}

/// **splunk** —— Splunk（PagerDuty 兼容的事件端点）。
/// config：`splunkRestURL`（必填）、`splunkSeverity`（可选：trigger /
/// recovery / acknowledged）、`pagerdutyIntegrationKey`（可选，routing_key）。
async fn send_splunk(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "splunk";
    let url = require_url(config, &["splunkRestURL"], KIND, "splunkRestURL")?;
    let message_type = {
        let given = cfg_string(config, "splunkSeverity");
        if given.is_empty() { "trigger".to_string() } else { given }
    };
    let mut payload = json!({
        "message_type": message_type,
        "state_message": format!("[{title}] {body}"),
        "entity_display_name": format!("AIBuddy Panel: {title}"),
        "entity_id": "aibuddy-panel/test",
    });
    if let Some(map) = payload.as_object_mut() {
        let routing_key = cfg_string(config, "pagerdutyIntegrationKey");
        if !routing_key.is_empty() {
            map.insert("routing_key".to_string(), Value::String(routing_key));
        }
    }
    send(http_client().post(&url).json(&payload)).await
}

/// **spugpush** —— SpugPush（推送助手模板消息）。
/// config：`templateKey`（必填）。
async fn send_spugpush(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "spugpush";
    let template = require_field(config, &["templateKey"], KIND, "templateKey")?;
    let payload = json!({ "title": title, "content": body });
    send(
        http_client()
            .post(format!("https://push.spug.cc/send/{}", percent_encode(&template)))
            .json(&payload),
    )
    .await
}

/// **squadcast** —— Squadcast 事件 webhook。
/// config：`squadcastWebhookURL`（必填）。
async fn send_squadcast(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["squadcastWebhookURL"], "squadcast", "squadcastWebhookURL")?;
    let payload = json!({
        "message": message_text(title, body),
        "description": "",
        "tags": {},
        "heartbeat": Value::Null,
        "source": "aibuddy-panel",
    });
    send(http_client().post(&url).json(&payload)).await
}

/// **stackfield** —— Stackfield 讨论 webhook（Title 字段，大写 T 照源码）。
/// config：`stackfieldwebhookURL`（必填）。
async fn send_stackfield(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["stackfieldwebhookURL"], "stackfield", "stackfieldwebhookURL")?;
    let text = format!("+{title}+\n{}", message_text(title, body));
    let payload = json!({ "Title": text });
    send(http_client().post(&url).json(&payload)).await
}

/// **techuluspush** —— Techulus Push（API key 在路径里）。
/// config：`pushAPIKey`（必填）、`pushTitle` / `pushChannel` / `pushSound`
/// （可选）、`pushTimeSensitive`（布尔，默认 true）。
async fn send_techuluspush(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "techuluspush";
    let key = require_field(config, &["pushAPIKey"], KIND, "pushAPIKey")?;
    let notify_title = {
        let given = cfg_string(config, "pushTitle");
        if given.is_empty() { "AIBuddy-Panel".to_string() } else { given }
    };
    let mut payload = json!({
        "title": notify_title,
        "body": message_text(title, body),
        "timeSensitive": config.get("pushTimeSensitive").and_then(Value::as_bool).unwrap_or(true),
    });
    if let Some(map) = payload.as_object_mut() {
        let channel = cfg_string(config, "pushChannel");
        if !channel.is_empty() {
            map.insert("channel".to_string(), Value::String(channel));
        }
        let sound = cfg_string(config, "pushSound");
        if !sound.is_empty() {
            map.insert("sound".to_string(), Value::String(sound));
        }
    }
    send(
        http_client()
            .post(format!(
                "https://push.techulus.com/api/v1/notify/{}",
                percent_encode(&key)
            ))
            .json(&payload),
    )
    .await
}

/// **telnyx** —— Telnyx SMS API（Bearer 认证）。
/// config：`telnyxApiKey` / `telnyxPhoneNumber` / `telnyxToNumber`（必填）、
/// `telnyxMessagingProfileId`（可选）。
async fn send_telnyx(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "telnyx";
    let key = require_field(config, &["telnyxApiKey"], KIND, "telnyxApiKey")?;
    let from = require_field(config, &["telnyxPhoneNumber"], KIND, "telnyxPhoneNumber")?;
    let to = require_field(config, &["telnyxToNumber"], KIND, "telnyxToNumber")?;
    let Some(bearer) = bearer_header(&key) else {
        return Err("telnyx 渠道的 apiKey 含非法字符".to_string());
    };
    let mut payload = json!({
        "from": from,
        "to": to,
        "text": message_text(title, body),
    });
    let profile = cfg_string(config, "telnyxMessagingProfileId");
    if !profile.is_empty() {
        if let Some(map) = payload.as_object_mut() {
            map.insert("messaging_profile_id".to_string(), Value::String(profile));
        }
    }
    send(
        http_client()
            .post("https://api.telnyx.com/v2/messages")
            .header(reqwest::header::AUTHORIZATION, bearer)
            .json(&payload),
    )
    .await
}

/// **teltonika** —— Teltonika 路由器 RMS 短信网关（先登录拿 token 再发信）。
/// config：`teltonikaUrl` / `teltonikaUsername` / `teltonikaPassword`（必填）、
/// `teltonikaModem` / `teltonikaPhoneNumber`（必填）。源码的
/// `teltonikaUnsafeTls` 不移植（共享 Client 没法按请求关证书校验）。
async fn send_teltonika(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "teltonika";
    let url = require_url(config, &["teltonikaUrl"], KIND, "teltonikaUrl")?;
    let origin = url_origin(&url).ok_or_else(|| format!("{KIND} 渠道的 teltonikaUrl 无效"))?;
    let username = require_field(config, &["teltonikaUsername"], KIND, "teltonikaUsername")?;
    let password = require_field(config, &["teltonikaPassword"], KIND, "teltonikaPassword")?;
    let modem = require_field(config, &["teltonikaModem"], KIND, "teltonikaModem")?;
    let phone = require_field(config, &["teltonikaPhoneNumber"], KIND, "teltonikaPhoneNumber")?;
    // 登录拿 access token（token 5 分钟过期，照源码每次都新登一次）
    let login_text = send_and_read(
        http_client()
            .post(format!("{origin}/api/login"))
            .json(&json!({ "username": username, "password": password })),
    )
    .await?;
    let login = parse_json(&login_text).ok_or_else(|| "teltonika 登录响应无法解析".to_string())?;
    if !login.get("success").and_then(Value::as_bool).unwrap_or(false) {
        return Err(format!("teltonika 登录失败: {}", json_text(&login, "error")));
    }
    // token 在响应的 data.token 里（照源码 loginResp.data.data.token）
    let token = login
        .get("data")
        .map(|data| json_text(data, "token"))
        .unwrap_or_default();
    if token.is_empty() {
        return Err("teltonika 登录成功但没有返回 token".to_string());
    }
    let Some(bearer) = bearer_header(&token) else {
        return Err("teltonika 返回的 token 含非法字符".to_string());
    };
    let message: String = message_text(title, body).chars().take(159).collect();
    let payload = json!({
        "data": {
            "modem": modem,
            "number": phone,
            "message": message,
        },
    });
    let sms_text = send_and_read(
        http_client()
            .post(format!("{origin}/api/messages/actions/send"))
            .header(reqwest::header::AUTHORIZATION, bearer)
            .json(&payload),
    )
    .await?;
    let sms = parse_json(&sms_text).ok_or_else(|| "teltonika 发送响应无法解析".to_string())?;
    if !sms.get("success").and_then(Value::as_bool).unwrap_or(false) {
        return Err(format!("teltonika 发送失败: {}", json_text(&sms, "error")));
    }
    Ok(())
}

/// **threema** —— Threema basic 模式（send_simple，表单提交）。
/// config：`threemaSenderIdentity` / `threemaSecret` / `threemaRecipient`（必填）、
/// `threemaRecipientType`（identity / phone / email）。
async fn send_threema(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "threema";
    let from = require_field(config, &["threemaSenderIdentity"], KIND, "threemaSenderIdentity")?;
    let secret = require_field(config, &["threemaSecret"], KIND, "threemaSecret")?;
    let recipient = require_field(config, &["threemaRecipient"], KIND, "threemaRecipient")?;
    let recipient_key = match cfg_string(config, "threemaRecipientType").as_str() {
        "identity" => "to",
        "phone" => "phone",
        "email" => "email",
        other => return Err(format!("threema 渠道的 threemaRecipientType 无效: {other}")),
    };
    let form = vec![
        ("from".to_string(), from),
        ("secret".to_string(), secret),
        ("text".to_string(), message_text(title, body)),
        (recipient_key.to_string(), recipient),
    ];
    send(
        http_client()
            .post("https://msgapi.threema.ch/send_simple")
            .form(&form),
    )
    .await
}

/// **turbosmtp** —— TurboSMTP 邮件 API（consumerKey / consumerSecret 头）。
/// config：`turbosmtpConsumerKey` / `turbosmtpConsumerSecret` /
/// `turbosmtpFromEmail` / `turbosmtpToEmail`（必填）、`turbosmtpRegion`
/// （eu 可选）、`turbosmtpSubject` / `turbosmtpCcEmail` / `turbosmtpBccEmail`（可选）。
async fn send_turbosmtp(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "turbosmtp";
    let consumer_key = require_field(config, &["turbosmtpConsumerKey"], KIND, "turbosmtpConsumerKey")?;
    let consumer_secret = require_field(config, &["turbosmtpConsumerSecret"], KIND, "turbosmtpConsumerSecret")?;
    let from = require_field(config, &["turbosmtpFromEmail"], KIND, "turbosmtpFromEmail")?;
    let to = require_field(config, &["turbosmtpToEmail"], KIND, "turbosmtpToEmail")?;
    let (Some(key_header), Some(secret_header)) = (
        header_value(&consumer_key),
        header_value(&consumer_secret),
    ) else {
        return Err("turbosmtp 渠道的 consumerKey / consumerSecret 含非法字符".to_string());
    };
    let host = if cfg_string(config, "turbosmtpRegion") == "eu" {
        "api.eu.turbo-smtp.com"
    } else {
        "api.turbo-smtp.com"
    };
    let subject = {
        let given = cfg_string(config, "turbosmtpSubject");
        if given.is_empty() { "AIBuddy Panel 通知".to_string() } else { given }
    };
    let mut payload = json!({
        "from": from,
        "to": to,
        "subject": subject,
        "content": message_text(title, body),
    });
    if let Some(map) = payload.as_object_mut() {
        let cc = split_recipients(&cfg_string(config, "turbosmtpCcEmail")).join(",");
        let bcc = split_recipients(&cfg_string(config, "turbosmtpBccEmail")).join(",");
        if !cc.is_empty() {
            map.insert("cc".to_string(), Value::String(cc));
        }
        if !bcc.is_empty() {
            map.insert("bcc".to_string(), Value::String(bcc));
        }
    }
    send(
        http_client()
            .post(format!("https://{host}/api/v2/mail/send"))
            .header("consumerKey", key_header)
            .header("consumerSecret", secret_header)
            .json(&payload),
    )
    .await
}

/// **twilio** —— Twilio SMS（Basic 认证，表单提交）。
/// config：`twilioAccountSID` / `twilioAuthToken` / `twilioFromNumber` /
/// `twilioToNumber`（必填）、`twilioApiKey`（可选，填了替代 SID 做认证）、
/// `twilioMessagingServiceSID`（可选）。
async fn send_twilio(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "twilio";
    let account = require_field(config, &["twilioAccountSID"], KIND, "twilioAccountSID")?;
    let auth_token = require_field(config, &["twilioAuthToken"], KIND, "twilioAuthToken")?;
    let from = require_field(config, &["twilioFromNumber"], KIND, "twilioFromNumber")?;
    let to = require_field(config, &["twilioToNumber"], KIND, "twilioToNumber")?;
    let api_user = cfg_first_scalar(config, &["twilioApiKey"]);
    let api_user = if api_user.is_empty() { account.clone() } else { api_user };
    let mut form = vec![
        ("To".to_string(), to),
        ("From".to_string(), from),
        ("Body".to_string(), message_text(title, body)),
    ];
    let messaging_sid = cfg_string(config, "twilioMessagingServiceSID");
    if !messaging_sid.is_empty() {
        form.push(("MessagingServiceSid".to_string(), messaging_sid));
    }
    send(
        http_client()
            .post(format!(
                "https://api.twilio.com/2010-04-01/Accounts/{}/Messages.json",
                percent_encode(&account)
            ))
            .basic_auth(api_user, Some(auth_token))
            .form(&form),
    )
    .await
}

/// **vk** —— VK messages.send（access_token 表单提交）。
/// config：`vkAccessToken` / `vkPeerId`（必填）、`vkApiVersion`（可选）、
/// `vkDontParseLinks`（布尔，可选）。
async fn send_vk(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "vk";
    let token = require_field(config, &["vkAccessToken"], KIND, "vkAccessToken")?;
    let peer_id = require_field(config, &["vkPeerId"], KIND, "vkPeerId")?;
    let version = {
        let given = cfg_string(config, "vkApiVersion");
        if given.is_empty() { "5.131".to_string() } else { given }
    };
    let form = [
        ("access_token", token),
        ("v", version),
        ("peer_id", peer_id),
        ("message", message_text(title, body)),
        ("dont_parse_links", if config.get("vkDontParseLinks").and_then(Value::as_bool).unwrap_or(false) { "1".to_string() } else { "0".to_string() }),
        ("random_id", random_id_i32().to_string()),
    ];
    let text = send_and_read(http_client().post("https://api.vk.ru/method/messages.send").form(&form)).await?;
    let value = parse_json(&text).ok_or_else(|| "vk 返回了无法解析的响应".to_string())?;
    if let Some(error) = value.get("error") {
        return Err(format!(
            "vk 发送失败: {}: {}",
            json_text(error, "error_code"),
            json_text(error, "error_msg")
        ));
    }
    if value.get("response").is_none() {
        return Err("vk 返回了意外响应".to_string());
    }
    Ok(())
}

/// **vkteams** —— VK Teams（Myteam）机器人消息（GET sendText）。
/// config：`vkteamsBotToken` / `vkteamsChatId`（必填）、`vkteamsBaseUrl`
/// （可选，默认 https://myteam.mail.ru）。
async fn send_vkteams(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "vkteams";
    let token = require_field(config, &["vkteamsBotToken"], KIND, "vkteamsBotToken")?;
    let chat_id = require_field(config, &["vkteamsChatId"], KIND, "vkteamsChatId")?;
    let base = {
        let given = cfg_string(config, "vkteamsBaseUrl");
        if given.is_empty() { "https://myteam.mail.ru".to_string() } else { given }
    }
    .trim_end_matches('/')
    .to_string();
    let params = [
        ("token", token),
        ("chatId", chat_id),
        ("text", message_text(title, body)),
    ];
    let text = send_and_read(
        http_client()
            .get(format!("{base}/bot/v1/messages/sendText"))
            .query(&params),
    )
    .await?;
    // ok === false 视为业务失败（description 带原因）
    if parse_json(&text)
        .map(|value| value.get("ok").and_then(Value::as_bool) == Some(false))
        .unwrap_or(false)
    {
        return Err(format!("vkteams 发送失败: {}", truncate_text(&text, 200)));
    }
    Ok(())
}

/// **waha** —— WAHA（WhatsApp HTTP API，自建）。
/// config：`wahaApiUrl` / `wahaSession` / `wahaChatId`（必填）、`wahaApiKey`（可选）。
async fn send_waha(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "waha";
    let base = require_url(config, &["wahaApiUrl"], KIND, "wahaApiUrl")?
        .trim_end_matches('/')
        .to_string();
    let session = require_field(config, &["wahaSession"], KIND, "wahaSession")?;
    let chat_id = require_field(config, &["wahaChatId"], KIND, "wahaChatId")?;
    let payload = json!({
        "session": session,
        "chatId": chat_id,
        "text": message_text(title, body),
    });
    let mut request = http_client()
        .post(format!("{base}/api/sendText"))
        .json(&payload);
    let key = cfg_string(config, "wahaApiKey");
    if !key.is_empty() {
        if let Some(value) = header_value(&key) {
            request = request.header("X-Api-Key", value);
        }
    }
    send(request).await
}

/// **whapi** —— Whapi（WhatsApp 云端网关）。
/// config：`whapiAuthToken` / `whapiRecipient`（必填）、`whapiApiUrl`
/// （可选，默认 https://gate.whapi.cloud）。
async fn send_whapi(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "whapi";
    let token = require_field(config, &["whapiAuthToken"], KIND, "whapiAuthToken")?;
    let recipient = require_field(config, &["whapiRecipient"], KIND, "whapiRecipient")?;
    let base = {
        let given = cfg_string(config, "whapiApiUrl");
        if given.is_empty() { "https://gate.whapi.cloud".to_string() } else { given }
    };
    let Some(bearer) = bearer_header(&token) else {
        return Err("whapi 渠道的 token 含非法字符".to_string());
    };
    let payload = json!({ "to": recipient, "body": message_text(title, body) });
    send(
        http_client()
            .post(format!("{}/messages/text", base.trim_end_matches('/')))
            .header(reqwest::header::AUTHORIZATION, bearer)
            .json(&payload),
    )
    .await
}

/// **wpush** —— WPush（推送达）。
/// config：`wpushAPIkey`（必填）、`wpushChannel`（可选）。
async fn send_wpush(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "wpush";
    let key = require_field(config, &["wpushAPIkey"], KIND, "wpushAPIkey")?;
    let payload = json!({
        "title": title,
        "content": body,
        "apikey": key,
        "channel": cfg_string(config, "wpushChannel"),
    });
    let text = send_and_read(http_client().post("https://api.wpush.cn/api/v1/send").json(&payload)).await?;
    let code = parse_json(&text).and_then(|value| value.get("code").cloned());
    let ok = match code {
        Some(Value::Number(number)) => number.as_i64() == Some(0),
        Some(Value::String(text)) => text == "0",
        _ => false,
    };
    if !ok {
        return Err(format!("wpush 发送失败: {}", truncate_text(&text, 200)));
    }
    Ok(())
}

/// **wxpusher** —— WxPusher（微信推送，simple-push 接口，SPT 逗号分隔、
/// 每请求最多 10 个，超出分批）。config：`wxpusherSPT`（必填）。
async fn send_wxpusher(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "wxpusher";
    let raw = require_field(config, &["wxpusherSPT"], KIND, "wxpusherSPT")?;
    let spts: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    if spts.is_empty() {
        return Err("wxpusher 渠道缺少 SPT".to_string());
    }
    let summary: String = title.chars().take(100).collect();
    for batch in spts.chunks(10) {
        let payload = json!({
            "content": body,
            "summary": summary,
            "contentType": 1,
            "sptList": batch,
        });
        let text = send_and_read(
            http_client()
                .post("https://wxpusher.zjiecode.com/api/send/message/simple-push")
                .json(&payload),
        )
        .await?;
        let code = parse_json(&text).and_then(|value| value.get("code").cloned());
        let ok = match code {
            Some(Value::Number(number)) => number.as_i64() == Some(1000),
            Some(Value::String(text)) => text == "1000",
            _ => false,
        };
        if !ok {
            return Err(format!("wxpusher 发送失败: {}", truncate_text(&text, 200)));
        }
    }
    Ok(())
}

/// **yzj** —— 一站式工作 YZJ 群机器人。
/// config：`yzjWebHookUrl` / `yzjToken`（必填）。
async fn send_yzj(config: &Value, title: &str, body: &str) -> Result<(), String> {
    const KIND: &str = "yzj";
    let url = require_url(config, &["yzjWebHookUrl"], KIND, "yzjWebHookUrl")?;
    let token = require_field(config, &["yzjToken"], KIND, "yzjToken")?;
    let payload = json!({ "content": message_text(title, body) });
    let text = send_and_read(
        http_client()
            .post(with_query(&url, "yzjtype", "0"))
            .query(&[("yzjtoken", token)])
            .json(&payload),
    )
    .await?;
    let success = parse_json(&text)
        .and_then(|value| value.get("success").and_then(Value::as_bool))
        .unwrap_or(false);
    if !success {
        return Err(format!("yzj 发送失败: {}", truncate_text(&text, 200)));
    }
    Ok(())
}

/// **zohocliq** —— Zoho Cliq 入站 webhook。
/// config：`webhookUrl`（必填）。
async fn send_zohocliq(config: &Value, title: &str, body: &str) -> Result<(), String> {
    let url = require_url(config, &["webhookUrl"], "zohocliq", "webhookUrl")?;
    let text = format!("Notification\n*Description:* {}", message_text(title, body));
    let payload = json!({ "text": text });
    send(http_client().post(&url).json(&payload)).await
}

// ─── 分发与测试 ─────────────────────────────────────────────────

/// 单渠道发送（分发与测试共用）：按 `type` 找到实现并执行。
async fn send_channel(channel: &NotifyChannel, title: &str, body: &str) -> Result<(), String> {
    let config = &channel.config;
    match channel.kind.as_str() {
        KIND_WEBHOOK => send_webhook(config, title, body).await,
        KIND_WEBHOOK_CUSTOM => send_webhook_custom(config, title, body).await,
        KIND_TELEGRAM => send_telegram(config, title, body).await,
        KIND_DISCORD => send_discord(config, title, body).await,
        KIND_SLACK => send_slack(config, title, body).await,
        KIND_DINGTALK => send_dingtalk(config, title, body).await,
        KIND_FEISHU => send_feishu(config, title, body).await,
        KIND_WECOM => send_wecom(config, title, body).await,
        KIND_BARK => send_bark(config, title, body).await,
        KIND_GOTIFY => send_gotify(config, title, body).await,
        KIND_PUSHOVER => send_pushover(config, title, body).await,
        KIND_PUSHBULLET => send_pushbullet(config, title, body).await,
        KIND_NTFY => send_ntfy(config, title, body).await,
        KIND_TEAMS => send_teams(config, title, body).await,
        KIND_SERVERCHAN => send_serverchan(config, title, body).await,
        KIND_LINE => send_line(config, title, body).await,
        // ── Uptime-Kuma 全量移植的渠道（与 KNOWN_KINDS 的登记顺序一致）──
        "360messenger" => send_360messenger(config, title, body).await,
        "46elks" => send_46elks(config, title, body).await,
        "alerta" => send_alerta(config, title, body).await,
        "alertnow" => send_alertnow(config, title, body).await,
        "amootsms" => send_amootsms(config, title, body).await,
        "bale" => send_bale(config, title, body).await,
        "bearsms" => send_bearsms(config, title, body).await,
        "bitrix24" => send_bitrix24(config, title, body).await,
        "brevo" => send_brevo(config, title, body).await,
        "callmebot" => send_callmebot(config, title, body).await,
        "cellsynt" => send_cellsynt(config, title, body).await,
        "clicksendsms" => send_clicksendsms(config, title, body).await,
        "clickup" => send_clickup(config, title, body).await,
        "egosms" => send_egosms(config, title, body).await,
        "evolution" => send_evolution(config, title, body).await,
        "flashduty" => send_flashduty(config, title, body).await,
        "flowtriq" => send_flowtriq(config, title, body).await,
        "fluxer" => send_fluxer(config, title, body).await,
        "freemobile" => send_freemobile(config, title, body).await,
        "goalert" => send_goalert(config, title, body).await,
        "googlechat" => send_googlechat(config, title, body).await,
        "googlesheets" => send_googlesheets(config, title, body).await,
        "gorush" => send_gorush(config, title, body).await,
        "grafanaoncall" => send_grafanaoncall(config, title, body).await,
        "gtxmessaging" => send_gtxmessaging(config, title, body).await,
        "halopsa" => send_halopsa(config, title, body).await,
        "heiioncall" => send_heiioncall(config, title, body).await,
        "homeassistant" => send_homeassistant(config, title, body).await,
        "indigo" => send_indigo(config, title, body).await,
        "jirasm" => send_jirasm(config, title, body).await,
        "keep" => send_keep(config, title, body).await,
        "kook" => send_kook(config, title, body).await,
        "lunasea" => send_lunasea(config, title, body).await,
        "matrix" => send_matrix(config, title, body).await,
        "mattermost" => send_mattermost(config, title, body).await,
        "max" => send_max(config, title, body).await,
        "milky" => send_milky(config, title, body).await,
        "nextcloudtalk" => send_nextcloudtalk(config, title, body).await,
        "notifery" => send_notifery(config, title, body).await,
        "notifyapp" => send_notifyapp(config, title, body).await,
        "octopush" => send_octopush(config, title, body).await,
        "onebot" => send_onebot(config, title, body).await,
        "onechat" => send_onechat(config, title, body).await,
        "onesender" => send_onesender(config, title, body).await,
        "ooredoo" => send_ooredoo(config, title, body).await,
        "openwa" => send_openwa(config, title, body).await,
        "opsgenie" => send_opsgenie(config, title, body).await,
        "pagerduty" => send_pagerduty(config, title, body).await,
        "pagertree" => send_pagertree(config, title, body).await,
        "pinglet" => send_pinglet(config, title, body).await,
        "plivo" => send_plivo(config, title, body).await,
        "promosms" => send_promosms(config, title, body).await,
        "pumble" => send_pumble(config, title, body).await,
        "pushdeer" => send_pushdeer(config, title, body).await,
        "pushplus" => send_pushplus(config, title, body).await,
        "pushy" => send_pushy(config, title, body).await,
        "resend" => send_resend(config, title, body).await,
        "rocketchat" => send_rocketchat(config, title, body).await,
        "sendgrid" => send_sendgrid(config, title, body).await,
        "serwersms" => send_serwersms(config, title, body).await,
        "sevenio" => send_sevenio(config, title, body).await,
        "signal" => send_signal(config, title, body).await,
        "signalgrid" => send_signalgrid(config, title, body).await,
        "signl4" => send_signl4(config, title, body).await,
        "smsgateway" => send_smsgateway(config, title, body).await,
        "smsir" => send_smsir(config, title, body).await,
        "smsmanager" => send_smsmanager(config, title, body).await,
        "smspartner" => send_smspartner(config, title, body).await,
        "smsplanet" => send_smsplanet(config, title, body).await,
        "smsc" => send_smsc(config, title, body).await,
        "smseagle" => send_smseagle(config, title, body).await,
        "splunk" => send_splunk(config, title, body).await,
        "spugpush" => send_spugpush(config, title, body).await,
        "squadcast" => send_squadcast(config, title, body).await,
        "stackfield" => send_stackfield(config, title, body).await,
        "techuluspush" => send_techuluspush(config, title, body).await,
        "telnyx" => send_telnyx(config, title, body).await,
        "teltonika" => send_teltonika(config, title, body).await,
        "threema" => send_threema(config, title, body).await,
        "turbosmtp" => send_turbosmtp(config, title, body).await,
        "twilio" => send_twilio(config, title, body).await,
        "vk" => send_vk(config, title, body).await,
        "vkteams" => send_vkteams(config, title, body).await,
        "waha" => send_waha(config, title, body).await,
        "whapi" => send_whapi(config, title, body).await,
        "wpush" => send_wpush(config, title, body).await,
        "wxpusher" => send_wxpusher(config, title, body).await,
        "yzj" => send_yzj(config, title, body).await,
        "zohocliq" => send_zohocliq(config, title, body).await,
        other => Err(format!("未知的通知渠道类型: {other}")),
    }
}

/// 把一条事件**并发**发给所有启用渠道（`JoinSet` 并发、各自记日志、失败不抛）。
///
/// `event` 是事件的机器名（如 `account_offline` / `test`），只用于日志定位；
/// 标题与正文才是渠道真正收到的东西。立即返回，发送在后台任务里完成。
pub fn dispatch(event: &str, title: &str, body: &str) {
    let targets: Vec<NotifyChannel> = channels().into_iter().filter(|channel| channel.enabled).collect();
    if targets.is_empty() {
        return;
    }
    let event = event.to_string();
    let title = title.to_string();
    let body = body.to_string();
    crate::spawn_task(async move {
        let mut set = tokio::task::JoinSet::new();
        for channel in targets {
            let event = event.clone();
            let title = title.clone();
            let body = body.clone();
            set.spawn(async move {
                let label = channel.label();
                if !is_known_kind(&channel.kind) {
                    logging::log(
                        "[Notify]",
                        &format!("⚠️ 跳过未知类型的通知渠道「{label}」: {}", channel.kind),
                    );
                    return;
                }
                match send_channel(&channel, &title, &body).await {
                    Ok(()) => logging::log("[Notify]", &format!("✅ 通知已发送[{event}]: {label}")),
                    Err(error) => {
                        logging::log("[Notify]", &format!("❌ 通知发送失败[{event}]: {label}: {error}"))
                    }
                }
            });
        }
        // 只回收 JoinError（任务 panic / 被取消）；发送成败已在上面各记各的
        while let Some(joined) = set.join_next().await {
            if let Err(error) = joined {
                logging::log("[Notify]", &format!("❌ 通知任务异常: {error}"));
            }
        }
    });
}

/// 发一条测试通知到**指定渠道**（`POST /api/notify/test` 的执行体）：
/// 同步等待结果，成败与错误文案直接回给界面。
pub async fn test_channel(channel: &NotifyChannel) -> Result<(), String> {
    if !is_known_kind(&channel.kind) {
        return Err(format!("未知的通知渠道类型: {}", channel.kind));
    }
    send_channel(
        channel,
        "AIBuddy Panel 测试通知",
        "收到这条消息即说明该通知渠道配置正确。",
    )
    .await
}

// ─── 账号异常告警（功能三的公共入口）────────────────────────────

/// 告警设置（配置顶层键 `notifyAlerts`）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlertSettings {
    /// **总开关**：关着时任何账号事件都不出网（界面上「账号异常告警」的主开关）。
    /// 与三类事件开关分开：静默期想整体停一停、或只想先配好渠道再启用，
    /// 一个总闸比逐类去点更不容易漏。
    pub enabled: bool,
    /// 429 降级事件
    pub degrade: bool,
    /// 账号掉线 / 转发失败
    pub account_offline: bool,
    /// 探活 / 自动维护停用账号
    pub health_disabled: bool,
    /// 静默时段开始（本地时区 `HH:mm`；空串 = 不静默）
    pub quiet_start: String,
    /// 静默时段结束（同上；与 quietStart 相等也视为不静默）
    pub quiet_end: String,
}

impl Default for AlertSettings {
    /// 全关 + 不静默：**默认不出网**。告警是「额外行为」，不该在用户没配置
    /// 通知渠道 / 没开开关的时候悄悄把账号事件往外部地址发。
    fn default() -> Self {
        Self {
            enabled: false,
            degrade: false,
            account_offline: false,
            health_disabled: false,
            quiet_start: String::new(),
            quiet_end: String::new(),
        }
    }
}

/// 读告警设置（宽容：缺字段走默认值，非 bool 按「没配」处理）
pub fn alert_settings() -> AlertSettings {
    let raw = config::current().raw().get(KEY_ALERTS).cloned();
    let Some(object) = raw.and_then(|value| value.as_object().cloned()) else {
        return AlertSettings::default();
    };
    let bool_of = |key: &str, default: bool| object.get(key).and_then(Value::as_bool).unwrap_or(default);
    let text_of = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    AlertSettings {
        enabled: bool_of("enabled", false),
        degrade: bool_of("degrade", false),
        account_offline: bool_of("accountOffline", false),
        health_disabled: bool_of("healthDisabled", false),
        quiet_start: text_of("quietStart"),
        quiet_end: text_of("quietEnd"),
    }
}

/// 保存告警设置（整份覆盖；调用方先读 [`alert_settings`] 改完再存）
pub fn save_alert_settings(settings: &AlertSettings) -> bool {
    config::update_raw_field(
        KEY_ALERTS,
        json!({
            "enabled": settings.enabled,
            "degrade": settings.degrade,
            "accountOffline": settings.account_offline,
            "healthDisabled": settings.health_disabled,
            "quietStart": settings.quiet_start,
            "quietEnd": settings.quiet_end,
        }),
    )
}

/// 解析 `HH:mm`（24 小时制；容忍 `9:05` 这种单数字小时）。
/// API 保存侧的校验与静默判定共用这一份，口径不会分叉。
pub fn parse_hhmm(text: &str) -> Option<(u32, u32)> {
    let (hour, minute) = text.trim().split_once(':')?;
    let hour: u32 = hour.trim().parse().ok()?;
    let minute: u32 = minute.trim().parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some((hour, minute))
}

/// 当前是否处于静默时段（本地时区 —— 静默是「人的作息」，跟面板机器走）。
/// 只配了一端、两端相等、或解析失败都视为不静默：静默漏掉的告警只进日志，
/// 配错了静默导致告警**永远不发**才是事故。
fn in_quiet_hours(settings: &AlertSettings) -> bool {
    let Some((start_h, start_m)) = parse_hhmm(&settings.quiet_start) else {
        return false;
    };
    let Some((end_h, end_m)) = parse_hhmm(&settings.quiet_end) else {
        return false;
    };
    let start = start_h * 60 + start_m;
    let end = end_h * 60 + end_m;
    if start == end {
        return false;
    }
    let now = chrono::Local::now();
    let minutes = u32::from(now.hour()) * 60 + u32::from(now.minute());
    if start < end {
        // 同日时段（如 02:00-07:00）
        (start..end).contains(&minutes)
    } else {
        // 跨夜时段（如 22:00-07:00）
        minutes >= start || minutes < end
    }
}

/// 账号异常事件的公共入口（**事件源埋点调这个**，转发到通知渠道）。
///
/// ── 行为分三种 ──────────────────────────────────────────────
///   - 该事件的开关没开：什么都不做（事件源自己通常已经打过日志，这里再打
///     一遍只会让运行日志出现成对的重复行）；
///   - 开了但处于静默时段：只记一行运行日志（`[Notify]`），不发送；
///   - 开了且不在静默时段：记日志 + [`dispatch`] 并发推送全部启用渠道。
/// 事件种类（`kind`）不在 [`EVENT_DEGRADE`] / [`EVENT_ACCOUNT_OFFLINE`] /
/// [`EVENT_HEALTH_DISABLED`] 之列时同样只记日志 —— 新增事件种类先在这里
/// 登记开关，避免「埋点随手传个串」绕过开关直接出网。
pub fn notify_account_event(provider: &str, account: &str, kind: &str, detail: &str) {
    let title = match kind {
        EVENT_DEGRADE => "429 降级",
        EVENT_ACCOUNT_OFFLINE => "账号掉线",
        EVENT_HEALTH_DISABLED => "探活自动禁用",
        _ => {
            logging::log(
                "[Notify]",
                &format!("⚠️ 未登记的账号事件类型（仅记录）: {kind} — {provider}/{account}: {detail}"),
            );
            return;
        }
    };
    let settings = alert_settings();
    // 总开关先判：关着时连事件分派的日志都不打（与「没开的事件」同一静默度 ——
    // 事件源自己通常已经打过业务日志，这里再打只会成对重复）
    if !settings.enabled {
        return;
    }
    let enabled = match kind {
        EVENT_DEGRADE => settings.degrade,
        EVENT_ACCOUNT_OFFLINE => settings.account_offline,
        _ => settings.health_disabled,
    };
    if !enabled {
        return;
    }
    let text = format!("提供商 {provider} 的账号「{account}」: {detail}");
    if in_quiet_hours(&settings) {
        logging::log("[Notify]", &format!("🔇 静默时段，仅记录告警[{title}]: {text}"));
        return;
    }
    logging::log("[Notify]", &format!("🔔 告警[{title}]: {text}，正在推送通知渠道"));
    dispatch(kind, &format!("AIBuddy Panel {title}"), &text);
}

/// 归一 API 传入的一条渠道（保存侧）：补 id、归一 kind、保底 config。
/// 校验（type 认不认识、config 是否对象）由 `api::notify_api` 做，这里只做
/// 「补默认值」—— 两者分开是为了让 core 的这条函数可以被非 HTTP 路径复用。
pub fn normalize_channel(kind: &str, name: &str, enabled: bool, config: Value) -> NotifyChannel {
    NotifyChannel {
        id: generate_id(),
        name: name.trim().chars().take(100).collect(),
        kind: kind.trim().to_lowercase(),
        enabled,
        config: match config {
            Value::Null => Value::Object(Map::new()),
            other => other,
        },
    }
}
