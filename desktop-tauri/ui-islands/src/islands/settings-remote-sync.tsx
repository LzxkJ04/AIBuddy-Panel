/**
 * AIBuddy Panel · 设置页「账号导入 / 导出」卡里的「一键绑定远程」块。
 *
 * 解决的事：多机部署（本机桌面端 + 远程服务器面板）下账号要两边用，以前只能
 * 「本机导出 JSON 文件 → 到远程导入文件」手工倒。这里把这条链路自动化：远程
 * 面板本来就是同一套网关（`/api/accounts/export` / `/api/accounts/import`），
 * 直接跨域调它 —— 远程按「提供商 + 业务身份」自动识别合并（命中更新、没有的
 * 新增、桌面端实时登录态跳过并说明），不需要文件中转。全部提供商与自定义
 * 提供商定义一并同步（export/import 是全家通吃的，不挑家）。
 *
 * ── 通道选择（两端通用的关键）────────────────────────────────
 * 本机侧一律走 `api_request` 壳命令：桌面端是 Tauri invoke（网关调用自动带
 * 第一把 Key，本机配了 Key 也不会 401）；网页端是 web_shim 的同源 fetch
 * （自动带 Key / 面板会话，401 还有静默续期）。与 logs-panel 的 callAudit
 * 同一手法。
 *
 * 远程侧只能用裸 fetch 跨域调：远程网关的 CORS 是无条件下发
 * `Access-Control-Allow-Origin: *`，且放行 Content-Type / Authorization /
 * x-api-key（见 server/http.rs 的 attach_cors 与 CORS_HEADERS），浏览器跨站
 * 带得了 Key 头、带不了会话 Cookie（`*` 不能与 credentials 连用，Cookie 还有
 * SameSite 拦着）—— 所以开了面板登录的远程必须填一把 API Key，401 的错误
 * 文案照实说。
 *
 * ── 凭证的去留 ──────────────────────────────────────────────
 * 远程地址与 Key 存 localStorage（跨次启动保留）；Key 只随请求发往这里填的
 * 地址。导出载荷内含 accessToken / refreshToken 等凭证 —— 与「导出文件」同一
 * 敏感级，点对点直传（HTTPS / 内网），不落任何中间盘。
 */

import * as React from 'react'
import { Button, Input } from '@ui'
import { shared } from './settings-model'

/** localStorage 键：远程地址与 Key 的持久化（JSON `{url, key}`） */
const STORE_KEY = 'agent2api-remote-sync'

type RemoteSyncConfig = { url: string; key: string }

function readConfig(): RemoteSyncConfig {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Partial<RemoteSyncConfig>
    return {
      url: typeof raw.url === 'string' ? raw.url : '',
      key: typeof raw.key === 'string' ? raw.key : '',
    }
  } catch {
    return { url: '', key: '' }
  }
}

function saveConfig(config: RemoteSyncConfig): void {
  // 存不了（隐私模式等）只影响下次启动，不打断当前操作
  try { localStorage.setItem(STORE_KEY, JSON.stringify(config)) } catch { /* 忽略 */ }
}

/**
 * 地址归一：没写协议补 `http://`（局域网直连最常见的形态；https 地址一般连同
 * 协议一起复制）；去尾斜杠；粘贴成 `…/api` 结尾的把 `/api` 去掉 —— 接口路径
 * 由这里自己拼，多一层会拼出 `/api/api/...`。
 */
