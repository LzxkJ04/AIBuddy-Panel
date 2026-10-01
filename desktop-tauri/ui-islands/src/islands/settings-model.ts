/**
 * Agent2API · 设置页的**模型层**（桥类型 / 字段表 / 纯函数 / 页面文案）。
 *
 * 从 settings-page.tsx 拆出来：那一份「五个分类 + 十来个面板 + 一个确认框」的视图层装完
 * 已超过项目约定的单文件体量，而这一层的边界很清楚 —— 没有 JSX、没有状态。依赖单向
 * （settings-state.ts 与 settings-page.tsx import 它，它谁都不认识）。
 *
 * 它不是岛：文件名是 .ts，不会被 src/index.tsx 的 `islands/*.tsx` glob 加载；设置页的岛
 * 只有 settings-page.tsx 一个（页面级说明与取舍见它的文件头）。
 *
 * 这里的东西都是「只允许一处说了算」的口径：
 *   · 字段表（保留期 / 重试 / 超时 / 提示词模式）—— 键名必须与后端 config.rs 的常量逐字一致，
 *     散到视图里各写一遍必然漂（旧实现把这份对齐写在 settings-panel.js 的注释里）；
 *   · 页面文案 —— 从 index.html 的静态骨架逐字搬来（提示语 / 说明行 / 开关文字），
 *     静态骨架随本次迁移删除，这些字是页面上唯一的来源；
 *   · 纯函数（校验 / 归一化 / 文案派生）—— 状态层与视图层都要用。
 */

/* ─── 桥与共享全局 ─────────────────────────── */

/** 启动与托盘设置（壳命令 get_app_settings / save_app_settings） */
export type AppSettings = { closeToTray: boolean; autostart: boolean }

/** 导入失败项：customProvider 标记的那条不是账号，是自定义提供商定义 */
export type ImportError = { id?: string; message?: string; customProvider?: boolean }

/** 导入结果（壳命令 import_accounts） */
export type ImportResult = {
  canceled?: boolean
  total?: number
  added?: number
  updated?: number
  skipped?: number
  failed?: number
  errors?: ImportError[]
  /** v2 导出文件附带的自定义提供商定义统计 */
  customProviders?: { added?: number; updated?: number }
}

/** 导出结果（壳命令 export_accounts） */
export type ExportResult = {
  canceled?: boolean
  count?: number
  /** v2 导出文件附带的自定义提供商定义条数 */
  customProviders?: number
  file?: string
}

/**
 * 网关自带提示词的**三段正文**（身份句 / 稳定段 / 动态段）。
 *
 * 三段各自成块是上游对身份的**结构**要求（实测：三段并成一段 → 405/3012，
 * 见后端 `zcode::OFFICIAL_PROMPT_NOTE`），所以界面与配置都按段来，不做
 * 「合成一整段」的编辑方式。动态段里的运行值写成占位符（`{cwd}` 等），
 * 发请求时才换成真实值。
 */
export type GatewayBlocks = { identity: string; stable: string; dynamic: string }

/** 提示词写入载荷：只传变化的那一项（后端允许部分字段），clearDegrade 是同一端点上的动作位 */
export type PromptPatch = {
  promptMode?: string
  promptFile?: string
  /**
   * 界面里编辑的提示词正文（**优先于** `promptFile` 与内置默认）。空串 = 清除
   * 这一份、回落文件 / 内置默认；缺失 = 这一项不改。
   */
  promptText?: string
  /**
   * 按提供商的覆盖：`{ "<providerId>": {promptMode?, promptFile?, promptText?} | null }`
   * （键名与全局那几项、以及响应里每家的字段完全一致，三处只有一套名字）。
   * 值是 `null` = 删掉这一家的覆盖（回落全局设置）；整张表缺失 = 这一维不改。
   */
  promptProviders?: Record<
    string,
    { promptMode?: string; promptFile?: string; promptText?: string } | null
  >
  /**
   * 网关自带提示词的逐家开关：`{ "<providerId>": true | false | null }`。
   * 值 `null` = 删键回到默认（装）；整张表缺失 = 这一维不改（与上面那张表同一约定）。
   */
  promptGateway?: Record<string, boolean | null>
  /**
   * 网关自带提示词的**正文覆盖**：`{ "<providerId>": {identity?, stable?, dynamic?} | null }`。
   * 段是**部分更新**（未出现的段保持原值，空串 = 这一段回到官方原文）；值 `null` =
   * 这一家整个回到官方原文。
   */
  promptGatewayText?: Record<string, Partial<GatewayBlocks> | null>
  clearDegrade?: boolean
}

/** 本页用到的壳 / HTTP 桥（方法名与 bridge.rs 一一对应，一个都不能改） */
export type SettingsBridge = {
  /** 'desktop' | 'web'：面板登录那一块只在网页端有意义 */
  platform?: string
  getAppSettings(): Promise<AppSettings | null | undefined>
  saveAppSettings(patch: AppSettings): Promise<AppSettings | null | undefined>
  exportAccounts(): Promise<ExportResult | null | undefined>
  importAccounts(): Promise<ImportResult | null | undefined>
  getRetention(): Promise<unknown>
  saveRetention(patch: Record<string, number>): Promise<unknown>
  getRetry(): Promise<unknown>
  saveRetry(patch: Record<string, unknown>): Promise<unknown>
  getTimeouts(): Promise<unknown>
  saveTimeouts(patch: Record<string, number>): Promise<unknown>
  getQueue(): Promise<unknown>
  saveQueue(patch: Record<string, number>): Promise<unknown>
  getDebug(): Promise<unknown>
  saveDebug(enabled: boolean): Promise<unknown>
  getSanitize(): Promise<unknown>
  saveSanitize(enabled: boolean): Promise<unknown>
  getPrompt(): Promise<unknown>
  savePrompt(payload: PromptPatch): Promise<unknown>
  getStorage(): Promise<unknown>
  getCaptchaSetting(): Promise<{ captchaEnabled?: boolean } | null | undefined>
  saveCaptchaSetting(on: boolean): Promise<{ captchaEnabled?: boolean } | null | undefined>
  panelLogout(): Promise<unknown>
  /** 最近一次「检查更新」结果（currentVersion 用于部署信息分区；web_shim 与桌面桥都有） */
  getUpdateStatus?(): Promise<{ currentVersion?: string } | null | undefined>
  /* ── 数据维护（web_shim 全有；桌面桥缺失时按钮 toast 提示，不会静默假成功）── */
  /** 事件日志统计：{total, max, byLevel, lastId, file} */
  getLogStats?(): Promise<unknown>
  /** 清空事件日志：全清必须显式 all='1'（后端护栏，缺参数给 400） */
  clearLogs?(query: Record<string, string>): Promise<unknown>
  /** 请求记录清理预览：{all, raw, dbBytes, vacuumRunning, lastVacuum} */
  getStatsClearPreview?(query?: Record<string, string>): Promise<unknown>
  /** 清理请求记录：mode=all 删明细（含原始正文）/ mode=raw 只删原始正文 */
  clearStatsRequests?(query?: Record<string, string>): Promise<unknown>
  /** 压缩数据库（checkpoint + VACUUM，后台线程执行；进行中重复触发给 409） */
  compactStatsDb?(): Promise<unknown>
  /* ── 品牌外观（网页端专属保存通道；桌面桥没有对应命令，UI 如实提示）── */
  /** 读取品牌：{title: string|null, logo: string|null}（logo 是 data URL） */
  getBranding?(): Promise<{ title?: string | null; logo?: string | null } | null | undefined>
  /** 保存品牌：两键均可空（null = 回默认 / 移除）；服务端校验长度与格式 */
  saveBranding?(patch: { title?: string | null; logo?: string | null }): Promise<unknown>
  /** 打开外链的唯一出口（只放行 http(s)）：桌面走系统浏览器，网页端 shim 是 window.open */
  openReleasePage?(url: string): Promise<unknown>
}

/**
 * window 上由其它脚本 / 其它岛挂载的共享桥。
 *
 * 刻意用「局部窄类型 + 转型」而不是 declare global 往 Window 上加属性：
 * workbuddyDesktop / wbApp / wbUnits 是多个岛共用的桥，各岛各 declare 一份会因同名属性
 * 类型不一致直接报 TS2717（并行迁移时必然撞车）。这里只认本页用到的成员；
 * 设置页独占的 wbSettingsPanel 由 settings-page.tsx 自己 declare。
 */
export type SharedWindow = {
  workbuddyDesktop?: SettingsBridge
  wbApp?: {
    toast?: (message: string, kind?: 'err' | 'ok') => void
    /** 账号被导入改动后让主界面重绘（账号列表、导航计数） */
    refresh?: () => Promise<void> | void
    /** 当前页标识：脚本加载时若已停在设置页，补一次 load() */
    readonly currentPage?: string
    /** 应用显示模式（system / light / dark）：实现与持久化都在 app.js，本页只调用 */
    applyTheme?: (mode: string) => void
    /** 应用界面缩放（传百分数，如 105）：由 app.js 落到 WebView 层并记档 */
    applyZoom?: (percent: number) => void
  }
  /** Token 计量单位的展示口径（units.js）：本页只负责拨开关，格式化在那边 */
  wbUnits?: { isChinese?: () => boolean; setChinese?: (on: boolean) => void }
  /** 软件更新面板的岛（update-panel.tsx）：切到设置页时让它自己刷新一次 */
  wbUpdatePanel?: { load?: () => Promise<void> | void }
  /** 内联图标集（icons.js）：左栏分类图标由它渲染（返回 SVG 串，注入用） */
  wbIcons?: { icon?: (name: string, size?: number) => string }
  /** 页签栏（tags-view.js）的官方外部出口：closeAll 是「全部关闭」的同一份实现 */
  wbTagsView?: {
    open?(page: string): void
    close?(page: string): void
    closeAll?(): void
    list?(): string[]
  }
  /** 通知中心（notify-center.js）的官方外部出口：open / refresh / unread 都是真的 */
  wbNotifyCenter?: {
    refresh?(): void
    open?(): void
    close?(): void
    unread?(): number
  }
}

