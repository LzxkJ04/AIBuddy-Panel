import * as React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@ui'
import {
  CATEGORIES,
  CONTENT_MAX_KEY,
  LANGUAGES,
  NOTES,
  NOTIFY_READ_KEY,
  PREFS_EVENT,
  PREFS_KEY,
  PREFS_LOCK_ACTIVE_KEY,
  PRIMARY_DEFAULT,
  PRIMARY_PRESETS,
  PROMPT_MODES,
  QUEUE_FIELDS,
  RETENTION_FIELDS,
  RETRY_FIELDS,
  SHELL_CONTENT_WIDTHS,
  SHELL_PAGE_ANIMS,
  SHELL_TAG_LABELS,
  STATES,
  TAGS_HOME,
  TAGS_KEY,
  THEME_EVENT,
  THEME_MODES,
  TIPS,
  TIMEOUT_FIELDS,
  ZOOM_EVENT,
  ZOOM_PERCENTS,
  formatBytes,
  formatCount,
  normalizeShellPrefs,
  openExternal,
  parseInteger,
  readThemeMode,
  readZoomPercent,
  shared,
  toast,
  type GatewayBlocks,
  type NumberField,
  type ShellPrefs,
  type ThemeMode,
} from './settings-model'
import {
  addProviderPrompt,
  addRetryCode,
  applyUnits,
  clearDegrade,
  dropLastRetryCode,
  exportAccounts,
  importAccounts,
  load,
  panelLogout,
  refreshDebug,
  refreshPrompt,
  refreshQueue,
  refreshRetention,
  refreshRetry,
  refreshSanitize,
  refreshStorage,
  refreshTimeouts,
  removeProviderPrompt,
  removeRetryCode,
  renderDebug,
  renderPrompt,
  renderRetention,
  renderRetry,
  renderSanitize,
  renderSettings,
  renderStorage,
  resolveRetentionConfirm,
  restoreCategory,
  saveCaptcha,
  saveDebug,
  savePromptFile,
  savePromptMode,
  saveProviderGatewayPrompt,
  saveProviderPromptFile,
  saveProviderPromptMode,
  saveQueueField,
  saveRetentionField,
  saveRetryField,
  saveSanitize,
  saveTimeoutField,
  saveToggle,
  selectCategory,
  showCategory,
  useSettings,
  type DebugState,
  type LoadStatus,
  type NumericState,
  type PromptState,
  type ProviderPromptOption,
  type ProviderPromptState,
  type SettingsSnapshot,
  type StorageState,
} from './settings-state'
import {
  GatewayTextButton,
  ProviderPromptTextButton,
  PromptTextButton,
  gatewayEditedText,
} from './settings-prompt-editor'

/**
 * Agent2API · 设置页（React 岛）。
 *
 * 替换 ui/settings-panel.js（那份自持状态、按 id 读写 DOM、用 innerHTML 拼导入失败明细的
 * 老实现）。对外接口与原实现**逐字一致**（见文件末尾）：调用点一行都不用改 ——
 * app.js:135 load()、upgrade-panel.js:74 load()、islands/update-panel.tsx:972 showCategory('about')。
 *
 * ── 三块文件的分工 ──────────────────────────
 * settings-page.tsx（本文件）= 视图 + 挂载 + 对外契约；settings-state.ts = 快照 store 与全部
 * 读写流程；settings-model.ts = 桥类型 / 字段表 / 页面文案。后两个是 .ts，不会被
 * `islands/*.tsx` 的 glob 当岛加载 —— 设置页的岛只有本文件一个。
 *
 * ── ⚠ 「更新」分类（原「关于」）的面板不归本文件 ───────────
 * `.settings-pane[data-cat="about"]` 是**另一个岛**（update-panel.tsx）的挂载点：它在模块
 * 加载期就 `document.querySelector('.settings-pane[data-cat="about"]')`，找到才把 React root
 * 建上去。所以这里必须做到两件事：
 *   ① 原样渲染出一个**空的** `<div class="settings-pane" data-cat="about" />` —— 里面一个子
 *      节点都不能放（会被那个岛清掉），React 也不能在后续渲染里动它的 DOM 子树。React 对
 *      「没有 children 的宿主元素」不会去碰它的子节点，所以只要**始终**渲染这个 div、
 *      不给它 children、不改变它在兄弟中的位置，它的内容就一直是那个岛的；
 *   ② 让它在**模块加载期就同步存在于 DOM 里** —— 见 mount() 的注释（flushSync）。
 * 分类切换（`.active`）走 React 的 className：切到「更新」时这个 div 会拿到 active，
 * 那个岛的面板跟着显示，与旧实现命令式切 class 等价。
 *
 * ── 页面骨架照抄 index.html，只换控件 ────────────
 * 布局类名原样保留（`.settings-layout` / `.settings-nav` / `.settings-nav-item` /
 * `.settings-panes` / `.settings-pane` / `.panel` / `.panel-head` / `.panel-body` /
 * `.head-actions` / `.settings-switches` / `.settings-state` / `.retention-list` /
 * `.retention-row` / `.retention-input` / `.unit` / `.hint` / `.retention-note` /
 * `.prompt-input` / `.tag-input` / `.tag-chip` / `.tag-x` / `.storage-line` /
 * `.storage-path` / `.storage-counts` / `.storage-count` / `.danger-zone` / `.io-result`），
 * 它们是这一页的排版而不是「组件」（样式在 ui/css/page-settings.css）。
 * 控件换组件库：原生 input → Input、原生 checkbox → Switch、原生 select → Select 一族、
 * button → Button、`.badge` → Badge、`#retention-modal` → Dialog。
 * 左栏分类项带**图标**（icons.js 里那组描边风格的设置页图标，17px 图标盒与主侧栏
 * 同款）—— 标签因此不再受「两字」限制：图标负责一眼认出、文字负责说清。
 *
 * 三处细节：
 *   · 问号仍用 `[data-tip]`（10 条说明动辄几百字，tooltip.js 的自动增强仍在页面上跑，
 *     含 MutationObserver 接住 React 动态插入的元素）—— 不换成 Tooltip 是刻意的：换了要
 *     把十条长文各包一层组件，观感与行为却完全一样；
 *   · 数字框的宽度 / 居中 / 等宽数字写成工具类：组件库的 Input 自带 `w-full`（工具类带
 *     !important），page-settings.css 里 `.retention-input input[type="number"]` 的 92px
 *     只保得住 max-width，宽度得自己带（与任务面板的间隔框同一处理）；
 *   · 显隐一律**条件渲染**，不写 hidden / style.display —— 组件库的 Tailwind 工具类分层且
 *     带 !important，会压掉 tokens.css 里未分层的 `[hidden]{display:none!important}`。
 */

/* ─── 小组件 ───────────────────────────────── */

/**
 * 图标（icons.js 的内联 SVG 串）：整站共用一份图标集，这里只做注入。
 * 图标在 set（左栏分类）里都已存在于 icons.js；取不到时返回空串（图标位留空，
 * 不影响文字与点击 —— 按名字取不到是开发期错误，不该把页面弄崩）。
 */
function iconHtml(name: string, size: number): string {
  return shared().wbIcons?.icon?.(name, size) || ''
}

/** 三态徽章：`.badge`（检测中…）/ `.badge.ok` / `.badge.bad` → Badge 的 variant */
function StatusBadge({ tone, children }: { tone: 'idle' | 'ok' | 'bad'; children: React.ReactNode }) {
  const variant = tone === 'ok' ? 'success' : tone === 'bad' ? 'destructive' : 'outline'
  return <Badge variant={variant}>{children}</Badge>
}

type PanelHeadProps = {
  title: string
  /** 标题右侧问号的说明全文（沿用 `[data-tip]`） */
  tip?: string
  badge?: React.ReactNode
  actions?: React.ReactNode
}

/** 面板标题栏：标题 + 问号 + 徽章 + 右侧操作（DOM 顺序与静态骨架一致） */
function PanelHead({ title, tip, badge, actions }: PanelHeadProps) {
  return (
    <div className='panel-head'>
      <h2>{title}</h2>
      {tip ? <span className='tip-q' data-tip={tip}></span> : null}
      {badge}
      {actions ? <div className='head-actions'>{actions}</div> : null}
    </div>
  )
}

type SwitchRowProps = {
  id: string
  label: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (next: boolean) => void
}

/**
 * 一行开关。开关与文字同在一个 `<label class="switch">` 里（与旧模板同构）：Base UI 的
 * Switch 会渲染一个隐藏 checkbox，label 的原生激活行为照样把点击转给它 —— 点文字也能拨动。
 */
function SwitchRow({ id, label, checked, disabled, onCheckedChange }: SwitchRowProps) {
  return (
    <label className='switch'>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={next => onCheckedChange(next)} />
      <span>{label}</span>
    </label>
  )
}

type NumberRowProps = {
  field: NumberField
  /** 生效值；null = 没读到（输入框保持禁用，旧实现同） */
  value: number | null
  /** 面板忙碌（提交在途）：本次操作期间禁用，与旧实现置 DOM disabled 等价 */
  disabled: boolean
  onCommit: (raw: string) => Promise<void>
}

/**
 * 一行数字设置（保留期 / 重试 / 超时共用）。
 *
 * 未提交的编辑是**本组件的草稿**：聚焦时把生效值抄进草稿，失焦 / 回车提交，提交结束
 * （无论成败）把草稿收掉、显示回到生效值 —— 这就是旧实现那套「正在编辑的那一项不回填 +
 * 失败回滚 + 保存后按后端值规范化」的等价物，只是状态只存在于这一处。
 */
function NumberRow({ field, value, disabled, onCommit }: NumberRowProps) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const text = draft !== null ? draft : value === null ? '' : String(value)

  async function commit(): Promise<void> {
    const raw = draft
    if (raw === null) return
    try { await onCommit(raw) } finally { setDraft(null) }
  }

  return (
    <div className='retention-row'>
      <label htmlFor={field.id}>{field.label}</label>
      <span className='retention-input'>
        <Input
          id={field.id}
          type='number'
          min={field.min}
          max={field.max}
          step={1}
          inputMode='numeric'
          className='w-[92px] max-w-[92px] text-center tabular-nums'
          value={text}
          disabled={disabled || value === null}
          onChange={event => setDraft(event.target.value)}
          onFocus={() => setDraft(String(value ?? ''))}
          onBlur={() => void commit()}
          // 回车等价于「失焦提交」：不同内核里 Enter 是否派发 change 并不一致，
          // 这里主动 blur 一次把它统一成「值已提交」这一条路径
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
        />
        <span className='unit'>{field.unit}</span>
      </span>
      <div className='hint'>{field.hint}</div>
    </div>
  )
}

/** 数字面板的徽章：首屏「检测中…」、读到「已生效」、读不到「不可用」 */
function numericBadge(state: NumericState): React.ReactNode {
  if (state.status === 'ready') return <StatusBadge tone='ok'>已生效</StatusBadge>
  if (state.status === 'unavailable') return <StatusBadge tone='bad'>不可用</StatusBadge>
  return <StatusBadge tone='idle'>检测中…</StatusBadge>
}

/** 刷新按钮（无修饰的 button → Button 的 outline 档，与静态骨架的观感一致） */
function RefreshButton({ id, onClick }: { id: string; onClick: () => void }) {
  return <Button id={id} variant='outline' onClick={onClick}>刷新</Button>
}

/* ─── 通用分类 ─────────────────────────────── */

function GeneralPane({ snap }: { snap: SettingsSnapshot }) {
  const app = snap.app
  const appState = app.status === 'unavailable'
    ? STATES.appUnavailable
    : app.status === 'loading'
      ? STATES.appLoading
      : app.closeToTray ? STATES.appTrayOn : STATES.appTrayOff

  return (
    <>
      <section className='panel'>
        <PanelHead
          title='启动与托盘'
          tip={TIPS.tray}
          badge={app.status === 'ready'
            ? <StatusBadge tone='ok'>已应用</StatusBadge>
            : app.status === 'unavailable'
              ? <StatusBadge tone='bad'>不可用</StatusBadge>
              : <StatusBadge tone='idle'>检测中…</StatusBadge>}
        />
        <div className='panel-body'>
          <div className='settings-switches'>
            {/* 主进程没返回启动设置时开关仍可拨（照旧实现）：拨了直接发全量 patch，
                保存成功即回到「已应用」，不必让用户重开程序 */}
            <SwitchRow
              id='settings-close-to-tray'
              label='关闭窗口时最小化到托盘'
              checked={app.closeToTray}
              disabled={snap.busy === 'app'}
              onCheckedChange={next => void saveToggle('tray', next)}
            />
            <SwitchRow
              id='settings-autostart'
              label='开机自动启动'
              checked={app.autostart}
              disabled={snap.busy === 'app'}
              onCheckedChange={next => void saveToggle('autostart', next)}
            />
          </div>
          <div className='settings-state'>{appState}</div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='计量单位' tip={TIPS.units} />
        <div className='panel-body'>
          <div className='settings-switches'>
            <SwitchRow
              id='settings-chinese-units'
              label='使用中文单位（亿 / 万）'
              checked={snap.unitsChinese}
              onCheckedChange={applyUnits}
            />
          </div>
          <div className='settings-state'>
            {snap.unitsChinese ? STATES.unitsOn : STATES.unitsOff}
          </div>
        </div>
      </section>
    </>
  )
}

/* ─── 显示分类 ─────────────────────────────── */

/** 显示模式三档的状态行文案（三条文案在 settings-model 的 STATES 里） */
function themeStateText(mode: ThemeMode): string {
  if (mode === 'light') return STATES.themeLight
  if (mode === 'dark') return STATES.themeDark
  return STATES.themeSystem
}

/**
 * 显示分类：显示模式 / 界面缩放 / 语言。
 *
 * 三项都是**纯前端偏好** —— 与后端配置无关，所以不参与 settings-state 的 load
 * （那边一次并行取全部后端设置），这里自己持两个受控值就够了。
 *
 * 主题与缩放的**唯一应用入口都在 app.js**（见 settings-model 的显示偏好一节）：
 * 这里改完只调 wbApp.applyTheme / applyZoom，再靠 'wb:theme' / 'wb:zoom' 事件
 * 跟随 —— 侧边栏底部的主题三键是同一个设置的另一个入口，两边必须互相同步；
 * 谁也不去读对方的状态，只认事件里带的新值。
 *
 * 网页端：主题照常可用（data-theme 是纯 CSS 生效，窗口主题在 shim 里是空实现）；
 * 界面缩放禁用 —— 浏览器里的缩放归浏览器自己的 Ctrl +/- 管。
 */
