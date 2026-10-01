//! 管理面板的注册 / 登录 / 刷新 / 登出（`/api/panel/*`）。
//!
//! ── 面板认证模型（双令牌，照 OmniProxy 的语义）────────────────
//! 账号密码是「人」的凭证，API Key 是「程序」的凭证，各管一层：
//!   · 登录成功签发双令牌 —— access（2 小时，path=/）+ refresh
//!     （30 天，path=/api/panel）；`/api/*` 由 `http::require_api_key`
//!     认 access 会话或 API Key；
//!   · access 过期后前端调 `POST /api/panel/refresh` 静默换新
//!     （轮换：旧 refresh 作废、新 refresh 同会话链；重放旧 refresh
//!     会被检测为泄露并整链作废）；
//!   · 首次部署（没有任何管理员）时登录页走注册模式：
//!     `POST /api/panel/setup` 创建管理员并直接登录。
//!
//! ── 防爆破 ──────────────────────────────────────────────────
//! 同一来源连续失败 5 次锁 5 分钟（按 IP，不是全局 —— 全局锁会把
//! 「攻击者锁死管理员」变成一种攻击）。登录端点挂 public 组：调用方
//! 还没有任何凭证，安全性由锁定与 bcrypt 的校验成本承担。

use axum::body::Bytes;
use axum::extract::ConnectInfo;
use axum::http::{header::SET_COOKIE, HeaderMap};
use axum::response::Response;
use std::net::SocketAddr;

use crate::server::access;
use crate::server::altcha;
use crate::server::config;
use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;

