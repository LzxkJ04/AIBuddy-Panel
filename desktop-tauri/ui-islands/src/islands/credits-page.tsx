/**
 * AIBuddy Panel · 积分构成页（对照 workbuddy2api-panel 的同名页三段结构）。
 *
 * 本岛接管 `<section class="page" data-page="credits">`，清空子节点后把 React root 直接建在
 * 这个 section 上（不套宿主 div，与 settings-page / report-page 同一手法）。
 *
 * ── 数据从哪来 ──────────────────────────────────────────────
 * `GET /api/accounts/usage/packages`：逐启用 WorkBuddy 账号走 get-user-resource 的
 * **逐包明细**（packageCode / name / isDaily / total / used / left / startAt /
 * expireAt（毫秒）/ refreshAt …，后端已按套餐优先级 + 到期时间排序，见
 * billing/usage.rs 与 core/usage_query.rs query_credit_packages）。每次点击都真打
 * 上游；其它提供商的 usage 形状（wallets / 积分简报）没有「积分包 + 到期」概念，
 * 由后端计入 skipped、页脚照实说明。
 * （v2.13.0 一版曾错用 /api/accounts/usage —— 它对 WorkBuddy 走积分简报三个数，
 * 没有 resources，页面永远是空态；v2.13.1 起改用本端点。）
 *
 * ── 信息结构（与参考站逐段对齐，refs/workbuddy2api-panel）──────
 * 1. 积分到期分布：按**剩余整天数**分桶（不是日历日），桶内条形按账号分段着色
 *    （稳定配色，透明度随剩余天数衰减），右侧汇总该桶剩余积分；余额按「到期早的
 *    先占坑」逐包封顶，避免上游重复记录把分布撑大（app.js pkAccountSegments /
 *    summarizeCreditDays / renderExpiryDistribution，约 2351 / 2378 / 2407 行）。
 * 2. 账号对比卡片：大数字余额 + 「共 X · 已用 · N 个包 · 占最高 P% · 套餐到期」
 *    + 按包来源聚合的构成条与图例（pkBySource：键 = packageCode|name，同码同名
 *    的多包并成一个来源；app.js 约 2237 / 2469 行）+ 账号内到期迷你条；失败账号
 *    出「查询失败」卡。
 * 3. 逐账号明细表：面额 / 剩余 / 已用 / 发放（startAt）/ 到期（临期着色），
 *    并补齐参考站的折叠汇总口径（pkDetailGroups，app.js 约 2300 行）：正余额包按
 *    到期从早到晚默认展示前 5 条，其余未用完与已用完的分别折成一行汇总、可展开
 *    ——平铺明细仍然保留（展开即全部行），只是默认收起。
 *
 * ── 视觉 ────────────────────────────────────────────────────
 * 全部走 var(--…) token（ui-kit theme.css 的 --ui-* 与宿主 tokens.css 的
 * --danger/--warn 三件套），深浅主题自动跟随；数字 tabular-nums 右对齐，大数用
 * fmtTok 压宽（app.js:1690 同口径）。临期口径与账号池「有效期」列一致：
 * 已到期 / ≤3 天红 / ≤7 天黄（accounts-page.tsx 的 expiryTier 约定）。
 * 手机端：卡片单列、表格横向滚动、≤480px 收敛分布图栅格与图例字号。
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner, cn } from '@ui'
import { shared, toast } from './settings-model'

const PAGE_SELECTOR = '.page[data-page="credits"]'

/** 明细默认展示条数（参考站由后端配置 package_detail_limit 下发；我们没有那个配置项，
 *  换成**页面内可调 + localStorage 持久化**的口径 —— 用户自己挑 3/5/10，跨次启动保留）。 */
const DETAIL_LIMIT_KEY = 'aibuddy-credits-detail-limit'
const DETAIL_LIMITS = [3, 5, 10] as const
function readDetailLimit(): number {
  try {
    const n = Number(localStorage.getItem(DETAIL_LIMIT_KEY))
    return (DETAIL_LIMITS as readonly number[]).includes(n) ? n : 5
  } catch { return 5 }
}
function saveDetailLimit(value: number): void {
  try { localStorage.setItem(DETAIL_LIMIT_KEY, String(value)) } catch { /* 存不了只影响下次启动 */ }
}

/** rejection 值可能是裸字符串（桌面端没走桥的 asError），统一摘出可读文案 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error ?? '').trim() || '未知错误'
}

/** 本机网关调用（api_request 壳命令：桌面 invoke 自动带 Key；网页 shim 同源 fetch） */
async function callLocal<T>(method: 'GET', path: string): Promise<T> {
  const internals = (shared() as unknown as {
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: unknown) => Promise<unknown> }
  }).__TAURI_INTERNALS__
  if (!internals || typeof internals.invoke !== 'function') {
    throw new Error('桌面运行时不可用（Tauri 未初始化）')
  }
  return internals.invoke('api_request', { request: { method, path } }) as Promise<T>
}

/* ─── 数据形状（与 core/usage_query.rs / billing/usage.rs 的输出逐字对齐）── */

type ResourceItem = {
  id?: string
  packageCode?: string
  name?: string
  isDaily?: boolean
  /** total / used / left 可能是数字或字符串（后端 js_int_string 的口径），展示层按字符串处理 */
  total?: number | string
  used?: number | string
  left?: number | string
  /** 发放时间（DeductionStartTime / CycleStartTime，毫秒）——明细表「发放」列 */
  startAt?: number | null
  expireAt?: number | null
  refreshAt?: number | null
}

