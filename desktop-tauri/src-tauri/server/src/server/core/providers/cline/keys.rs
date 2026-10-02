//! Cline 账号的 API Key 管理：列出 + 删除（官方 `api.cline.bot` 的
//! `/api/v1/api-keys`）。
//!
//! ── 官方依据（docs.cline.bot，2026-10 核对）──────────────────
//! ```text
//! GET    /api/v1/api-keys           "List your API keys"
//! DELETE /api/v1/api-keys/{key_id}  "Delete an API key"
//! ```
//! 出处：`docs.cline.bot/enterprise-solutions/api-reference` 的 "API Keys" 段
//! （该页原文只给方法与路径，**没有**给响应体 schema 与状态码表 —— 因此下面的
//! 字段解析全部走「候选键逐个取」的防御式写法，原始响应整体留在 `raw` 里；
//! 第一次实测响应回来后若字段对不上，只改本文件的候选键表即可）。
//! 同段还有 `POST /api/v1/api-keys`（创建）—— 本模块刻意不实现：创建一把新
//! Key 属于「发放凭证」，而密钥通常只在创建那一刻完整展示一次，管理面板做
//! 「查看与回收」更贴合定位（要创建请走官方 app.cline.bot 的 Settings → API Keys）。
//!
//! ── 鉴权（与 balance.rs 同一套，对照核实过）──────────────────
//! `Authorization: Bearer <token>`，token 含 `workos:` 前缀（`credentials`
//! 的 `bearer_token()` 负责补）。官方 authentication 页把这类 token 称为
//! "account auth token — Generated automatically when you sign in"，与余额
//! 接口用的是同一套头；`X-CLIENT-TYPE` 在文档里未提及，但管理接口带上它
//! 与 `balance.rs` 同一取向（更贴近官方客户端，且没有代价）。
//!
//! ── 可选跟踪头 `X-Task-ID`（官方 authentication 页，原文）────
//! "X-Task-ID — A unique task identifier. Used internally by the Cline
//! extension."，属于「The Cline API accepts optional headers for tracking
//! and identification」表里的三项之一（另两项 HTTP-Referer / X-Title），
//! **可选、格式未文档化**。本模块（管理接口）没有任务上下文，不携带也不
//! 伪造 —— 伪造一个任务 id 会让上游的使用日志对不上真实调用。转发链路若
//! 要注入，用 [`TRACKING_HEADER_TASK_ID`] 常量在 `adapter.rs` 的请求头组装
//! 处接线（该文件本模块不动，见交付报告的接线清单）。
//!
//! ── 401 的处置（与 usage_query 对单账号的处置同构）───────────
//! `supports_refresh = true`（adapter），因此 401 在本模块内部就走
//! 「强制续期 → 重试一次」：token 完全可能在时间上还很新时被上游拒绝
//! （服务端侧失效），只透出 401 会把「刷一下就好」变成一次失败。重试仍 401
//! 或续期本身失败时，错误原样向上 —— 不吞、不再重试第二遍。
//!
//! ── 路由接线（本文件只提供 handler，注册在别处）──────────────
//! 本文件同时承担 axum handler（[`list_keys_route`] / [`delete_key_route`]），
//! 供 `http.rs` 的 protected 路由组直接注册：
//! ```text
//! GET    /api/providers/cline/{account_id}/keys         → list_keys_route
//! DELETE /api/providers/cline/{account_id}/keys/{key_id} → delete_key_route
//! ```
//! handler 放进 core 层是任务指明的取舍（api/ 层不新增文件）：它们是**薄壳**
//! （参数解析 + 调本模块核心函数 + 错误转管理信封），不引入新的分层依赖。
//! 另需在 `providers/cline/mod.rs` 里补 `pub mod keys;`（本模块不动同目录
//! 其它文件，见交付报告）。
//!
//! ── 硬约束 ──────────────────────────────────────────────────
//! release 是 `panic=abort`：绝不 unwrap/expect/panic。

use axum::extract::{Path, State};
use axum::response::Response;
use reqwest::Method;
use serde_json::{json, Map, Value};

use crate::server::core::account_store::AccountStore;
use crate::server::core::egress;
use crate::server::errors::{management_error, GatewayError};
use crate::server::http::ok_json;
use crate::server::ServerState;

