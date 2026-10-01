//! 网关 Key 的额度 / 有效期管理（`GET/PUT /api/keys/{id}/quota`）。
//!
//! ── 为什么单独一个端点（而不是并进 `PATCH /api/keys/{id}`）──────
//! `keys_api` 的 PATCH 是**三态部分更新**（键缺失 = 不动，见
//! `parse_allowlist` 的说明），那是为「旧版前端只发 name/enabled」的历史包袱
//! 设计的；额度 / 有效期没有这个包袱，但「缺了」到底算「清除」还是「不动」
//! 在三态语义里永远说不清。专用端点按**字段级三态**走：键缺失 = 不动、
//! `null` = 清除（不限制）、数字 = 设定 —— 「整表回传」与「只重置用量」
//! 两种提交都安全，旧版前端就算误发也不至于静默清掉用户的配额。
//! 存取原语是 `api_keys::set_quota`（存储形态与兼容性说明见 `core::api_keys`
//! 的字段注释）；已用 Token 的计量与「配额是否用尽」的判定在
//! `core::key_quota`（转发链路的消费点）。
//!
//! ── 与 PATCH 的字段关系（keys_api 的透传情况）──────────────────
//! `POST/PATCH /api/keys` **不透传** `quotaTokens` / `expiresAt`：保存体只认
//! `name / key / enabled / allowedProviders / allowedModels`（见
//! `keys_api::create_key / update_key` 与 `api_keys::add / update` 的签名），
//! 所以本端点是这两个限制的**唯一写入口** —— 界面改配额不会路过 keys_api。
//!
//! ── 动额度不动用量 ─────────────────────────────────────────
//! 已用 Token 是历史事实，改配额不清零；「重新计时」由请求体里
//! `resetUsed: true` 显式表达（清 `core::key_quota` 里这把 Key 的计量行）。
//! 校验顺序与 `retry_api::put_retry` 同一口径：先整单校验，一项非法整体
//! 不落盘。错误一律走管理信封（404 Key 不存在 / 400 参数非法），与
//! `keys_api` 的响应习惯一致。

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::core::{api_keys, key_quota};
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// GET /api/keys/{id}/quota —— 配额 / 已用 / 剩余 / 有效期的回显
pub async fn get_quota(State(_state): State<ServerState>, Path(id): Path<String>) -> Response {
    match find_entry(&id) {
        Some(entry) => ok_json(quota_json(&entry)),
        None => errors::management_error(404, "Key 不存在"),
    }
}

/// PUT /api/keys/{id}/quota —— body `{quotaTokens?, expiresAt?, resetUsed?}`
///
/// 三态：键缺失 = 不动；`null` = 清除该限制；正整数 = 设定（毫秒时间戳 /
/// Token 总量）。`resetUsed: true` 顺带把已用 Token 清零（其它取值视为不动）。
/// 返回**生效后**的全量读数（前端直接用响应刷新，不必再 GET 一次）。
pub async fn put_quota(State(_state): State<ServerState>, Path(id): Path<String>, body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };
    let Some(entry) = find_entry(&id) else {
        return errors::management_error(404, "Key 不存在");
    };

    // ── 先整单校验再写盘（一项非法整体不动，与 put_retry 同一顺序）──
    let mut quota_tokens = entry.quota_tokens;
    let mut expires_at = entry.expires_at;
    if let Some(value) = object.get("quotaTokens") {
        quota_tokens = match parse_limit_field("quotaTokens", value) {
            Ok(parsed) => parsed,
            Err(response) => return response,
        };
    }
    if let Some(value) = object.get("expiresAt") {
        expires_at = match parse_limit_field("expiresAt", value) {
            Ok(parsed) => parsed,
            Err(response) => return response,
        };
    }
    let reset_used = match object.get("resetUsed") {
        None => false,
        Some(Value::Bool(reset)) => *reset,
        Some(_) => return errors::management_error(400, "resetUsed 必须是布尔值"),
    };

    let Ok(entry) = api_keys::set_quota(&id, quota_tokens, expires_at) else {
        // find_entry 刚确认过存在，走到这里只可能是两次读盘之间被删
        return errors::management_error(404, "Key 不存在");
    };
    if reset_used {
        if let Err(message) = key_quota::reset_usage(&id) {
            // 配额已经改了、用量没清成：如实报错让前端重试，不静默吞掉 ——
            // 「界面显示已重置、判定还在按旧用量拒」比一次 500 更难排查
            return errors::management_error(500, format!("已用 Token 清零失败: {message}"));
        }
        logging::log("[Config]", &format!("API Key「{}」的已用 Token 已清零", entry.name));
    }
    logging::log(
        "[Config]",
        &format!(
            "API Key「{}」额度已更新: 配额 {}，有效期 {}",
            entry.name,
            entry
                .quota_tokens
                .map(|quota| format!("{quota} tokens"))
                .unwrap_or_else(|| "不限制".to_string()),
            entry
                .expires_at
                .map(|at| format!("{}（毫秒时间戳 {at}）", format_millis(at)))
                .unwrap_or_else(|| "不限制".to_string()),
        ),
    );
    ok_json(quota_json(&entry))
}

