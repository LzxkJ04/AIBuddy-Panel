//! 通知渠道与账号异常告警的管理接口：
//!
//! - `GET    /api/notify/channels`          渠道列表（`config` 原样带出）
//! - `POST   /api/notify/channels`          新增 `{name?, type, enabled?, config?}`
//! - `PUT    /api/notify/channels/{id}`     改渠道（部分字段：缺 = 不动）
//! - `DELETE /api/notify/channels/{id}`
//! - `POST   /api/notify/test`              发测试通知 `{id}` 或 `{type, config, name?}`
//! - `GET    /api/notify/alerts`            告警设置回显
//! - `PUT    /api/notify/alerts`            告警设置 `{enabled?, events?, quietStart?, quietEnd?}`
//!
//! ── 分工（与 `core::notify` 的边界）─────────────────────────
//! 存取、并发分发、16 种渠道的发送实现都在 `core::notify`；本文件只做
//! HTTP 层的三件事：**校验**（type 认不认识、config 是不是对象、静默时段
//! 是不是合法的 `HH:mm`）、**改列表**（按 id 找到再改/删）、**调测试**。
//! 发送期的必填校验（url / token 等）刻意不在这里做 —— 渠道字段集随 type
//! 走、逐类型抄写校验会有 16 份漂移副本，而「测试」按钮就是校验入口
//! （错误文案直接回给界面，见 `core::notify` 模块头的说明）。
//!
//! ── 告警设置的 API 形态与存储形态 ───────────────────────────
//! API 层是 `{enabled, events: {onDegraded, onOffline, onProbeDisabled},
//! quietStart, quietEnd}`（界面一张卡片一个总闸 + 三个事件勾选）；存储是
//! **扁平**的 `{enabled, degrade, accountOffline, healthDisabled, quietStart,
//! quietEnd}`（与配置里其它布尔开关同一风格）。两层各自稳定，映射只在本
//! 文件的 `alerts_json` / `put_alerts` 各一处 —— 事件名 ↔ 存储键的对账表
//! 不散落。三档事件名与 `core::notify` 的三个 `EVENT_*` 常量一一对应。
//!
//! ── 静默时段（quietStart / quietEnd）────────────────────────
//! `HH:mm`（本地时区，容忍 `9:05`）；空串 / `null` = 不静默。保存侧用与
//! 判定同一份 `core::notify::parse_hhmm` 校验 —— 两处口径不会分叉。静默期
//! 内的事件只记日志不推送（行为见 `core::notify::notify_account_event`）。

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::core::notify::{
    self, AlertSettings, NotifyChannel, MAX_CHANNELS,
};
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

// ─── 渠道管理 ───────────────────────────────────────────────────

/// GET /api/notify/channels
pub async fn get_channels(State(_state): State<ServerState>) -> Response {
    ok_json(channels_json())
}

/// POST /api/notify/channels —— 新增渠道
///
/// 保存侧只校验「type 必填且认识、config 是对象」；字段级校验在发送（测试）
/// 时报错，理由见模块头。
pub async fn create_channel(State(_state): State<ServerState>, body: Bytes) -> Response {
    let object = match body_object(&body) {
        Ok(object) => object,
        Err(response) => return response,
    };
    let kind = match require_kind(object.get("type")) {
        Ok(kind) => kind,
        Err(response) => return response,
    };
    let config = match parse_config(object.get("config")) {
        Ok(config) => config,
        Err(response) => return response,
    };
    let name = object.get("name").and_then(Value::as_str).unwrap_or("");
    let enabled = object.get("enabled").and_then(Value::as_bool).unwrap_or(true);

    let mut list = notify::channels();
    if list.len() >= MAX_CHANNELS {
        return errors::management_error(400, format!("通知渠道最多 {MAX_CHANNELS} 个"));
    }
    let channel = notify::normalize_channel(&kind, name, enabled, config);
    list.push(channel.clone());
    if !notify::save_channels(&list) {
        return errors::management_error(500, "保存通知渠道失败");
    }
    logging::log("[Notify]", &format!("✅ 新增通知渠道「{}」({})", channel.label(), channel.kind));
    let mut payload = channels_json();
    if let Some(map) = payload.as_object_mut() {
        map.insert("created".to_string(), channel.public_json());
    }
    ok_json(payload)
}

