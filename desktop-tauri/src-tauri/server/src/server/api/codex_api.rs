//! Codex CLI 一键接入（照 Buddy2API 的 /admin/codex/setup 形态）。
//!
//! - `GET  /api/codex/status` → `{configExists, authExists, backupExists,
//!   serverUrl, codexDir}`：探测本机 Codex CLI 的配置目录 `~/.codex/` 里
//!   `config.toml` / `auth.json` 是否已存在、有没有 `.bak` 备份。`serverUrl`
//!   是当前面板的 origin（Host 头还原），前端拿它展示「base_url 将写为
//!   {serverUrl}/v1」。
//! - `POST /api/codex/setup`  `{baseUrl?, apiKey?}` → 写两个文件，返回
//!   `{written, skipped, backups, codexDir, baseUrl}`。
//!   `baseUrl` 缺省 = 请求的 origin（与 status 的 serverUrl 同一口径）；
//!   `apiKey` 缺失时**只写 config、跳过 auth**（见下）。
//!
//! ── 写的是什么 ──────────────────────────────────────────────
//! Codex CLI（OpenAI 的本机编码客户端）的供应商与凭证配置就在这两个文件里：
//!   · `config.toml` —— `model_provider = "aibuddy"` +
//!     `[model_providers.aibuddy]`（name / base_url=`{baseUrl}/v1` /
//!     wire_api="chat"）：把 Codex 的对话请求整体指到本网关的 OpenAI 兼容端点。
//!     整文件重写而不是原地改键：混着改会说不清「这份配置里哪些是用户的、哪些
//!     是本面板写的」，重写之前先备份（下条），旧配置永远找得回来；
//!   · `auth.json` —— `{"OPENAI_API_KEY": <apiKey>}`。apiKey 缺失时跳过这个
//!     文件（只写 config）：没有 Key 的 auth.json 等于给 Codex 配了空凭证，
//!     反而会打断它现有的登录方式。
//!
//! ── .bak 备份（绝不覆盖丢失）─────────────────────────────────
//! 目标文件**已存在**时，写入前先复制成 `<原名>.bak`（config.toml.bak /
//! auth.json.bak）。备份失败时 setup 立刻中止：宁可什么都不写，也不冒
//! 「覆盖了旧配置、又没留备份」的险（可能出现的部分成功 —— 第一个文件已写、
//! 第二个备份失败 —— 响应如实报错，重跑一遍 setup 即可补齐）。`.bak` 已存在时
//! 被本次备份覆盖：它的语义是「上一次写入前的状态」，保留最新一份才最有恢复
//! 价值；更旧的版本交给用户自己的备份习惯。
//!
//! ── 敏感度与挂载 ───────────────────────────────────────────
//! 写的是**另一个本机应用**（Codex CLI）的配置文件，apiKey 明文落盘 —— 与
//! 「从其他工具导入」读别人凭证（`api::import_sources`）、/api/keys 写网关
//! 凭证同一档敏感，挂 protected（见 `http::panel_router`）。明文只在
//! 面板表单 → 本机网关 → 本机文件之间流转，不出机器。

use std::path::{Path, PathBuf};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap};
use axum::response::Response;
use serde_json::{json, Value};

use crate::server::errors;
use crate::server::http::{ok_json, parse_body};
use crate::server::logging;
use crate::server::ServerState;

/// 用户主目录（Windows 优先 USERPROFILE，其余平台 HOME；与
/// `core::import_ccswitch` / `core::clash` 同一取序，不引入 dirs crate）。
fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Codex CLI 的配置目录（`~/.codex`）。
fn codex_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".codex"))
}

/// 当前面板的 origin：从请求的 Host 头还原（HTTP/1.1 必带），反向代理形态读
/// `x-forwarded-proto` 补协议；两者都拿不到（极端形态）时退回
/// `http://127.0.0.1:{面板端口}`。
///
/// 为什么不按配置里的监听端口拼 URL：桌面形态面板与网关同端口、headless 分
/// 端口，而经反向代理访问时外部地址与监听地址本来就不一致 —— 请求头里的 Host
/// 才是「用户此刻访问面板用的地址」，Codex 用同一个地址才连得上。
fn panel_origin(state: &ServerState, headers: &HeaderMap) -> String {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    // 多值时取第一个（X-Forwarded-* 是逐跳追加的，第一个是客户端原始协议）
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("http");
    match host {
        Some(host) => format!("{proto}://{host}"),
        None => format!("http://127.0.0.1:{}", state.panel_port.unwrap_or(state.port)),
    }
}

/// base_url 的归一：trim、去结尾斜杠，再剥掉已带的 `/v1` 后缀。
///
/// 写进 config.toml 的永远是 `{base}/v1`（Codex 在其后自己拼 /chat/completions，
/// 与 OpenAI SDK 同一约定）。用户从别处粘贴的地址常带结尾斜杠、甚至已经带了
/// /v1（照着快速接入片段整行复制是常态），先剥掉再拼，重复粘贴也幂等。
fn normalize_base(text: &str) -> String {
    text.trim()
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_string()
}