type UsagePayload = {
  kind?: string
  editionType?: string
  planName?: string
  usageTotal?: string
  usageLeft?: string
  usageUsed?: string
  expireAt?: number | null
  resources?: ResourceItem[]
}

type UsageResult = {
  id?: string
  name?: string
  /** 逐包明细行（/api/accounts/usage/packages 把本家 usage 的这些字段平铺到 result 上） */
  editionType?: string
  planName?: string
  usageLeft?: string
  usageUsed?: string
  usageTotal?: string
  expireAt?: number | null
  resources?: ResourceItem[]
  /** 平铺口径里 resources 不存在而 error 有值 = 这一行查询失败 */
  error?: string | null
  usage?: UsagePayload | null
}
type Snapshot = { at?: number; results?: UsageResult[]; skipped?: number; skippedProviders?: string[] }

/* ─── 参考站口径的小工具 ─────────────────────────────────────── */

/** 把数字 / 数字字符串归一成有限数值（NaN / 缺失 → 0），聚合用 */
function numOf(value: number | string | undefined | null): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** 到期毫秒值 → YYYY-MM-DD（无效值返回空串，分布图跳过） */
function dayOf(ms: number | null | undefined): string {
  if (!ms || ms <= 1000) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 到期毫秒值 → YYYY-MM-DD HH:mm（悬停标题用） */
function timeOf(ms: number | null | undefined): string {
  if (!ms || ms <= 1000) return '—'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${dayOf(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 数字缩写（参考站 fmtTok 同口径：app.js:1690 —— ≥1e9 B / ≥1e6 M / ≥1e3 k）。
 *  只用于汇总大数压宽；逐包明细表保留精确数字。 */
function fmtTok(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(value)
}

const DAY_MS = 24 * 3600 * 1000

/** 到期毫秒 → 剩余整天数（ceil，已到期 = 0；无有效到期时间 = null，不进分布图）。
 *  参考站 pkAccountSegments 的 days 同口径（app.js:2362）。 */
function daysLeftOf(expireAt: number | null | undefined, now: number): number | null {
  if (!expireAt || expireAt <= 1000) return null
  const diff = expireAt - now
  if (!Number.isFinite(diff)) return null
  return diff <= 0 ? 0 : Math.ceil(diff / DAY_MS)
}

/** 悬停用的相对到期描述（参考站 pkExpiryText 同口径，app.js:2331） */
function relativeExpiryOf(expireAt: number | null | undefined, now: number): string {
  if (!expireAt || expireAt <= 1000) return '无到期时间'
  const diff = expireAt - now
  if (diff <= 0) return '已到期'
  const minutes = Math.max(1, Math.ceil(diff / 60000))
  if (minutes < 60) return `剩余 ${minutes} 分钟`
  const hours = Math.ceil(diff / 3600000)
  if (hours < 24) return `剩余 ${hours} 小时`
  return `剩余 ${Math.ceil(diff / DAY_MS)} 天`
}

/** 发放列的相对形态（换方法：相对天数优先、超过 30 天回退完整日期 ——
 *  与到期列的相对语义呼应，悬停 title 永远给完整时间）。 */
function relativeStartOf(startAt: number | null | undefined, now: number): string {
  if (!startAt || startAt <= 1000) return '—'
  const diff = now - startAt
  if (!Number.isFinite(diff) || diff < 0) return dayOf(startAt)
  const days = Math.floor(diff / DAY_MS)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return dayOf(startAt)
}

/** 临期分档：expired 已到期 / urgent ≤3 天 / soon ≤7 天 —— 与账号池「有效期」列
 *  的 expiryTier 同一套约定（accounts-page.tsx：≤3 天红 / ≤7 天黄）。 */
type ExpiryTier = 'expired' | 'urgent' | 'soon'
function expiryTierOf(expireAt: number | null | undefined, now: number): ExpiryTier | null {
  if (!expireAt || expireAt <= 1000) return null
  const left = expireAt - now
  if (left <= 0) return 'expired'
  if (left < 3 * DAY_MS) return 'urgent'
  if (left < 7 * DAY_MS) return 'soon'
  return null
}

/** 临期徽章文案与悬停说明（沿用账号池「有效期」列的用词） */
const TIER_TEXT: Record<ExpiryTier, { label: string; title: string }> = {
  expired: { label: '已过期', title: '该积分包已到期，剩余积分不再可用' },
  urgent: { label: '即将过期', title: '剩余有效期不足 3 天，尽快用掉以免浪费' },
  soon: { label: '临期', title: '剩余有效期不足 7 天' },
}

/** 分段条透明度随剩余天数衰减（参考站 pkCreditOpacity 同口径，app.js:2326：
 *  越近到期越实，30 天开外最淡 0.25）。 */
function expiryOpacity(days: number | null): number {
  if (days == null || !Number.isFinite(days)) return 1
  return 0.25 + 0.75 * Math.max(0, Math.min(29, days - 1)) / 29
}

/** 账号 / 包来源共用的稳定配色盘（对照参考站 PK_COLORS / pkAccountColorMap：
 *  排序后按下标取色，刷新重排不换色）。取值全走主题 token，深浅主题自动跟随。 */
const PK_PALETTE = [
  'var(--ui-chart-1)',
  'var(--ui-chart-2)',
  'var(--ui-chart-3)',
  'var(--ui-chart-4)',
  'var(--ui-chart-5)',
  'var(--ui-info)',
  'var(--ui-success)',
  'var(--ui-sensitive)',
  'var(--ui-intl)',
]

function paletteAt(index: number): string {
  const size = PK_PALETTE.length
  return PK_PALETTE[((index % size) + size) % size]
}

/** 账号版本的中文标（editionType → 展示名） */
const EDITION_LABELS: Record<string, string> = {
  flagship: '旗舰版',
  advanced: '进阶版',
  pro: '专业版',
  youth: '青春版',
  pro_trial: '专业试用',
  free: '免费',
}

/** 有积分包明细的账号：逐包字段直接平铺在 result 上（新端点口径），
 *  兼容旧 usage.resources 形状（其他端点 / 老数据） */
function packagesOf(result: UsageResult): ResourceItem[] {
  if (Array.isArray(result.resources)) return result.resources
  const resources = result.usage?.resources
  return Array.isArray(resources) ? resources : []
}

/** 该行是否查询失败（新端点：resources 缺失且有 error；旧形状：usage 为 null） */
function isErrorRow(result: UsageResult): boolean {
  if (result.usage === null && result.error) return true
  return !Array.isArray(result.resources) && !result.usage && Boolean(result.error)
}

/** 展示名：优先昵称，退而取 id 前 8 位（参考站 nickname || uid.slice(0,8) 同口径） */
function nameOf(result: UsageResult): string {
  return result.name || (result.id ? result.id.slice(0, 8) : '') || '（未命名账号）'
}

/* ─── 聚合口径（逐段对照参考站 app.js）──────────────────────── */

type Segment = {
  amount: number
  expireAt: number | null
  days: number | null
  source: string
  uid: string
  accountName: string
}

/** 单账号「余额 → 分段」：按到期时间从早到晚逐包消耗账号总余额
 *  （amount = min(余额, 包剩余)），上游重复记录不会把分布撑大。
 *  参考站 pkAccountSegments 同口径（app.js:2351）。 */
function segmentsOf(result: UsageResult, now: number): Segment[] {
  let balance = Math.max(0, numOf(result.usageLeft))
  const out: Segment[] = []
  const packs = [...packagesOf(result)].sort((a, b) => {
    const ea = a.expireAt ?? Number.POSITIVE_INFINITY
    const eb = b.expireAt ?? Number.POSITIVE_INFINITY
    if (ea !== eb) return ea - eb
    return numOf(b.left) - numOf(a.left)
  })
  for (const pack of packs) {
    if (balance <= 0) break
    const remain = numOf(pack.left)
    if (remain <= 0) continue
    const amount = Math.min(balance, remain)
    const expireAt = pack.expireAt && pack.expireAt > 1000 ? pack.expireAt : null
    out.push({
      amount,
      expireAt,
      days: expireAt == null ? null : daysLeftOf(expireAt, now),
      source: pack.name || pack.packageCode || '积分',
      uid: result.id || '',
      accountName: nameOf(result),
    })
    balance -= amount
  }
  return out
}

type SourceAgg = {
  key: string
  name: string
  n: number
  size: number
  remain: number
  used: number
  minStart: number | null
}

/** 按包来源聚合面额/剩余/个数（参考站 pkBySource 同口径，app.js:2237）：
 *  分组键必须带上 packageCode —— 「首登赠送」与普通活动包可能同名同码不同批；
 *  聚合结果按面额合计降序。卡片构成条与明细行色点共用这套键。 */
function sourcesOf(packs: ResourceItem[]): SourceAgg[] {
  const map = new Map<string, SourceAgg>()
  for (const pack of packs) {
    const key = `${pack.packageCode || ''}|${pack.name || '(未命名)'}`
    const entry =
      map.get(key) ||
      { key, name: pack.name || '(未命名)', n: 0, size: 0, remain: 0, used: 0, minStart: null }
    entry.n += 1
    entry.size += numOf(pack.total)
    entry.remain += numOf(pack.left)
    entry.used += numOf(pack.used)
    if (pack.startAt && pack.startAt > 1000 && (entry.minStart == null || pack.startAt < entry.minStart)) {
      entry.minStart = pack.startAt
    }
    map.set(key, entry)
  }
  return [...map.values()].sort((a, b) => b.size - a.size)
}

/** 明细表默认展示的正余额包条数（页面内可调，见 DETAIL_LIMIT_KEY；detailGroupsOf 按入参取） */
function detailVisibleLimit(): number {
  return readDetailLimit()
}

type DetailGroups = {
  visible: ResourceItem[]
  rest: ResourceItem[]
  used: ResourceItem[]
  restSize: number
  restRemain: number
  usedSize: number
}

/** 单账号逐包明细的折叠口径（参考站 pkDetailGroups 同口径，app.js:2300）：
 *  正余额包按到期时间从早到晚默认展示前 N 条（同到期按面额降序），其余正余额包
 *  与已用完包分别折叠成一行汇总；平铺明细不丢 —— 展开即全部行。 */
function detailGroupsOf(packs: ResourceItem[]): DetailGroups {
  const byExpiry = (a: ResourceItem, b: ResourceItem): number => {
    const ea = a.expireAt ?? Number.POSITIVE_INFINITY
    const eb = b.expireAt ?? Number.POSITIVE_INFINITY
    if (ea !== eb) return ea - eb
    return numOf(b.total) - numOf(a.total)
  }
  const active: ResourceItem[] = []
  const used: ResourceItem[] = []
  for (const pack of packs) (numOf(pack.left) > 0 ? active : used).push(pack)
  active.sort(byExpiry)
  used.sort(byExpiry)
  const limit = detailVisibleLimit()
  const visible = active.slice(0, limit)
  const rest = active.slice(visible.length)
  let restSize = 0
  let restRemain = 0
  let usedSize = 0
  for (const pack of rest) {
    restSize += numOf(pack.total)
    restRemain += numOf(pack.left)
  }
  for (const pack of used) usedSize += numOf(pack.total)
  return { visible, rest, used, restSize, restRemain, usedSize }
}

/* ─── 组件内样式（圈在 .pk-* 名下，颜色全走 token，深浅主题自动跟随）── */

const PK_CSS = `
.pk-exp-head, .pk-exp-row {
  display: grid;
  grid-template-columns: 64px minmax(72px, 1fr) 88px;
  align-items: center;
  gap: 9px;
}
.pk-exp-head { margin-bottom: 4px; color: var(--ui-text-2); font-size: 11px; }
.pk-exp-head > b { text-align: right; font-weight: 600; }
.pk-exp-row { min-height: 30px; }
.pk-exp-row > span { color: var(--ui-text-2); font-size: 11.5px; white-space: nowrap; }
.pk-exp-row > b {
  text-align: right; font-weight: 600; font-size: 11.5px;
  font-family: var(--ui-font-mono); font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.pk-chart-scroll {
  max-height: 280px; overflow-y: auto; overflow-x: hidden;
  scrollbar-width: thin; overscroll-behavior: contain; padding-right: 8px;
}
.pk-exp-track {
  display: flex; align-items: stretch; gap: 2px; height: 9px;
  border-radius: 5px; background: var(--ui-surface-inset); overflow: hidden;
}
.pk-exp-seg {
  display: block; min-width: 3px; height: 100%;
  transition: filter .15s;
}
.pk-exp-seg:hover { filter: brightness(1.12); }
.pk-mixbar {
  display: flex; height: 7px; border-radius: 4px; overflow: hidden;
  margin-top: 8px; background: var(--ui-surface-inset);
}
.pk-mixbar i { display: block; height: 100%; min-width: 2px; }
.pk-expirybar {
  display: flex; height: 5px; border-radius: 3px; overflow: hidden;
  margin-top: 6px; background: var(--ui-surface-inset);
}
.pk-expirybar i { display: block; height: 100%; min-width: 2px; }
.pk-legend {
  display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px;
  color: var(--ui-text-2); font-size: 11px;
}
.pk-legend span { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.pk-legend i { width: 9px; height: 9px; border-radius: 3px; flex: 0 0 9px; }
.pk-exp-pill {
  display: inline-flex; align-items: center; height: 16px; margin-left: 6px;
  padding: 0 6px; border: 1px solid var(--warn-bd); border-radius: 999px;
  background: var(--warn-soft); color: var(--warn);
  font-size: 10px; font-weight: 600; line-height: 1; white-space: nowrap;
  vertical-align: 1px;
}
.pk-exp-pill.danger { color: var(--danger); background: var(--danger-soft); border-color: var(--danger-bd); }
@media (max-width: 480px) {
  .pk-exp-head, .pk-exp-row { grid-template-columns: 52px minmax(56px, 1fr) 72px; gap: 6px; }
  .pk-legend { font-size: 10.5px; }
}
`

/* ─── 视图 ─────────────────────────────────────────────────── */

/** 到期日单元格：YYYY-MM-DD 右对齐等宽 + 临期徽章（≤3 天红 / ≤7 天黄，与账号池同款） */
function ExpiryCell({ expireAt, now }: { expireAt: number | null | undefined; now: number }): React.ReactElement {
  const day = dayOf(expireAt)
  if (!day) return <span className='text-subtle'>—</span>
  const tier = expiryTierOf(expireAt, now)
  return (
    <span
      className={cn(
        'whitespace-nowrap tabular-nums',
        (tier === 'expired' || tier === 'urgent') && 'font-medium text-destructive',
        tier === 'soon' && 'font-medium text-warning',
      )}
    >
      {day}
      {tier ? (
        <span className={cn('pk-exp-pill', tier !== 'soon' && 'danger')} title={TIER_TEXT[tier].title}>
          {TIER_TEXT[tier].label}
        </span>
      ) : null}
    </span>
  )
}

/** 已知来源码前缀：上游 packageCode 带的批次数头（如 TCACA_），展示时剥掉 ——
 *  原始完整码放进悬停 title（换方法：泛化成前缀表而不是只认一个，title 兜底可溯源）。 */
const SOURCE_CODE_PREFIXES = ['TCACA_', 'CODEBUDDY_', 'CB_']
function displayCode(packageCode: string | undefined): string {
  let code = packageCode || ''
  for (const prefix of SOURCE_CODE_PREFIXES) {
    if (code.startsWith(prefix)) { code = code.slice(prefix.length); break }
  }
  return code
}

/** 逐包明细行（含来源色点；列：包名/来源 · 面额 · 剩余 · 已用 · 发放 · 到期） */
function detailRow(
  pack: ResourceItem,
  index: number,
  sourceColor: Map<string, string>,
  now: number,
): React.ReactElement {
  const key = `${pack.packageCode || ''}|${pack.name || '(未命名)'}`
  const code = displayCode(pack.packageCode)
  return (
    <tr key={pack.id || `${key}-${index}`} className='border-t border-hairline'>
      <td className='py-1.5 pr-1.5 align-middle'>
        <i
          aria-hidden='true'
          className='inline-block size-2 rounded-[3px]'
          style={{ background: sourceColor.get(key) || PK_PALETTE[0] }}
        />
      </td>
      <td className='py-1.5 pr-3'>
        <span>{pack.name || pack.packageCode || '（未命名）'}</span>
        {pack.isDaily ? <span className='ml-1 text-[10.5px] text-subtle'>日额</span> : null}
        {code ? (
          <div
            className='mt-0.5 cursor-help text-[10.5px] leading-tight text-subtle'
            title={`原始来源码：${pack.packageCode || ''}`}
          >
            {code}
          </div>
        ) : null}
      </td>
      <td className='py-1.5 pr-3 text-right tabular-nums'>{pack.total ?? '—'}</td>
      <td className='py-1.5 pr-3 text-right font-medium tabular-nums'>{pack.left ?? '—'}</td>
      <td className='py-1.5 pr-3 text-right tabular-nums text-subtle'>{pack.used ?? '—'}</td>
      <td
        className='py-1.5 pr-3 whitespace-nowrap text-subtle tabular-nums'
        title={pack.startAt && pack.startAt > 1000 ? `发放时间 ${timeOf(pack.startAt)}` : undefined}
      >
        {relativeStartOf(pack.startAt, now)}
      </td>
      <td className='py-1.5'>
        <ExpiryCell expireAt={pack.expireAt} now={now} />
      </td>
    </tr>
  )
}

/** 折叠汇总行（参考站 pk-group-summary / pk-group-toggle 同交互）：
 *  收起时「……，展开」，展开时「收起……」，其余行随之显隐。 */
function GroupToggleRow({
  label,
  expanded,
  onToggle,
}: {
  label: string
  expanded: boolean
  onToggle: () => void
}): React.ReactElement {
  return (
    <tr className='border-t border-hairline bg-surface-2'>
      <td colSpan={7} className='p-0'>
        <button
          type='button'
          aria-expanded={expanded}
          onClick={onToggle}
          className='w-full px-2 py-1.5 text-left text-[11px] text-subtle transition-colors hover:text-foreground'
        >
          {expanded ? `收起${label}` : `${label}，展开`}
        </button>
      </td>
    </tr>
  )
}

/** 逐账号明细表：默认最早到期 N 条（页面可调）+ 折叠汇总（其余未用完 / 已用完）。
 *  querySeq 变化 = 刚完成一次新查询：展开状态重置回默认收起（换方法：由父组件
 *  递增的查询序号驱动，而非比较数据引用 —— 上游数据每次都是新对象）。 */
function AccountDetail({
  result,
  sourceColor,
  now,
  querySeq,
}: {
  result: UsageResult
  sourceColor: Map<string, string>
  now: number
  querySeq: number
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState<{ rest: boolean; used: boolean }>({
    rest: false,
    used: false,
  })
  React.useEffect(() => {
    setExpanded({ rest: false, used: false })
  }, [querySeq])
  const packs = packagesOf(result)
  const groups = detailGroupsOf(packs)
  const edition = EDITION_LABELS[result.editionType || ''] || result.editionType || ''
  const activeCount = groups.visible.length + groups.rest.length
  const rowOf = (pack: ResourceItem, index: number): React.ReactElement =>
    detailRow(pack, index, sourceColor, now)

  return (
    <section className='rounded-md border border-hairline bg-card p-3 sm:p-4'>
      <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1'>
        <h3 className='text-[13px] font-semibold'>
          {nameOf(result)}
          {edition ? <span className='ml-1.5 text-[11.5px] font-normal text-subtle'>{edition}</span> : null}
        </h3>
        <span className='hint'>
          余额 {fmtTok(numOf(result.usageLeft))} / 总额 {fmtTok(numOf(result.usageTotal))} · 可用{' '}
          {activeCount} 个包
          {groups.used.length > 0 ? ` / 已用完 ${groups.used.length} 个` : ''} ·
          默认展示最早到期 {detailVisibleLimit()} 条
        </span>
      </div>
      <div className='mt-2 overflow-x-auto'>
        <table className='w-full min-w-[520px] text-[11.5px] sm:text-[12px]'>
          <thead>
            <tr className='text-left text-[11px] font-medium text-subtle'>
              <th className='w-4 py-1.5 pr-1.5' aria-hidden='true' />
              <th className='py-1.5 pr-3'>积分包 / 来源</th>
              <th className='py-1.5 pr-3 text-right'>面额</th>
              <th className='py-1.5 pr-3 text-right'>剩余</th>
              <th className='py-1.5 pr-3 text-right'>已用</th>
              <th className='py-1.5 pr-3'>发放</th>
              <th className='py-1.5'>到期</th>
            </tr>
          </thead>
          <tbody>
            {packs.length === 0 ? (
              <tr>
                <td colSpan={7} className='border-t border-hairline py-3 text-center text-subtle'>
                  该账号没有积分包明细
                </td>
              </tr>
            ) : (
              <>
                {groups.visible.map(rowOf)}
                {groups.rest.length > 0 ? (
                  <>
                    <GroupToggleRow
                      label={`其余未用完 ${groups.rest.length} 个包（面额合计 ${fmtTok(groups.restSize)} · 剩余 ${fmtTok(groups.restRemain)}）`}
                      expanded={expanded.rest}
                      onToggle={() => setExpanded(prev => ({ ...prev, rest: !prev.rest }))}
                    />
                    {expanded.rest ? groups.rest.map(rowOf) : null}
                  </>
                ) : null}
                {groups.used.length > 0 ? (
                  <>
                    <GroupToggleRow
                      label={`已用完 ${groups.used.length} 个包（面额合计 ${fmtTok(groups.usedSize)}）`}
                      expanded={expanded.used}
                      onToggle={() => setExpanded(prev => ({ ...prev, used: !prev.used }))}
                    />
                    {expanded.used ? groups.used.map(rowOf) : null}
                  </>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function CreditsPage(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null)
  const [ready, setReady] = React.useState(false)
  const [querying, setQuerying] = React.useState(false)
  /** 明细默认展示条数（页面可调，localStorage 持久化） */
  const [detailLimit, setDetailLimit] = React.useState<number>(() => readDetailLimit())
  /** 查询序号：每次成功查询 +1，明细卡的展开状态据此重置回默认收起 */
  const [querySeq, setQuerySeq] = React.useState(0)

  /** 拉积分包构成（逐启用 WorkBuddy 账号真打上游）。打开页面先拉一次，
   *  「查询积分」按钮再拉——端点本身就是明细查询，没有快照层。 */
  const load = React.useCallback(async (): Promise<void> => {
    setQuerying(true)
    try {
      setSnapshot(await callLocal<Snapshot>('GET', '/api/accounts/usage/packages'))
      setQuerySeq(seq => seq + 1)
    } catch (error) {
      toast(`读取积分构成失败：${describeError(error)}`, 'err')
    } finally {
      setQuerying(false)
      setReady(true)
    }
  }, [])

  React.useEffect(() => {
    // 对外接口登记：app.js 切到本页时调 wbCreditsPanel.load()（转给组件内的 load）
    loadRef = load
    void load()
    return () => { loadRef = null }
  }, [load])

  const now = Date.now()
  const results = snapshot?.results ?? []
  const failedRows = results.filter(isErrorRow)
  const withPackages = results.filter(item => packagesOf(item).length > 0)
  const skipped = snapshot?.skipped ?? 0
  const skippedProviders = snapshot?.skippedProviders ?? []

  // ── 稳定配色：账号按 id 排序取色（刷新重排不换色，参考站 pkAccountColorMap）──
  const accountColor = new Map<string, string>()
  results
    .filter(result => !isErrorRow(result) && result.id)
    .map(result => String(result.id))
    .sort()
    .forEach((id, index) => accountColor.set(id, paletteAt(index)))

  // 包来源 → 颜色：跨账号同名同码同色（参考站按「各账号最大面额」降序取名次）
  const sourceKeys: string[] = []
  const sourceMaxSize = new Map<string, number>()
  for (const result of results) {
    for (const source of sourcesOf(packagesOf(result))) {
      if (!sourceMaxSize.has(source.key)) sourceKeys.push(source.key)
      sourceMaxSize.set(source.key, Math.max(sourceMaxSize.get(source.key) || 0, source.size))
    }
  }
  sourceKeys.sort((a, b) => (sourceMaxSize.get(b) || 0) - (sourceMaxSize.get(a) || 0))
  const sourceColor = new Map(sourceKeys.map((key, index) => [key, paletteAt(index)]))

  // 逐账号分段只算一次，到期分布 / 卡片迷你条 / 图例三处共用
  const segmentsByAccount = new Map<string, Segment[]>()
  for (const result of results) {
    segmentsByAccount.set(result.id || '', isErrorRow(result) ? [] : segmentsOf(result, now))
  }

  // ── 到期分布：按剩余整天数分桶（无有效到期时间的余额不进图，不猜到期日）──
  type ExpiryRow = { days: number; credits: number; segments: Segment[] }
  const buckets = new Map<number, ExpiryRow>()
  for (const result of results) {
    if (isErrorRow(result)) continue
    for (const segment of segmentsByAccount.get(result.id || '') || []) {
      if (segment.days == null) continue
      const row = buckets.get(segment.days) || { days: segment.days, credits: 0, segments: [] }
      row.credits += segment.amount
      row.segments.push(segment)
      buckets.set(segment.days, row)
    }
  }
  const expiryRows = [...buckets.values()].sort((a, b) => a.days - b.days)
  for (const row of expiryRows) {
    row.segments.sort((a, b) =>
      (a.expireAt ?? Number.POSITIVE_INFINITY) - (b.expireAt ?? Number.POSITIVE_INFINITY) ||
      a.accountName.localeCompare(b.accountName) ||
      a.source.localeCompare(b.source))
  }
  const legendEntries = results
    .filter(result => !isErrorRow(result) && (segmentsByAccount.get(result.id || '') || []).some(s => s.days != null))
    .map(result => ({
      uid: String(result.id || ''),
      name: nameOf(result),
      color: accountColor.get(String(result.id || '')) || PK_PALETTE[0],
    }))

  // ── 账号对比：占最高百分比用「最高余额」做分母（参考站 maxRemain）──
  const maxRemain = Math.max(1, ...results.map(result => numOf(result.usageLeft)))

  return (
    <div className='flex flex-col gap-4 p-3 sm:p-4'>
      <style dangerouslySetInnerHTML={{ __html: PK_CSS }} />

      {/* 页头：说明 + 主操作（窄屏按钮折到下一行，不挤标题） */}
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='min-w-0'>
          <h2 className='text-[15px] font-semibold'>积分构成</h2>
          <p className='hint mt-0.5'>
            逐 WorkBuddy 账号向上游实时查询积分包：到期分布（越早到期的越先用掉）· 账号对比 ·
            逐包明细（默认展示最早到期 {detailLimit} 条，其余折叠可展开）。
            其他提供商没有「积分包 + 到期」的概念，不计入本页。
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <label className='flex items-center gap-1.5 text-[11.5px] text-subtle'>
            明细展示
            <Select
              value={String(detailLimit)}
              onValueChange={value => {
                const next = Number(value)
                setDetailLimit(next)
                saveDetailLimit(next)
              }}
            >
              <SelectTrigger id='credits-detail-limit' className='h-7 w-[74px] text-[12px]'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DETAIL_LIMITS.map(limit => (
                  <SelectItem key={limit} value={String(limit)}>
                    {limit} 条
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button id='btn-credits-query' variant='default' disabled={querying} onClick={() => void load()}>
            {querying ? <><Spinner className='mr-1.5 inline-block size-3.5' />查询中…</> : '查询积分'}
          </Button>
        </div>
      </div>

      {!ready ? (
        <div className='rounded-md border border-hairline bg-card px-4 py-8 text-center text-[12px] text-subtle'>
          <Spinner className='mr-1.5 inline-block size-3.5' />正在逐账号向上游查询积分包…
        </div>
      ) : results.length === 0 ? (
        <div className='rounded-md border border-hairline bg-card p-6 text-center'>
          <p className='text-[13px] font-medium'>没有可展示的积分包</p>
          <p className='hint mx-auto mt-1 max-w-[560px]'>
            没有启用中的 WorkBuddy 账号（或查询时上游没有返回积分包）。
            积分包是 WorkBuddy（腾讯 CodeBuddy）的额度概念，其他提供商不产生积分包。
          </p>
        </div>
      ) : (
        <>
          {/* ── 积分到期分布（参考站 pkExpiry：剩余天数 × 账号分段堆叠条）── */}
          <section className='rounded-md border border-hairline bg-card p-3 sm:p-4'>
            <div className='flex flex-wrap items-baseline justify-between gap-x-3'>
              <h3 className='text-[13px] font-semibold'>积分到期分布</h3>
              <span className='hint'>按批次剩余天数聚合，颜色区分账号，越早到期的越先用掉</span>
            </div>
            {expiryRows.length === 0 ? (
              <p className='py-6 text-center text-[12px] text-subtle'>
                暂无可汇总积分（没有带有效到期时间的剩余积分）
              </p>
            ) : (
              <>
                <div className='pk-exp-head mt-2'>
                  <span>剩余天数</span>
                  <span style={{ textAlign: 'center' }}>各账号该批剩余</span>
                  <b>剩余积分</b>
                </div>
                <div className='pk-chart-scroll'>
                  {expiryRows.map(row => (
                    <div key={row.days} className='pk-exp-row'>
                      <span>{row.days === 0 ? '已到期' : `${row.days} 天`}</span>
                      <div className='pk-exp-track' role='img' aria-label='该批次各账号剩余积分'>
                        {row.segments.map((segment, index) => (
                          <span
                            key={`${segment.uid}-${segment.source}-${index}`}
                            className='pk-exp-seg'
                            style={{
                              background: accountColor.get(segment.uid) || PK_PALETTE[0],
                              opacity: expiryOpacity(segment.days),
                              flex: `${Math.max(0.008, segment.amount / (row.credits || 1)).toFixed(4)} 1 0`,
                            }}
                            title={`${segment.source}\n${fmtTok(segment.amount)} 积分\n到期时间 ${timeOf(segment.expireAt)}（${relativeExpiryOf(segment.expireAt, now)}）\n${segment.accountName}`}
                          />
                        ))}
                      </div>
                      <b>{fmtTok(row.credits)}</b>
                    </div>
                  ))}
                </div>
                {legendEntries.length > 0 ? (
                  <div className='pk-legend mt-2'>
                    {legendEntries.map(entry => (
                      <span key={entry.uid}>
                        <i style={{ background: entry.color }} />
                        {entry.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </>
            )}
            <p className='hint mt-2.5 border-t border-hairline pt-2'>
              {results.length} 个账号
              {failedRows.length > 0 ? ` · ${failedRows.length} 个未获取余额` : ''}
            </p>
          </section>

          {/* ── 账号对比（参考站 pkSummary：大数余额 + 来源构成条 + 到期迷你条 + 图例）── */}
          <section className='rounded-md border border-hairline bg-card p-3 sm:p-4'>
            <div className='flex flex-wrap items-baseline justify-between gap-x-3'>
              <h3 className='text-[13px] font-semibold'>账号对比</h3>
              <span className='hint'>
                {results.length} 个账号 · 实时查询上游 · 颜色 = 积分包来源（同名同码同色）
              </span>
            </div>
            <div className='mt-2.5 grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3'>
              {results.map(result => {
                const edition = EDITION_LABELS[result.editionType || ''] || result.editionType || ''
                if (isErrorRow(result)) {
                  return (
                    <div key={result.id || result.name} className='rounded-lg border border-hairline p-3'>
                      <div className='flex items-baseline gap-2'>
                        <span className='text-[13px] font-semibold'>{nameOf(result)}</span>
                        {edition ? <span className='text-[11px] text-subtle'>{edition}</span> : null}
                      </div>
                      <p className='mt-1.5 text-[12px] leading-relaxed text-warning'>
                        查询失败：{result.error || '未知错误'}
                      </p>
                    </div>
                  )
                }
                const packs = packagesOf(result)
                const srcs = sourcesOf(packs)
                const segments = segmentsByAccount.get(result.id || '') || []
                const expiryTotal = segments.reduce((sum, segment) => sum + segment.amount, 0)
                const planTier = expiryTierOf(result.expireAt, now)
                const color = accountColor.get(String(result.id || '')) || PK_PALETTE[0]
                return (
                  <div key={result.id || result.name} className='rounded-lg border border-hairline p-3'>
                    <div className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
                      <span className='text-[13px] font-semibold'>{nameOf(result)}</span>
                      {result.planName || edition ? (
                        <span className='text-[11px] text-subtle'>
                          {result.planName || ''}{result.planName && edition ? ' · ' : ''}{edition}
                        </span>
                      ) : null}
                    </div>
                    <div className='mt-1.5 font-mono text-[22px] font-semibold leading-none tabular-nums sm:text-[24px]'>
                      {fmtTok(numOf(result.usageLeft))}
                    </div>
                    <div className='mt-1.5 text-[11.5px] leading-relaxed text-subtle'>
                      共 {fmtTok(numOf(result.usageTotal))} · 已用 {fmtTok(numOf(result.usageUsed))} ·{' '}
                      {packs.length} 个包 · 占最高{' '}
                      {((numOf(result.usageLeft) / maxRemain) * 100).toFixed(0)}%
                      {dayOf(result.expireAt) ? (
                        <>
                          {' '}· 套餐到期{' '}
                          <span
                            className={cn(
                              'tabular-nums',
                              (planTier === 'expired' || planTier === 'urgent') && 'text-destructive',
                              planTier === 'soon' && 'text-warning',
                            )}
                          >
                            {dayOf(result.expireAt)}
                          </span>
                        </>
                      ) : null}
                    </div>
                    {srcs.length > 0 ? (
                      <>
                        <div className='pk-mixbar' role='img' aria-label='积分包来源构成'>
                          {srcs.map(source => (
                            <i
                              key={source.key}
                              style={{
                                width: `${(source.size / Math.max(1, numOf(result.usageTotal))) * 100}%`,
                                background: sourceColor.get(source.key) || PK_PALETTE[0],
                              }}
                              title={`${source.name} ${fmtTok(source.size)}`}
                            />
                          ))}
                        </div>
                        <div className='pk-legend'>
                          {srcs.map(source => (
                            <span key={source.key}>
                              <i style={{ background: sourceColor.get(source.key) || PK_PALETTE[0] }} />
                              {source.name} x{source.n} · {fmtTok(source.size)}
                              {source.minStart ? ` · 首发 ${dayOf(source.minStart).slice(5)}` : ''}
                            </span>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className='mt-2 text-[11.5px] text-subtle'>上游没有返回积分包</p>
                    )}
                    {segments.length > 0 ? (
                      <div
                        className='pk-expirybar'
                        role='img'
                        aria-label='该账号积分到期分布'
                      >
                        {segments.map((segment, index) => (
                          <i
                            key={`${segment.source}-${index}`}
                            style={{
                              background: color,
                              opacity: expiryOpacity(segment.days),
                              flex: `${Math.max(0.008, segment.amount / Math.max(1, expiryTotal)).toFixed(4)} 1 0`,
                            }}
                            title={`${segment.source}\n${fmtTok(segment.amount)} 积分\n到期时间 ${timeOf(segment.expireAt)}（${relativeExpiryOf(segment.expireAt, now)}）`}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>

          {/* ── 逐账号明细（参考站 pkDetail：面额重点 + 折叠汇总，平铺明细展开可得）── */}
          {results
            .filter(result => !isErrorRow(result))
            .map(result => (
              <AccountDetail
                key={result.id || result.name}
                result={result}
                sourceColor={sourceColor}
                now={now}
                querySeq={querySeq}
              />
            ))}

          {(failedRows.length > 0 || skipped > 0) && (
            <p className='hint'>
              {failedRows.length > 0 ? `${failedRows.length} 个 WorkBuddy 账号查询失败（${String(failedRows[0].error).slice(0, 50)}${String(failedRows[0].error).length > 50 ? '…' : ''}），请到「账号池」检查登录态后重试` : ''}
              {failedRows.length > 0 && skipped > 0 ? '；' : ''}
              {skipped > 0
                ? `另有 ${skipped} 个其他提供商的账号未计入${skippedProviders.length ? `（${[...new Set(skippedProviders)].join('、')}）` : ''}`
                : ''}。
            </p>
          )}
        </>
      )}
    </div>
  )
}

/* ─── 挂载与对外接口 ───────────────────────────────────────── */

/** 组件挂载后自登记的 load（app.js 切页时经 wbCreditsPanel.load() 调到）。
 *  声明必须在 mount() 之前：flushSync 渲染会**同步**跑 useEffect，effect 里
 *  就要写这个变量 —— 声明放后面（TDZ）会让首次渲染直接 ReferenceError。 */
let loadRef: (() => Promise<void>) | null = null

let pageRoot: ReturnType<typeof createRoot> | null = null

function mount(): void {
  if (pageRoot) return
  const section = document.querySelector<HTMLElement>(PAGE_SELECTOR)
  if (!section) return
  section.replaceChildren()
  // onUncaughtError：渲染 / 副作用里未捕获的错误会被 React 19 整树卸载（本页表现为
  // 「section 空白但 wbCreditsPanel 存在」），把错误留在一个可查的句柄上便于定位
  pageRoot = createRoot(section, {
    onUncaughtError: (error) => {
      (window as unknown as { __creditsPageError?: string }).__creditsPageError = String(error)
      console.error('[credits-page]', error)
    },
  })
  flushSync(() => { pageRoot?.render(<CreditsPage />) })
}

if (document.querySelector(PAGE_SELECTOR)) mount()
else document.addEventListener('DOMContentLoaded', mount, { once: true })

const bridgeWindow = window as unknown as { wbCreditsPanel?: { load?: () => Promise<void> | void } }
bridgeWindow.wbCreditsPanel = { load: () => void loadRef?.() }
