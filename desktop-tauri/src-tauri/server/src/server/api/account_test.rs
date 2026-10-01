//! 账号一键连通性测试（`POST /api/accounts/{id}/test`）与 `/api/accounts*`
//! 的入口包装。
//!
//! ── 为什么本文件要「包装」账号入口 ──────────────────────────
//! `POST /api/accounts/{id}/test` 带路径参数，而 `/api/accounts` 族在 http.rs
//! 里注册的是通配入口 `/api/accounts/{*rest}` → `api::accounts::accounts_entry`
//! （Node 版判定顺序的对齐方式，见 `api::accounts` 的模块头）。matchit 0.8
//! **不允许**通配段与命名参数在同一段共存（插入 `/api/accounts/{id}/test` 会
//! 与既有的 `{*rest}` 冲突，启动即 panic），而 `accounts.rs` 的分发函数是既有
//! 契约文件、不在本次改动范围内。因此采用「包装入口」：
//!
//!   http.rs 的三条 `/api/accounts*` 注册改指向本文件的
//!   [`accounts_entry`] → 先拦 `POST /api/accounts/{id}/test`（命中即处理），
//!   其余请求**原样转交** `api::accounts::accounts_entry` —— 判定顺序、
//!   信封形状与既有行为逐字不变，`/test` 只是追加在转发链前面的一层。
//!
//! 判定写法与 `accounts.rs::dispatch` 的后缀分支同一风格
//! （`strip_prefix` + `strip_suffix`，id 为空不命中）：账号 id 不含 `/`，
//! `…/abc/test/extra` 这类更深路径不命中后落到原入口的 404。
//!
//! ── 测试行为 ────────────────────────────────────────────────
//! 执行体在 `core::probe::test_account`（与定时探活共用同一套「单账号最小
//! 请求」，动作按 provider 能力分档，见 `core::probe` 的模块头）：计时 →
//! 返回 `{success, latencyMs, detail}`（detail 含错误分类），结果进事件日志，
//! **不改账号状态、不动连败计数**。鉴权沿用 `/api/accounts` 族所在的
//! protected 分组（http.rs 的 `require_api_key`），本文件不做二次校验。

use axum::extract::{Request, State};
use axum::http::Method;
use axum::response::Response;

use crate::server::core::probe;
use crate::server::errors::management_error;
use crate::server::http::ok_json;
use crate::server::ServerState;

/// `/api/accounts` 族三条注册（无尾段 / 尾斜杠 / 通配尾段）的统一入口。
///
/// 与 `api::accounts::accounts_entry` 同一签名（http.rs 的注册处指向这里）：
/// 先拦截一键测试，未命中原样转交既有入口。顺带惰性拉起探活的调度循环
/// （幂等，见 `core::probe::ensure_loop`）—— 账号页是探活设置最常被触碰的
/// 入口，让「重启后循环未起跑」的窗口尽量短。
pub async fn accounts_entry(State(state): State<ServerState>, request: Request) -> Response {
    probe::ensure_loop(state.store().clone());
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    if method == Method::POST {
        if let Some(id) = path
            .strip_prefix("/api/accounts/")
            .and_then(|rest| rest.strip_suffix("/test"))
        {
            let id = decode_segment(id);
            if !id.is_empty() {
                return match probe::test_account(state.store(), &id).await {
                    Ok(report) => ok_json(report),
                    Err(error) => {
                        management_error(i32::from(error.status_code), error.message)
                    }
                };
            }
        }
    }
    super::accounts::accounts_entry(State(state), request).await
}

/// 百分号解码（与 `api::accounts::decode_segment` 同一份逻辑的本地副本 ——
/// 那边是私有函数，账号 id 正常不含特殊字符；保留它让手工构造的 URL 带
/// `%2F` 这类编码时行为与相邻的 `{id}` 分支一致）。
fn decode_segment(value: &str) -> String {
    let mut out = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|text| u8::from_str_radix(text, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| value.to_string())
}
