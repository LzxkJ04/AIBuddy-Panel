import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Button, Spinner } from '@ui'

/**
 * 文档页（接口地址）—— React 岛。
 *
 * 替换的是 ui/index.html 里 `<section class="page" data-page="docs">` 那 74 行静态 DOM
 * （接口条 .ep-panel / .ep-list / .ep-row / .ep-group / .panel-foot）。对外**没有任何
 * window 接口**，app.js 切到本页时只调 `window.wbPortPanel.sync()`（补一次真实端口），
 * 与本岛无关，调用方一行都不用改。页面共三块面板：接口地址（纯展示）、客户端快速接入
 * （本地状态）与网关健康（有网络请求，见下）。
 *
 * ── 网关健康：探活不在挂载时打，在「进页面」时打 ────────────────
 * 本岛在应用启动时就挂载（islands/ui.js 统一加载），不是切到本页才挂载；要是在挂载
 * useEffect 里直接探活，用户一辈子不进文档页也会白打几发请求。app.js 切页只在本岛
 * 挂载的 section 上切 `.active` 类（从不碰子节点，两边不抢 DOM），于是拿 class 变化
 * 当「进页面」的信号：MutationObserver 盯住 section 的 class，每次拿到 `.active`
 * 自动检测一轮（挂载时就已在本页 —— 上次会话停在这页 —— 也算一次）。不新增
 * window 接口、不改 app.js：showPage 的 docs 分支保持只调 wbPortPanel.sync()。
 * 探活对象按部署者视角挑的：/health 与 /v1/models 同源、免鉴权（未配 Key 的空
 * 模型清单同样算成功），未登录时 /api/update/status、/api/storage 读不到只回落
 * 「—」/ 省略脚注，不算失败。
 *
 * ── 挂载：面板岛模式，root 直接建在既有的页面区块上 ──────────────
 * 先 `section.replaceChildren()` 清掉静态骨架，再把 root 建在这个 section 上（不套宿主
 * div）：页面 CSS 用 `.page` / `.panel` 这组直接子选择器分配布局，中间插一层会打断它
 * （与 tasks-panel / logs-panel 同一手法）。app.js 的 showPage 只在这个 section 上切
 * `active` 类、从不碰子节点，两边不会抢同一个 DOM。
 *
 * ── 边界：页面布局类名照旧，控件换组件库 ──────────────────────
 * `.panel` `.panel-head` `.panel-foot` `.ep-panel` `.ep-list` `.ep-row` `.ep-head`
 * `.ep-name` `.ep-note` `.ep-line` `.ep-value` `.ep-group` 全部保留（样式在
 * ui/css/page-gateway.css 与 layout.css）—— 布局不是「组件」，换成 Tailwind 会让这一页
 * 与其它页长得不一样。这一页唯一的控件是 5 颗复制按钮，换成 @ui 的 Button。
 * 面板头那枚问号仍是 `.tip-q` + `data-tip`（tooltip.js 的自动增强带 MutationObserver，
 * 接得住 React 插入的节点）—— 与设置页 / 定时任务页同一处理，不换成 Tooltip 是刻意的：
 * 换要把长文包一层组件，观感与行为却完全一样。
 *
 * ── 地址不是本岛的数据：五个 id 必须原样渲染、且必须稳定 ────────────
 * 五条地址的文本由**另一个岛**写进来：port-panel.tsx 的 paintGatewayAddress 用
 * `getElementById(id).textContent = ...` 就地覆盖（它每次 sync / render 都重写一遍，
 * 地址随真实端口变化）。所以：
 *   · `id` 一字不改（api-base / api-chat / api-responses / api-messages / api-models）
 *     —— 少了任何一个，那一行地址永远是占位的「—」；
 *   · 这五个元素的**文本不进 React 的 state**，本岛只渲染一次静态骨架，之后不重渲染；
 *     即便将来有人给它加了会变的 key 或条件渲染把它换掉，React 重建元素后 port-panel
 *     要等下一次 sync（最多 20 秒的轮询）才会补写 —— 用户会看到地址闪没；
 *   · 占位的「—」是**首屏**文案（静态 DOM 里就有）：port-panel 还没写进来时不留空白。
 *     React 只在挂载时渲染它一次，之后 port-panel 的 textContent 覆盖不会被 React
 *     回写（同一处 children 前后一致，React 不产生 DOM 操作），所以不会互相打架。
 *
 * ── 复制按钮：属性与类名都是 clipboard.js 的契约 ────────────────
 * clipboard.js 是**全局事件委托**（扫 `[data-copy-from]`，取该 id 元素的文本、剥掉
 * "POST " / "GET " 前缀再复制），并且只在触发器带 `.copy-btn` 类时才做「⧉ → ✓」的
 * 即时反馈。两样都照抄静态 DOM，换成 Button 不影响：委托认的是属性与类名，不看标签。
 */

