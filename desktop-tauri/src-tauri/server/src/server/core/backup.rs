//! 数据备份（安全与运维切片，功能四的执行层）。
//!
//! ── 备份是什么形态 ──────────────────────────────────────────
//! 一份**整库快照文件**：`VACUUM INTO '{path}'` 把统一库（含 kv 配置、
//! 账号、日志、统计……全部表）收敛成一个独立、自洽的 SQLite 文件，落在
//! `{config_dir}/backups/`。选 `VACUUM INTO` 而不是逐表导出 JSON 的理由：
//!   - 它在一条语句里拿到**事务一致**的快照（读的是备份那一刻的完整库，
//!     含 WAL 里未 checkpoint 的页），不需要自己拼「多表一致性」；
//!   - 产物直接是可恢复的库文件 —— 灾难恢复 = 关进程、换文件，不依赖
//!     本程序还活着（JSON 快照的导入反而依赖一个能跑的网关）；
//!   - 零新依赖：rusqlite 直通 SQLite 3.27+ 的原生能力。
//! 结构化导出 / 导入（JSON 快照）是另一条路，在 `api::backup_api` 里，
//! 服务「把配置搬到另一台机器」；本模块服务「本机定时兜底」。
//!
//! ── WAL 提示（db::mod.rs 留过的话）──────────────────────────
//! 库是 WAL 模式，`VACUUM INTO` 的产物是**收敛后**的独立文件（不需要
//! `-wal` / `-shm` 伴随）—— 正是当年「备份要么在线备份、要么三件一起拷」
//! 那条注释要的答案。
//!
//! ── 定时 ────────────────────────────────────────────────────
//! 排期、占位、失败退避全部复用 `core::task_state`（落库、跨重启、跨实例），
//! 与 `core::scheduled_tasks` 同一框架，只是不进那份**上游任务**注册表：
//! 备份不打上游、没有「间隔可调」的需求（固定每天一次），进注册表反而要
//! 为它扩 config 的解析层。开关与保留份数是独立设置（`api::backup_api`
//! 读写），本模块自起一个轮询循环（`spawn`，由 `ServerState::bootstrap`
//! 接线），tick 里先看开关再判定到期 —— 关闭时一次库读都不发生。
//!
//! ── 保留份数 ────────────────────────────────────────────────
//! 每次成功备份后清一次旧文件：文件名内嵌毫秒时间戳（等宽十进制），按名
//! 排序即按时间排序，超出保留份数的最旧者删除。只认自己前缀的文件，
//! 用户手工放进目录的其它文件一概不动。
//!
//! ── 硬约束：持锁期间不做文件 IO 与日志 ──────────────────────
//! `VACUUM INTO` 在 `Db::with` 的连接锁内执行（它本来就是一条 SQL），
//! 闭包里只跑这一条语句；目录创建、删旧文件、打日志全部在锁外
//! （`logging::log` 要写同一个库，锁内调用是死锁，见 `db::mod` 模块头）。

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::server::config;
use crate::server::core::task_state::{self, Claim};
use crate::server::db::Db;
use crate::server::logging;

/// `core::task_state` 里的排期键（不是 kv 顶层键 —— task_state 把所有任务
/// 打包在 `backgroundTaskState` 一个保留键里，无需再登记 schema）
pub const TASK_KEY: &str = "scheduledBackup";

/// 备份目录名（相对 `config::config_dir()`）
pub const BACKUP_DIR_NAME: &str = "backups";
/// 备份文件名前缀（保留清理只认这个前缀 + .db 后缀）
pub const FILE_PREFIX: &str = "agent2api-backup-";

/// 定时备份间隔：24 小时（固定值，没有可调间隔的需求，见模块头）
pub const BACKUP_INTERVAL_MS: i64 = 24 * 60 * 60_000;
/// 保留份数的默认值（需求口径：默认关、保留 7 份）
pub const DEFAULT_KEEP: i64 = 7;
/// 保留份数的合法范围：至少留 1 份（0 = 备了就删，没有意义），
/// 上限 90 份（每天一份 ≈ 一季度的历史）
pub const KEEP_MIN: i64 = 1;
pub const KEEP_MAX: i64 = 90;

/// 轮询判定间隔：到点后最多晚一分钟执行（备份对分钟级精度无感）
const TICK_MS: u64 = 60_000;

/// 进程级库句柄（照 `core::task_state` / `core::proxy_pool` 的形态：
/// bootstrap 时 install 一次）
static DB: OnceLock<Option<Db>> = OnceLock::new();

/// 接线（`ServerState::bootstrap` 调用一次）。重复调用无副作用。
pub fn install(db: Option<Db>) {
    let _ = DB.set(db);
}