use super::{credentials, refresh};

/// 官方可选跟踪头（`X-Task-ID`，出处见模块头）。导出给转发链路按需注入；
/// 管理接口本身不带（没有任务上下文，见模块头说明）。
pub const TRACKING_HEADER_TASK_ID: &str = "X-Task-ID";

/// 请求超时（与 balance.rs 同档：20 秒。删除比查询更不该挂着 —— 但同一档
/// 常量让两处的行为可预期，不另设小值制造「删除比查询更早超时」的错觉）
const REQUEST_TIMEOUT_MS: u64 = 20_000;

/// 对一次 Key 管理请求的描述（列表 / 删除某一把）。
///
/// 用枚举而不是两个入口各自取凭证 + 重试：401 的「强制续期 → 重试一次」
/// 是两条路径共用的处置，写两遍迟早会漂。
enum KeyRequest {
    List,
    /// 要删除的 Key id（路径段；发请求前百分号编码）
    Delete(String),
}

/// 列出账号在 Cline 官方的 API Key（`GET /api/v1/api-keys`）。
///
/// 返回归一形状（`keys` 数组 + `raw` 原始响应）：
/// ```jsonc
/// { "accountId": "cline-free-…", "count": 1,
///   "keys": [ { "id": "…", "name": "…", "createdAt": 1789…, "lastUsedAt": null, "key": "…" } ],
///   "raw": { … 上游原样 … } }
/// ```
/// 字段以实测响应为准（文档未给 schema，见模块头）：`id` / `name` / `createdAt`
/// / `key` 都是候选键取值，取不到就是空串或 null —— 前端按缺省渲染，不猜。
pub async fn list_api_keys(store: &AccountStore, account_id: &str) -> Result<Value, GatewayError> {
    let payload = request_with_refresh(store, account_id, KeyRequest::List).await?;
    Ok(normalize_list(&payload, account_id))
}

/// 删除账号的一把 API Key（`DELETE /api/v1/api-keys/{key_id}`）。
///
/// 返回 `{ "deleted": true, "id": key_id, "raw": … }`（raw 是上游响应，可能为
/// null —— 204/空 body 也是成功）。**key_id 必须来自 list 的返回**：它是上游
/// 的资源 id，不是界面上看到的那段掩码。
pub async fn delete_api_key(
    store: &AccountStore,
    account_id: &str,
    key_id: &str,
) -> Result<Value, GatewayError> {
    let key_id = key_id.trim();
    if key_id.is_empty() {
        return Err(GatewayError::bad_request("缺少要删除的 API Key id"));
    }
    let payload = request_with_refresh(store, account_id, KeyRequest::Delete(key_id.to_string()))
        .await?;
    Ok(normalize_delete(&payload, key_id))
}

/// 取会话 → 发请求 → 401 时强制续期后重试一次（理由见模块头）。
///
/// 会话链与 balance 同款：`refresh::ensure_fresh(store, id, false)`（临期主动
/// 刷新 + 单飞 + 比较再写），token 由 `bearer_token()` 统一补 `workos:` 前缀。
async fn request_with_refresh(
    store: &AccountStore,
    account_id: &str,
    request: KeyRequest,
) -> Result<Value, GatewayError> {
    let credentials = refresh::ensure_fresh(store, account_id, false).await?;
    let result = match &request {
        KeyRequest::List => fetch_list(&credentials.bearer_token()).await,
        KeyRequest::Delete(key_id) => fetch_delete(&credentials.bearer_token(), key_id).await,
    };
    match result {
        Err(error) if error.status_code == 401 => {
            // 强制续期（不看临期窗口 —— 被拒的 token 时间上可能还很新）后重试一次
            let fresh = refresh::ensure_fresh(store, account_id, true).await?;
            match &request {
                KeyRequest::List => fetch_list(&fresh.bearer_token()).await,
                KeyRequest::Delete(key_id) => fetch_delete(&fresh.bearer_token(), key_id).await,
            }
        }
        other => other,
    }
}

