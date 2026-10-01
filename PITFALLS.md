# 项目踩坑记录（AIBuddy Panel 二开）

> 给后续二开 / 部署的人（以及 AI 助手）看的实战坑。改动前先扫一遍，能省大量排查时间。

## 构建

- **本机（Windows）没有 Rust 工具链**：UI 层（HTML/CSS/JS/React 岛）随便改，`cd desktop-tauri/ui-islands && npm run build` 即可；但 Rust 改动只能在服务器上用 Docker 源码构建验证（`docker compose up -d --build`，首次 10-20 分钟）。
- **ui-islands 构建依赖 ui-kit 的 node_modules**：只装 ui-islands 会报一堆 `Cannot find module '@base-ui/react/xxx'`（tsc 阶段）。`cd desktop-tauri/ui-kit && npm install` 一次即可。
- 岛产物直接落 `desktop-tauri/ui/islands/`（vite outDir，emptyOutDir:false），`ui/` 就是完整可部署目录。

## React 岛时序（最容易踩的坑）

- 岛之间按**文件名字典序**执行（vite glob 打包）：`docs-page` 在 `port-panel` 之前。前者渲染的 DOM 要被后者立刻写入（接口地址五行），**必须 `flushSync` 同步提交**，否则写入扑空、页面永远显示占位 `—`。login-page / settings-page 同理。
- 模块加载期的主动初始化（如 port-panel 自行 `paintGatewayAddress + sync()`）是对的——**不要依赖 app.js 的调用链**，网页端（web_shim 桥）那条链不保证走。

## 环境/路径

- **Git Bash 会把 `/www/...` 这类独立参数改写成 Windows 路径**（MSYS 路径转换），SFTP 上传报 ENOENT 十有八九是这个。统一加 `export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` 再跑 `python deploy/ssh_run.py`。
- `deploy/ssh_run.py` 是服务器部署通道（paramiko，root@<服务器IP>:<SSH端口>）；putdir 上传整目录。

## 部署

- 服务器站点根：`/www/wwwroot/panel.example.com`（compose + data/ + ui/ + source/）。UI 更新 = 上传 `ui/` 后 `docker compose up -d`。
- **Rust 更新标准路线（v2.10.0 起）：本地 VM 构建，服务器零编译！** 服务器只有 2GB 内存，曾被 docker build 的 Rust LTO 链接阶段打挂整机 1 小时+（ping 通但 SSH/HTTP 全死）。现流程：本地 VMware Debian 13 VM（root/<密码>，<VM局域网IP>，16GB/32核）→ `docker build -t aibuddy-panel:2.10.0 .` → `docker save | gzip` → 传回 Windows → 传服务器 → `docker load` → 改 compose 的 image 版本号 → `docker compose up -d`。
- VM 的 DNS 曾被污染（docker.io 解析到 Facebook IP）：`/etc/resolv.conf` 换 223.5.5.5/119.29.29.29 + `/etc/docker/daemon.json` 配 registry-mirrors（docker.1ms.run 等）解决。
- **服务器 compose 已去掉 build 指令与 ADMIN env**：防止误触发服务器构建；管理员凭据已写入数据库（要改密码把 env 两行加回来改值重启）。
- `deploy/vm_ssh.py`（root SSH）与 `deploy/vm_su.py`（zxk + su 提权）是 VM 操作通道；Debian 13 默认 root 禁密码登录，已改 sshd_config PermitRootLogin yes。
- nginx vhost 手写反代（SSE 需要 `proxy_buffering off` + 长超时），宝塔面板里改站点可能覆盖它，改完记得比对。
- 容器只绑 `127.0.0.1:3065`，公网走 nginx + Let's Encrypt（certbot webroot，站点目录就是 webroot）。
- `source/` 有 nginx 404 规则，不对外暴露。

## GHCR 镜像发布

- 镜像发布渠道：**ghcr.io/lzxkj04/aibuddy-panel**（tags：`<版本>` / `v<版本>` / `latest`，amd64 + arm64 双架构）。发布由 `.github/workflows/docker.yml` 承担：推 `v*` tag 自动构建，`workflow_dispatch` 可对旧版本补发（输入版本号）。**不要手动往 GHCR 推镜像**，一切走 CI。
- **镜像 owner 写错的报错极隐晦**：GHCR 路径必须全小写，且 owner 必须与用户名完全对应——用户名 `LzxkJ04` 的小写是 `lzxk j 04`（第 5 个字母是 j），写成 `lzxkl04` 会报 `denied: not_found: owner not found`（编译全部正常、只在 push 阶段失败），别往权限/密钥方向排查。
- **Actions 推的包默认就公开**：GITHUB_TOKEN 从公开仓库推送、镜像带 `org.opencontainers.image.source` label 关联仓库时，包自动 public，匿名可 `docker pull`（2026-10-01 实测）。若哪天发现匿名拉取 401/404，去包设置页（仓库 Packages 页 → 包 → Package settings → Danger Zone）手动改 Public——GitHub 没有改可见性的 API，只能网页操作。
- VM 宿主机没装 curl：容器内验证用 `docker exec <容器> curl ...`（镜像内自带 curl），宿主机直接 curl 会 127。

## 面板行为

- 管理员由 compose 环境变量预置（`AGENT2API_ADMIN_USER/PASSWORD`），启动时覆盖写库；登录还要过 **ALTCHA 人机验证**（脚本登录需解题：sha256(salt+num)==challenge）。
- 无 Key 时 `/v1/*` fail-closed（headless 默认）；建第一把 Key 后自动恢复。
- 品牌设置（标题/Logo）存在 kv 表 `branding` 键；GET `/api/panel/branding` public、PUT `/api/branding` 需登录；static_files 往 index.html/login.html 注入引导脚本（短轮询等 React 元素就位）。

## 浏览器验证

- 内嵌浏览器对**远程 https 站点**导航/截图经常超时，别死磕：本地 `python -m http.server` 起静态预览验证视觉；线上数据用服务器 `curl 127.0.0.1:3065` 或 SSH 里跑脚本验证。
- ALTCHA 复选框是自定义元素（影子 DOM），Playwright `getByRole('checkbox')` 定位可能失败——`dom_cua.get_visible_dom()` 拿 node_id 再点。

## 偏好系统与页签栏（v2.11.0）

- **顶栏 `#topbar-status` 会被整体重写**：app.js 的 `renderTopbarStatus()` 每次刷新都整段替换该容器的内容，直接塞进去的自绘按钮必然被冲掉。自绘按钮必须放独立容器、插在它旁边（prefs.js 顶栏快捷组的做法），并挂 MutationObserver 监听容器变化、被重写后自动重挂（自愈）。
- **http 非安全源没有 crypto.subtle**：ALTCHA 人机验证靠 `crypto.subtle` 做 SHA-256 解题，非 secure context 下该 API 不存在，验证框会永远转圈、登录卡死。本地预览必须走 `http://localhost`（localhost 属 secure context）或 https；生产环境 https 不受影响。
- **岛按文件名字典序执行**：跨岛「先渲染 DOM、后立刻写入」的操作必须 `flushSync` 同步提交，否则前面的岛还没落 DOM、后面的写入扑空（docs-page → port-panel 即此坑，详见上面「React 岛时序」一节）。
