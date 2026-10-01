/**
 * AIBuddy Panel · 积分构成页（对照 workbuddy2api-panel 的同名页：到期分布 / 账号对比 / 逐包明细）。
 *
 * 本岛接管 `<section class="page" data-page="credits">`，清空子节点后把 React root 直接建在
 * 这个 section 上（不套宿主 div，与 settings-page / report-page 同一手法）。
 *
 * ── 数据从哪来 ──────────────────────────────────────────────
 * 积分查询链路是现成的：`GET /api/accounts/usage/snapshot` 返回最近一次**定时查询**的
 * 快照（秒开、不打上游），`GET /api/accounts/usage` 才真正逐账号打上游（账号页工具栏的
 * 「查询积分」与定时任务页的定时查询走同一条）。每条 result 的 `usage.resources[]` 就是
 * 积分包构成（packageCode / name / isDaily / total / used / left / expireAt …，后端已按
 * 到期时间排序，见 billing/usage.rs）—— 本页只做展示，不再发明新的上游调用。
 *
 * 打开页面 = 读快照（app.js 的 showPage 转发 `wbCreditsPanel.load()`）；「查询积分」按钮
 * 才发起真查询（与账号页同一语义：全量启用账号、支持积分查询的家）。两家之外的账号
 * （无 resources 形状 / error）不进对比与明细，只归进底部一行「N 个账号无积分明细」。
 *
 * ── 视觉 ────────────────────────────────────────────────────
 * 复用 settings-page 同一套 tokens（bg-card / border-hairline / text-subtle …），
 * 手机端单列堆叠（sm: 断点），窄屏表格横向滚动。
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Button, Spinner } from '@ui'
import { shared, toast } from './settings-model'

const PAGE_SELECTOR = '.page[data-page="credits"]'

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

/* ─── 数据形状（与 billing/usage.rs 的输出逐字对齐）──────────── */