/// `GET /api/v1/api-keys` → 原始响应（含 `data` 信封）。
async fn fetch_list(token: &str) -> Result<Value, GatewayError> {
    let url = format!("{}/api-keys", credentials::API_BASE_URL);
    match request_json(Method::GET, &url, token).await? {
        Some(payload) => Ok(payload),
        // 200 但空 body：对列表接口是非预期形态（上游要么给信封要么给错误）
        None => Err(GatewayError::with_status(
            502,
            "Cline API Key 列表返回了空响应",
        )),
    }
}

/// `DELETE /api/v1/api-keys/{key_id}` → 原始响应。
///
/// **空 body 视为成功**（上游可能回 204 / 无内容体）：删除的成败看状态码，
/// 响应体里有没有内容不改变事实 —— `normalize_delete` 对 null raw 照样成立。
async fn fetch_delete(token: &str, key_id: &str) -> Result<Value, GatewayError> {
    let url = format!(
        "{}/api-keys/{}",
        credentials::API_BASE_URL,
        url_encode(key_id)
    );
    Ok(request_json(Method::DELETE, &url, token).await?.unwrap_or(Value::Null))
}

/// 发一次带鉴权的请求并解析 JSON 响应体。
///
/// 状态码处置与 `balance.rs` 的 `get_json_allow_status` 同一套口径：
/// 401 原样透出（调用方 [`request_with_refresh`] 据此走刷新重试），
/// 其余非 2xx 提取上游错误文案转 502；**空 body 返回 `Ok(None)`**
/// （DELETE 的 204 是正常形态，见 `fetch_delete`）。
async fn request_json(
    method: Method,
    url: &str,
    token: &str,
) -> Result<Option<Value>, GatewayError> {
    let client = egress::client_for(None);
    let response = client
        .request(method, url)
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {token}"))
        .header("X-CLIENT-TYPE", super::adapter::CLIENT_TYPE)
        .timeout(std::time::Duration::from_millis(REQUEST_TIMEOUT_MS))
        .send()
        .await
        .map_err(|error| {
            GatewayError::with_status(
                502,
                format!("Cline 接口请求失败: {}", egress::describe_error_detail(&error)),
            )
        })?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if status == 401 {
        // 原样透出 401：调用方据此走「强制续期后重试一次」的处置
        return Err(GatewayError::with_status(
            401,
            "Cline 登录态已失效，请刷新凭证后重试",
        ));
    }
    if !(200..300).contains(&status) {
        return Err(upstream_error(status, &text));
    }
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| GatewayError::with_status(502, format!("Cline 接口响应不是 JSON: {error}")))
}

/// 上游错误体 → 可读错误（两种形态都认，与 `refresh::upstream_error_message`
/// 同口径：`{"error":"..."}` 与 `{"error":{"message":...}}`）。
fn upstream_error(status: u16, text: &str) -> GatewayError {
    let payload: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let detail = upstream_error_message(&payload)
        .unwrap_or_else(|| {
            crate::server::core::account_store::store_util::truncate_text(text, 200)
        });
    GatewayError::with_status(502, format!("Cline 接口返回 {status}: {detail}"))
}