export function normalizeBaseUrl(input: string): string {
  let value = input.trim()
  if (!/^https?:\/\//i.test(value)) value = 'http://' + value
  value = value.replace(/\/+$/, '')
  if (/\/api$/i.test(value)) value = value.slice(0, -'/api'.length)
  return value
}

/** rejection 值可能是裸字符串（桌面端没走桥的 asError），统一摘出可读文案 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error ?? '').trim() || '未知错误'
}

/** 管理 API 的 `{ success, data }` 信封（错误时 error 可能是字符串或带 type/message 的对象） */
type Envelope = { success?: boolean; data?: unknown; error?: unknown; message?: unknown; msg?: unknown }

/** 从错误响应里摘可读文案（口径与 notifyApi / web_shim httpCall 一致） */
function remoteDetailOf(payload: Envelope | null, text: string, status: number): string {
  const detail = payload ? (payload.error ?? payload.message ?? payload.msg) : null
  if (typeof detail === 'string' && detail.trim()) return detail
  if (detail && typeof detail === 'object') {
    const record = detail as { message?: unknown; type?: unknown }
    if (typeof record.message === 'string' && record.message.trim()) return record.message
    if (typeof record.type === 'string' && record.type.trim()) return record.type
  }
  return text.trim() || `HTTP ${status}`
}

/** `/api/accounts/import` 的返回（两端同形，见 account_transfer.rs 的 ImportStats） */
type SyncOutcome = {
  total?: number
  added?: number
  updated?: number
  skipped?: number
  failed?: number
  errors?: Array<{ id?: string; message?: string; skipped?: boolean; customProvider?: boolean }>
  customProviders?: { added?: number; updated?: number }
}

/** 一行统计：新增 / 更新 / 跳过 / 失败（数字缺省按 0，别显示 NaN） */
function summarize(outcome: SyncOutcome): string {
  const text = `共 ${outcome.total ?? 0} 条：新增 ${outcome.added ?? 0}、更新 ${outcome.updated ?? 0}`
    + `、跳过 ${outcome.skipped ?? 0}、失败 ${outcome.failed ?? 0}`
  const cp = outcome.customProviders
  if (cp && (cp.added || cp.updated)) {
    return `${text}（自定义提供商定义：新增 ${cp.added ?? 0} 家、更新 ${cp.updated ?? 0} 家）`
  }
  return text
}

/** 失败 / 跳过明细（最多 4 条，其余折叠成计数 —— 整批贴出来会把卡撑爆） */
function detailLines(outcome: SyncOutcome, max = 4): string[] {
  const errors = outcome.errors ?? []
  const lines = errors.slice(0, max).map(item => `· ${item.id || '(无 id)'}：${item.message || ''}`)
  if (errors.length > max) lines.push(`…等共 ${errors.length} 条明细`)
  return lines
}

type Busy = 'test' | 'push' | 'pull' | null
type Feedback = { ok: boolean; text: string }

/** 壳的原始 IPC（局部窄类型 + 转型：各岛的 SharedWindow 声明互不相同，不改对方的） */
type TauriInternals = { invoke?: (cmd: string, args: unknown) => Promise<unknown> }

export function RemoteSyncSection(): React.ReactElement {
  const [url, setUrl] = React.useState<string>(() => readConfig().url)
  const [key, setKey] = React.useState<string>(() => readConfig().key)
  const [busy, setBusy] = React.useState<Busy>(null)
  const [feedback, setFeedback] = React.useState<Feedback | null>(null)

  /** 本机网关调用（api_request 壳命令：桌面 invoke 自动带 Key；网页 shim 同源 fetch） */
  async function callLocal<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const internals = (shared() as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') {
      throw new Error('桌面运行时不可用（Tauri 未初始化）')
    }
    return internals.invoke('api_request', {
      request: { method, path, body: body === undefined ? null : body },
    }) as Promise<T>
  }

  /**
   * 远程调用：裸 fetch 跨域（CORS 由远程网关无条件放行，见文件头）。
   * Key 缺省时不带 —— 远程若没配鉴权照样能通（桌面对桌面的内网形态）。
   */
  async function callRemote<T>(method: 'GET' | 'POST', base: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (key.trim()) headers['x-api-key'] = key.trim()
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let response: Response
    try {
      response = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      // TypeError 不带详情（浏览器安全限制），把常见原因写全让用户自己能对号
      throw new Error('连不上远程面板：' + describeError(error)
        + '（地址不对 / 网络不通 / https 面板连 http 远程被浏览器拦）')
    }
    const text = await response.text()
    let payload: Envelope | null = null
    try { payload = text ? (JSON.parse(text) as Envelope) : null } catch { /* 非 JSON：按原文报错 */ }
    const ok = response.status >= 200 && response.status < 300 && payload?.success !== false
    if (!ok) {
      if (response.status === 401) {
        throw new Error('远程要求鉴权（401）：到远程面板「API Keys」页创建一把 Key 填到上面。'
          + '只开了面板登录、没建 Key 的远程收不了跨站请求 —— 会话 Cookie 无法跨站携带')
      }
      throw new Error(`远程返回错误（HTTP ${response.status}）：${remoteDetailOf(payload, text, response.status)}`)
    }
    return (payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload) as T
  }

  /** 导出载荷是否为空（账号与自定义提供商定义都为 0 = 没东西可传） */
  function isEmptyPayload(payload: { accounts?: unknown[]; customProviders?: unknown[] } | null): boolean {
    return !payload?.accounts?.length && !payload?.customProviders?.length
  }

  async function run(kind: Exclude<Busy, null>): Promise<void> {
    const base = normalizeBaseUrl(url)
    if (!base || base === 'http://') {
      setFeedback({ ok: false, text: '请先填写远程面板地址' })
      return
    }
    setBusy(kind)
    setFeedback(null)
    try {
      if (kind === 'test') {
        await callRemote('GET', base, '/api/session')
        setFeedback({ ok: true, text: `连接成功：${base}` })
        return
      }
      if (kind === 'push') {
        const local = await callLocal<{ accounts?: unknown[]; customProviders?: unknown[] }>(
          'GET',
          '/api/accounts/export',
        )
        if (isEmptyPayload(local)) {
          setFeedback({ ok: false, text: '本机没有可上传的内容（账号与自定义提供商定义都为空）' })
          return
        }
        const outcome = await callRemote<SyncOutcome>('POST', base, '/api/accounts/import', local)
        setFeedback({ ok: true, text: [summarize(outcome), ...detailLines(outcome)].join('\n') })
        return
      }
      // pull：远程导出 → 本机导入（同一套 merge 语义，本机的 id / 优先级口径不变）
      const payload = await callRemote<{ accounts?: unknown[]; customProviders?: unknown[] }>(
        'GET',
        base,
        '/api/accounts/export',
      )
      if (isEmptyPayload(payload)) {
        setFeedback({ ok: false, text: '远程没有可拉取的内容（账号与自定义提供商定义都为空）' })
        return
      }
      const outcome = await callLocal<SyncOutcome>('POST', '/api/accounts/import', payload)
      setFeedback({ ok: true, text: [summarize(outcome), ...detailLines(outcome)].join('\n') })
    } catch (error) {
      setFeedback({ ok: false, text: describeError(error) })
    } finally {
      setBusy(null)
    }
  }

  const locked = busy !== null || !url.trim()

  return (
    <div className='mt-3 rounded-md border border-hairline bg-surface-2 p-3'>
      <div className='text-sm font-medium'>一键绑定远程面板</div>
      <div className='hint mt-1'>
        把本机账号一键上传到远程面板，或从远程拉回来，不用再导文件倒手。远程按
        「提供商 + 业务身份」自动识别：已存在的更新凭证、没有的新增，不会重复堆积；
        全部提供商与自定义提供商定义一并同步。本机客户端「实时登录态」账号不随同步迁移
        （会列在跳过明细里，远程侧要用「导入桌面端登录态」重新读取）。
      </div>
      <div className='mt-2 flex flex-col gap-2 sm:flex-row'>
        <Input
          id='remote-sync-url'
          className='sm:flex-1'
          placeholder='远程面板地址，如 https://panel.example.com'
          value={url}
          onChange={event => { setUrl(event.target.value); saveConfig({ url: event.target.value, key }) }}
        />
        <Input
          id='remote-sync-key'
          className='sm:w-[280px]'
          placeholder='远程 API Key（远程开启鉴权时必填）'
          value={key}
          onChange={event => { setKey(event.target.value); saveConfig({ url, key: event.target.value }) }}
        />
      </div>
      <div className='mt-2 flex flex-wrap gap-2'>
        <Button
          id='btn-remote-sync-test'
          variant='outline'
          disabled={busy !== null || !url.trim()}
          onClick={() => void run('test')}
        >
          {busy === 'test' ? '测试中…' : '测试连接'}
        </Button>
        <Button
          id='btn-remote-sync-push'
          variant='default'
          disabled={locked}
          onClick={() => void run('push')}
        >
          {busy === 'push' ? '上传中…' : '一键上传到远程'}
        </Button>
        <Button
          id='btn-remote-sync-pull'
          variant='outline'
          disabled={locked}
          onClick={() => void run('pull')}
        >
          {busy === 'pull' ? '拉取中…' : '从远程拉取'}
        </Button>
      </div>
      <div className='hint mt-2'>
        Key 只存本机（浏览器存储），仅随请求发送到上面填写的远程地址；在远程面板的
        「API Keys」页创建。浏览器端打开的 https 面板连 http 远程会被浏览器拦下，桌面端不受限。
      </div>
      {feedback ? (
        <div
          className={
            'mt-2 rounded-md border px-3 py-2 text-[12px] leading-[1.7] whitespace-pre-line '
            + (feedback.ok
              ? 'border-hairline bg-surface-inset text-subtle'
              : 'border-destructive-bd bg-destructive-soft text-destructive')
          }
        >
          {feedback.text}
        </div>
      ) : null}
    </div>
  )
}