export function shared(): SharedWindow {
  return window as unknown as SharedWindow
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** toast 的统一出口（运行期读 wbApp，不在模块顶层解构） */
export function toast(message: string, kind?: 'err' | 'ok'): void {
  shared().wbApp?.toast?.(message, kind)
}

/**
 * 打开外链：一律交给系统默认浏览器（桌面走壳命令 `open_release_page`，网页端
 * shim 把它映射成 window.open）—— 与 update-shared 的同名函数是**两份实现**，
 * 不跨族 import 是刻意的：这里服务设置页（反馈与需求），那边服务更新面板一族，
 * 各自只依赖自己那份桥类型；但也别再加第三份，要用先从这两处挑。
 */
export async function openExternal(url: string): Promise<void> {
  try {
    await shared().workbuddyDesktop?.openReleasePage?.(url)
  } catch (error) {
    toast(`打开链接失败：${errorMessage(error)}`, 'err')
  }
}

/* ─── 分类与偏好键 ─────────────────────────── */

/**
 * 左侧分类。顺序 = 界面顺序；showCategory 用它校验传进来的值（旧实现是查 DOM，
 * 这里改成查这份表 —— 分类不再由 HTML 声明，而是本页渲染出来的）。
 *
 * 「重试」「超时」从「网关」里拆出来独立成菜单（原先挤在网关一栏里，排在排队等待
 * 两侧）：这两组是**每次转发都会读**的网络行为参数，出问题时最常被翻，单独一栏
 * 少一次翻找。数据加载本就不分分类（settings-state 的 load 一次并行取全部），
 * 拆分只是视图层的两段搬迁。
 *
 * 「显示」紧跟「通用」：显示模式 / 界面缩放 / 语言都是**纯前端偏好**（存在
 * localStorage 里，与主题同族），不碰后端配置 —— 放在最前面那几栏里最顺手。
 *
 * 「反馈与需求」是纯跳转面板（三个 GitHub issue 表单入口，见 settings-page 的
 * FeedbackPane），排在「更新」上面 —— 都是「对外」的两栏，挨着放。
 *
 * `icon` 是 icons.js 里那组设置页分类图标的键（描边风格，见那边的说明）；标签
 * 不再受两字限制，图标负责在窄栏里一眼认出，文字负责说清。
 *
 * 「更新」（原「关于」）**id 保持 `about` 不变**：它同时是 update-panel.tsx 的挂载点
 * 选择器（`.settings-pane[data-cat="about"]`）与用户 localStorage 里存着的分类值，
 * 改名会让两者当场失配 —— 用户看到的只是标签，id 是内部契约。
 *
 * 「偏好与外观」（prefs）与「通知与页签」（shell）把最近新增的外壳功能（偏好抽屉 /
 * 页签栏 / 通知中心）纳入后台设置：这两栏管的全是**本机偏好**（localStorage 的
 * aibuddy-prefs / aibuddy-tags / aibuddy-notify-read 等），与后端配置无关，所以排在
 * 「数据」之后、「部署信息」之前 —— 后端类的分类看完，再看本机观感类的收尾。
 * 图标沿用 icons.js 里现成的描边图标（sliders 与「通用」同款、feedback 与「反馈」同款）。
 *
 * 「通知中心」（notify）是**后端配置类**分类（通知渠道与告警事件路由都存在网关配置里，
 * 与「通知与页签」那栏的本机偏好不是一回事），所以插在「数据」之后、「偏好与外观」之前
 * —— 任务要求它排在「通知与页签」之前，而它管的又是后端的事，紧跟后端类的「数据」
 * 最顺；图标取 'bell'（icons.js 的设置页分类组目前还没有这个键，视图层有一枚
 * 同源描边兜底，见 settings-page 的 categoryIconHtml）。
 */
export const CATEGORIES = [
  { id: 'general', label: '通用', icon: 'sliders' },
  { id: 'display', label: '显示', icon: 'display' },
  { id: 'brand', label: '品牌', icon: 'brand' },
  { id: 'gateway', label: '网关', icon: 'traffic' },
  { id: 'retry', label: '重试', icon: 'refresh' },
  { id: 'timeout', label: '超时', icon: 'timer' },
  { id: 'security', label: '安全', icon: 'shield' },
  { id: 'data', label: '数据', icon: 'database' },
  { id: 'notify', label: '通知中心', icon: 'bell' },
  { id: 'prefs', label: '偏好与外观', icon: 'sliders' },
  { id: 'shell', label: '通知与页签', icon: 'feedback' },
  { id: 'deploy', label: '部署信息', icon: 'pulse' },
  { id: 'feedback', label: '反馈与需求', icon: 'feedback' },
  { id: 'about', label: '更新', icon: 'download' },
] as const

/**
 * 「设置页当前分类」的 localStorage 键：纯前端偏好（与主题、计量单位同类），
 * 主进程不参与。键名沿用旧实现的取值，别改 —— 否则用户上次停留的分类会丢。
 */
export const SETTINGS_CAT_KEY = 'workbuddy-desktop-settings-cat'

/* ─── 显示偏好（「显示」分类） ───────────────── */

/**
 * 「显示」分类的三项偏好：显示模式 / 界面缩放 / 语言。
 *
 * ⚠ 前两项的**应用入口都不在本页**，而在 ui/app.js（applyTheme / applyZoom）：
 *   · 主题还要同步操作系统标题栏的深浅色，并处理「跟随系统」时窗口主题会污染
 *     WebView 颜色偏好的问题（那段长注释在 app.js）；
 *   · 缩放要走 WebView 层（壳命令 set_zoom），不是页面自己能做完的事。
 * 本页只做两件事：**读** localStorage 把控件摆到当前值上；改动时调
 * `wbApp.applyTheme / applyZoom`，再靠 'wb:theme' / 'wb:zoom' 事件跟随 ——
 * 侧边栏的主题三键与这里的档位是同一个设置的两个入口，必须互相同步。
 *
 * 键名与 app.js 里的字面量是同一份契约（两侧各写一份，改一处必然漂）；
 * 事件名同理（app.js 派发，本页监听）。
 */
export const THEME_KEY = 'workbuddy-desktop-theme'
export const ZOOM_KEY = 'workbuddy-desktop-zoom'
export const THEME_EVENT = 'wb:theme'
export const ZOOM_EVENT = 'wb:zoom'

/** 缩放档位边界与步长：与 app.js 的 ZOOM_MIN / ZOOM_MAX / ZOOM_STEP 同源 */
export const ZOOM_MIN = 80
export const ZOOM_MAX = 130
export const ZOOM_STEP = 5

/** 缩放候选项（80% ~ 130%，5% 一档共 11 档）：下拉的 value 就是百分数本身 */
export const ZOOM_PERCENTS: number[] = Array.from(
  { length: (ZOOM_MAX - ZOOM_MIN) / ZOOM_STEP + 1 },
  (_, index) => ZOOM_MIN + index * ZOOM_STEP,
)

/**
 * 显示模式三档：value 与 app.js / `data-theme` 的取值逐字一致（system / light / dark）。
 * 文案取侧边栏那三个按钮的 title（跟随设备 → 跟随系统，是同一件事的两种叫法，
 * 这里用了更书面的一种）。
 */
export const THEME_MODES = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const

/** 显示模式取值（SegmentedControl 的泛型参数要用它，免得在视图里转字面量联合） */
export type ThemeMode = (typeof THEME_MODES)[number]['value']

/**
 * 语言选项：目前只有简体中文一种，先摆成单选题把位置占住（用户明确要的形态）。
 * 不做持久化 —— 界面文案现在全是写死的中文，选了也不改变任何东西；真加语言时
 * 这里就是唯一要长出来的地方（值改成 BCP 47 标签，如 zh-CN / en）。
 */
export const LANGUAGES = [{ value: 'zh-CN', label: '简体中文' }] as const

/** 读当前显示模式（app.js 是写入方）：读到非法值按跟随系统 */
export function readThemeMode(): ThemeMode {
  try {
    const mode = localStorage.getItem(THEME_KEY)
    return mode === 'light' || mode === 'dark' ? mode : 'system'
  } catch {
    return 'system'
  }
}

/** 读当前缩放（百分数）：非法 / 越界值回落 100，与 app.js 的 storedZoom 同一口径 */
export function readZoomPercent(): number {
  try {
    const text = localStorage.getItem(ZOOM_KEY)
    // 空串 / 缺失要单独挡：Number('') 与 Number(null) 都是 0（不是 NaN），
    // 不挡就会被当成「0%」一路夹到 80% —— 「没设过」必须等于默认的 100%
    if (text === null || text.trim() === '') return 100
    const raw = Number(text)
    if (!Number.isFinite(raw)) return 100
    const snapped = Math.round(raw / ZOOM_STEP) * ZOOM_STEP
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, snapped))
  } catch {
    return 100
  }
}

/* ─── 外壳偏好（「偏好与外观」「通知与页签」两分类的键与口径） ── */

/**
 * 外壳功能的存储键（与 ui/js/prefs.js / notify-center.js / tags-view.js 逐字同源 ——
 * 那边都是封闭 IIFE，两边只能靠「同一份键名」对齐，改一处必然要改另一处）。
 *
 * ⚠ prefs.js **不监听**任何事件：'aibuddy-prefs-changed' 只是它每次 apply() 之后在
 * document 上派发的广播（今天没有任何监听者）。所以设置页改完偏好后「立即生效」
 * 由设置页自己做 —— 逐条镜像 apply() 对这批键的 DOM 效果（见 settings-page 的
 * applyShellPrefs），壳下次加载时从 localStorage 读到同一批值重新应用，两边不会漂。
 * 这里照样派发同款事件（detail 是整份偏好）：维持「改了偏好就广播」的既定契约，
 * 留给未来的监听者，而不是假装壳会替我们重应用。
 */