/* ─── 常量 ─────────────────────────────────── */

/** 面板头问号的说明全文（逐字照抄静态 DOM 的 data-tip，别删条目 —— 每一条都是踩过的边界） */
const PANEL_TIP = 'Base URL 填进客户端的「API 地址 / Base URL」栏；对话协议按客户端支持的类型三选一'
  + '（Chat Completions / Responses / Anthropic Messages），三者共用同一套模型与账号池，可随时切换；'
  + '鉴权用「网关 Key」页里任一启用 Key。'

/* ─── 小组件 ───────────────────────────────── */

type EndpointRowProps = {
  /** port-panel 与 clipboard.js 都按这个 id 找人：契约点，不许改 */
  id: string
  name: string
  note: string
}

/** 一行端点：上排「名字 + 用途」，下排「方法 + URL + 复制」（两排是 .ep-* 的既有版式） */
function EndpointRow({ id, name, note }: EndpointRowProps) {
  return (
    <div className='ep-row'>
      <div className='ep-head'>
        <span className='ep-name'>{name}</span>
        <span className='ep-note'>{note}</span>
      </div>
      <div className='ep-line'>
        <code className='ep-value' id={id}>—</code>
        {/*
          复制按钮：`data-copy-from` 与 `.copy-btn` 见文件头（clipboard.js 的委托契约）。
          size / rounded 用工具类再写一遍 21px 与 --r-xs：`.copy-btn` 是老样式表里的
          未分层声明，而组件库的工具类分层且带 !important（globals.css 的刻意取舍），
          不补这两个值就会被 icon-xs 档的 24px / 圆角盖掉，这一行的行高跟着变。
        */}
        <Button
          variant='ghost'
          size='icon-xs'
          className='copy-btn size-[21px] rounded-[var(--r-xs)]'
          data-copy-from={id}
          title='复制地址'
        >
          ⧉
        </Button>
      </div>
    </div>
  )
}

/* ─── 客户端快速接入：按当前网关地址生成现成配置 ─── */

type SharedWindow = {
  workbuddyDesktop?: { platform?: string }
}

/**
 * 当前网关对外地址（不带 /v1）。
 *
 * 首选「接口地址」面板里 port-panel 已写好的 Base URL（与页面显示永远同源）；
 * 它还没写进来（极早时序）时按同款规则现算：网页端非回环 → 当前 origin，桌面 → 127.0.0.1。
 */
function quickStartBase(): string {
  const text = document.getElementById('api-base')?.textContent?.trim()
  if (text && text !== '—' && text.startsWith('http')) return text.replace(/\/+v1$/, '')
  const host = window.location.hostname
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  const isWeb = (window as unknown as SharedWindow).workbuddyDesktop?.platform === 'web'
  if (isWeb && !loopback) return window.location.origin
  return 'http://127.0.0.1:3065'
}

type ClientKind = 'curl' | 'python' | 'node' | 'claude' | 'codex'

const CLIENT_TABS: { kind: ClientKind; label: string; hint: string }[] = [
  { kind: 'curl', label: 'curl', hint: '命令行直接测通' },
  { kind: 'python', label: 'Python', hint: 'openai SDK' },
  { kind: 'node', label: 'Node.js', hint: 'openai SDK（ESM）' },
  { kind: 'claude', label: 'Claude Code', hint: 'Anthropic 协议环境变量' },
  { kind: 'codex', label: 'Codex CLI', hint: 'config.toml 接入' },
]