/// PUT /api/notify/channels/{id} —— 改渠道（部分字段：键缺失 = 不动）
pub async fn update_channel(
    State(_state): State<ServerState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let object = match body_object(&body) {
        Ok(object) => object,
        Err(response) => return response,
    };
    let mut list = notify::channels();
    let Some(channel) = list.iter_mut().find(|channel| channel.id == id) else {
        return errors::management_error(404, "通知渠道不存在");
    };
    // type / config 从严（给了就必须合法，否则 400 整体不落盘）；
    // name / enabled 从宽（与 keys_api 的 PATCH 同一口径：非字符串 / 非布尔
    // 视为「没给」—— 旧前端多带一个错型的键不该让改名失败）
    if let Some(value) = object.get("type") {
        let kind = match require_kind(Some(value)) {
            Ok(kind) => kind,
            Err(response) => return response,
        };
        channel.kind = kind;
    }
    if let Some(value) = object.get("config") {
        channel.config = match parse_config(Some(value)) {
            Ok(config) => config,
            Err(response) => return response,
        };
    }
    if let Some(name) = object.get("name").and_then(Value::as_str) {
        channel.name = name.trim().chars().take(100).collect();
    }
    if let Some(enabled) = object.get("enabled").and_then(Value::as_bool) {
        channel.enabled = enabled;
    }
    let label = channel.label();
    if !notify::save_channels(&list) {
        return errors::management_error(500, "保存通知渠道失败");
    }
    logging::log("[Notify]", &format!("通知渠道「{label}」已更新"));
    ok_json(channels_json())
}

/// DELETE /api/notify/channels/{id}
pub async fn delete_channel(State(_state): State<ServerState>, Path(id): Path<String>) -> Response {
    let mut list = notify::channels();
    let Some(position) = list.iter().position(|channel| channel.id == id) else {
        return errors::management_error(404, "通知渠道不存在");
    };
    let removed = list.remove(position);
    if !notify::save_channels(&list) {
        return errors::management_error(500, "保存通知渠道失败");
    }
    logging::log("[Notify]", &format!("通知渠道「{}」已删除", removed.label()));
    ok_json(channels_json())
}

/// POST /api/notify/test —— 发一条测试通知
///
/// 两种寻址：`{id}` 测**已保存**的渠道；`{type, config, name?}` 测**还没保存**
/// 的草稿（新建表单里点「测试」不必先落库）。两者都没有 → 400。
/// 同步等待结果：成败与错误文案直接回给界面（这里是渠道配置的校验入口，
/// 见模块头）。
pub async fn test_channel(State(_state): State<ServerState>, body: Bytes) -> Response {
    let object = match body_object(&body) {
        Ok(object) => object,
        Err(response) => return response,
    };
    let channel = match resolve_test_target(&object) {
        Ok(channel) => channel,
        Err(response) => return response,
    };
    match notify::test_channel(&channel).await {
        Ok(()) => ok_json(json!({
            "success": true,
            "message": format!("测试通知已发送到「{}」", channel.label()),
        })),
        Err(message) => errors::management_error(400, message),
    }
}

// ─── 告警设置 ───────────────────────────────────────────────────

/// GET /api/notify/alerts
pub async fn get_alerts(State(_state): State<ServerState>) -> Response {
    ok_json(alerts_json(&notify::alert_settings()))
}

/// PUT /api/notify/alerts —— body `{enabled?, events?, quietStart?, quietEnd?}`
///
/// 部分更新（键缺失 = 不动，与 `/api/probe/settings` 同一口径）：
///   - `events` 里三档事件是严格布尔（给了就必须是 bool，防 `"true"` 被
///     静默忽略后用户以为开了）；`events: null` = 三档都不动；
///   - `quietStart` / `quietEnd`：`null` = 清除（不静默），字符串必须是
///     `HH:mm`（空串同清除）；非法整体不落盘。
pub async fn put_alerts(State(_state): State<ServerState>, body: Bytes) -> Response {
    let object = match body_object(&body) {
        Ok(object) => object,
        Err(response) => return response,
    };
    let mut settings = notify::alert_settings();
    if let Some(value) = object.get("enabled") {
        settings.enabled = match value.as_bool() {
            Some(enabled) => enabled,
            None => return errors::management_error(400, "enabled 必须是布尔值"),
        };
    }
    if let Some(value) = object.get("events") {
        // null = 这一项不动（整表回传时未填项常见为 null，与 put_retry 同一口径）
        if !value.is_null() {
            let Some(events) = value.as_object() else {
                return errors::management_error(400, "events 必须是 JSON 对象或 null");
            };
            for (key, slot) in [
                ("onDegraded", &mut settings.degrade),
                ("onOffline", &mut settings.account_offline),
                ("onProbeDisabled", &mut settings.health_disabled),
            ] {
                if let Some(flag) = events.get(key) {
                    *slot = match flag.as_bool() {
                        Some(flag) => flag,
                        None => return errors::management_error(400, format!("events.{key} 必须是布尔值")),
                    };
                }
            }
        }
    }
    if let Some(value) = object.get("quietStart") {
        settings.quiet_start = match quiet_time("quietStart", value) {
            Ok(text) => text,
            Err(response) => return response,
        };
    }
    if let Some(value) = object.get("quietEnd") {
        settings.quiet_end = match quiet_time("quietEnd", value) {
            Ok(text) => text,
            Err(response) => return response,
        };
    }
    if !notify::save_alert_settings(&settings) {
        // 内存快照已更新（本次运行仍生效），但重启后会回到旧值 —— 必须让
        // 用户知道，理由同 retry_api 的写盘失败分支
        logging::log("[Notify]", "⚠️ 告警设置写盘失败，本次运行内仍生效");
    }
    logging::log(
        "[Notify]",
        &format!(
            "账号异常告警已更新: 总开关 {}，事件（降级 {} / 掉线 {} / 探活禁用 {}），静默 {}-{}",
            bool_text(settings.enabled),
            bool_text(settings.degrade),
            bool_text(settings.account_offline),
            bool_text(settings.health_disabled),
            if settings.quiet_start.is_empty() { "无" } else { &settings.quiet_start },
            if settings.quiet_end.is_empty() { "无" } else { &settings.quiet_end },
        ),
    );
    ok_json(alerts_json(&settings))
}