fn database() -> Result<&'static Db, String> {
    DB.get()
        .and_then(Option::as_ref)
        .ok_or_else(|| "备份数据库不可用".to_string())
}

// ─── 设置（落配置键 backupSettings，读写都走 config 管线）─────────

/// 备份设置的配置键（config 顶层键 → kv 行；与 `debugMode` 同类开关）。
/// 键名核对过不与 `db::schema::RESERVED_KV_KEYS` 相撞。
pub const KEY_BACKUP_SETTINGS: &str = "backupSettings";

/// 定时备份设置（`backupSettings` 键的内容）
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupSettings {
    /// 定时备份开关（默认关）
    pub enabled: bool,
    /// 保留份数（默认 7）
    pub keep: i64,
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self { enabled: false, keep: DEFAULT_KEEP }
    }
}

/// 设置的部分更新入参（`None` = 该项不动）
#[derive(Clone, Copy, Debug, Default)]
pub struct BackupPatch {
    pub enabled: Option<bool>,
    pub keep: Option<i64>,
}

/// 读当前设置（配置里没有该键 / 形状不对 / 越界时回落默认值）。
///
/// 与 `config::days_field` 等「读侧回落」同一取向：手改库写坏一个值，
/// 不该让备份循环报错或拿到天文数字。每次读走 `config::current()`（克隆
/// 整份 raw）—— 消费点是每分钟的 tick 与设置页读写，量级可忽略；
/// 它不在任何逐请求热路径上，不值得为此给 config 加解析字段。
pub fn settings() -> BackupSettings {
    let mut parsed = config::current()
        .raw()
        .get(KEY_BACKUP_SETTINGS)
        .and_then(|value| serde_json::from_value::<BackupSettings>(value.clone()).ok())
        .unwrap_or_default();
    parsed.keep = parsed.keep.clamp(KEEP_MIN, KEEP_MAX);
    parsed
}

/// 应用设置更新（写库 + 刷新配置快照），返回生效后的值。
///
/// 调用方（`api::backup_api::put_settings`）**必须先校验范围**：本函数按
/// 「已合法」处理，越界值在写入前再夹一次只是防御（与 config 各 setter
/// 对 `interval` 的双重收口同一理由）。
pub fn apply_settings(patch: BackupPatch) -> BackupSettings {
    let mut next = settings();
    if let Some(enabled) = patch.enabled {
        next.enabled = enabled;
    }
    if let Some(keep) = patch.keep {
        next.keep = keep.clamp(KEEP_MIN, KEEP_MAX);
    }
    let payload = serde_json::json!({ "enabled": next.enabled, "keep": next.keep });
    if !config::update_raw_field(KEY_BACKUP_SETTINGS, payload) {
        logging::log("[Backup]", "⚠️  备份设置写入失败，本次运行内仍生效");
    }
    next
}

/// 把排期置为「现在就到期」（设置页刚把备份从关拨到开时调用 ——
/// 与定时任务框架「开启即跑一次」的语义一致；失败冷却仍优先）。
pub fn schedule_now() -> Result<(), String> {
    task_state::schedule_now(TASK_KEY)
}

// ─── 备份执行 ───────────────────────────────────────────────

/// 备份目录（`{config_dir}/backups/`；路径事实来源是 `config::config_dir`，
/// 与库文件同一条派生链）
pub fn backup_dir() -> PathBuf {
    config::config_dir().join(BACKUP_DIR_NAME)
}

/// 执行一次备份，返回快照文件路径。
///
/// 同名文件（同一毫秒内两次调用）按冲突处理而不是覆盖 —— 备份产物绝不能
/// 静默互相顶掉。库不可用 / 执行失败时清掉可能的半截产物再报错。
pub fn run_backup() -> Result<PathBuf, String> {
    let db = database()?;
    let dir = backup_dir();
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建备份目录失败: {error}"))?;
    let path = dir.join(format!("{FILE_PREFIX}{}.db", logging::now_ms()));
    if path.exists() {
        return Err("同名备份文件已存在，请稍后重试".to_string());
    }
    // VACUUM 是纯词法语句，不支持绑定参数 —— 路径以字面量拼进 SQL。
    // 路径来自本进程的 config_dir + 时间戳，把单引号翻倍防拼坏（Windows
    // 用户名 / 自定义 HOME 里都可能出现引号类字符）。
    let escaped = path.to_string_lossy().replace('\'', "''");
    let executed = db.with(|conn| {
        conn.execute_batch(&format!("VACUUM INTO '{escaped}';"))
            .map_err(|error| format!("备份数据库失败: {error}"))
    });
    match executed {
        Some(Ok(())) => {}
        Some(Err(message)) => {
            let _ = std::fs::remove_file(&path);
            return Err(message);
        }
        None => {
            let _ = std::fs::remove_file(&path);
            return Err("数据库不可用，备份未执行".to_string());
        }
    }
    prune_old_backups();
    Ok(path)
}

