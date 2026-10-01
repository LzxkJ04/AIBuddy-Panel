//! POST /api/shutdown —— 停止服务（设置页「危险操作」面板的落点）。
//!
//! ── 语义 ────────────────────────────────────────────────────
//! 「要彻底关闭对外服务」的显式动作：进程整体退出，面板与 /v1/* 同时下线，
//! 与 Ctrl+C / SIGTERM / `docker stop` 等价（headless 形态宿主是容器时，
//! 恢复靠 `docker start agent2api` 或 `docker compose up -d`）。日常停用
//! 单个账号请走 /api/accounts*，不要用这里。
//!
//! ── 停机机制为什么是「先落盘再 exit(0)」而不是优雅停机信号 ──
//! 项目里现成的优雅停机入口是 `server::start()` 返回的 oneshot 发送端
//! （`with_graceful_shutdown` 消费它），但它被**入口二进制**持有
//! （headless 的 `main` / 桌面壳的 BackendHandle），HTTP handler 够不着；
//! 且即便把信号递过去，headless 的 main 仍阻塞在 `wait_for_shutdown_signal()`
//! 上，serve 停了进程也不退 —— 达不到「彻底关闭」的目的。
//! 因此走任务书给定的兜底：`std::process::exit(0)` 前先落盘。落盘之所以
//! 只剩统计库一次 checkpoint：账号 / 日志 / 访问控制的每次写入都即时提交
//! 事务（见 `request_stats.rs` flush 的模块说明），没有「内存里没落盘」的
//! 状态；`RequestStats::flush()` 把 WAL 并回主库、清掉 `-wal` / `-shm`
//! 残留，与 `server::start()` 停机路径做的事一致，让重启后备份时只有一个
//! 文件是真相。
//!
//! ── 为什么先回响应、延时退出 ────────────────────────────────
//! `exit(0)` 立即杀死进程，若在 handler 里同步调用，连接随进程一起断，
//! 前端只会看到网络错误而不是「服务已停止」。所以响应先发出去，落到
//! `spawn_task` 的任务里睡 500ms 再收尾退出 —— 时长与入口二进制自己的
//! 停机间隙（300ms，见 aibuddy-panel-server.rs）同一量级，本地回包绰绰
//! 有余；期间在途的其它请求不再保证跑完（这是「停止服务」的字面语义）。
//!
//! ── 接线（主会话）────────────────────────────────────────────
//! api/mod.rs：`pub mod shutdown_api;`；http.rs：protected 组挂
//! `.route("/api/shutdown", post(api::shutdown_api::handle))` ——
//! 停机是最高危操作之一，必须鉴权，不得进 public 组。

use axum::extract::State;
use axum::response::Response;
use serde_json::json;

use crate::server::http::ok_json;
use crate::server::logging;
use crate::server::ServerState;

/// 收到请求到真正退出之间的间隙：让 axum 把响应发上闭环连接。
const EXIT_DELAY_MS: u64 = 500;

/// POST /api/shutdown —— 记日志、落盘、进程退出。
///
/// 响应体是管理信封（`{success:true,message}`，与 /api/* 一致），message
/// 给前端直接弹的恢复指引；真值语义只在「响应送达」这一瞬成立 —— 之后
/// 进程退出，任何后续请求都会连接失败，那是预期行为而不是故障。
pub async fn handle(State(state): State<ServerState>) -> Response {
    // 先记日志再排退出：LogStore 的 append 即时提交事务（见模块头），
    // 这条「为什么停机」一定留在盘上，重启后能在事件日志里看到来龙去脉
    logging::log(
        "[Server]",
        "⚠️ 收到停止服务请求（面板「危险操作」触发）：服务即将下线，恢复需在服务器上手动启动",
    );
    let request_stats = state.request_stats();
    crate::spawn_task(async move {
        tokio::time::sleep(std::time::Duration::from_millis(EXIT_DELAY_MS)).await;
        // 统计收尾与 server::start 的停机路径同款：WAL 并回主库、清掉残留。
        // 此刻锁上可能还有别的写方（在途请求记账），flush 自己会取锁串行化
        request_stats.flush();
        logging::log("[Server]", "统计库已收尾（WAL 并回主库），进程退出");
        std::process::exit(0);
    });
    ok_json(json!({
        "success": true,
        "message": "服务已停止。请在服务器上执行 docker start agent2api 或 docker compose up -d 恢复。",
    }))
}
