/**
 * Remote access settings page.
 *
 * Rendered as one Web Settings section (`settings.section`). Every value comes
 * from `/remote-web-ui/api` on the origin it was loaded from: the DSH Host
 * origin in the desktop shell, or the plugin's own entry origin in a remote
 * browser. Both mounts share one implementation on the Host.
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import css from './SettingsTab.module.css'

const MIN_PASSWORD_LENGTH = 8

/** One selectable listen address. */
interface HostOption {
  value: string
  label: string
  family: 'IPv4' | 'IPv6'
  internal: boolean
}

/** One reachable URL for the current listeners. */
interface AccessAddress {
  url: string
  label: string
  kind: 'loopback' | 'lan' | 'any'
}

/** Mirror of the Host half's status payload. */
interface RemoteStatus {
  listening: boolean
  /** 开关状态；端口被占时它仍是 true，而 `listening` 为 false。 */
  enabled: boolean
  hosts: string[]
  port: number
  error?: string
  hasPassword: boolean
  sessionDays: number
  publicUrl: string
}

/** Mirror of the Host half's state payload. */
interface StateView {
  status: RemoteStatus
  localUrl: string
  publicUrl: string
  addresses: AccessAddress[]
  availableHosts: HostOption[]
}

/** Either a refreshed state or a user-facing failure. */
type MutationView = ({ ok: true } & StateView) | { ok: false; error: string }

/** Registration-side API surface injected as props. */
export interface SettingsTabInjected {
  t: (key: string, params?: Record<string, unknown>) => string
  load: () => Promise<StateView>
  configure: (patch: { enabled?: boolean; hosts?: string[]; port?: number; sessionDays?: number; publicUrl?: string }) => Promise<MutationView>
  setPassword: (next: string) => Promise<MutationView>
}

/** Full props assembled by the settings slot renderer. */
export type SettingsTabProps = SettingsTabInjected

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Surface the upstream error text when the body carries one. */
function messageOf(value: unknown, status: number): string {
  if (typeof value === 'object' && value !== null && 'error' in value) {
    const error = (value as { error?: unknown }).error
    if (typeof error === 'string' && error.length > 0) return error
  }
  return `HTTP ${String(status)}`
}

/** Call one settings route on the current origin. */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/remote-web-ui/api${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...init,
  })
  const body = await readJson(response)
  if (!response.ok) throw new Error(messageOf(body, response.status))
  return body
}

/**
 * Copy through the async clipboard, falling back to the legacy selection
 * command: a plain-HTTP entry is not a secure context, where `navigator.clipboard`
 * is unavailable.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

/** Small copy glyph. */
function CopyIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