/** 生成各客户端的接入片段（base 不带 /v1；Key 与模型名用占位符，用户替换） */
function clientSnippet(kind: ClientKind, base: string): string {
  switch (kind) {
    case 'curl':
      return [
        `curl ${base}/v1/chat/completions \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Authorization: Bearer sk-你的网关Key" \\`,
        `  -d '{`,
        `    "model": "模型名（GET /v1/models 里任选）",`,
        `    "messages": [{"role": "user", "content": "你好"}],`,
        `    "stream": true`,
        `  }'`,
      ].join('\n')
    case 'python':
      return [
        `from openai import OpenAI`,
        ``,
        `client = OpenAI(base_url="${base}/v1", api_key="sk-你的网关Key")`,
        `resp = client.chat.completions.create(`,
        `    model="模型名（GET /v1/models 里任选）",`,
        `    messages=[{"role": "user", "content": "你好"}],`,
        `)`,
        `print(resp.choices[0].message.content)`,
      ].join('\n')
    case 'node':
      return [
        `import OpenAI from 'openai'`,
        ``,
        `const client = new OpenAI({`,
        `  baseURL: '${base}/v1',`,
        `  apiKey: 'sk-你的网关Key',`,
        `})`,
        `const resp = await client.chat.completions.create({`,
        `  model: '模型名（GET /v1/models 里任选）',`,
        `  messages: [{ role: 'user', content: '你好' }],`,
        `})`,
        `console.log(resp.choices[0].message.content)`,
      ].join('\n')
    case 'claude':
      return [
        `# macOS / Linux（bash）`,
        `export ANTHROPIC_BASE_URL=${base}`,
        `export ANTHROPIC_AUTH_TOKEN=sk-你的网关Key`,
        `claude`,
        ``,
        `# Windows（PowerShell）`,
        `$env:ANTHROPIC_BASE_URL = "${base}"`,
        `$env:ANTHROPIC_AUTH_TOKEN = "sk-你的网关Key"`,
        `claude`,
      ].join('\n')
    case 'codex':
      return [
        `# ~/.codex/config.toml`,
        `model_provider = "aibuddy"`,
        ``,
        `[model_providers.aibuddy]`,
        `name = "AIBuddy Panel"`,
        `base_url = "${base}/v1"`,
        `wire_api = "chat"`,
        `env_key = "AIBUDDY_API_KEY"`,
        ``,
        `# 然后设置环境变量再启动：`,
        `export AIBUDDY_API_KEY=sk-你的网关Key`,
      ].join('\n')
  }
}

/** 一颗接入客户端的分段按钮（选中用品牌实底，未选中透明） */
function ClientTab({ kind, label, hint, active, onPick }: {
  kind: ClientKind
  label: string
  hint: string
  active: boolean
  onPick: (kind: ClientKind) => void
}) {
  return (
    <Button
      variant={active ? 'default' : 'ghost'}
      size='sm'
      className='shrink-0'
      title={hint}
      onClick={() => onPick(kind)}
    >
      {label}
    </Button>
  )
}

const DOCS_CLIENT_KEY = 'aibuddy-docs-client'
const DOCS_CLIENTS: ClientKind[] = ['curl', 'python', 'node', 'claude', 'codex']

/** 上次选过的客户端类型：设置页「页面偏好」与本处共用同一个键 */
function readDocsClient(): ClientKind {
  try {
    const saved = localStorage.getItem(DOCS_CLIENT_KEY)
    return saved !== null && (DOCS_CLIENTS as string[]).includes(saved) ? (saved as ClientKind) : 'curl'
  } catch {
    return 'curl'
  }
}

