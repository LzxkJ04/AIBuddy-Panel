//! OpenAI 兼容的 embeddings 透传（`POST /v1/embeddings`）。
//!
//! ── 上游契约（核实于 docs.openclaw.ai/zh-CN/gateway/openai-http-api）──
//!   - 端点：`POST /v1/embeddings`，与小浣熊网关的其它 HTTP API 同端口多路复用；
//!     上游默认**禁用**，需网关侧 `gateway.http.endpoints.chatCompletions` 的
//!     `enabled: true` 打开（文档说明该开关控制整个端点组，chat 与 embeddings 同组）。
//!   - 请求体：`model` 用与对话同一套目标 id（`openclaw` / `openclaw/default` /
//!     `openclaw/<agentId>`）；`input` 支持字符串或字符串数组。其余字段
//!     （`encoding_format` / `dimensions` / `user`）文档未提 —— 透传层不做本地
//!     校验，原样交给上游裁定。
//!   - 选拔入模型的头：`x-openclaw-model`（如 `openai/text-embedding-3-small`）；
//!     不带则用「所选智能体的正常嵌入设置」。**本网关暂不透传该头**：对话链路的
//!     既有约定是适配器自组头集合、不透传客户端头，将来要透传应在适配器层补。
//!   - 响应形状文档未给 —— 按 OpenAI 标准形（`object:"list"` + `data[].embedding`
//!     + `usage`）**原样透传**，本网关不解析改写（usage 旁路提取除外）。
//!   - 鉴权：`Authorization: Bearer <token>`，与对话同源（适配器的头集合已带）。
//!
//! ── 支持矩阵（为什么只对小浣熊分派）──────────────────────────
//! 全仓库（Rust + Node 源实现）grep 无任何 embeddings 痕迹（2026-10 核实）；
//! 官方文档确认该端点的上游只有小浣熊（OpenClaw 网关）。其余各家（workbuddy /
//! catpaw / autoclaw / qoder / cline / accio / zcode / trae / codearts）既无
//! 文档也无实现 —— 所以本入口把请求**固定分派给小浣熊**；将来哪家支持了，
//! 在 `forward_embeddings` 的分派点扩一条即可。
//!
//! ── 为什么不走 UpstreamService::forward ─────────────────────
//! 那条链的两大前提对 embeddings 都不成立：① 无论下游要不要流式，上游恒以
//! `stream:true` 请求、响应按 chat SSE 聚合（embeddings 请求没有 stream，
//! 响应是普通 JSON）；② 历史 sanitize / 提示词注入都围绕 messages。因此这里
//! 走一条**专用的最小转发**：凭证与头集合复用小浣熊适配器的
//! `build_chat_request`（URL 只把 `/chat/completions` 尾巴换成 `/embeddings`，
//! 基址 / 鉴权 / 出口代理全同源），传输复用 `upstream::request`，编排上只保留
//! 「单账号 + 401 刷新后同账号重试一次」。
//!
//! ── 与 /v1/chat/completions 的刻意差异（都是简化，不丢语义）──────
//!   1. **无去重排队**：去重槽（防同 body 重试风暴）是 `upstream` 内部的私有
//!      机制；embeddings 幂等且秒级，重复请求交给上游限流处置。
//!   2. **无 429 账号轮换**：冷却标记在 `rotate`（pub(super)，api 层不可达），
//!      embeddings 单发不轮换 —— 429 按「试满后的终态」同形透出（状态码 /
//!      文案与 chat 终态一致，账号冷却由下一次请求的限额语义自然承接）。
//!   3. **无退避重试预算**：传输失败直接 502；重试节奏交给客户端。
//!   4. **不做目录存在性校验**：对话目录里没有 embeddings 型号，按它校验会把
//!      一切请求 404 掉；只做 Key 的模型 / 提供商白名单（语义与
//!      `pipeline::resolve_model` / `filter_by_key_scope` 逐字对齐）。
//!   5. **记账完全同源**：`record_started` → 进行中行，`record_entry` → 终态 +
//!      `request_raw` 正文 + Key 额度计量（usage 取自响应 JSON 的 `usage`
//!      字段 —— prompt/total_tokens 有值；embeddings 没有 completion_tokens，
//!      `extract_usage` 的兼容规则把它按 0 记）。
//!
//! ── 硬约束 ─────────────────────────────────────────────────
//! release 是 `panic=abort`：零 unwrap/expect/panic（`from_u16` 一类用
//! `unwrap_or` 归一，不 unwind）。

