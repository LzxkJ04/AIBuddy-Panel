import * as React from 'react'
import { createRoot } from 'react-dom/client'
import {
  Badge,
  Button,
  buttonVariants,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
  Input,
  Label,
  MultiSelect,
  SegmentedControl,
  Switch,
  type MultiSelectOption,
} from '@ui'
import { toDataURL } from 'qrcode'
import { TableFooter, useClientPaging } from './table-shell'

/**
 * Agent2API · 网关 Key 页（列表 / 新建 / 启停 / 删除 / 可用范围 / 快速接入）—— React 岛。
 *
 * 替换 ui/keys-panel.js（那份用 innerHTML 拼 .models-table 的行、事件走容器委托）。
 * 对外接口与原实现**完全一致**：`window.wbKeysPanel = { load, render, visibleColumns }`
 * —— app.js:151 切到本页时调 load()，table-columns.js 的列宽层按 visibleColumns()
 * 算「当前可见列」（覆盖值落到哪个 <col>、末列不给把手），调用点一行都不用改。
 *
 * ── 数据口径（照旧，别改）──────────────────────────────────
 * 数据来自 `GET /api/keys`（`{keys, authRequired, providers, modelsByProvider}`，
 * keys 带明文 key 与掩码）。写接口都返回最新列表，就地替换后重绘；列表默认显示掩码，
 * 每行可单独「显示」明文并复制（复制走 clipboard.js 的 data-copy 委托）。
 * 「可用提供商 / 可用模型」两个白名单**空数组 = 不限制**（见后端 core::api_keys）。
 *
 * ── 额度与有效期：直连 /api/keys/{id}/quota ─────────────────
 * 配额与到期**不在** PATCH /api/keys 里（后端 keys_api 不透传这两个字段），
 * 唯一写入口是 PUT /api/keys/{id}/quota（字段级三态：键缺失 = 不动 / null =
 * 清除 / 正整数 = 设定）。两份桥（bridge.rs / web_shim.rs）都还没有这组方法，
 * 而面板与网关**同源 HTTP**，fetch 直连在桌面与网页两种形态都能用（与设置页
 * notifyApi 同一模式，见 quotaApi 的说明）。已用 Token 只有这组端点给：列表
 * （public_json）只带 quotaTokens / expiresAt 两个「有没有设」的字段，所以
 * 读数按需逐把补拉（见 quotaMap 的 effect）。PUT 的响应是**生效后**的全量
 * 读数，就地更新该行即可，不必再 GET。行内展示对照 one-api 令牌页：设了
 * 配额给进度条 + 已用/总量，不限额给灰字（省略与「没读到」长得一样），过期
 * 红字、临期黄字 —— 详见 KeyQuotaArea 的说明。
 *
 * ── 两个多选走组件库的 MultiSelect ───────────────────────────
 * 「可用提供商 / 可用模型」是**受控**的 React state（不再渲染原生 `<select multiple>`
 * 再让 select.js 增强）：候选、勾选、联动全在这一层算 —— 联动规则见 modelOptions，
 * 提交给后端的取值口径见 pickedFromOptions。
 *
 * ── 弹窗走组件库的 Dialog（与 request-clear-modal / conc-dialog 同一手法）──
 * 旧的 `#key-modal`（.modal-mask 一族）不再使用：Esc / 点遮罩关闭、焦点陷阱、滚动
 * 锁定都由 Dialog 内建。MultiSelect 的浮层是 Base UI 自己的浮层（portal 到 body，
 * z-35 高于弹窗的 z-30），与模态共用同一套 outside-press 判定，不需要额外放行。
 *
 * ── 列设置：为什么在 layout effect 里注册，而不是模块顶层 ──────
 * ① 本岛的模块体比 table-col-settings.tsx 先执行（import.meta.glob 按文件名字典序），
 *    模块顶层那一刻 `window.wbColSettings` 还不存在；
 * ② 「列设置」按钮要插进**本岛渲染出来的** .panel-head .head-actions，而 React 的首次
 *    渲染排在后面的任务里 —— 顶层 querySelector 拿到的是 index.html 的静态骨架
 *    （马上会被 replaceChildren 清掉），按钮会插进一个即将消失的节点。
 * 表头同步跟着注册一起做，并靠 syncStaticHead 内部的 `wbTableColumns.repaint('keys')`
 * 补上把手与列宽：table-columns.js 在本脚本之后加载，谁先跑都有可能 —— 它先跑时找
 * 不到表（当时 React 还没渲染），这次 repaint 补上；这次是空转时，它加载期自己会找。
 * <colgroup> / <thead> 由本文件渲染但 `data-col` 一个不少，React 从不动这几棵静态
 * 子树（虚拟 DOM 不变），所以命令式的重排 / 摘除是安全的。
 */

/* ─── 类型 ─────────────────────────────────── */

/** 一把 Key（`GET /api/keys` 的 keys[]，对应后端 `api_keys::ApiKeyEntry::public_json`） */
type KeyEntry = {
  id: string
  name?: string
  /** 明文：本机管理界面要能随时复制给客户端（掩码只用于列表折叠展示） */
  key?: string
  masked?: string
  enabled?: boolean
  createdAt?: number
  /** 白名单，**空数组 = 不限制** */
  allowedProviders?: string[]
  allowedModels?: string[]
  /** 配额总量（Token）；null / 缺省 = 不限额（public_json 现在带这两个字段） */
  quotaTokens?: number | null
  /** 到期时刻（毫秒时间戳）；null / 缺省 = 永久有效 */
  expiresAt?: number | null
}

/**
 * `GET/PUT /api/keys/{id}/quota` 的响应体（后端 key_quota_api::quota_json）。
 * `usedTokens` / `remainingTokens` 只有这组端点给：列表（public_json）只带
 * 「有没有设」的两个字段。`remainingTokens` 不限额时是 null；`expired` 是
 * 服务端的过期判定（与转发准入同一口径）。
 */
type KeyQuota = {
  id?: string
  name?: string
  enabled?: boolean
  /** 配额总量；null = 不限额 */
  quotaTokens?: number | null
  usedTokens?: number | null
  remainingTokens?: number | null
  /** 到期时刻（毫秒）；null = 永久 */
  expiresAt?: number | null
  expired?: boolean
}

/** 「可用提供商」的候选项：后端注册表摘要（项目禁止维护第二份 provider 清单） */
type ProviderOption = { id: string; label?: string }

/**
 * `GET /api/codex/status` 的响应（后端 api::codex_api，Codex CLI 一键写入的
 * 检测步）。三个布尔是 ~/.codex/ 里 config.toml / auth.json / *.bak 的存在性；
 * `serverUrl` 是后端从请求 Host 还原的面板 origin（base_url 以它为默认值），
 * `codexDir` 是 ~/.codex 的绝对路径（主目录定位不到时为 null）。
 */
type CodexStatus = {
  configExists?: boolean
  authExists?: boolean
  backupExists?: boolean
  serverUrl?: string
  codexDir?: string | null
}

/** `POST /api/codex/setup` 的响应：写入/跳过清单与备份名清单 */
type CodexSetupResult = {
  /** 实际写入的文件名（config.toml / auth.json） */
  written?: string[]
  /** 被跳过的文件与原因（如 apiKey 缺失时跳过 auth.json） */
  skipped?: { file?: string; reason?: string }[]
  /** 本次发生的备份名（config.toml.bak / auth.json.bak） */
  backups?: string[]
  codexDir?: string
  /** 实际写进 config.toml 的 base_url（归一后的 {baseUrl}/v1） */
  baseUrl?: string
}

/** 四个接口的响应；`created` 只在 POST 的响应里（新建后要立刻展开它） */
type KeysPayload = {
  keys?: KeyEntry[]
  authRequired?: boolean
  providers?: ProviderOption[]
  /** 每家 → 对外名清单，模型候选的**唯一**数据源（按当前勾选的提供商取并集） */
  modelsByProvider?: Record<string, string[]>
  created?: KeyEntry
}

/** 本岛用到的后端桥（见 bridge.rs 的「网关 Key」那一段） */
type KeysBridge = {
  getKeys(): Promise<KeysPayload | null | undefined>
  createKey(payload: {
    name: string
    /** 留空 = 后端自动生成 */
    key?: string
    allowedProviders: string[]
    allowedModels: string[]
  }): Promise<KeysPayload | null | undefined>
  updateKey(
    id: string,
    patch: { enabled?: boolean; allowedProviders?: string[]; allowedModels?: string[] },
  ): Promise<KeysPayload | null | undefined>
  deleteKey(id: string): Promise<KeysPayload | null | undefined>
}

/**
 * window 上由其它脚本 / 其它岛挂载的共享桥。
 *
 * 刻意用「局部窄类型 + 转型」而不是 declare global 往 Window 上加属性：
 * workbuddyDesktop / wbApp / wbColSettings / wbProviders 是多个岛共用的桥，若每个岛
 * 各 declare 一份，接口合并会因同名属性类型不一致直接报 TS2717。本文件只 declare
 * 自己独占的 wbKeysPanel（见文件末尾）。
 */
type SharedWindow = {
  workbuddyDesktop?: KeysBridge
  wbApp?: {
    toast?: (message: string, kind?: 'err' | 'ok') => void
    /** 时间戳 → 本地时间串（app.js 的 formatTime；createdAt 列用它） */
    formatTime?: (value: unknown) => string
    /** 顶栏状态区重画：本页徽标是顶栏那枚的镜像（按 id 读文案与 data-tone） */
    renderTopbarStatus?: () => void
    /** 当前页标识：首屏自持加载只在用户正看着本页时打后端 */
    readonly currentPage?: string
  }
  wbConfirm?: {
    ask?: (options: {
      title?: string
      /** 正文，允许 <strong> 等少量标记；内容由调用方负责转义 */
      html?: string
      okText?: string
      /** danger = 不可恢复的危险操作（确认键走红） */
      okClass?: string
    }) => Promise<boolean>
  }
  wbColSettings?: {
    register(spec: {
      id: string
      label?: string
      columns: readonly ColumnDecl[]
      mount?: () => Element | null
      onChange?: () => void
    }): ColSettingsHandle
    syncStaticHead(id: string, table: Element | null | undefined): void
  }
  /** 提供商显示名（注册表 + 自定义家的查找链，注册表里没有的 id 回落原样） */
  wbProviders?: { labelOf?: (id: string) => string | undefined }
}