function QuickStartPanel() {
  const [kind, setKindState] = useState<ClientKind>(readDocsClient)
  const setKind = (next: ClientKind) => {
    setKindState(next)
    try {
      localStorage.setItem(DOCS_CLIENT_KEY, next)
    } catch {
      // 存储不可用只影响下次打开
    }
  }
  // 现读而非存 state：port-panel 首渲染就会把 Base URL 写进 #api-base，
  // 用户点切换时读到的必然是已同步的地址（早时序则走 quickStartBase 的回退）
  const base = quickStartBase()
  const snippetId = 'qs-snippet'
  return (
    <section className='panel ep-panel'>
      <div className='panel-head'>
        <h2>客户端快速接入</h2>
        <span className='tip-q' tabIndex={0} aria-label='接口地址说明'
          data-tip='按上方 Base URL 现生成接入片段；把「sk-你的网关Key」换成「网关 Key」页里创建的 Key，模型名从 GET /v1/models 里选。'></span>
      </div>
      <div className='ep-list'>
        <div className='ep-group'>选择客户端类型</div>
        <div className='flex flex-wrap gap-2 px-[16px] pb-[4px]'>
          {CLIENT_TABS.map((tab) => (
            <ClientTab key={tab.kind} {...tab} active={kind === tab.kind} onPick={setKind} />
          ))}
        </div>
        <div className='px-[16px] pb-[16px]'>
          <div className='relative'>
            <pre
              id={snippetId}
              className='m-0 overflow-x-auto rounded-[var(--r-sm)] bg-[var(--surface-inset)] p-[14px] font-mono text-[12px] leading-[1.7] whitespace-pre'
            >{clientSnippet(kind, base)}</pre>
            <Button
              variant='ghost'
              size='icon-xs'
              className='copy-btn absolute right-[10px] top-[10px] size-[24px] rounded-[var(--r-xs)] bg-[var(--surface)]'
              data-copy-from={snippetId}
              title='复制配置'
            >
              ⧉
            </Button>
          </div>
          <div className='mt-[10px] text-[12px] muted'>
            各客户端共用同一套账号池与 Key；流式（SSE）在以上所有方式里默认开启。
          </div>
        </div>
      </div>
    </section>
  )
}

/* ─── 网关健康：同源探活 + 引擎版本，三张状态卡 ─── */

/**
 * 一条探活的读数。`ok: null` = 还没测过（首帧给占位「—」）；失败细分两档，提示语
 * 也跟着分开：`net` = fetch 抛错（浏览器根本没连上本站 —— 不一定是网关挂了，
 * 地址 / 端口不对、跨机访问网络不通都长这样）；`http` = 本站回了非 2xx（进程在
 * 响应，是这个端点没过 —— 与「连不上」是两回事）。
 */
type ProbeOutcome = {
  ok: boolean | null
  /** 本站往返耗时（performance.now 差值四舍五入，毫秒）；只在成功时展示 */
  ms: number
  why: '' | 'net' | 'http'
  /** why === 'http' 时的状态码（net 恒为 0） */
  status: number
  /** 成功响应解出的 JSON（解析失败给 null；探活判定只看 HTTP 状态） */
  body: unknown
}

const IDLE_PROBE: ProbeOutcome = { ok: null, ms: 0, why: '', status: 0, body: null }

/**
 * GET 一个同源端点：网络错误与 HTTP 错误分开报、**永不抛出** —— 探活是页面里最
 * 不该有副作用的一类请求，任何异常都折进读数里。cache: 'no-store'：探活要的是
 * 「此刻的网关」，不是上一刻的缓存。
 */
async function probeGet(url: string): Promise<ProbeOutcome> {
  const started = performance.now()
  try {
    const res = await fetch(url, { cache: 'no-store' })
    const ms = Math.round(performance.now() - started)
    const body = res.ok ? await res.json().catch(() => null) : null
    return { ok: res.ok, ms, why: res.ok ? '' : 'http', status: res.status, body }
  } catch {
    return { ok: false, ms: Math.round(performance.now() - started), why: 'net', status: 0, body: null }
  }
}

/** /v1/models 响应里的 OpenAI 形态 data 数组（缺字段 / 形状不对给 null） */
function modelsArrayOf(body: unknown): unknown[] | null {
  const data = (body as { data?: unknown } | null)?.data
  return Array.isArray(data) ? data : null
}

/** 管理 API 的 `{success, data}` 信封里取 data（形状不对给 null） */
function envelopeData(body: unknown): Record<string, unknown> | null {
  const data = (body as { data?: unknown } | null)?.data
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null
}