use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Extension, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::config;
use crate::server::core::account_store::AccountStore;
use crate::server::core::debug_traffic::{self, TrafficCapture};
use crate::server::core::key_quota;
use crate::server::core::key_scope::{self, KeyScope};
use crate::server::core::providers::adapter::{adapter_for, UpstreamErrorClass};
use crate::server::core::providers::catalog::wire_target_for_provider;
use crate::server::core::providers::{kind_id, ProviderKind};
use crate::server::core::proxies::{session_proxy, ResolvedProxy};
use crate::server::core::upstream::cancellation;
use crate::server::core::upstream::request::{
    read_upstream_error, send_chat_request, TransportRequest, UpstreamErrorDetail,
    UpstreamRequestError,
};
use crate::server::core::upstream::usage::{LogPhase, RequestTelemetry};
use crate::server::errors::GatewayError;
use crate::server::logging;
use crate::server::ServerState;

use super::disconnect_guard::DisconnectGuard;
use super::pipeline::{
    live_row_sink, model_field_text, raw_body_text, record_early_failure, record_entry,
    user_agent_of, write_debug_files, RecordContext,
};

/// embeddings 的唯一承载家（支持矩阵见模块头；`kind_id` 是 const fn，
/// 所以这里能以常量而非字面量持有 —— 与注册表单一事实来源）。
const PROVIDER_ID: &str = kind_id(ProviderKind::Raccoon);

/// 小浣熊适配器构造的 chat URL 固定尾巴（`{llmBase}/chat/completions`，
/// 见 `raccoon::mod` 的 `build_chat_request`）。embeddings URL 由它换尾而来。
const CHAT_PATH: &str = "/chat/completions";