function shared(): SharedWindow {
  return window as unknown as SharedWindow
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** toast 的统一出口（运行期读 wbApp，不在模块顶层解构） */
function toast(message: string, kind?: 'err' | 'ok'): void {
  shared().wbApp?.toast?.(message, kind)
}

/** 确认框正文是 HTML 串，插值一律先转义（不借 wbApp.esc：那是 app.js 的私有函数） */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch] ?? ch))
}

/**
 * 额度接口的直连出口（`GET/PUT /api/keys/{id}/quota`）。
 *
 * 这组端点两份桥（bridge.rs / web_shim.rs）都还没有专属方法，而桌面端与网页端
 * 的面板**都是同源 HTTP**（桌面端的网关跑在应用进程内、面板由它伺服），fetch
 * 直连在两种形态下都能用 —— 与设置页通知接口（settings-model 的 notifyApi）
 * 是同一模式。响应按网关的 `{success, data}` 信封拆包：非 2xx 或 `success ===
 * false` 抛 Error（文案取 error / message / msg），有 `data` 键取 `data`。
 * 401 的静默续期不在本函数里 —— 那是桥的职责，直连绕过了它；会话过期时这里
 * 只会如实报错，用户重新登录后一切恢复。
 */
async function quotaApi(method: 'GET' | 'PUT', id: string, body?: unknown): Promise<KeyQuota> {
  const init: RequestInit = { method, headers: { Accept: 'application/json' } }
  if (method === 'PUT') {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body ?? {})
  }
  const response = await fetch(`/api/keys/${encodeURIComponent(id)}/quota`, init)
  const text = await response.text()
  let payload: unknown = null
  try { payload = text ? JSON.parse(text) : null } catch { /* 非 JSON：按原文报错 */ }
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  const success = typeof record?.success === 'boolean' ? record.success : undefined
  if (!response.ok || success === false) {
    const detail = record
      ? (record.error ?? record.message ?? record.msg ?? `HTTP ${response.status}`)
      : (text.trim() || `HTTP ${response.status}`)
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  return (record && Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : payload) as KeyQuota
}

/**
 * Codex 接口的直连出口（`GET /api/codex/status`、`POST /api/codex/setup`）。
 *
 * 与上面的 quotaApi 同一模式：这组端点两份桥（bridge.rs / web_shim.rs）都还没有，
 * 而面板与网关**同源 HTTP**，fetch 直连在桌面与网页两种形态下都能用。响应按
 * 网关的 `{success, data}` 信封拆包（与 quotaApi 逐字同口径）；401 的静默续期
 * 同样不在本函数里 —— 会话过期时如实报错，用户重新登录后一切恢复。
 */
async function codexApi<T>(
  method: 'GET' | 'POST',
  path: '/api/codex/status' | '/api/codex/setup',
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: 'application/json' } }
  if (method === 'POST') {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body ?? {})
  }
  const response = await fetch(path, init)
  const text = await response.text()
  let payload: unknown = null
  try { payload = text ? JSON.parse(text) : null } catch { /* 非 JSON：按原文报错 */ }
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  const success = typeof record?.success === 'boolean' ? record.success : undefined
  if (!response.ok || success === false) {
    const detail = record
      ? (record.error ?? record.message ?? record.msg ?? `HTTP ${response.status}`)
      : (text.trim() || `HTTP ${response.status}`)
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
  return (record && Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : payload) as T
}

/* ─── 常量与列声明 ───────────────────────────── */

type Align = 'left' | 'center' | 'right'

/** 列声明：key 与 index.html 里既有的 `data-col`、<col> 的 data-col 三处同名 */
type ColumnDecl = { key: string; label: string; align?: Align }

const COLUMNS: readonly ColumnDecl[] = [
  { key: 'name', label: '名称' },
  { key: 'key', label: 'Key' },
  { key: 'time', label: '创建时间' },
  { key: 'state', label: '启用' },
  { key: 'act', label: '操作', align: 'right' },
]

/** 每个单元格自己的类名（`state` / `r` 是既有 CSS 的钩子，见 page-gateway.css） */
const CELL_CLASS: Record<string, string> = {
  name: 'cell-name',
  key: 'cell-key',
  time: 'cell-time',
  state: 'cell-state state',
  act: 'cell-act r',
}

/** 页面区块（React root 直接建在它上面，见文件头） */
const SECTION = '.page[data-page="keys"]'

/* ─── 列设置：能力层（register / apply / syncStaticHead）─── */

type ColSettingsHandle = {
  apply<C extends { key: string }>(columns: C[]): (C & { align: Align })[]
  config(): unknown
}

let colSettings: ColSettingsHandle | null = null

/** 列设置改动后的重画入口：组件挂载后登记（onChange 从 React 之外回调进来） */
let onColumnsChanged: (() => void) | null = null

/**
 * 该表当前可见的列（顺序即配置顺序；列设置未就绪时退回全部列）。
 * 导出给 table-columns.js：列宽那一层要按当前可见列算（覆盖值落到哪个 <col>、
 * 末列不给把手），两边读同一份配置才不会各算一个样。
 */
function visibleColumns(): (ColumnDecl & { align: Align })[] {
  if (colSettings) return colSettings.apply([...COLUMNS])
  // 列设置没就绪（脚本加载失败等）：退回声明顺序，对齐取列上声明的默认值
  return COLUMNS.map(column => ({ ...column, align: column.align ?? 'left' }))
}

/** 静态表头就地重排：顺序 / 显隐 / 对齐（末尾顺带让列宽层重对一遍把手） */
function syncHead(): void {
  shared().wbColSettings?.syncStaticHead?.('keys', document.querySelector('table.keys-table'))
}

/** 登记列设置（只做一次）并同步表头；必须在 React 提交之后调用（见文件头） */
function setupColumns(): void {
  if (colSettings) return
  const handle = shared().wbColSettings?.register({
    id: 'keys',
    label: '网关 Key 表',
    columns: COLUMNS,
    mount: () => document.querySelector('.page[data-page="keys"] .panel-head .head-actions'),
    onChange: () => {
      syncHead()
      onColumnsChanged?.()
    },
  })
  if (!handle) return
  colSettings = handle
  syncHead()
}

/* ─── 纯函数：文案与候选项 ───────────────────── */

function keysOf(payload: KeysPayload | null): KeyEntry[] {
  return Array.isArray(payload?.keys) ? payload.keys : []
}

/** 后端下发的提供商摘要（注册表顺序：workbuddy → raccoon → …） */
function providersOf(payload: KeysPayload | null): ProviderOption[] {
  return Array.isArray(payload?.providers) ? payload.providers : []
}

function modelsByProviderOf(payload: KeysPayload | null): Record<string, string[]> {
  const map = payload?.modelsByProvider
  return map && typeof map === 'object' ? map : {}
}

/** 提供商显示名：注册表里没有的 id 回落原样（旧数据里可能有已下线的家） */
function providerLabel(id: string): string {
  return shared().wbProviders?.labelOf?.(id) || id
}

/**
 * 按**当前勾选的提供商**取对外名并集，铺成多选选项。
 * `selected` 里的名字即使不在并集里也照样保留（铺成已勾选状态）—— 用户取消勾选某家
 * 之后，那家独有的模型仍要看得见、能自己取消，否则「保存范围」会变成一次静默的
 * 数据修改。一家都没勾时返回**空数组**（没有约束范围就没有候选）。
 */
function modelOptions(
  table: Record<string, string[]>,
  selectedProviders: string[],
  selected: string[],
): MultiSelectOption[] {
  const names = new Map<string, string>() // 小写 → 原始名（先到先得，保住后端给的大小写）
  const put = (value: unknown) => {
    const text = String(value ?? '').trim()
    if (!text) return
    const key = text.toLowerCase()
    if (!names.has(key)) names.set(key, text)
  }
  selectedProviders.forEach(id => {
    const list = table[id] ?? table[String(id).toLowerCase()]
    if (Array.isArray(list)) list.forEach(put)
  })
  // 已勾选的模型无论是否还在并集里都要铺出来（见函数说明）
  selected.forEach(put)
  const out = [...names.values()].map(value => ({ value, label: value }))
  out.sort((a, b) => (a.value.toLowerCase() < b.value.toLowerCase() ? -1 : 1))
  return out
}

/**
 * 一行 Key 名下的**限制摘要**。为什么要显示而不是留空：限制是**看不见的** —— 列表上
 * 不写，用户就只记得「我配过点什么」，客户端 404 时会去查模型、查账号，最后才想到是
 * Key 的限制。无限制时显示「不限制」而不是省略：省略与「没读到」长得一样。
 */
function restrictionText(k: KeyEntry): string {
  const providers = Array.isArray(k.allowedProviders) ? k.allowedProviders : []
  const models = Array.isArray(k.allowedModels) ? k.allowedModels : []
  if (!providers.length && !models.length) return '不限制'
  const parts: string[] = []
  if (providers.length) parts.push(providers.map(providerLabel).join('、'))
  // 模型那半边只报个数：一屏 Row 里塞不下十几个模型名，悬停由 title 给全量
  if (models.length) parts.push(`${models.length} 个模型`)
  return `限制：${parts.join(' / ')}`
}

