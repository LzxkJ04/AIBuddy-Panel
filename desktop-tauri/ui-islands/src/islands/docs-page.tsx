import { useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Button } from '@ui'

/**
 * 文档页（接口地址）—— React 岛。
 *
 * 替换的是 ui/index.html 里 `<section class="page" data-page="docs">` 那 74 行静态 DOM
 * （接口条 .ep-panel / .ep-list / .ep-row / .ep-group / .panel-foot）。对外**没有任何
 * window 接口**：这一页是纯展示，没有数据、没有交互状态，app.js 切到本页时只调
 * `window.wbPortPanel.sync()`（补一次真实端口），与本岛无关，调用方一行都不用改。
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
        <span className='tip-q'
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

/* ─── 页面 ─────────────────────────────────── */

function DocsPage() {
  return (
    <>
      <section className='panel ep-panel'>
      <div className='panel-head'>
        <h2>接口地址</h2>
        <span className='tip-q' data-tip={PANEL_TIP}></span>
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