/// POST /v1/embeddings
///
/// 请求体校验（OpenAI 形状的最小集）→ Key 准入（额度 / 白名单）→ 按支持矩阵
/// 固定分派给小浣熊 → 透传响应。鉴权（401）、维护模式（503）由 `require_api_key`
/// 中间件覆盖（本路由挂在网关面的鉴权组，路由登记见 `http::gateway_router`）。
pub async fn embeddings(
    State(state): State<ServerState>,
    headers: HeaderMap,
    // R9：中间件放进请求扩展的「命中 Key 的限制」。`Option` 是刻意的 ——
    // 免鉴权模式、环境变量 Key、转发链路之外的管理调用都没有它，而
    // 「取不到 = 不限制」正是本需求的语义（与 api::chat 同一段说明）。
    key_scope: Option<Extension<KeyScope>>,
    body: Bytes,
) -> Response {
    let scope = key_scope.map(|Extension(scope)| scope);
    // 请求开始时刻（请求统计用）。放在最前面：它要覆盖 body 解析与选路的耗时
    let started_at = logging::now_ms();
    let path = "/v1/embeddings";
    // ⓪ Key 额度 / 有效期准入（`core::key_quota`）：过期 → 403「Key 已过期」，
    // Token 配额用尽 → 403「Key 配额已用尽」。没有命中的 Key（免鉴权 /
    // 环境变量 Key / 未知 Key）一律放行 —— 与三条对话入口同一处时点、同一套文案。
    if let Err(message) = key_quota::check_scope(scope.as_ref()) {
        let error = GatewayError::with_status(403, message);
        record_early_failure(&state, started_at, "", "", &error);
        return error.payload_response();
    }
    // 记账键在 scope 被消费之前抄好（随 RecordContext 带到收尾，
    // 见 `key_quota::key_id_of` 的说明）
    let key_id = key_quota::key_id_of(scope.as_ref());
    // ① body 必须是 JSON 对象（数组/标量/null 都算非法，与三条对话入口同一口径）
    let parsed = serde_json::from_slice::<Value>(&body).ok();
    let Some(mut payload) = parsed.filter(Value::is_object) else {
        let error = GatewayError::bad_request("请求体必须是 JSON 对象");
        record_early_failure(&state, started_at, "", "", &error);
        return error.payload_response();
    };
    // ② model 必填（OpenAI 契约；官方文档：embeddings 用同一套模型目标 id）。
    // 取值链与对话入口同源（`model_field_text`：真值判定 + 字符串化）。
    let client_model = model_field_text(&payload);
    if client_model.is_empty() {
        let error = GatewayError::bad_request("缺少 model 字段");
        record_early_failure(&state, started_at, &client_model, "", &error);
        return error.payload_response();
    }
    // ③ input 必填：字符串或字符串数组（官方文档明确支持的两形态）。
    // token 数组等上游自有扩展不做本地校验 —— 透传层不替上游收窄入参。
    let input_missing = payload.get("input").is_none();
    let input_ok = payload
        .get("input")
        .map(|value| value.is_string() || value.is_array())
        .unwrap_or(false);
    if !input_ok {
        let error = GatewayError::bad_request(if input_missing {
            "缺少 input 字段"
        } else {
            "input 必须是字符串或字符串数组"
        });
        record_early_failure(&state, started_at, &client_model, "", &error);
        return error.payload_response();
    }
    // ④ R9 模型白名单：语义与 `pipeline::resolve_model` 的同名判定一致 ——
    // 「这个模型对你这把 Key 不存在」（404 + model_not_found，文案逐字同源）。
    // 不做目录存在性校验的理由见模块头差异 4。
    if !key_scope::allows_model(scope.as_ref(), &client_model) {
        let error = GatewayError::with_status(
            404,
            format!("模型 '{client_model}' 不可用：不在这把网关 Key 的可用模型列表里"),
        )
        .with_code("model_not_found");
        record_early_failure(&state, started_at, &client_model, "", &error);
        return error.payload_response();
    }
    // ⑤ R9 提供商白名单：embeddings 只由小浣熊承载（支持矩阵见模块头）。
    // Key 限制了提供商又没勾小浣熊时，错误形态照抄转发层的
    // `filter_by_key_scope`（404 + model_not_found + 指向 Key 页的文案）；
    // 终端留一行与转发层同形状的安全日志 —— 请求日志那侧由
    // record_early_failure 记进「错误」列，运行日志页不再逐请求刷行。
    if !key_scope::allows_provider(scope.as_ref(), PROVIDER_ID) {
        let describe = scope
            .as_ref()
            .map(|scope| scope.describe())
            .unwrap_or_else(|| "不限制".to_string());
        logging::console_line(
            "[Security]",
            &format!("🚫 请求被网关 Key 的可用提供商拒绝: 模型 {client_model}（{describe}）"),
        );
        let error = GatewayError::with_status(
            404,
            format!(
                "模型 '{client_model}' 不可用：提供它的提供商都不在这把网关 Key 的可用提供商列表里（{describe}）"
            ),
        )
        .with_code("model_not_found");
        record_early_failure(&state, started_at, &client_model, "", &error);
        return error.payload_response();
    }
    // ⑥ verbose 日志 + 调试落盘（与三条对话入口同一形态与时机）
    let user_agent = user_agent_of(&headers);
    // inputs：字符串记 1，数组记长度（排障时对照上游的计费条数用）
    let input_count = payload
        .get("input")
        .map(|value| match value {
            Value::Array(items) => items.len(),
            _ => 1,
        })
        .unwrap_or(0);
    logging::verbose(
        "[Model]",
        &format!(
            "← POST {path} model={client_model} inputs={input_count} bytes={} ua={user_agent}",
            body.len(),
        ),
    );
    write_debug_files(&body, "POST", path, &user_agent);

    // ⑦ 记账前置（与三条对话入口同一处时点与语义）：进行中行 + 在途回写 +
    // 手动终止的取消令牌 + 断线兜底守卫。embeddings 没有思考等级，
    // client_reasoning 恒空串（不给「没发的等级」预支一个值）。
    // 模型名两列同值：这里没有默认模型回落（差异 4），请求名即转发名
    //（发送侧若有映射改写，由 telemetry 的 upstream_model 列如实呈现）。
    let telemetry = Arc::new(RequestTelemetry::with_id());
    let telemetry_id = telemetry.snapshot().id;
    state.request_stats().record_started(
        &telemetry_id,
        started_at,
        &client_model,
        &client_model,
        "",
    );
    telemetry.set_live_sink(live_row_sink(
        state.request_stats(),
        telemetry_id.clone(),
        started_at,
    ));
    if let Some(token) = cancellation::register(&telemetry_id) {
        telemetry.set_cancel_token(token);
    }
    let mut guard = DisconnectGuard::new(state.request_stats(), telemetry_id.clone());
    // 调试模式：装原始报文采集器（与 `UpstreamService::forward` 同一装法：
    // 只带 id，URL / 头 / 体在真正发送前由 reset_request 填上）
    if debug_traffic::enabled() && !telemetry_id.is_empty() {
        telemetry.set_capture(Arc::new(TrafficCapture::begin(&telemetry_id)));
    }
    // 下游原始请求体在此刻抄一份（request_raw 表的请求侧）：
    // body 还是客户端发来的原值
    let raw_request = raw_body_text(&body);

    // ⑧ 转发：非流式 JSON 请求，成功 / 失败都在 outcome 里
    let outcome = forward_embeddings(&state, &mut payload, &client_model, &headers, &telemetry).await;
    match outcome {
        Ok(outcome) => {
            // 响应正文在记账前抄一份（完整 JSON 文本，透传与入库同源）
            let raw_response = Some(outcome.body_text.clone());
            record_entry(
                &RecordContext {
                    stats: state.request_stats(),
                    telemetry,
                    started_at,
                    model: client_model.clone(),
                    client_model: client_model.clone(),
                    client_reasoning: String::new(),
                    // 状态码透传上游的（成功恒为 2xx）—— 明细记的必须是
                    // 客户端实际看到的那个码（与流式分支同一口径）
                    status: i64::from(outcome.status),
                    raw_request,
                    raw_response,
                    key_id,
                },
                None,
            );
            // 记账已完成：解除断线兜底并注销取消令牌（请求不再在途）
            guard.complete();
            passthrough_json(outcome.status, outcome.body_text)
        }
        Err(error) => {
            // headers 还没发出 → 直接给 OpenAI 风格错误信封。这行只在终端：
            // 同一条 message 紧接着由 record_entry 的 fallback_error 记进
            // 请求日志的「错误」列（与 api::chat 同名分支同一口径）。
            logging::console_line("[Model]", &format!("❌ {}", error.message));
            let status = i64::from(error.http_status().as_u16());
            let message = error.message.clone();
            record_entry(
                &RecordContext {
                    stats: state.request_stats(),
                    telemetry,
                    started_at,
                    model: client_model.clone(),
                    client_model: client_model.clone(),
                    client_reasoning: String::new(),
                    status,
                    // 请求侧正文照存（失败请求的请求体同样是排障材料）；
                    // 响应体由网关自己生成（error 摘要已在明细里），不另存
                    raw_request,
                    raw_response: None,
                    // 最后一个使用点：直接 move，不再 clone
                    key_id,
                },
                Some(message),
            );
            // 记账已完成（含手动终止的 408）：解除兜底并注销令牌
            guard.complete();
            error.payload_response()
        }
    }
}