/** 探活失败的友好原因（空串 = 没失败 / 还没测）。连不上 ≠ 网关挂了：两种失败分开说 */
function probeError(p: ProbeOutcome): string {
  if (p.ok !== false) return ''
  if (p.why === 'net') return '无法连接本站：网关可能没启动，或地址 / 端口不对；跨机访问时先检查网络'
  return `本站有响应，但这个端点回了 HTTP ${p.status}`
}

/** 三张卡下方的小字说明（失败原因另起一行红字，见 probeError，不混在这句里） */
const GATEWAY_HINT = 'GET /health 不需要鉴权；延迟是浏览器到本站一个来回的耗时'
const MODELS_HINT = '客户端接入的第一步：GET /v1/models 不需要鉴权；没配 Key 时给空清单，也算可用'
const VERSION_HINT = '网关内核的版本号，登录面板后从 GET /api/update/status 读；读不到显示「—」'

/** 面板头问号的说明全文 */
const HEALTH_TIP = '三张卡回答「客户端能不能接」：网关进程探 GET /health、模型清单探 '
  + 'GET /v1/models，两条都不需要鉴权、与页面同源直连；引擎版本要登录面板后才读得到。'
  + '红色不一定是网关挂了 —— 浏览器连不上本站（地址 / 端口 / 网络不通）也会红，'
  + '卡片下方的小字会区分两种情形。'

/** 面板的全部读数：探活结果与两条管理 API 的派生值，一轮检测整体替换一次 */
type HealthSnapshot = {
  /** 检测在途（按钮转圈禁用；卡片保留上一轮读数，按钮自己表达「正在测」） */
  checking: boolean
  gateway: ProbeOutcome
  models: ProbeOutcome
  /** /v1/models 的 data 长度（只在探测成功且形状正确时有效） */
  modelCount: number
  /** 引擎版本号；空串 = 没读到（卡片显示「—」） */
  version: string
  /** /api/storage 的账号 / 请求数；null = 没读到（脚注整段省略） */
  accounts: number | null
  requests: number | null
}

const IDLE_SNAPSHOT: HealthSnapshot = {
  checking: false,
  gateway: IDLE_PROBE,
  models: IDLE_PROBE,
  modelCount: 0,
  version: '',
  accounts: null,
  requests: null,
}

/** 状态卡的色调：ok 绿 / bad 红 / info 靛（版本读到了）/ idle 灰（还没测过）。
 *  全部取自 tokens 语义色，深浅主题自适应 —— 卡片里没有一处写死颜色 */
type CardTone = 'ok' | 'bad' | 'info' | 'idle'

const DOT_COLOR: Record<CardTone, string> = {
  ok: 'var(--ok)',
  bad: 'var(--danger)',
  info: 'var(--info)',
  idle: 'var(--text-3)',
}

const VALUE_COLOR: Record<CardTone, string> = {
  ok: 'var(--ok)',
  bad: 'var(--danger)',
  info: 'var(--text)',
  idle: 'var(--text-3)',
}

/**
 * 一张状态卡：上排「圆点 + 名字」，中排大字读数，下排小字说明（失败再补一行红字）。
 * 卡身用 .ep-group / 代码块同款的做法：--surface-inset 抬一层 + --hairline 描边，
 * 与面板内其它「凹下去的小块」视觉同族。
 */
function HealthCard({ name, tone, value, hint, error }: {
  name: string
  tone: CardTone
  value: string
  hint: string
  error: string
}) {
  return (
    <div className='min-w-[176px] flex-1 rounded-[var(--r-sm)] border border-[var(--hairline)] bg-[var(--surface-inset)] p-[12px]'>
      <div className='flex items-center gap-[7px]'>
        <span aria-hidden className='size-[8px] shrink-0 rounded-full' style={{ background: DOT_COLOR[tone] }} />
        <span className='text-[12.5px] font-semibold'>{name}</span>
      </div>
      <div className='mt-[7px] text-[15px] font-semibold leading-[1.4]' style={{ color: VALUE_COLOR[tone] }}>
        {value}
      </div>
      {error ? (
        <div className='mt-[5px] text-[11.5px] leading-[1.55]' style={{ color: 'var(--danger)' }}>{error}</div>
      ) : null}
      <div className='mt-[5px] text-[11.5px] leading-[1.55] muted'>{hint}</div>
    </div>
  )
}

