# AIBuddy Panel · 品牌 Logo

紫罗兰主题品牌资产，主色取自面板主题 `oklch(0.585 0.221 293)` ≈ **#8654F0**。

## 文件

| 文件 | 用途 |
|---|---|
| `logo-icon.svg` / `png/logo-icon-{512,192,128,64,32}.png` | 应用图标、favicon、侧栏品牌区 |
| `favicon.ico`（16/32/48） | 浏览器标签页 |
| `logo-horizontal.svg` / `png/logo-horizontal@2x.png` | 横版字标，浅色背景（登录页、文档页） |
| `logo-horizontal-dark.svg` / `png/logo-horizontal-dark@2x.png` | 横版字标，深色背景 |
| `logo-stacked.svg`（dark 同理） | 竖版字标，图标在上文字在下 |
| `preview.html` | 深浅背景 + 侧栏/标签页场景预览（浏览器打开） |

## 用法

面板「设置 → 品牌」分区上传 `logo-icon-128.png`（侧栏/favicon）或 `logo-horizontal@2x.png`（登录页横幅）。
Tauri 桌面端图标可基于 `png/logo-icon-512.png` 重新生成 `src-tauri/icons/`（`tauri icon` 命令）。

## 设计说明

- 图形：白气泡（Buddy 对话感）+ 三枚渐变圆点（多提供商消息流）+ 右上 AI 火花，置于紫罗兰渐变圆角方形上。
- 字标：Segoe UI Bold，「AIBuddy」紫渐变、「Panel」中性色，已转为矢量路径，任何环境显示一致。
- 色板：渐变 `#A678FF → #8654F0 → #6123C0`；深色背景字 `#B9A0FF → #9A73FF` + `#EFEEF6`；浅色背景 "Panel" `#3B3F4A`。

## 重新生成

```bash
cd generator && npm i && node gen.js && node render.js
```

依赖 `opentype.js`（文字转路径）与 `@resvg/resvg-js`（SVG 转 PNG，走 C:/Windows/Fonts 的 Segoe UI）。