/// 从上游错误体里取可读文案（字符串与嵌套对象两种形态；同 refresh.rs）
fn upstream_error_message(payload: &Value) -> Option<String> {
    if let Some(text) = payload.get("error").and_then(Value::as_str) {
        let text = text.trim();
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    payload
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// 列表归一：解 `{"data": …}` 信封 → 逐条归一成前端要的稳定形状。
///
/// ── 信封下的集合键（候选）──────────────────────────────────
/// 文档没给 schema，集合可能在 `data` 直接是数组，也可能包在
/// `items` / `keys` / `apiKeys` 之一里 —— 逐个候选取第一个命中的；
/// 都不命中按「空列表」处理（前端显示空态，而不是整次报错：一个新字段名
/// 不该把「有 3 把 Key」说成「查询失败」）。
fn normalize_list(payload: &Value, account_id: &str) -> Value {
    let data = payload.get("data").unwrap_or(payload);
    let rows: Vec<Value> = extract_items(data).iter().map(normalize_key).collect();
    json!({
        "accountId": account_id,
        "count": rows.len(),
        "keys": rows,
        // 排障用原始响应（前端默认不展示）：字段名对不上时对着它改候选键表
        "raw": payload,
    })
}

/// 信封下的集合：数组直给，对象则按候选键找数组
fn extract_items(data: &Value) -> Vec<Value> {
    if let Some(items) = data.as_array() {
        return items.clone();
    }
    for key in ["items", "keys", "apiKeys"] {
        if let Some(items) = data.get(key).and_then(Value::as_array) {
            return items.clone();
        }
    }
    Vec::new()
}

/// 单条 Key 归一（候选键取值，出处与取舍见模块头）：
///   - `id`：删除接口的路径参数，候选 `id` / `keyId` / `key_id`；
///   - `name`：展示名，候选 `name` / `label` / `title`；
///   - `createdAt` / `lastUsedAt`：毫秒时间戳（ISO 字符串与毫秒数两种形态都认，
///     复用 `refresh::parse_expires_at` —— 与续期响应的 `expiresAt` 同一套解析）；
///   - `key`：上游给的掩码 / 缩略形态（官方创建时只完整展示一次，列表里应是
///     掩码），候选 `key` / `maskedKey` / `masked_key` / `preview` / `prefix` / `token`。
fn normalize_key(item: &Value) -> Value {
    let mut out = Map::new();
    out.insert("id".to_string(), Value::String(pick_string(item, &["id", "keyId", "key_id"])));
    out.insert("name".to_string(), Value::String(pick_string(item, &["name", "label", "title"])));
    out.insert(
        "createdAt".to_string(),
        pick_time(item, &["createdAt", "created_at", "created", "issuedAt"])
            .map(crate::server::core::account_store::state::json_number)
            .unwrap_or(Value::Null),
    );
    out.insert(
        "lastUsedAt".to_string(),
        pick_time(item, &["lastUsedAt", "last_used_at", "lastUsed"])
            .map(crate::server::core::account_store::state::json_number)
            .unwrap_or(Value::Null),
    );
    out.insert(
        "key".to_string(),
        Value::String(pick_string(
            item,
            &["key", "maskedKey", "masked_key", "preview", "prefix", "token"],
        )),
    );
    Value::Object(out)
}

/// 删除结果归一（`deleted` 恒为 true：走到这里状态码已是 2xx）
fn normalize_delete(payload: &Value, key_id: &str) -> Value {
    json!({
        "deleted": true,
        "id": key_id,
        // 上游的删除响应体（可能为 null —— 204/空 body 也是成功，见 fetch_delete）
        "raw": payload,
    })
}

/// 候选键里取第一个非空字符串（去空白；与 credentials::pick_string 同形，
/// 那份是私有的，为不动同目录其它文件在这里另立一份）
fn pick_string(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let text = text.trim();
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

/// 候选键里取第一个可解析的时间（毫秒时间戳；ISO 字符串也认）
fn pick_time(value: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(found) = value.get(key).filter(|candidate| !candidate.is_null()) {
            if let Some(ms) = refresh::parse_expires_at(Some(found)) {
                return Some(ms);
            }
        }
    }
    None
}

/// 百分号编码（只编码会破坏路径的字符；与 balance.rs 的同名实现同一份逻辑
/// —— 那份是私有的，理由见 `pick_string`）
fn url_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/* ─── axum handler（薄壳，路由注册见模块头）─────────────────── */

/// GET /api/providers/cline/{account_id}/keys
///
/// 列出该 Cline 账号在官方的 API Key。账号不存在 / 不属于 Cline 时
/// `refresh::snapshot` 回 401（与余额单查同一文案口径）。
pub async fn list_keys_route(
    State(state): State<ServerState>,
    Path(account_id): Path<String>,
) -> Response {
    match list_api_keys(state.store(), &account_id).await {
        Ok(data) => ok_json(data),
        Err(error) => management_error(error.status_code, error.message),
    }
}

/// DELETE /api/providers/cline/{account_id}/keys/{key_id}
///
/// 删除该账号的一把 API Key（确认在**前端**做：这是不可恢复的破坏性操作，
/// 弹确认框是账号页批量删除的既有惯例）。
pub async fn delete_key_route(
    State(state): State<ServerState>,
    Path((account_id, key_id)): Path<(String, String)>,
) -> Response {
    match delete_api_key(state.store(), &account_id, &key_id).await {
        Ok(data) => ok_json(data),
        Err(error) => management_error(error.status_code, error.message),
    }
}