/** 限制摘要的完整说明（悬停 title 用；列不宽，详情只能挂这里） */
function restrictionTitle(k: KeyEntry): string {
  const providers = Array.isArray(k.allowedProviders) ? k.allowedProviders : []
  const models = Array.isArray(k.allowedModels) ? k.allowedModels : []
  if (!providers.length && !models.length) {
    return '这把 Key 不限制提供商与模型（可用全部上游与全部对外模型）'
  }
  const lines: string[] = []
  if (providers.length) lines.push(`可用提供商：${providers.map(providerLabel).join('、')}`)
  if (models.length) lines.push(`可用模型：${models.join('、')}`)
  return lines.join('\n')
}

/**
 * 弹窗里「当前选的摘要」。为什么要有它：限制是**看不见的** —— 弹窗一关，列表上只剩
 * 「限制：…」一行；而多选的触发器只显示连接后的一行文案，清单长了会被省略号收掉。
 * 用户点完「保存范围」就看不到弹窗了，勾了哪几家 / 哪些模型得在这儿给他核对一遍。
 */
function restrictionSummary(providers: readonly string[], models: readonly string[]): string {
  if (!providers.length && !models.length) {
    return '当前不限制：这把 Key 可以用全部提供商与全部对外模型'
  }
  const parts: string[] = []
  if (providers.length) parts.push(`提供商：${providers.map(providerLabel).join('、')}`)
  if (models.length) parts.push(`模型：${models.join('、')}`)
  // 只限制了模型、没限制提供商（旧数据里可能存在这种组合）：模型候选此刻只剩已勾的
  // 那几个（没有提供商就没有并集可铺），要说清怎么把候选拿回来 —— 否则用户会以为
  // 「模型清单坏了，加不了新的」
  if (!providers.length) {
    parts.push('（模型候选需先选提供商；不选则沿用当前这几项，保存后仍按模型白名单生效）')
  }
  return parts.join('　')
}

/* ─── 多选的选项与取值 ───────────────────────── */

/** 白名单字段是后端给的，可能缺失 / 形状不对（非数组一律当空，与旧实现同口径） */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)) : []
}

/**
 * 把 state 里的勾选值按**候选表**归一：只留候选里存在的项、顺序照候选表、写法以候选
 * 为准（模型名的大小写可能与清单不一致，旧实现就是按小写比对后把候选的写法写回 DOM）。
 * 这就是旧实现 `[...select.selectedOptions].map(option => option.value)` 的口径 ——
 * 那时「勾选」只存在于渲染出来的 option 上，候选里没有的 id 落不到 DOM 里，提交时自然
 * 被丢掉。**提交给后端的两个数组必须逐字保持这个口径**。
 */
function pickedFromOptions(values: readonly string[], options: readonly MultiSelectOption[]): string[] {
  const canonical = new Map(options.map(option => [option.value.toLowerCase(), option.value]))
  const chosen = new Set<string>()
  values.forEach(value => {
    const hit = canonical.get(String(value).toLowerCase())
    if (hit) chosen.add(hit)
  })
  return options.filter(option => chosen.has(option.value)).map(option => option.value)
}

/* ─── 弹窗（新建 / 改可用范围共用）──────────────── */

type KeyModalProps = {
  /** 编辑形态的 Key；null = 新建 */
  target: KeyEntry | null
  providers: ProviderOption[]
  modelsByProvider: Record<string, string[]>
  onClose: () => void
  /** 写接口返回的最新列表（与旧实现的 accept 同义）；revealId = 新建后要展开明文的那把 */
  onSaved: (next: KeysPayload | null | undefined, revealId?: string) => void
}