/// 生成 config.toml 的内容。经 toml crate 序列化：base_url 来自请求体，
/// 字符串转义交给库，不手拼 TOML 文本。
fn config_toml_text(base_url: &str) -> Result<String, String> {
    use toml::{Table as TomlTable, Value as TomlValue};
    let mut provider = TomlTable::new();
    provider.insert("name".to_string(), TomlValue::String("AIBuddy Panel".to_string()));
    provider.insert("base_url".to_string(), TomlValue::String(base_url.to_string()));
    provider.insert("wire_api".to_string(), TomlValue::String("chat".to_string()));
    let mut providers = TomlTable::new();
    providers.insert("aibuddy".to_string(), TomlValue::Table(provider));
    let mut doc = TomlTable::new();
    doc.insert("model_provider".to_string(), TomlValue::String("aibuddy".to_string()));
    doc.insert("model_providers".to_string(), TomlValue::Table(providers));
    toml::to_string_pretty(&doc).map_err(|error| format!("生成 config.toml 内容失败: {error}"))
}

/// 写一个配置文件：目标已存在时先备份成 `<原名>.bak`（语义见模块头）。
///
/// 备份失败返回 Err（调用方立刻中止整个 setup，原文件未动）；写入失败同样。
/// `written` / `backups` 是响应清单，成功时各追加一项。
fn write_with_backup(
    path: &Path,
    text: &str,
    written: &mut Vec<String>,
    backups: &mut Vec<String>,
) -> Result<(), String> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    if path.is_file() {
        let bak_path = path.with_file_name(format!("{name}.bak"));
        std::fs::copy(path, &bak_path)
            .map_err(|error| format!("备份 {name} 失败（已中止写入，原文件未动）: {error}"))?;
        backups.push(format!("{name}.bak"));
    }
    std::fs::write(path, text).map_err(|error| format!("写入 {name} 失败: {error}"))?;
    written.push(name);
    Ok(())
}

/// GET /api/codex/status
///
/// 定位不到主目录时三个布尔一律 false、`codexDir` 为 null：前端按「全新写入」
/// 引导即可，真正的失败由 setup 那条给出可读的 400。
pub async fn get_status(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    let dir = codex_dir();
    let dir_text = dir.as_ref().map(|dir| dir.to_string_lossy().to_string());
    let exists = |name: &str| dir.as_ref().is_some_and(|dir| dir.join(name).is_file());
    ok_json(json!({
        "configExists": exists("config.toml"),
        "authExists": exists("auth.json"),
        "backupExists": exists("config.toml.bak") || exists("auth.json.bak"),
        "serverUrl": panel_origin(&state, &headers),
        "codexDir": dir_text,
    }))
}

/// POST /api/codex/setup
///
/// 顶层不是 JSON 对象的请求体按空对象处理（两个键都缺省 = 用请求 origin、
/// 只写 config）；写入成功后记一条日志（面板「日志」页可见，与其它配置类
/// 写操作同一习惯）。
pub async fn post_setup(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let object = match parse_body(&body) {
        Ok(value) => value.as_object().cloned().unwrap_or_default(),
        Err(error) => return errors::management_error(400, error.message),
    };
    let api_key = object
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let base = object
        .get("baseUrl")
        .and_then(Value::as_str)
        .map(normalize_base)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| normalize_base(&panel_origin(&state, &headers)));
    let base_url = format!("{base}/v1");

    // 目标目录：主目录定位不到 / 建不出来都不写任何文件（数据安全优先）
    let Some(dir) = codex_dir() else {
        return errors::management_error(
            400,
            "无法定位用户主目录（USERPROFILE / HOME），找不到 ~/.codex 的写入位置",
        );
    };
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return errors::management_error(500, format!("创建 {} 失败: {error}", dir.display()));
    }

    let mut written: Vec<String> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut backups: Vec<String> = Vec::new();

    // ① config.toml：model_provider 指向本网关（OpenAI 兼容，wire_api="chat"）
    let text = match config_toml_text(&base_url) {
        Ok(text) => text,
        Err(message) => return errors::management_error(500, message),
    };
    let config_path = dir.join("config.toml");
    if let Err(message) = write_with_backup(&config_path, &text, &mut written, &mut backups) {
        return errors::management_error(500, message);
    }

    // ② auth.json：OPENAI_API_KEY（缺 Key 时跳过 —— 见模块头）
    if api_key.is_empty() {
        skipped.push(json!({
            "file": "auth.json",
            "reason": "未提供 API Key，保持 Codex 现有的登录方式",
        }));
    } else {
        let text = match serde_json::to_string_pretty(&json!({ "OPENAI_API_KEY": api_key })) {
            Ok(text) => text,
            Err(error) => return errors::management_error(500, format!("生成 auth.json 内容失败: {error}")),
        };
        let auth_path = dir.join("auth.json");
        if let Err(message) = write_with_backup(&auth_path, &text, &mut written, &mut backups) {
            return errors::management_error(500, message);
        }
    }

    logging::log(
        "[Codex]",
        &format!(
            "✅ Codex 配置已写入：{} → {}（base_url={base_url}）",
            written.join("、"),
            dir.display(),
        ),
    );
    ok_json(json!({
        "written": written,
        "skipped": skipped,
        "backups": backups,
        "codexDir": dir.to_string_lossy().to_string(),
        "baseUrl": base_url,
    }))
}
