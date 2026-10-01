# 更新日志（AIBuddy Panel 二开版）

本仓库基于 [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api) 二次开发，上游协议引擎全部保留。以下只记录二开改动。

## 2.10.0（2026-10-01）

### 品牌外观
- 新增「品牌」设置分区：自定义**站点标题**与**站点 Logo**，保存后应用于浏览器标签、侧栏品牌区、面包屑、登录页与 favicon（服务端页面注入，登录前的登录页同样生效）。
- 新增后端 `GET /api/panel/branding`（公开读取）与 `PUT /api/branding`（登录后保存），品牌数据持久化在 SQLite kv 表。
- Logo 支持上传 PNG / JPEG / WebP / SVG，超过 280KB 前端自动等比缩到 256px；服务端约 300KB 硬上限与格式白名单。

### 页面偏好
- 设置 → 显示 新增「页面偏好」：打开面板默认停留页、报表默认时间范围、请求日志默认范围、文档页默认客户端（本浏览器 localStorage 持久化）。

### 数据维护
- 设置 → 数据 新增「事件日志维护」（条目占用 / 级别分布 / 一键清空）与「请求记录维护」（清理预览、清明细、仅清原始正文、压缩数据库 VACUUM）。

### 面板与文档
- 文档页接口地址自动识别访问域名（远程部署显示 `https://域名/v1`，桌面端保持 `127.0.0.1`），修复远程部署下地址恒为 `—` 的时序缺陷。
- 文档页新增「客户端快速接入」生成器：curl / Python / Node.js / Claude Code / Codex CLI 五种现成配置，一键复制，默认类型可记忆。
- 设置页新增「部署信息」分区：运行形态、面板地址、HTTPS 状态、引擎版本、安全与数据概览。
- 登录页主面板与文档页完整视觉改版（AIBuddy Panel 品牌、紫罗兰主题、深浅色与跟随系统三套配色同步替换）。
- index.html 补 viewport meta（移动端基础适配；完整移动端布局是后续目标）。
- 桌面端品牌更名：安装包名（AIBuddy Panel_2.10.0_x64-setup.exe）、窗口标题、发行者与版权信息全部改为 AIBuddy Panel / LzxkJ04（旧产品名仅保留在迁移探测清单里，用于识别上游安装）。
- Docker 镜像随 GitHub Release 一并发布（`aibuddy-panel-<版本>-docker.tar.gz`，`docker load` 即用），服务器无需本地构建；镜像同时发布到 GHCR，免下载直接 `docker pull ghcr.io/lzxkj04/aibuddy-panel:v2.10.0`（Actions 从公开仓库推送时包自动公开；若发现匿名拉取 401 再去包设置页手动改 Public）。

## 2.9.0

- 同步上游 agent2api v2.9.0 引擎（多提供商网关：账号池 / 模型映射 / 429 降级 / 出站脱敏 / 代理池 / 报表）。
