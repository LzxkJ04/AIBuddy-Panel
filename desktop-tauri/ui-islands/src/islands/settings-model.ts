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
  /** 密钥类字段：卡片摘要与测试文案里打码，表单里用密码框显示（可点「显示」临时明文核对） */
  secret?: boolean
  /** 数字输入（端口 / 优先级 / 时长等）：渲染 number 输入框，值仍按字符串存取 */
  number?: boolean
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
 * 渠道类型与各自的 config 字段表（全量对齐 Uptime-Kuma 的 notification-providers）。
 *
 * 键名与后端的渠道配置逐字对齐（webhook 的 url、telegram 的 botToken / chatId …）；
 * 说明文案按「是什么 / 到哪里拿 / 填什么形态」写，新用户不看文档也能填对。
 * 顺序 = 添加渠道下拉里的顺序：原有 16 种在前（通用 Webhook 在前、IM 机器人居中、
 * 专用推送服务殿后，结构保持不动），后面按「IM 群聊 → WhatsApp/消息网关 → 推送 →
 * 事件与值班 → 邮件 → 短信语音 → 其它集成」分组追加 Uptime-Kuma 的其余类型。
 *
 * 新类型的 type 值 = refs/uptime-kuma/server/notification-providers/ 的文件名去掉
 * .js 后转小写（与后端代理同一份命名规则），config 键名与各 provider 的
 * send(notification, …) 逐字一致 —— 后端按这份表取值，改一处必须两处同步。
 *
 * 字段渲染口径（settings-page 的 ChannelFieldRow）：secret 出密码框（可临时明文）、
 * number 出数字框、multiline 出多行文本、其余为单行文本；源码里的下拉与复选框
 * 一律按文本框出，可选值写进说明（值本身是字符串，后端按需解析）。
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

  /* ── 以下为 Uptime-Kuma 全量补齐（type = 源码文件名去 .js 转小写）── */

  // IM 与群聊机器人
  {
    type: 'bale',
    label: 'Bale',
    desc: 'Bale 即时通讯 Bot 推送：把告警发到指定聊天（私聊 / 群组 / 频道）。',
    fields: [
      {
        key: 'baleBotToken',
        label: 'Bot Token',
        hint: '在 Bale 里找 BotFather 创建机器人后获取的令牌，整段复制。',
        placeholder: '123456:ABC…',
        secret: true,
        required: true,
      },
      {
        key: 'baleChatID',
        label: 'Chat ID',
        hint: '接收消息的聊天 ID，支持私聊 / 群组 / 频道。先给机器人发一条消息，再访问 Bale 的 getUpdates 接口即可看到 chat_id。',
        required: true,
      },
    ],
  },
  {
    type: 'kook',
    label: 'KOOK',
    desc: 'KOOK（开黑啦）机器人推送：把告警发进指定服务器。',
    fields: [
      {
        key: 'kookBotToken',
        label: 'Bot Token',
        hint: '在 KOOK 开发者平台（developer.kookapp.cn）创建应用后获取的机器人 Token。',
        secret: true,
        required: true,
      },
      {
        key: 'kookGuildID',
        label: '服务器 ID（Guild ID）',
        hint: '接收消息的服务器 ID：在 KOOK 设置里打开「开发者模式」，然后右键点击目标服务器复制其 ID。',
        required: true,
      },
    ],
  },
  {
    type: 'matrix',
    label: 'Matrix',
    desc: 'Matrix 房间推送：把告警发进去中心化聊天网络里的指定房间。',
    fields: [
      {
        key: 'homeserverUrl',
        label: 'Homeserver 地址',
        hint: 'Matrix 服务器的完整地址（含 http(s):// 与可选端口），如 https://matrix.org。',
        placeholder: 'https://matrix.org',
        required: true,
      },
      {
        key: 'internalRoomId',
        label: '内部房间 ID',
        hint: '目标房间的内部 ID：在 Matrix 客户端该房间的「设置 → 高级」里查看，形如 !QMdRCpUIfLwsfjxye6:home.server。',
        required: true,
      },
      {
        key: 'accessToken',
        label: 'Access Token',
        hint: '专用账号的访问令牌。强烈建议新建一个专用用户并只邀请它进通知房间，不要用自己的账号 Token（等于交出全部账号权限）。可用 POST /_matrix/client/v3/login（type: m.login.password）换取。',
        secret: true,
        required: true,
      },
      {
        key: 'matrixUseTemplate',
        label: '使用自定义模板',
        hint: '开启后用下面的模板渲染消息正文（填 true 开启；留空或填 false 关闭）。',
      },
      {
        key: 'matrixTemplate',
        label: '消息模板',
        hint: '基于 LiquidJS 的消息模板，仅在开启「使用自定义模板」后生效；留空用默认格式。',
        multiline: true,
        rows: 4,
      },
    ],
  },
  {
    type: 'mattermost',
    label: 'Mattermost',
    desc: 'Mattermost 频道 Incoming Webhook：告警发进自建协作平台的指定频道。',
    fields: [
      {
        key: 'mattermostWebhookUrl',
        label: 'Webhook URL',
        hint: 'Mattermost → 整合 → 传入的 Webhook（Incoming Webhook）里创建的完整地址。',
        placeholder: 'https://mattermost.example.com/hooks/…',
        required: true,
      },
      {
        key: 'mattermostusername',
        label: '显示名称（选填）',
        hint: '覆盖消息发送者显示的用户名，留空用 Webhook 默认值。',
      },
      {
        key: 'mattermosticonurl',
        label: '图标 URL（选填）',
        hint: '机器人头像图片的链接；设置了 Emoji 图标时此字段会被忽略。',
      },
      {
        key: 'mattermosticonemo',
        label: 'Emoji 图标（选填）',
        hint: '用 emoji 作为机器人头像，如 :rotating_light:（Emoji 速查见 unicode.org/emoji/charts/full-emoji-list.html）。',
      },
      {
        key: 'mattermostchannel',
        label: '频道名称（选填）',
        hint: '覆盖 Webhook 默认发送的频道，如 #other-channel；需要先在该 Webhook 设置里勾选允许覆盖频道。',
      },
    ],
  },
  {
    type: 'rocket-chat',
    label: 'Rocket.Chat',
    desc: 'Rocket.Chat 频道 Incoming Webhook。',
    fields: [
      {
        key: 'rocketwebhookURL',
        label: 'Webhook URL',
        hint: 'Rocket.Chat 管理后台 → Incoming Webhook 集成创建的完整地址。',
        placeholder: 'https://rocket.example.com/hooks/…',
        required: true,
      },
      {
        key: 'rocketusername',
        label: '显示名称（选填）',
        hint: '覆盖消息发送者显示的用户名。',
      },
      {
        key: 'rocketiconemo',
        label: 'Emoji 图标（选填）',
        hint: '用 emoji 作为机器人头像，如 :rotating_light:。',
      },
      {
        key: 'rocketchannel',
        label: '频道名称（选填）',
        hint: '覆盖默认频道：填 #频道名 或 @用户名（私信）。',
      },
    ],
  },
  {
    type: 'fluxer',
    label: 'Fluxer',
    desc: 'Fluxer 频道 Webhook：告警直接进指定频道的消息流。',
    fields: [
      {
        key: 'fluxerWebhookUrl',
        label: 'Webhook URL',
        hint: '目标频道的设置 → Webhooks → 创建 Webhook 后复制的完整地址。',
        required: true,
      },
      {
        key: 'fluxerUsername',
        label: '显示名称（选填）',
        hint: '覆盖 Webhook 消息的机器人显示名称。',
      },
      {
        key: 'fluxerPrefixMessage',
        label: '消息前缀（选填）',
        hint: '追加在消息正文之前的自定义前缀，如 @everyone 以提醒全体成员。',
      },
      {
        key: 'fluxerMessageFormat',
        label: '消息格式',
        hint: 'normal（默认富文本）/ minimalist（极简短状态）/ custom（自定义模板）三选一，留空按 normal。',
        placeholder: 'normal',
        initial: 'normal',
      },
      {
        key: 'fluxerUseMessageTemplate',
        label: '使用自定义模板',
        hint: '开启后用下面的模板渲染消息（基于 LiquidJS）。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'fluxerMessageTemplate',
        label: '消息模板',
        hint: '仅在「使用自定义模板」开启后生效，留空用默认格式。',
        multiline: true,
        rows: 4,
      },
      {
        key: 'disableUrl',
        label: '禁止解析链接',
        hint: '开启后消息里的链接不会被展开成预览卡片。填 true 开启；留空或填 false 关闭。',
      },
    ],
  },
  {
    type: 'google-chat',
    label: 'Google Chat',
    desc: 'Google Chat 群聊 Webhook：告警作为卡片消息发进指定聊天空间。',
    fields: [
      {
        key: 'googleChatWebhookURL',
        label: 'Webhook URL',
        hint: 'Google Chat 空间 → 空间名称 → 应用和集成 → Webhook → 添加后复制的完整地址（https://chat.googleapis.com/…）。',
        required: true,
      },
      {
        key: 'googleChatUseTemplate',
        label: '使用纯文本模板',
        hint: '上游 Android 客户端解析卡片偶有 bug，可开启此项改发纯文本模板。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'googleChatTemplate',
        label: '纯文本模板',
        hint: '仅在「使用纯文本模板」开启后生效（LiquidJS 语法），留空用默认格式。',
        multiline: true,
        rows: 4,
      },
    ],
  },
  {
    type: 'pumble',
    label: 'Pumble',
    desc: 'Pumble 团队聊天 Incoming Webhook。',
    fields: [
      {
        key: 'webhookURL',
        label: 'Webhook URL',
        hint: 'Pumble 应用里创建的 Incoming Webhook 完整地址。',
        required: true,
      },
    ],
  },
  {
    type: 'stackfield',
    label: 'Stackfield',
    desc: 'Stackfield（德式团队协作）组织内 Webhook。',
    fields: [
      {
        key: 'stackfieldwebhookURL',
        label: 'Webhook URL',
        hint: 'Stackfield 目标群组 / 讨论的 Webhook 集成地址。',
        required: true,
      },
    ],
  },
  {
    type: 'yzj',
    label: 'YZJ 机器人',
    desc: 'YZJ（云之家）群机器人 Webhook：企业 IM 群消息推送。',
    fields: [
      {
        key: 'yzjWebHookUrl',
        label: 'Webhook URL',
        hint: 'YZJ 群机器人拿到的完整 Webhook 地址。',
        required: true,
      },
      {
        key: 'yzjToken',
        label: '机器人 Token',
        hint: '该群机器人的 Token，与 Webhook 地址一并从机器人设置里复制。',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'zoho-cliq',
    label: 'Zoho Cliq',
    desc: 'Zoho Cliq 频道 Incoming Webhook。',
    fields: [
      {
        key: 'webhookUrl',
        label: 'Webhook URL',
        hint: '在 Zoho Cliq 目标频道 / Bot 的「Hooks」里创建的 Incoming Webhook 完整地址。',
        required: true,
      },
    ],
  },
  {
    type: 'vk',
    label: 'VK',
    desc: 'VK（俄罗斯社交平台）站内消息推送：通过 VK API 给指定会话发消息。',
    fields: [
      {
        key: 'vkAccessToken',
        label: 'Access Token',
        hint: 'VK 开发者后台创建的访问令牌（建议用仅含 messages 权限的社区令牌）。',
        secret: true,
        required: true,
      },
      {
        key: 'vkApiVersion',
        label: 'API 版本',
        hint: '请求使用的 VK API 版本号，保持默认即可，仅在有兼容性需求时改。',
        placeholder: '5.131',
        initial: '5.131',
        required: true,
      },
      {
        key: 'vkPeerId',
        label: 'Peer ID',
        hint: '目标会话的 peer_id，原样发给 API：用户为正数、群聊为 2000000000+群 ID、社区消息为负数。',
        required: true,
      },
      {
        key: 'vkDontParseLinks',
        label: '禁用链接摘要',
        hint: '开启后 VK 不再为消息里的链接生成预览卡片。填 true 开启；留空或填 false 关闭。',
      },
    ],
  },
  {
    type: 'vkteams',
    label: 'VK Teams',
    desc: 'VK Teams（Myteam 企业版）Bot 推送。',
    fields: [
      {
        key: 'vkteamsBotToken',
        label: 'Bot Token',
        hint: '在 VK Teams（myteam.mail.ru）的 Bot 平台创建机器人后获取的令牌。',
        secret: true,
        required: true,
      },
      {
        key: 'vkteamsChatId',
        label: 'Chat ID',
        hint: '接收消息的用户填其邮箱地址；群组 / 频道在其设置里复制 ID 并追加 @chat.agent（如 *****@chat.agent）。',
        placeholder: 'user@example.com 或 ******@chat.agent',
        required: true,
      },
      {
        key: 'vkteamsBaseUrl',
        label: 'API 地址',
        hint: 'VK Teams 的基础 API 地址，自建（On-Premise）部署时需要改。默认 https://myteam.mail.ru。',
        placeholder: 'https://myteam.mail.ru',
        initial: 'https://myteam.mail.ru',
        required: true,
      },
      {
        key: 'vkteamsUseTemplate',
        label: '使用自定义模板',
        hint: '开启后消息按下面的模板发送。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'vkteamsTemplateFormat',
        label: '消息格式',
        hint: '模板的排版语言：plain（纯文本）/ MarkdownV2 / HTML，留空按 plain。',
        placeholder: 'plain',
        initial: 'plain',
      },
      {
        key: 'vkteamsTemplate',
        label: '消息模板',
        hint: '仅在「使用自定义模板」开启后生效，留空用默认格式。',
        multiline: true,
        rows: 4,
      },
    ],
  },
  {
    type: 'max',
    label: 'MAX',
    desc: 'MAX messenger Bot 推送。',
    fields: [
      {
        key: 'maxBotToken',
        label: 'Bot Token',
        hint: '在 MAX Bot 平台（platform-api.max.ru）创建机器人后获取的令牌。',
        secret: true,
        required: true,
      },
      {
        key: 'maxApiUrl',
        label: 'API 地址',
        hint: 'MAX 的基础 API 地址，默认 https://platform-api.max.ru。',
        placeholder: 'https://platform-api.max.ru',
        initial: 'https://platform-api.max.ru',
        required: true,
      },
      {
        key: 'maxChatID',
        label: 'Chat ID',
        hint: '消息目的地的 chat id（用户 / 群聊会话标识）。',
        required: true,
      },
      {
        key: 'maxUseTemplate',
        label: '使用自定义模板',
        hint: '开启后消息按下面的模板发送。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'maxTemplateFormat',
        label: '消息格式',
        hint: 'MAX 支持的排版语言：plain（纯文本）/ markdown / html，留空按 plain。',
        placeholder: 'plain',
        initial: 'plain',
      },
      {
        key: 'maxTemplate',
        label: '消息模板',
        hint: '仅在「使用自定义模板」开启后生效，留空用默认格式。',
        multiline: true,
        rows: 4,
      },
    ],
  },
  {
    type: 'milky',
    label: 'Milky',
    desc: 'Milky（QQ 机器人协议）HTTP 推送：向支持 Milky 协议的 QQ 机器人发送群聊 / 私聊消息。',
    fields: [
      {
        key: 'httpAddr',
        label: 'Milky HTTP 地址',
        hint: 'Milky 服务端的 HTTP 地址，结尾无需带 /api 后缀（如 http://127.0.0.1:3000）。',
        placeholder: 'http://127.0.0.1:3000',
        required: true,
      },
      {
        key: 'accessToken',
        label: 'AccessToken',
        hint: 'Milky 服务端设置的访问令牌（出于安全考虑必须设置）。',
        secret: true,
        required: true,
      },
      {
        key: 'msgType',
        label: '消息类型',
        hint: 'group（群聊消息）或 private（私聊消息），留空按 group。',
        placeholder: 'group',
        initial: 'group',
      },
      {
        key: 'recieverId',
        label: '群聊 / 用户 ID',
        hint: '按「消息类型」填对应的群号或 QQ 号。',
        required: true,
      },
    ],
  },
  {
    type: 'onebot',
    label: 'OneBot',
    desc: 'OneBot（QQ 机器人协议）HTTP 推送：向支持 OneBot 11 的实现发送群聊 / 私聊消息。',
    fields: [
      {
        key: 'httpAddr',
        label: 'OneBot HTTP 地址',
        hint: 'OneBot 实现的 HTTP 上报地址（如 http://127.0.0.1:5700）。',
        placeholder: 'http://127.0.0.1:5700',
        required: true,
      },
      {
        key: 'accessToken',
        label: 'AccessToken',
        hint: 'OneBot 实现配置的访问令牌（出于安全原因请务必设置）。',
        secret: true,
        required: true,
      },
      {
        key: 'msgType',
        label: '消息类型',
        hint: 'group（群聊消息）或 private（私聊消息），留空按 group。',
        placeholder: 'group',
        initial: 'group',
      },
      {
        key: 'recieverId',
        label: '群组 / 用户 ID',
        hint: '按「消息类型」填对应的群号或 QQ 号。',
        required: true,
      },
    ],
  },
  {
    type: 'onechat',
    label: 'OneChat',
    desc: 'OneChat Bot 推送（泰国聊天平台）。',
    fields: [
      {
        key: 'accessToken',
        label: 'Access Token',
        hint: 'OneChat 平台里机器人的 Access Token。',
        secret: true,
        required: true,
      },
      {
        key: 'recieverId',
        label: '用户 / 群组 ID',
        hint: '接收消息的 OneChat 用户 ID 或群组 ID。',
        required: true,
      },
      {
        key: 'botId',
        label: 'Bot ID',
        hint: '发送消息的 OneChat 机器人 ID。',
        required: true,
      },
    ],
  },
  {
    type: 'onesender',
    label: 'Onesender',
    desc: 'Onesender（WhatsApp 网关）消息推送。',
    fields: [
      {
        key: 'onesenderURL',
        label: 'Onesender 地址',
        hint: 'Onesender 实例的消息接口地址（到 /api/v1/messages）。',
        placeholder: 'https://your-host.com/api/v1/messages',
        required: true,
      },
      {
        key: 'onesenderToken',
        label: 'Token',
        hint: 'Onesender 后台生成的访问令牌。',
        secret: true,
        required: true,
      },
      {
        key: 'onesenderTypeReceiver',
        label: '收件人类型',
        hint: 'private（私信号码）或 group（群组），留空按 private。',
        placeholder: 'private',
        initial: 'private',
      },
      {
        key: 'onesenderReceiver',
        label: '收件人',
        hint: 'private 填手机号（如 628123456789）；group 填有效的群组 ID（如 628123456789-342345）。',
        required: true,
      },
    ],
  },
  {
    type: 'nextcloudtalk',
    label: 'Nextcloud Talk',
    desc: 'Nextcloud Talk 会话 Bot 推送（自托管网盘的聊天组件）。',
    fields: [
      {
        key: 'host',
        label: 'Nextcloud 主机地址',
        hint: 'Nextcloud 站点根地址（含 http(s)://），如 https://cloud.example.com。',
        placeholder: 'https://cloud.example.com',
        required: true,
      },
      {
        key: 'conversationToken',
        label: '会话令牌',
        hint: '目标 Talk 会话的 token：浏览器里打开该会话时 URL 最后一串字符（如 /call/abc12345 里的 abc12345）。',
        secret: true,
        required: true,
      },
      {
        key: 'botSecret',
        label: 'Bot 密钥',
        hint: '在 Talk 会话里添加「Bot」时设置的随机密钥（Bot secret），两边保持一致。',
        secret: true,
        required: true,
      },
      {
        key: 'sendSilentUp',
        label: '静默发送恢复事件',
        hint: '恢复正常（UP）事件不发出提醒声音。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'sendSilentDown',
        label: '静默发送故障事件',
        hint: '故障（DOWN）事件不发出提醒声音。填 true 开启；留空或填 false 关闭。',
      },
    ],
  },
  {
    type: 'signal',
    label: 'Signal',
    desc: 'Signal 消息推送：需要一个带 REST API 的 signal-cli 客户端（自建）。',
    fields: [
      {
        key: 'signalURL',
        label: 'Post URL',
        hint: 'signal-cli-rest-api 服务的根地址（http:// 或 https://）。没有的话需要先部署一个带 REST API 的 Signal 客户端。',
        placeholder: 'http://signal.example.com:8080',
        required: true,
      },
      {
        key: 'signalNumber',
        label: '发信号码',
        hint: '注册在 signal-cli 里、用来发送消息的 Signal 手机号（E.164 格式，如 +8613800000000）。',
        required: true,
      },
      {
        key: 'signalRecipients',
        label: '收件人',
        hint: '收件人号码或群组 ID，多个用逗号分隔。注意：不能把号码与群组混在一起填。',
        required: true,
      },
      {
        key: 'signalUseTemplate',
        label: '使用自定义模板',
        hint: '开启后消息按下面的模板发送（Liquid 模板语法）。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'signalTemplate',
        label: '消息模板',
        hint: '仅在「使用自定义模板」开启后生效，留空用默认格式。',
        multiline: true,
        rows: 4,
      },
    ],
  },
  {
    type: 'threema',
    label: 'Threema',
    desc: 'Threema 网关推送（瑞士加密通讯，基础模式为服务器端加密）。',
    fields: [
      {
        key: 'threemaRecipientType',
        label: '收件人类型',
        hint: 'identity（Threema ID，8 位）/ phone（手机号，E.164 不带 +）/ email（邮箱）三选一，留空按 identity。',
        placeholder: 'identity',
        initial: 'identity',
      },
      {
        key: 'threemaRecipient',
        label: '收件人',
        hint: '按「收件人类型」填：Threema ID（8 位字符）、手机号（如 41791234567）或邮箱地址。',
        required: true,
      },
      {
        key: 'threemaSenderIdentity',
        label: '网关 ID（Gateway-ID）',
        hint: 'Threema Gateway 的发件 ID，8 位字符，通常以 * 开头。',
        required: true,
      },
      {
        key: 'threemaSecret',
        label: '网关密钥',
        hint: 'Threema Gateway 的 ID 密钥（Gateway-ID Secret）。在 gateway.threema.ch 注册网关后获取。',
        secret: true,
        required: true,
      },
    ],
  },

  // WhatsApp / 消息网关与移动推送
  {
    type: 'whapi',
    label: 'Whapi',
    desc: 'Whapi Cloud（WhatsApp API 网关）消息推送。',
    fields: [
      {
        key: 'whapiApiUrl',
        label: 'API 地址',
        hint: 'Whapi 通道的 API 根地址，默认 https://gate.whapi.cloud/。',
        placeholder: 'https://gate.whapi.cloud/',
        initial: 'https://gate.whapi.cloud/',
        required: true,
      },
      {
        key: 'whapiAuthToken',
        label: 'Token',
        hint: '在 Whapi 控制台进入目标通道后获取的 API Token。',
        secret: true,
        required: true,
      },
      {
        key: 'whapiRecipient',
        label: '收件人',
        hint: '接收消息的手机号 / 联系人 ID / 群组 ID。',
        required: true,
      },
    ],
  },
  {
    type: 'waha',
    label: 'WAHA',
    desc: 'WAHA（WhatsApp HTTP API，自托管）消息推送。',
    fields: [
      {
        key: 'wahaApiUrl',
        label: 'API 地址',
        hint: 'WAHA 实例的根地址，如 http://localhost:3000/。',
        placeholder: 'http://localhost:3000/',
        required: true,
      },
      {
        key: 'wahaApiKey',
        label: 'API Key（选填）',
        hint: '即启动 WAHA 时设置的 WHATSAPP_API_KEY 环境变量的值。',
        secret: true,
      },
      {
        key: 'wahaSession',
        label: '会话',
        hint: 'WAHA 用于发送通知的会话（session）名，在 WAHA 仪表板里可以看到。',
        placeholder: 'default',
        required: true,
      },
      {
        key: 'wahaChatId',
        label: '聊天 ID',
        hint: '接收消息的手机号 / 联系人 ID / 群组 ID。',
        required: true,
      },
    ],
  },
  {
    type: 'openwa',
    label: 'OpenWA',
    desc: 'OpenWA（WhatsApp Web API，自托管）消息推送。',
    fields: [
      {
        key: 'openwaApiUrl',
        label: 'API 地址',
        hint: 'OpenWA 实例的根地址，如 http://localhost:2785/。',
        placeholder: 'http://localhost:2785/',
        required: true,
      },
      {
        key: 'openwaApiKey',
        label: 'API Key',
        hint: 'OpenWA 实例使用的 API 密钥。',
        secret: true,
        required: true,
      },
      {
        key: 'openwaSession',
        label: '会话',
        hint: 'OpenWA 用于发送通知的会话 ID（session）。',
        placeholder: 'default',
        required: true,
      },
      {
        key: 'openwaChatId',
        label: '聊天 ID',
        hint: '接收消息的手机号 / 联系人 ID / 群组 ID。',
        required: true,
      },
      {
        key: 'openwaUseCustomMessage',
        label: '自定义消息（可选）',
        hint: '开启后用下面的自定义消息替代默认消息。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'openwaCustomMessage',
        label: '自定义消息内容',
        hint: '仅在开启「自定义消息」后生效，留空则用默认消息。',
        multiline: true,
        rows: 4,
      },
    ],
  },
  {
    type: 'evolution',
    label: 'Evolution API',
    desc: 'Evolution API（WhatsApp 网关，自托管）消息推送。',
    fields: [
      {
        key: 'evolutionApiUrl',
        label: 'API 地址',
        hint: 'Evolution API 实例的根地址，如 https://evoapicloud.com/。',
        placeholder: 'https://evoapicloud.com/',
        required: true,
      },
      {
        key: 'evolutionInstanceName',
        label: '实例名称',
        hint: 'Evolution API 里用来发消息的实例（instance）名。',
        required: true,
      },
      {
        key: 'evolutionAuthToken',
        label: 'Token',
        hint: '该实例的鉴权令牌（Enter your desired channel 后可获取）。',
        secret: true,
        required: true,
      },
      {
        key: 'evolutionRecipient',
        label: '收件人',
        hint: '接收消息的手机号 / 联系人 ID / 群组 ID。',
        required: true,
      },
      {
        key: 'evolutionUseCustomMessage',
        label: '自定义消息（可选）',
        hint: '开启后用下面的自定义消息替代默认消息。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'evolutionCustomMessage',
        label: '自定义消息内容',
        hint: '仅在开启「自定义消息」后生效，留空则用默认消息。',
        multiline: true,
        rows: 4,
      },
    ],
  },
  {
    type: '360messenger',
    label: '360messenger',
    desc: '360messenger（WhatsApp 商务网关）消息推送。',
    fields: [
      {
        key: 'Whatsapp360messengerAuthToken',
        label: 'API Key',
        hint: '在 360messenger 后台获取的 API 密钥。',
        secret: true,
        required: true,
      },
      {
        key: 'Whatsapp360messengerRecipient',
        label: '收件人手机号',
        hint: '接收消息的手机号，多个用逗号分隔（如 447488888888, 447499999999）。',
        placeholder: '447488888888, 447499999999',
      },
      {
        key: 'Whatsapp360messengerGroupIds',
        label: 'WhatsApp 分组 ID',
        hint: '要发送到的 WhatsApp 分组 ID，多个用逗号分隔。',
      },
      {
        key: 'Whatsapp360messengerUseTemplate',
        label: '使用消息模板',
        hint: '开启后按下面的模板发送。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'Whatsapp360messengerTemplate',
        label: '消息模板',
        hint: '仅在「使用消息模板」开启后生效。',
        multiline: true,
        rows: 4,
      },
    ],
  },
  {
    type: 'call-me-bot',
    label: 'CallMeBot',
    desc: 'CallMeBot 免费个人推送：向 WhatsApp / Telegram / 短信 / 电话发一条提醒。',
    fields: [
      {
        key: 'callMeBotEndpoint',
        label: 'Endpoint',
        hint: '按 CallMeBot（callmebot.com）各渠道的指引为自己的账号生成的完整端点 URL（已含密钥参数），整段填入。注意该服务有速率限制（大约每条消息间隔需数秒以上）。',
        required: true,
      },
    ],
  },
  {
    type: 'nostr',
    label: 'Nostr',
    desc: 'Nostr 去中心化社交协议推送：把告警作为事件发布到 relay。',
    fields: [
      {
        key: 'relays',
        label: 'Relay 地址',
        hint: '要发布到的 Nostr relay 服务地址，每行一个（如 wss://relay.damus.io）。',
        placeholder: 'wss://127.0.0.1:7777/',
        multiline: true,
        rows: 3,
        required: true,
      },
      {
        key: 'sender',
        label: '发送者私钥（nsec）',
        hint: '用于签名发布事件的发送者私钥（nsec 开头）。建议使用专用密钥，不要填个人主号。',
        secret: true,
        required: true,
      },
      {
        key: 'recipients',
        label: '接收者公钥（npub）',
        hint: '接收告警的公钥（npub 开头），每行一个。',
        placeholder: 'npub123…',
        multiline: true,
        rows: 3,
        required: true,
      },
    ],
  },
  {
    type: 'lunasea',
    label: 'LunaSea',
    desc: 'LunaSea（iOS / Android 自托管通知 App）推送。',
    fields: [
      {
        key: 'lunaseaTarget',
        label: '目标类型',
        hint: 'device（按设备 ID 推送）或 user（按用户 ID 推送），留空按 device。',
        placeholder: 'device',
        initial: 'device',
      },
      {
        key: 'lunaseaDevice',
        label: '设备 ID',
        hint: 'LunaSea App 里显示的设备 ID（Device ID）；按设备推送时必填。',
      },
      {
        key: 'lunaseaUserID',
        label: '用户 ID',
        hint: 'LunaSea 账号的用户 ID（User ID）；按用户推送时必填。',
      },
    ],
  },
  {
    type: 'wxpusher',
    label: 'WxPusher',
    desc: 'WxPusher Simple Push：通过 WxPusher App 在 Android / iOS / 鸿蒙 / 桌面端推送。',
    fields: [
      {
        key: 'wxpusherSPT',
        label: 'SPT',
        hint: 'WxPusher App 扫码获取的 Simple Push Token（SPT_ 开头）；需要多个时用英文逗号分隔。',
        placeholder: 'SPT_xxxxxxxxxxxx',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'pushplus',
    label: 'PushPlus（推送加）',
    desc: 'PushPlus：告警推送到微信公众号 / 微信。',
    fields: [
      {
        key: 'pushPlusSendKey',
        label: 'SendKey',
        hint: '在 pushplus.plus 官网微信扫码登录后得到的 SendKey，一对一推送只需它。',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'pushdeer',
    label: 'PushDeer',
    desc: 'PushDeer 开源推送：iOS / Android App 接收（支持自建服务端）。',
    fields: [
      {
        key: 'pushdeerServer',
        label: 'PushDeer 服务器（选填）',
        hint: '自建 PushDeer 服务端填其地址；留空使用官方服务器 https://api2.pushdeer.com。',
        placeholder: 'https://api2.pushdeer.com',
      },
      {
        key: 'pushdeerKey',
        label: 'PushDeer Key',
        hint: 'PushDeer App（设备页）里生成的推送 Key（PDU 开头）。',
        placeholder: 'PDUxxxx',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'pushy',
    label: 'Pushy',
    desc: 'Pushy（面向 App 的推送服务）设备推送。',
    fields: [
      {
        key: 'pushyAPIKey',
        label: 'API Key',
        hint: 'Pushy 控制台里的 Secret API Key。',
        secret: true,
        required: true,
      },
      {
        key: 'pushyToken',
        label: '设备 Token',
        hint: '接收推送的设备在 Pushy SDK 里注册得到的 Device Token。',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'spugpush',
    label: 'SpugPush',
    desc: 'SpugPush（spug.cc 免费推送服务）消息推送。',
    fields: [
      {
        key: 'templateKey',
        label: '模板代码',
        hint: '在 spug.cc 推送服务里创建后获得的模板代码（Template Code）。',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'techulus-push',
    label: 'Push by Techulus',
    desc: 'Push by Techulus（iOS / Android 推送 App）。',
    fields: [
      {
        key: 'pushAPIKey',
        label: 'API Key',
        hint: '在 techulus 官方控制台（push.techulus.com）获取的 API Key。',
        secret: true,
        required: true,
      },
      {
        key: 'pushTitle',
        label: '标题（选填）',
        hint: '覆盖通知标题，留空用默认。',
      },
      {
        key: 'pushChannel',
        label: '通知频道（选填）',
        hint: '仅限字母、数字和连字符（-）的频道名；留空用默认频道。',
      },
      {
        key: 'pushSound',
        label: '提示音（选填）',
        hint: '覆盖默认通知声音，可选 default / arcade / correct / fail / harp / reveal / bubble / doorbell / flute / money / scifi / clear / elevator / guitar / pop。',
      },
      {
        key: 'pushTimeSensitive',
        label: '即时通知（仅 iOS）',
        hint: '开启后 iOS 会以「时效性通知」立即呈现。填 true 开启；留空或填 false 关闭。',
      },
    ],
  },
  {
    type: 'wpush',
    label: 'WPush',
    desc: 'WPush 聚合推送：一个 Key 走微信 / 短信 / 邮件 / 飞书等通道。',
    fields: [
      {
        key: 'wpushAPIkey',
        label: 'API Key',
        hint: 'WPush 平台（wpush.cn）生成的 API Key。',
        placeholder: 'WPushxxxxx',
        secret: true,
        required: true,
      },
      {
        key: 'wpushChannel',
        label: '发送通道',
        hint: '选择推送通道：wechat（微信）/ sms（短信）/ mail（邮件）/ feishu（飞书）/ dingtalk（钉钉）/ wechat_work（企业微信）。',
        required: true,
      },
    ],
  },
  {
    type: 'pinglet',
    label: 'Pinglet',
    desc: 'Pinglet 主题订阅推送：App 订阅同主题即可收告警。',
    fields: [
      {
        key: 'pingletPublishUrl',
        label: '主题 URL',
        hint: 'Pinglet 主题的发布地址（如 https://app.pinglet.co.uk/your-namespace/alerts）；主题不存在时首次发布自动创建。',
        placeholder: 'https://app.pinglet.co.uk/your-namespace/alerts',
        required: true,
      },
      {
        key: 'pingletApiKey',
        label: 'API Key',
        hint: 'Pinglet 后台的 API 密钥。',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'notifery',
    label: 'Notifery',
    desc: 'Notifery（自托管推送服务）消息推送。',
    fields: [
      {
        key: 'notiferyApiKey',
        label: 'API Key',
        hint: 'Notifery 后台生成的 API 密钥。',
        secret: true,
        required: true,
      },
      {
        key: 'notiferyTitle',
        label: '标题（选填）',
        hint: '覆盖通知标题，留空用默认。',
        placeholder: 'Uptime Kuma Alert',
      },
      {
        key: 'notiferyGroup',
        label: '分组（选填）',
        hint: '通知归属的分组名，便于在 App 里归类。',
      },
    ],
  },
  {
    type: 'notifyapp',
    label: 'Notify!',
    desc: 'Notify! App（安卓推送）单设备或分组推送。',
    fields: [
      {
        key: 'notifyAppDeviceId',
        label: '设备 ID / 分组 ID',
        hint: 'Notify! App 里的设备 ID（Device ID）；填分组 ID 则同时提醒分组内所有设备。',
        placeholder: 'ABC12345',
        required: true,
      },
      {
        key: 'notifyAppToken',
        label: 'Token',
        hint: 'Notify! 服务的访问令牌。',
        secret: true,
        required: true,
      },
      {
        key: 'notifyAppIconUrl',
        label: '图标 URL（选填）',
        hint: '通知里显示的图标图片链接。',
      },
    ],
  },
  {
    type: 'gorush',
    label: 'Gorush',
    desc: 'Gorush（Go 编写的 APNs / FCM 代理，自托管）移动推送。',
    fields: [
      {
        key: 'gorushDeviceToken',
        label: '设备 Token',
        hint: '目标设备的推送 Token（Apple Device Token）。',
        required: true,
      },
      {
        key: 'gorushServerURL',
        label: '服务器地址',
        hint: '自建 Gorush 服务的地址（http:// 或 https://）。',
        placeholder: 'https://gorush.example.com',
        required: true,
      },
      {
        key: 'gorushPlatform',
        label: '平台',
        hint: '目标平台：ios / android / huawei。',
        placeholder: 'ios',
        initial: 'ios',
        required: true,
      },
      {
        key: 'gorushTitle',
        label: '标题（选填）',
        hint: '覆盖通知标题，留空用默认。',
      },
      {
        key: 'gorushPriority',
        label: '优先级',
        hint: 'normal（普通）或 high（高），留空按 Gorush 默认。',
        placeholder: 'normal',
        initial: 'normal',
      },
      {
        key: 'gorushRetry',
        label: '重试次数',
        hint: '发送失败时的重试次数（数字），留空不重试。',
        number: true,
      },
      {
        key: 'gorushTopic',
        label: 'Topic',
        hint: '推送主题（APNs 的 topic 通常是 App 的 Bundle ID；FCM 场景按 Gorush 配置填）。',
        required: true,
      },
    ],
  },

  // 事件与值班管理
  {
    type: 'alerta',
    label: 'Alerta',
    desc: 'Alerta（开源告警聚合平台）事件上报。',
    fields: [
      {
        key: 'alertaApiEndpoint',
        label: 'API 接入点',
        hint: 'Alerta 服务端的 API 根地址（http:// 或 https://）。',
        placeholder: 'https://alerta.example.com/api',
        required: true,
      },
      {
        key: 'alertaEnvironment',
        label: '环境参数',
        hint: '事件标注的环境名（如 Production / Development），便于在 Alerta 里区分来源。',
        required: true,
      },
      {
        key: 'alertaApiKey',
        label: 'API Key（选填）',
        hint: 'Alerta 后台创建的读写 API 密钥；服务端未开启鉴权时可留空。',
        secret: true,
      },
      {
        key: 'alertaAlertState',
        label: '报警时的严重性',
        hint: '故障（DOWN）事件写入的严重性级别，如 critical / major / minor / warning / informational。',
        placeholder: 'critical',
        initial: 'critical',
        required: true,
      },
      {
        key: 'alertaRecoverState',
        label: '恢复后的严重性',
        hint: '恢复正常（UP）时写入的级别，常用 cleared 或 normal。',
        placeholder: 'cleared',
        initial: 'cleared',
        required: true,
      },
    ],
  },
  {
    type: 'alertnow',
    label: 'AlertNow',
    desc: 'AlertNow（值班告警平台）事件上报。',
    fields: [
      {
        key: 'alertNowWebhookURL',
        label: 'Webhook URL',
        hint: '在 AlertNow 控制台为 Uptime Kuma 创建集成后拿到的完整接收地址。',
        required: true,
      },
    ],
  },
  {
    type: 'flashduty',
    label: 'FlashDuty',
    desc: 'FlashDuty（快猫星云，值班告警平台）事件上报。',
    fields: [
      {
        key: 'flashdutyIntegrationKey',
        label: '推送 URL',
        hint: 'FlashDuty 控制台 → 协作空间 → 集成数据 → 新增集成，选择 Uptime Kuma 后复制的推送 URL（整段含域名与 key）。',
        secret: true,
        required: true,
      },
      {
        key: 'flashdutySeverity',
        label: '严重程度',
        hint: '事件严重级别：Info / Warning / Critical 三档，留空按 Info。',
        placeholder: 'Info',
        initial: 'Info',
      },
    ],
  },
  {
    type: 'goalert',
    label: 'GoAlert',
    desc: 'GoAlert（开源值班调度与升级告警）事件上报。',
    fields: [
      {
        key: 'goAlertBaseURL',
        label: '基础地址',
        hint: 'GoAlert 站点的根地址（http:// 或 https://）。',
        placeholder: 'https://goalert.example.com',
        required: true,
      },
      {
        key: 'goAlertToken',
        label: 'Token',
        hint: '目标服务的通用 API 集成密钥，形如 aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee，通常是复制来的链接里 token 参数的值。',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'grafana-oncall',
    label: 'Grafana OnCall',
    desc: 'Grafana OnCall（值班与升级告警）事件上报。',
    fields: [
      {
        key: 'GrafanaOncallURL',
        label: '接收地址',
        hint: 'Grafana OnCall 里创建「Outgoing Webhook / Alert 接收端」后得到的完整 URL。',
        required: true,
      },
    ],
  },
  {
    type: 'heii-oncall',
    label: 'Heii On-Call',
    desc: 'Heii On-Call（值班告警服务）触发器调用。',
    fields: [
      {
        key: 'heiiOnCallApiKey',
        label: 'API Key',
        hint: 'Heii On-Call 后台的 API 密钥；获取方式见其文档（heii-oncall.dev）。',
        secret: true,
        required: true,
      },
      {
        key: 'heiiOnCallTriggerId',
        label: 'Trigger ID',
        hint: '要触发的 Trigger ID；获取方式见其文档。',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'home-assistant',
    label: 'Home Assistant',
    desc: 'Home Assistant（智能家居平台）通知触发：调用指定的 notify 通知动作。',
    fields: [
      {
        key: 'homeAssistantUrl',
        label: 'Home Assistant 地址',
        hint: 'Home Assistant 的完整访问地址（含 http(s):// 与端口，如 https://ha.example.com:8123）。',
        placeholder: 'https://ha.example.com:8123',
        required: true,
      },
      {
        key: 'longLivedAccessToken',
        label: '长期访问令牌',
        hint: 'Home Assistant 个人资料页最下方「长期访问令牌」里创建的 Token（Long-Lived Access Token）。',
        secret: true,
        required: true,
      },
      {
        key: 'notificationService',
        label: '通知动作（选填）',
        hint: '要调用的 notify 动作，只填 notify. 后面的部分：如动作是 notify.mobile_app_xyz 就填 mobile_app_xyz；留空通知全部设备。',
        placeholder: 'mobile_app_xyz',
      },
    ],
  },
  {
    type: 'indigo',
    label: 'Indigo',
    desc: 'Indigo（macOS 智能家居平台）变量更新与动作组触发。',
    fields: [
      {
        key: 'indigoUrl',
        label: 'Indigo 地址',
        hint: 'Indigo Reflector 地址（https://名称.indigodomo.net）或局域网 Web Server 地址（https://IP:8176）。',
        placeholder: 'https://your-reflector.indigodomo.net',
        required: true,
      },
      {
        key: 'indigoIgnoreTlsError',
        label: '忽略 TLS 错误',
        hint: '局域网自建 Web Server 用自签证书时需要开启；Reflector 不需要。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'indigoApiKey',
        label: 'API Key',
        hint: 'Indigo 账号「Authorizations」里的 API Key，或局域网 Web Server 设置的本地密钥。',
        secret: true,
        required: true,
      },
      {
        key: 'indigoVariableId',
        label: '变量 ID（选填）',
        hint: '告警消息会写入这个 Indigo 变量（数字 ID）。在 Indigo 里右键变量 → Copy ID 获取。',
        number: true,
      },
      {
        key: 'indigoActionGroupId',
        label: '动作组 ID（选填）',
        hint: '变量更新后执行的动作组（数字 ID）。在 Indigo 里右键动作组 → Copy ID 获取。变量与动作组至少填一个。',
        number: true,
      },
    ],
  },
  {
    type: 'jira-service-management',
    label: 'Jira Service Management',
    desc: 'Jira Service Management（Atlassian，原 Opsgenie 同族）告警事件上报。',
    fields: [
      {
        key: 'jsmCloudId',
        label: 'Cloud ID',
        hint: 'Atlassian 站点的 Cloud ID：登录 admin.atlassian.com 查看站点信息，或访问 <站点>/_edge/tenant_info 获取。',
        required: true,
      },
      {
        key: 'jsmEmail',
        label: '邮箱',
        hint: '用于调用 API 的 Atlassian 账号邮箱。',
        required: true,
      },
      {
        key: 'jsmApiToken',
        label: 'API Token',
        hint: '在 id.atlassian.com → 安全 → 创建和管理 API 令牌 里生成的令牌。',
        secret: true,
        required: true,
      },
      {
        key: 'jsmPriority',
        label: '优先级（选填）',
        hint: '告警优先级（数字，1 最高）；留空用 Jira 默认。',
        number: true,
      },
    ],
  },
  {
    type: 'keep',
    label: 'Keep',
    desc: 'Keep（开源告警管理平台）Webhook 上报。',
    fields: [
      {
        key: 'webhookURL',
        label: '服务器地址',
        hint: 'Keep 服务端的 Webhook 接收地址（Provider 的 Incoming Webhook）。',
        placeholder: 'https://keep.example.com',
        required: true,
      },
      {
        key: 'webhookAPIKey',
        label: 'API Key',
        hint: 'Keep 的 API 密钥（与该 Webhook Provider 关联）。',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'opsgenie',
    label: 'Opsgenie',
    desc: 'Opsgenie（Atlassian 值班告警）事件上报。',
    fields: [
      {
        key: 'opsgenieRegion',
        label: '区域',
        hint: '账号所在区域：us（默认，api.opsgenie.com）或 eu（api.eu.opsgenie.com）。',
        placeholder: 'us',
        initial: 'us',
      },
      {
        key: 'opsgenieApiKey',
        label: 'API Key',
        hint: 'Opsgenie「API 集成」里生成的 GenieKey。',
        secret: true,
        required: true,
      },
      {
        key: 'opsgeniePriority',
        label: '优先级（选填）',
        hint: '告警优先级（数字 1-5，1 最高）；留空用 Opsgenie 默认。',
        number: true,
      },
    ],
  },
  {
    type: 'pagerduty',
    label: 'PagerDuty',
    desc: 'PagerDuty（值班告警平台）Events API v2 上报。',
    fields: [
      {
        key: 'pagerdutyIntegrationKey',
        label: 'Integration Key',
        hint: 'Service → Service Directory → 选择服务 → Integrations → Add integration 搜索「Events API V2」后得到的 32 位 Integration Key（Routing Key）。',
        secret: true,
        required: true,
      },
      {
        key: 'pagerdutyIntegrationUrl',
        label: '集成地址（选填）',
        hint: 'Events API v2 的接收地址；留空用官方默认（https://events.pagerduty.com/v2/enqueue）。',
      },
      {
        key: 'pagerdutyPriority',
        label: '严重性',
        hint: '事件严重级别：info / warning（默认）/ error / critical。',
        placeholder: 'warning',
        initial: 'warning',
      },
      {
        key: 'pagerdutyAutoResolve',
        label: '恢复时的动作',
        hint: '服务恢复时的处理：0（不操作，默认）/ acknowledge（自动标记为已读）/ resolve（自动标记为已解决）。',
        placeholder: '0',
        initial: '0',
      },
    ],
  },
  {
    type: 'pagertree',
    label: 'PagerTree',
    desc: 'PagerTree（值班告警平台）事件上报。',
    fields: [
      {
        key: 'pagertreeIntegrationUrl',
        label: '集成 URL',
        hint: '在 PagerTree 里创建 Uptime Kuma 集成后复制的端点地址。',
        required: true,
      },
      {
        key: 'pagertreeUrgency',
        label: '紧急程度',
        hint: 'silent（静默）/ low（低）/ medium（中）/ high（高）/ critical（严重），留空按 PagerTree 默认。',
        placeholder: 'low',
      },
      {
        key: 'pagertreeAutoResolve',
        label: '自动解除',
        hint: '服务恢复时是否自动解除告警：resolve（自动解除）或 0（不操作，默认）。',
        placeholder: '0',
        initial: '0',
      },
    ],
  },
  {
    type: 'signl4',
    label: 'SIGNL4',
    desc: 'SIGNL4（移动值班告警）团队 Webhook 上报。',
    fields: [
      {
        key: 'webhookURL',
        label: 'SIGNL4 Webhook URL',
        hint: 'SIGNL4 团队的入站 Webhook 地址（在 SIGNL4 后台「Develop → Webhook」获取；完整说明见其文档 signl4.com）。',
        required: true,
      },
    ],
  },
  {
    type: 'signalgrid',
    label: 'Signalgrid',
    desc: 'Signalgrid（值班告警）事件上报。',
    fields: [
      {
        key: 'signalgridClientKey',
        label: 'Client Key',
        hint: 'Signalgrid 集成的 Client Key。',
        secret: true,
        required: true,
      },
      {
        key: 'signalgridChannel',
        label: 'Channel',
        hint: '接收告警的 Signalgrid 频道标识。',
        required: true,
      },
    ],
  },
  {
    type: 'splunk',
    label: 'Splunk',
    desc: 'Splunk Event Collector（HEC）事件上报。',
    fields: [
      {
        key: 'splunkRestURL',
        label: 'Splunk REST 地址',
        hint: 'Splunk HTTP Event Collector 的完整地址（含端口与 collector 端点，如 https://splunk.example.com:8088/services/collector/event）。',
        required: true,
      },
      {
        key: 'splunkSeverity',
        label: '严重性',
        hint: '事件严重级别：INFO / WARNING / CRITICAL，留空按 INFO。',
        placeholder: 'INFO',
        initial: 'INFO',
      },
      {
        key: 'splunkAutoResolve',
        label: '恢复时的动作',
        hint: '服务恢复时的处理：0（不操作，默认）/ ACKNOWLEDGEMENT（标记已读）/ RECOVERY（标记恢复）。',
        placeholder: '0',
        initial: '0',
      },
    ],
  },
  {
    type: 'squadcast',
    label: 'Squadcast',
    desc: 'Squadcast（事件管理与值班告警）事件上报。',
    fields: [
      {
        key: 'squadcastWebhookURL',
        label: 'Post URL',
        hint: 'Squadcast 服务里创建的「Uptime Kuma / 自定义」集成的接收地址。',
        required: true,
      },
    ],
  },
  {
    type: 'clickup',
    label: 'ClickUp',
    desc: 'ClickUp（项目管理）任务型告警：按事件在指定频道建任务。',
    fields: [
      {
        key: 'clickupToken',
        label: 'ClickUp API Token',
        hint: 'ClickUp → Settings → Integrations & ClickApps → ClickUp API → API Token 里创建的个人访问令牌。',
        secret: true,
        required: true,
      },
      {
        key: 'clickupWorkspaceId',
        label: '工作区 ID',
        hint: 'Workspace ID：工作区 URL 中 app.clickup.com/ 之后那一段（如 app.clickup.com/12345678/home 里的 12345678）。',
        required: true,
      },
      {
        key: 'clickupChannelId',
        label: '频道 ID',
        hint: 'Chat 频道 ID：频道 URL 中 /chat/r/ 之后那一段（如 …/chat/r/abc123-4567 里的 abc123-4567）。',
        required: true,
      },
      {
        key: 'clickupDisableUrl',
        label: '通知里禁止解析链接',
        hint: '开启后任务描述里的链接不生成预览。填 true 开启；留空或填 false 关闭。',
      },
    ],
  },
  {
    type: 'halopsa',
    label: 'HaloPSA',
    desc: 'HaloPSA（IT 服务管理）自定义集成 Runbook 触发。',
    fields: [
      {
        key: 'halowebhookurl',
        label: 'Webhook URL',
        hint: 'HaloPSA → Configuration → Integrations → Custom Integrations → Integration Runbooks 里创建的 Webhook 地址（创建时勾选 Can only be started from Halo and from a public endpoint）。',
        placeholder: 'https://your-instance.halopsa.com/api/v1/webhook',
        required: true,
      },
      {
        key: 'haloUsername',
        label: '用户名（选填）',
        hint: '用于该 Webhook 身份验证的用户名。',
      },
      {
        key: 'haloPassword',
        label: '密码（选填）',
        hint: '用于该 Webhook 身份验证的密码。',
      },
    ],
  },

  // 邮件
  {
    type: 'brevo',
    label: 'Brevo',
    desc: 'Brevo（原 Sendinblue）邮件发送。',
    fields: [
      {
        key: 'brevoApiKey',
        label: 'Brevo API Key',
        hint: '在 Brevo 后台（app.brevo.com → SMTP & API）创建的 API Key（xkeysib- 开头）。',
        secret: true,
        required: true,
      },
      {
        key: 'brevoFromEmail',
        label: '发件邮箱',
        hint: '发件人邮箱地址，必须是 Brevo 账号里已验证的发件人。',
        required: true,
      },
      {
        key: 'brevoFromName',
        label: '发件人名称（选填）',
        hint: '显示的发件人名字，留空用 Brevo 默认名称。',
      },
      {
        key: 'brevoToEmail',
        label: '收件邮箱',
        hint: '接收告警的邮箱地址。',
        required: true,
      },
      {
        key: 'brevoCcEmail',
        label: '抄送邮箱（选填）',
        hint: '抄送地址，多个用逗号分隔。',
      },
      {
        key: 'brevoBccEmail',
        label: '密送邮箱（选填）',
        hint: '密送地址，多个用逗号分隔。',
      },
      {
        key: 'brevoSubject',
        label: '主题（选填）',
        hint: '覆盖邮件主题，留空用默认主题。',
      },
    ],
  },
  {
    type: 'resend',
    label: 'Resend',
    desc: 'Resend（面向开发者的邮件 API）邮件发送。',
    fields: [
      {
        key: 'resendApiKey',
        label: 'Resend API Key',
        hint: '在 resend.com 控制台 → API Keys 创建的密钥（re_ 开头）。',
        secret: true,
        required: true,
      },
      {
        key: 'resendFromEmail',
        label: '发件邮箱',
        hint: '发件人地址，必须是 Resend 里已验证的域名下的地址。',
        required: true,
      },
      {
        key: 'resendFromName',
        label: '发件人名称（选填）',
        hint: '显示的发件人名字，留空用默认名称。',
      },
      {
        key: 'resendToEmail',
        label: '收件邮箱',
        hint: '接收告警的邮箱地址。',
        required: true,
      },
      {
        key: 'resendSubject',
        label: '主题（选填）',
        hint: '覆盖邮件主题，留空用默认主题。',
      },
    ],
  },
  {
    type: 'send-grid',
    label: 'SendGrid',
    desc: 'SendGrid（Twilio 旗下邮件服务）邮件发送。',
    fields: [
      {
        key: 'sendgridApiKey',
        label: 'SendGrid API Key',
        hint: '在 SendGrid 控制台 → Settings → API Keys 创建的密钥（SG. 开头，需有 Mail Send 权限）。',
        secret: true,
        required: true,
      },
      {
        key: 'sendgridFromEmail',
        label: '发件邮箱',
        hint: '发件人地址，必须是 SendGrid 里通过验证的 Sender Identity。',
        required: true,
      },
      {
        key: 'sendgridToEmail',
        label: '收件邮箱',
        hint: '接收告警的邮箱地址。',
        required: true,
      },
      {
        key: 'sendgridCcEmail',
        label: '抄送邮箱（选填）',
        hint: '抄送地址，多个用逗号分隔。',
      },
      {
        key: 'sendgridBccEmail',
        label: '密送邮箱（选填）',
        hint: '密送地址，多个用逗号分隔。',
      },
      {
        key: 'sendgridSubject',
        label: '主题（选填）',
        hint: '覆盖邮件主题，留空用默认主题。',
      },
    ],
  },
  {
    type: 'smtp',
    label: 'SMTP 邮件',
    desc: '通用 SMTP 邮件发送：任何邮箱服务 / 自建邮件服务器都能用。',
    fields: [
      {
        key: 'smtpHost',
        label: '主机名',
        hint: 'SMTP 服务器的主机名；打算用本机邮件投递代理（local MTA）时填 localhost。',
        placeholder: 'smtp.example.com',
        required: true,
      },
      {
        key: 'smtpPort',
        label: '端口',
        hint: 'SMTP 端口：常用 25（明文）、465（隐式 TLS）、587（STARTTLS）。',
        placeholder: '587',
        number: true,
        required: true,
      },
      {
        key: 'smtpSecure',
        label: '加密方式',
        hint: 'true = 隐式 TLS（配 465 端口）；留空或 false = 先明文连接再按需升级 STARTTLS（配 587）。',
      },
      {
        key: 'smtpIgnoreTLSError',
        label: '忽略 TLS 错误',
        hint: '服务器用自签证书时开启；会降低安全性，慎用。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'smtpIgnoreSTARTTLS',
        label: '禁用 STARTTLS',
        hint: '仅在不加密连接且服务器不支持 STARTTLS 时开启（连接将是明文的）。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'smtpUsername',
        label: '用户名（选填）',
        hint: 'SMTP 登录用户名；与密码同时留空则不进行认证。',
      },
      {
        key: 'smtpPassword',
        label: '密码 / 授权码',
        hint: 'SMTP 登录密码；邮箱服务商通常是「授权码」而不是网页登录密码（如 QQ / 163 需要在邮箱设置里开启 SMTP 并生成授权码）。',
        secret: true,
      },
      {
        key: 'smtpFrom',
        label: '发件邮箱',
        hint: 'From 地址（有的服务要求与登录账号一致）。',
        placeholder: 'alert@example.com',
        required: true,
      },
      {
        key: 'smtpTo',
        label: '收件邮箱',
        hint: '接收告警的地址，多个用逗号分隔（如 example2@kuma.pet, example3@kuma.pet）。',
        required: true,
      },
      {
        key: 'smtpCC',
        label: '抄送（选填）',
        hint: '抄送地址，多个用逗号分隔。',
      },
      {
        key: 'smtpBCC',
        label: '密送（选填）',
        hint: '密送地址，多个用逗号分隔。',
      },
      {
        key: 'customSubject',
        label: '自定义主题（选填）',
        hint: '覆盖邮件主题（LiquidJS 模板语法），留空用默认。',
        multiline: true,
        rows: 2,
      },
      {
        key: 'customBody',
        label: '自定义正文（选填）',
        hint: '覆盖邮件正文（LiquidJS 模板语法），留空用默认。',
        multiline: true,
        rows: 4,
      },
      {
        key: 'htmlBody',
        label: '正文按 HTML 发送',
        hint: '开启后自定义正文按 HTML 渲染（默认纯文本）。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'smtpAdditionalHeaders',
        label: '附加邮件头（JSON，选填）',
        hint: '随邮件附加的 SMTP 头，写成一个 JSON 对象，如 {"X-Custom":"value"}。',
        multiline: true,
        rows: 3,
      },
      {
        key: 'smtpDkimDomain',
        label: 'DKIM 域名（选填）',
        hint: '启用 DKIM 签名时填邮件域名，如 example.com。',
        placeholder: 'example.com',
      },
      {
        key: 'smtpDkimKeySelector',
        label: 'DKIM Key Selector（选填）',
        hint: 'DKIM 选择器（DNS 里 <selector>._domainkey.<域名> 的前缀），如 2017。',
        placeholder: '2017',
      },
      {
        key: 'smtpDkimPrivateKey',
        label: 'DKIM 私钥（选填）',
        hint: 'DKIM 签名用的 PEM 私钥（-----BEGIN PRIVATE KEY----- 开头，整段粘贴）。',
        multiline: true,
        rows: 4,
      },
      {
        key: 'smtpDkimHashAlgo',
        label: 'DKIM 哈希算法（选填）',
        hint: '签名哈希算法，一般用 sha256。',
        placeholder: 'sha256',
      },
      {
        key: 'smtpDkimheaderFieldNames',
        label: 'DKIM 签名头（选填）',
        hint: '参与签名的邮件头，冒号分隔；留空用 nodemailer 默认。',
        placeholder: 'message-id:date:from:to',
      },
      {
        key: 'smtpDkimskipFields',
        label: 'DKIM 跳过的头（选填）',
        hint: '不参与签名的邮件头，冒号分隔。',
        placeholder: 'message-id:date',
      },
    ],
  },
  {
    type: 'turbosmtp',
    label: 'TurboSMTP',
    desc: 'TurboSMTP（邮件投递服务）邮件发送。',
    fields: [
      {
        key: 'turbosmtpConsumerKey',
        label: 'Consumer Key',
        hint: 'TurboSMTP 后台的 Consumer Key。',
        secret: true,
        required: true,
      },
      {
        key: 'turbosmtpConsumerSecret',
        label: 'Consumer Secret',
        hint: 'TurboSMTP 后台的 Consumer Secret（与 Consumer Key 成对）。',
        secret: true,
        required: true,
      },
      {
        key: 'turbosmtpRegion',
        label: '区域',
        hint: '服务区域：us（默认）或 eu，按注册账号所在区域选择。',
        placeholder: 'us',
        initial: 'us',
      },
      {
        key: 'turbosmtpFromEmail',
        label: '发件邮箱',
        hint: '发件人地址（TurboSMTP 账号里已验证的发件人）。',
        required: true,
      },
      {
        key: 'turbosmtpToEmail',
        label: '收件邮箱',
        hint: '接收告警的邮箱地址，多个用逗号分隔。',
        required: true,
      },
      {
        key: 'turbosmtpCcEmail',
        label: '抄送邮箱（选填）',
        hint: '抄送地址，多个用逗号分隔。',
      },
      {
        key: 'turbosmtpBccEmail',
        label: '密送邮箱（选填）',
        hint: '密送地址，多个用逗号分隔。',
      },
      {
        key: 'turbosmtpSubject',
        label: '主题（选填）',
        hint: '覆盖邮件主题，留空用默认主题。',
      },
    ],
  },

  // 短信与语音
  {
    type: '46elks',
    label: '46elks',
    desc: '46elks（瑞典短信 / 语音 API）短信发送。',
    fields: [
      {
        key: 'elksUsername',
        label: 'API 用户名',
        hint: '46elks 控制台里的 API Username（与 Password 成对）。',
        secret: true,
        required: true,
      },
      {
        key: 'elksAuthToken',
        label: 'API 密码',
        hint: '46elks 控制台里的 API Password。',
        secret: true,
        required: true,
      },
      {
        key: 'elksFromNumber',
        label: '发件号码',
        hint: '发送用的 46elks 虚拟号码或已批准的发件人名称。',
        required: true,
      },
      {
        key: 'elksToNumber',
        label: '收件号码',
        hint: '收件人手机号，E.164 国际格式（如 +46701234567）。',
        required: true,
      },
    ],
  },
  {
    type: 'aliyun-sms',
    label: '阿里云短信',
    desc: '阿里云短信服务（国内 / 国际短信模板短信）。',
    fields: [
      {
        key: 'accessKeyId',
        label: 'AccessKey ID',
        hint: '阿里云 RAM 用户的 AccessKey ID（建议为短信功能单独建一个最小权限的 RAM 用户）。',
        secret: true,
        required: true,
      },
      {
        key: 'secretAccessKey',
        label: 'AccessKey Secret',
        hint: '与 AccessKey ID 成对的访问密钥。',
        secret: true,
        required: true,
      },
      {
        key: 'phonenumber',
        label: '收件手机号',
        hint: '接收短信的手机号。',
        required: true,
      },
      {
        key: 'signName',
        label: '短信签名',
        hint: '已审核通过的短信签名名称（显示在短信开头的【签名】）。',
        required: true,
      },
      {
        key: 'templateCode',
        label: '模板代码',
        hint: '已审核通过的模板 CODE。模板必须包含 name / time / status（以及可选的 msg）变量：{"name":"${name}","time":"${time}","status":"${status}"}。',
        required: true,
      },
      {
        key: 'optionalParameters',
        label: '启用可选变量 msg',
        hint: '开启后把告警详情作为可选变量 msg 传入；运营商限制下启用可选变量可能导致发送失败。填 true 开启；留空或填 false 关闭。',
      },
    ],
  },
  {
    type: 'amootsms',
    label: 'AmootSMS',
    desc: 'AmootSMS（伊朗短信服务）短信发送。',
    fields: [
      {
        key: 'amootApiToken',
        label: 'API Token',
        hint: 'AmootSMS 后台的 API 令牌。',
        secret: true,
        required: true,
      },
      {
        key: 'amootMobiles',
        label: '收件人手机号',
        hint: '接收短信的手机号，多个用逗号分隔（如 9123456789,09987654321）。',
        placeholder: '9123456789,09987654321',
        required: true,
      },
      {
        key: 'amootUsePattern',
        label: '使用模板发送',
        hint: '开启后按下面的模板编号发送。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'amootPatternCodeId',
        label: '模板编号（Pattern Code ID）',
        hint: 'AmootSMS 后台创建模板后得到的编号（数字）；「使用模板发送」开启时必填。',
        placeholder: '1234',
        number: true,
      },
      {
        key: 'amootUseOwnLine',
        label: '使用自有线路',
        hint: '模板发送时使用自己的线路号码。填 true 开启；留空或填 false 关闭。',
      },
      {
        key: 'amootLineNumber',
        label: '线路号码',
        hint: '发短信用的线路号码；非模板发送或「使用自有线路」开启时必填。',
        secret: true,
      },
    ],
  },
  {
    type: 'bearsms',
    label: 'BearSMS',
    desc: 'BearSMS（巴勒斯坦短信服务）短信发送。',
    fields: [
      {
        key: 'bearsmsUsername',
        label: 'API 用户名',
        hint: 'BearSMS 后台的 API 用户名。',
        required: true,
      },
      {
        key: 'bearsmsHashKey',
        label: 'Hash Key',
        hint: 'BearSMS 后台的哈希密钥（与用户名一同提供）。',
        secret: true,
        required: true,
      },
      {
        key: 'bearsmsSenderId',
        label: '发件人名称 / 号码（选填）',
        hint: '向收件人显示的发件人 ID（最多 11 字符），需先在 BearSMS 账号里获批；留空用账号默认发件人。',
      },
      {
        key: 'bearsmsPhoneNumber',
        label: '收件人手机号',
        hint: '含国家代码的收件人号码，不带 + 或 00（如 9725XXXXXXXX）。',
        placeholder: '9725XXXXXXXX',
        required: true,
      },
    ],
  },
  {
    type: 'cellsynt',
    label: 'Cellsynt',
    desc: 'Cellsynt（瑞典短信服务）短信发送。',
    fields: [
      {
        key: 'cellsyntLogin',
        label: '用户名',
        hint: 'Cellsynt 账号的用户名。',
        required: true,
      },
      {
        key: 'cellsyntPassword',
        label: '密码',
        hint: 'Cellsynt 账号的密码。',
        secret: true,
        required: true,
      },
      {
        key: 'cellsyntOriginatortype',
        label: '发件人类型',
        hint: 'alpha（字母数字，最多 11 字符，推荐，收件人不可回复）或 numeric（数字号码，最多 15 位，收件人可回复）。',
        placeholder: 'alpha',
        initial: 'alpha',
        required: true,
      },
      {
        key: 'cellsyntOriginator',
        label: '发件人',
        hint: '在收件人手机上显示的发件人：按「发件人类型」填最多 11 位字母数字，或 15 位以内的国际格式号码（不带 00 前缀）。',
        required: true,
      },
      {
        key: 'cellsyntDestination',
        label: '收件人号码',
        hint: '以 00 + 国家代码开头的国际格式（英国 07920 110 000 填 00447920110000，总长最多 17 位）；多个用逗号分隔，单次请求最多 25000 个。',
        required: true,
      },
      {
        key: 'cellsyntAllowLongSMS',
        label: '允许长短信',
        hint: '开启后长消息自动拆分为至多 6 段（每段 153 字符，共 918 字符）。填 true 开启；留空或填 false 关闭。',
      },
    ],
  },
  {
    type: 'clicksendsms',
    label: 'ClickSend',
    desc: 'ClickSend（国际短信 / 彩信 / 语音平台）短信发送。',
    fields: [
      {
        key: 'clicksendsmsLogin',
        label: 'API 用户名',
        hint: 'ClickSend 后台的 API Username。',
        required: true,
      },
      {
        key: 'clicksendsmsPassword',
        label: 'API Key',
        hint: 'ClickSend 后台（dashboard → API Key）生成的 API Key。',
        secret: true,
        required: true,
      },
      {
        key: 'clicksendsmsToNumber',
        label: '收件人手机号',
        hint: '接收短信的手机号（E.164 国际格式，如 +61411111111）。',
        required: true,
      },
      {
        key: 'clicksendsmsSenderName',
        label: '发件人名称 / 号码（选填）',
        hint: '已获批的发件人 ID 或号码；留空用 ClickSend 默认共享发件人。',
      },
    ],
  },
  {
    type: 'egosms',
    label: 'EgoSMS',
    desc: 'EgoSMS（乌干达短信服务）短信发送。',
    fields: [
      {
        key: 'egosmsUsername',
        label: 'API 用户名',
        hint: 'EgoSMS 平台的 API 用户名。',
        required: true,
      },
      {
        key: 'egosmsPassword',
        label: '密码',
        hint: 'EgoSMS 平台的账号密码。',
        secret: true,
        required: true,
      },
      {
        key: 'egosmsSender',
        label: '发件人名称 / 号码（选填）',
        hint: '向收件人显示的发件人 ID（最多 11 字符）；留空默认 EGOSMS。',
        placeholder: 'EGOSMS',
      },
      {
        key: 'egosmsPhoneNumber',
        label: '收件人手机号',
        hint: '含国家代码的收件人号码，不带 + 或 00（如 2567XXXXXXXX）。',
        placeholder: '2567XXXXXXXX',
        required: true,
      },
    ],
  },
  {
    type: 'freemobile',
    label: 'Free Mobile',
    desc: 'Free Mobile（法国运营商）短信通知：发到自己的手机。',
    fields: [
      {
        key: 'freemobileUser',
        label: '用户 ID',
        hint: 'Free Mobile 用户中心（mobile.free.fr → mon compte → mes options → SMS）显示的用户标识（ID Facultatif）。',
        required: true,
      },
      {
        key: 'freemobilePass',
        label: 'API Key',
        hint: '同一页面里生成的 API 密钥（Identifier le secret）。该服务只发给自己注册的手机号，每条 160 字符以内。',
        secret: true,
        required: true,
      },
    ],
  },
  {
    type: 'gtx-messaging',
    label: 'GTX Messaging',
    desc: 'GTX Messaging（短信 API）短信发送。',
    fields: [
      {
        key: 'gtxMessagingApiKey',
        label: 'API Key',
        hint: '在 GTX 后台：My Routing Accounts → Show Account Information → API Credentials → REST API (v2.x)。',
        secret: true,
        required: true,
      },
      {
        key: 'gtxMessagingFrom',
        label: '发件人（TPOA）',
        hint: '收件人看到的发送方：最多 11 位字母数字、短代码或国际格式号码（E.164 / E.212 / E.214）。',
        required: true,
      },
      {
        key: 'gtxMessagingTo',
        label: '收件人号码',
        hint: '接收短信的手机号（E.164 格式）。',
        required: true,
      },
    ],
  },
  {
    type: 'octopush',
    label: 'Octopush',
    desc: 'Octopush（法国短信服务）短信发送。',
    fields: [
      {
        key: 'octopushVersion',
        label: 'API 版本',
        hint: '2 = 新版 API（默认）；1 = 旧版（2011-2020 时代的账号才用）。',
        placeholder: '2',
        initial: '2',
      },
      {
        key: 'octopushAPIKey',
        label: 'API Key',
        hint: '控制台 HTTP API credentials 里的 "API key"（新版必填；旧版账号填旧版凭据）。',
        secret: true,
        required: true,
      },
      {
        key: 'octopushLogin',
        label: 'Login（选填）',
        hint: '控制台 HTTP API credentials 里的 "Login"（旧版 API 需要）。',
      },
      {
        key: 'octopushSMSType',
        label: '短信类型',
        hint: 'sms_premium（快，推荐用于告警）或 sms_low_cost（便宜但慢，可能被运营商拦截），留空按 Octopush 默认。',
        placeholder: 'sms_premium',
        initial: 'sms_premium',
      },
      {
        key: 'octopushPhoneNumber',
        label: '收件人手机号',
        hint: '国际通用格式（如 +33612345678）。',
        required: true,
      },
      {
        key: 'octopushSenderName',
        label: '发件人名称（选填）',
        hint: '3-11 位字母数字（a-zA-Z0-9）与空格；留空用 Octopush 默认。',
      },
    ],
  },
  {
    type: 'ooredoo',
    label: 'Ooredoo',
    desc: 'Ooredoo（马尔代夫运营商）批量短信 API。',
    fields: [
      {
        key: 'ooredooUsername',
        label: '用户名',
        hint: '登录 Ooredoo 批量短信控制面板的邮箱地址。',
        required: true,
      },
      {
        key: 'ooredooAccessKey',
        label: 'Access Key',
        hint: 'Ooredoo 短信控制面板「API Access Key」处的密钥，按原样粘贴（发送前会自动 Base64 编码）。',
        secret: true,
        required: true,
      },
      {
        key: 'ooredooBearerToken',
        label: 'Bearer Token',
        hint: '控制面板示例 cURL 命令里 "Authorization: Bearer" 后面那串令牌。',
        secret: true,
        required: true,
      },
      {
        key: 'ooredooToNumber',
        label: '收件人号码',
        hint: '一个或多个号码，用逗号或空格分隔；本地 7 位号码会自动加 960 国家前缀。',
        required: true,
      },
      {
        key: 'ooredooServerUrl',
        label: 'API 地址（选填）',
        hint: '自定义 API 端点；留空使用默认 Ooredoo 端点。',
        placeholder: 'https://o-papi1-lb01.ooredoo.mv/bulk_sms/v2',
      },
    ],
  },
  {
    type: 'plivo',
    label: 'Plivo',
    desc: 'Plivo（短信 / 语音 API）短信或语音电话告警。',
    fields: [
      {
        key: 'plivoAuthID',
        label: 'Auth ID',
        hint: 'Plivo 控制台的 Auth ID。',
        required: true,
      },
      {
        key: 'plivoAuthToken',
        label: 'Auth Token',
        hint: 'Plivo 控制台的 Auth Token。',
        secret: true,
        required: true,
      },
      {
        key: 'plivoFromNumber',
        label: '发件人号码',
        hint: '发送用的 Plivo 号码（如 +15551234567）；短信也可用获批的字母数字发件人 ID，语音通话必须用 Plivo 号码。',
        placeholder: '+15551234567',
        required: true,
      },
      {
        key: 'plivoToNumber',
        label: '收件人号码',
        hint: '接收短信 / 电话的目标号码（如 +15559876543）。',
        placeholder: '+15559876543',
        required: true,
      },
      {
        key: 'plivoMessageType',
        label: '消息类型',
        hint: 'sms（发短信，默认）或 call（打语音电话）。',
        placeholder: 'sms',
        initial: 'sms',
      },
      {
        key: 'plivoAnswerUrl',
        label: 'Answer URL（语音必填）',
        hint: '返回 Plivo XML 的网址：告警文本会附在 ?message= 参数里，端点可据此返回如 <Response><Speak>{message}</Speak></Response>。',
        placeholder: 'https://example.com/answer.xml',
      },
    ],
  },
  {
    type: 'promosms',
    label: 'PromoSMS',
    desc: 'PromoSMS（波兰短信服务）短信发送。',
    fields: [
      {
        key: 'promosmsLogin',
        label: 'API 登录名',
        hint: 'PromoSMS 的 API 登录名。',
        required: true,
      },
      {
        key: 'promosmsPassword',
        label: 'API 密码',
        hint: 'PromoSMS 的 API 密码。',
        secret: true,
        required: true,
      },
      {
        key: 'promosmsSMSType',
        label: '短信类型',
        hint: '0 = FLASH（直接显示在收件人设备上）/ 1 = ECO（便宜但慢，仅限波兰）/ 3 = FULL（高级，需先注册发件人名，适合告警）/ 4 = SPEED（最高优先级，价格约为 FULL 两倍）。',
        placeholder: '3',
        initial: '3',
      },
      {
        key: 'promosmsPhoneNumber',
        label: '收件人手机号',
        hint: '接收短信的手机号。',
        required: true,
      },
      {
        key: 'promosmsSenderName',
        label: '发件人名称（选填）',
        hint: '已在 PromoSMS 注册的发件人名称（FULL 类型可用）。',
      },
      {
        key: 'promosmsAllowLongSMS',
        label: '允许长短信',
        hint: '开启后长消息可超过单条长度（按多条计费）。填 true 开启；留空或填 false 关闭。',
      },
    ],
  },
  {
    type: 'serwersms',
    label: 'SerwerSMS',
    desc: 'SerwerSMS（波兰短信服务）短信发送。',
    fields: [
      {
        key: 'serwersmsUsername',
        label: 'API 用户名',
        hint: 'SerwerSMS 的 API 用户名（含 webapi_ 前缀）。',
        placeholder: 'webapi_user',
        required: true,
      },
      {
        key: 'serwersmsPassword',
        label: 'API 密码',
        hint: 'SerwerSMS 的 API 密码。',
        secret: true,
        required: true,
      },
      {
        key: 'serwersmsRecipientType',
        label: '收件人类型',
        hint: 'phone（按手机号发送）或 group（按客户面板里的通讯录分组发送）。',
        placeholder: 'phone',
        initial: 'phone',
      },
      {
        key: 'serwersmsPhoneNumber',
        label: '手机号码',
        hint: '接收短信的手机号；「收件人类型」为 phone 时必填。',
      },
      {
        key: 'serwersmsGroupId',
        label: '分组 ID',
        hint: '客户面板里的通讯录分组 ID（可在面板的编辑分组处复制）；「收件人类型」为 group 时必填。',
      },
      {
        key: 'serwersmsSenderName',
        label: '发件人名称（选填）',
        hint: '已在客户中心注册的 SMS 发件人名称。',
      },
    ],
  },
  {
    type: 'sevenio',
    label: 'SevenIO',
    desc: 'SevenIO（德国短信服务）短信发送。',
    fields: [
      {
        key: 'sevenioApiKey',
        label: 'API Key',
        hint: '在 app.seven.io → Developer → API Key 点绿色添加按钮生成的密钥。',
        secret: true,
        required: true,
      },
      {
        key: 'sevenioSender',
        label: '发件人（选填）',
        hint: '发送用的号码或名称；留空用账号默认。',
        placeholder: 'Uptime Kuma',
      },
      {
        key: 'sevenioReceiver',
        label: '收件人号码',
        hint: '接收短信的号码（数字）；号码不在德国时在前面加国家代码（美国国家代码 1 的 017612121212 写成 117612121212）。',
        placeholder: '0123456789',
        number: true,
        required: true,
      },
    ],
  },
  {
    type: 'sms-gateway',
    label: 'SMS Gateway',
    desc: 'Android SMS Gateway App（用安卓手机当短信网关，自托管）。',
    fields: [
      {
        key: 'smsgatewayUrl',
        label: '服务器地址',
        hint: 'SMS Gateway 的根地址，不含 API 路径（如 http://192.168.1.10:8080）。',
        placeholder: 'http://localhost:8080',
        required: true,
      },
      {
        key: 'smsgatewayApiKey',
        label: 'API Key',
        hint: 'SMS Gateway App 设置里生成的 API 密钥。',
        secret: true,
        required: true,
      },
      {
        key: 'smsgatewayTo',
        label: '收件人号码',
        hint: '国际格式（E.164）手机号列表，逗号分隔（如 +15551234567, +15559876543）。',
        placeholder: '+15551234567, +15559876543',
        required: true,
      },
    ],
  },
  {
    type: 'sms-planet',
    label: 'SMSPlanet',
    desc: 'SMSPlanet（波兰短信服务）短信发送。',
    fields: [
      {
        key: 'smsplanetApiToken',
        label: 'API Token',
        hint: 'SMSPlanet 后台生成的 API Token（获取方式见 SMSPlanet 文档）。',
        secret: true,
        required: true,
      },
      {
        key: 'smsplanetPhoneNumbers',
        label: '收件人号码',
        hint: '接收短信的手机号列表，逗号分隔。',
        multiline: true,
        rows: 3,
        required: true,
      },
      {
        key: 'smsplanetSenderName',
        label: '发件人名称（选填）',
        hint: '已在 SMSPlanet 注册的发件人名称；留空用默认。',
      },
    ],
  },
  {
    type: 'smsc',
    label: 'SMSC',
    desc: 'SMSC（smsc.kz，哈萨克 / 俄语区短信服务）短信发送。',
    fields: [
      {
        key: 'smscLogin',
        label: 'API 用户名',
        hint: 'SMSC（smsc.kz）的 API 登录用户名。',
        required: true,
      },
      {
        key: 'smscPassword',
        label: 'API Key',
        hint: 'SMSC 的 API 密码。',
        secret: true,
        required: true,
      },
      {
        key: 'smscToNumber',
        label: '收件人手机号',
        hint: '接收短信的手机号（至少 11 位）。',
        required: true,
      },
      {
        key: 'smscSenderName',
        label: '发件人名称 / 号码（选填）',
        hint: '已获批的发件人名称或号码（1-15 字符）；留空用共享发件人号码。',
      },
      {
        key: 'smscTranslit',
        label: '音译',
        hint: '非拉丁字符的处理：0 = 默认（不音译）/ 1 = Translit / 2 = 反向音译。',
        placeholder: '0',
        initial: '0',
      },
    ],
  },
  {
    type: 'smseagle',
    label: 'SMSEagle',
    desc: 'SMSEagle（硬件短信网关设备，自托管）短信 / 语音 / TTS 发送。',
    fields: [
      {
        key: 'smseagleUrl',
        label: '设备地址',
        hint: 'SMSEagle 设备的地址（如 http://127.0.0.1）。',
        placeholder: 'http://127.0.0.1',
        required: true,
      },
      {
        key: 'smseagleToken',
        label: 'API 访问令牌',
        hint: 'SMSEagle 设备里创建的 API Access Token。',
        secret: true,
        required: true,
      },
      {
        key: 'smseagleApiType',
        label: 'API 版本',
        hint: 'smseagle-apiv1（旧项目兼容）或 smseagle-apiv2（推荐，固件 v2.0+）。',
        placeholder: 'smseagle-apiv2',
        initial: 'smseagle-apiv2',
      },
      {
        key: 'smseagleRecipientType',
        label: '收信人类型',
        hint: 'smseagle-to（手机号）/ smseagle-group（通讯录分组）/ smseagle-contact（通讯录联系人）。',
        placeholder: 'smseagle-to',
        initial: 'smseagle-to',
      },
      {
        key: 'smseagleRecipient',
        label: '收信人',
        hint: '按「收信人类型」填手机号 / 分组 / 联系人，多个用半角逗号分隔。',
        required: true,
      },
      {
        key: 'smseagleRecipientTo',
        label: '手机号（V2，选填）',
        hint: 'APIv2 专用：直接指定手机号（可多个，逗号分隔）。',
      },
      {
        key: 'smseagleRecipientGroup',
        label: '分组 ID（V2，选填）',
        hint: 'APIv2 专用：通讯录分组 ID（可多个，逗号分隔）。',
      },
      {
        key: 'smseagleRecipientContact',
        label: '联系人 ID（V2，选填）',
        hint: 'APIv2 专用：通讯录联系人 ID（可多个，逗号分隔）。',
      },
      {
        key: 'smseagleMsgType',
        label: '消息类型',
        hint: 'smseagle-sms（短信，默认）/ smseagle-ring（响铃呼叫）/ smseagle-tts（文本转语音呼叫）/ smseagle-tts-advanced（高级 TTS 呼叫）。',
        placeholder: 'smseagle-sms',
        initial: 'smseagle-sms',
      },
      {
        key: 'smseagleEncoding',
        label: 'Unicode 编码',
        hint: 'smseagle-unicode = 以 Unicode 发送（支持中文，但单条字数变少）；留空默认 GSM-7。',
        placeholder: 'smseagle-unicode',
      },
      {
        key: 'smseaglePriority',
        label: '消息优先级（选填）',
        hint: '0-9 的数字，9 最高；留空用设备默认。',
        placeholder: '0',
        number: true,
      },
      {
        key: 'smseagleDuration',
        label: '呼叫时长（秒，选填）',
        hint: '响铃 / TTS 呼叫的持续时长（秒），如 10；仅语音类消息类型有效。',
        placeholder: '10',
        number: true,
      },
      {
        key: 'smseagleTtsModel',
        label: 'TTS 模型 ID（选填）',
        hint: '文本转语音的模型编号（仅高级 TTS 呼叫需要）。',
        placeholder: '1',
        number: true,
      },
    ],
  },
  {
    type: 'smsir',
    label: 'SMS.ir',
    desc: 'SMS.ir（伊朗短信服务）模板短信发送。',
    fields: [
      {
        key: 'smsirApiKey',
        label: 'API Key',
        hint: 'SMS.ir 后台的 API 密钥。',
        secret: true,
        required: true,
      },
      {
        key: 'smsirNumber',
        label: '收件人手机号',
        hint: '接收短信的手机号，多个用逗号分隔（如 9123456789,09987654321）。',
        placeholder: '9123456789,09987654321',
        required: true,
      },
      {
        key: 'smsirTemplate',
        label: '模板 ID',
        hint: 'SMS.ir 后台创建的模板编号（如 12345）；模板必须包含一个 #uptkumaalert# 变量。',
        placeholder: '12345',
        required: true,
      },
    ],
  },
  {
    type: 'smsmanager',
    label: 'SMSManager',
    desc: 'SMSManager（捷克短信服务）短信发送。',
    fields: [
      {
        key: 'smsmanagerApiKey',
        label: 'API Key',
        hint: 'SMSManager 后台（smsmanager.cz）生成的 API Key。',
        secret: true,
        required: true,
      },
      {
        key: 'numbers',
        label: '收件人',
        hint: '接收短信的手机号，多个用逗号分隔。',
        required: true,
      },
      {
        key: 'messageType',
        label: '网关类型',
        hint: 'economy（经济）/ lowcost（低价）/ high（高级，默认）三档，留空按 high。',
        placeholder: 'high',
        initial: 'high',
      },
    ],
  },
  {
    type: 'smspartner',
    label: 'SMSPartner',
    desc: 'SMSPartner（法国短信服务）短信发送。',
    fields: [
      {
        key: 'smspartnerApikey',
        label: 'API Key',
        hint: '在 SMSPartner 控制台（dashboard）里获取的 API 密钥。',
        secret: true,
        required: true,
      },
      {
        key: 'smspartnerPhoneNumber',
        label: '收件人号码',
        hint: '国际格式手机号（如 +33612345678 / 33612345678），多个用逗号分隔。',
        required: true,
      },
      {
        key: 'smspartnerSenderName',
        label: '发件人名称',
        hint: 'SMS 发件人名称：3-11 个常规字符，不能含特殊字符。',
        required: true,
      },
    ],
  },
  {
    type: 'telnyx',
    label: 'Telnyx',
    desc: 'Telnyx（通信平台）短信发送。',
    fields: [
      {
        key: 'telnyxApiKey',
        label: 'API Key（V2）',
        hint: 'Telnyx 门户 → API Keys 里的 V2 密钥。',
        secret: true,
        required: true,
      },
      {
        key: 'telnyxPhoneNumber',
        label: '发件人号码',
        hint: '发送用的 Telnyx 号码（必须注册在你的 Telnyx 账户下，如 +15551234567）。',
        placeholder: '+15551234567',
        required: true,
      },
      {
        key: 'telnyxToNumber',
        label: '收件人号码',
        hint: '接收短信的目标号码（如 +15559876543）。',
        placeholder: '+15559876543',
        required: true,
      },
      {
        key: 'telnyxMessagingProfileId',
        label: '消息配置 ID（选填）',
        hint: '关联 Telnyx Messaging Profile 以控制发件设置与功能；留空用默认。',
      },
    ],
  },
  {
    type: 'teltonika',
    label: 'Teltonika',
    desc: 'Teltonika 路由器（RUT 系列）SMS API 短信发送。',
    fields: [
      {
        key: 'teltonikaUrl',
        label: '设备地址',
        hint: '路由器的完整来源地址（如 http://192.168.100.1 或 https://router.example.com）。',
        placeholder: '192.168.100.1',
        required: true,
      },
      {
        key: 'teltonikaUsername',
        label: 'API 用户名',
        hint: '建议在路由器里单独建一个只有发短信权限的用户并填其用户名。',
        required: true,
      },
      {
        key: 'teltonikaPassword',
        label: 'API 密码',
        hint: '该 API 用户的密码（在路由器用户管理里设置）。',
        secret: true,
        required: true,
      },
      {
        key: 'teltonikaModem',
        label: '调制解调器 ID',
        hint: '发短信用的 modem id，格式如 3-1（详见 Teltonika 开发者文档 developers.teltonika-networks.com/reference/）。',
        placeholder: '3-1',
        required: true,
      },
      {
        key: 'teltonikaPhoneNumber',
        label: '收件人号码',
        hint: '国际格式手机号（如 +37061234567）；仅允许一个号码。',
        required: true,
      },
      {
        key: 'teltonikaUnsafeTls',
        label: '关闭证书验证',
        hint: '自签证书时才开启：关闭验证会暴露在中间人攻击下，可能导致数据泄露，慎用。填 true 开启；留空或填 false 关闭。',
      },
    ],
  },
  {
    type: 'twilio',
    label: 'Twilio',
    desc: 'Twilio（短信 / 语音平台）短信发送。',
    fields: [
      {
        key: 'twilioAccountSID',
        label: 'Account SID',
        hint: 'Twilio 控制台首页的 Account SID（AC 开头）。',
        required: true,
      },
      {
        key: 'twilioAuthToken',
        label: 'Auth Token',
        hint: 'Twilio 控制台的 Auth Token（与 Account SID 配对使用）。',
        secret: true,
        required: true,
      },
      {
        key: 'twilioApiKey',
        label: 'API Key（选填）',
        hint: '可选但推荐：用 API Key 对（SID + Secret）替代 Auth Token 认证。',
        secret: true,
      },
      {
        key: 'twilioFromNumber',
        label: '发件人号码',
        hint: '发送用的 Twilio 号码（如 +15551234567），或已配置的短代码 / 字母数字发件人 ID。',
        required: true,
      },
      {
        key: 'twilioToNumber',
        label: '收件人号码',
        hint: '接收短信的目标号码（如 +15559876543）。',
        required: true,
      },
      {
        key: 'twilioMessagingServiceSID',
        label: '消息服务 SID（选填）',
        hint: '用 Messaging Service 发送时填其 SID（MG 开头）；填了它时发件人号码由服务决定。',
      },
    ],
  },

  // 其它集成
  {
    type: 'apprise',
    label: 'Apprise',
    desc: 'Apprise（命令行多渠道通知分发器）：一个入口转发到它支持的上百种服务。',
    fields: [
      {
        key: 'appriseURL',
        label: 'Apprise URL',
        hint: '传给 apprise 命令行的目标 URL（可用逗号分隔多个），写法见 Apprise 文档（github.com/caronc/apprise），如 tgram://bottoken/ChatID、mailto://user:pass@gmail.com。要求网关所在机器已安装 apprise CLI。',
        required: true,
      },
      {
        key: 'title',
        label: '标题（选填）',
        hint: '附加给 Apprise 消息的标题（部分服务支持标题字段）。',
      },
    ],
  },
  {
    type: 'bitrix24',
    label: 'Bitrix24',
    desc: 'Bitrix24（CRM 与协作平台）站内通知发送。',
    fields: [
      {
        key: 'bitrix24WebhookURL',
        label: 'Bitrix24 Webhook URL',
        hint: 'Bitrix24 → 开发者应用 → 本地应用 / 入站 Webhook 创建的地址（到 /im.notify.system.add 前的完整 URL）。',
        secret: true,
        required: true,
      },
      {
        key: 'bitrix24UserID',
        label: '用户 ID',
        hint: '接收通知的 Bitrix24 用户 ID：在目标用户的个人资料页链接里可以查到。',
        required: true,
      },
    ],
  },
  {
    type: 'flowtriq',
    label: 'Flowtriq',
    desc: 'Flowtriq（自动化工作流平台）Webhook 触发。',
    fields: [
      {
        key: 'flowtriqWebhookUrl',
        label: 'Webhook URL',
        hint: 'Flowtriq 里创建的 Webhook 触发器地址。',
        placeholder: 'https://app.flowtriq.com/api/webhooks/…',
        required: true,
      },
      {
        key: 'flowtriqApiKey',
        label: 'API Key（选填）',
        hint: '用于校验 Webhook 请求的密钥；触发器未开启鉴权时可留空。',
        secret: true,
      },
    ],
  },
  {
    type: 'google-sheets',
    label: 'Google Sheets',
    desc: 'Google Sheets 行写入：通过 Apps Script Web 应用把告警记进表格。',
    fields: [
      {
        key: 'googleSheetsWebhookUrl',
        label: 'Apps Script Web 应用 URL',
        hint: '先在 Google 表格里「扩展程序 → Apps 脚本」粘贴其提供的脚本代码，再「部署 → 新建部署 → Web 应用」（执行身份 = 我、访问权限 = 任何人），最后把部署得到的 URL 粘贴到这里（https://script.google.com/macros/s/…/exec）。',
        placeholder: 'https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec',
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
  notifyChannels: '通知渠道是网关把告警**推到外面**的出口：每条渠道是一组「类型 + 地址 / 凭据」，类型全量对齐 Uptime-Kuma（109 种：Webhook / Telegram / 钉钉 / 飞书 / Bark / SMTP / PagerDuty / 各家短信与推送服务等），同一类型可以配多条（比如两个不同的钉钉群）。清单整体保存在网关配置里，添加 / 编辑 / 删除 / 启停都是**全量保存**——请求进行中整块禁用，成功后按后端返回的清单重画。密钥类字段默认打码：卡片摘要只露首尾几段，编辑表单里是密码框（可点「显示」临时明文核对），保存时按输入框里的真实值原样落盘。「测试」按钮会用与真实告警完全相同的通道发一条测试消息，收到即配置正确。',
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
