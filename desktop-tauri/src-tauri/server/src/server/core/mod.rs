//! 领域逻辑（端点常量、提供商注册表、账号存储、鉴权会话、无头登录、出网代理、模型目录、转发、脱敏）。
//!
//! 对照 Node 版 src/*.mjs 的落位：
//!   endpoints.rs         端点/版本/UA/上下文          （workbuddy-endpoints.mjs）
//!   providers/           提供商注册表（id/label）+ 聚合模型目录 + 模型路由
//!                        （Agent2API 改造新增；见本文件末尾的模块分工）
//!   account_store/       账号列表、凭证、优先级、迁移  （workbuddy-account-store.mjs）
//!   account_transfer.rs  账号导入/导出                （workbuddy-account-transfer.mjs）
//!   auth_http.rs         上游请求发送与解包、鉴权错误   （workbuddy-auth.mjs 的 api/unwrap）
//!   auth.rs              会话、getStatus、鉴权头、刷新（workbuddy-auth.mjs 会话部分）
//!   login.rs             无头登录与登录任务表          （auth.mjs 登录部分 + server.mjs 任务表）
//!   clash.rs             Clash Verge 配置读取与快照缓存（workbuddy-proxy.mjs 的 Clash 部分）
//!   proxies.rs           账号级代理归一/解析/描述       （workbuddy-proxy.mjs 的代理部分）
//!   egress.rs            出网点（按出口缓存 Client）+ 连通性（workbuddy-proxy.mjs 的 dispatch 部分）
//!   billing/             积分 / 签到 / 运营活动         （workbuddy-billing.mjs）
//!   models/              workbuddy 模型目录（内置 + /v3/config 刷新）（workbuddy-models.mjs）
//!   sanitize.rs          出站请求体指纹脱敏（硬编码规则集，照搬 workbuddy2api）
//!   prompt.rs            网关自有系统提示词（透传 / 替换 / 追加，照搬 workbuddy2api）
//!   degrade.rs           内容拦截降级状态机（撞审核误报 → 中性提示词到次日 00:00）
//!   routing.rs           账号选路（优先级 + 限额冷却）  （workbuddy-routing.mjs）
//!   upstream/            对话转发（选路/轮换/SSE/聚合） （workbuddy-upstream-client.mjs）
//!   auto_checkin.rs      定时签到调度（轮询 + 补签）    （workbuddy-auto-checkin.mjs）
//!   growth_queue.rs      「WorkBuddy 成长任务」执行队列：全账号扫描 → 待办入队 →
//!                        Semaphore 并发执行（账号内串行）→ 异步计分回读 →
//!                        自动领奖 → 进度状态（供 /api/growth-tasks/* 轮询）；
//!                        上游动作落在 `billing::{growth, report, streak, travel}`
//!   credential_maintenance.rs 凭证自动维护（遍历账号 → 刷新临期凭证；判定逻辑
//!                        在适配器，见 `providers::adapter` 的扩展 5）
//!   custom_providers.rs  自定义提供商（用户自建上游端点）的存储与校验；
//!                        管理 API 在 `api::custom_providers`，账号接入在
//!                        `account_store::custom_accounts`
//!   scheduled_tasks.rs   间隔型定时任务注册表与调度循环（凭证维护 / 模型刷新 /
//!                        定时查询积分 / 两个前端自动刷新；开关与间隔来自 config，
//!                        路由见 `api::scheduled_tasks`）
//!   usage_query.rs       余额 / 积分查询（目标集合解析 + 跨账号并发 + 定时那一轮的
//!                        结果快照；查询逻辑在 core 是为了让手动与定时共用一份）
//!   key_scope.rs         本次请求命中的网关 Key 及其可用提供商 / 可用模型限制
//!                        （R9；中间件放入请求扩展，handler 与转发层读出）
//!   key_quota.rs         网关 Key 的 Token 配额计量与「过期 / 超配额」准入判定
//!                        （用量落 kv 的 `keyQuotaUsage`；判定点在三条协议入口，
//!                        计量点在 `api::pipeline::record_entry` 收尾记账）
//!   notify.rs            多渠道通知（Webhook / Telegram / 钉钉 / …16 种 HTTP
//!                        提供商）与账号异常告警的公共入口；渠道配置在配置顶层
//!                        键 `notifyChannels`，告警开关在 `notifyAlerts`，
//!                        管理 API 在 `api::notify_api`
//!   update/              软件更新（版本/出网/下载状态机）（workbuddy-update.mjs）
//!
//! ── 模型清单的三个层次（Agent2API 改造 W2a-T2）─────────────
//!   providers/mod.rs      身份与元数据（id/label/默认路由优先级）
//!   models/               **workbuddy 一家**的清单（内置 + 远程刷新）
//!   providers/catalog.rs  聚合目录：各家清单合并成 /v1/models 的单一视图
//!   providers/router.rs   模型名 → provider 候选链（聚合目录 + providerRoute 优先级）
//! 前三者回答「有哪些模型」，最后一者回答「先试哪一家」。
//! 各家清单的**持久化**（远程拉到的那份在进程重启后由它读回，不再回落到内置
//! 清单）在 `providers/catalog_cache.rs` —— 它横跨上面三层，不属于任何一层。
//!
//! 约定：core 里的模块只做纯逻辑 + 文件读写 + 上游 HTTP，不认识 axum；
//! api/ 里的 handler 负责把 HTTP 输入转成 core 调用、再把结果转成响应。

pub mod account_store;
pub mod account_transfer;
pub mod api_keys;
pub mod auth;
pub mod auth_http;
pub mod auto_checkin;
pub mod backup;
pub mod billing;
pub mod capability;
pub mod clash;
pub mod credential_maintenance;
pub mod custom_providers;
pub mod debug_traffic;
pub mod degrade;
pub mod egress;
pub mod endpoints;
// 成长任务的动作实现（autoActions 移植：判据事件链 / 真实对话 / 专家链 /
// 夜猫子 / mp 口径 Sequential 链），由 `growth_queue` 逐项调度
pub mod growth_actions;
// 「WorkBuddy 成长任务」执行队列（扫描/入队/并发执行/回读/领奖；路由在
// `api::growth_tasks`，上游动作在 `billing::{growth, report, streak, travel}`
// 与 `growth_actions`）
pub mod growth_queue;
// 成长任务定时调度（growth 队列 01:00 / travel [9,21] / blackcat 23:00 /
// streak 挂签到后；默认全关，配置与游标落 task_state 的 kv，设置 API 在
// `api::growth_tasks::schedule`）
pub mod growth_schedule;
pub mod import_ccswitch;
// 网关 Key 的额度 / 有效期（quotaTokens / expiresAt 的消费点：转发前准入判定
// + 收尾 Token 计量；存储与展示见 `core::api_keys`，作用域传播见 `key_scope`）
pub mod key_quota;
pub mod key_scope;
pub mod login;
pub mod model_rules;
pub mod models;
// 多渠道通知与账号异常告警（渠道管理 / 告警设置 / 测试的 API 在 `api::notify_api`；
// 事件源的埋点位置见该模块 `notify_account_event` 的说明）
pub mod notify;
// 账号探活（定时对启用账号发最小上游请求 + 连败自动停用；设置 API 在
// `api::probe_api`，单账号手动测试在 `api::account_test`）
pub mod probe;
pub mod prompt;
pub mod protocol;
pub mod providers;
pub mod proxy_pool;
pub mod proxies;
pub mod routing;
pub mod sanitize;
pub mod scheduled_tasks;
pub mod task_state;
pub mod update;
pub mod upstream;
pub mod usage_query;