/// 一次 embeddings 转发的结果：上游 2xx 响应的状态码与原文（已验证是 JSON）。
struct EmbeddingsOutcome {
    /// 上游状态码（成功恒为 2xx；原样透传给客户端）
    status: u16,
    /// 上游响应原文（原样透传；`request_raw` 表的响应侧同源）
    body_text: String,
}

/// 转发一次 embeddings 请求（分派固定到小浣熊，理由见模块头）。
///
/// 编排（账号选择 → 凭证 → 构造 → 发送 → 401 刷新重试一次）是
/// `upstream::provider_loop::attempt_queue` 的单家最小投影：每一步的口径
/// （verbose 文案、telemetry 的成对调用、明细定稿时机）都照那条链对齐。
/// 每个终态出口都先把本轮尝试明细定稿（`finish_last_attempt`）再返回错误，
/// 保证「起头恰好一次、定稿恰好一次」的明细配对不被本文件打破。
async fn forward_embeddings(
    state: &ServerState,
    payload: &mut Value,
    client_model: &str,
    client_headers: &HeaderMap,
    telemetry: &Arc<RequestTelemetry>,
) -> Result<EmbeddingsOutcome, GatewayError> {
    let store = state.store();
    let adapter = adapter_for(ProviderKind::Raccoon);
    // ── 模型名改写（发送侧）────────────────────────────────────
    // 与 chat 的 `payload::send_body` 同一语义：记账 / 日志里的模型保持客户端
    // 原值（handler 已记），只把**发出去的字节**里的 model 换成该家认的真名
    //（`sn-` 前缀别名等既有映射；embeddings 型号不在目录里时 wire_target
    // 原样返回本名 —— 行为即透传）。
    let wire = wire_target_for_provider(client_model, PROVIDER_ID, None);
    if !wire.model.eq_ignore_ascii_case(client_model) {
        logging::verbose(
            "[Upstream]",
            &format!(
                "provider={PROVIDER_ID} 按该家目录改写模型名 {client_model} → {}（备援名）",
                wire.model
            ),
        );
        if let Some(object) = payload.as_object_mut() {
            object.insert("model".to_string(), Value::String(wire.model.clone()));
        }
    }
    telemetry.note_upstream_model(&wire.model);
    // embeddings 没有思考等级：wire.reasoning 不消费，也不问 outbound_reasoning

    // ── 账号选择 ──────────────────────────────────────────────
    // chat 走 rotate 的全局队列（优先级 → 429 冷却 → 换号）；embeddings 取
    // 小浣熊组的队首（`current_entry_for_provider`：启用 + 有凭证 +
    // 按（优先级, 加入时间），与转发「没有账号记录时该家的默认账号」同源）。
    let entry = store.current_entry_for_provider(PROVIDER_ID);
    let account_id = entry
        .as_ref()
        .map(|item| item.id.clone())
        .unwrap_or_default();
    // 出口：账号级代理（与转发链路同源 —— 账号会话里配的 proxy 对所有
    // provider 生效；无账号记录 = 默认登录态旁路，直连）
    let proxy: Option<ResolvedProxy> = entry
        .as_ref()
        .and_then(|item| session_proxy(&item.session));

    // ── 凭证 ─────────────────────────────────────────────────
    // `ensure_access_token` 含临期主动刷新（与 chat 的凭证准备同一入口；
    // account_id 为空串时走环境变量旁路 / 桌面端实时登录态）。
    // 有账号记录时失败不致命：沿用会话里现有的 token 继续发，真失效由下面
    // 401 → 刷新重试那条路径兜底（与 attempt_queue 同一取向 —— 这里提前报错
    // 反而会让一个本来能成功的请求失败）。
    let ensured = adapter.ensure_access_token(store, &account_id).await;
    let mut session = match entry.as_ref() {
        Some(item) => match &ensured {
            Ok(token) if !token.is_empty() => bearer_session(token),
            _ => {
                if let Err(error) = &ensured {
                    logging::verbose(
                        "[Upstream]",
                        &format!(
                            "账号 {account_id} 的凭证准备失败（沿用现有 token）: {}",
                            error.message
                        ),
                    );
                }
                item.session.clone()
            }
        },
        // 没有账号记录：全靠默认登录态。拿不到时错误原样透出 —— 它比笼统的
        // 401「请先登录」更贴近真实原因（环境变量为空 / auth.json 缺失）；
        // 刷新成功但 token 为空串则给缺凭证的明确文案。
        None => match ensured {
            Ok(token) if !token.is_empty() => bearer_session(&token),
            Ok(_) => {
                return Err(GatewayError::with_status(
                    401,
                    "小浣熊账号缺少 accessToken，无法转发",
                ));
            }
            Err(error) => return Err(error),
        },
    };

    // ── 尝试起头（与 attempt_queue 同一成对口径：note_attempt → note_attempt_started）
    let attempt_account = account_display_name(store, &account_id, &session);
    telemetry.note_attempt(
        if account_id.is_empty() {
            None
        } else {
            Some(account_id.as_str())
        },
        &attempt_account,
        PROVIDER_ID,
    );
    telemetry.note_attempt_started(PROVIDER_ID, &attempt_account);

    // ── 发送循环：首次 + 401 刷新后同账号重试一次 ─────────────────
    // 与 chat 的「动作 2」同档：TokenExpired → 强制刷新凭证 → 同一账号再发
    // 一次。刷新重试**不**给本轮明细定稿（同账号重试不算新尝试，口径见
    // TelemetrySnapshot::attempts），由重试那次的出口收尾。
    let mut refreshed = false;
    loop {
        // 手动终止：发送前先看令牌（与 send_with_retry 同一位置）
        if telemetry.is_cancelled() {
            telemetry.finish_last_attempt(
                Some(cancellation::MANUAL_TERMINATED_STATUS),
                Some(cancellation::MANUAL_TERMINATED),
            );
            return Err(cancellation::cancelled_error());
        }
        // 构造请求计划可能失败（适配器自己的校验：小浣熊账号缺 accessToken
        // → 401）。先给明细定稿再返回 —— 那条「起头」不能悬空（与
        // attempt_queue 同一处理）。
        let plan = match adapter.build_chat_request(&session, payload, client_headers) {
            Ok(plan) => plan,
            Err(error) => {
                telemetry.finish_last_attempt(
                    Some(i64::from(error.status_code)),
                    Some(&error.message),
                );
                return Err(error);
            }
        };
        // chat URL → embeddings URL：`build_chat_request` 产出的固定形态是
        // `{llmBase}/chat/completions`（见 raccoon::mod），把路径尾巴换掉即可
        // 复用同一套凭证头与基址（基址指向 OpenClaw 网关时得到的就是文档里的
        // `/v1/embeddings`）。尾巴对不上只可能是适配器契约变了（内部契约错误），
        // 按 500 明确报出，绝不悄悄发错路径。
        let Some(url) = plan
            .url
            .strip_suffix(CHAT_PATH)
            .map(|base| format!("{base}/embeddings"))
        else {
            let error = GatewayError::with_status(
                500,
                "内部契约错误：小浣熊请求 URL 不是 chat 形态，无法改写为 embeddings",
            );
            telemetry.finish_last_attempt(Some(i64::from(error.status_code)), Some(&error.message));
            return Err(error);
        };
        // 序列化失败只可能是内部数据坏了（与 attempt_queue 同一口径收敛成 500）
        let payload_text = match serde_json::to_string(&plan.body) {
            Ok(text) => text,
            Err(error) => {
                let gateway = GatewayError::new(format!("请求体序列化失败: {error}"));
                telemetry.finish_last_attempt(
                    Some(i64::from(gateway.status_code)),
                    Some(&gateway.message),
                );
                return Err(gateway);
            }
        };
        let transport = TransportRequest {
            url,
            headers: plan.headers,
            payload: payload_text,
            proxy: proxy.clone(),
        };
        // 调试模式：抓一份即将发出去的原始报文（与 attempt_queue 同一位置；
        // 重试覆盖前一次 ——「最后一次为准」）
        let capture = telemetry.capture();
        if let Some(capture) = capture.as_deref() {
            capture.reset_request(&transport.url, PROVIDER_ID, &transport.headers, &plan.body);
        }
        // 阶段：这一下就是真正发出上游请求的时刻（与 send_with_retry 同义）
        telemetry.note_phase(LogPhase::Waiting);
        // 发送；挂了取消令牌就 select 它（镜像 provider_loop::send_or_cancel：
        // 置位后立即醒来，不必等上游响应头）
        let sent = match telemetry.cancel_token() {
            Some(token) => tokio::select! {
                result = send_chat_request(&transport) => result,
                _ = token.cancelled() => Err(UpstreamRequestError {
                    message: cancellation::MANUAL_TERMINATED.to_string(),
                    reason: cancellation::MANUAL_TERMINATED.to_string(),
                }),
            },
            None => send_chat_request(&transport).await,
        };
        let response = match sent {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                let status = response.status().as_u16();
                // 错误响应体的读取受「非流式响应超时」管（与 send_with_retry
                // 同一配置）：上游接了错误响应却迟迟不吐完出错体时，不能让
                // 「读错误」把请求挂住 —— 读不出来就当上游没给细节，分类仍按
                // 状态码走（classify_error 只看 status 也能给出结论）。
                let detail = {
                    let budget = Duration::from_millis(config::timeout_settings().body_ms());
                    match tokio::time::timeout(
                        budget,
                        read_upstream_error(response, capture.as_deref()),
                    )
                    .await
                    {
                        Ok(detail) => detail,
                        Err(_elapsed) => UpstreamErrorDetail {
                            code: None,
                            message: format!("非流式响应超时({}秒)", budget.as_secs()),
                        },
                    }
                };
                let class = adapter.classify_error(status, &detail.to_value());
                // 动作 2：401 → 强制刷新凭证后同账号重试一次（与 chat 同档）。
                // 刷新失败按 401 终态透出 —— 这里无号可换（差异 2），文案仍是
                // 适配器给的「上游返回 401: …」。
                if let UpstreamErrorClass::TokenExpired { message } = &class {
                    if !refreshed {
                        refreshed = true;
                        logging::console_line(
                            "[Upstream]",
                            &format!("⚠️ {message}，刷新凭证后同账号重试"),
                        );
                        match adapter.refresh_access_token(store, &account_id).await {
                            Ok(token) if !token.is_empty() => {
                                session = bearer_session(&token);
                                continue;
                            }
                            _ => {
                                let error = GatewayError::with_status(401, message.clone());
                                telemetry.finish_last_attempt(
                                    Some(i64::from(status)),
                                    Some(&error.message),
                                );
                                return Err(error);
                            }
                        }
                    }
                }
                // 终态：文案由适配器给出（「上游返回 {status}: {上游原文}」，
                // 含限额 / 内容拦截的判定），编排层只组装状态码与上游业务码 ——
                // 与 send_with_retry 的终端出口同形。
                let (out_status, message, upstream_code) = match &class {
                    UpstreamErrorClass::QuotaLimited { status, message, upstream_code, .. } => {
                        (*status, message.clone(), *upstream_code)
                    }
                    UpstreamErrorClass::ContentBlocked { status, message, upstream_code } => {
                        (*status, message.clone(), *upstream_code)
                    }
                    UpstreamErrorClass::Fatal { status, message, upstream_code } => {
                        (*status, message.clone(), *upstream_code)
                    }
                    UpstreamErrorClass::TokenExpired { message } => {
                        (status, message.clone(), detail.code)
                    }
                };
                // 这一行只在终端留痕：请求日志那侧由本轮明细的 error（同一个
                // message）回答，两处不再各写一份（与 send_with_retry 同一口径）
                logging::console_line("[Upstream]", &format!("上游错误 HTTP {status}: {message}"));
                telemetry.finish_last_attempt(Some(i64::from(out_status)), Some(&message));
                return Err(
                    GatewayError::with_status(i32::from(out_status), message)
                        .with_optional_code(upstream_code),
                );
            }
            Err(error) => {
                // 手动终止：不把它当传输失败（原因不是链路抖动）
                if telemetry.is_cancelled() {
                    telemetry.finish_last_attempt(
                        Some(cancellation::MANUAL_TERMINATED_STATUS),
                        Some(cancellation::MANUAL_TERMINATED),
                    );
                    return Err(cancellation::cancelled_error());
                }
                // 传输层失败（DNS / 代理 / 连接）：embeddings 不做退避重试
                //（差异 3），按既有口径收敛成 502 直接透出
                let gateway = error.to_gateway_error();
                telemetry.finish_last_attempt(
                    Some(i64::from(gateway.status_code)),
                    Some(&gateway.message),
                );
                return Err(gateway);
            }
        };
        // ── 成功：读响应体 → 提取 usage → 原样透传 ────────────────
        let response_status = response.status().as_u16();
        // 调试报文的响应侧：attach_response 必须在 consume response 之前
        if let Some(capture) = capture.as_deref() {
            capture.attach_response(response_status, response.headers());
        }
        // 首响：非流式请求的「第一个字节」就是响应本身（旁路槽与聚合路径同一处）
        telemetry.note_first_frame();
        // 响应体的读取同样受「非流式响应超时」管（与错误体同一预算）
        let text = {
            let budget = Duration::from_millis(config::timeout_settings().body_ms());
            match tokio::time::timeout(budget, response.text()).await {
                Ok(Ok(text)) => text,
                Ok(Err(error)) => {
                    let gateway =
                        GatewayError::with_status(502, format!("读取上游响应失败: {error}"));
                    telemetry.finish_last_attempt(
                        Some(i64::from(gateway.status_code)),
                        Some(&gateway.message),
                    );
                    return Err(gateway);
                }
                Err(_elapsed) => {
                    let gateway = GatewayError::with_status(
                        502,
                        format!("非流式响应超时({}秒)", budget.as_secs()),
                    );
                    telemetry.finish_last_attempt(
                        Some(i64::from(gateway.status_code)),
                        Some(&gateway.message),
                    );
                    return Err(gateway);
                }
            }
        };
        if let Some(capture) = capture.as_deref() {
            capture.push(text.as_bytes());
        }
        // 解析校验 + usage 旁路：embeddings 响应按 OpenAI 形状带 usage
        //（prompt_tokens / total_tokens）—— 报表与 Key 配额计量都吃得到；
        // completion_tokens 缺失按 0（`extract_usage` 的兼容规则）。不是 JSON
        // 对象则不给客户端透传半截坏响应，按 502 明确报出。
        let parsed = serde_json::from_str::<Value>(&text).ok();
        let Some(response_body) = parsed.filter(Value::is_object) else {
            let gateway = GatewayError::with_status(
                502,
                "上游返回了非 JSON 的 embeddings 响应，无法透传",
            );
            telemetry.finish_last_attempt(Some(i64::from(gateway.status_code)), Some(&gateway.message));
            return Err(gateway);
        };
        if let Some(usage) = response_body.get("usage") {
            telemetry.report_usage(usage);
        }
        // 成功出口：这一轮的结果是「成功 + 状态码」，明细在这里定稿（与
        // attempt_queue 的成功出口同一位置与口径）
        telemetry.finish_last_attempt(Some(i64::from(response_status)), None);
        return Ok(EmbeddingsOutcome { status: response_status, body_text: text });
    }
}