function DisplayPane() {
  const [theme, setTheme] = React.useState<ThemeMode>(readThemeMode)
  const [zoom, setZoom] = React.useState<number>(readZoomPercent)
  // 端别取自桥（platform）而不是 navigator：与设置页其它端别判断同一口径
  const isWeb = shared().workbuddyDesktop?.platform === 'web'

  // 跟随别人的改动（侧边栏三键、index.html 头部内联脚本的抢先应用、或本页自身）：
  // 事件里带着新值，直接采纳，不必回头读 localStorage
  React.useEffect(() => {
    const onTheme = (event: Event) => setTheme(String((event as CustomEvent).detail || 'system') as ThemeMode)
    const onZoom = (event: Event) => setZoom(Number((event as CustomEvent).detail) || 100)
    window.addEventListener(THEME_EVENT, onTheme)
    window.addEventListener(ZOOM_EVENT, onZoom)
    return () => {
      window.removeEventListener(THEME_EVENT, onTheme)
      window.removeEventListener(ZOOM_EVENT, onZoom)
    }
  }, [])

  const zoomLabel = zoom === 100 ? '100%（默认）' : `${zoom}%`
  const language = LANGUAGES[0]

  return (
    <>
      <section className='panel'>
        <PanelHead title='显示模式' tip={TIPS.displayTheme} />
        <div className='panel-body'>
          <div>
            <SegmentedControl<ThemeMode>
              aria-label='显示模式'
              options={THEME_MODES}
              value={theme}
              onValueChange={next => shared().wbApp?.applyTheme?.(next)}
            />
          </div>
          <div className='settings-state'>{themeStateText(theme)}</div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='界面缩放' tip={TIPS.displayZoom} />
        <div className='panel-body'>
          <div className='retention-list'>
            <div className='retention-row'>
              <label htmlFor='settings-zoom'>缩放比例</label>
              <span className='prompt-input'>
                {/* 档位是 80%–130% 的 11 个定值，用下拉而不是滑块：每一档都要能精确
                    复述（用户问「我现在多少」时答案是个整数），且组件库目前没有 Slider。
                    展示文案显式给 SelectValue，不依赖 value 自动显示。 */}
                <Select
                  value={String(zoom)}
                  onValueChange={next => shared().wbApp?.applyZoom?.(Number(next))}
                >
                  <SelectTrigger
                    id='settings-zoom'
                    className='w-[140px]'
                    disabled={isWeb}
                    aria-label='界面缩放比例'
                  >
                    <SelectValue>{zoomLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ZOOM_PERCENTS.map(percent => (
                      <SelectItem key={percent} value={String(percent)}>
                        {percent === 100 ? '100%（默认）' : `${percent}%`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </span>
              <div className='hint'>
                放大或缩小整个界面（文字与控件一起变），效果与浏览器 Ctrl +/- 相同：
                共 11 档，立即生效并记住。
              </div>
            </div>
          </div>
          <div className='settings-state'>
            {isWeb ? STATES.zoomWeb : zoom === 100 ? STATES.zoomDefault : `当前按 ${zoom}% 显示。`}
          </div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='语言设置' tip={TIPS.displayLanguage} />
        <div className='panel-body'>
          <div className='settings-switches'>
            {/* 单选项而不是下拉：语种少的时候一眼看得见全部可选、选中的也一目了然。
                目前只有一项 —— 选中它就是「当前语言」，改不动任何东西；等真有了第二种
                语言，这里会自己长出第二行（表在 settings-model 的 LANGUAGES）。 */}
            <RadioGroup value={language.value} onValueChange={() => {}}>
              <Label className='flex cursor-pointer items-center gap-2 text-[12.5px] font-medium'>
                <RadioGroupItem value={language.value} />
                {language.label}
              </Label>
            </RadioGroup>
          </div>
          <div className='settings-state'>{STATES.languageOnly}</div>
        </div>
      </section>

      <PagePrefsSection />
    </>
  )
}

/* ─── 页面偏好（本浏览器的界面默认值，localStorage 持久化）────────── */

type PrefOption = { value: string; label: string }

/** 各页自身在用的持久化键与合法值 —— 改这里等于改「下次打开的默认值」 */
const PREF_PAGE_KEY = 'workbuddy-desktop-page'
const PREF_PAGES: PrefOption[] = [
  { value: 'overview', label: '报表' },
  { value: 'accounts', label: '账号' },
  { value: 'gateway', label: '模型管理' },
  { value: 'proxies', label: '网络代理' },
  { value: 'keys', label: '网关 Key' },
  { value: 'docs', label: '文档' },
  { value: 'requests', label: '请求日志' },
  { value: 'logs', label: '日志' },
  { value: 'tasks', label: '定时任务' },
  { value: 'settings', label: '设置' },
]
const PREF_REPORT_KEY = 'workbuddy-desktop-report-range'
const PREF_REPORTS: PrefOption[] = [
  { value: 'today', label: '今天' },
  { value: '7', label: '近 7 天（默认）' },
  { value: '30', label: '近 30 天' },
  { value: 'month', label: '本月' },
  { value: 'all', label: '全部' },
]
const PREF_REQ_KEY = 'workbuddy-desktop-logs-requests-range'
const PREF_REQS: PrefOption[] = [
  { value: 'today', label: '今天' },
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: 'month', label: '本月' },
  { value: 'all', label: '全部（默认）' },
]
const PREF_DOCS_KEY = 'aibuddy-docs-client'
const PREF_DOCS: PrefOption[] = [
  { value: 'curl', label: 'curl（默认）' },
  { value: 'python', label: 'Python SDK' },
  { value: 'node', label: 'Node.js SDK' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex CLI' },
]

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存储不可用只影响下次打开，不影响本次会话
  }
}

function PrefSelect({ id, label, hint, options, value, onChange }: {
  id: string
  label: string
  hint: string
  options: PrefOption[]
  value: string
  onChange: (next: string) => void
}) {
  return (
    <div className='retention-row'>
      <label htmlFor={id}>{label}</label>
      <span className='storage-line'>
        <Select value={value} onValueChange={next => onChange(String(next))}>
          <SelectTrigger id={id} className='w-[220px]'>
            <SelectValue>{options.find(item => item.value === value)?.label || value}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map(item => (
              <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
      <div className='hint'>{hint}</div>
    </div>
  )
}

function PagePrefsSection() {
  const [page, setPage] = React.useState(() => readPref(PREF_PAGE_KEY, 'overview'))
  const [report, setReport] = React.useState(() => readPref(PREF_REPORT_KEY, '7'))
  const [req, setReq] = React.useState(() => readPref(PREF_REQ_KEY, 'all'))
  const [docs, setDocs] = React.useState(() => readPref(PREF_DOCS_KEY, 'curl'))
  const change = (key: string, setter: (next: string) => void) => (next: string) => {
    setter(next)
    writePref(key, next)
    dataToast('✅ 已保存，下次打开面板生效', 'ok')
  }
  return (
    <section className='panel'>
      <PanelHead title='页面偏好' tip={NOTES.pagePrefs} />
      <div className='panel-body'>
        <div className='retention-list'>
          <PrefSelect
            id='pref-default-page'
            label='打开面板时默认停留在'
            hint='「报表」是内置默认；切到某页后本页通常会记住（这里改的是没有记忆时的兜底值）。'
            options={PREF_PAGES}
            value={page}
            onChange={change(PREF_PAGE_KEY, setPage)}
          />
          <PrefSelect
            id='pref-report-range'
            label='报表默认时间范围'
            hint='报表页统计概览、热力图与趋势图的初始范围；页内随时可临时切换。'
            options={PREF_REPORTS}
            value={report}
            onChange={change(PREF_REPORT_KEY, setReport)}
          />
          <PrefSelect
            id='pref-requests-range'
            label='请求日志默认时间范围'
            hint='请求日志页打开时的初始筛选档位；翻页与筛选不会重置它。'
            options={PREF_REQS}
            value={req}
            onChange={change(PREF_REQ_KEY, setReq)}
          />
          <PrefSelect
            id='pref-docs-client'
            label='文档页默认客户端'
            hint='「文档」页快速接入生成器初始展开的客户端片段。'
            options={PREF_DOCS}
            value={docs}
            onChange={change(PREF_DOCS_KEY, setDocs)}
          />
        </div>
        <div className='hint'>{NOTES.pagePrefs}</div>
      </div>
    </section>
  )
}

/* ─── 网关分类 ─────────────────────────────── */

/** 「指定错误码直接换号」的标签输入（GitHub Topics 同款：徽章 + 行内输入框） */
function RetryCodesField({ codes, status, busy }: {
  codes: number[] | null
  status: LoadStatus
  busy: boolean
}) {
  const [text, setText] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  // 读不到重试设置时整框禁用（旧实现：field.disabled + .disabled 类 + 占位符换「—」）
  const locked = status === 'unavailable'

  return (
    <div className='retention-row'>
      <label htmlFor='settings-retry-no-codes-input'>指定错误码直接换号</label>
      <div className='retention-input'>
        {/* 点框体空白处 = 聚焦输入框（整框是一个输入控件的观感，旧实现同） */}
        <div
          className={locked ? 'tag-input disabled' : 'tag-input'}
          onClick={() => inputRef.current?.focus()}
        >
          {(codes || []).map(code => (
            <span className='tag-chip' key={code}>
              <span className='v'>{code}</span>
              {/* 徽章上的 ✕：小号圆角热区，悬停加深 —— 用组件库的小件档 + 语义色，
                  「能点删」的视觉暗示与旧实现一致 */}
              <Button
                type='button'
                variant='ghost'
                size='icon-2xs'
                className='tag-x text-muted-foreground hover:bg-destructive-soft hover:text-destructive'
                title={`删除 ${code}`}
                aria-label={`删除状态码 ${code}`}
                onClick={event => { event.stopPropagation(); void removeRetryCode(code) }}
              >
                ✕
              </Button>
            </span>
          ))}
          <Input
            ref={inputRef}
            id='settings-retry-no-codes-input'
            type='text'
            // 框的描边由外层 .tag-input 出，这里把组件库 Input 的边框 / 底色 / 内边距
            // 用工具类压平（.tag-input-field 的老规则是非分层的，压不过工具类）
            className='tag-input-field h-auto border-0 bg-transparent px-0 shadow-none focus:shadow-none'
            placeholder={locked ? '—' : '输入状态码，回车添加'}
            inputMode='numeric'
            autoComplete='off'
            value={text}
            disabled={locked || busy}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void addRetryCode(text)
                setText('') // 提交后立即清空输入框（旧实现同）
                return
              }
              // 与 GitHub Topics 一致：输入框为空时退格删掉最后一枚
              if (event.key === 'Backspace' && !text) void dropLastRetryCode()
            }}
          />
        </div>
      </div>
      <div className='hint'>{NOTES.retryCodes}</div>
    </div>
  )
}

/** 系统提示词：文件路径输入框（草稿机制与数字框同款，失焦 / 回车才提交） */
function PromptFileRow({ prompt, locked, busy }: {
  prompt: PromptState
  locked: boolean
  busy: boolean
}) {
  const [draft, setDraft] = React.useState<string | null>(null)

  async function commit(): Promise<void> {
    const raw = draft
    if (raw === null) return
    try { await savePromptFile(raw) } finally { setDraft(null) }
  }

  return (
    <div className='retention-row'>
      <label htmlFor='settings-prompt-file'>提示词文件</label>
      <span className='prompt-input'>
        <Input
          id='settings-prompt-file'
          type='text'
          placeholder='留空 = 用内置默认提示词'
          value={draft !== null ? draft : prompt.file}
          disabled={locked || busy}
          onChange={event => setDraft(event.target.value)}
          onFocus={() => setDraft(prompt.file)}
          onBlur={() => void commit()}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
        />
      </span>
      <div className='hint'>{NOTES.promptFile}</div>
    </div>
  )
}

/** 提示词状态行：模式说明 + 来源与行数 + 文件读取告警 */
function promptStateText(prompt: PromptState): string {
  if (prompt.status === 'loading') return STATES.appLoading
  if (prompt.status === 'unavailable') return STATES.promptUnavailable
  const source = promptSourceText(prompt.source)
  const parts: string[] = []
  if (prompt.mode === 'passthrough') {
    parts.push('客户端 system 原样出站（只靠指纹脱敏改写模板句）。')
  } else {
    parts.push(
      `${prompt.mode === 'custom' ? '替换' : '追加'}生效：上游收到的 system 来自${source}`
      + `${prompt.lines ? `（${prompt.lines} 行）` : ''}。`,
    )
  }
  if (prompt.fileError) parts.push(`⚠️ ${prompt.fileError}`)
  return parts.join('')
}

/** 正文来源的中文说法（三处状态行共用；'' = 没有正文可讲） */
function promptSourceText(source: string): string {
  if (source === 'inline') return '界面里编辑的正文'
  if (source === 'file') return '提示词文件'
  if (source === 'builtin') return '内置默认提示词'
  return ''
}

/** 降级行的说明：只在真的处于降级期时出现（平时它是一行与用户无关的状态噪音） */
function degradeHint(prompt: PromptState): string {
  return '已自动切换到最小中性提示词（撞了上游内容拦截，多半是 system 指纹误报），'
    + `到 ${prompt.degradeUntilText || STATES.degradeUntilFallback} 自动解除。`
    + '期间本模式自己的提示词不会发出；把提示词改好后可以立即解除。'
}

/**
 * 提示词文件输入框（草稿机制与上面那个全局的同款，按 id 提交到对应那一家）
 */
function ProviderFileRow({ item, label, locked, busy }: {
  item: ProviderPromptState
  label: string
  locked: boolean
  busy: boolean
}) {
  const [draft, setDraft] = React.useState<string | null>(null)

  async function commit(): Promise<void> {
    const raw = draft
    if (raw === null) return
    try {
      // 只在与「显示值」真的不同时才提交：这一行可能是「跟随全局」的（显示的是
      // 全局那两份），点进去再点出来不该凭空生成一条覆盖
      if (raw !== item.file) await saveProviderPromptFile(item, raw)
    } finally { setDraft(null) }
  }

  return (
    <span className='prompt-input'>
      <Input
        id={`settings-prompt-file-${item.id}`}
        type='text'
        placeholder='留空 = 用内置默认提示词'
        aria-label={`${label} 提示词文件`}
        value={draft !== null ? draft : item.file}
        disabled={locked || busy}
        onChange={event => setDraft(event.target.value)}
        onFocus={() => setDraft(item.file)}
        onBlur={() => void commit()}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
      />
    </span>
  )
}

/** 一家的状态行：模式说明 + 来源与行数 + 文件读取告警（与全局那行同一套措辞） */
function providerStateText(item: ProviderPromptState, configured: boolean): string {
  // 没单独配过的家（只在「有网关自带提示词」时才会被列出来）走全局那份 ——
  // 不说这一句的话，用户会以为这一行显示的就是「这家的设置」
  if (!configured) return `未单独配置：模式、提示词文件与正文都跟随上面的全局配置（当前「${PROMPT_MODES.find(option => option.value === item.mode)?.toastLabel ?? item.mode}」）。`
  if (item.mode === 'passthrough') return '客户端 system 原样出站。'
  const head = `${item.mode === 'custom' ? '替换' : '追加'}生效：上游收到的 system 来自${promptSourceText(item.source)}`
    + `${item.lines ? `（${item.lines} 行）` : ''}。`
  return item.fileError ? `${head} ⚠️ ${item.fileError}` : head
}

/**
 * 一家的**网关自带提示词**那一行（只有 registry 里标了 `gatewayNote` 的家才有）。
 *
 * 这段文本不来自客户端、也不来自提示词文件，是网关自己装上去的（ZCode 活动套餐
 * 通道的官方三段身份块）。它默认开、可以关，**也可以改正文** —— 关掉后还能不能跑
 * 取决于上游当前的校验口径，所以关掉时把这一行**换成警示语气**（`tone` 为非 ok
 * 的徽章 + 粗体），而不是留一个看起来无害的灰开关。
 */
function ProviderGatewayRow({ item, option, over, locked, busy }: {
  item: ProviderPromptState
  option: ProviderPromptOption
  /** 这一家已存的正文覆盖（只含改过的段；缺省 = 全是官方原文） */
  over: GatewayBlocks | undefined
  locked: boolean
  busy: boolean
}) {
  const on = item.gateway
  const chars = option.gatewayChars
  const size = chars ? `约 ${chars.toLocaleString('zh-CN')} 字符` : '一段内置装配'
  const edited = gatewayEditedText(over)
  return (
    <div className='retention-row'>
      <label className='prompt-gateway-label'>网关自带</label>
      <span className='prompt-input'>
        <SwitchRow
          id={`settings-prompt-gateway-${item.id}`}
          label={`装上${size}的官方身份提示词`}
          checked={on}
          disabled={locked || busy}
          onCheckedChange={next => void saveProviderGatewayPrompt(item.id, next)}
        />
        {/* 正文编辑与开关并排：两件事（装不装 / 长什么样）在同一个可视范围里，
            但各走各的接口字段，改一个不会动另一个（见 settings-state 两个动作） */}
        <GatewayTextButton item={item} option={option} over={over} locked={locked} busy={busy} />
      </span>
      <div className={on ? 'hint' : 'hint prompt-gateway-off'}>
        {on ? option.gatewayNote : `已关闭。${option.gatewayNote}`}
        {edited ? ` 正文已改：${edited}（其余段用官方原文）。` : ''}
      </div>
    </div>
  )
}

/**
 * 「按提供商配置」区块：列**两类**家 ——
 *
 *   1. 注册表里带 `gatewayNote` 的家（有网关自带提示词可拨开关）——**默认就列**，
 *      不需要先去「添加提供商…」：一个开关藏在添加动作后面等于没有；
 *   2. 用户单独配过模式 / 文件的家（`promptProviders` 里有的）。
 *
 * 第 1 类即使没有 `promptProviders` 项也要出现在列表里，所以这里合成一行
 * （模式 / 文件取全局默认值：`prompt` 自己那两份）。用户一动这个模式 / 文件，
 * 后端就会为它落一条显式覆盖 —— 这正是「从默认值开始配」的自然路径。
 */
function ProviderPromptRows({ prompt, locked, busy }: {
  prompt: PromptState
  locked: boolean
  busy: boolean
}) {
  const options = prompt.options
  const configured = new Map(prompt.providers.map(item => [item.id, item]))
  // 顺序：先按注册表顺序列出带开关的家，再补齐用户配过、但注册表里没标开关的家
  // （自定义提供商不会出现在 options 里，它们只能靠 promptProviders 出现）
  const rows: ProviderPromptState[] = []
  for (const option of options) {
    if (!option.gatewayNote) continue
    rows.push(configured.get(option.id) ?? {
      id: option.id,
      // 没单独配过的行显示**生效值**（= 全局那份）：界面上一眼看不出「这行是不是
      // 自己配过」，但显示的值必须是真的，否则「跟随默认」这句话就是空话
      mode: prompt.mode,
      // 显示**生效值**（= 全局那份）：这一行的模式 / 文件 / 正文都跟随全局，
      // 输入框与编辑器里给出真实的那份；改动任何一个控件时会把当前显示的这几个值
      // 一起落成这一家自己的覆盖（见 saveProviderPromptMode 的说明），
      // 所以「只改模式」不会把全局的提示词文件弄丢
      file: prompt.file,
      text: prompt.text,
      source: prompt.source,
      lines: prompt.lines,
      fileError: prompt.fileError,
      gateway: prompt.gateway[option.id] ?? true,
      configured: false,
    })
  }
  for (const item of prompt.providers) {
    if (rows.some(row => row.id === item.id)) continue
    rows.push({ ...item, gateway: prompt.gateway[item.id] ?? true, configured: true })
  }
  const listed = new Set(rows.map(row => row.id))
  const candidates = options.filter(item => !item.gatewayNote && !listed.has(item.id))
  const [pending, setPending] = React.useState('')
  const labelOf = (id: string) => options.find(item => item.id === id)?.label || id
  const optionOf = (id: string) => options.find(item => item.id === id)
  const noteOf = (id: string) => optionOf(id)?.gatewayNote || ''

  return (
    <>
      {rows.map(item => {
        const label = labelOf(item.id)
        const modeLabel = PROMPT_MODES.find(option => option.value === item.mode)?.optionLabel ?? item.mode
        const note = noteOf(item.id)
        const option = optionOf(item.id)
        return (
          <React.Fragment key={item.id}>
            <div className='retention-row'>
              <label htmlFor={`settings-prompt-mode-${item.id}`}>{label}</label>
              <span className='prompt-input'>
                <Select
                  value={item.mode}
                  onValueChange={next => {
                    // 同上：null = 没选（清空 / 取消），不是一个叫 "null" 的模式。
                    // 模式与文件一起提交：这一行可能还在「跟随全局」，只写模式会让
                    // 它的文件从屏幕上的路径变成内置默认（见 saveProviderPromptMode）
                    if (next != null && String(next)) {
                      void saveProviderPromptMode(item, String(next))
                    }
                  }}
                >
                  <SelectTrigger
                    id={`settings-prompt-mode-${item.id}`}
                    className='w-[240px]'
                    disabled={locked || busy}
                    aria-label={`${label} 的提示词模式`}
                  >
                    <SelectValue>{modeLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {PROMPT_MODES.map(option => (
                      <SelectItem key={option.value} value={option.value}>{option.optionLabel}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ProviderFileRow item={item} label={label} locked={locked} busy={busy} />
                <ProviderPromptTextButton item={item} label={label} locked={locked} busy={busy} />
                {/* 「跟随默认」只在**单独配过**的行上出现：没配过的行点了它也删不掉
                    任何东西（后端此时没有这一项），留一颗无效按钮只会让人以为点坏了 */}
                {item.configured ? (
                  <Button
                    variant='outline'
                    disabled={locked || busy}
                    onClick={() => void removeProviderPrompt(item.id)}
                  >
                    跟随默认
                  </Button>
                ) : null}
              </span>
              <div className='hint'>{providerStateText(item, item.configured)}</div>
            </div>
            {/* 网关自带那段（只有 registry 标了 note 的家有）——单独一行开关，
                与上面那行不是一回事：那个管客户端 system、这个管网关自己装什么 */}
            {option && note ? (
              <ProviderGatewayRow
                item={item}
                option={option}
                over={prompt.gatewayText[item.id]}
                locked={locked}
                busy={busy}
              />
            ) : null}
          </React.Fragment>
        )
      })}

      <div className='retention-row'>
        <label htmlFor='settings-prompt-provider-add'>添加提供商</label>
        <span className='prompt-input'>
          {/* 组件的 Select 不支持占位（必须有一个 value），所以第一个选项就是
              「选择要配置的提供商」这个动作本身；选完立刻重置回它。
              `next` 可能是 null（Base UI 在「清空 / 取消选择」时回调的就是它，
              见 @base-ui 的 `onValueChange` 类型）：照 `String(next)` 走会把它
              变成字符串 "null"，而后端会如实回一句「未知的提供商 id：null」——
              一次「没选」不该变成一次失败的保存。 */}
          <Select
            value={pending}
            onValueChange={next => {
              setPending('')
              const id = next == null ? '' : String(next)
              if (id) void addProviderPrompt(id)
            }}
          >
            <SelectTrigger
              id='settings-prompt-provider-add'
              className='w-[240px]'
              disabled={locked || busy || candidates.length === 0}
              aria-label='添加要单独配置的提供商'
            >
              <SelectValue>
                {pending ? labelOf(pending) : (candidates.length ? '添加提供商…' : '全部已配置')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {candidates.map(item => (
                <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>
        <div className='hint'>{NOTES.promptProviders}</div>
      </div>
    </>
  )
}

function PromptPanel({ snap }: { snap: SettingsSnapshot }) {
  const prompt = snap.prompt
  const locked = prompt.status !== 'ready'
  const busy = snap.busy === 'prompt'
  const modeLabel = PROMPT_MODES.find(item => item.value === prompt.mode)?.optionLabel ?? prompt.mode

  return (
    <section className='panel'>
      <PanelHead
        title='系统提示词'
        tip={TIPS.prompt}
        badge={prompt.status === 'ready'
          ? <StatusBadge tone='ok'>{prompt.mode === 'passthrough' ? '透传' : '已接管'}</StatusBadge>
          : prompt.status === 'unavailable'
            ? <StatusBadge tone='bad'>不可用</StatusBadge>
            : <StatusBadge tone='idle'>检测中…</StatusBadge>}
        actions={<RefreshButton id='btn-prompt-refresh' onClick={() => void refreshPrompt()} />}
      />
      <div className='panel-body'>
        <div className='retention-list'>
          {/* 两个分组条把「默认」与「某家的例外」分开：上面那几行是所有未单独配置的
              家共用的默认值，下面那张表是逐家的例外 —— 不分开时它们是一串同构的行，
              用户读不出哪几行管全部、哪几行只管一家（见 page-settings.css 的 .prompt-group）。 */}
          <div className='prompt-group'>
            全局配置<span className='note'>所有未单独配置的提供商都用这一份</span>
          </div>

          <div className='retention-row'>
            <label htmlFor='settings-prompt-mode'>模式</label>
            <span className='prompt-input'>
              {/* 旧实现是原生 <select>（select.js 增强 + wbSelect.sync）；这里换成组件库的
                  Select：触发器是按钮，page-settings.css 的 `.prompt-input select{width:240px}`
                  不再命中，宽度得用工具类补回（否则触发器按内容宽度缩成一团）。
                  展示文案显式给 SelectValue，不依赖 value 自动显示。 */}
              <Select
                value={prompt.mode}
                // 同「添加提供商」那条：null = 没选，不当作一个模式名（见那里的说明）
                onValueChange={next => { if (next != null && String(next)) void savePromptMode(String(next)) }}
              >
                <SelectTrigger
                  id='settings-prompt-mode'
                  className='w-[240px]'
                  disabled={locked || busy}
                  aria-label='系统提示词模式'
                >
                  <SelectValue>{modeLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PROMPT_MODES.map(item => (
                    <SelectItem key={item.value} value={item.value}>{item.optionLabel}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
            <div className='hint'>{NOTES.promptMode}</div>
          </div>

          <PromptFileRow prompt={prompt} locked={locked} busy={busy} />

          {/* 提示词正文：与文件是同一件事的两个来源（正文优先），所以紧挨着文件那一行。
              行里只放按钮与状态 —— 几百行文本塞进行内输入框既看不清也没法编辑 */}
          <div className='retention-row'>
            <label htmlFor='btn-prompt-edit-body'>提示词正文</label>
            <span className='prompt-input'>
              <PromptTextButton prompt={prompt} locked={locked} busy={busy} />
            </span>
            <div className='hint'>
              {NOTES.promptText}
              {prompt.source === 'inline'
                ? `（当前生效的就是这一份，${prompt.lines} 行）`
                : prompt.text.trim()
                  ? `（已存一份正文，${prompt.lines} 行；切成「替换 / 追加」后生效）`
                  : ''}
            </div>
          </div>

          <div className='prompt-group'>
            按提供商配置<span className='note'>只列单独配置过的家，其余沿用上面的全局配置</span>
          </div>

          <ProviderPromptRows prompt={prompt} locked={locked} busy={busy} />

          {/* 降级行只在真的处于降级期时渲染（旧实现是切 hidden） */}
          {prompt.status === 'ready' && prompt.degradeActive ? (
            <div className='retention-row'>
              <label>内容拦截降级</label>
              <span className='prompt-input'>
                <Button
                  id='btn-prompt-clear-degrade'
                  variant='outline'
                  disabled={busy}
                  onClick={() => void clearDegrade()}
                >
                  立即解除
                </Button>
              </span>
              <div className='hint'>{degradeHint(prompt)}</div>
            </div>
          ) : null}
        </div>
        <div className='settings-state'>{promptStateText(prompt)}</div>
        <div className='hint retention-note'>{NOTES.prompt}</div>
      </div>
    </section>
  )
}

/** 调试模式的状态行：条数只在后端给了两个整数时才提 */
function debugStateText(debug: DebugState): string {
  if (debug.status === 'loading') return STATES.appLoading
  if (debug.status === 'unavailable') return STATES.debugUnavailable
  const stored = debug.count !== null && debug.limit !== null
    ? `已保存 ${debug.count} / ${debug.limit} 条报文（超出后丢弃最旧的）。`
    : ''
  return debug.on ? `${STATES.debugOn}${stored}凭据类请求头已脱敏。` : STATES.debugOff
}

/* ─── 重试 / 超时分类（从「网关」拆出的两个独立菜单）── */

/** 请求超时（拆出理由见 settings-model 的 CATEGORIES 说明） */
function TimeoutPane({ snap }: { snap: SettingsSnapshot }) {
  return (
    <section className='panel'>
      <PanelHead
        title='请求超时'
        tip={TIPS.timeouts}
        badge={numericBadge(snap.timeouts)}
        actions={<RefreshButton id='btn-timeouts-refresh' onClick={() => void refreshTimeouts()} />}
      />
      <div className='panel-body'>
        <div className='retention-list'>
          {TIMEOUT_FIELDS.map(field => (
            <NumberRow
              key={field.key}
              field={field}
              value={snap.timeouts.values?.[field.key] ?? null}
              disabled={snap.busy === 'timeouts'}
              onCommit={raw => saveTimeoutField(field, raw)}
            />
          ))}
        </div>
        <div className='hint retention-note'>{NOTES.timeouts}</div>
      </div>
    </section>
  )
}

/** 请求重试：数字参数 + 「指定错误码」名单（两段共用同一份保存流程） */
function RetryPane({ snap }: { snap: SettingsSnapshot }) {
  return (
    <section className='panel'>
      <PanelHead
        title='请求重试'
        tip={TIPS.retry}
        badge={numericBadge(snap.retry)}
        actions={<RefreshButton id='btn-retry-refresh' onClick={() => void refreshRetry()} />}
      />
      <div className='panel-body'>
        <div className='retention-list'>
          {RETRY_FIELDS.map(field => (
            <NumberRow
              key={field.key}
              field={field}
              value={snap.retry.values?.[field.key] ?? null}
              disabled={snap.busy === 'retry'}
              onCommit={raw => saveRetryField(field, raw)}
            />
          ))}
          <RetryCodesField
            codes={snap.retryCodes}
            status={snap.retry.status}
            busy={snap.busy === 'codes' || snap.busy === 'retry'}
          />
        </div>
        <div className='hint retention-note'>{NOTES.retry}</div>
      </div>
    </section>
  )
}

/* ─── 网关分类 ─────────────────────────────── */

function GatewayPane({ snap }: { snap: SettingsSnapshot }) {
  return (
    <>
      <section className='panel'>
        <PanelHead
          title='排队等待'
          tip={TIPS.queue}
          badge={numericBadge(snap.queue)}
          actions={<RefreshButton id='btn-queue-refresh' onClick={() => void refreshQueue()} />}
        />
        <div className='panel-body'>
          <div className='retention-list'>
            {QUEUE_FIELDS.map(field => (
              <NumberRow
                key={field.key}
                field={field}
                value={snap.queue.values?.[field.key] ?? null}
                disabled={snap.busy === 'queue'}
                onCommit={raw => saveQueueField(field, raw)}
              />
            ))}
          </div>
          <div className='hint retention-note'>{NOTES.queue}</div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead
          title='指纹脱敏'
          tip={TIPS.sanitize}
          badge={snap.sanitize.status === 'ready'
            ? <StatusBadge tone='ok'>已生效</StatusBadge>
            : snap.sanitize.status === 'unavailable'
              ? <StatusBadge tone='bad'>不可用</StatusBadge>
              : <StatusBadge tone='idle'>检测中…</StatusBadge>}
          actions={<RefreshButton id='btn-sanitize-refresh' onClick={() => void refreshSanitize()} />}
        />
        <div className='panel-body'>
          <div className='settings-switches'>
            <SwitchRow
              id='settings-sanitize'
              label='剥离上游审核黑名单指纹（改写请求体里的模板句与表头）'
              checked={snap.sanitize.on}
              // 读到后端值之前不许切（否则会出现「切了但不知道后端原本是什么」，回滚也没依据）
              disabled={snap.sanitize.status !== 'ready' || snap.busy === 'sanitize'}
              onCheckedChange={next => void saveSanitize(next)}
            />
          </div>
          <div className='settings-state'>
            {snap.sanitize.status === 'loading'
              ? STATES.appLoading
              : snap.sanitize.status === 'unavailable'
                ? STATES.sanitizeUnavailable
                : snap.sanitize.on ? STATES.sanitizeOn : STATES.sanitizeOff}
          </div>
          <div className='hint retention-note'>{NOTES.sanitize}</div>
        </div>
      </section>

      <PromptPanel snap={snap} />

      <section className='panel'>
        <PanelHead
          title='调试模式'
          tip={TIPS.debug}
          badge={snap.debug.status === 'ready'
            ? <StatusBadge tone='ok'>已生效</StatusBadge>
            : snap.debug.status === 'unavailable'
              ? <StatusBadge tone='bad'>不可用</StatusBadge>
              : <StatusBadge tone='idle'>检测中…</StatusBadge>}
          actions={<RefreshButton id='btn-debug-refresh' onClick={() => void refreshDebug()} />}
        />
        <div className='panel-body'>
          <div className='settings-switches'>
            <SwitchRow
              id='settings-debug-mode'
              label='保存上游原始报文（请求头、请求体、响应头、响应体）'
              checked={snap.debug.on}
              disabled={snap.debug.status !== 'ready' || snap.busy === 'debug'}
              onCheckedChange={next => void saveDebug(next)}
            />
          </div>
          <div className='settings-state'>{debugStateText(snap.debug)}</div>
          <div className='hint retention-note'>{NOTES.debug}</div>
        </div>
      </section>
    </>
  )
}

/* ─── 安全分类 ─────────────────────────────── */

function SecurityPane({ snap }: { snap: SettingsSnapshot }) {
  // 「退出登录」成功后整页跳回登录页，那时组件已不在；只有失败才需要把按钮解禁
  const [loggingOut, setLoggingOut] = React.useState(false)

  async function onLogout(): Promise<void> {
    setLoggingOut(true)
    const ok = await panelLogout()
    if (!ok) setLoggingOut(false)
  }

  return (
    <>
      <section className='panel'>
        <PanelHead title='机器人校验' />
        <div className='panel-body'>
          <SwitchRow
            id='settings-captcha'
            label='登录 / 注册需要通过 ALTCHA 人机验证（工作量证明）'
            checked={snap.captcha.enabled}
            disabled={!snap.captcha.available || snap.busy === 'captcha'}
            onCheckedChange={next => void saveCaptcha(next)}
          />
          <div className='hint'>{NOTES.captcha}</div>
        </div>
      </section>

      {/* 面板登录：仅网页端（桌面壳的面板跟着应用走，没有「登录面板」的概念） */}
      {snap.panelLogin ? (
        <section className='panel' id='panel-login-section'>
          <PanelHead title='面板登录' />
          <div className='panel-body'>
            <div className='hint'>{NOTES.panelLogin}</div>
            <div className='mt-2.5'>
              <Button
                id='btn-panel-logout'
                variant='outline'
                disabled={loggingOut}
                onClick={() => void onLogout()}
              >
                退出登录
              </Button>
            </div>
          </div>
        </section>
      ) : null}
    </>
  )
}

/* ─── 数据分类 ─────────────────────────────── */

/** 数据存储面板的一格计数（键在上、值在下） */
function StorageCount({ label, value }: { label: string; value: string }) {
  return (
    <div className='storage-count'>
      <span className='k'>{label}</span>
      <span className='v'>{value}</span>
    </div>
  )
}

function storageBadge(state: StorageState): React.ReactNode {
  if (state.status === 'loading') return <StatusBadge tone='idle'>检测中…</StatusBadge>
  if (state.status === 'unavailable') return <StatusBadge tone='bad'>不可用</StatusBadge>
  // 「数据库不可用」是读到了概况但库打不开，与「读不到」不是一回事（旧实现同）
  return <StatusBadge tone={state.available ? 'ok' : 'bad'}>
    {state.available ? '已生效' : '数据库不可用'}
  </StatusBadge>
}

/* ─── 数据维护：事件日志 / 请求记录（后端现成的真实维护能力）────────── */

type DataBridgeWindow = {
  workbuddyDesktop?: {
    getLogStats?(): Promise<unknown>
    clearLogs?(query: Record<string, string>): Promise<unknown>
    getStatsClearPreview?(query?: Record<string, string>): Promise<unknown>
    clearStatsRequests?(query?: Record<string, string>): Promise<unknown>
    compactStatsDb?(): Promise<unknown>
  }
  wbApp?: { toast?: (message: string, kind?: 'err' | 'ok') => void }
  wbConfirm?: {
    ask?: (options: { title?: string; text?: string; okText?: string; okClass?: string }) => Promise<boolean>
  }
}

function dataShared(): DataBridgeWindow {
  return window as unknown as DataBridgeWindow
}

function dataToast(message: string, kind?: 'err' | 'ok'): void {
  dataShared().wbApp?.toast?.(message, kind)
}

function dataError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 危险操作的统一确认出口（wbConfirm 缺失时按未确认处理 —— 绝不静默执行删除） */
async function dataAsk(title: string, text: string, okText: string): Promise<boolean> {
  const ask = dataShared().wbConfirm?.ask
  if (!ask) return false
  return ask({ title, text, okText, okClass: 'danger' })
}

type LogStats = { total?: number; max?: number; lastId?: number; byLevel?: Record<string, number> }

/** 事件日志维护：容量统计 + 全清（对应 GET /api/logs/stats、DELETE /api/logs?all=1） */
function EventLogSection() {
  const [stats, setStats] = React.useState<LogStats | null>(null)
  const [busy, setBusy] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      const data = await dataShared().workbuddyDesktop?.getLogStats?.()
      setStats((data ?? null) as LogStats | null)
    } catch (error) {
      dataToast(`读取日志统计失败：${dataError(error)}`, 'err')
    }
  }, [])

  React.useEffect(() => { void refresh() }, [refresh])

  async function onClear(): Promise<void> {
    if (!(await dataAsk(
      '清空全部事件日志',
      '将删除全部运行日志（各级别条目一并删除），条目编号从 1 重新计数。\n此操作不可恢复；需要留存请先在「日志」页导出。',
      '确认清空',
    ))) return
    setBusy(true)
    try {
      const result = await dataShared().workbuddyDesktop?.clearLogs?.({ all: '1' }) as { removed?: number } | null | undefined
      dataToast(typeof result?.removed === 'number' ? `✅ 事件日志已清空（删除 ${result.removed} 条）` : '✅ 事件日志已清空', 'ok')
      await refresh()
      void refreshStorage()
    } catch (error) {
      dataToast(`清空失败：${dataError(error)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const total = stats?.total ?? null
  const max = stats?.max ?? null
  const levels = stats?.byLevel ?? {}
  const levelText = Object.entries(levels)
    .filter(([, count]) => count > 0)
    .map(([level, count]) => `${level} ${formatCount(count)}`)
    .join(' · ')
  const pct = total !== null && max ? Math.min(100, Math.round((total / max) * 100)) : null

  return (
    <section className='panel'>
      <PanelHead
        title='事件日志维护'
        tip={NOTES.logMaint}
        actions={<RefreshButton id='btn-logstats-refresh' onClick={() => void refresh()} />}
      />
      <div className='panel-body'>
        <div className='retention-list'>
          <div className='retention-row'>
            <label htmlFor='logstats-total'>条目占用</label>
            <span className='storage-line'>
              <span className='storage-path' id='logstats-total'>
                {total !== null ? `${formatCount(total)} / ${formatCount(max ?? 0)}${pct !== null ? `（${pct}%）` : ''}` : '—'}
              </span>
            </span>
            <div className='hint'>当前条目数与容量上限；写满后自动滚动淘汰最旧的条目。</div>
          </div>
          <div className='retention-row'>
            <label htmlFor='logstats-levels'>按级别分布</label>
            <span className='storage-line'>
              <span className='storage-path' id='logstats-levels'>{levelText || (total !== null ? '（暂无条目）' : '—')}</span>
            </span>
            <div className='hint'>info / warn / error 各级别的条目数；排查故障时优先看 warn 与 error。</div>
          </div>
        </div>
        <div className='mt-2.5'>
          <Button id='btn-logs-clear' variant='outline' disabled={busy} onClick={() => void onClear()}>
            {busy ? '清空中…' : '清空全部事件日志'}
          </Button>
          <div className='hint'>{NOTES.logClear}</div>
        </div>
      </div>
    </section>
  )
}

type ClearPreview = {
  all?: number
  raw?: number
  dbBytes?: number
  vacuumRunning?: boolean
  lastVacuum?: number
}

/** 请求记录维护：清理预览 + 两种清理 + 数据库压缩（clear-preview / DELETE stats / compact） */
function RequestMaintenanceSection() {
  const [preview, setPreview] = React.useState<ClearPreview | null>(null)
  const [busy, setBusy] = React.useState<'clear' | 'raw' | 'compact' | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const data = await dataShared().workbuddyDesktop?.getStatsClearPreview?.({})
      setPreview((data ?? null) as ClearPreview | null)
    } catch (error) {
      dataToast(`读取清理预览失败：${dataError(error)}`, 'err')
    }
  }, [])

  React.useEffect(() => { void refresh() }, [refresh])

  async function onClear(mode: 'all' | 'raw'): Promise<void> {
    const all = mode === 'all'
    if (!(await dataAsk(
      all ? '清理全部请求明细' : '仅清理原始正文',
      all
        ? `将删除 ${formatCount(preview?.all ?? 0)} 条请求明细（含原始正文）。\n报表历史随之清零，此操作不可恢复。`
        : `将删除 ${formatCount(preview?.raw ?? 0)} 条原始正文（请求 / 响应报文）。\n明细行与报表统计保留，磁盘空间在「压缩数据库」后才真正释放。`,
      all ? '确认清理' : '确认清理正文',
    ))) return
    setBusy(all ? 'clear' : 'raw')
    try {
      const result = await dataShared().workbuddyDesktop?.clearStatsRequests?.(all ? { mode: 'all' } : { mode: 'raw' }) as { deleted?: number } | null | undefined
      dataToast(typeof result?.deleted === 'number' ? `✅ 已删除 ${result.deleted} 条` : '✅ 已清理', 'ok')
      await refresh()
      void refreshStorage()
    } catch (error) {
      dataToast(`清理失败：${dataError(error)}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  async function onCompact(): Promise<void> {
    setBusy('compact')
    try {
      const result = await dataShared().workbuddyDesktop?.compactStatsDb?.() as { started?: boolean } | null | undefined
      if (result?.started) dataToast('✅ 已在后台开始压缩数据库；完成后磁盘占用才会下降', 'ok')
      else dataToast('压缩未能启动，请稍后重试', 'err')
      await refresh()
    } catch (error) {
      dataToast(`压缩失败：${dataError(error)}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  const rows: { label: string; value: string; hint: string }[] = [
    {
      label: '请求明细',
      value: preview ? formatCount(preview.all ?? 0) : '—',
      hint: '每次客户端调用的明细行；报表与请求日志页的数据来源。',
    },
    {
      label: '含原始正文',
      value: preview ? formatCount(preview.raw ?? 0) : '—',
      hint: '其中带完整请求 / 响应报文的条数（调试报文，体积大头）。',
    },
    {
      label: '请求库占用',
      value: preview ? formatBytes(preview.dbBytes ?? 0) : '—',
      hint: '请求统计库文件（含 WAL）的磁盘占用；删除后不缩小，压缩后才释放。',
    },
    {
      label: '压缩状态',
      value: preview
        ? preview.vacuumRunning
          ? '后台压缩进行中…'
          : preview.lastVacuum
            ? `空闲 · 上次完成 ${new Date(preview.lastVacuum).toLocaleString()}`
            : '空闲 · 从未压缩'
        : '—',
      hint: '「压缩数据库」执行时这里会转为进行中；期间数据库短暂互斥属正常。',
    },
  ]

  return (
    <section className='panel'>
      <PanelHead
        title='请求记录维护'
        tip={NOTES.requestMaint}
        actions={<RefreshButton id='btn-clearpreview-refresh' onClick={() => void refresh()} />}
      />
      <div className='panel-body'>
        <div className='retention-list'>
          {rows.map(row => (
            <div className='retention-row' key={row.label}>
              <label>{row.label}</label>
              <span className='storage-line'>
                <span className='storage-path'>{row.value}</span>
              </span>
              <div className='hint'>{row.hint}</div>
            </div>
          ))}
        </div>
        <div className='mt-2.5 flex flex-wrap gap-2.5'>
          <Button
            id='btn-requests-clear-all'
            variant='outline'
            disabled={busy !== null}
            onClick={() => void onClear('all')}
          >
            {busy === 'clear' ? '清理中…' : '清理请求明细（含原始正文）'}
          </Button>
          <Button
            id='btn-requests-clear-raw'
            variant='outline'
            disabled={busy !== null}
            onClick={() => void onClear('raw')}
          >
            {busy === 'raw' ? '清理中…' : '仅清理原始正文（保留明细）'}
          </Button>
          <Button
            id='btn-requests-compact'
            variant='outline'
            disabled={busy !== null || preview?.vacuumRunning === true}
            onClick={() => void onCompact()}
          >
            {busy === 'compact' || preview?.vacuumRunning === true ? '后台压缩中…' : '压缩数据库'}
          </Button>
        </div>
        <div className='hint'>{NOTES.compact}</div>
      </div>
    </section>
  )
}

function DataPane({ snap }: { snap: SettingsSnapshot }) {
  const io = snap.busy
  const storage = snap.storage
  // 库打不开时各计数都是后端回落出来的 0，与「真的没有数据」在数字上无法区分 ——
  // 整排显示「—」，不误导用户以为数据丢了；路径仍然照显（文件位置是已知的）
  const ready = storage.status === 'ready'
  const counts = ready && storage.available
  const path = ready && storage.file ? storage.file : '—'
  const count = (value: number | null): string => (counts && value !== null ? formatCount(value) : '—')

  return (
    <>
      <section className='panel'>
        <PanelHead
          title='账号导入 / 导出'
          tip={TIPS.io}
          actions={
            <>
              {/* 忙碌守卫与旧实现的 guard() 同形：点下去的那个按钮禁用并换文案，
                  另一个保持可点但会被守卫挡下 */}
              <Button
                id='btn-settings-export'
                variant='outline'
                disabled={io === 'export'}
                onClick={() => void exportAccounts()}
              >
                {io === 'export' ? '导出中…' : '导出账号'}
              </Button>
              <Button
                id='btn-settings-import'
                variant='default'
                disabled={io === 'import'}
                onClick={() => void importAccounts()}
              >
                {io === 'import' ? '导入中…' : '导入账号'}
              </Button>
            </>
          }
        />
        <div className='panel-body'>
          <div className='danger-zone'>
            <strong>导出文件内含 accessToken / refreshToken / apiKey 等凭证与自定义提供商定义</strong>
            ，可直接用于登录。请妥善保管，不要外传或上传到公共位置。
          </div>
          {/* 失败明细（旧实现写 innerHTML 并 display:none 收起空结果，这里条件渲染） */}
          {snap.ioFailure ? (
            <div className='io-result'>
              <span className='text-destructive'>
                失败 {snap.ioFailure.failed} 个：{snap.ioFailure.detail}
                {snap.ioFailure.more ? ' 等' : ''}
              </span>
            </div>
          ) : null}
        </div>
      </section>

      <section className='panel'>
        <PanelHead
          title='数据保留'
          tip={TIPS.retention}
          badge={numericBadge(snap.retention)}
          actions={<RefreshButton id='btn-retention-refresh' onClick={() => void refreshRetention()} />}
        />
        <div className='panel-body'>
          <div className='retention-list'>
            {RETENTION_FIELDS.map(field => (
              <NumberRow
                key={field.key}
                field={field}
                value={snap.retention.values?.[field.key] ?? null}
                disabled={snap.busy === 'retention'}
                onCommit={raw => saveRetentionField(field, raw)}
              />
            ))}
          </div>
          <div className='hint retention-note'>{NOTES.retention}</div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead
          title='数据存储'
          tip={TIPS.storage}
          badge={storageBadge(storage)}
          actions={<RefreshButton id='btn-storage-refresh' onClick={() => void refreshStorage()} />}
        />
        <div className='panel-body'>
          <div className='retention-list'>
            <div className='retention-row'>
              <label htmlFor='storage-db-path'>数据库文件</label>
              <span className='storage-line'>
                {/* 悬停看完整路径（元素上是折行显示的，长路径会被截成好几行） */}
                <span className='storage-path' id='storage-db-path' title={path}>{path}</span>
              </span>
              <div className='hint'>{NOTES.storageFile}</div>
            </div>
            <div className='retention-row'>
              <label htmlFor='storage-db-size'>占用大小</label>
              <span className='storage-line'>
                <span className='storage-path' id='storage-db-size'>
                  {counts ? formatBytes(storage.bytes) : '—'}
                </span>
              </span>
              <div className='hint'>{NOTES.storageSize}</div>
            </div>
          </div>
          <div className='retention-list storage-counts'>
            <StorageCount label='账号' value={count(storage.accounts)} />
            <StorageCount label='事件日志' value={count(storage.logs)} />
            <StorageCount label='请求记录' value={count(storage.requests)} />
            <StorageCount label='报表天数' value={count(storage.dailyDays)} />
            <StorageCount label='调试报文' value={count(storage.debug)} />
          </div>
          <div className='hint retention-note'>{NOTES.storage}</div>
        </div>
      </section>

      <EventLogSection />
      <RequestMaintenanceSection />
    </>
  )
}

/* ─── 反馈与需求分类 ───────────────────────── */

/**
 * 三个入口，分别指向仓库里预设好模板的 GitHub issue 表单。
 * 用系统默认浏览器打开（`openExternal` → 壳命令 `open_release_page`，只放行
 * http(s)）：应用内 webview 打开会白屏，而且提交 issue 需要用户自己的 GitHub 登录态。
 */
const FEEDBACK_LINKS = [
  {
    title: '问题反馈',
    desc: '遇到 Bug、报错或异常行为',
    cta: '去反馈',
    url: 'https://github.com/aimod-cc/agent2api/issues/new?template=bug_report.yml',
  },
  {
    title: '功能建议',
    desc: '想要的新功能或改进想法',
    cta: '提建议',
    url: 'https://github.com/aimod-cc/agent2api/issues/new?template=feature_request.yml',
  },
  {
    title: '请求提供商 / 模型支持',
    desc: '希望接入新的提供商或模型',
    cta: '去申请',
    url: 'https://github.com/aimod-cc/agent2api/issues/new?template=provider_request.yml',
  },
] as const

function FeedbackPane() {
  return (
    <section className='panel'>
      <PanelHead title='反馈与需求' />
      <div className='panel-body'>
        <div className='hint'>
          点下面的入口会用系统默认浏览器打开 GitHub 的对应表单（需要 GitHub 账号，
          模板已预设好，填完直接提交即可）。
        </div>
        <div className='mt-3 flex flex-col gap-2'>
          {FEEDBACK_LINKS.map(item => (
            <div
              key={item.url}
              className='flex items-center justify-between gap-3 rounded-md border border-hairline bg-surface-2 px-3 py-2.5'
            >
              <div className='min-w-0'>
                <div className='text-[12.5px] text-foreground'>{item.title}</div>
                <div className='mt-0.5 text-[12px] text-subtle'>{item.desc}</div>
              </div>
              <Button variant='outline' size='sm' onClick={() => void openExternal(item.url)}>
                {item.cta}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ─── 保留期改小的确认框 ───────────────────── */

/**
 * 缩短保留天数的二次确认（旧实现是 index.html 的 `#retention-modal` + 一堆 class 开关）。
 *
 * 用 Dialog 而不是 AlertDialog：旧实现的五条出口（确认 / 取消 / 右上角 ✕ / 点遮罩 / Esc）里
 * 有四条都算「取消」，即它是**可以糊弄过去**的普通弹窗，不是 AlertDialog 那种必须表态的框。
 * 焦点落在「取消」而不是危险键：这是不可恢复的删除操作，敲回车不该等于同意删除。
 */
function RetentionConfirmDialog({ confirm }: { confirm: { head: string } | null }) {
  const cancelRef = React.useRef<HTMLButtonElement | null>(null)

  return (
    <Dialog open={confirm !== null} onOpenChange={next => { if (!next) resolveRetentionConfirm(false) }}>
      {/* 旧 .modal-confirm 把宽度收到 440px（这类框只有一段话加两个按钮，620px 太宽） */}
      <DialogContent className='w-[min(440px,calc(100vw-48px))]' initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>确认缩短保留天数</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className='danger-zone'>
            {confirm?.head}
            <br />
            <strong>超出的历史数据会被立即删除，且不可恢复。</strong>确定继续？
          </div>
        </DialogBody>
        <DialogFooter>
          <div className='mr-auto' />
          <Button ref={cancelRef} variant='outline' onClick={() => resolveRetentionConfirm(false)}>
            取消
          </Button>
          <Button variant='destructive' onClick={() => resolveRetentionConfirm(true)}>
            继续并清理
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─── 部署信息 ─────────────────────────────────── */

/** 部署信息分区的一行：值可以是 JSX（比如带颜色的状态徽标文本） */
function DeployRow({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
  return (
    <div className='retention-row'>
      <label>{label}</label>
      <span className='storage-line'>
        <span className='storage-path'>{value}</span>
      </span>
      <div className='hint'>{hint}</div>
    </div>
  )
}

/**
 * 部署信息：当前运行形态、访问地址、引擎版本、安全与数据概览。
 *
 * 全部是**只读的真实状态**（不做任何设置修改 —— 那些归属各自分区）：
 * 版本号来自 getUpdateStatus（web_shim 与桌面桥都有），其余来自快照与浏览器自身。
 */
function DeployPane({ snap }: { snap: SettingsSnapshot }) {
  const [version, setVersion] = React.useState('')
  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const info = await shared().workbuddyDesktop?.getUpdateStatus?.()
        if (alive) setVersion(info?.currentVersion || '—')
      } catch {
        if (alive) setVersion('—')
      }
    })()
    return () => { alive = false }
  }, [])

  const isWeb = snap.panelLogin
  const https = window.location.protocol === 'https:'
  const storage = snap.storage
  const storageReady = storage.status === 'ready' && storage.available

  return (
    <>
      <section className='panel'>
        <PanelHead title='运行形态' tip='面板与网关的部署方式。网页端经反向代理访问服务器上的网关；桌面端的网关跑在应用进程内。' />
        <div className='panel-body'>
          <div className='retention-list'>
            <DeployRow
              label='运行形态'
              value={isWeb ? '网页端 · 服务器 / 容器部署' : '桌面端 · 应用内置网关'}
              hint={isWeb
                ? '面板与网关由同一个服务端进程提供，浏览器访问的是反向代理后的地址。'
                : '网关随应用启动，关闭窗口默认最小化到托盘，转发不中断。'}
            />
            {isWeb ? (
              <DeployRow
                label='面板地址'
                value={window.location.origin}
                hint='当前浏览器访问的地址，也是 API 客户端要填的 Base URL 的前半段（文档页有完整端点）。'
              />
            ) : null}
            {isWeb ? (
              <DeployRow
                label='传输加密'
                value={https
                  ? <span style={{ color: 'var(--ok)' }}>HTTPS · TLS 已启用</span>
                  : <span className='text-destructive'>HTTP · 未加密</span>}
                hint='公网部署请始终使用 HTTPS：登录口令与 API Key 都在这条通道上明文传输。'
              />
            ) : null}
            {isWeb ? (
              <DeployRow
                label='网关 Base URL'
                value={`${window.location.origin}/v1`}
                hint='OpenAI 兼容端点；三种对话协议与模型清单的完整地址见「文档」页。'
              />
            ) : null}
          </div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='引擎与安全' tip='引擎版本与面板安全状态的只读概览；可修改的项在各自分区。' />
        <div className='panel-body'>
          <div className='retention-list'>
            <DeployRow
              label='引擎版本'
              value={version || '…'}
              hint='网关引擎的当前版本；有新版本时「更新」分区会亮标。'
            />
            <DeployRow
              label='登录人机验证'
              value={snap.captcha.enabled
                ? <span style={{ color: 'var(--ok)' }}>已开启 · ALTCHA 工作量证明</span>
                : '已关闭'}
              hint='在「安全」分区切换；开启后登录页自动完成验证（对真人无感），脚本暴力破解成本大幅上升。'
            />
            <DeployRow
              label='面板登录会话'
              value={isWeb ? '管理员会话 · 30 天自动续期' : '桌面端无需登录'}
              hint='会话只在登录设备上有效；「安全」分区的退出登录会撤销本设备的会话链。'
            />
          </div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='数据概览' tip='SQLite 库的只读摘要；完整路径、大小与逐表计数见「数据」分区。' />
        <div className='panel-body'>
          <div className='retention-list'>
            <DeployRow
              label='存储状态'
              value={storageReady
                ? <span style={{ color: 'var(--ok)' }}>正常 · SQLite 单文件库</span>
                : <span className='text-destructive'>不可用</span>}
              hint='全部状态（账号、日志、请求记录、设置）都在这一个库文件里。'
            />
            <DeployRow
              label='库大小'
              value={storageReady ? formatBytes(storage.bytes) : '—'}
              hint='主文件大小；运行期 WAL 会在退出时自动并回。'
            />
            <DeployRow
              label='账号 / 请求记录'
              value={storageReady ? `${formatCount(storage.accounts)} / ${formatCount(storage.requests)}` : '—'}
              hint='账号池规模与累计请求条数；清理入口在「数据」分区。'
            />
          </div>
        </div>
      </section>
    </>
  )
}

/* ─── 品牌外观（网页端保存；注入脚本把它铺到所有页面）────────────── */

/** Logo 原始文件上限（再大就直接拒绝，而不是吞下去现压） */
const LOGO_RAW_LIMIT = 5 * 1024 * 1024
/** 直接上传的 data URL 上限：超过就走 canvas 等比缩到 256px */
const LOGO_INLINE_LIMIT = 280 * 1024

/** 把用户选的图片转成品牌 Logo 的 data URL：小图原样，大图等比缩到 256px 转 PNG */
function fileToLogoDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('请选择图片文件（PNG / JPEG / WebP / SVG）'))
      return
    }
    if (file.size > LOGO_RAW_LIMIT) {
      reject(new Error('图片超过 5MB，请先压缩'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      if (dataUrl.length <= LOGO_INLINE_LIMIT) {
        resolve(dataUrl)
        return
      }
      // 大图现压：等比缩到最长边 256px（SVG 交给 canvas 栅格化后同样走这条）
      const image = new Image()
      image.onload = () => {
        const scale = Math.min(1, 256 / Math.max(image.width || 1, image.height || 1))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round((image.width || 256) * scale))
        canvas.height = Math.max(1, Math.round((image.height || 256) * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('图片处理失败，请换一张试试'))
          return
        }
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/png'))
      }
      image.onerror = () => reject(new Error('图片解析失败，请换一张试试'))
      image.src = dataUrl
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function BrandPane({ snap }: { snap: SettingsSnapshot }) {
  const [title, setTitle] = React.useState('')
  const [logo, setLogo] = React.useState<string | null>(null)
  const [loaded, setLoaded] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const data = await shared().workbuddyDesktop?.getBranding?.()
        if (!alive) return
        setTitle(data?.title || '')
        setLogo(data?.logo || null)
      } catch {
        // 读不到就按默认值展示，保存时服务端会兜底校验
      } finally {
        if (alive) setLoaded(true)
      }
    })()
    return () => { alive = false }
  }, [])

  async function save(patch: { title?: string | null; logo?: string | null }, okText: string): Promise<void> {
    if (!shared().workbuddyDesktop?.saveBranding) {
      dataToast('当前端不支持保存品牌（网页端部署专属能力）', 'err')
      return
    }
    setBusy(true)
    try {
      const data = await shared().workbuddyDesktop?.saveBranding?.(patch)
      setTitle((data as { title?: string | null })?.title || '')
      setLogo((data as { logo?: string | null })?.logo || null)
      setDirty(false)
      dataToast(okText, 'ok')
    } catch (error) {
      dataToast(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  async function onPickLogo(file: File | undefined): Promise<void> {
    if (!file) return
    try {
      const dataUrl = await fileToLogoDataUrl(file)
      setLogo(dataUrl)
      setDirty(true)
      await save({ logo: dataUrl }, '✅ Logo 已保存，刷新页面生效')
    } catch (error) {
      dataToast(error instanceof Error ? error.message : String(error), 'err')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const isWeb = snap.panelLogin

  return (
    <>
      <section className='panel'>
        <PanelHead title='站点标题' tip={NOTES.brandingTitle} />
        <div className='panel-body'>
          <div className='flex flex-col gap-2'>
            <Label htmlFor='branding-title'>自定义标题（留空 = 恢复「AIBuddy Panel」）</Label>
            <Input
              id='branding-title'
              value={title}
              maxLength={40}
              placeholder='AIBuddy Panel'
              onChange={event => { setTitle(event.target.value); setDirty(true) }}
            />
          </div>
          <div className='hint'>{NOTES.brandingTitle}</div>
          <div className='mt-2.5'>
            <Button
              id='btn-branding-title-save'
              variant='default'
              disabled={busy || !loaded || !dirty}
              onClick={() => void save({ title: title.trim() || null }, '✅ 标题已保存，刷新页面生效')}
            >
              {busy ? '保存中…' : '保存标题'}
            </Button>
          </div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='站点 Logo' tip={NOTES.brandingLogo} />
        <div className='panel-body'>
          <div className='flex items-center gap-4'>
            <div className='size-[64px] shrink-0 overflow-hidden rounded-[14px] border border-border bg-surface-2'>
              {logo
                ? <img src={logo} alt='logo 预览' className='size-full object-cover' />
                : <div className='flex size-full items-center justify-center text-[11px] muted'>内置</div>}
            </div>
            <div className='flex flex-wrap gap-2.5'>
              <Button
                id='btn-branding-logo-pick'
                variant='outline'
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                选择图片…
              </Button>
              {logo ? (
                <Button
                  id='btn-branding-logo-clear'
                  variant='outline'
                  disabled={busy}
                  onClick={() => void save({ logo: null }, '✅ 已移除自定义 Logo，刷新页面生效')}
                >
                  移除 Logo
                </Button>
              ) : null}
            </div>
            <input
              ref={fileRef}
              type='file'
              accept='image/png,image/jpeg,image/webp,image/svg+xml'
              className='hidden'
              onChange={event => void onPickLogo(event.target.files?.[0])}
            />
          </div>
          <div className='hint'>{NOTES.brandingLogo}</div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='生效范围' tip={NOTES.brandingScope} />
        <div className='panel-body'>
          <div className='retention-list'>
            <div className='retention-row'>
              <label>标题应用位置</label>
              <span className='storage-line'>
                <span className='storage-path'>浏览器标签 · 侧栏品牌区 · 面包屑 · 登录页</span>
              </span>
              <div className='hint'>由服务端在页面里注入，登录前的登录页同样生效。</div>
            </div>
            <div className='retention-row'>
              <label>保存通道</label>
              <span className='storage-line'>
                <span className='storage-path'>
                  {isWeb ? '网页端 · PUT /api/branding（当前可用）' : '桌面端 · 暂不支持（仅网页端部署可改）'}
                </span>
              </span>
              <div className='hint'>{NOTES.brandingScope}</div>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}

/* ─── 偏好与外观 / 通知与页签（外壳偏好）────────── */

/**
 * 「偏好与外观」「通知与页签」两分类：把顶栏齿轮「偏好设置」抽屉、页签栏
 * （tags-view.js）与通知中心（notify-center.js）三块外壳功能纳入后台设置。
 *
 * ⚠ 生效机制（比「显示」分类的纯前端偏好更绕一点，读prefs.js 后确认的事实）：
 * prefs.js 是封闭 IIFE 且**不监听任何事件**（'aibuddy-prefs-changed' 只是它自己
 * apply() 后在 document 上派发的广播，今天没有任何监听者），window.__aibuddyPrefs
 * 只暴露「只读偏好 + 锁屏控制」。所以本页改完 localStorage 后，立即生效只能自己做
 * —— 下面的 applyShellPrefs 逐条镜像 prefs.js apply() 对这批键的 DOM 效果；壳下次
 * 加载时会从 localStorage 读到同一批值重新应用，两边不会漂。主题是例外：它的唯一
 * 应用入口在 app.js（applyTheme 管 data-theme、color-scheme 与窗口标题栏），改主题
 * 必须调它，再顺手把 aibuddy-prefs.theme 同步成同一个值 —— 否则 prefs.js 启动时
 * 会用旧值把 data-theme 掰回去。
 *
 * 页签 / 通知两块则有官方外部出口（wbTagsView / wbNotifyCenter），「清空页签」「打开
 * 通知中心」「重置未读」都直接调它们，是活的功能、不是摆设。
 */

/** 读偏好存档（坏档 / 隐私模式回落默认值，与 prefs.js load() 同一取向） */
function readShellPrefs(): ShellPrefs {
  try {
    return normalizeShellPrefs(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'))
  } catch {
    return normalizeShellPrefs(null)
  }
}

/**
 * 合并写入偏好存档：patch 与现有存档浅合并后整体写回 —— 本页不管理的键（如 layout）
 * 原样保留，不会冲掉用户在抽屉里配过的其它项（与 prefs.js「读 → 改 → 存」同构）。
 */
function writeShellPrefs(patch: Partial<ShellPrefs>): ShellPrefs {
  let stored: Record<string, unknown> = {}
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    if (raw && typeof raw === 'object') stored = raw as Record<string, unknown>
  } catch { /* 坏档按空处理，这次写回即修复 */ }
  const next = { ...stored, ...normalizeShellPrefs({ ...stored, ...patch }) }
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)) } catch { /* 存储不可用只影响持久化 */ }
  return normalizeShellPrefs(next)
}

/** 派发偏好广播（与 prefs.js apply() 同款：document + detail 为整份偏好） */
function dispatchPrefsChanged(prefs: ShellPrefs): void {
  try { document.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: prefs })) } catch { /* 老引擎没有 CustomEvent 也无妨 */ }
}

/** 品牌名（水印 / 页脚用）：与 prefs.js 同一数据源 —— 侧栏品牌区的 h1 */
function prefBrandName(): string {
  const h1 = document.querySelector('.brand-text h1')
  return (h1?.textContent?.trim()) || 'AIBuddy Panel'
}

/** 平铺水印：与 prefs.js applyWatermark 同款（品牌名 · 当天日期，-20° 斜铺，中性灰半透明） */
function applyPrefWatermark(on: boolean): void {
  const old = document.getElementById('pref-watermark')
  if (!on) {
    if (old && old.parentNode) old.parentNode.removeChild(old)
    return
  }
  const now = new Date()
  const text = prefBrandName() + ' · ' + now.getFullYear() + '-'
    + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
  const w = 280
  const h = 170
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.translate(w / 2, h / 2)
  ctx.rotate((-20 * Math.PI) / 180)
  ctx.font = '13px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(127,127,127,0.18)' // 中性灰：浅色 / 深色主题下都低调可见
  ctx.fillText(text, 0, 0)
  const node = old ?? document.createElement('div')
  node.id = 'pref-watermark'
  node.setAttribute('aria-hidden', 'true')
  node.style.backgroundImage = `url(${canvas.toDataURL('image/png')})`
  if (!old) document.body.appendChild(node)
}

/** 页脚版权：与 prefs.js ensureFooter 同款（.content-inner 底部固定一行） */
function applyPrefFooter(on: boolean): void {
  const old = document.getElementById('pref-footer')
  if (!on) {
    if (old && old.parentNode) old.parentNode.removeChild(old)
    return
  }
  const host = document.querySelector('.content-inner')
  if (!host) return
  const node = old ?? document.createElement('div')
  node.id = 'pref-footer'
  node.className = 'pref-footer'
  node.textContent = `© ${new Date().getFullYear()} ${prefBrandName()} · 基于 agent2api`
  if (!old) host.appendChild(node)
}

/** 动态标题：与 prefs.js 同一份数据源（壳在 boot 时记下品牌名与当前页名） */
function applyPrefTitle(dynamic: boolean): void {
  const base = (window as unknown as { __aibuddyTitleBase?: { brand?: string; currentPage?: string } }).__aibuddyTitleBase
  if (!base?.brand) return // 壳还没记下品牌名：不动标题（免得写坏）
  document.title = dynamic && base.currentPage ? `${base.currentPage} · ${base.brand}` : base.brand
}

/**
 * 主题的应用入口在 app.js（applyTheme）：data-theme、color-scheme 与窗口标题栏都由它
 * 统一处理，并广播 'wb:theme' 让侧栏三键 / 本页「显示」分类的档位跟上。
 */
function applyShellTheme(mode: string): void {
  const app = shared().wbApp
  if (app?.applyTheme) {
    app.applyTheme(mode)
    return
  }
  // 桥缺失的兜底（正常不会走到）：至少把 data-theme 与 color-scheme 切过去，
  // 并按 applyTheme 的契约广播 'wb:theme'，让本页与「显示」分类的档位跟上
  const root = document.documentElement
  root.dataset.theme = mode
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  root.style.colorScheme = dark ? 'dark' : 'light'
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: mode }))
}

/**
 * 逐条镜像 prefs.js apply() 的 DOM 效果（data-theme 除外 —— 那归 applyTheme 管）。
 * 全部幂等：每次改偏好后整份重放，多调几次与调一次结果相同。
 */
function applyShellPrefs(prefs: ShellPrefs): void {
  const root = document.documentElement
  root.setAttribute('data-pref-sidebar', prefs.darkSidebar ? 'dark' : 'light')
  root.setAttribute('data-pref-topbar', prefs.darkTopbar ? 'dark' : 'light')
  root.setAttribute('data-pref-width', prefs.contentWidth)
  root.setAttribute('data-pref-filter', prefs.filter)
  root.setAttribute('data-pref-anim', prefs.pageAnim)
  root.setAttribute('data-pref-crumb', prefs.isBreadcrumb ? 'on' : 'off')
  root.setAttribute('data-pref-logo', prefs.isShowLogo ? 'on' : 'off')
  root.setAttribute('data-pref-grouplabel', prefs.isGroupLabel ? 'on' : 'off')
  root.setAttribute('data-pref-topbar-grad', prefs.topbarGradient ? 'on' : 'off')
  root.setAttribute('data-pref-navhl', prefs.menuHighlight ? 'on' : 'off')
  // 主题色派生规则与 prefs.js 逐字同源：衍生色用 color-mix 跟随，明暗两套主题都成立
  if (prefs.primary) {
    const c = prefs.primary
    root.style.setProperty('--primary', c)
    root.style.setProperty('--ui-primary', c)
    root.style.setProperty('--primary-hover', `color-mix(in srgb, ${c} 86%, var(--text))`)
    root.style.setProperty('--ui-primary-hover', `color-mix(in srgb, ${c} 86%, var(--text))`)
    root.style.setProperty('--primary-soft', `color-mix(in srgb, ${c} 14%, transparent)`)
    root.style.setProperty('--primary-bd', `color-mix(in srgb, ${c} 38%, transparent)`)
    root.style.setProperty('--primary-fg', `color-mix(in srgb, ${c} 70%, var(--text))`)
  } else {
    for (const name of ['--primary', '--ui-primary', '--primary-hover', '--ui-primary-hover', '--primary-soft', '--primary-bd', '--primary-fg']) {
      root.style.removeProperty(name)
    }
  }
  applyPrefWatermark(prefs.watermark)
  applyPrefFooter(prefs.isFooter)
  applyPrefTitle(prefs.dynamicTitle)
}

/**
 * 一行「开关 + 详细说明」。与 SwitchRow 的差别：说明独立成行下的 hint 段 ——
 * 这里的每一项都要放下 2-3 句的中文说明（是什么 / 怎么生效 / 注意什么），
 * 塞进开关旁的行内文字放不下。
 */
function PrefSwitchRow({ id, label, checked, hint, onChange }: {
  id: string
  label: string
  checked: boolean
  hint: string
  onChange: (next: boolean) => void
}) {
  return (
    <div className='retention-row'>
      <label htmlFor={id}>{label}</label>
      <span className='retention-input'>
        <Switch id={id} checked={checked} onCheckedChange={onChange} />
      </span>
      <div className='hint'>{hint}</div>
    </div>
  )
}

/** 自动锁屏分钟数的字段表（0–1440，0 = 不自动锁屏，与 prefs.js 的抽屉同口径） */
const LOCK_MINUTES_FIELD: NumberField = {
  key: 'minutes',
  id: 'prefs-lock-minutes',
  label: '自动锁屏（空闲分钟数）',
  unit: '分钟',
  min: 0,
  max: 1440,
  hint: '鼠标 / 键盘空闲达到该分钟数自动锁屏（有活动就重新计时）；0 = 不自动锁屏。可填 0–1440。',
}

/**
 * 「偏好与外观」：与顶栏齿轮的偏好抽屉共用同一份 aibuddy-prefs。除锁屏外的一切
 * 改动走 commit()（写档 → applyShellPrefs 立即应用 → 广播 → 界面采纳）；
 * 锁屏参数只写档（解锁校验与自动锁屏计时由壳在页面加载时读取，刷新后生效）。
 */
function PrefsPane() {
  const [prefs, setPrefs] = React.useState<ShellPrefs>(readShellPrefs)
  const prefsRef = React.useRef(prefs)
  prefsRef.current = prefs
  const [pwDraft, setPwDraft] = React.useState<string | null>(null)

  // 跟随其它入口的改动：抽屉每次 apply 都派发 PREFS_EVENT（document），重读即可；
  // 主题走 app.js 的 'wb:theme' —— 除了采纳新值，还要把 aibuddy-prefs.theme 同步成
  // 同一个值（prefs.js 启动时会用这个值重设 data-theme，不同步就会互相顶掉）
  React.useEffect(() => {
    const onPrefs = () => setPrefs(readShellPrefs())
    const onTheme = (event: Event) => {
      const mode = String((event as CustomEvent).detail || 'system')
      if (prefsRef.current.theme === mode) return
      writeShellPrefs({ theme: mode as ShellPrefs['theme'] })
      setPrefs(readShellPrefs())
    }
    document.addEventListener(PREFS_EVENT, onPrefs)
    window.addEventListener(THEME_EVENT, onTheme)
    return () => {
      document.removeEventListener(PREFS_EVENT, onPrefs)
      window.removeEventListener(THEME_EVENT, onTheme)
    }
  }, [])

  /** 改偏好的唯一通道：写档 → 立即应用 → 广播 → 界面采纳 */
  function commit(patch: Partial<ShellPrefs>, okText?: string): void {
    const next = writeShellPrefs(patch)
    applyShellPrefs(next)
    dispatchPrefsChanged(next)
    setPrefs(next)
    if (okText) toast(okText)
  }

  function changeTheme(mode: string): void {
    // 先调 app.js 的唯一入口（窗口标题栏与 'wb:theme' 都由它处理），再同步偏好存档；
    // applyTheme 派发的 'wb:theme' 会命中上面的同步监听，两次写档是同一个值，无副作用
    applyShellTheme(mode)
    commit({ theme: mode as ShellPrefs['theme'] })
  }

  /** 灰色 / 色弱两个滤镜互斥（与抽屉同款）：开一个自动关另一个 */
  const setFilter = (mode: 'gray' | 'weak') => (next: boolean): void =>
    commit({ filter: next ? mode : '' })

  async function commitLockMinutes(raw: string): Promise<void> {
    const parsed = parseInteger(raw, 0, 1440, '空闲分钟数')
    if (!parsed.ok) { toast(parsed.message, 'err'); return }
    const current = prefsRef.current.lockScreen
    if (parsed.value === current.minutes) return
    commit(
      { lockScreen: { ...current, minutes: parsed.value } },
      `✅ 已保存：空闲 ${parsed.value === 0 ? '不自动锁屏' : `${parsed.value} 分钟`}（刷新页面后生效）`,
    )
  }

  function commitLockPassword(): void {
    const raw = pwDraft
    if (raw === null) return
    setPwDraft(null)
    const current = prefsRef.current.lockScreen
    if (raw === current.password) return
    commit(
      { lockScreen: { ...current, password: raw } },
      raw ? '✅ 已保存锁屏密码（刷新页面后用于解锁校验）' : '✅ 已清除锁屏密码（锁屏后点击即可解锁）',
    )
  }

  function openDrawer(): void {
    // 抽屉没有独立的外部出口，顶栏齿轮按钮（#pref-btn-prefs）就是入口本身：
    // click 它与用户点齿轮完全等价（prefs.js 还挂了 MutationObserver 自愈，按钮常在）
    const button = document.getElementById('pref-btn-prefs')
    if (button) { button.click(); return }
    toast('未找到偏好抽屉按钮（顶栏尚未就绪），请稍后重试', 'err')
  }

  function lockNow(): void {
    // 锁屏遮罩由壳在页面加载时恢复（boot → apply → syncLockScreen 读
    // aibuddy-lockscreen-active），遮罩上的密码输入框用的是**刷新后**读到的偏好 ——
    // 因此不走壳内 lockNow()（那会用壳内存里的旧偏好建遮罩，刚改的密码它不认识）：
    // 先落盘锁屏标记再刷新，刷新后直接进入锁屏，刚保存的密码与分钟数立即生效
    try { localStorage.setItem(PREFS_LOCK_ACTIVE_KEY, '1') } catch { /* 写不进就无法持久锁屏 */ }
    window.location.reload()
  }

  return (
    <>
      <section className='panel'>
        <PanelHead title='偏好设置抽屉' tip={TIPS.prefsDrawer} />
        <div className='panel-body'>
          <div className='hint'>
            偏好抽屉是壳自带的完整偏好入口（外观 / 布局 / 通用 / 锁屏四个页签，外加
            「复制偏好 / 导入偏好 / 恢复默认」）；本分类下面各面板收录其中最常用的项目
            —— 两边改的是同一份配置，改哪处另一处都看得到。
          </div>
          <div className='mt-2.5'>
            <Button id='prefs-open-drawer' variant='outline' onClick={openDrawer}>
              打开偏好设置抽屉
            </Button>
          </div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='主题模式' tip={TIPS.prefsTheme} />
        <div className='panel-body'>
          <div className='retention-list'>
            <div className='retention-row'>
              <label htmlFor='prefs-theme'>界面主题</label>
              <span className='prompt-input'>
                {/* 与「显示 → 显示模式」同款三档；展示文案显式给 SelectValue */}
                <Select
                  value={prefs.theme}
                  onValueChange={next => { if (next != null && String(next)) changeTheme(String(next)) }}
                >
                  <SelectTrigger id='prefs-theme' className='w-[180px]' aria-label='界面主题'>
                    <SelectValue>{THEME_MODES.find(item => item.value === prefs.theme)?.label || prefs.theme}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {THEME_MODES.map(item => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </span>
              <div className='hint'>
                与侧边栏底部的主题三键、偏好抽屉、「显示 → 显示模式」是同一设置的不同入口：
                改哪处，其它处立即跟上（本页同时写入应用主题与偏好存档两处）。
              </div>
            </div>
          </div>
          <div className='settings-state'>{themeStateText(prefs.theme)}</div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='主题色' tip={TIPS.prefsPrimary} />
        <div className='panel-body'>
          <div className='flex flex-wrap gap-2'>
            {PRIMARY_PRESETS.map(([hex, name]) => {
              const active = prefs.primary.toLowerCase() === hex
              return (
                <button
                  key={hex}
                  type='button'
                  title={`${name}（${hex}）`}
                  onClick={() => commit({ primary: hex }, `✅ 主题色：${name}`)}
                  className={'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] '
                    + (active ? 'text-foreground' : 'border-hairline text-subtle')}
                  style={active ? { borderColor: hex } : undefined}
                >
                  <span className='size-3.5 rounded-full border border-hairline' style={{ background: hex }} />
                  {name}
                </button>
              )
            })}
          </div>
          <div className='mt-2.5 flex flex-wrap items-center gap-2.5'>
            <Label className='text-[12.5px] font-medium' htmlFor='prefs-primary-custom'>自定义</Label>
            {/* 原生取色器（组件库没有 color input）：选色即应用，与抽屉的自定义色同源 */}
            <input
              id='prefs-primary-custom'
              type='color'
              className='size-8 cursor-pointer rounded-md border border-hairline bg-transparent p-0.5'
              value={prefs.primary || PRIMARY_DEFAULT}
              onChange={event => commit({ primary: event.target.value })}
            />
            <span className='tabular-nums text-[12px] text-subtle'>{prefs.primary || '跟随默认（紫罗兰）'}</span>
            <Button
              id='prefs-primary-reset'
              variant='outline'
              onClick={() => commit({ primary: '' }, '✅ 已恢复默认主题色（紫罗兰）')}
            >
              恢复默认紫
            </Button>
          </div>
          <div className='hint'>{TIPS.prefsPrimary}</div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='深色与滤镜' />
        <div className='panel-body'>
          <div className='retention-list'>
            <PrefSwitchRow
              id='prefs-dark-sidebar'
              label='深色侧边栏'
              checked={prefs.darkSidebar}
              hint='仅把左侧边栏换成深色配色，内容区跟随当前主题（偏好抽屉「外观」页的同名开关是同一项）。立即生效并记住。'
              onChange={next => commit({ darkSidebar: next })}
            />
            <PrefSwitchRow
              id='prefs-dark-topbar'
              label='深色顶栏'
              checked={prefs.darkTopbar}
              hint='仅把顶部栏换成深色配色，内容区跟随当前主题。立即生效并记住。'
              onChange={next => commit({ darkTopbar: next })}
            />
            <PrefSwitchRow
              id='prefs-watermark'
              label='界面水印'
              checked={prefs.watermark}
              hint={NOTES.prefWatermark}
              onChange={next => commit({ watermark: next })}
            />
            <PrefSwitchRow
              id='prefs-filter-gray'
              label='灰色模式'
              checked={prefs.filter === 'gray'}
              hint='页面整体去色，只保留明暗层级（CSS 滤镜，适合打印 / 专注场景）。与色弱模式互斥：开一个会自动关掉另一个。'
              onChange={setFilter('gray')}
            />
            <PrefSwitchRow
              id='prefs-filter-weak'
              label='色弱模式'
              checked={prefs.filter === 'weak'}
              hint='反转明度并回旋色相，提升相近颜色之间的辨识度（CSS 滤镜）。与灰色模式互斥。'
              onChange={setFilter('weak')}
            />
          </div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='内容宽度与切换动画' />
        <div className='panel-body'>
          <div className='retention-list'>
            <div className='retention-row'>
              <label htmlFor='prefs-content-width'>内容宽度</label>
              <span className='prompt-input'>
                <Select
                  value={prefs.contentWidth}
                  onValueChange={next => {
                    if (next != null && String(next)) commit({ contentWidth: String(next) as ShellPrefs['contentWidth'] })
                  }}
                >
                  <SelectTrigger id='prefs-content-width' className='w-[220px]' aria-label='内容宽度'>
                    <SelectValue>
                      {SHELL_CONTENT_WIDTHS.find(item => item.value === prefs.contentWidth)?.label || prefs.contentWidth}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {SHELL_CONTENT_WIDTHS.map(item => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </span>
              <div className='hint'>
                流式跟随窗口宽度铺满；定宽把内容收进 1200px 版心，宽屏上更易读。立即生效并记住。
              </div>
            </div>
            <div className='retention-row'>
              <label htmlFor='prefs-page-anim'>页面切换动画</label>
              <span className='prompt-input'>
                <Select
                  value={prefs.pageAnim}
                  onValueChange={next => {
                    if (next != null && String(next)) commit({ pageAnim: String(next) as ShellPrefs['pageAnim'] })
                  }}
                >
                  <SelectTrigger id='prefs-page-anim' className='w-[220px]' aria-label='页面切换动画'>
                    <SelectValue>
                      {SHELL_PAGE_ANIMS.find(item => item.value === prefs.pageAnim)?.label || prefs.pageAnim}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {SHELL_PAGE_ANIMS.map(item => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </span>
              <div className='hint'>
                切换页面时的过场效果：无 / 淡入 / 滑入；系统开启「减少动态效果」时自动禁用。
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='界面显示项' />
        <div className='panel-body'>
          <div className='retention-list'>
            <PrefSwitchRow
              id='prefs-topbar-grad'
              label='顶栏渐变'
              checked={prefs.topbarGradient}
              hint='顶栏背景改为「主色 → 紫蓝」横向渐变，浅色 / 深色主题下都协调。'
              onChange={next => commit({ topbarGradient: next })}
            />
            <PrefSwitchRow
              id='prefs-breadcrumb'
              label='面包屑'
              checked={prefs.isBreadcrumb}
              hint='顶栏显示当前页面位置（如「首页 / 报表」）；手机窄屏下始终隐藏。'
              onChange={next => commit({ isBreadcrumb: next })}
            />
            <PrefSwitchRow
              id='prefs-show-logo'
              label='侧栏 Logo'
              checked={prefs.isShowLogo}
              hint='关闭后隐藏侧栏顶部的圆形 Logo，品牌文字保留。'
              onChange={next => commit({ isShowLogo: next })}
            />
            <PrefSwitchRow
              id='prefs-group-label'
              label='折叠时隐藏分组标题'
              checked={prefs.isGroupLabel}
              hint='开启 = 侧栏折叠时隐藏「运行状态」等分组标题；关闭 = 折叠 / 手机抽屉模式也显示。'
              onChange={next => commit({ isGroupLabel: next })}
            />
            <PrefSwitchRow
              id='prefs-menu-highlight'
              label='选中菜单高亮条'
              checked={prefs.menuHighlight}
              hint='当前选中的菜单项左侧额外显示一条主色竖条。'
              onChange={next => commit({ menuHighlight: next })}
            />
            <PrefSwitchRow
              id='prefs-dynamic-title'
              label='动态标题'
              checked={prefs.dynamicTitle}
              hint='把当前页面名写进浏览器标签页标题（如「报表 · AIBuddy Panel」）。'
              onChange={next => commit({ dynamicTitle: next })}
            />
            <PrefSwitchRow
              id='prefs-progressbar'
              label='页面切换进度条'
              checked={prefs.progressbar}
              hint='切换页面时顶部显示细进度条（壳在每次切页时现读偏好，下一次切页起按新值生效）。'
              onChange={next => commit({ progressbar: next })}
            />
            <PrefSwitchRow
              id='prefs-footer'
              label='页脚版权'
              checked={prefs.isFooter}
              hint='在内容区底部显示版权行「© 2026 品牌名 · 基于 agent2api」。'
              onChange={next => commit({ isFooter: next })}
            />
          </div>
          <div className='hint'>{NOTES.prefDisplayItems}</div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='锁屏管理' tip={TIPS.prefsLock} />
        <div className='panel-body'>
          <div className='retention-list'>
            <PrefSwitchRow
              id='prefs-lock-enabled'
              label='启用锁屏'
              checked={prefs.lockScreen.enabled}
              hint='开启后 Ctrl+L 立即锁屏、空闲达到下方分钟数自动锁屏；刷新页面后由壳按保存值接管计时与解锁校验。'
              onChange={next => commit({ lockScreen: { ...prefs.lockScreen, enabled: next } })}
            />
            <div className='retention-row'>
              <label htmlFor='prefs-lock-password'>锁屏密码</label>
              <span className='prompt-input'>
                {/* 草稿机制与提示词文件同款：聚焦抄入生效值，失焦 / 回车提交 */}
                <Input
                  id='prefs-lock-password'
                  type='password'
                  autoComplete='new-password'
                  placeholder='未设置（留空则点击解锁）'
                  value={pwDraft !== null ? pwDraft : prefs.lockScreen.password}
                  onChange={event => setPwDraft(event.target.value)}
                  onFocus={() => setPwDraft(prefs.lockScreen.password)}
                  onBlur={() => commitLockPassword()}
                  onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
                />
              </span>
              <div className='hint'>
                仅明文保存在本机 localStorage，用于本机解锁校验，不上传服务器；留空则锁屏后
                点击即可解锁。失焦或回车保存。
              </div>
            </div>
            <NumberRow
              field={LOCK_MINUTES_FIELD}
              value={prefs.lockScreen.minutes}
              disabled={false}
              onCommit={commitLockMinutes}
            />
          </div>
          <div className='mt-2.5'>
            <Button id='prefs-lock-now' variant='default' onClick={lockNow}>
              立即锁屏
            </Button>
            <div className='hint'>
              先落盘锁屏标记（aibuddy-lockscreen-active）再刷新页面：刷新后直接进入锁屏界面，
              刚保存的密码与分钟数立即生效；解锁后标记自动清除。
            </div>
          </div>
        </div>
      </section>

      <div className='hint retention-note'>{NOTES.prefsPane}</div>
    </>
  )
}

/* ─── 通知与页签（页签栏 / 内容区全屏 / 通知中心的外部出口）────────── */

/** 读页签存档（与 tags-view.js loadTags 同一取向：只认字符串、去重、保序） */
function readTags(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(TAGS_KEY) || '[]')
    if (!Array.isArray(raw)) return [TAGS_HOME]
    const out: string[] = []
    for (const item of raw) {
      if (typeof item === 'string' && item && out.indexOf(item) === -1) out.push(item)
    }
    return out.length ? out : [TAGS_HOME]
  } catch {
    return [TAGS_HOME]
  }
}

function readContentMax(): boolean {
  try { return localStorage.getItem(CONTENT_MAX_KEY) === '1' } catch { return false }
}

/** 未读告警数（通知中心的实时缓存；中心对象不在时给 null，界面显示「—」） */
function readUnread(): number | null {
  const unread = shared().wbNotifyCenter?.unread?.()
  return typeof unread === 'number' ? unread : null
}

/**
 * 「通知与页签」：页签栏与通知中心都有壳官方的外部出口（wbTagsView / wbNotifyCenter），
 * 动作直接调它们 —— 是活的功能，不是只改存档的假开关；页签状态展示读 localStorage
 * （与页签栏自己的持久化同键，刷新 / 动作后重读）。
 */
function ShellPane() {
  const [tags, setTags] = React.useState<string[]>(readTags)
  const [unread, setUnread] = React.useState<number | null>(readUnread)
  const [contentMax, setContentMax] = React.useState<boolean>(readContentMax)

  // Esc 退出内容区全屏由 tags-view.js 处理（写档 + 摘 class），这里只负责把本页
  // 开关的状态跟上来（那边监听在前、写档同步完成后这边才读得到新值）
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setContentMax(readContentMax()) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  function refresh(): void {
    setTags(readTags())
    setUnread(readUnread())
    setContentMax(readContentMax())
  }

  function clearTags(): void {
    const view = shared().wbTagsView
    if (view?.closeAll) {
      // 与页签栏「全部关闭」同一份实现：清单回到只剩首页、立即重绘并跳回首页
      view.closeAll()
      toast('✅ 已清空页签，回到首页')
    } else {
      // 页签栏不在（理论上不会）：退化为只重写存档，刷新后生效
      try { localStorage.setItem(TAGS_KEY, JSON.stringify([TAGS_HOME])) } catch { /* 存储不可用只影响持久化 */ }
      toast('已重置页签存档，刷新页面后生效')
    }
    setTags(readTags())
  }

  function openNotify(): void {
    const center = shared().wbNotifyCenter
    if (center?.open) {
      center.open()
      return
    }
    // 中心对象不在时退化为点铃铛按钮（铃铛由 notify-center.js 自愈，常在）
    const bell = document.getElementById('nc-btn-bell')
    if (bell) { bell.click(); return }
    toast('未找到通知中心（顶栏尚未就绪），请稍后重试', 'err')
  }

  function resetUnread(): void {
    try { localStorage.removeItem(NOTIFY_READ_KEY) } catch { /* 存储不可用时无从清除 */ }
    const center = shared().wbNotifyCenter
    if (center?.refresh) {
      // 清完立即重算：refresh 拉到数据后 firstRunSeed 按当前最新事件重建水位、
      // 角标清零（拉取异步，稍后重读一次未读数把界面跟上来）
      center.refresh()
      toast('✅ 已重置未读：当前告警按已读处理，红点已清零')
      window.setTimeout(() => setUnread(readUnread()), 2000)
    } else {
      toast('已清除已读水位，下一次轮询（60 秒内）后按新事件重新计数')
    }
    setUnread(readUnread())
  }

  function toggleContentMax(on: boolean): void {
    // 与 tags-view.js toggleContentMax 同款：body class 立即生效，存档记住
    document.body.classList.toggle('pref-content-max', on)
    try { localStorage.setItem(CONTENT_MAX_KEY, on ? '1' : '0') } catch { /* 存储不可用只影响持久化 */ }
    setContentMax(on)
  }

  const tagText = tags.map(id => SHELL_TAG_LABELS[id] || id).join('、')

  return (
    <>
      <section className='panel'>
        <PanelHead
          title='页签栏'
          tip={TIPS.shellTags}
          actions={<RefreshButton id='btn-shell-tags-refresh' onClick={refresh} />}
        />
        <div className='panel-body'>
          <div className='retention-list'>
            <div className='retention-row'>
              <label>已打开页签</label>
              <span className='storage-line'>
                <span className='storage-path' title={tagText}>
                  {`${formatCount(tags.length)} 个${tags.length ? `：${tagText}` : ''}`}
                </span>
              </span>
              <div className='hint'>
                页签栏的实时清单以内容区顶部的页签栏为准；本行在进入本页或点「刷新」时读取
                （页签变化不会推送到这里）。
              </div>
            </div>
          </div>
          <div className='mt-2.5'>
            <Button id='btn-shell-tags-clear' variant='outline' onClick={clearTags}>
              清空页签（回到首页）
            </Button>
          </div>
        </div>
      </section>

      <section className='panel'>
        <PanelHead title='内容区全屏' />
        <div className='panel-body'>
          <PrefSwitchRow
            id='prefs-content-max'
            label='隐藏侧栏 / 顶栏 / 页签栏'
            checked={contentMax}
            hint='只留当前页内容 —— 与页签右键菜单的「当前页全屏」是同一个功能，按 Esc 退出；状态记住，刷新后保持。'
            onChange={toggleContentMax}
          />
        </div>
      </section>

      <section className='panel'>
        <PanelHead
          title='通知中心'
          tip={TIPS.shellNotify}
          actions={<RefreshButton id='btn-shell-notify-refresh' onClick={() => setUnread(readUnread())} />}
        />
        <div className='panel-body'>
          <div className='retention-list'>
            <div className='retention-row'>
              <label>未读告警</label>
              <span className='storage-line'>
                <span className='storage-path'>
                  {unread === null ? '—' : `${formatCount(unread)} 条（仅统计 error / warn）`}
                </span>
              </span>
              <div className='hint'>顶栏铃铛上的红点角标读数；打开通知中心面板即全部记为已读。</div>
            </div>
          </div>
          <div className='mt-2.5 flex flex-wrap gap-2.5'>
            <Button id='btn-shell-notify-open' variant='default' onClick={openNotify}>
              打开通知中心
            </Button>
            <Button id='btn-shell-notify-reset' variant='outline' onClick={resetUnread}>
              重置未读
            </Button>
          </div>
          <div className='hint'>{NOTES.shellResetUnread}</div>
        </div>
      </section>

      <div className='hint retention-note'>{NOTES.shellPane}</div>
    </>
  )
}

/* ─── 页面 ─────────────────────────────────── */

function SettingsPage() {
  const snap = useSettings()
  const panesRef = React.useRef<HTMLDivElement | null>(null)

  // 切换分类后把内容栏滚回顶部（旧实现是命令式写 scrollTop）：否则上一类的滚动位置会
  // 带到新分类上，打开「更新」却停在半截。scrollReset 每次 showCategory 都递增，
  // 于是「切回同一分类」（页面重入时 load → restoreCategory）同样会滚回顶部。
  React.useEffect(() => {
    const panes = panesRef.current
    if (panes) panes.scrollTop = 0
  }, [snap.scrollReset])

  const paneClass = (cat: string): string => (snap.category === cat ? 'settings-pane active' : 'settings-pane')

  return (
    <div className='settings-layout'>
      <nav className='settings-nav' id='settings-nav'>
        {CATEGORIES.map(item => (
          <button
            key={item.id}
            type='button'
            className={snap.category === item.id ? 'settings-nav-item active' : 'settings-nav-item'}
            data-cat={item.id}
            onClick={() => selectCategory(item.id)}
          >
            {/* 分类图标（icons.js）：与主侧栏同款 17px 图标盒，颜色随 currentColor
                （选中态自动变主题色） */}
            <span className='ico' dangerouslySetInnerHTML={{ __html: iconHtml(item.icon, 17) }} />
            {item.label}
          </button>
        ))}
      </nav>

      <div className='settings-panes' ref={panesRef}>
        <div className={paneClass('general')} data-cat='general'>
          <GeneralPane snap={snap} />
        </div>
        <div className={paneClass('display')} data-cat='display'>
          <DisplayPane />
        </div>
        <div className={paneClass('brand')} data-cat='brand'>
          <BrandPane snap={snap} />
        </div>
        <div className={paneClass('gateway')} data-cat='gateway'>
          <GatewayPane snap={snap} />
        </div>
        <div className={paneClass('retry')} data-cat='retry'>
          <RetryPane snap={snap} />
        </div>
        <div className={paneClass('timeout')} data-cat='timeout'>
          <TimeoutPane snap={snap} />
        </div>
        <div className={paneClass('security')} data-cat='security'>
          <SecurityPane snap={snap} />
        </div>
        <div className={paneClass('data')} data-cat='data'>
          <DataPane snap={snap} />
        </div>
        <div className={paneClass('prefs')} data-cat='prefs'>
          <PrefsPane />
        </div>
        <div className={paneClass('shell')} data-cat='shell'>
          <ShellPane />
        </div>
        <div className={paneClass('deploy')} data-cat='deploy'>
          <DeployPane snap={snap} />
        </div>
        <div className={paneClass('feedback')} data-cat='feedback'>
          <FeedbackPane />
        </div>
        {/*
          「更新」的面板（原「关于」，id 仍是 about）由另一个岛（update-panel.tsx）接管：
          它按这个选择器找挂载点，找到就把 React root 建在这个 div 上。所以这里必须是
          **空的**、且永远保持同一个元素（不给 children、不改它在兄弟中的位置、不条件渲染）——
          React 对没有 children 的宿主元素不会去动它的 DOM 子树，那个岛的渲染结果才留得住。
          显隐照旧：className 上的 active 由本文件按当前分类切。
        */}
        <div className={paneClass('about')} data-cat='about' />
      </div>

      <RetentionConfirmDialog confirm={snap.retentionConfirm} />
    </div>
  )
}

/* ─── 挂载：接管 index.html 里既有的设置页 section ─── */

const PAGE_SELECTOR = '.page[data-page="settings"]'

let pageRoot: ReturnType<typeof createRoot> | null = null

/**
 * 把 React root 直接建在 `.page[data-page="settings"]` 上（不套宿主 div：页面 CSS 用
 * `.page[data-page="settings"]` 的直接子选择器分配高度与滚动归属）。
 *
 * ── 为什么必须 flushSync ──────────────────────
 * `.settings-pane[data-cat="about"]` 是 update-panel.tsx 的挂载点，它在**自己的模块加载期**
 * 就 `document.querySelector` 这个选择器，找到才建 root。React 19 的 `createRoot().render()`
 * 是并发调度，提交可能落在下一个宏任务 —— 那一刻这个 pane 还没进 DOM，update-panel 只会
 * 退化成等 DOMContentLoaded，而那时它早已过了注册窗口，「设置 → 更新」会整块空白。
 * 两个岛的求值顺序由 glob 的文件名字典序决定（settings-page.tsx 排在 update-panel.tsx 前），
 * 所以这里同步提交之后，它一定能查到。
 *
 * 先 replaceChildren()：React 不替我们清容器，留着静态骨架会与它的接管打架。
 */
function mount(): void {
  if (pageRoot) return
  const section = document.querySelector<HTMLElement>(PAGE_SELECTOR)
  if (!section) return
  section.replaceChildren()
  pageRoot = createRoot(section)
  flushSync(() => { pageRoot?.render(<SettingsPage />) })
}

// 首屏就按上次的选择展开（旧实现在模块加载期做同一件事），不必等 load() 回来；
// load() 里还会再校准一次，覆盖「页面切回来时状态被重置」的情况。
restoreCategory()

// 脚本排在页面骨架之后（index.html 里 islands/ui.js 在各 section 之后），正常直接挂；
// 万一将来被挪到前面，退化成等 DOM 解析完再挂。
if (document.querySelector(PAGE_SELECTOR)) mount()
else document.addEventListener('DOMContentLoaded', mount, { once: true })

/* ─── 注册：对外契约 ─────────────────────────── */

declare global {
  interface Window {
    /**
     * 设置页（替换 ui/settings-panel.js，九个方法与原实现逐字一致）。
     * 调用点：app.js:135 切到设置页时 load()；upgrade-panel.js:74 迁移完成后 load()；
     * update-panel.tsx:972 的「去更新」showCategory('about')。
     */
    wbSettingsPanel?: {
      load(): Promise<void>
      /** 铺启动与托盘设置（旧实现叫 renderSettings，对外名字是 render） */
      render(data?: unknown): void
      renderRetention(data?: unknown): void
      renderRetry(data?: unknown): void
      renderDebug(data?: unknown): void
      renderSanitize(data?: unknown): void
      renderPrompt(data?: unknown): void
      renderStorage(data?: unknown): void
      showCategory(category?: string | null): void
    }
  }
}

window.wbSettingsPanel = {
  load,
  render: renderSettings,
  renderRetention,
  renderRetry,
  renderDebug,
  renderSanitize,
  renderPrompt,
  renderStorage,
  showCategory,
}

// 首屏自持加载：app.js 的 showPage 在脚本加载前已执行过，若上次停留在设置页，
// 这里补一次加载，避免徽标一直停在「检测中…」
if (shared().wbApp?.currentPage === 'settings') void load()