export const PREFS_KEY = 'aibuddy-prefs'
export const PREFS_EVENT = 'aibuddy-prefs-changed'
/** 锁屏「正在锁定」标记：prefs.js boot 时读到 '1' 就恢复锁屏遮罩；解锁时移除 */
export const PREFS_LOCK_ACTIVE_KEY = 'aibuddy-lockscreen-active'
/** 通知中心已读水位：{id, ts}（notify-center.js 读写；清掉即「按当前事件重算已读」） */
export const NOTIFY_READ_KEY = 'aibuddy-notify-read'
/** 页签清单（tags-view.js 读写，数组 of page id；overview 永远第一且不可关闭） */
export const TAGS_KEY = 'aibuddy-tags'
export const TAGS_HOME = 'overview'
/** 内容区全屏（tags-view.js：藏侧栏 / 顶栏 / 页签栏，Esc 退出）'1' = 开 */
export const CONTENT_MAX_KEY = 'aibuddy-content-max'

/**
 * 偏好存档（aibuddy-prefs）里本页管理的键。字段名与 prefs.js 的 DEFAULTS 一致；
 * 本页不管理的键（如 layout）读写时原样保留，不会冲掉用户在抽屉里配过的值。
 */
export type ShellPrefs = {
  theme: 'light' | 'dark' | 'system'
  darkSidebar: boolean
  darkTopbar: boolean
  /** 空 = 用 tokens.css 默认紫罗兰 */
  primary: string
  contentWidth: 'fluid' | 'boxed'
  dynamicTitle: boolean
  progressbar: boolean
  watermark: boolean
  /** '' | gray | weak（互斥，与 prefs.js sanitize 同一口径） */
  filter: '' | 'gray' | 'weak'
  pageAnim: 'none' | 'fade' | 'slide'
  isBreadcrumb: boolean
  isFooter: boolean
  isShowLogo: boolean
  isGroupLabel: boolean
  topbarGradient: boolean
  menuHighlight: boolean
  lockScreen: { enabled: boolean; password: string; minutes: number }
}

/**
 * 偏好归一化（镜像 prefs.js 的 sanitize：越界值拉回合法档位，缺省补默认）。
 * 缺省值与 DEFAULTS / sanitize 逐字对齐：三个「默认开」的项（动态标题 / 进度条 /
 * 面包屑 / Logo / 分组标题）missing 时按开，其余按关。
 */
export function normalizeShellPrefs(raw: unknown): ShellPrefs {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const bool = (value: unknown, fallback: boolean): boolean =>
    value === undefined || value === null ? fallback : Boolean(value)
  const lock = (p.lockScreen && typeof p.lockScreen === 'object' ? p.lockScreen : {}) as Record<string, unknown>
  const minutes = Math.floor(Number(lock.minutes))
  return {
    theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'system',
    darkSidebar: p.darkSidebar === true,
    darkTopbar: p.darkTopbar === true,
    primary: typeof p.primary === 'string' ? p.primary : '',
    contentWidth: p.contentWidth === 'boxed' ? 'boxed' : 'fluid',
    dynamicTitle: bool(p.dynamicTitle, true),
    progressbar: bool(p.progressbar, true),
    watermark: p.watermark === true,
    filter: p.filter === 'gray' || p.filter === 'weak' ? p.filter : '',
    pageAnim: p.pageAnim === 'fade' || p.pageAnim === 'slide' ? p.pageAnim : 'none',
    isBreadcrumb: bool(p.isBreadcrumb, true),
    isFooter: p.isFooter === true,
    isShowLogo: bool(p.isShowLogo, true),
    isGroupLabel: bool(p.isGroupLabel, true),
    topbarGradient: p.topbarGradient === true,
    menuHighlight: p.menuHighlight === true,
    lockScreen: {
      enabled: lock.enabled === true,
      password: typeof lock.password === 'string' ? lock.password : '',
      minutes: Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 1440) : 0,
    },
  }
}

/** 12 色内置主题板（prefs.js PRIMARY_PRESETS 的逐字副本 —— 两处共用一份口径） */
export const PRIMARY_PRESETS: ReadonlyArray<readonly [string, string]> = [
  ['#2563eb', '默认蓝'], ['#7c5cfc', '紫罗兰'], ['#ec4899', '樱花粉'],
  ['#eab308', '柠檬黄'], ['#3b82f6', '天蓝'], ['#10b981', '浅绿'],
  ['#3f3f46', '锌灰'], ['#0d9488', '深绿'], ['#1d4ed8', '深蓝'],
  ['#f97316', '橙黄'], ['#e11d48', '玫红'], ['#27272a', '中性'],
]

/** 默认主题色（prefs.js 自定义取色器的回落值，也是「恢复默认」的目标） */
export const PRIMARY_DEFAULT = '#7c5cfc'

/** 内容宽度档位（value 与 prefs.js 存档值逐字一致） */
export const SHELL_CONTENT_WIDTHS = [
  { value: 'fluid', label: '流式（跟随窗口宽度）' },
  { value: 'boxed', label: '定宽（1200px 版心）' },
] as const

/** 页面切换动画档位（value 与 prefs.js 存档值逐字一致） */
export const SHELL_PAGE_ANIMS = [
  { value: 'none', label: '无（默认）' },
  { value: 'fade', label: '淡入' },
  { value: 'slide', label: '滑入' },
] as const

/**
 * 页签 id → 文案（tags-view.js LABELS 的镜像，仅展示用：页签栏自己优先取侧栏导航
 * 上的现成文案，这里取不到 DOM 时兜底；两处改动需同步）。
 */
export const SHELL_TAG_LABELS: Record<string, string> = {
  overview: '报表',
  accounts: '账号',
  gateway: '模型管理',
  proxies: '网络代理',
  keys: '网关 Key',
  docs: '文档',
  logs: '日志',
  tasks: '定时任务',
  requests: '请求日志',
  settings: '设置',
}

/* ─── 通知渠道与告警路由（「通知中心」分类） ─── */

/**
 * 单个通知渠道（`GET /api/notify/channels` 的 channels 项）。
 *
 * `config` 的键名按渠道类型各有一套（见 NOTIFY_TYPES 的字段表），值统一按字符串
 * 处理 —— 后端存的是字符串表，界面也不再自作聪明转数字（多一处转换就多一处漂）。
 */
export type NotifyChannel = {
  /** 渠道 id：测试接口按它点名渠道；新建时由界面生成（后端全量保存不补 id） */
  id: string
  name: string
  type: string
  enabled: boolean
  config: Record<string, string>
}

/** 告警事件路由（`GET /api/notify/alerts` 的 data） */
export type NotifyAlerts = {
  /** 总开关：关闭后任何事件都不做外部推送（事件照常写事件日志） */
  enabled: boolean
  events: {
    /** 429 降级告警：账号触发上游 429、被降级并换号时 */
    onDegraded: boolean
    /** 账号掉线与失败告警：登录态失效 / 凭证刷新失败 / 连续转发失败时 */
    onOffline: boolean
    /** 探活自动禁用告警：定时探活连败达到阈值、账号被自动停用时 */
    onProbeDisabled: boolean
  }
  /** 静默时段起止（HH:mm，本地时区；两端都空 = 不启用静默） */
  quietStart: string
  quietEnd: string
}

/**
 * 通知接口的直连出口（`/api/notify/*`）。
 *
 * 设置页的其它数据都走 window.workbuddyDesktop 桥（bridge.rs / web_shim.rs 各实现
 * 一份）；通知这组端点两份桥都还没有（后端刚起），而桌面端与网页端的面板**都是同源
 * HTTP**（桌面端的网关跑在应用进程内、面板由它伺服），fetch 直连在两种形态下都能用
 * —— 与「部署信息」分区 checkUpdateNow 打 /api/update/check 是同一模式。
 *
 * 响应按网关的 `{success, data}` 信封拆包（与 web_shim 的 httpCall 同一口径）：
 * 非 2xx 或 `success === false` 抛 Error（文案取 error / message / msg）；
 * 有 `data` 键取 `data`，否则原样返回（PUT 契约写的是裸 `{channels:[…]}`，两种都接）。
 * 401 的静默续期 / Key 兜底不在本函数里 —— 那是桥的职责，直连绕过了它；会话过期时
 * 这里只会如实报错，用户重新登录后一切恢复。
 */
export async function notifyApi<T = unknown>(
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: 'application/json' } }
  if (method !== 'GET') {
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
    const message = typeof detail === 'string'
      ? detail
      : detail && typeof detail === 'object' && typeof (detail as Record<string, unknown>).message === 'string'
        ? String((detail as Record<string, unknown>).message)
        : JSON.stringify(detail)
    throw new Error(message)
  }
  return (record && Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : payload) as T
}

/** 渠道类型字段表里的一项 */
export type NotifyFieldSpec = {
  /** config 的键名（与后端逐字一致） */
  key: string
  label: string
  /** 字段说明（表单里渲染在输入框下方） */
  hint: string
  placeholder?: string
  /** 密钥类字段：卡片摘要与测试文案里打码，不回显全文 */
  secret?: boolean
  /** 多行文本（自定义模板 / 请求头 JSON） */
  multiline?: boolean
  rows?: number
  /** 必填（false = 选填，如钉钉加签密钥、自定义 Webhook 的请求头） */
  required?: boolean
  /** 新建渠道时该字段的初始值（如 Bark 的官方地址） */
  initial?: string
}

/** 渠道类型注册表里的一项 */
export type NotifyTypeSpec = {
  /** type 值（与后端逐字一致） */
  type: string
  /** 中文名（下拉、类型徽章用） */
  label: string
  /** 一句话说明（下拉项下方、卡片摘要兜底） */
  desc: string
  fields: NotifyFieldSpec[]
}