/// 上游 2xx 响应的原样下发（状态码透传 + `application/json`）。
///
/// 用**上游原文**而不是反序列化再序列化的值：透传层不重排键序、不改数字精度，
/// 客户端拿到的响应与上游给的语义等价且逐字节同源（usage 已在转发层旁路提取，
/// 不影响这里透传原文）。charset 显式写上 —— 与 `pipeline::json_response` 同一口径。
fn passthrough_json(status: u16, text: String) -> Response {
    let mut response = Response::new(Body::from(text));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

/// 只有 token 的最小会话（provider_loop 给环境变量旁路构造的就是这个形状；
/// 小浣熊的 `build_chat_request` 只读 `auth.accessToken`）。
fn bearer_session(token: &str) -> Value {
    json!({
        "auth": {
            "accessToken": token,
            "tokenType": "Bearer",
        },
    })
}

/// 账号展示名（与 `upstream::account_label` 同一口径：账号名 → 会话昵称 → id；
/// 那个函数是 pub(super)，这里按同一优先级内联一份最小实现）。
///
/// 账号名从**公开形态**里查（`accounts_for_provider` 与界面同源）；无账号记录
/// （默认登录态旁路）时看会话昵称，再退回 id，全空给 `-`。
fn account_display_name(store: &AccountStore, account_id: &str, session: &Value) -> String {
    if !account_id.is_empty() {
        // accounts_for_provider 返回的是**值**（临时对象），先落局部再借 ——
        // 链在一条语句里写完会让临时值在借用存活期内被释放（E0716）
        let listing = store.accounts_for_provider(PROVIDER_ID);
        let found = listing
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(account_id))
            .and_then(|item| item.get("name"))
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty());
        if let Some(name) = found {
            return name.to_string();
        }
    }
    session
        .get("account")
        .and_then(|account| account.get("nickname"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if account_id.is_empty() {
                "-".to_string()
            } else {
                account_id.to_string()
            }
        })
}
