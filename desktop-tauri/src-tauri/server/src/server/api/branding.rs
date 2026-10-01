//! 品牌外观（站点标题 / Logo）：面板品牌自定义的存储与读写端点。
//!
//! GET  /api/panel/branding   读取（public：登录页在鉴权前就要渲染标题与 Logo）
//! PUT  /api/branding         保存（protected：面板会话 / API Key）
//!
//! 存储在 kv 表的单个键 `branding`（JSON `{title?, logo?}`），与 panelAdmin 同一张
//! 表、同一套「启动 attach、运行期 with / with_mut」的访问模式（见 access.rs）。
//! title / logo 都是**可空**的：null = 回到内置默认（AIBuddy Panel / 内置图标）。
//!
//! 注入：静态页（index.html / login.html）由 static_files 在 `<head>` 后插一段品牌
//! 引导脚本 —— 它拉一次本端点，把 document.title、侧栏品牌区、登录页 h1、favicon
//! 与 .brand-logo 换成自定义值。桌面壳同样吃这段注入；保存通道目前只有网页端桥
//! （桌面桥没有对应命令，设置页在桌面端会如实提示）。

use axum::body::Bytes;
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::access;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;

const KV_BRANDING_KEY: &str = "branding";
/// 标题最大长度（字符数，中文按 1 计）：足够放「XX 公司 · AI 网关」这类形态，
/// 又不至于把侧栏与登录卡片挤破版。
const MAX_TITLE_CHARS: usize = 40;
/// Logo data URL 的最大长度（字符）：约 300KB 的图片 —— 512×512 的 PNG 绰绰有余；
/// 再大就该先压缩再传（设置页前端会先压一道，这里只是服务端的最后防线）。
const MAX_LOGO_CHARS: usize = 400_000;

/// 读当前品牌（库里没有 / 读坏了都回全 null = 内置默认）。
fn read_branding() -> Value {
    let empty = json!({ "title": Value::Null, "logo": Value::Null });
    let Some(db) = access::db() else { return empty };
    let loaded: Option<String> = db
        .with(|conn| {
            conn.query_row(
                "SELECT value FROM kv WHERE key = ?1",
                rusqlite::params![KV_BRANDING_KEY],
                |row| row.get(0),
            )
            .ok()
        })
        .flatten();
    let Some(text) = loaded else { return empty };
    let value: Value = serde_json::from_str(&text).unwrap_or_else(|_| empty.clone());
    json!({
        "title": value.get("title").cloned().unwrap_or(Value::Null),
        "logo": value.get("logo").cloned().unwrap_or(Value::Null),
    })
}

/// 合并写入：patch 里出现的键才改（未出现的保持原值）；全部为空 = 删键回默认。
fn write_branding(patch: &Value) -> Result<(), String> {
    let Some(db) = access::db() else {
        return Err("数据库不可用".to_string());
    };
    let current = read_branding();
    let title = patch.get("title").cloned().unwrap_or(current["title"].clone());
    let logo = patch.get("logo").cloned().unwrap_or(current["logo"].clone());
    let merged = json!({ "title": title, "logo": logo });
    let empty = merged["title"].is_null() && merged["logo"].is_null();
    db.with_mut(|conn| {
        if empty {
            conn.execute(
                "DELETE FROM kv WHERE key = ?1",
                rusqlite::params![KV_BRANDING_KEY],
            )
        } else {
            conn.execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![KV_BRANDING_KEY, merged.to_string()],
            )
        }
    })
    .ok_or_else(|| "写入品牌设置失败".to_string())?;
    Ok(())
}

/// GET /api/panel/branding —— 登录页在鉴权前就要渲染品牌，挂 public
/// （与 /api/panel/status 同一道前缀豁免，见 http.rs 的闸门说明）。
pub async fn get_branding() -> Response {
    ok_json(read_branding())
}

/// PUT /api/branding —— 保存品牌外观。body `{title?, logo?}` 两键均可空：
/// title 空串 / null = 回默认标题；logo null = 移除自定义 Logo。
pub async fn put_branding(body: Bytes) -> Response {
    let payload = match parse_body(&body) {
        Ok(value) => value,
        Err(error) => return errors::management_error(400, error.message),
    };
    let Some(object) = payload.as_object() else {
        return errors::management_error(400, "请求体必须是 JSON 对象");
    };

    let mut patch = serde_json::Map::new();
    if let Some(title) = object.get("title") {
        match title {
            Value::Null => {
                patch.insert("title".to_string(), Value::Null);
            }
            Value::String(text) => {
                let trimmed = text.trim();
                if trimmed.chars().count() > MAX_TITLE_CHARS {
                    return errors::management_error(400, format!("标题最长 {MAX_TITLE_CHARS} 个字"));
                }
                patch.insert(
                    "title".to_string(),
                    if trimmed.is_empty() { Value::Null } else { json!(trimmed) },
                );
            }
            _ => return errors::management_error(400, "title 必须是字符串或 null"),
        }
    }
    if let Some(logo) = object.get("logo") {
        match logo {
            Value::Null => {
                patch.insert("logo".to_string(), Value::Null);
            }
            Value::String(text) => {
                let ok = text.starts_with("data:image/png;base64,")
                    || text.starts_with("data:image/jpeg;base64,")
                    || text.starts_with("data:image/webp;base64,")
                    || text.starts_with("data:image/svg+xml;base64,");
                if !ok {
                    return errors::management_error(
                        400,
                        "Logo 必须是 PNG / JPEG / WebP / SVG 的 data URL",
                    );
                }
                if text.len() > MAX_LOGO_CHARS {
                    return errors::management_error(
                        400,
                        "Logo 图片过大（约 300KB 上限），请先压缩再上传",
                    );
                }
                patch.insert("logo".to_string(), json!(text));
            }
            _ => return errors::management_error(400, "logo 必须是 data URL 字符串或 null"),
        }
    }
    if patch.is_empty() {
        return errors::management_error(400, "请求体没有可保存的字段（title / logo）");
    }

    let patch_value = Value::Object(patch);
    if let Err(message) = write_branding(&patch_value) {
        return errors::management_error(500, message);
    }
    logging::log("[Branding]", "✅ 品牌外观已更新（刷新页面生效）");
    ok_json(read_branding())
}
