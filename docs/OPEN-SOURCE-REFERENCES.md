# 开源参考项目与文档全清单

> 本文是 AIBuddy Panel 二开的功能设计依据：每个借鉴的开源项目、对应文档/仓库地址、以及从它那里参考了什么。研究产出见 CHANGELOG 2.11.0 与后续路线（one-api/new-api 模式的渠道与计费体系等）。

## 1. 基座与协议

### aimod-cc/agent2api（上游基座）
- 仓库：https://github.com/aimod-cc/agent2api
- 参考内容：多提供商协议引擎全部（账号候选链、429 降级、出站指纹脱敏、出网代理、各家登录态转发与签名）、/health 与 /api/* 的接口形状、Node 版 server.mjs 的行为基准
- 许可：MIT + 附加使用声明（本项目沿用）

### OpenAI OpenAPI 规范（openai-openapi）
- 仓库：https://github.com/openai/openai-openapi
- 参考内容：List Models 响应形状（`{object:"list", data:[{id,object:"model",created,owned_by}]}`，导出 JSON 的格式依据）、chat/completions 与 responses 协议、`Authorization: Bearer` 鉴权头、usage 用量对象
- 用在：模型清单导出、Key 快速接入卡、网关健康面板（/v1/models 探活口径）

## 2. 渠道与计费体系（后续路线的主要参照）

### songquanpeng/one-api
- 仓库：https://github.com/songquanpeng/one-api
- 文档：https://github.com/songquanpeng/one-api#-功能
- 参考内容：渠道管理（连通性测试、批量启停、优先级与权重）、令牌管理（额度硬配额、有效期、IP 白名单、限定模型范围）、分组与模型倍率计费、兑换码生成核销、登录防爆破、维护模式

### Calcium-Ion/new-api
- 仓库：https://github.com/Calcium-Ion/new-api
- 参考内容：补全倍率与缓存计费口径、审计日志、会话管理（在线设备/强制下线）、渠道导出（渠道名+模型串）、多模态端点开关、用户数据管理

## 3. 状态与告警

### louislam/uptime-kuma
- 仓库：https://github.com/louislam/uptime-kuma
- 参考内容：状态页与心跳历史（ping 图）、90+ 通知方式（Webhook/Telegram/邮件/Bark 等）、账号异常告警推送、阈值告警与静默时段、TLS 证书临期监控、代理池健康探测思想

### grafana/grafana
- 仓库：https://github.com/grafana/grafana
- 参考内容：阈值告警 + 静默时段（免打扰窗口）、定时备份与保留策略、单值面板（请求速率显示）与日志级别 chips 的展示习惯

## 4. 面板外壳与交互

### lyt-Top/vue-next-admin（本地已克隆：`../vue-next-admin`）
- 仓库：https://github.com/lyt-Top/vue-next-admin ｜ 文档：https://lyt-top.github.io/vue-next-admin-doc-preview/
- 本地源码参照：`src/stores/themeConfig.ts`（全部偏好字段）、`src/theme/app.scss + dark.scss`（配色变量与深色形态）、`src/layout/navBars/topBar/setings.vue`（偏好抽屉）、`src/layout/component/tagsView`
- 参考内容：偏好抽屉字段全集（主题/深色形态/12 色/水印/锁屏/面包屑/页脚/渐变/高亮/动画）、TagsView 页签栏与拖拽排序、面包屑、动态标题、布局密度、表格列工具 tableTool、system/limits/fun 模块（RBAC 参照）

### Certd（certd/certd，参考站实例）
- 仓库：https://github.com/certd/certd
- 参考内容：偏好抽屉四页签形态（外观/布局/快捷键/通用，art-design-pro 风格）、主题三卡与内置色板网格、顶栏图标组、卡片化设置导航

### Element Plus
- 文档：https://element-plus.org/ ｜ 仓库：https://github.com/element-plus/element-plus
- 参考内容：可选中 Tag（日志级别 chips）、密码框显隐眼睛、表头工具栏「控件就在数据控件旁」的自动刷新交互、时间+相对描述的展示习惯

### shadcn/ui（本项目 ui-kit 的组件基线）
- 文档：https://ui.shadcn.com/
- 参考内容：Dialog/Select/Switch/SegmentedControl 等组件的交互基线（项目内经 `@ui` 封装使用）

### Lobe-Chat / NextChat
- Lobe-Chat：https://github.com/lobehub/lobe-chat ｜ NextChat：https://github.com/ChatGPTNextWeb/NextChat
- 参考内容：设置分区习惯（外观/通用分组）、主题跟随系统、**配置全量快照导入导出**（NextChat）

## 5. 落地状态对照

| 来源 | 已吸收（v2.11.0 及之前） | 待做路线 |
|---|---|---|
| one-api / new-api | Key 管理、模型映射、日志体系 | 渠道测试/探活/分组路由/倍率计费/兑换码/审计/会话管理/维护模式 |
| Uptime-Kuma / Grafana | 通知中心、网关健康面板、级别 chips | 多渠道通知、阈值告警、状态页、备份策略 |
| vue-next-admin | 偏好抽屉、TagsView+右键+拖拽、深色体系、折叠 | 布局密度、RBAC 参照、表格工具增强 |
| OpenAI 规范 | 三协议兼容、模型导出、Key 接入卡 | usage 用量面、多模态端点开关 |
| Element Plus / shadcn | 组件交互基线（已内化） | 持续 |
| Lobe-Chat / NextChat | 设置分区、主题跟随 | 配置快照导入导出 |

> 研究方法说明：one-api / new-api / Uptime-Kuma / vue-next-admin 经 GitHub 与本地源码核实；Lobe-Chat / NextChat / Grafana / OpenAI 规范部分依既有知识，未能联网复核的均已标注。
