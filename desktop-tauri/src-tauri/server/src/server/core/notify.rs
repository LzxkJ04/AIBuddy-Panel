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
//! 16 种渠道全是出站 HTTP，共用一个带 10 秒超时的 Client（连接池顺带复用）。
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

// ── 渠道类型常量（`type` 字段的合法取值，也是 KNOWN_KINDS 的唯一来源）──
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

/// 全部认识的渠道类型（未在表中的 `type`：分发时记日志跳过、保存时 400）
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