function KeyModal({ target, providers, modelsByProvider, onClose, onSaved }: KeyModalProps) {
  const editingId = target?.id ?? null
  const editing = Boolean(editingId)

  const [name, setName] = React.useState(target?.name ?? '')
  const [keyValue, setKeyValue] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  /** 在途守卫：命令式的关闭判定（Esc / 点遮罩）必须能**同步**读到它 */
  const savingRef = React.useRef(false)

  /** 两个白名单的勾选（受控；**空数组 = 不限制**）。初值照抄后端给的数组，不在这里删改 */
  const [pickedProviders, setPickedProviders] = React.useState<string[]>(
    () => stringList(target?.allowedProviders),
  )
  const [pickedModels, setPickedModels] = React.useState<string[]>(
    () => stringList(target?.allowedModels),
  )

  /** 提供商候选 = 后端下发的注册表摘要（项目禁止维护第二份 provider 清单） */
  const providerOptions = React.useMemo<MultiSelectOption[]>(
    () => providers.map(item => ({ value: String(item.id), label: String(item.label ?? item.id) })),
    [providers],
  )

  /**
   * 勾选值按候选表归一后的结果 —— 它是**唯一对外**的东西：MultiSelect 的受控值、摘要、
   * 提交给后端的数组都用它，与旧实现从 `<select>` 的 selectedOptions 读值同一口径
   * （见 pickedFromOptions 的说明）。
   */
  const allowedProviders = React.useMemo(
    () => pickedFromOptions(pickedProviders, providerOptions),
    [pickedProviders, providerOptions],
  )

  /**
   * 模型候选跟着「已勾选的提供商」重建：勾一家立刻多出这家的对外名，取消一家则收回去。
   * 但**已勾选的模型一律留在候选里**（见 modelOptions）—— 用户没动过模型那栏，
   * 保存就不该悄悄少几项。
   */
  const modelCandidates = React.useMemo(
    () => modelOptions(modelsByProvider, allowedProviders, pickedModels),
    [modelsByProvider, allowedProviders, pickedModels],
  )

  const allowedModels = React.useMemo(
    () => pickedFromOptions(pickedModels, modelCandidates),
    [pickedModels, modelCandidates],
  )

  /**
   * 空候选的说明文案分两种：没勾提供商时是「先选提供商」，勾了却是空才是「这几家
   * 现在没有可用模型」（后端没给该家的清单 = 没登录态）。有候选时不写这句 ——
   * 那时浮层里空只可能是搜索没匹配上。
   */
  const modelEmptyHint = modelCandidates.length
    ? '没有匹配的选项'
    : allowedProviders.length
      ? '这几家当前没有可用模型（账号未登录或清单为空）'
      : '请先在上面选择可用提供商'

  /** 收尾：解除在途守卫（写两处，避免两边漂移） */
  function stopSaving(): void {
    savingRef.current = false
    setSaving(false)
  }

  async function save(): Promise<void> {
    if (savingRef.current) return
    // 两个白名单直接用归一后的勾选（见 pickedFromOptions），字段名与取值口径都与旧实现一致
    savingRef.current = true
    setSaving(true)
    setStatus('保存中…')
    try {
      const api = shared().workbuddyDesktop
      if (!api) throw new Error('后端桥不可用')
      if (editingId) {
        // 只提交两个白名单：别名与启停都不动（部分更新语义，见后端 api_keys::update）
        const next = await api.updateKey(editingId, { allowedProviders, allowedModels })
        // 先解除守卫再关窗（旧实现同序：saving = false 在 closeModal 之前）
        stopSaving()
        onSaved(next)
        onClose()
        toast('✅ 可用范围已保存')
        return
      }
      const trimmedKey = keyValue.trim()
      if (trimmedKey && trimmedKey.length < 8) {
        setStatus('Key 至少需要 8 个字符')
        return
      }
      const next = await api.createKey({
        name: name.trim(), key: trimmedKey || undefined, allowedProviders, allowedModels,
      })
      stopSaving()
      onSaved(next, next?.created?.id)
      onClose()
      toast('✅ Key 已创建，记得复制给客户端')
    } catch (error) {
      setStatus(`保存失败：${errorMessage(error)}`)
    } finally {
      stopSaving()
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next, eventDetails) => {
        // 关闭请求（Esc / 点遮罩 / 右上角 ✕）全部汇到这里。保存中拒绝关闭必须走
        // eventDetails.cancel()：光「不更新 open prop」拦不住 Base UI 的 store。
        if (next) return
        if (savingRef.current) {
          eventDetails.cancel()
          return
        }
        onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? `可用范围 · ${target?.name || '未命名'}` : '新建 API Key'}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogSection>
            <div className='flex flex-wrap items-center gap-2.5'>
              <Label htmlFor='key-name' className='text-[12.5px] whitespace-nowrap text-subtle'>名称</Label>
              <Input id='key-name' type='text' maxLength={60} placeholder='例如 Cursor / 公司电脑'
                autoComplete='off' value={name} disabled={editing}
                onChange={event => setName(event.currentTarget.value)} />
            </div>
            {/* 编辑形态**不渲染** Key 输入行：那一行在改范围时没有意义（Key 值不可改）。
                这里既没有常驻需求也没有状态要保，条件渲染最省事 —— 属性式显隐留给
                节点必须常驻的场合（组件库 globals.css 的 [hidden][hidden] 已给它兜底）。 */}
            {!editing && (
              <div className='flex flex-wrap items-center gap-2.5'>
                <Label htmlFor='key-value' className='text-[12.5px] whitespace-nowrap text-subtle'>Key</Label>
                <Input id='key-value' type='text' placeholder='留空自动生成；手填至少 8 个字符'
                  autoComplete='off' spellCheck={false} value={keyValue}
                  onChange={event => setKeyValue(event.currentTarget.value)}
                  // 回车 = 提交（旧实现只绑在这一个输入框上）
                  onKeyDown={event => { if (event.key === 'Enter') void save() }} />
              </div>
            )}
            {/* 两个多选走组件库的 MultiSelect（受控）。宽度规则（min 180 / max 260）原先是
                page-gateway.css 按 `#key-allowed-providers` / `#key-allowed-models` 给的，
                而 MultiSelect 的触发器不吃 id（组件库不转发）—— 那条规则成了死规则，
                等价的宽度锚只能自己带：flex-auto 就是旧 CSS 里的 `flex: 1 1 auto`。
                触发器上没有可见 label 与之关联（同样没有 id 可给 htmlFor），所以 aria-label
                必须给，否则读屏只念到一串连接起来的选项名。 */}
            <div className='flex flex-wrap items-center gap-2.5'>
              <Label className='text-[12.5px] whitespace-nowrap text-subtle'>可用提供商</Label>
              <MultiSelect
                value={allowedProviders}
                onValueChange={setPickedProviders}
                options={providerOptions}
                placeholder='留空 = 不限制'
                searchPlaceholder='搜索提供商…'
                aria-label='可用提供商'
                className='flex-auto min-w-[180px] max-w-[260px]'
              />
            </div>
            <div className='flex flex-wrap items-center gap-2.5'>
              <Label className='text-[12.5px] whitespace-nowrap text-subtle'>可用模型</Label>
              <MultiSelect
                value={allowedModels}
                onValueChange={setPickedModels}
                options={modelCandidates}
                placeholder='留空 = 不限制'
                emptyHint={modelEmptyHint}
                searchPlaceholder='搜索模型…'
                aria-label='可用模型'
                className='flex-auto min-w-[180px] max-w-[260px]'
              />
            </div>
            <p>
              留空表示不限制；同时设置时请求需同时满足两个条件（模型在白名单内且路由到允许的提供商）。
              「可用模型」的候选跟着上面勾选的提供商走：没勾提供商时它是空的（还没有约束范围），
              勾了几家就列出这几家能收的全部对外名。
            </p>
            {/* 当前选的摘要：多选的触发器上只显示「连接后的一行文案」，清单长了会被省略号
                收掉 —— 勾了哪几家 / 哪些模型要在这儿摊开。id 沿用旧实现的：page-gateway.css
                按它给这行加了上边距（它是「当前选择」而不是「使用说明」）。 */}
            <p id='key-restrict-summary'>{restrictionSummary(allowedProviders, allowedModels)}</p>
          </DialogSection>
          <div className='min-h-[18px] text-[11.5px] text-muted-foreground'>{status}</div>
        </DialogBody>
        <DialogFooter>
          <div className='mr-auto' />
          <Button variant='outline' onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant='default' disabled={saving} onClick={() => void save()}>
            {editing ? '保存范围' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─── 快速接入弹窗（带真实 Key 的客户端接入配置 + 接入二维码）── */

/** 三段配置的分段标识（分段控件受控值） */
type QuickTabKind = 'openai' | 'curl' | 'anthropic'

const QUICK_TABS: readonly { value: QuickTabKind; label: string }[] = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'curl', label: 'cURL' },
  { value: 'anthropic', label: 'Anthropic' },
]

/** Key 掩码的兜底形态（后端 public_json 正常带 masked；缺了就现拼 sk-abc…xyz 样子） */
function maskedKeyOf(k: KeyEntry): string {
  if (k.masked) return k.masked
  const value = k.key ?? ''
  if (value.length > 12) return `${value.slice(0, 6)}…${value.slice(-3)}`
  return '••••••••'
}

/**
 * 三段接入配置的片段。**口径与「使用文档」页 QuickStartPanel 的 clientSnippet 一致**
 * （OpenAI SDK 的 base_url 要带 /v1，SDK 只在其后拼 /chat/completions；Anthropic 的
 * ANTHROPIC_BASE_URL 不带 /v1，Claude Code 自己拼 /v1/messages），差别只有一处：
 * 占位符「sk-你的网关Key」换成了**这把 Key 的明文** —— 快速接入的意义就是免替换。
 */
function quickSnippet(kind: QuickTabKind, base: string, key: string): string {
  switch (kind) {
    case 'openai':
      return [
        'from openai import OpenAI',
        '',
        `client = OpenAI(base_url="${base}/v1", api_key="${key}")`,
        'resp = client.chat.completions.create(',
        '    model="模型名（GET /v1/models 里任选）",',
        '    messages=[{"role": "user", "content": "你好"}],',
        ')',
        'print(resp.choices[0].message.content)',
      ].join('\n')
    case 'curl':
      return [
        `curl ${base}/v1/chat/completions \\`,
        '  -H "Content-Type: application/json" \\',
        `  -H "Authorization: Bearer ${key}" \\`,
        "  -d '{",
        '    "model": "模型名（GET /v1/models 里任选）",',
        '    "messages": [{"role": "user", "content": "你好"}],',
        '    "stream": true',
        "  }'",
      ].join('\n')
    case 'anthropic':
      return [
        `export ANTHROPIC_BASE_URL=${base}`,
        `export ANTHROPIC_AUTH_TOKEN=${key}`,
      ].join('\n')
  }
}

/**
 * 二维码的载荷：三行接入信息文本（标识 / Base / Key 明文）。手机相机与各客户端的
 * 「扫一扫导入」认的是**纯文本**，不搞私有 JSON —— 扫出来就能照着填。
 */
function quickQrPayload(base: string, key: string): string {
  return `AIBuddy Panel\nBase: ${base}/v1\nKey: ${key}`
}

/** 二维码展示尺寸（px）；卡片另有白底内边距与描边，整体略大 */
const QR_SIZE = 180

/** 下载文件名：Key 名洗掉路径非法字符（中文原样保留，浏览器自己会转码） */
function qrFileNameOf(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'key'
  return `aibuddy-key-${safe}.png`
}

/**
 * 快速接入弹窗里的二维码卡。生成走 `qrcode` 的 toDataURL（canvas → PNG DataURL，
 * 纯前端），不引任何服务端依赖。为什么源图生成 512px 而展示只给 180px：下载出去的
 * PNG 也要能扫 —— 180px 打印 / 截图后再放大会糊，512px 缩着展示依然锐利。
 *
 * 二维码**本体永远白底黑模块**（color 写死）：扫码器对反色 / 深底容错很差，深色
 * 主题下也不许跟着换色；主题自适应的只有外层描边（--border / --r-md，走 tokens）。
 */
function QuickQrCard({ payload, fileName }: { payload: string; fileName: string }) {
  const [url, setUrl] = React.useState('')
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    // toDataURL 是异步的 canvas 渲染：卸载 / 载荷变化后不再写回旧结果
    let alive = true
    setFailed(false)
    toDataURL(payload, {
      margin: 2,
      width: 512,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#FFFFFF' },
    })
      .then(next => { if (alive) setUrl(next) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [payload])

  return (
    <div className='flex flex-wrap items-start gap-3'>
      {/* 白底内边距就是 quiet zone 的兜底：哪怕截图裁掉一圈，模块周围仍有留白可扫 */}
      <div className='rounded-[var(--r-md)] border border-[var(--border)] bg-white p-2'>
        {url ? (
          <img src={url} width={QR_SIZE} height={QR_SIZE} alt='接入信息二维码（Base URL 与 Key）'
            className='block size-[180px]' />
        ) : (
          <div className='grid size-[180px] place-items-center text-[11.5px] text-neutral-500'>
            {failed ? '二维码生成失败' : '二维码生成中…'}
          </div>
        )}
      </div>
      <div className='flex min-w-[160px] flex-1 flex-col items-start gap-2'>
        <p>手机扫码即得 Base URL 与 Key，适合在手机端快速配置客户端。</p>
        {/* 下载走 a[download]：DataURL 同源可直接落盘；DataURL 没就绪前先禁点
            （buttonVariants 只出样式串，禁用态在这里手工补） */}
        <a
          className={`${buttonVariants({ variant: 'outline', size: 'sm' })}${url ? '' : ' pointer-events-none opacity-45'}`}
          href={url || undefined}
          download={fileName}
          aria-disabled={!url}
        >
          下载 PNG
        </a>
      </div>
    </div>
  )
}

function QuickAccessModal({ target, onClose }: { target: KeyEntry; onClose: () => void }) {
  const [tab, setTab] = React.useState<QuickTabKind>('openai')
  /** 明文显示开关：默认掩码，眼睛按钮切全量（与列表行的 显示/隐藏 同一意图） */
  const [shown, setShown] = React.useState(false)

  const keyValue = target.key ?? ''
  const base = window.location.origin
  const snippet = quickSnippet(tab, base, keyValue)

  return (
    <Dialog
      open
      // 只读展示弹窗，没有在途写操作要守卫：Esc / 点遮罩 / ✕ 直接关（不像 KeyModal
      // 那样要看 savingRef 决定 cancel）
      onOpenChange={next => { if (!next) onClose() }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>快速接入 · {target.name || '未命名'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogSection>
            {/* Key 行复用列表 keycell 的结构钩子（page-gateway.css 全局可用）：
                .kv 自带省略号折叠，明文再长也不撑破弹窗 */}
            <div className='keycell'>
              <Label className='text-[12.5px] whitespace-nowrap text-subtle'>Key</Label>
              <code className='kv'>{shown ? keyValue : maskedKeyOf(target)}</code>
              <Button size='icon-xs' variant='ghost'
                aria-label={shown ? '隐藏 Key 明文' : '显示 Key 明文'}
                title={shown ? '隐藏 Key 明文' : '显示 Key 明文'}
                onClick={() => setShown(value => !value)}>
                {shown ? '🙈' : '👁'}
              </Button>
              {/* data-copy 是 clipboard.js 的委托钩子（弹窗虽 portal 到 body，委托在
                  document 上照样命中）；复制永远带明文，与掩码显示互不影响 */}
              <Button size='sm' variant='ghost' data-copy={keyValue} title='复制 Key'>复制</Button>
            </div>
            <p className='text-[11.5px] text-muted-foreground'>⚠ Key 即凭证，请勿外传；泄露后请在本页删除并重建。</p>
          </DialogSection>
          <DialogSection>
            <div className='flex flex-wrap items-center gap-2.5'>
              <SegmentedControl value={tab} onValueChange={setTab}
                options={QUICK_TABS} aria-label='选择客户端类型' />
            </div>
            {keyValue ? (
              <div className='relative'>
                <pre
                  className='m-0 overflow-x-auto rounded-[var(--r-sm)] bg-[var(--surface-inset)] p-[14px] font-mono text-[12px] leading-[1.7] whitespace-pre'
                >{snippet}</pre>
                {/* 复制的是当前分段的完整片段（含真实 Key）：文本挂在 data-copy 属性上，
                    显示与复制解耦 —— 以后就算把片段里的 Key 也做掩码，复制出的仍是可用的 */}
                <Button
                  variant='ghost'
                  size='icon-xs'
                  className='copy-btn absolute right-[10px] top-[10px] size-[24px] rounded-[var(--r-xs)] bg-[var(--surface)]'
                  data-copy={snippet}
                  title='复制配置'
                >
                  ⧉
                </Button>
              </div>
            ) : (
              <p className='text-[12px] text-muted-foreground'>这把 Key 的明文不在当前数据里，无法生成配置；请刷新页面后重试。</p>
            )}
            <p className='text-[11.5px] text-muted-foreground'>
              Base URL 取当前页面地址（{base}）；跨机访问时换成网关所在主机的地址。
            </p>
          </DialogSection>
          {/* 扫码接入只在明文在手时出现：没有真实 Key 的二维码扫了也没用（与上面
              片段的回退文案同一口径 —— 明文缺失时整个区块整段让位，不摆空壳 */}
          {keyValue ? (
            <DialogSection>
              <h3>扫码接入</h3>
              <QuickQrCard payload={quickQrPayload(base, keyValue)}
                fileName={qrFileNameOf(target.name || '')} />
              <p>⚠ 二维码内含 Key 明文，转发截图前先想想它会落到谁手里。</p>
            </DialogSection>
          ) : null}
          {/* Codex CLI 一键写入：keyValue 只用来预填 Key 输入框，缺失也能用
              （用户可以自己粘贴另一把 Key），所以不再按 keyValue 条件渲染 */}
          <CodexWriteSection keyValue={keyValue} />
        </DialogBody>
        <DialogFooter>
          <div className='mr-auto' />
          <Button variant='outline' onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─── Codex CLI 一键写入（照 Buddy2API 的 /admin/codex/setup 形态）── */

/** 写入动作的三段状态：先检测 ~/.codex 现状 → 确认并填 Key → 展示结果 */
type CodexPhase = 'idle' | 'ready' | 'done'

/**
 * 快速接入弹窗里的「Codex CLI 一键写入」分区。
 *
 * 流程照 Buddy2API 的 /admin/codex/setup：点按钮先 GET status，把 ~/.codex 里
 * 已有的文件与「将做 .bak 备份」如实列出来，用户核对 / 粘贴 API Key（掩码输入，
 * 默认预填本把 Key 的明文，可清空 —— 留空则只写 config、跳过 auth），POST setup
 * 后展示写入 / 跳过清单、.bak 备份位置与手动恢复方法。直连 /api/codex/*（见
 * codexApi），不经过桥。
 *
 * 无键盘快捷键（不绑 Enter 提交）：写入的是用户本机另一个应用的配置文件，
 * 多一步显式点击是刻意的。
 */
function CodexWriteSection({ keyValue }: { keyValue: string }) {
  const [phase, setPhase] = React.useState<CodexPhase>('idle')
  const [status, setStatus] = React.useState<CodexStatus | null>(null)
  const [apiKey, setApiKey] = React.useState('')
  /** 掩码显示开关（默认掩码；眼睛按钮切明文，与 Key 行同一意图） */
  const [shown, setShown] = React.useState(false)
  const [result, setResult] = React.useState<CodexSetupResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState('')

  /** 第一步：读 ~/.codex 现状（成功才进入确认步，失败只写 note 不切阶段） */
  async function prepare(): Promise<void> {
    if (busy) return
    setBusy(true)
    setNote('检测 ~/.codex 现状…')
    try {
      const next = await codexApi<CodexStatus>('GET', '/api/codex/status')
      setStatus(next)
      // Key 默认预填本把 Key 的明文（快速接入的意义就是免替换）；已填过的不覆盖
      setApiKey(current => current || keyValue)
      setPhase('ready')
      setNote('')
    } catch (error) {
      setNote(`检测失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 第二步：写入（Key 留空则不带 apiKey 键 → 后端跳过 auth.json，见其模块头） */
  async function write(): Promise<void> {
    if (busy) return
    setBusy(true)
    setNote('正在写入…')
    try {
      const key = apiKey.trim()
      const next = await codexApi<CodexSetupResult>('POST', '/api/codex/setup', {
        // baseUrl 不带：后端按请求 origin 兜底（与 status 的 serverUrl 同口径）
        ...(key ? { apiKey: key } : {}),
      })
      setResult(next)
      setPhase('done')
      setNote('')
      toast('✅ Codex 配置已写入，重启 Codex 后生效')
    } catch (error) {
      setNote(`写入失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const dir = result?.codexDir || status?.codexDir || '~/.codex'
  const serverUrl = status?.serverUrl || window.location.origin

  return (
    <DialogSection>
      <h3>Codex CLI 一键写入</h3>
      {phase === 'idle' ? (
        <>
          <p>
            把本网关一键写入本机 <b>Codex CLI</b> 的配置：写 <code>~/.codex/config.toml</code>
            （model_provider 指向本网关的 OpenAI 兼容端点）与 <code>~/.codex/auth.json</code>
            （OPENAI_API_KEY）。已存在的文件会先备份为同名 <code>.bak</code>，绝不覆盖丢失。
          </p>
          <div className='flex flex-wrap items-center gap-2.5'>
            <Button variant='default' disabled={busy} onClick={() => void prepare()}>
              一键写入 Codex 配置
            </Button>
            <span className='text-[11.5px] text-muted-foreground'>
              先检测本机 ~/.codex 现状，确认后才会写入。
            </span>
          </div>
        </>
      ) : null}
      {phase === 'ready' && status ? (
        <>
          <p>
            写入位置：<code>{dir}</code>；base_url 将写为 <code>{serverUrl}/v1</code>
            （跨机访问时 Codex 连不上这里，请改用网关所在主机的地址）。
          </p>
          <ul className='m-0 list-disc pl-5 text-[12px] leading-[1.7]'>
            <li>
              config.toml：
              {status.configExists ? '已存在 —— 写入前会先备份为 config.toml.bak' : '不存在 —— 将新建'}
            </li>
            <li>
              auth.json：
              {status.authExists ? '已存在 —— 写入前会先备份为 auth.json.bak' : '不存在 —— 将新建'}
            </li>
            {status.backupExists ? (
              <li>已存在 .bak 备份 —— 本次写入会用当前内容覆盖旧备份（.bak 保留的是最近一次写入前的状态）</li>
            ) : null}
          </ul>
          <div className='keycell'>
            <Label htmlFor='codex-api-key' className='text-[12.5px] whitespace-nowrap text-subtle'>
              API Key（写入 auth.json）
            </Label>
            <Input id='codex-api-key' type={shown ? 'text' : 'password'}
              placeholder='粘贴网关 Key；留空则跳过 auth.json'
              autoComplete='off' spellCheck={false} value={apiKey} disabled={busy}
              onChange={event => setApiKey(event.currentTarget.value)} />
            <Button size='icon-xs' variant='ghost'
              aria-label={shown ? '隐藏 API Key 明文' : '显示 API Key 明文'}
              title={shown ? '隐藏 API Key 明文' : '显示 API Key 明文'}
              onClick={() => setShown(value => !value)}>
              {shown ? '🙈' : '👁'}
            </Button>
          </div>
          <p className='text-[11.5px] text-muted-foreground'>
            默认预填本把 Key 的明文，可清空后另贴；留空则只写 config.toml、跳过 auth.json
            （Codex 沿用现有登录方式）。写入完成后需重启 Codex CLI 才会生效。
          </p>
          <div className='flex flex-wrap items-center gap-2.5'>
            <Button variant='outline' disabled={busy} onClick={() => setPhase('idle')}>取消</Button>
            <Button variant='default' disabled={busy} onClick={() => void write()}>写入配置</Button>
          </div>
        </>
      ) : null}
      {phase === 'done' && result ? (
        <>
          <p>写入完成：</p>
          <ul className='m-0 list-disc pl-5 text-[12px] leading-[1.7]'>
            {(result.written ?? []).map(name => (
              <li key={`w-${name}`}>✅ 已写入 <code>{name}</code></li>
            ))}
            {(result.skipped ?? []).map(item => (
              <li key={`s-${item.file ?? '未知'}`}>
                跳过 <code>{item.file || '未知文件'}</code>（{item.reason || '原因未说明'}）
              </li>
            ))}
          </ul>
          {result.backups?.length ? (
            <p className='text-[11.5px] text-muted-foreground'>
              原文件已备份为 {result.backups.join('、')}（位于 <code>{dir}</code>）。
              如需恢复：删除对应的新文件，把 <code>.bak</code> 改回原名即可
              （例如 <code>config.toml.bak</code> → <code>config.toml</code>）。
            </p>
          ) : (
            <p className='text-[11.5px] text-muted-foreground'>
              本次没有覆盖任何已有文件（新建的配置无需备份）。
            </p>
          )}
          <p className='text-[11.5px] text-muted-foreground'>
            Codex CLI 重启后生效：退出 Codex（含 IDE 插件里的 Codex 会话）再重新打开即可。
          </p>
          <Button variant='outline' disabled={busy}
            onClick={() => { setResult(null); setPhase('idle') }}>
            重新检测
          </Button>
        </>
      ) : null}
      <div className='min-h-[18px] text-[11.5px] text-muted-foreground'>{note}</div>
    </DialogSection>
  )
}

/* ─── 额度与有效期：换算与文案 ───────────────── */

/** Token 数的展示口径：千分位（输入框收原始整数，展示带分隔符，四舍五入防浮点尾巴） */
function formatTokens(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value).toLocaleString('zh-CN')
    : '—'
}

/** 临期阈值：到期剩多久内算「临期」（黄字提醒）；真过期另有红字 */
const EXPIRY_SOON_DAYS = 7

/** 毫秒 → 面板时间文案：优先 app.js 的 formatTime（与创建时间列同一格式），桥不在则本地化 */
function formatExpiry(ms: number): string {
  return shared().wbApp?.formatTime?.(ms) || new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/** 到期一行的三态配色（值全走 tokens，深浅主题自动跟随） */
type ExpiryTone = 'danger' | 'warn' | 'muted'

const EXPIRY_COLOR: Record<ExpiryTone, string> = {
  danger: 'var(--danger)',
  warn: 'var(--warn)',
  muted: 'var(--text-3)',
}

/** 进度条条体的三态配色（同上） */
const BAR_COLOR: Record<'primary' | 'warn' | 'danger', string> = {
  primary: 'var(--primary)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
}

/**
 * 到期一行的文案与配色。过期判定以后端 `expired` 字段为准（与转发准入同一
 * 口径），没有读数时（回落列表自带字段）退到本地时钟比较 —— 桌面单机场景
 * 两者差不了几秒。`expiresAt` 为 null（永久）返回 null，由调用方给「永久有效」。
 */
function expiryView(expiresAt: number | null, expired?: boolean): { text: string; tone: ExpiryTone } | null {
  if (expiresAt === null) return null
  const left = expiresAt - Date.now()
  if (expired === true || left <= 0) {
    return { text: `已过期（${formatExpiry(expiresAt)}）`, tone: 'danger' }
  }
  // 向上取整：还剩 0.1 天也报「1 天后过期」，不报 0
  const days = Math.ceil(left / 86400000)
  if (days <= EXPIRY_SOON_DAYS) {
    return { text: `${days} 天后过期（${formatExpiry(expiresAt)}）`, tone: 'warn' }
  }
  return { text: `${formatExpiry(expiresAt)} 到期`, tone: 'muted' }
}

/** 进度条配色：剩余比例 <10% 红、<20% 黄，其余主色（任务口径） */
function quotaTone(used: number, quota: number): 'primary' | 'warn' | 'danger' {
  if (!(quota > 0)) return 'danger'
  const remaining = Math.max(quota - used, 0) / quota
  if (remaining < 0.1) return 'danger'
  if (remaining < 0.2) return 'warn'
  return 'primary'
}

/** 毫秒 → datetime-local 输入框的值（本地时区 YYYY-MM-DDTHH:mm；构造不出给空串） */
function msToLocalInputValue(ms: number | null | undefined): string {
  const date = ms == null ? null : new Date(ms)
  if (!date || Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/* ─── 行内额度区（进度条 / 不限额 / 到期）────────── */

/**
 * Key 行内的「额度」小区域（挂在 Key 列 keycell 下方）。
 *
 * 对照 one-api 令牌页的口径：设了配额给进度条 + 已用/总量（unlimited 给一行
 * 「无限额度」文字），到期过期红字 —— 本页把两者合进一个小区块。配色全走
 * tokens：剩余 <20% --warn、<10% --danger，过期红字、临期（7 天内）黄字；
 * 未设配额显示「不限额」灰字 —— 省略与「没读到」长得一样，所以哪怕不限额也
 * 要写出来（与 restrictionText 同一考虑）。
 *
 * 数据源 quotaMap 优先（带已用读数），还没读到 / 读失败时回落列表自带的
 * quotaTokens / expiresAt：进度条要已用数，没有就只给文字，**不摆一条 0% 的
 * 空条冒充「还没用」**。自绘进度条而不是组件库 Progress：那件的指示器配色
 * 锁在 bg-primary，无法从外部按阈值换 --warn / --danger；role/aria 在这里
 * 手工补齐（与 Base UI 的 Progress 同一组无障碍属性）。
 */
function KeyQuotaArea({ entry, quota }: { entry: KeyEntry; quota: KeyQuota | undefined }) {
  const read = quota ?? null
  // 读数在手以读数为准（ ?? 链会把「读数说 null」误回落到列表字段，必须分叉）
  const quotaTokens = read ? read.quotaTokens ?? null : entry.quotaTokens ?? null
  const expiresAt = read ? read.expiresAt ?? null : entry.expiresAt ?? null
  const used = read?.usedTokens ?? null
  const expired = read?.expired

  return (
    <div
      className='flex min-w-0 flex-col gap-[3px] text-[11.5px] leading-[1.5]'
      title='配额按 Key 维度累计转发 Token 用量，用尽后这把 Key 的请求会被拒绝；到期后 Key 立即失效。'
    >
      {quotaTokens === null ? (
        // 未设配额：不限额也要写出来；已用读数在手时顺带展示（one-api 不限额度也显示已用）
        <div className='text-[var(--text-3)]'>
          不限额{used !== null ? ` · 已用 ${formatTokens(used)} tokens` : ''}
        </div>
      ) : used === null ? (
        // 有配额但已用数还没读到（读数在途 / 读失败）：给文字，不给 0% 空条
        <div className='text-[var(--text-3)]'>限额 {formatTokens(quotaTokens)} tokens · 已用统计待读</div>
      ) : (
        <>
          <div
            role='progressbar'
            aria-label={`额度使用 ${formatTokens(used)} / ${formatTokens(quotaTokens)} tokens`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(Math.max(used / quotaTokens, 0), 1) * 100)}
            className='h-[5px] w-full overflow-hidden rounded-[var(--r-pill)] bg-[var(--surface-3)]'
          >
            {/* used 可能越过配额（超用），宽度封顶 100% */}
            <div
              className='h-full rounded-[inherit] transition-[width] duration-300 ease-out'
              style={{
                width: `${Math.min(Math.max(used / quotaTokens, 0), 1) * 100}%`,
                background: BAR_COLOR[quotaTone(used, quotaTokens)],
              }}
            />
          </div>
          <div className='tabular-nums'>
            已用 {formatTokens(used)} / {formatTokens(quotaTokens)}
            <span className='text-[var(--text-3)]'> tokens · 剩余 {formatTokens(Math.max(quotaTokens - used, 0))}</span>
          </div>
        </>
      )}
      {(() => {
        const view = expiryView(expiresAt, expired)
        if (!view) return <div className='text-[var(--text-3)]'>永久有效</div>
        return <div style={{ color: EXPIRY_COLOR[view.tone] }}>{view.text}</div>
      })()}
    </div>
  )
}

/* ─── 额度管理弹窗（配额 / 有效期 / 重置已用）────── */

type QuotaModalProps = {
  target: KeyEntry
  /** 行内已拉到的读数（带已用数）；还没读到时给 undefined，初值回落列表自带字段 */
  quota: KeyQuota | undefined
  onClose: () => void
  /** PUT 返回**生效后**的全量读数（后端契约），交给父级就地更新，不必再 GET */
  onSaved: (next: KeyQuota) => void
}

function QuotaModal({ target, quota, onClose, onSaved }: QuotaModalProps) {
  // 初值只在挂载时算一次：弹窗每次打开都是新实例（有目标才渲染），不会陈旧
  const [quotaText, setQuotaText] = React.useState(() => {
    const initial = quota?.quotaTokens ?? target.quotaTokens ?? null
    return initial === null ? '' : String(initial)
  })
  const [expiryText, setExpiryText] = React.useState(
    () => msToLocalInputValue(quota?.expiresAt ?? target.expiresAt ?? null),
  )
  const [resetUsed, setResetUsed] = React.useState(false)
  const [status, setStatus] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  /** 在途守卫：命令式的关闭判定（Esc / 点遮罩）必须能**同步**读到它（KeyModal 同款） */
  const savingRef = React.useRef(false)

  /** 收尾：解除在途守卫（写两处，避免两边漂移） */
  function stopSaving(): void {
    savingRef.current = false
    setSaving(false)
  }

  async function save(): Promise<void> {
    if (savingRef.current) return
    // 先校验再置忙（与 KeyModal 同序）：非法输入不动在途守卫
    const quotaInput = quotaText.trim()
    if (quotaInput && (!/^\d+$/.test(quotaInput) || Number(quotaInput) <= 0)) {
      setStatus('配额必须是正整数（Token 个数）；留空表示不限额')
      return
    }
    const expiryInput = expiryText.trim()
    let expiresAt: number | null = null
    if (expiryInput) {
      // datetime-local 的值无时区后缀，new Date 按本地时区解析 —— 与展示口径一致
      const parsed = new Date(expiryInput).getTime()
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setStatus('到期时间无效，请重新选择；留空表示永久有效')
        return
      }
      expiresAt = parsed
    }
    savingRef.current = true
    setSaving(true)
    setStatus('保存中…')
    try {
      // 字段级三态里本弹窗只用两态：每次都带当前值**整表回传**（数字 / null），
      // 「键缺失 = 不动」留给只想重置用量的提交 —— 后端两种提交都安全
      const next = await quotaApi('PUT', target.id, {
        quotaTokens: quotaInput ? Number(quotaInput) : null,
        expiresAt,
        // 缺省不带这个键 = 不动已用计数（后端按「有没有这个键」判定）
        ...(resetUsed ? { resetUsed: true } : {}),
      })
      stopSaving()
      onSaved(next)
      onClose()
      toast('✅ 额度已保存')
    } catch (error) {
      setStatus(`保存失败：${errorMessage(error)}`)
      stopSaving()
    }
  }

  const used = quota?.usedTokens ?? null

  return (
    <Dialog
      open
      onOpenChange={(next, eventDetails) => {
        // 与 KeyModal 同一判定：保存中拒绝关闭必须走 eventDetails.cancel()
        if (next) return
        if (savingRef.current) {
          eventDetails.cancel()
          return
        }
        onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>额度管理 · {target.name || '未命名'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogSection>
            <div className='flex flex-wrap items-center gap-2.5'>
              <Label htmlFor='key-quota-input' className='text-[12.5px] whitespace-nowrap text-subtle'>配额 Token 数</Label>
              <Input id='key-quota-input' type='text' inputMode='numeric' placeholder='留空 = 不限额'
                autoComplete='off' className='max-w-[220px]' value={quotaText}
                onChange={event => setQuotaText(event.currentTarget.value)} />
            </div>
            <p className='text-[11.5px] text-muted-foreground'>
              配额按 <b>Key 维度</b>累计转发 Token 用量（所有经这把 Key 的请求加总），用尽后这把 Key
              的请求会被拒绝。留空表示不限额。{used !== null ? `当前已用 ${formatTokens(used)} tokens。` : ''}
            </p>
            <div className='flex flex-wrap items-center gap-2.5'>
              <Label htmlFor='key-expiry-input' className='text-[12.5px] whitespace-nowrap text-subtle'>到期时间</Label>
              <Input id='key-expiry-input' type='datetime-local' className='max-w-[220px]'
                value={expiryText} onChange={event => setExpiryText(event.currentTarget.value)} />
            </div>
            <p className='text-[11.5px] text-muted-foreground'>
              留空表示永久有效；到期后这把 Key 立即失效（已排队的请求也会被拒）。
            </p>
            {/* Checkbox 的关联用 <label> 包裹（组件库的 Checkbox 是 button 形态，
                htmlFor 关联不上；点击文字切换与账号页批量栏同一手法） */}
            <label className='flex cursor-pointer flex-wrap items-center gap-2'>
              <Checkbox checked={resetUsed} onCheckedChange={next => setResetUsed(next === true)}
                aria-label='保存时同时清零已用计数' />
              <span className='text-[12.5px]'>保存时同时清零已用计数（重新开始计量）</span>
            </label>
            <p>
              保存立即生效：改配额不清零已用（历史事实），勾选上面一项才会清零；两项留空 / 不勾
              就按输入框里的值保存（空 = 清除该限制）。
            </p>
          </DialogSection>
          <div className='min-h-[18px] text-[11.5px] text-muted-foreground'>{status}</div>
        </DialogBody>
        <DialogFooter>
          <div className='mr-auto' />
          <Button variant='outline' onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant='default' disabled={saving} onClick={() => void save()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─── 页面本体 ───────────────────────────────── */

/** 组件挂载后登记的入口：对外契约的 load / render 都经它转发 */
type PageHandle = {
  load(): Promise<void>
  /** 旧实现的重绘入口（当前无外部调用点，保留契约） */
  render(): void
}

let handle: PageHandle | null = null

/** app.js 切到本页时调它拉一次（挂载前的调用见文件末尾的说明） */
async function load(): Promise<void> {
  await handle?.load()
}

/** 保留旧实现的能力：按当前数据重绘一次 */
function render(): void {
  handle?.render()
}

function KeysPage() {
  const [data, setData] = React.useState<KeysPayload | null>(null)
  /** 已切到明文显示的 key id */
  const [revealed, setRevealed] = React.useState<ReadonlySet<string>>(() => new Set())
  /** 在途操作的行（按钮与开关禁用）；同步守卫读下面的 ref */
  const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set())
  /** 弹窗：null = 关着；{ key: null } = 新建 */
  const [modal, setModal] = React.useState<{ key: KeyEntry | null } | null>(null)
  /**
   * 快速接入弹窗：只存 key id，条目每次从最新列表里现查 —— 列表刷新 / 那把 Key 被
   * 删掉时弹窗自动跟上（找不到条目就不渲染），不会拿着一份过期的明文继续展示。
   */
  const [quickId, setQuickId] = React.useState<string | null>(null)
  /**
   * 每把 Key 的额度读数（`GET /api/keys/{id}/quota`，按 id 收）：行内进度条与
   * 到期展示的数据源。读不到（在途 / 失败）的 Key 行内回落列表自带的
   * quotaTokens / expiresAt，只少进度条不少信息。
   */
  const [quotaMap, setQuotaMap] = React.useState<Record<string, KeyQuota>>({})
  /** 额度管理弹窗：只存 key id，条目每次从最新列表里现查（与 quickId 同一手法） */
  const [quotaId, setQuotaId] = React.useState<string | null>(null)
  /** 列设置改了 / 契约 render() 被调 → 强制重画（数据没变但可见列变了） */
  const [, setVersion] = React.useState(0)

  const pendingRef = React.useRef<Set<string>>(new Set())
  const loadingRef = React.useRef(false)
  /** effect 里判断「哪些 Key 还没有读数」用：state 本体的镜像（effect 依赖只有 id 串） */
  const quotaMapRef = React.useRef(quotaMap)
  quotaMapRef.current = quotaMap

  const applyData = React.useCallback((next: KeysPayload | null) => {
    setData(next)
  }, [])

  /** 写接口返回的最新列表：形状不对（读失败）时保持原样，与旧实现的 accept 同口径 */
  const accept = React.useCallback((next: KeysPayload | null | undefined) => {
    if (next && Array.isArray(next.keys)) applyData(next)
  }, [applyData])

  const loadPanel = React.useCallback(async (): Promise<void> => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const api = shared().workbuddyDesktop
      if (!api) throw new Error('后端桥不可用')
      applyData((await api.getKeys()) ?? null)
    } catch (error) {
      toast(`读取 Key 列表失败：${errorMessage(error)}`, 'err')
    } finally {
      loadingRef.current = false
    }
  }, [applyData])

  /** 行内异步操作的统一外壳：置忙 → 跑 → 用返回值刷新 → 收忙（失败只 toast） */
  async function runRowAction(
    id: string,
    run: () => Promise<KeysPayload | null | undefined>,
    doneText?: string,
  ): Promise<void> {
    if (pendingRef.current.has(id)) return
    pendingRef.current.add(id)
    setPending(new Set(pendingRef.current))
    try {
      accept(await run())
      if (doneText) toast(doneText)
    } catch (error) {
      toast(`操作失败：${errorMessage(error)}`, 'err')
    } finally {
      pendingRef.current.delete(id)
      setPending(new Set(pendingRef.current))
    }
  }

  function toggleReveal(id: string): void {
    setRevealed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 删除：原生 confirm 在 Tauri 的 WebView 里不弹窗、直接放行（等于没有确认） */
  async function removeKey(k: KeyEntry): Promise<void> {
    const api = shared().workbuddyDesktop
    const ask = shared().wbConfirm?.ask
    if (!api || !ask) return
    const label = escapeHtml(k.name || k.masked || k.id)
    const confirmed = await ask({
      title: '删除网关 Key',
      html: `确定删除 Key「<strong>${label}</strong>」？使用它的客户端会立刻无法访问。`,
      okText: '删除',
      okClass: 'danger',
    })
    if (!confirmed) return
    void runRowAction(k.id, () => api.deleteKey(k.id), 'Key 已删除')
  }

  /** 开关：写接口回的是最新列表，就地替换（与旧实现的 runRowAction 同路） */
  function toggleEnabled(k: KeyEntry, next: boolean): void {
    const api = shared().workbuddyDesktop
    if (!api) return
    void runRowAction(
      k.id,
      () => api.updateKey(k.id, { enabled: next }),
      next ? 'Key 已启用' : 'Key 已停用',
    )
  }

  /**
   * 额度保存成功：PUT 的响应是**生效后**的全量读数，就地更新该行（进度条 /
   * 到期立即跟上）；列表里的 quotaTokens / expiresAt 也变了，重拉一次列表对齐
   * —— 与写接口「返回最新列表就替换」的页面习惯同一方向。
   */
  const handleQuotaSaved = React.useCallback((id: string, next: KeyQuota) => {
    setQuotaMap(prev => ({ ...prev, [id]: next }))
    void loadPanel()
  }, [loadPanel])

  /* ─── 挂载期的两件事：契约登记 + 列设置（见文件头）────── */

  React.useLayoutEffect(() => {
    handle = {
      load: loadPanel,
      render: () => setVersion(version => version + 1),
    }
    onColumnsChanged = () => setVersion(version => version + 1)
    setupColumns()
    // 注册完必须再画一次：首帧的 visibleColumns() 还是「列设置未就绪」的回退值
    // （全部列、声明顺序），用户藏过列的话表头与表体会对不上。layout effect 里的
    // setState 是同步重画，发生在浏览器绘制之前，看不到这一帧。
    setVersion(version => version + 1)
    return () => {
      handle = null
      onColumnsChanged = null
    }
  }, [loadPanel])

  /**
   * 首屏自持加载：app.js 的 showPage 在本脚本加载前就执行过（那时 window.wbKeysPanel
   * 还不存在，切页那次调用落空），用户上次若停在本页，这里补一次 —— 与旧实现文件
   * 末尾的 `if (wbApp.currentPage === 'keys') load()` 等价。
   */
  React.useEffect(() => {
    if (shared().wbApp?.currentPage === 'keys') void loadPanel()
  }, [loadPanel])

  /** 当前列表的 id 串（下面补拉 effect 的依赖；渲染段还用它现查弹窗目标） */
  const idsKey = keysOf(data).map(item => item.id).join(',')

  /**
   * 额度读数的按需补拉：列表里出现还没有读数的 Key（首载 / 新建）就打一次
   * `GET /api/keys/{id}/quota`。依赖是 **id 串**而不是数组引用 —— 行内启停等写
   * 操作换来的新列表 id 集合没变，不重拉；额度只在弹窗里改，保存后走就地更新
   * （见 handleQuotaSaved），这里自然不用跟。读数失败（旧版后端没有这组端点）
   * 静默回落：Key 通常只有几把，失败也不弹错误风暴，行内少条进度条而已。
   */
  React.useEffect(() => {
    if (!idsKey) return
    const missing = idsKey.split(',').filter(id => !quotaMapRef.current[id])
    if (!missing.length) return
    let alive = true
    void (async () => {
      const results = await Promise.allSettled(missing.map(id => quotaApi('GET', id)))
      if (!alive) return
      setQuotaMap(prev => {
        const next = { ...prev }
        missing.forEach((id, index) => {
          const result = results[index]
          if (result.status === 'fulfilled') next[id] = result.value
        })
        return next
      })
    })()
    return () => { alive = false }
  }, [idsKey])

  /** 顶栏那枚是本页徽标的镜像（app.js 的 renderTopbarStatus 按 id 读文案与 data-tone）：
   *  数据一变就让它跟上，否则要等下一次主状态轮询（20 秒）才同步 */
  React.useEffect(() => {
    shared().wbApp?.renderTopbarStatus?.()
  }, [data])

  /* ─── 渲染 ─────────────────────────────── */

  const keys = keysOf(data)
  /** 客户端分页（通用表格外壳）：Key 通常只有几把，但口径与其它四张表保持一致 */
  const paging = useClientPaging(keys.length, 'keys')
  const list = paging.paged ? paging.slice(keys) : keys
  const columns = visibleColumns()
  const authRequired = data?.authRequired === true
  const enabledCount = list.filter(item => item.enabled).length
  const badgeText = authRequired ? `已启用鉴权 · ${enabledCount} 把 Key 生效` : '未启用鉴权'
  /** 快速接入弹窗的目标（按 id 从最新列表现查，见 quickId 的说明） */
  const quickTarget = quickId ? keys.find(item => item.id === quickId) ?? null : null
  /** 额度管理弹窗的目标（同上现查；读数从 quotaMap 里取，没有就回落列表字段） */
  const quotaTarget = quotaId ? keys.find(item => item.id === quotaId) ?? null : null

  /** 一个单元格的内容（不含 <td> 外壳）；「某一列长什么样」只有这一处实现 */
  function cell(columnKey: string, k: KeyEntry, busyRow: boolean): React.ReactNode {
    switch (columnKey) {
      case 'name':
        return (
          <>
            <div className='mid'><span className='t'>{k.name || '未命名'}</span></div>
            <div className='mname' title={restrictionTitle(k)}>{restrictionText(k)}</div>
          </>
        )
      case 'key': {
        const shown = revealed.has(k.id)
        return (
          // Key 列是全表最宽的一列，进度条放这里才铺得开（名称列还有限制摘要要摆）
          <div className='flex min-w-0 flex-col gap-[6px]'>
            <div className='keycell'>
              <code className='kv'>{shown ? k.key : k.masked}</code>
              <Button size='sm' variant='ghost' onClick={() => toggleReveal(k.id)}>
                {shown ? '隐藏' : '显示'}
              </Button>
              {/* data-copy 是 clipboard.js 的委托钩子 */}
              <Button size='sm' variant='ghost' data-copy={k.key} title='复制 Key'>复制</Button>
            </div>
            <KeyQuotaArea entry={k} quota={quotaMap[k.id]} />
          </div>
        )
      }
      case 'time':
        return (
          <span className='muted'>{k.createdAt ? shared().wbApp?.formatTime?.(k.createdAt) : '—'}</span>
        )
      case 'state':
        return (
          <Switch checked={k.enabled === true} disabled={busyRow}
            aria-label={`启用「${k.name || '未命名'}」`}
            onCheckedChange={next => toggleEnabled(k, next)} />
        )
      case 'act':
        return (
          <div className='row-actions'>
            <Button size='sm' variant='ghost' disabled={busyRow} onClick={() => setQuickId(k.id)}>
              快速接入
            </Button>
            <Button size='sm' variant='ghost' disabled={busyRow} onClick={() => setModal({ key: k })}>
              可用范围
            </Button>
            <Button size='sm' variant='ghost' disabled={busyRow} onClick={() => setQuotaId(k.id)}>
              额度管理
            </Button>
            <Button size='sm' variant='destructive' disabled={busyRow}
              onClick={() => void removeKey(k)}>
              删除
            </Button>
          </div>
        )
      default:
        return null
    }
  }

  return (
    <section className='panel'>
      <div className='panel-head'>
        <h2>API Key 列表</h2>
        {/* id 与 data-tone 保留：app.js 的 renderTopbarStatus 按 id 镜像这枚徽标的文案
            与配色（data-tone 有值走它，不去拆组件库 Badge 那串 Tailwind 类名） */}
        <Badge id='keys-status' variant={authRequired ? 'success' : 'warning'}
          data-tone={authRequired ? 'ok' : 'warn'}>
          {badgeText}
        </Badge>
        <div className='head-actions'>
          {/* 列设置的触发按钮由 wbColSettings.register 插进这个容器的最前面（命令式，
              与模型管理页同一手法：插入位置由那边决定，本岛只留容器） */}
          <Button variant='default' onClick={() => setModal({ key: null })}>
            ＋ 新建 Key
          </Button>
        </div>
      </div>

      <div className='models-table-wrap'>
        <table className='models-table keys-table'>
          {/* colgroup / thead 由本文件渲染，但 data-col 一个不少：列设置的就地重排
              （syncStaticHead）与列宽层（table-columns.js）都按它定位列 */}
          <colgroup>
            <col className='k-name' data-col='name' />
            <col className='k-key' data-col='key' />
            <col className='k-time' data-col='time' />
            <col className='k-state' data-col='state' />
            <col className='k-act' data-col='act' />
          </colgroup>
          <thead>
            <tr>
              <th data-col='name'>名称</th>
              <th data-col='key'>Key</th>
              <th data-col='time'>创建时间</th>
              <th data-col='state'>启用</th>
              <th className='r' data-col='act'>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.length ? list.map(k => {
              const busyRow = pending.has(k.id)
              return (
                <tr key={k.id} className={k.enabled ? '' : 'off'} data-id={k.id}>
                  {columns.map(column => (
                    <td key={column.key} className={`${CELL_CLASS[column.key] ?? ''} ta-${column.align}`}>
                      {cell(column.key, k, busyRow)}
                    </td>
                  ))}
                </tr>
              )
            }) : (
              // 空态的 colspan 跟着可见列数走：写死 5 之后藏起两列，这一格会比表体宽出
              // 两格，把整张表顶出横向滚动
              <tr>
                <td colSpan={columns.length} className='empty'>
                  {data ? '还没有 Key，当前不鉴权' : '加载中…'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <TableFooter
        leading={(
          <span>
            客户端请求需带 <code>{'Authorization: Bearer <key>'}</code> 或 <code>{'x-api-key: <key>'}</code>；
            修改后立即生效，本程序自身会自动使用第一把启用的 Key。每把 Key 可单独限制
            <b>可用提供商</b>与<b>可用模型</b>（行内「可用范围」）：留空 = 不限制，两个都设时
            按交集生效 —— 被限制的模型对这把 Key 表现为「不存在」（拉 /v1/models 也看不到它），
            提供它的家不在可用列表里时请求同样被拒。每把 Key 还可单独设
            <b>配额</b>与<b>有效期</b>（行内「额度管理」）：配额按 Key 维度累计转发 Token
            用量，用尽或到期后这把 Key 的请求都会被拒。
          </span>
        )}
        total={keys.length}
        range={paging.paged ? { start: paging.rangeStart, end: paging.rangeEnd } : null}
        page={paging.page}
        pageCount={paging.pageCount}
        size={paging.size}
        onSizeChange={paging.setSize}
        onPageChange={paging.goto}
      />

      {modal ? (
        <KeyModal
          target={modal.key}
          providers={providersOf(data)}
          modelsByProvider={modelsByProviderOf(data)}
          onClose={() => setModal(null)}
          onSaved={(next, revealId) => {
            if (revealId) setRevealed(prev => new Set(prev).add(revealId))
            accept(next)
            // 新建成功后直接打开快速接入：创建 Key 的下一步就是把带真实 Key 的接入配置
            // 复制给客户端（原先只有一句「记得复制」的 toast，还得去行里找按钮）
            if (revealId) setQuickId(revealId)
          }}
        />
      ) : null}

      {quickTarget ? (
        <QuickAccessModal target={quickTarget} onClose={() => setQuickId(null)} />
      ) : null}

      {quotaTarget ? (
        <QuotaModal
          target={quotaTarget}
          quota={quotaMap[quotaTarget.id]}
          onClose={() => setQuotaId(null)}
          onSaved={next => handleQuotaSaved(quotaTarget.id, next)}
        />
      ) : null}
    </section>
  )
}

/* ─── 挂载：接管 index.html 里既有的页面区块 ─────── */

let mounted = false

/**
 * 把 React root 直接建在页面区块上（不套宿主 div：页面 CSS 用 `.page > *` 这组直接
 * 子选择器分配高度，中间插一层会打断它）。先清掉骨架里的静态子节点 —— 下面按同样的
 * 类名重新渲染，留着会与 React 打架。
 */
function mount(): void {
  if (mounted) return
  const section = document.querySelector<HTMLElement>(SECTION)
  if (!section) return
  mounted = true
  section.replaceChildren()
  createRoot(section).render(<KeysPage />)
}

// 脚本排在页面骨架之后（index.html 里 islands/ui.js 在各 section 之后），正常直接挂；
// 万一将来被挪到前面，退化成等 DOM 解析完再挂。
if (document.querySelector(SECTION)) mount()
else document.addEventListener('DOMContentLoaded', mount, { once: true })

declare global {
  interface Window {
    /** 网关 Key 面板（替换 ui/keys-panel.js，接口与原实现一致） */
    wbKeysPanel?: {
      /** 切到本页时拉一次（app.js:151） */
      load(): Promise<void>
      /** 按当前数据重绘（旧实现的能力，保留） */
      render(): void
      /** 当前可见的列（table-columns.js 的列宽层按它算覆盖值与末列把手） */
      visibleColumns(): (ColumnDecl & { align: Align })[]
    }
  }
}

window.wbKeysPanel = { load, render, visibleColumns }
