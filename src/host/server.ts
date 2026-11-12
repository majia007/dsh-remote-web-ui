/**
 * The remote Web UI listener: its own login, its own session cookie, and a
 * reverse proxy onto the loopback DSH Host.
 *
 * Lifecycle contract: `start()` never throws past a recorded `lastError` — a
 * port already in use must not take the DSH Host down with it. The listener is
 * plain HTTP on loopback; TLS (if any) belongs to whatever forwards to it,
 * which is why the session cookie is deliberately not marked `Secure`.
 */
import http from 'node:http'
import type { Duplex } from 'node:stream'
import { createSecret, hashPassword, LoginThrottle, signSession, verifyPassword, verifySession } from './auth.ts'
import { API_PREFIX, handleApi } from './api.ts'
import { renderLoginPage } from './login-page.ts'
import { forwardHttp, forwardUpgrade, type ProxyTarget } from './proxy.ts'
import { normalizeState, readState, writeState, type RemoteAccessState } from './state.ts'

/** Cookie carrying this plugin's own session (never the DSH Host cookie). */
const COOKIE_NAME = 'dsh-remote-web-ui'
const LOGIN_PATH = '/__remote/login'
const LOGOUT_PATH = '/__remote/logout'
const HEALTH_PATH = '/__remote/health'
const MIN_PASSWORD_LENGTH = 8
const MAX_FORM_BYTES = 64 * 1024
/** How long one minted upstream cookie is reused before minting again. */
const UPSTREAM_COOKIE_TTL_MS = 300_000

/** Host-side facilities this listener needs. */
export interface RemoteServerOptions {
  /** Current loopback port of the DSH Host, undefined before it listens. */
  internalPort(): number | undefined
  /** Authenticated launch URL for one loopback port. */
  authenticatedUrl(port: number): string
  /** Diagnostic sink; never receives form values. */
  log(message: string): void
}

/** Everything the settings page renders about the listener. */
export interface RemoteStatus {
  readonly listening: boolean
  /** 开关状态（操作者意图）；端口被占时它仍是 true，而 `listening` 为 false。 */
  readonly enabled: boolean
  readonly hosts: readonly string[]
  readonly port: number
  readonly error: string | undefined
  readonly hasPassword: boolean
  readonly sessionDays: number
  readonly publicUrl: string
}

/** Result of a settings mutation. */
export type MutationResult = { readonly ok: true; readonly status: RemoteStatus } | { readonly ok: false; readonly error: string }

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Only same-origin relative paths are accepted as post-login destinations. */
function safeNext(value: string | null): string | undefined {
  if (value === null || value.length === 0) return undefined
  if (!value.startsWith('/') || value.startsWith('//')) return undefined
  return value
}

function readForm(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_FORM_BYTES) {
        reject(new Error('form body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    request.on('error', reject)
  })
}

/** Bracketed form of an address literal for use inside a URL. */
function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

/** Set equality for listen addresses. */
function sameHosts(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((host, index) => host === b[index])
}

/** The listener, its state, and its throttling. */
export class RemoteAccessServer {
  private state: RemoteAccessState
  private servers: http.Server[] = []
  private readonly throttle = new LoginThrottle()
  private upstream: { port: number; cookie: string; at: number } | undefined
  private lastError: string | undefined
  /** Pending rebind after a settings response has been flushed. */
  private rebindTimer: NodeJS.Timeout | undefined

  private readonly options: RemoteServerOptions

  /** @param options - Host facilities; read lazily so a late Host listener is picked up. */
  constructor(options: RemoteServerOptions) {
    this.options = options
    this.state = readState()
  }

  /** Current persisted state (read-only view). */
  getState(): RemoteAccessState {
    return this.state
  }

  /** Renderable status for the settings page. */
  status(): RemoteStatus {
    return {
      listening: this.servers.length > 0,
      enabled: this.state.enabled,
      hosts: this.state.hosts,
      port: this.state.port,
      error: this.lastError,
      hasPassword: this.state.auth !== null,
      sessionDays: this.state.sessionDays,
      publicUrl: this.state.publicUrl,
    }
  }