function HealthPanel() {
  const [snap, setSnap] = useState<HealthSnapshot>(IDLE_SNAPSHOT)
  // 「一次只测一轮」的闸：按钮在 checking 时本来就禁用，这道闸主要挡「快速来回
  // 切页」时 MutationObserver 连环触发的自动检测 —— 后到的直接让路，在途那轮的
  // 结果照样落地
  const busyRef = useRef(false)

  const check = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setSnap(prev => ({ ...prev, checking: true }))
    // 四个读数互不依赖、失败互不拖累，并发打出去（探活函数自己不抛）。两个管理
    // API 未登录会 401：probeGet 只看 HTTP 状态，401 的 body 是 null，版本回落
    // 「—」、脚注省略 —— 登录态的缺失不该被画成「网关不健康」。
    const [gateway, models, updateStatus, storage] = await Promise.all([
      probeGet('/health'),
      probeGet('/v1/models'),
      probeGet('/api/update/status'),
      probeGet('/api/storage'),
    ])
    const version = String(envelopeData(updateStatus.body)?.currentVersion || '').trim()
    // /api/storage 的读数住在 data.database 小节里（账户数 / 累计请求数），形状
    // 由 storage_api.rs 定；形状不对时 Number() 给 NaN，下面统一按「没读到」处理
    const database = envelopeData(storage.body)?.database as Record<string, unknown> | undefined
    const accounts = Number(database?.accounts)
    const requests = Number(database?.requests)
    setSnap({
      checking: false,
      gateway,
      models,
      modelCount: modelsArrayOf(models.body)?.length ?? 0,
      version,
      accounts: Number.isFinite(accounts) ? accounts : null,
      requests: Number.isFinite(requests) ? requests : null,
    })
    busyRef.current = false
  }, [])

  // 进页面自动检测一轮：信号与理由见文件头「网关健康」一节。check 有 busyRef
  // 挡重复，快速来回切页不会叠出多轮请求。
  useEffect(() => {
    const section = document.querySelector('.page[data-page="docs"]')
    if (!section) return
    if (section.classList.contains('active')) void check()
    const observer = new MutationObserver(() => {
      if (section.classList.contains('active')) void check()
    })
    observer.observe(section, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [check])

  const gatewayValue = snap.gateway.ok === true
    ? (snap.gateway.ms > 0 ? `运行中 · ${snap.gateway.ms} ms` : '运行中')
    : snap.gateway.ok === false ? '不可达' : '—'
  const modelsValue = snap.models.ok === true
    ? `可用 · ${snap.modelCount} 个模型`
    : snap.models.ok === false ? '不可用' : '—'

  return (
    <section className='panel ep-panel'>
      <div className='panel-head'>
        <h2>网关健康</h2>
        <span className='tip-q' tabIndex={0} aria-label='网关健康面板说明' data-tip={HEALTH_TIP}></span>
        <div className='head-actions'>
          <Button variant='outline' size='sm' disabled={snap.checking} onClick={() => void check()}>
            {snap.checking ? (<><Spinner className='size-3.5' />检测中…</>) : '重新检测'}
          </Button>
        </div>
      </div>
      <div className='ep-list'>
        {/* 三张卡横排；窗口放不下时 flex-wrap 整卡落到下一行，不压扁读数 */}
        <div className='flex flex-wrap gap-[10px] px-[16px] py-[14px]'>
          <HealthCard
            name='网关进程'
            tone={snap.gateway.ok === true ? 'ok' : snap.gateway.ok === false ? 'bad' : 'idle'}
            value={gatewayValue}
            hint={GATEWAY_HINT}
            error={probeError(snap.gateway)}
          />
          <HealthCard
            name='模型清单'
            tone={snap.models.ok === true ? 'ok' : snap.models.ok === false ? 'bad' : 'idle'}
            value={modelsValue}
            hint={MODELS_HINT}
            error={probeError(snap.models)}
          />
          <HealthCard
            name='引擎版本'
            tone={snap.version ? 'info' : 'idle'}
            value={snap.version || '—'}
            hint={VERSION_HINT}
            error=''
          />
        </div>
      </div>
      <div className='panel-foot'>
        <span>
          {'探活请求不带鉴权头、与页面同源；探活只看 HTTP 状态 —— '}
          <code>{'{"status":"ok"}'}</code>
          {' 或空模型清单同样算通过。'}
        </span>
        {snap.accounts !== null ? (
          <span>{`账号池 ${snap.accounts} 个账号 · 累计请求 ${snap.requests ?? 0} 次`}</span>
        ) : null}
      </div>
    </section>
  )
}

/* ─── 页面 ─────────────────────────────────── */

function DocsPage() {
  return (
    <>
      <section className='panel ep-panel'>
      <div className='panel-head'>
        <h2>接口地址</h2>
        <span className='tip-q' tabIndex={0} aria-label='客户端快速接入说明' data-tip={PANEL_TIP}></span>
      </div>
      {/* 对话协议三种并列写出：客户端按自己支持的那种选一行填，三家共用同一套模型与账号池
          —— 换协议不用换配置 */}
      <div className='ep-list'>
        <EndpointRow id='api-base' name='Base URL' note='填进客户端的「API 地址 / Base URL」' />

        <div className='ep-group'>对话协议（按客户端支持的类型选一行）</div>

        <EndpointRow id='api-chat' name='OpenAI Chat Completions' note='多数 OpenAI 兼容客户端的默认协议' />
        <EndpointRow id='api-responses' name='OpenAI Responses' note='OpenAI 新协议（Codex、新版 SDK）' />
        <EndpointRow id='api-messages' name='Anthropic Messages'
          note='Claude Code / Anthropic SDK（token 计数：/v1/messages/count_tokens）' />

        <div className='ep-group'>模型清单</div>

        <EndpointRow id='api-models' name='模型列表'
          note='客户端自动拉取可用模型；不受鉴权限制，配 Key 之前就能拉' />
      </div>
      {/* 脚注逐字照抄静态 DOM：空格与标点都是原文的一部分，所以每段文本各写一个表达式 ——
          JSX 会把「跨行的文本」折成一个空格，中英混排里那一格空隙很显眼 */}
      <div className='panel-foot'>
        <span>
          {'鉴权用「网关 Key」页里任一'}
          <b>启用</b>
          {'的 Key：请求带 '}
          <code>{'Authorization: Bearer <key>'}</code>
          {' 或 '}
          <code>{'x-api-key: <key>'}</code>
          {'。未配置任何 Key 时：桌面端不鉴权（只监听 127.0.0.1）；服务器 / 远程部署默认拒绝转发（fail-closed），创建第一把 Key 后自动恢复。'}
        </span>
      </div>
    </section>
      <QuickStartPanel />
      <HealthPanel />
    </>
  )
}

/* ─── 挂载：接管 index.html 里既有的页面区块 ─────── */

const PAGE_SELECTOR = '.page[data-page="docs"]'

let mounted = false

/**
 * 把 React root 直接建在页面区块上（不套宿主 div，理由见文件头）。先清掉骨架里的静态子节点
 * （.panel / .panel-head / .ep-list …）：下面按同样的类名重新渲染，留着会与 React 打架。
 */
function mount(): void {
  if (mounted) return
  const section = document.querySelector<HTMLElement>(PAGE_SELECTOR)
  if (!section) return
  mounted = true
  section.replaceChildren()
  // 同步提交（与 login-page / settings-page 同一手法）：bundle 里本文件按字典序
  // 排在 port-panel.tsx 之前，而那边的模块初始化会立刻把接口地址写进下面渲染的
  // 五个 id 元素 —— render() 默认交给调度器异步提交的话，那五笔写入会扑空（元素
  // 还不存在，paint 静默跳过），文档页地址就永远停在占位的「—」。
  flushSync(() => {
    createRoot(section).render(<DocsPage />)
  })
}

// 脚本排在页面骨架之后（index.html 里 islands/ui.js 在各 section 之后），正常直接挂；
// 万一将来被挪到前面，退化成等 DOM 解析完再挂。
if (document.querySelector(PAGE_SELECTOR)) mount()
else document.addEventListener('DOMContentLoaded', mount, { once: true })