/** Render the remote Web UI settings page. */
export function RemoteAccessSection({ t, load, configure, setPassword }: SettingsTabProps): ReactNode {
  const baseId = useId()
  const [view, setView] = useState<StateView | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<Notice>(undefined)
  const [busy, setBusy] = useState<'config' | 'password' | 'service' | undefined>(undefined)
  const [copied, setCopied] = useState<string | undefined>(undefined)

  const [hosts, setHosts] = useState<string[]>([])
  const [port, setPort] = useState('')
  const [sessionDays, setSessionDays] = useState('')
  const [publicUrl, setPublicUrl] = useState('')
  const [nextPassword, setNextPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)

  const apply = (next: StateView): void => {
    setView(next)
    setHosts([...next.status.hosts])
    setPort(String(next.status.port))
    setSessionDays(String(next.status.sessionDays))
    setPublicUrl(next.publicUrl)
  }

  useEffect(() => {
    let live = true
    void load().then(
      (next) => { if (live) { apply(next); setLoadError(undefined) } },
      (error: unknown) => { if (live) setLoadError(error instanceof Error ? error.message : String(error)) },
    )
    return () => { live = false }
  }, [load])

  /**
   * 重绑是宿主延后一个 tick 做的（响应必须先写完），所以变更响应里的
   * `listening` / `addresses` 还是重绑前的快照。轮询到 `listening` 与开关
   * 一致为止，最多 2 秒；只更新视图，不碰用户正在编辑的输入框。
   */
  const settle = (wantEnabled: boolean): void => {
    const deadline = Date.now() + 2000
    const tick = (): void => {
      void load().then((fresh) => {
        setView(fresh)
        if (fresh.status.listening === wantEnabled || Date.now() > deadline) return
        window.setTimeout(tick, 150)
      }, () => undefined)
    }
    window.setTimeout(tick, 200)
  }

  const saved = (next: MutationView, okText: string): void => {
    if (next.ok) {
      apply({ status: next.status, localUrl: next.localUrl, publicUrl: next.publicUrl, addresses: next.addresses, availableHosts: next.availableHosts })
      setNotice({ kind: 'ok', text: okText })
      setNextPassword('')
      setPasswordVisible(false)
      settle(next.status.enabled)
    } else {
      setNotice({ kind: 'error', text: next.error })
    }
  }

  /**
   * `0.0.0.0` already covers every IPv4 interface, so selecting it excludes
   * concrete addresses and vice versa — listening on both would collide.
   */
  const toggleHost = (value: string): void => {
    setHosts((current) => {
      if (current.includes(value)) {
        const next = current.filter(host => host !== value)
        return next.length > 0 ? next : current
      }
      if (value === '0.0.0.0') return ['0.0.0.0']
      return [...current.filter(host => host !== '0.0.0.0'), value]
    })
  }

  const submitConfig = (): void => {
    const parsedPort = Number(port)
    const parsedDays = Number(sessionDays)
    setBusy('config')
    setNotice(undefined)
    void configure({
      hosts,
      port: Number.isInteger(parsedPort) ? parsedPort : undefined,
      sessionDays: Number.isInteger(parsedDays) ? parsedDays : undefined,
      publicUrl,
    }).then(
      next => { saved(next, t('saved')) },
      (error: unknown) => { setNotice({ kind: 'error', text: t('requestFailed', { error: error instanceof Error ? error.message : String(error) }) }) },
    ).finally(() => { setBusy(undefined) })
  }

  const submitPassword = (): void => {
    if (nextPassword.length < MIN_PASSWORD_LENGTH) {
      setNotice({ kind: 'error', text: t('passwordTooShort', { min: String(MIN_PASSWORD_LENGTH) }) })
      return
    }
    setBusy('password')
    setNotice(undefined)
    void setPassword(nextPassword).then(
      next => { saved(next, t('saved')) },
      (error: unknown) => { setNotice({ kind: 'error', text: t('requestFailed', { error: error instanceof Error ? error.message : String(error) }) }) },
    ).finally(() => { setBusy(undefined) })
  }

  /**
   * 开关服务。没有密码时宿主会拒绝启用（密码是这个入口唯一的防线），这里先拦
   * 一次：省一次往返，也能立刻说清为什么点不动。
   */
  const toggleService = (next: boolean): void => {
    if (next && view?.status.hasPassword !== true) {
      setNotice({ kind: 'error', text: t('passwordRequired') })
      return
    }
    setBusy('service')
    setNotice(undefined)
    void configure({ enabled: next }).then(
      result => { saved(result, t('saved')) },
      (error: unknown) => { setNotice({ kind: 'error', text: t('requestFailed', { error: error instanceof Error ? error.message : String(error) }) }) },
    ).finally(() => { setBusy(undefined) })
  }

  const copy = (url: string): void => {
    void copyText(url).then((ok) => {
      if (!ok) { setNotice({ kind: 'error', text: t('copyFailed') }); return }
      setCopied(url)
      setTimeout(() => { setCopied(current => current === url ? undefined : current) }, 1800)
    })
  }

  const status = view?.status
  const anySelected = hosts.includes('0.0.0.0')

  // 监听地址与外部地址共用同一行结构：地址、类型标签、复制按钮。
  // 外部地址不是监听器，只是展示事实，所以排最后，监听关闭时照样显示。
  const addressRows: { url: string; kindLabel: string }[] = (view?.addresses ?? []).map(entry => ({
    url: entry.url,
    kindLabel: entry.kind === 'loopback' ? t('loopback') : t('lan'),
  }))
  if (view !== undefined && view.publicUrl !== '') {
    addressRows.push({ url: view.publicUrl, kindLabel: t('externalUrl') })
  }

  return (
    <div className={css.section}>
      <header className={css.header}>
        <h3 className={css.title}>{t('title')}</h3>
        <p className={css.subtitle}>{t('subtitle')}</p>
      </header>

      {loadError !== undefined ? (
        <p className={css.statusError} role="alert">{t('loadFailed', { error: loadError })}</p>
      ) : null}

      {view !== undefined ? (
        <div className={css.statusBlock}>
          <p className={css.statusRow}>
            <span className={view.status.listening ? css.dotOn : css.dotOff} aria-hidden="true" />
            <span data-remote-listening={view.status.listening ? 'true' : 'false'}>
              {view.status.listening
                ? t('statusListening')
                : view.status.enabled ? t('statusStopped') : t('statusOff')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={view.status.enabled}
              aria-label={t('serviceToggle')}
              className={css.switch}
              disabled={busy !== undefined}
              onClick={() => { toggleService(!view.status.enabled) }}
            >
              <span className={css.switchKnob} aria-hidden="true" />
            </button>
          </p>
          {view.status.error === undefined ? null : (
            <p className={css.statusError} role="alert">{t('statusError', { error: view.status.error })}</p>
          )}
          {view.status.hasPassword ? null : (
            <p className={css.statusWarn} role="status">{t('statusNoPassword')}</p>
          )}
          <ul className={css.addresses}>
            {addressRows.map(row => (
              <li key={row.url} className={css.addressRow}>
                <code className={css.addressUrl}>{row.url}</code>
                <span className={css.addressKind}>{row.kindLabel}</span>
                <button
                  type="button"
                  className={css.copy}
                  title={t('copy')}
                  aria-label={t('copy')}
                  onClick={() => { copy(row.url) }}
                >
                  {copied === row.url ? <span className={css.copied}>{t('copied')}</span> : <CopyIcon />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className={css.card} aria-labelledby={`${baseId}-config`}>
        <h4 className={css.cardTitle} id={`${baseId}-config`}>{t('listenHost')}</h4>
        <div className={css.field}>
          <span className={css.label}>{t('listenHost')}</span>
          <div className={css.hostList}>
            {(view?.availableHosts ?? []).map(option => {
              const checked = hosts.includes(option.value)
              const conflict = anySelected && option.value !== '0.0.0.0'
              return (
                <label key={option.value} className={conflict ? `${css.hostOption} ${css.hostOptionMuted}` : css.hostOption}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={conflict}
                    onChange={() => { toggleHost(option.value) }}
                  />
                  <span className={css.hostLabel}>{option.label}</span>
                  <code className={css.hostValue}>{option.value}</code>
                </label>
              )
            })}
          </div>
          <p className={css.hint}>{t('listenHostHint')}</p>
        </div>
        <div className={css.field}>
          <label className={css.label} htmlFor={`${baseId}-port`}>{t('port')}</label>
          <input
            id={`${baseId}-port`}
            className={css.input}
            inputMode="numeric"
            value={port}
            onChange={(event) => { setPort(event.currentTarget.value) }}
          />
          <p className={css.hint}>{t('portHint')}</p>
        </div>
        <div className={css.field}>
          <label className={css.label} htmlFor={`${baseId}-days`}>{t('sessionDays')}</label>
          <input
            id={`${baseId}-days`}
            className={css.input}
            inputMode="numeric"
            value={sessionDays}
            onChange={(event) => { setSessionDays(event.currentTarget.value) }}
          />
          <p className={css.hint}>{t('sessionDaysHint')}</p>
        </div>
        <div className={css.field}>
          <label className={css.label} htmlFor={`${baseId}-public`}>{t('externalUrl')}</label>
          <input
            id={`${baseId}-public`}
            className={css.input}
            placeholder="https://dsh.example.com"
            value={publicUrl}
            onChange={(event) => { setPublicUrl(event.currentTarget.value) }}
          />
          <p className={css.hint}>{t('externalUrlHint')}</p>
        </div>
        <button type="button" className={css.primary} disabled={busy !== undefined} onClick={submitConfig}>
          {busy === 'config' ? t('saving') : t('save')}
        </button>
      </section>

      <section className={css.card} aria-labelledby={`${baseId}-password`}>
        <div className={css.cardTitleRow}>
          <h4 className={css.cardTitle} id={`${baseId}-password`}>{t('passwordTitle')}</h4>
          <span className={status?.hasPassword === true ? css.badgeOn : css.badgeOff}>
            {status?.hasPassword === true ? t('passwordSet') : t('passwordUnset')}
          </span>
        </div>
        <div className={css.field}>
          <label className={css.label} htmlFor={`${baseId}-next`}>{t('nextPassword')}</label>
          <div className={css.passwordRow}>
            <input
              id={`${baseId}-next`}
              className={css.input}
              type={passwordVisible ? 'text' : 'password'}
              autoComplete="new-password"
              value={nextPassword}
              onChange={(event) => { setNextPassword(event.currentTarget.value) }}
            />
            <button
              type="button"
              className={css.eye}
              onClick={() => { setPasswordVisible(value => !value) }}
              aria-label={passwordVisible ? t('hidePassword') : t('showPassword')}
            >
              {passwordVisible ? t('hidePassword') : t('showPassword')}
            </button>
          </div>
          <p className={css.hint}>{t('passwordHint', { min: String(MIN_PASSWORD_LENGTH) })}</p>
        </div>
        <button type="button" className={css.primary} disabled={busy !== undefined} onClick={submitPassword}>
          {busy === 'password' ? t('saving') : t('setPassword')}
        </button>
      </section>

      {notice === undefined ? null : (
        <p className={notice.kind === 'ok' ? css.noticeOk : css.noticeError} role={notice.kind === 'ok' ? 'status' : 'alert'}>
          {notice.text}
        </p>
      )}
    </div>
  )
}

/** Build the API client bound to this page's origin. */
export function createApi() {
  return {
    load: async (): Promise<StateView> => await request('/state') as StateView,
    configure: async (patch: { enabled?: boolean; hosts?: string[]; port?: number; sessionDays?: number; publicUrl?: string }): Promise<MutationView> => {
      const body = await request('/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      return body as MutationView
    },
    setPassword: async (next: string): Promise<MutationView> => {
      const body = await request('/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ next }),
      })
      return body as MutationView
    },
  }
}