/**
 * 16 种渠道类型与各自的 config 字段表。
 *
 * 键名与后端的渠道配置逐字对齐（webhook 的 url、telegram 的 botToken / chatId …）；
 * 说明文案按「是什么 / 到哪里拿 / 填什么形态」写，新用户不看文档也能填对。
 * 顺序 = 添加渠道下拉里的顺序：通用 Webhook 在前，IM 机器人居中，专用推送服务殿后。
 */
export const NOTIFY_TYPES: NotifyTypeSpec[] = [
  {
    type: 'webhook',
    label: 'Webhook',
    desc: '通用 Webhook：以 POST 方式向该地址发送 JSON 告警（含 title / body 字段）。',
    fields: [
      {
        key: 'url',
        label: '接收地址 URL',
        hint: '接收 POST 请求的完整地址（http:// 或 https://）。网关会把告警装成 JSON（含 title、body、时间与事件类型）整体发过去，适合自建接收端或 n8n、Huginn 等自动化平台。',
        placeholder: 'https://example.com/hook',
        required: true,
      },
    ],
  },
  {
    type: 'webhook-custom',
    label: '自定义 Webhook',
    desc: '自定义报文模板与请求头的 Webhook：报文长什么样由模板决定。',
    fields: [
      {
        key: 'url',
        label: '接收地址 URL',
        hint: '接收 POST 请求的完整地址（http:// 或 https://）。',
        placeholder: 'https://example.com/hook',
        required: true,
      },
      {
        key: 'template',
        label: '报文模板',
        hint: 'POST 的正文按这个模板渲染：{{title}} 替换为告警标题、{{body}} 替换为正文。留空则发送默认 JSON（{title, body}）。需要发到只认固定格式的平台（如企业应用的自定义机器人）时用它。',
        placeholder: '{"msgtype":"text","text":{"content":"{{title}}\\n{{body}}"}}',
        multiline: true,
        rows: 5,
      },
      {
        key: 'headers',
        label: '自定义请求头（JSON）',
        hint: '随请求一并发送的 HTTP 头，写成一个 JSON 对象，如 {"Content-Type":"application/json","X-Token":"abc"}。留空则只带默认的 Content-Type。',
        placeholder: '{"Content-Type":"application/json"}',
        multiline: true,
        rows: 3,
      },
    ],
  },
  {
    type: 'telegram',
    label: 'Telegram',
    desc: 'Telegram Bot 推送：把告警发到指定聊天（私聊或群组）。',
    fields: [
      {
        key: 'botToken',
        label: 'Bot Token',
        hint: '找 @BotFather 创建机器人后获取（形如 123456:ABC-DEF…）。机器人要先与目标聊天下过一句话（私聊发 /start、群里把它拉进来发条消息），否则发不出去。',
        placeholder: '123456789:AAF…',
        secret: true,
        required: true,
      },
      {
        key: 'chatId',
        label: 'Chat ID',
        hint: '接收消息的聊天 ID：私聊是一个正整数，群组是负数（-100 开头常见）。可向 @userinfobot 或 @getidsbot 查询；把机器人拉进群后它也能从 getUpdates 里看到。',
        placeholder: '-1001234567890',
        required: true,
      },
    ],
  },
  {
    type: 'discord',
    label: 'Discord',
    desc: 'Discord 频道 Webhook：告警直接进指定频道的消息流。',
    fields: [
      {
        key: 'url',
        label: 'Webhook URL',
        hint: 'Discord 频道的 Webhook 地址：服务器设置 → 整合 → Webhook → 新建（或复用现有的），复制完整 URL（https://discord.com/api/webhooks/…）。',
        placeholder: 'https://discord.com/api/webhooks/…',
        required: true,
      },
    ],
  },
  {
    type: 'slack',
    label: 'Slack',
    desc: 'Slack Incoming Webhook：告警作为消息发进指定频道。',
    fields: [
      {
        key: 'url',
        label: 'Webhook URL',
        hint: 'Slack 的 Incoming Webhook 地址（https://hooks.slack.com/services/…）：在 Slack App 设置里启用 Incoming Webhooks、为目标频道添加一条后复制。旧版 Legacy 网址同样可用。',
        placeholder: 'https://hooks.slack.com/services/…',
        required: true,
      },
    ],
  },
  {
    type: 'dingtalk',
    label: '钉钉机器人',
    desc: '钉钉群自定义机器人 Webhook，支持「加签」安全设置。',
    fields: [
      {
        key: 'url',
        label: 'Webhook URL',
        hint: '钉钉群设置 → 群机器人 → 添加「自定义」机器人后拿到的完整 Webhook 地址（https://oapi.dingtalk.com/robot/send?access_token=…）。安全设置建议选「加签」。',
        placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…',
        required: true,
      },
      {
        key: 'secret',
        label: '加签密钥（选填）',
        hint: '机器人安全设置选「加签」时的密钥（SEC 开头）。填写后网关自动按 HmacSHA256 + base64 计算时间戳签名并附在请求上，不需要手动拼接；安全设置选「自定义关键词」的可以留空（告警标题里含「告警」关键词可命中）。',
        placeholder: 'SEC…',
        secret: true,
      },
    ],
  },
  {
    type: 'feishu',
    label: '飞书机器人',
    desc: '飞书群自定义机器人 Webhook。',
    fields: [
      {
        key: 'url',
        label: 'Webhook URL',
        hint: '飞书群设置 → 群机器人 → 添加「自定义机器人」后拿到的完整地址（https://open.feishu.cn/open-apis/bot/v2/hook/…）。若开启了签名校验，地址与签名密钥一并算在网关的加签逻辑内。',
        placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
        required: true,
      },
    ],
  },
  {
    type: 'wecom',
    label: '企业微信机器人',
    desc: '企业微信群机器人 Webhook。',
    fields: [
      {
        key: 'url',
        label: 'Webhook URL',
        hint: '企业微信群的「群机器人」拿到的完整地址（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…），key 保持在地址里整段抄下来。',
        placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
        required: true,
      },
    ],
  },
  {
    type: 'bark',
    label: 'Bark',
    desc: 'iOS 推送 App Bark：告警作为系统通知直达 iPhone。',
    fields: [
      {
        key: 'url',
        label: 'Bark 服务地址',
        hint: 'Bark 服务端地址：用官方服务保持默认 https://api.day.app 即可；自建 Bark Server 的填自己的地址。',
        placeholder: 'https://api.day.app',
        initial: 'https://api.day.app',
        required: true,
      },
      {
        key: 'key',
        label: '推送 Key',
        hint: 'Bark App 首页显示的设备推送 Key（一串字母数字）。App 里可以复制完整的推送 URL，其中路径段就是 Key。',
        placeholder: 'QH7yFeZ…',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'gotify',
    label: 'Gotify',
    desc: '自托管消息服务 Gotify：推送到指定应用的消息通道。',
    fields: [
      {
        key: 'url',
        label: 'Gotify 服务地址',
        hint: '自建 Gotify 的根地址（http:// 或 https://），如 https://push.example.com。',
        placeholder: 'https://push.example.com',
        required: true,
      },
      {
        key: 'token',
        label: 'Application Token',
        hint: 'Gotify 网页端 → Apps → 创建应用后拿到的 Application Token（以 A 开头的一串；不是客户端的 User Token，别抄错）。',
        placeholder: 'Axxxxxxxxxx',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'pushover',
    label: 'Pushover',
    desc: 'Pushover 移动推送（付费 App，到达率高）。',
    fields: [
      {
        key: 'token',
        label: 'API Token',
        hint: 'Pushover 上创建 Application 后的 API Token（30 个字母），用于标识来源应用。',
        placeholder: 'azGDO…',
        secret: true,
        required: true,
      },
      {
        key: 'user',
        label: 'User Key',
        hint: 'Pushover 个人主页上的 User Key（同样 30 个字母），标识推给谁；多设备同账号共用一个。',
        placeholder: 'uQiRz…',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'pushbullet',
    label: 'Pushbullet',
    desc: 'Pushbullet 推送（跨设备通知同步）。',
    fields: [
      {
        key: 'token',
        label: 'Access Token',
        hint: 'Pushbullet 账号设置 → Access Tokens 里创建的令牌，整段抄下来（只需这一项）。',
        placeholder: 'o.xxxxxxxxxxxx',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'ntfy',
    label: 'ntfy',
    desc: 'ntfy 主题推送：手机装 ntfy App 订阅同一主题即可收告警。',
    fields: [
      {
        key: 'url',
        label: '服务地址（含主题）',
        hint: 'ntfy 的发布地址，必须**带主题（topic）路径**：官方服务写 https://ntfy.sh/主题名（主题名建议起得足够独特，公网谁都能订阅）；自建 ntfy 写自己的地址 + 主题。手机 App 里订阅同一个主题名即可收到。',
        placeholder: 'https://ntfy.sh/my-aibuddy-alerts',
        required: true,
      },
    ],
  },
  {
    type: 'teams',
    label: 'Teams',
    desc: 'Microsoft Teams 频道 Incoming Webhook。',
    fields: [
      {
        key: 'url',
        label: 'Webhook URL',
        hint: 'Teams 频道 → 「工作流」/「连接器」添加「Incoming Webhook」后拿到的完整地址（https://outlook.office.com/webhook/… 或 …/incomingwebhook/…）。',
        placeholder: 'https://xxx.office.com/webhook/…',
        required: true,
      },
    ],
  },
  {
    type: 'serverchan',
    label: 'Server酱',
    desc: 'Server酱：告警推送到微信（服务号消息）。',
    fields: [
      {
        key: 'key',
        label: 'SendKey',
        hint: '在 Server酱官网（sct.ftqq.com）微信扫码登录后得到的 SendKey（SCT 开头的一串）；免费额度每天有条数上限，告警频繁时留意。',
        placeholder: 'SCTxxxxxxxxxx',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'line',
    label: 'LINE',
    desc: 'LINE Messaging API 推送。',
    fields: [
      {
        key: 'token',
        label: 'Channel Access Token',
        hint: 'LINE Developers 控制台里 Messaging API 频道的长时效 Channel Access Token（issue 后整段复制）；同时要记下接收消息的用户 / 群组 ID 并让对方加机器人好友。',
        placeholder: 'eyJhbGciOi…',
        secret: true,
        required: true,
      },
    ],
  },
]

/** 按类型查注册表（未知类型给 null —— 后端加了新类型而前端没跟时，界面仍能如实显示 type 值） */
export function notifyTypeSpec(type: string): NotifyTypeSpec | null {
  return NOTIFY_TYPES.find(item => item.type === type) || null
}

/** 渠道类型的展示名（未知类型原样回显 type 值） */
export function notifyTypeLabel(type: string): string {
  return notifyTypeSpec(type)?.label || type
}

/** 新建渠道时的初始 config：按类型字段表补 initial 值，其余留空 */
export function emptyNotifyConfig(type: string): Record<string, string> {
  const config: Record<string, string> = {}
  for (const field of notifyTypeSpec(type)?.fields || []) {
    config[field.key] = field.initial ? String(field.initial) : ''
  }
  return config
}

/** 新渠道 id 的本地生成（后端全量保存不补 id，测试接口要靠它点名渠道） */
export function newNotifyChannelId(): string {
  return `nch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 渠道清单归一化：只认「形状对的项」（id / name / type 都是字符串、enabled 按布尔），
 * 认不出的丢弃 —— 宁可少显示一个渠道，也不把 undefined 渲染到卡片上。
 * 返回 null 表示整块不可用（响应形状不对，调用方据此打「不可用」徽章）。
 */
export function normalizeNotifyChannels(raw: unknown): NotifyChannel[] | null {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(record?.channels)
      ? record.channels
      : null
  if (list === null) return null
  const channels: NotifyChannel[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const id = String(entry.id ?? '').trim()
    const type = String(entry.type ?? '').trim()
    if (!id || !type) continue
    const config: Record<string, string> = {}
    if (entry.config && typeof entry.config === 'object') {
      for (const [key, value] of Object.entries(entry.config as Record<string, unknown>)) {
        if (value !== undefined && value !== null) config[key] = String(value)
      }
    }
    channels.push({
      id,
      name: String(entry.name ?? '').trim() || id,
      type,
      enabled: entry.enabled === true,
      config,
    })
  }
  return channels
}

/** 告警路由归一化：严格按形状采纳，缺事件键时补 true（与后端默认一致），形状不对返回 null */
export function normalizeNotifyAlerts(raw: unknown): NotifyAlerts | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const events = record.events && typeof record.events === 'object'
    ? (record.events as Record<string, unknown>)
    : {}
  return {
    enabled: record.enabled === true,
    events: {
      onDegraded: events.onDegraded !== false,
      onOffline: events.onOffline !== false,
      onProbeDisabled: events.onProbeDisabled !== false,
    },
    quietStart: /^\d{2}:\d{2}$/.test(String(record.quietStart ?? '')) ? String(record.quietStart) : '',
    quietEnd: /^\d{2}:\d{2}$/.test(String(record.quietEnd ?? '')) ? String(record.quietEnd) : '',
  }
}

/** HH:mm 静默时间校验：合法返回原值（归一成两位数），非法返回 null */
export function normalizeQuietTime(raw: string): string | null {
  const matched = String(raw ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!matched) return null
  const hours = Number(matched[1])
  const minutes = Number(matched[2])
  if (hours > 23 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** 时间值的可比数字（HH:mm → 分钟数；非法给 -1） */
function quietMinutes(time: string): number {
  const normalized = normalizeQuietTime(time)
  if (normalized === null) return -1
  return Number(normalized.slice(0, 2)) * 60 + Number(normalized.slice(3, 5))
}

/**
 * 单渠道草稿校验：返回错误文案，'' = 通过。在视图层保存前先挡一道（提示短、省一次
 * 往返），后端仍会再校验一遍 —— 这里挡的是抄写类错误（空名、URL 抄漏了协议、
 * JSON 少个引号），后端挡的是它自己的口径。
 */
export function validateNotifyChannel(channel: NotifyChannel): string {
  if (!channel.name.trim()) return '渠道名称不能为空'
  const spec = notifyTypeSpec(channel.type)
  if (!spec) return `未知的渠道类型：${channel.type}`
  for (const field of spec.fields) {
    const value = (channel.config[field.key] ?? '').trim()
    if (field.required && !value) return `「${field.label}」不能为空`
    if (!value) continue
    if (field.key === 'url' && !/^https?:\/\//i.test(value)) {
      return `「${field.label}」需要以 http:// 或 https:// 开头（当前填的是 ${value}）`
    }
    if (field.key === 'headers') {
      try {
        const parsed: unknown = JSON.parse(value)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return `「${field.label}」需要是一个 JSON 对象（如 {"Content-Type":"application/json"}）`
        }
      } catch {
        return `「${field.label}」不是合法的 JSON：请检查引号、逗号是否配对`
      }
    }
  }
  // 静默时段式的自洽检查不涉及渠道；这里再查一遍 Webhook 模板的占位符拼写：
  // {{tittle}} 之类的手误不会被报错，只会让报文里留着字面量 —— 点出来省得排查
  const template = (channel.config.template ?? '')
  for (const match of template.match(/\{\{\s*[a-zA-Z]+\s*\}\}/g) || []) {
    const token = match.replace(/[{}\s]/g, '')
    if (token !== 'title' && token !== 'body') {
      return `报文模板里的占位符 ${match} 不认识（可用 {{title}} 与 {{body}}）`
    }
  }
  // 静默时段式的语义检查：URL 类字段抄进主题路径没有做强校验（各家形态不同），交给后端
  void quietMinutes
  return ''
}

/** 密钥打码：卡片摘要里给「抄对没有」的线索（首尾几段 + 长度对不对），不回显全文 */
export function maskNotifySecret(value: string): string {
  const text = value.trim()
  if (!text) return '（未填）'
  if (text.length <= 8) return `${text.slice(0, 2)}••••`
  return `${text.slice(0, 6)}••••${text.slice(-4)}`
}

/** 渠道卡片摘要：按字段表把 config 摆成一行（密钥打码），没配置项时退回类型说明 */
export function notifyChannelSummary(channel: NotifyChannel): string {
  const spec = notifyTypeSpec(channel.type)
  if (!spec || spec.fields.length === 0) return spec?.desc || ''
  return spec.fields.map(field => {
    const value = (channel.config[field.key] ?? '').trim()
    const shown = value ? (field.secret ? maskNotifySecret(value) : value) : '（未填）'
    return `${field.label}：${shown}`
  }).join(' · ')
}


export type NumberField = {
  /** 后端 config 的 JSON 键（大小写必须逐字一致，否则 PUT 被静默忽略） */
  key: string
  /** 控件 id：保留旧 id 便于排查（没有任何外部脚本再按 id 读这些控件） */
  id: string
  label: string
  /** 输入框右侧的单位 */
  unit: string
  min: number
  max: number
  /** 行下方的说明（逐字来自 index.html 静态骨架） */
  hint: string
}

/** 与后端 RETENTION_MIN_DAYS / RETENTION_MAX_DAYS 同源（非法值后端会 400） */
export const RETENTION_MIN = 1
export const RETENTION_MAX = 3650

export const RETENTION_FIELDS: NumberField[] = [
  {
    key: 'logRetentionDays',
    id: 'settings-retention-log',
    label: '事件日志保留天数',
    unit: '天',
    min: RETENTION_MIN,
    max: RETENTION_MAX,
    hint: '登录 / 账号切换 / 429 切换等系统事件，可填 1–3650 天。',
  },
  {
    key: 'requestRetentionDays',
    id: 'settings-retention-request',
    label: '请求日志保留天数',
    unit: '天',
    min: RETENTION_MIN,
    max: RETENTION_MAX,
    hint: '「请求日志」页的逐条请求记录，可填 1–3650 天。',
  },
  {
    key: 'dailyRetentionDays',
    id: 'settings-retention-daily',
    label: '按天聚合保留天数',
    unit: '天',
    min: RETENTION_MIN,
    max: RETENTION_MAX,
    hint: '报表页的热力图与按天趋势，可填 1–3650 天。',
  },
]

/**
 * 三项重试字段。第二项的键名 `retryCrossProviderCount` 是**旧措辞**（配置兼容，
 * 改名会让老配置读不到、静默回落默认值），后端常量已经改叫 KEY_RETRY_ACCOUNT_SWITCH_COUNT
 * —— 这里必须沿用旧字符串，只有展示名跟着真语义走。
 */
export const RETRY_FIELDS: NumberField[] = [
  {
    key: 'retryCount',
    id: 'settings-retry-count',
    label: '同一账号重试次数',
    unit: '次',
    min: 0,
    max: 10,
    hint: '在同一个账号上原地重发几次（不含首发；整条请求共用一份，用完后换来的账号只发一次就继续换）。可填 0–10，0 表示失败立即换号。',
  },
  {
    key: 'retryCrossProviderCount',
    id: 'settings-retry-cross-provider-count',
    label: '切换账号重试次数',
    unit: '次',
    min: 0,
    max: 10,
    hint: '失败后最多再换几个账号试（填 N = 最多换 N 个，首发那个不算）。换到同一家名下另一个账号、或换到另一家，都各算一次；换满仍失败就返回错误。可填 0–10，0 表示失败立即报错。',
  },
  {
    key: 'retryIntervalSeconds',
    id: 'settings-retry-interval',
    label: '重试间隔',
    unit: '秒',
    min: 0,
    max: 300,
    hint: '两次重试之间的等待时间，两项共用，可填 0–300 秒。',
  },
]

/** 超时字段：键名与 config.rs 的 KEY_TIMEOUT_* 指向的 JSON 键逐字一致 */
export const TIMEOUT_FIELDS: NumberField[] = [
  {
    key: 'connectTimeoutSeconds',
    id: 'settings-timeout-connect',
    label: '连接中超时',
    unit: '秒',
    min: 1,
    max: 3600,
    hint: '建立上游 TCP/TLS 连接或代理隧道的最大等待时间（秒），默认 30 秒，范围 1~3600。',
  },
  {
    key: 'headersTimeoutSeconds',
    id: 'settings-timeout-headers',
    label: '等待响应超时',
    unit: '秒',
    min: 1,
    max: 3600,
    hint: '请求发出后等待上游响应头的最大时间（秒），默认 300 秒，范围 1~3600。',
  },
  {
    key: 'streamIdleTimeoutSeconds',
    id: 'settings-timeout-stream-idle',
    label: '流式响应空闲超时',
    unit: '秒',
    min: 1,
    max: 3600,
    hint: '流式响应相邻数据之间允许的最大空闲时间（秒），收到新数据后重新计时，默认 300 秒，范围 1~3600。',
  },
  {
    key: 'bodyTimeoutSeconds',
    id: 'settings-timeout-body',
    label: '非流式响应超时',
    unit: '秒',
    min: 1,
    max: 3600,
    hint: '读取完整非流式响应体允许的最大时间（秒），默认 300 秒，范围 1~3600。',
  },
]

/** 排队等待字段：键名与 config.rs 的 KEY_QUEUE_* 指向的 JSON 键逐字一致 */
export const QUEUE_FIELDS: NumberField[] = [
  {
    key: 'queueMaxWaits',
    id: 'settings-queue-max-waits',
    label: '排队等待次数',
    unit: '次',
    min: 0,
    max: 10,
    hint: '上游模型繁忙时会先排队（回一句「建议 N 秒后再来」，Qoder 免费模型就是这样）：网关等一会儿再发同一请求，最多等几次。默认 2 次，可填 0–10；填 0 表示不等待，排队直接返回 503 并说明「不是登录态或额度问题」。',
  },
  {
    key: 'queueWaitSeconds',
    id: 'settings-queue-wait-seconds',
    label: '排队等待秒数',
    unit: '秒',
    min: 0,
    max: 120,
    hint: '每次等待的时长，默认 0 = 跟随上游建议（实测 9~30 秒，上游没给建议时用 15 秒）。可填 0–120 秒强制一个固定时长。',
  },
]

/** 「指定错误码直接换号」：键名、状态码范围与名单上限与后端 retry_api.rs 逐字同源 */
export const NO_RETRY_CODES_KEY = 'noRetryStatusCodes'
export const RETRY_CODE_MIN = 100
export const RETRY_CODE_MAX = 599
export const RETRY_MAX_CODES = 50

/** 提示词模式：下拉的展示文案（含「（默认）」）与 toast 里用的短名分开 —— 旧实现是两份表 */
export type PromptModeOption = { value: string; optionLabel: string; toastLabel: string }

export const PROMPT_MODES: PromptModeOption[] = [
  { value: 'passthrough', optionLabel: '透传客户端 system（默认）', toastLabel: '透传客户端 system' },
  { value: 'custom', optionLabel: '替换为网关提示词', toastLabel: '替换为网关提示词' },
  { value: 'append', optionLabel: '追加网关提示词', toastLabel: '追加网关提示词' },
]

/* ─── 校验与归一化 ─────────────────────────── */

export type ParseResult = { ok: true; value: number } | { ok: false; message: string }

/**
 * 前端校验：min–max 的整数（后端也会挡，这里先挡省一次往返，且提示更短）。
 * 用 /^\d+$/ 而不是 Number() + Number.isInteger()：后者会把 "1e2" 认成 100、
 * "0x10" 认成 16，这些都不是「用户填了几天 / 几次」的直觉答案，不如直接判非法。
 * `noun` 是提示语的主语：保留期用「天数」，其余面板用自己的标签。
 */
export function parseInteger(raw: unknown, min: number, max: number, noun: string): ParseResult {
  const text = String(raw ?? '').trim()
  // 空串要单独挡：空值过不了下面的正则，但提示语不同（「不能为空」比「必须是整数」更准）
  if (!text) return { ok: false, message: `${noun}不能为空（可填 ${min}–${max}）` }
  if (!/^\d+$/.test(text)) return { ok: false, message: `${noun}必须是整数` }
  const value = Number(text)
  if (value < min || value > max) {
    return { ok: false, message: `${noun}必须在 ${min}–${max} 之间（当前填的是 ${text}）` }
  }
  return { ok: true, value }
}

/**
 * 保存返回值归一化：后端按契约应回传完整设置，但只认它是布尔才采纳，
 * 缺字段时沿用本次提交的值，避免把开关误渲染成「关闭」。
 */
export function normalizeApp(saved: unknown, fallback: AppSettings): AppSettings {
  const result: AppSettings = { ...fallback }
  if (saved && typeof saved === 'object') {
    const record = saved as Record<string, unknown>
    if (typeof record.closeToTray === 'boolean') result.closeToTray = record.closeToTray
    if (typeof record.autostart === 'boolean') result.autostart = record.autostart
  }
  return result
}

/**
 * 数字面板的响应归一化（保留期 / 重试 / 超时共用同一口径）：
 * 只采纳「范围内的整数」，缺字段 / null / 字符串一概沿用上一轮的有效值 ——
 * 不把线上没给的项清空，也不写 "undefined" 进输入框。
 * 返回 null 表示整块不可用（响应形状不对，或三项都拿不到有效值）。
 */
export function normalizeNumbers(
  fields: NumberField[],
  data: unknown,
  previous: Record<string, number> | null,
): Record<string, number> | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const next: Record<string, number> = { ...(previous || {}) }
  for (const field of fields) {
    const value = Number(record[field.key])
    if (Number.isInteger(value) && value >= field.min && value <= field.max) {
      next[field.key] = value
    }
  }
  // 一项有效值都拿不到（换壳后接口形状变了之类）：按不可用处理，
  // 不让一排空输入框留在页面上
  if (!fields.some(field => Number.isInteger(next[field.key]))) return null
  return next
}

/* ─── 读数格式化（数据存储面板） ─────────────── */

/** 字节数 → 可读大小（库主文件通常几百 KB 到几十 MB，四档够用） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** 条数 → 带千分位的文本（用户对着看更省事）；非法值给「—」 */
export function formatCount(value: unknown): string {
  const count = Number(value)
  if (!Number.isFinite(count) || count < 0) return '—'
  return count.toLocaleString('zh-CN')
}

/* ─── 页面文案（逐字来自 index.html 静态骨架） ─── */

/** 标题右侧问号（`[data-tip]`）的说明全文：tooltip.js 仍在页面上跑，照旧服务这些元素 */
export const TIPS = {
  displayTheme: '控制界面的深浅色，与左侧边栏底部的三个主题按钮是同一个设置（改哪一处，另一处立刻跟上）。「跟随系统」会随操作系统当前的浅色 / 深色自动切换，并在系统主题变化时即时跟上；选「浅色」或「深色」则把界面固定在该模式，不再随系统变化。窗口标题栏的深浅色会一并同步，不会出现深色界面配一条浅色标题栏的情况。',
  displayZoom: '等比放大或缩小整个界面（文字、控件、间距一起变），效果与浏览器按 Ctrl +/- 相同：80%–130%、5% 一档。窗口本身不缩放，变的是页面内容的显示比例，设置立即生效并记住，下次启动直接按这个比例打开。放得越大可视范围越小，窗口较窄或表格较宽时不建议调得太大。',
  displayLanguage: '界面语言。目前只提供简体中文，所以这里只有这一项可选（选中即当前语言）。以后增加其它语言时，这个列表里会出现对应选项，选择后立即应用到界面。',
  tray: '默认关闭窗口不会退出程序，而是把窗口缩到系统托盘，转发继续在后台运行（OpenAI 客户端不受影响）；要彻底退出程序，请在托盘图标上右键选「退出」。关掉这个开关后，点关闭按钮即退出程序、转发随之中断。「开机自动启动」开启后，登录系统时会自动启动本程序（通常直接驻留托盘），不需要手动打开。',
  units: '控制报表与请求日志里 Token 读数的写法：开启后按中文量级显示（1.2亿 / 8400万），关闭则用 k / M 缩写（与上游文档、接口字段的写法一致）。这只影响显示口径，不改变任何统计与存储的数值。',
  queue: '只对「排队制」的上游生效（目前是 Qoder 的免费模型）：模型繁忙时上游不报错，只回一句「建议 N 秒后再来」（业务码 10605），网关按建议时长等一会儿再发同一请求，等满次数仍排不上才把「排队中」作为错误返回（HTTP 503，文案会说明这不是登录态或额度问题）。等待发生在首个字节之前，吃的是「等待响应超时」那份预算 —— 两项设置一起决定一次请求最多卡多久；排队不会标记账号限额、也不会换账号（换谁都一样在排队）。保存后对下一个请求立即生效，不用重启。',
  timeouts: '上游请求四个阶段各自的等待上限（秒，1~3600）：①「连接中超时」= 建立 TCP/TLS 连接或代理隧道的最大等待，默认 30 秒；②「等待响应超时」= 请求发出后等上游响应头的最大时间，默认 300 秒 —— 网关请求上游恒带 stream，响应头在 SSE 建立时就到达，与模型思考多久无关；③「流式响应空闲超时」= 流式响应相邻两块数据之间允许的最大空闲，收到新数据即重新计时，默认 300 秒 —— 上游长时间不吐数据即判定连接僵死并断开；④「非流式响应超时」= 读完整份非流式响应体的总预算（一次性计时、不重置），默认 300 秒。四项都是「等待上限」，只要数据还在来，正常的流式回答就一直往下传。保存后对下一个请求立即生效，不用重启。',
  retry: '请求转发到上游失败时（服务器瞬时错误、连接失败，以及 WorkBuddy 的 11-128 敏感词拦截），网关会等一段间隔后再发一次。次数分两档，管的是两件事：①「同一账号重试次数」在同一账号上原地重发几次 —— 一般是提示词被上游拦截、或链路瞬时抖动，等一会儿重发往往就好了；②「切换账号重试次数」这份请求最多再换几个账号试 —— 首发的那个账号不算，每换一个扣一次，不分是不是同一家（换到同一家的下一个账号也算一次），换满还失败就把错误返回给客户端。两项都设为 0 表示失败不重试、直接报错。注意账号级限额（429）不占这里的换号次数 —— 那类失败走「冷却该账号并换下一个账号」的降级，与这里的重试是两条路。另有「指定错误码直接换号」名单（默认 402）：命中名单的上游状态码不在同一账号重发，直接按队列换下一个账号继续试（换号也占「切换账号重试次数」），换满仍失败才把错误返回给客户端。',
  sanitize: '上游用「逐字精确匹配」的方式审核请求体（不是语义审核）：客户端注入的固定模板句、计费头字段名、以及某些裸错误码出现在报文里就会整单拦截，返回 400。开启本项后，网关在每次转发前改写这些指纹 —— 表头键值整段删除，承载语义的模板句只换一个词（如 official CLI for Claude → official CLI tool for Claude），对话内容与语义都不受影响。规则集是内置的，不需要也无法维护词表。关掉本项后客户端模板会原样发往上游，可能重新出现模板句被误拦的报错。',
  prompt: '客户端（Claude Code / Codex 等 CLI）会在 system 提示词里注入几十句固定模板，上游按逐字匹配审核，命中就整单拦截（HTTP 400）。指纹脱敏能改写实测命中过的那几句，但换一个客户端版本就可能冒出新的。这里可以把 system 整段换成网关自己那份：①「透传」= 不动客户端 system（默认，行为与之前完全一致）；②「替换」= 删掉客户端所有 system / developer 消息，换成网关的提示词（客户端项目规范随之消失）；③「追加」= 在开头连续 system 块之后插入一条网关提示词，既有消息逐字不动（客户端规范与网关提示词并用）。那份提示词有两个来源：提示词文件（留空用内置默认），或直接在界面上编辑正文 —— 编辑过就以那份正文为准（优先于文件），清空则回到文件 / 内置默认。另外，透传 / 追加模式下撞了内容拦截（多半是指纹误报）时，网关会自动换一段最小中性提示词重试一次，并把「降级期」开到次日 00:00 —— 期间所有请求直接带中性提示词出门，不再先撞一次 400；这里能看见并提前解除它。上面几项是**默认值**：想给某个提供商单独配，用下面的「按提供商」加一行（带「网关自带」的家默认就列在那里）—— 不同的上游对这些内容的接受程度不一样。',
  debug: '开启后，网关会把每次转发**发给上游的请求**（请求头 + 请求体）与**上游返回的响应**（状态码 + 响应头 + 响应体）完整保存到本地，供请求日志页的「详情」查看。请求头里的 Authorization、Cookie、API Key 等凭据字段一律替换成 [redacted]，不会明文落盘；请求体与响应体按原样保存（可能包含你的对话内容）。报文只保留最近 500 条，超出后丢弃最旧的。这是排障用的临时开关，不需要时建议关闭。',
  io: '导出会把全部账号与自定义提供商定义写入一个 JSON 文件，可以拷到另一台机器上导入后继续使用。导入采用合并策略：同提供商下按业务身份（UID / userId / apiKey 等）去重 —— 已存在的账号只更新凭证，保留本机原有的优先级顺序；新账号追加到转发顺序末尾，不会抢占当前正在使用的账号；自定义提供商定义按 id 合并，本机缺失时自动补建。',
  retention: '三类数据各自独立计时，超出保留天数的部分会被删除：事件日志是登录、账号切换、429 切换这类系统事件；请求日志是网关每次转发到上游的逐条记录；按天聚合供报表页的热力图与按天趋势使用。把某一档改小（例如 30 天改成 7 天）保存后会立即删除超出的历史数据，此操作不可恢复；改大或保持不变不会删除任何数据。三项的可填范围均为 1–3650 天。',
  storage: '全部数据（账号、事件日志、请求记录、调试报文、设置）统一保存在配置目录下的 aibuddy-panel.db 这一个 SQLite 数据库里。备份时只需拷贝这个文件；更换保存位置请设置环境变量 AGENT2API_PROXY_HOME 后重启程序。',
  /* ── 偏好与外观 / 通知与页签（本次新增：外壳偏好，与 ui/js/prefs.js 同源）── */
  prefsDrawer: '打开右上角齿轮同款的「偏好设置」抽屉：四个页签（外观 / 布局 / 通用 / 锁屏）里有全部偏好项目，外加「复制偏好 / 导入偏好 / 恢复默认」三个批量动作。抽屉与本页读写的是同一份本机配置，两边改动的值互相可见（抽屉每次打开都会重读）。',
  prefsTheme: '与「显示 → 显示模式」、侧边栏底部的主题三键、偏好抽屉是同一个设置的几个入口：浅色 / 深色把界面固定在该模式，「跟随系统」随操作系统的深浅自动切换并即时跟上，窗口标题栏的深浅色一并同步。这里改动会同时写进应用主题与偏好存档两处，下次启动按同一值打开，不会互相顶掉。',
  prefsPrimary: '界面主色：按钮、选中态、链接、开关等主色元素立即换色。内置 12 色点击即用；「自定义」取色器可选任意颜色；「恢复默认」回到内置紫罗兰（#7c5cfc）。主色只在本机生效（保存在浏览器偏好里），悬停、柔和底、描边等衍生色按当前深浅主题自动计算，无需逐个调整。',
  prefsLock: '锁屏遮罩盖住整个页面，解锁前无法操作。开启后：可在本分区一键立即锁屏；鼠标 / 键盘空闲达到设定分钟数自动锁屏（有活动就重新计时，可设 0–1440 分钟，0 = 不自动锁屏）；锁屏状态会持久化，刷新页面后仍在锁屏，解锁才清除。解锁密码仅保存在本机浏览器（明文存 localStorage，不上传服务器），留空则锁屏后点击即可解锁。锁屏参数由壳在页面加载时读取，改动需刷新页面后生效；「立即锁屏」会自动先保存再刷新，直接进入锁屏。',
  shellTags: '内容区顶部的页签栏记录本次会话打开过的页面：首页「报表」固定不可关闭，其余页签可单独关闭、右键批量操作，清单在刷新后保留（存档非法项会自动丢弃、自动去重）。「清空页签（回到首页）」调用页签栏自带的「全部关闭」：立即回到只剩首页并跳回首页，不用刷新。',
  shellNotify: '顶栏铃铛是通知中心：每 60 秒轮询一次最近 8 条网关运行事件（页面切到后台时暂停轮询、回前台立即补拉；间隔固定、暂不可配置），只统计 error / warn 级别的未读角标，打开面板即全部记为已读；首轮拉到数据时会把当时的水位记为已读，历史告警不追着新用户响。完整历史在「日志」页查看。',
  /* ── 通知中心（渠道与告警路由，本次新增）── */
  notifyChannels: '通知渠道是网关把告警**推到外面**的出口：每条渠道是一组「类型 + 地址 / 凭据」，支持 16 种服务（Webhook / Telegram / 钉钉 / 飞书 / Bark 等），同一类型可以配多条（比如两个不同的钉钉群）。清单整体保存在网关配置里，添加 / 编辑 / 删除 / 启停都是**全量保存**——请求进行中整块禁用，成功后按后端返回的清单重画。卡片摘要里密钥类字段打码显示（只露首尾几段）供核对，编辑时输入框里是完整值，保存时按输入框里的值原样落盘。「测试」按钮会用与真实告警完全相同的通道发一条测试消息，收到即配置正确。',
  notifyAlerts: '告警事件路由决定「哪些事件要推送到渠道」：总开关关闭时任何事件都不做外部推送；三路事件开关各对应一类故障（429 降级 / 账号掉线 / 探活自动禁用），只影响**站外推送**——事件本身永远会写入事件日志并出现在顶栏铃铛里。静默时段（HH:mm 起止，本地时区）内的告警照常记录、照常亮红点，只是**不推送到渠道**，适合夜间免打扰；两端都留空 = 不启用静默，只填一端保存不会通过。',
} as const

/** 面板底注（`.hint.retention-note`）与各面板内的说明行 */
export const NOTES = {
  timeouts: '保存后立即生效，不用重启；超时按上游失败处理（计入请求日志的「错误」列，并按「请求重试」的设置决定是否重试）。',
  queue: '等待期间请求日志的状态列会显示「排队中」阶段，详情弹窗的「内部重试」里能逐次看到等待时长；等待用尽后返回 HTTP 503（不是 401/429：既不会刷新凭证，也不会把账号标成限额）。',
  retry: '保存后立即生效，不用重启；次数用尽仍失败时，错误原样返回给客户端。',
  retryCodes: '命中这些上游状态码的失败不在同一账号重发，直接换下一个账号继续试（换号占用「切换账号重试次数」，换满仍失败才把错误原样返回给客户端）。输入 100–599 的状态码后回车添加，点 × 或退格删除；默认 402（积分不足）。清空全部表示任何错误都照常重试。',
  sanitize: '默认开启。命中明细会记进请求日志的「敏」标签（悬停可看命中了哪几条规则）。本项只改发给上游的副本，客户端看到的响应内容不变。',
  debug: '开启后新发生的请求才会被记录（已经过去的请求补不回来）。报文统一存放在本地数据库里，只保留最近 500 条（超出后丢弃最旧的），条数见左侧「数据 → 数据存储」的「调试报文」。',
  promptMode: '替换 = 客户端 system / developer 消息全部删掉，换成网关的提示词；追加 = 保留客户端内容，只在开头 system 块之后多插一条。两者都只改发给上游的副本，客户端看到的响应不变。',
  promptFile: 'UTF-8 文本文件路径，留空用内置默认提示词（通用编码助手提示词，不含任何会被上游拦截的模板句）。只在「替换 / 追加」模式下生效，透传模式不读它。',
  promptText: '在这里直接编辑提示词正文：保存后以这份文本为准（优先于上面的提示词文件），清空则回到文件 / 内置默认。改一个字不必再去编辑器里开文件。',
  promptGatewayText: '上游按「结构」校验身份：三段必须各自成块，所以这里分开编辑三段（不能合成一段）。动态段里的运行值写成占位符，发请求时才替换：{cwd} 工作目录、{platform} 平台、{shell} shell、{os_version} 系统版本、{git} 是否 git 仓库、{provider} 提供方标识、{model} 模型名。清空某一段 = 那一段恢复官方原文。第三段发出时前面会自带一个空行（官方形状）。',
  prompt: '改完立即生效，不用重启（下一个请求就用新模式）。降级是自动的临时状态，解除后本模式自己的提示词立刻恢复。',
  promptProviders: '「用哪份提示词」本来是按上游分别决定的事，所以每家可以有自己的模式、提示词文件与正文：不在这里列出的提供商一律沿用上面那份默认设置，「跟随默认」把这一家取消、回到默认。带「网关自带」那一行的家（目前是 ZCode 两家）默认就列在这里 —— 那一段是网关自己装上去的文本，不来自客户端也不来自提示词文件，默认开启、可以关掉，也可以改它的正文（改过的那一段以你的文本为准）；关掉后还能不能通过上游校验，取决于上游当下的口径，行内说明了实测依据。「模式 / 提示词文件 / 正文」管的是客户端自己的 system 怎么处理，与那个开关是两件事。',
  retention: '保存后立即生效：改小保留天数会立刻删除超出的历史数据，且不可恢复。',
  storageFile: '配置目录下的 aibuddy-panel.db（账号、日志、请求记录、调试报文与设置都在里面）。',
  storageSize: '库主文件的大小（不含运行期间的 WAL 临时文件，退出时已自动并回）。',
  storage: '数据统一保存在配置目录下的 aibuddy-panel.db；如需更换位置，请设置环境变量 AGENT2API_PROXY_HOME 后重启程序。',
  captcha: '开启后，登录页在浏览器后台自动完成验证（对真人无感），而脚本每次尝试都要先算一道题 —— 暴力破解与抢注的成本显著上升。仅影响面板的登录 / 注册，与 API 客户端的 API Key 无关。',
  panelLogin: '当前浏览器以管理员身份登录着本面板。「退出登录」会撤销这台设备的登录会话（30 天内的自动续期一并失效），需要重新输入账号密码；其他已登录的设备不受影响。',
  exportDanger: '导出文件内含 accessToken / refreshToken / apiKey 等凭证与自定义提供商定义，可直接用于登录。请妥善保管，不要外传或上传到公共位置。',
  /* ── 数据维护（数据 pane 的日志 / 请求维护分区）────────────────── */
  logMaint: '事件日志是网关的运行流水（账号调度、令牌刷新、签到、更新检查等内部动作），与「请求日志」（客户端每次调用的记录）是两回事。它有容量上限（total 与 max 的比值就是占用度），写满后自动滚动淘汰最旧条目；也可在「数据保留」分区按天数自动清理。「清空全部」是立即删光并让条目编号从 1 重新计数，不可恢复 —— 只是想释放空间的话，优先调保留天数。',
  logClear: '全清需要显式确认：删除后事件日志归零、编号重排。需要留存内容的话，先在「日志」页导出，再回来清空。',
  requestMaint: '请求记录 = 每次客户端调用的明细行（模型、账号、状态、耗时、Token 计量），是报表与请求日志页的数据来源。「明细」与「原始正文」是两层：原始正文是请求 / 响应的完整报文（调试报文，体积大头）。「仅清理原始正文」保留明细行与统计（报表不断档），只删大报文释放空间；「清理请求明细」连明细一起删，报表历史随之清零 —— 两类操作都不可恢复，删前先看预览数字。',
  compact: '删除并不会缩小 SQLite 文件（空间只是标记为空闲、留给后续写入）；「压缩数据库」先并回 WAL 再 VACUUM 重建库文件，把已删除数据的空间真正还给磁盘。压缩在后台线程执行，期间数据库短暂互斥（几十 MB 的库通常秒级完成）；进行中重复触发会被拒绝。执行完这个动作，磁盘占用才与「数据概览」里的有效数据量一致。',
  /* ── 品牌外观 ─────────────────────────────── */
  brandingTitle: '自定义站点名称：显示在浏览器标签标题、左侧栏品牌区、面包屑首段与登录页大标题。留空 = 恢复内置的「AIBuddy Panel」。最长 40 个字；保存后刷新页面（或重新打开面板）生效。',
  brandingLogo: '自定义站点图标：替换侧栏品牌标、登录页图标与浏览器标签 favicon。支持 PNG / JPEG / WebP / SVG，超过 280KB 会自动等比缩到 256px 再上传（服务端硬上限约 300KB）。正方形显示效果最好；移除后回到内置图标。保存后刷新页面生效。',
  brandingScope: '品牌数据存在服务端数据库里：同一个部署的所有访问者（含登录页）看到的是同一套标题与图标。桌面端面板目前只能看、不能改（保存通道是网页端部署专属）；API 端点：GET /api/panel/branding（公开）、PUT /api/branding（需登录）。',
  pagePrefs: '这些是**本浏览器**的界面偏好，保存在 localStorage 里（不随账号走、清浏览器数据会重置）。各页自己也有同样的切换控件 —— 这里改的是「下次打开时的默认值」，立即生效（当前页会话内临时切换不受影响）。',
  /* ── 偏好与外观 / 通知与页签（本次新增）── */
  prefsPane: '本页与顶栏齿轮的「偏好设置」抽屉共用同一份本机配置（localStorage 的 aibuddy-prefs，不随账号走、清浏览器数据会重置；抽屉每次打开都会重读，两边互相可见）。除锁屏外的一切改动立即应用并持久化；锁屏的解锁校验与自动锁屏计时由壳在页面加载时读取，改动需刷新页面后生效。',
  prefWatermark: '在页面最上层平铺「品牌名 · 当天日期」的半透明水印（canvas 生成、不挡任何点击），适用于录屏与演示场景；水印文字取侧栏品牌区当前的品牌名，换品牌后重新开关一次即按新名字重绘。',
  prefDisplayItems: '这些开关与偏好抽屉「布局 / 通用」页签里的同名项目是同一批配置：改这里立即生效，抽屉打开后看到的也是改过的值。全部保存在本机偏好里，不随账号同步。',
  shellPane: '页签与通知都是外壳（浏览器内）功能：页签清单（aibuddy-tags）、通知已读水位（aibuddy-notify-read）、内容区全屏（aibuddy-content-max）都保存在本机 localStorage，不随账号走。通知中心的 60 秒轮询间隔是固定值，页面不可见时自动暂停、回前台立即补拉。',
  shellResetUnread: '清除通知中心的已读水位（aibuddy-notify-read）并立即重算：已亮着的红点随之清零，水位在重算时按当前最新事件重建 —— 之后的 error / warn 告警才会计未读。适合「红点想清零、从现在重新计数」的场景。',
  /* ── 通知中心（本次新增）── */
  notifyChannels: '渠道清单整体保存在网关配置里：每次添加 / 编辑 / 删除 / 启停都会把全部渠道一次性保存（PUT /api/notify/channels），请求进行中整块禁用。删除需要确认，删除后不可恢复 —— 好在配置不复杂，重新添加一张同样的渠道即可。',
  notifyQuiet: '静默时段（本地时区 HH:mm）内的告警**只记录不推送**：事件日志照常写、铃铛照常亮红点，渠道收不到推送；开始与结束都填写才生效，两端都留空 = 不启用静默。',
  notifyBell: '顶栏铃铛（通知中心）读的是网关事件日志，属于站内提醒：不需要配置渠道、也不受这里的总开关与事件路由控制；本页管的是站外推送（微信 / Telegram / 手机通知等）。两者相互独立 —— 关掉推送，铃铛照常工作。',
} as const

/** 状态行（`.settings-state`）的派生文案：与旧实现的赋值逐字一致 */
export const STATES = {
  appLoading: '—',
  appUnavailable: '主进程未返回启动设置，请更新桌面端后重试',
  appTrayOn: '关闭窗口时程序不退出，转发继续在后台运行；退出请用托盘菜单',
  appTrayOff: '关闭窗口即退出程序，后台转发随之中断',
  unitsOn: '当前显示为「1.2亿 / 8400万」这类中文量级。',
  unitsOff: '当前显示为「1.20M / 8.4k」这类英文缩写。',
  debugUnavailable: '未能读取调试模式设置，请稍后重试',
  debugOn: '正在保存上游原始报文：',
  debugOff: '未开启，转发时不保存任何原始报文。',
  sanitizeUnavailable: '未能读取指纹脱敏设置，请稍后重试',
  sanitizeOn: '正在剥离出站请求里的审核指纹：表头键值整段删除，模板句最小改写。',
  sanitizeOff: '未开启，客户端 system 模板会原样发往上游，可能被内容审核误拦（400）。',
  promptUnavailable: '未能读取系统提示词设置，请稍后重试',
  degradeUntilFallback: '次日 00:00',
  // ── 显示分类（本次新增：不来自静态骨架，是新写的文案）──
  themeSystem: '当前跟随操作系统的深浅色设置，系统切换时界面会自动跟上。',
  themeLight: '当前固定为浅色模式，不随系统变化。',
  themeDark: '当前固定为深色模式，不随系统变化。',
  zoomWeb: '网页端的界面缩放由浏览器自己控制（Ctrl + / Ctrl -，或浏览器菜单里的缩放），此项不可调。',
  zoomDefault: '当前按 100% 显示（默认比例）。',
  languageOnly: '当前界面语言为简体中文（目前仅提供这一种）。',
  // ── 通知中心（本次新增）──
  notifyChannelsUnavailable: '未能读取通知渠道，请稍后重试',
  notifyAlertsUnavailable: '未能读取告警事件路由，请稍后重试',
} as const