// ─── 内部工具 ───────────────────────────────────────────────────

/// 按 id 找一条 Key 记录（存储与形态见 `core::api_keys`）
fn find_entry(id: &str) -> Option<api_keys::ApiKeyEntry> {
    api_keys::list().into_iter().find(|entry| entry.id == id)
}

/// GET / PUT 共用的响应体：配额 / 已用 / 剩余 / 有效期。
///
/// `remainingTokens` 只在真的设了配额时给数（不限量给 `null` —— 「剩余」对
/// 不限量的 Key 是无意义读数，给 0 会让人误会已经用尽）；`expired` 是服务端
/// 的过期判定（与转发准入 `KeyScope::expired` 同一口径：时刻本身已不可用）。
fn quota_json(entry: &api_keys::ApiKeyEntry) -> Value {
    let used = key_quota::used_tokens(&entry.id);
    let remaining = entry.quota_tokens.map(|quota| (quota - used).max(0));
    json!({
        "id": entry.id,
        "name": entry.name,
        "enabled": entry.enabled,
        "quotaTokens": entry.quota_tokens,
        "usedTokens": used,
        "remainingTokens": remaining,
        "expiresAt": entry.expires_at,
        "expired": entry.expires_at.is_some_and(|at| logging::now_ms() >= at),
    })
}

/// 三态解析一个额度 / 时间戳字段：`null` = 清除、正整数（含整值浮点，
/// 容忍 JS 的 number 形态）= 设定，其余 400。写侧从严：字符串数字不收
/// （读侧宽容是历史兼容，写侧收字符串会让 `\"abc\"` 与 `123` 的边界变模糊）。
fn parse_limit_field(key: &str, value: &Value) -> Result<Option<i64>, Response> {
    if value.is_null() {
        return Ok(None);
    }
    let number = match value {
        Value::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|raw| raw.is_finite() && raw.fract() == 0.0)
                .map(|raw| raw as i64)
        }),
        _ => None,
    };
    match number {
        Some(number) if number > 0 => Ok(Some(number)),
        _ => Err(errors::management_error(
            400,
            format!("{key} 必须是正整数或 null（清除限制）"),
        )),
    }
}

/// 毫秒时间戳 → 面板展示用的可读时间（固定 UTC+8，与错误信封里 reset_at 的
/// 展示口径一致，见 `errors` 的格式化说明）；构造不出就回落原始数字。
fn format_millis(ms: i64) -> String {
    let Some(offset) = chrono::FixedOffset::east_opt(8 * 3600) else {
        return ms.to_string();
    };
    match chrono::DateTime::from_timestamp_millis(ms) {
        Some(utc) => utc.with_timezone(&offset).format("%Y-%m-%d %H:%M").to_string(),
        None => ms.to_string(),
    }
}