/// 按保留份数清理旧备份（超出部分删最旧的；只认自己的前缀与后缀）。
/// 单个文件删除失败只告警不清账 —— 删不掉通常是被占用，下轮再试。
fn prune_old_backups() {
    let keep = settings().keep.max(KEEP_MIN) as usize;
    let Ok(entries) = std::fs::read_dir(backup_dir()) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map_or(false, |name| {
                        name.starts_with(FILE_PREFIX) && name.ends_with(".db")
                    })
        })
        .collect();
    // 文件名内嵌 13 位毫秒时间戳（本世纪内等宽），按名排序即按时间排序
    files.sort();
    if files.len() <= keep {
        return;
    }
    let excess = files.len() - keep;
    for path in files.iter().take(excess) {
        if let Err(error) = std::fs::remove_file(path) {
            logging::log(
                "[Backup]",
                &format!("⚠️  删除旧备份失败（{}）: {error}", path.display()),
            );
        }
    }
}

// ─── 定时循环与手动入口（排期全在 task_state，跨重启、跨实例）────

/// 启动定时备份循环（`ServerState::bootstrap` 接线一次；进程内单例）。
///
/// 形态照 `core::scheduled_tasks::spawn`：先按持久化状态恢复排期（从未跑过
/// 则排到「现在」—— 全新开启后的第一轮随即发生），循环每 tick 重读设置与
/// 排期状态，开关关闭时不做任何库访问。真正的执行判定（占位 / 冷却 /
/// 最短间隔）在 `task_state::claim` 内完成，双实例共用一个库时天然只跑一份。
pub fn spawn() {
    crate::spawn_task(async move {
        let _ = task_state::reschedule(TASK_KEY, BACKUP_INTERVAL_MS);
        loop {
            if settings().enabled {
                match task_state::read(TASK_KEY) {
                    Ok(state) => {
                        if !state.running() && logging::now_ms() >= state.due_at() {
                            if let Err(error) = run_scheduled().await {
                                logging::verbose("[Backup]", &format!("定时备份：{error}"));
                            }
                        }
                    }
                    Err(error) => {
                        logging::verbose("[Backup]", &format!("读取备份排期失败：{error}"));
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
        }
    });
}

/// 定时路径的一次执行：占位（非手动、遵守冷却与最短间隔）→ 备份 → 收尾。
/// 被别的实例抢走（Deferred）不算错误。
async fn run_scheduled() -> Result<(), String> {
    let guard = match task_state::claim(
        TASK_KEY,
        BACKUP_INTERVAL_MS,
        false,
        task_state::ManualBackoff::Respect,
        60_000,
    )? {
        Claim::Acquired(guard) => guard,
        Claim::Deferred(_) => return Ok(()),
    };
    // 结果已由 finish 记进任务状态（界面上可见），循环路径不再上抛
    let _ = execute_with_guard(guard);
    Ok(())
}

/// 手动立即备份（设置页按钮）。手动越过普通排期；占位被占 / 冷却中给
/// 可读的等待提示（与 `/api/scheduled-tasks/{id}/run` 同一口径的 400）。
pub fn run_now() -> Result<String, String> {
    let guard = match task_state::claim(
        TASK_KEY,
        BACKUP_INTERVAL_MS,
        true,
        task_state::ManualBackoff::Bypass,
        0,
    )? {
        Claim::Acquired(guard) => guard,
        Claim::Deferred(state) => return Err(state.waiting_message()),
    };
    execute_with_guard(guard)
}

/// 执行备份并按结果收尾排期（成功 / 失败都重排到下一间隔，失败另有退避）。
fn execute_with_guard(guard: task_state::RunGuard) -> Result<String, String> {
    match run_backup() {
        Ok(path) => {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string_lossy().to_string());
            let summary = format!("备份完成：{name}");
            guard.finish(true, summary.clone(), None, 0, BACKUP_INTERVAL_MS)?;
            logging::log("[Backup]", &format!("✅ {summary}"));
            Ok(summary)
        }
        Err(message) => {
            guard.finish(false, message.clone(), None, 0, BACKUP_INTERVAL_MS)?;
            logging::log("[Backup]", &format!("❌ {message}"));
            Err(message)
        }
    }
}