// ─── 内部工具 ───────────────────────────────────────────────────

/// 渠道列表的响应体（GET / POST / PUT / DELETE 共用；`knownTypes` 是类型
/// 下拉的候选表 —— 与 keys_api 的 `providers` 同一思路：前端不烤写死清单）
fn channels_json() -> Value {
    let channels: Vec<Value> = notify::channels().iter().map(NotifyChannel::public_json).collect();
    json!({
        "channels": channels,
        "knownTypes": notify::KNOWN_KINDS,
        "maxChannels": MAX_CHANNELS,
    })
}

/// 告警设置的响应体（GET / PUT 共用；存储的扁平键在这里翻译成界面契约的
/// `events` 嵌套 —— 映射只此一处，见模块头）
fn alerts_json(settings: &AlertSettings) -> Value {
    json!({
        "enabled": settings.enabled,
        "events": {
            "onDegraded": settings.degrade,
            "onOffline": settings.account_offline,
            "onProbeDisabled": settings.health_disabled,
        },
        "quietStart": settings.quiet_start,
        "quietEnd": settings.quiet_end,
    })
}

fn bool_text(flag: bool) -> &'static str {
    if flag { "开" } else { "关" }
}

/// 请求体必须是 JSON 对象（与 keys_api::body_object 同一形状）
fn body_object(body: &Bytes) -> Result<serde_json::Map<String, Value>, Response> {
    let payload = parse_body(body).map_err(|error| errors::management_error(400, error.message))?;
    payload
        .as_object()
        .cloned()
        .ok_or_else(|| errors::management_error(400, "请求体必须是 JSON 对象"))
}

/// 渠道类型：必填、去空白、小写归一、必须在白名单里（保存与测试共用）
fn require_kind(value: Option<&Value>) -> Result<String, Response> {
    let Some(kind) = value.and_then(Value::as_str).map(str::trim).filter(|kind| !kind.is_empty()) else {
        return Err(errors::management_error(400, "type 必填（通知渠道类型）"));
    };
    let kind = kind.to_lowercase();
    if !notify::is_known_kind(&kind) {
        return Err(errors::management_error(400, format!("未知的通知渠道类型: {kind}")));
    }
    Ok(kind)
}

/// `config` 字段：缺失 / `null` = 空对象（各 provider 的字段读取对缺键
/// 本来就宽容）；给了就必须是对象 —— 填成数组 / 字符串只可能是数据坏了，
/// 静默当空对象会让用户以为配置生效了。
fn parse_config(value: Option<&Value>) -> Result<Value, Response> {
    match value {
        None | Some(Value::Null) => Ok(json!({})),
        Some(config) if config.is_object() => Ok(config.clone()),
        Some(_) => Err(errors::management_error(400, "config 必须是 JSON 对象")),
    }
}

/// 「测试」的目标：`{id}` 找已保存渠道；否则按 `{type, config, name?}`
/// 现场构造一条草稿（不落库）。两种都没给齐 → 400。
fn resolve_test_target(object: &serde_json::Map<String, Value>) -> Result<NotifyChannel, Response> {
    if let Some(id) = object.get("id").and_then(Value::as_str).map(str::trim).filter(|id| !id.is_empty()) {
        return notify::channels()
            .into_iter()
            .find(|channel| channel.id == id)
            .ok_or_else(|| errors::management_error(404, "通知渠道不存在"));
    }
    let kind = match require_kind(object.get("type")) {
        Ok(kind) => kind,
        Err(response) => return Err(response),
    };
    let config = match parse_config(object.get("config")) {
        Ok(config) => config,
        Err(response) => return Err(response),
    };
    let name = object.get("name").and_then(Value::as_str).unwrap_or("");
    Ok(notify::normalize_channel(&kind, name, true, config))
}

/// 静默时段字段：`null` / 空串 = 清除（不静默）；非空必须是合法 `HH:mm`
/// （用与静默判定同一份 `parse_hhmm`，两处口径不会分叉）。
fn quiet_time(key: &str, value: &Value) -> Result<String, Response> {
    if value.is_null() {
        return Ok(String::new());
    }
    let Some(text) = value.as_str().map(str::trim) else {
        return Err(errors::management_error(400, format!("{key} 必须是 HH:mm 字符串或 null")));
    };
    if text.is_empty() {
        return Ok(String::new());
    }
    if notify::parse_hhmm(text).is_none() {
        return Err(errors::management_error(400, format!("{key} 必须是 24 小时制的 HH:mm（如 23:30）")));
    }
    Ok(text.to_string())
}