  /**
   * Bind the configured port. A failure is recorded and leaves the DSH Host
   * untouched; callers re-read {@link status} instead of catching.
   * @returns settlement after a successful bind or a recorded failure.
   */
  async start(): Promise<void> {
    this.options.log('start requested')
    await this.stop()
    this.state = readState()
    // 两道门：开关没开不监听；没有密码也绝不监听——密码是这个入口唯一的
    // 防线，手改状态文件把 enabled 写成 true 的情况在这里兜住。
    if (!this.state.enabled) {
      this.lastError = undefined
      this.options.log('disabled: not listening')
      return
    }
    if (this.state.auth === null) {
      this.lastError = '尚未设置访问密码'
      this.options.log('no password: not listening')
      return
    }
    const port = this.state.port
    const created: http.Server[] = []
    const failures: string[] = []
    for (const host of this.state.hosts) {
      this.options.log(`binding http://${urlHost(host)}:${String(port)}`)
      const server = http.createServer((request, response) => { void this.handleRequest(request, response) })
      server.on('upgrade', (request, socket, head) => { void this.handleUpgrade(request, socket, head) })
      server.on('error', (error: Error) => {
        this.lastError = error.message
        this.options.log(`listener error: ${error.message}`)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            server.off('listening', onListening)
            reject(error)
          }
          const onListening = (): void => {
            server.off('error', onError)
            resolve()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(port, host)
        })
        created.push(server)
        this.options.log(`listening on http://${urlHost(host)}:${String(port)}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${host}: ${message}`)
        this.options.log(`cannot listen on ${host}:${String(port)}: ${message}`)
        server.close()
      }
    }
    this.servers = created
    this.lastError = failures.length > 0 ? failures.join('; ') : undefined
  }

  /**
   * Close every listener and every open connection. `closeAllConnections` is
   * required because SSE and WebSocket sockets never end on their own.
   * @returns settlement after all sockets are released.
   */
  async stop(): Promise<void> {
    if (this.rebindTimer !== undefined) {
      clearTimeout(this.rebindTimer)
      this.rebindTimer = undefined
    }
    const servers = this.servers
    this.servers = []
    this.upstream = undefined
    if (servers.length === 0) return
    await Promise.all(servers.map(server => new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
    })))
  }

  /**
   * Persist a settings change; a port change rebinds the listener.
   * @param patch - partial settings.
   * @returns the new status or a validation error.
   */
  async configure(patch: { enabled?: boolean; hosts?: readonly string[]; port?: number; sessionDays?: number; publicUrl?: string }): Promise<MutationResult> {
    if (patch.enabled === true && this.state.auth === null) {
      return { ok: false, error: '请先设置访问密码' }
    }
    if (patch.hosts !== undefined) {
      if (patch.hosts.length === 0) return { ok: false, error: '至少选择一个监听地址' }
      if (patch.hosts.some(host => host.trim().length === 0 || host.length > 64 || /[\s/]/.test(host))) {
        return { ok: false, error: '监听地址不合法' }
      }
    }
    if (patch.port !== undefined && (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535)) {
      return { ok: false, error: '端口必须是 1-65535 的整数' }
    }
    if (patch.sessionDays !== undefined && (!Number.isInteger(patch.sessionDays) || patch.sessionDays < 1 || patch.sessionDays > 365)) {
      return { ok: false, error: '会话有效期必须是 1-365 天' }
    }
    const rebind = (patch.enabled !== undefined && patch.enabled !== this.state.enabled)
      || (patch.port !== undefined && patch.port !== this.state.port)
      || (patch.hosts !== undefined && !sameHosts(patch.hosts, this.state.hosts))
    this.state = normalizeState({
      ...this.state,
      ...patch.enabled === undefined ? {} : { enabled: patch.enabled },
      ...patch.hosts === undefined ? {} : { hosts: patch.hosts },
      ...patch.port === undefined ? {} : { port: patch.port },
      ...patch.sessionDays === undefined ? {} : { sessionDays: patch.sessionDays },
      ...patch.publicUrl === undefined ? {} : { publicUrl: patch.publicUrl },
    })
    try {
      writeState(this.state)
    } catch (error) {
      return { ok: false, error: `保存失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (rebind) this.scheduleRebind()
    return { ok: true, status: this.status() }
  }

  /**
   * Rebind after the current response is flushed. Closing the listener while
   * this very request is still writing would drop the answer the settings page
   * is waiting for, so the rebind is deferred one tick.
   */
  private scheduleRebind(): void {
    if (this.rebindTimer !== undefined) clearTimeout(this.rebindTimer)
    this.rebindTimer = setTimeout(() => {
      this.rebindTimer = undefined
      void this.start()
    }, 50)
  }

  /**
   * Set or replace the access password. Admission already happened at the
   * mount, so no previous password is required; every change rotates the
   * signing secret and the session version, so all previously issued sessions
   * stop verifying.
   * @param next - new password.
   * @returns success with the new status, or a user-facing error.
   */
  async setPassword(next: string): Promise<MutationResult> {
    if (next.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, error: `密码至少 ${String(MIN_PASSWORD_LENGTH)} 位` }
    }
    const auth = this.state.auth
    const { salt, hash } = await hashPassword(next)
    this.state = {
      ...this.state,
      auth: { salt, hash, secret: createSecret(), version: (auth?.version ?? 0) + 1 },
    }
    try {
      writeState(this.state)
    } catch (error) {
      return { ok: false, error: `保存失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, status: this.status() }
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://remote.invalid')
      if (url.pathname.startsWith('/__remote/')) {
        this.options.log(`route ${request.method ?? ''} ${url.pathname}${url.search}`)
      }
      if (url.pathname === HEALTH_PATH) {
        this.json(response, 200, { ok: true, hasPassword: this.state.auth !== null })
        return
      }
      if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
        // Reached through the remote entry: the caller already passed the
        // plugin login, so it may read and change this plugin's settings.
        if (!this.authenticated(request)) {
          this.text(response, 401, 'unauthorized')
          return
        }
        await handleApi(this, request, response, { nativePick: false })
        return
      }
      if (url.pathname === LOGIN_PATH) {
        await this.handleLogin(request, response, url)
        return
      }
      if (url.pathname === LOGOUT_PATH) {
        await this.handleLogout(request, response)
        return
      }
      if (!this.authenticated(request)) {
        this.options.log(`unauthorized ${request.method} ${url.pathname} cookie=${request.headers.cookie === undefined ? 'none' : 'present'}`)
        this.redirect(response, `${LOGIN_PATH}?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`)
        return
      }
      const target = await this.resolveTarget()
      if (target === undefined) {
        this.text(response, 503, '本地 DSH 尚未就绪')
        return
      }
      forwardHttp(request, response, target)
    } catch (error) {
      this.options.log(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) this.text(response, 500, 'internal error')
      else response.destroy()
    }
  }

  private async handleLogin(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const auth = this.state.auth
    if (request.method === 'GET') {
      this.html(response, 200, renderLoginPage({
        configured: auth !== null,
        next: safeNext(url.searchParams.get('next')),
      }))
      return
    }
    if (request.method !== 'POST') {
      this.text(response, 405, 'method not allowed')
      return
    }
    const client = request.socket.remoteAddress ?? 'unknown'
    const wait = this.throttle.retryAfter(client)
    if (wait > 0) {
      this.html(response, 429, renderLoginPage({
        configured: auth !== null,
        error: `尝试过于频繁，请 ${String(wait)} 秒后再试`,
      }))
      return
    }
    if (auth === null) {
      this.html(response, 503, renderLoginPage({ configured: false, error: '尚未设置访问密码' }))
      return
    }
    const form = new URLSearchParams(await readForm(request))
    const password = form.get('password') ?? ''
    const next = safeNext(form.get('next'))
    if (!await verifyPassword(password, auth.salt, auth.hash)) {
      this.throttle.recordFailure(client)
      this.options.log(`login rejected ${client} version=${String(auth.version)}`)
      this.html(response, 401, renderLoginPage({ configured: true, error: '密码错误', next }))
      return
    }
    this.throttle.clear(client)
    const days = this.state.sessionDays
    const expiresAt = Date.now() + days * 86_400_000
    this.options.log(`login accepted ${client} version=${String(auth.version)} next=${next ?? '/'}`)
    response.writeHead(303, {
      location: next ?? '/',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'set-cookie': `${COOKIE_NAME}=${signSession(auth.secret, expiresAt, auth.version)}`
        + `; Path=/; Max-Age=${String(days * 86_400)}; HttpOnly; SameSite=Lax`,
    })
    response.end()
  }

  private async handleLogout(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      this.text(response, 405, 'method not allowed')
      return
    }
    response.writeHead(303, {
      location: LOGIN_PATH,
      'cache-control': 'no-store',
      'set-cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    })
    response.end()
  }

  private async handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!this.authenticated(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const target = await this.resolveTarget()
    if (target === undefined) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    forwardUpgrade(request, socket, head, target)
  }

  private authenticated(request: http.IncomingMessage): boolean {
    const auth = this.state.auth
    if (auth === null) return false
    const raw = cookieValue(request.headers.cookie, COOKIE_NAME)
    if (raw === undefined) return false
    const session = verifySession(raw, auth.secret, Date.now())
    return session !== undefined && session.pv === auth.version
  }

  /** Mint (or reuse) the DSH Host's own browser cookie for the current loopback port. */
  private async resolveTarget(): Promise<ProxyTarget | undefined> {
    const port = this.options.internalPort()
    if (port === undefined || port <= 0) return undefined
    const cached = this.upstream
    if (cached !== undefined && cached.port === port && Date.now() - cached.at < UPSTREAM_COOKIE_TTL_MS) {
      return { port, cookie: cached.cookie }
    }
    const response = await fetch(this.options.authenticatedUrl(port), { redirect: 'manual' })
    const all = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    const raw = all[0] ?? response.headers.get('set-cookie') ?? ''
    await response.body?.cancel().catch(() => undefined)
    const cookie = raw.split(';', 1)[0]?.trim() ?? ''
    if (cookie.length === 0) throw new Error('DSH Host did not return an authentication cookie')
    this.upstream = { port, cookie, at: Date.now() }
    return { port, cookie }
  }

  private json(response: http.ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  private text(response: http.ServerResponse, status: number, body: string): void {
    response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  private html(response: http.ServerResponse, status: number, body: string): void {
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    response.end(body)
  }

  private redirect(response: http.ServerResponse, location: string): void {
    response.writeHead(302, { location, 'cache-control': 'no-store' })
    response.end()
  }
}