fn body_str<'a>(payload: &'a serde_json::Value, field: &str) -> String {
    payload
        .get(field)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 机器人校验（ALTCHA proof-of-work，见 `server::altcha`）：开关开启时，
/// 注册 / 登录的请求体必须带登录页算好的 payload，否则 400。失败**不计入**
/// 登录失败锁定 —— 那把锁针对「密码猜错」，校验没过说明还没走到验密码那步。
fn check_captcha(payload: &serde_json::Value) -> Result<(), Response> {
    if !config::current().captcha_enabled() {
        return Ok(());
    }
    let Some(token) = payload.get("captcha").and_then(serde_json::Value::as_str) else {
        return Err(errors::management_error(400, "请完成人机验证后重试"));
    };
    altcha::verify(token).map_err(|message| errors::management_error(400, &message))
}

/// `GET /api/panel/captcha` —— 签发一道 ALTCHA challenge（登录页加载时领）。
///
/// 挂 public：领题时用户还没有任何凭证。响应是**裸 challenge JSON**
/// （不带管理 API 的 success/data 信封）—— 官方 widget 直接读顶层字段，
/// 包了信封它就解析失败（altcha-lib 的 challengeHandler 同样发裸对象）。
/// 开关关闭时回 400 —— 前端据此隐藏验证行。
pub async fn captcha_challenge() -> Response {
    match altcha::challenge() {
        Some(challenge) => crate::server::http::raw_json(challenge),
        None => errors::management_error(400, "机器人校验未启用"),
    }
}

fn issue_response(session: access::IssuedSession) -> Response {
    let mut response = ok_json(serde_json::json!({ "loggedIn": true }));
    for cookie in [session.access_cookie, session.refresh_cookie] {
        if let Ok(value) = axum::http::HeaderValue::from_str(&cookie) {
            response.headers_mut().append(SET_COOKIE, value);
        }
    }
    response
}

/// `GET /api/panel/status` —— 登录页用它决定显示「注册」还是「登录」。
///
/// 挂 public：打开登录页时用户还没有任何凭证。
pub async fn panel_status(headers: HeaderMap) -> Response {
    // username 只给**已登录**的调用方（顶栏用户菜单显示账号名用）：会话有效才带，
    // 未登录的匿名请求拿不到 —— 管理员账号名不对未认证者暴露
    let username = if access::session_valid(&headers) {
        access::admin_username()
    } else {
        None
    };
    ok_json(serde_json::json!({
        "registered": access::admin_registered(),
        "username": username,
    }))
}

/// `POST /api/panel/setup` —— 首次注册管理员（只在无人注册时成功）。
///
/// 密码要求：至少 8 位。bcrypt 哈希只落库（`kv` 的 `panelAdmin`），明文
/// 不留痕。注册成功直接签发会话 —— 用户注册完就进面板，不再输一次。
pub async fn panel_setup(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> Response {
    if access::admin_registered() {
        return management_error(409, "管理员账号已存在，无需重复注册");
    }
    let payload = parse_body(&body).unwrap_or(serde_json::Value::Null);
    if let Err(response) = check_captcha(&payload) {
        return response;
    }
    let username = body_str(&payload, "username");
    let password = payload
        .get("password")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if username.is_empty() || username.len() > 64 {
        return management_error(400, "请填写管理员账号（64 字符以内）");
    }
    if password.len() < 8 {
        return management_error(400, "密码至少 8 位");
    }
    let hash = match bcrypt::hash(password, 10) {
        Ok(hash) => hash,
        Err(error) => {
            logging::log("[Security]", &format!("❌ 管理员注册失败：{error}"));
            return management_error(500, "密码加密失败，请重试");
        }
    };
    match access::setup_admin(&username, &hash) {
        Ok(true) => {
            logging::log(
                "[Security]",
                &format!("✅ 管理员「{username}」注册完成（{}）", addr.ip()),
            );
            issue_response(access::IssuedSession::new_session())
        }
        Ok(false) => management_error(409, "管理员账号已存在，无需重复注册"),
        Err(reason) => {
            logging::log("[Security]", &format!("❌ 管理员注册失败：{reason}"));
            management_error(500, &reason)
        }
    }
}

/// `POST /api/panel/login` —— 账号密码换双令牌。
pub async fn panel_login(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> Response {
    if !access::admin_registered() {
        return management_error(400, "尚未注册管理员账号：请先在登录页完成首次注册");
    }
    if access::login_locked(addr.ip()) {
        logging::log("[Security]", &format!("❌ 面板登录已锁定（{}）", addr.ip()));
        return management_error(429, "登录失败次数过多，请 5 分钟后再试");
    }
    let payload = parse_body(&body).unwrap_or(serde_json::Value::Null);
    if let Err(response) = check_captcha(&payload) {
        return response;
    }
    let username = body_str(&payload, "username");
    let password = payload
        .get("password")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");

    if !access::verify_login(&username, password) {
        access::record_login_failure(addr.ip());
        logging::log("[Security]", &format!("❌ 面板登录失败（{}）", addr.ip()));
        crate::server::api::audit_api::audit("panel.login.failed", &format!("IP {} 登录失败", addr.ip()));
        return management_error(401, "账号或密码不正确");
    }
    access::clear_login_failures(addr.ip());
    logging::log("[Security]", &format!("✅ 面板登录成功（{}）", addr.ip()));
    crate::server::api::audit_api::audit("panel.login", &format!("用户 {} 从 {} 登录", username, addr.ip()));
    issue_response(access::IssuedSession::new_session())
}

/// `POST /api/panel/refresh` —— 用长效 refresh 轮换出新的双令牌。
///
/// 前端在 access 过期（401）后先静默调这里，成功则原请求重试、用户无感；
/// refresh 也失效（过期 / 重放检测触发）才真正跳登录页。
pub async fn panel_refresh(headers: HeaderMap) -> Response {
    let Some(session) = access::rotate_session(refresh_cookie_of(&headers)) else {
        return management_error(401, "登录已过期，请重新登录");
    };
    issue_response(session)
}

/// `POST /api/panel/logout` —— 撤销当前会话链（双 cookie 一并清除）。
pub async fn panel_logout(headers: HeaderMap) -> Response {
    access::revoke_session(refresh_cookie_of(&headers), &headers);
    let mut response = ok_json(serde_json::json!({ "loggedIn": false }));
    for name in [access::ACCESS_COOKIE, access::REFRESH_COOKIE] {
        let clear = format!("{name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
        if let Ok(value) = axum::http::HeaderValue::from_str(&clear) {
            response.headers_mut().append(SET_COOKIE, value);
        }
    }
    response
}

/// `POST /api/panel/password` —— 修改管理员账号 / 密码（已登录；需验证原密码）。
///
/// body：`{username, oldPassword, newUsername?, newPassword?}` —— 新账号与新密码
/// 至少填一项；只改账号名（保留原密码）或只改密码（保留原账号）都合法。
/// 成功后撤销**除当前会话外**的全部会话链（其他设备全部下线），当前会话不动。
/// env 预置管理员的部署会拒绝（改了也会被启动时的 env 覆盖），错误文案照实说。
pub async fn panel_password(headers: HeaderMap, body: Bytes) -> Response {
    // 与 setup / login 同口径：解析失败按空对象处理，字段校验自己报错
    let payload = parse_body(&body).unwrap_or(serde_json::Value::Null);
    let username = body_str(&payload, "username");
    let old_password = payload
        .get("oldPassword")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let new_username = payload.get("newUsername").and_then(serde_json::Value::as_str);
    let new_password = payload.get("newPassword").and_then(serde_json::Value::as_str);
    if username.is_empty() || old_password.is_empty() {
        return management_error(400, "缺少原账号或原密码");
    }
    if new_username.is_none() && new_password.is_none() {
        return management_error(400, "新账号与新密码至少填一项");
    }
    if let Some(password) = new_password {
        if password.chars().count() < 8 {
            return management_error(400, "新密码至少 8 位");
        }
    }
    if let Err(message) =
        access::change_admin_credentials(&username, old_password, new_username, new_password)
    {
        logging::log("[Security]", &format!("❌ 修改管理员凭据失败: {message}"));
        crate::server::api::audit_api::audit("panel.password.failed", &message);
        return management_error(400, &message);
    }
    let revoked = access::revoke_all_sessions_except(access::session_id_of(&headers).as_deref());
    logging::log("[Security]", "✅ 管理员凭据已修改，其余会话已全部下线");
    crate::server::api::audit_api::audit(
        "panel.password",
        &format!("管理员凭据已修改（撤销其他会话 {revoked} 条）"),
    );
    ok_json(serde_json::json!({ "changed": true, "revokedSessions": revoked }))
}

/// refresh token 的取值：cookie 的 Path 限定在 /api/panel，浏览器只在
/// 本组接口上携带；顺手接受 Authorization: Bearer（App/脚本场景）。
fn refresh_cookie_of(headers: &HeaderMap) -> Option<&str> {    if let Some(value) = headers.get(axum::http::header::AUTHORIZATION) {
        if let Ok(text) = value.to_str() {
            if let Some(token) = text.strip_prefix("Bearer ") {
                if !token.trim().is_empty() {
                    return Some(token.trim());
                }
            }
        }
    }
    headers
        .get(axum::http::header::COOKIE)
        .and_then(|value| value.to_str().ok())
}

fn management_error(status: i32, message: &str) -> Response {
    errors::management_error(status, message)
}