type ResourceItem = {
  id?: string
  packageCode?: string
  name?: string
  isDaily?: boolean
  /** total / used / left 可能是数字或字符串（后端 js_int_string 的口径），展示层按字符串处理 */
  total?: number | string
  used?: number | string
  left?: number | string
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

type UsageResult = { id?: string; name?: string; usage?: UsagePayload | null; error?: string; code?: string }
type Snapshot = { at?: number; results?: UsageResult[]; skipped?: { id?: string; reason?: string }[] }

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

/** 账号版本的中文标（editionType → 展示名） */
const EDITION_LABELS: Record<string, string> = {
  flagship: '旗舰版',
  advanced: '进阶版',
  pro: '专业版',
  youth: '青春版',
  pro_trial: '专业试用',
  free: '免费',
}

/** 有积分包明细的账号（WorkBuddy 个人 / 企业口径里带 resources 的那种） */
function packagesOf(result: UsageResult): ResourceItem[] {
  const resources = result.usage?.resources
  return Array.isArray(resources) ? resources : []
}

/* ─── 视图 ─────────────────────────────────────────────────── */

function PackageTable({ items }: { items: ResourceItem[] }): React.ReactElement {
  return (
    <div className='overflow-x-auto'>
      <table className='w-full text-[12px]'>
        <thead>
          <tr className='text-left text-subtle'>
            <th className='py-1.5 pr-3 font-medium'>积分包</th>
            <th className='py-1.5 pr-3 font-medium text-right'>总量</th>
            <th className='py-1.5 pr-3 font-medium text-right'>已用</th>
            <th className='py-1.5 pr-3 font-medium text-right'>剩余</th>
            <th className='py-1.5 font-medium'>到期时间</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={item.id || `${item.packageCode}-${index}`} className='border-t border-hairline'>
              <td className='py-1.5 pr-3'>
                {item.name || item.packageCode || '（未命名）'}
                {item.isDaily ? <span className='ml-1 text-[11px] text-subtle'>日额</span> : null}
              </td>
              <td className='py-1.5 pr-3 text-right tabular-nums'>{item.total ?? '—'}</td>
              <td className='py-1.5 pr-3 text-right tabular-nums'>{item.used ?? '—'}</td>
              <td className='py-1.5 pr-3 text-right tabular-nums'>{item.left ?? '—'}</td>
              <td className='py-1.5'>
                {dayOf(item.expireAt)
                  ? <span className='tabular-nums'>{dayOf(item.expireAt)}</span>
                  : <span className='text-subtle'>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CreditsPage(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null)
  const [ready, setReady] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [querying, setQuerying] = React.useState(false)

  /** 读快照（秒开，不打上游）；at=0 表示本进程还没查过 → 空态引导手动查询 */
  const load = React.useCallback(async (): Promise<void> => {
    setReady(false)
    try {
      setSnapshot(await callLocal<Snapshot>('GET', '/api/accounts/usage/snapshot'))
    } catch (error) {
      toast(`读取积分快照失败：${describeError(error)}`, 'err')
    } finally {
      setReady(true)
    }
  }, [])

  /** 真查询（逐账号打上游，与账号页「查询积分」同一语义），成功后以响应为准重画。
   *  手动查询本身就是一次「已查询」：响应没有 at（只有快照端点带）时补当前时间，
   *  否则空态文案会错成「本进程还没有查过积分」。 */
  const queryNow = React.useCallback(async (): Promise<void> => {
    if (querying) return
    setQuerying(true)
    setBusy(true)
    try {
      const report = await callLocal<Snapshot>('GET', '/api/accounts/usage')
      setSnapshot(prev => ({ ...(report ?? {}), at: report?.at || prev?.at || Date.now() }))
      toast('✅ 积分查询完成')
    } catch (error) {
      toast(`积分查询失败：${describeError(error)}`, 'err')
    } finally {
      setQuerying(false)
      setBusy(false)
    }
  }, [querying])

  React.useEffect(() => {
    // 对外接口登记：app.js 切到本页时调 wbCreditsPanel.load()（转给组件内的 load）
    loadRef = load
    void load()
    return () => { loadRef = null }
  }, [load])

  const results = snapshot?.results ?? []
  const withPackages = results.filter(item => packagesOf(item).length > 0)
  const withoutPackages = results.length - withPackages.length
  const skipped = snapshot?.skipped ?? []

  // ── 到期分布：全账号的积分包按到期日聚合（缺失到期时间的包不计入）──
  const byDay = new Map<string, number>()
  for (const item of withPackages) {
    for (const pack of packagesOf(item)) {
      const day = dayOf(pack.expireAt)
      if (day) byDay.set(day, (byDay.get(day) || 0) + numOf(pack.left))
    }
  }
  const expiries = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
  const maxExpire = expiries.reduce((acc, [, value]) => Math.max(acc, value), 0)

  return (
    <div className='flex flex-col gap-4 p-4'>
      {/* 页头：说明 + 主操作 */}
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <h2 className='text-[15px] font-semibold'>积分构成</h2>
          <p className='hint mt-0.5'>
            逐账号的积分包明细与到期分布。数据来自「积分查询」——打开本页先展示最近一次定时查询的快照，
            点「查询积分」才会真正到上游逐账号拉取。
          </p>
        </div>
        <Button id='btn-credits-query' variant='default' disabled={querying || busy} onClick={() => void queryNow()}>
          {querying ? <><Spinner className='mr-1.5 inline-block size-3.5' />查询中…</> : '查询积分'}
        </Button>
      </div>

      {!ready ? (
        <div className='rounded-md border border-hairline bg-card p-6 text-center text-[12px] text-subtle'>
          <Spinner className='mr-1.5 inline-block size-3.5' />正在读取积分快照…
        </div>
      ) : withPackages.length === 0 ? (
        <div className='rounded-md border border-hairline bg-card p-6 text-center'>
          <p className='text-[13px] font-medium'>还没有积分数据</p>
          <p className='hint mx-auto mt-1 max-w-[520px]'>
            {snapshot?.at
              ? '最近一次查询的结果里没有可展示的积分包（可能查询时没有启用中的账号，或账号不属于提供积分包的提供商）。'
              : '本进程还没有查过积分。点右上角「查询积分」对全部启用账号拉取一次（也可在「任务中心」里配置定时查询）。'}
          </p>
        </div>
      ) : (
        <>
          {/* ── 积分到期分布 ── */}
          <section className='rounded-md border border-hairline bg-card p-3'>
            <div className='flex items-baseline justify-between'>
              <h3 className='text-[13px] font-semibold'>积分到期分布</h3>
              <span className='hint'>按批次到期日聚合剩余积分，越早到期的越先用掉</span>
            </div>
            <div className='mt-2 flex flex-col gap-1.5'>
              {expiries.map(([day, value]) => (
                <div key={day} className='flex items-center gap-2'>
                  <span className='w-[84px] flex-none tabular-nums text-[12px] text-subtle'>{day}</span>
                  <div className='h-3.5 flex-1 overflow-hidden rounded-sm bg-surface-2'>
                    <div
                      className='h-full rounded-sm bg-primary opacity-70'
                      style={{ width: maxExpire > 0 ? `${Math.max(2, (value / maxExpire) * 100)}%` : '0%' }}
                    />
                  </div>
                  <span className='w-[96px] flex-none text-right tabular-nums text-[12px]'>{value.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </section>

          {/* ── 账号对比 + 逐包明细 ── */}
          {withPackages.map(item => {
            const usage = item.usage
            const edition = EDITION_LABELS[usage?.editionType || ''] || usage?.editionType || ''
            return (
              <section key={item.id || item.name} className='rounded-md border border-hairline bg-card p-3'>
                <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1'>
                  <h3 className='text-[13px] font-semibold'>{item.name || item.id || '（未命名账号）'}</h3>
                  <div className='flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[12px]'>
                    {usage?.planName ? <span className='text-subtle'>{usage.planName}{edition ? ` · ${edition}` : ''}</span> : null}
                    <span>总剩余 <b className='tabular-nums'>{usage?.usageLeft ?? '—'}</b></span>
                    <span className='text-subtle'>已用 <span className='tabular-nums'>{usage?.usageUsed ?? '—'}</span></span>
                    <span className='text-subtle'>累计 <span className='tabular-nums'>{usage?.usageTotal ?? '—'}</span></span>
                    <span className='text-subtle'>套餐到期 {dayOf(usage?.expireAt) || '—'}</span>
                  </div>
                </div>
                <div className='mt-2'>
                  <PackageTable items={packagesOf(item)} />
                </div>
              </section>
            )
          })}

          {(withoutPackages > 0 || skipped.length > 0) && (
            <p className='hint'>
              另有 {withoutPackages} 个账号本次查询结果不含积分包明细（不支持积分查询的提供商或查询报错）
              {skipped.length > 0 ? `，${skipped.length} 个账号被跳过` : ''}。
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
