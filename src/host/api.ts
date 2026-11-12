/**
 * The plugin's settings API, served from two places:
 *
 * 1. the DSH Host listener (desktop shell and any same-machine browser), after
 *    the connection fence — this is how the desktop settings page reaches it;
 * 2. this plugin's own listener, after the plugin session check — this is how a
 *    remote browser that reached the DSH page through the entry configures the
 *    plugin it is already using.
 *
 * Both mounts share this one implementation; only their admission differs.
 */
import { networkInterfaces } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { API_PREFIX } from '../shared.ts'
import { pickWindowsDirectory, type NativePickResult } from './native-pick.ts'
import type { RemoteAccessServer, RemoteStatus } from './server.ts'

/** Absolute path of the settings API on both mounts. */
export { API_PREFIX }
const MAX_JSON_BYTES = 64 * 1024

/**
 * Which mount is serving this request. The settings API is mounted twice:
 * the DSH Host listener (same machine, behind the connection fence) and the
 * plugin's own listener (a remote browser behind the plugin session).
 */
export interface ApiMount {
  /**
   * The Windows system chooser belongs to the machine's display, not to a
   * remote browser: only the Host mount offers it (the remote mount answers
   * 404 so a stale or hand-made request cannot pop a dialog on the host).
   */
  readonly nativePick: boolean
  /** Chooser implementation; tests replace it. */
  readonly pickDirectory?: () => Promise<NativePickResult>
}

/** One selectable listen address. */
export interface HostOption {
  readonly value: string
  readonly label: string
  readonly family: 'IPv4' | 'IPv6'
  readonly internal: boolean
}

/** One reachable URL for the current listeners. */
export interface AccessAddress {
  readonly url: string
  readonly label: string
  readonly kind: 'loopback' | 'lan' | 'any'
}

/** Write one JSON response. */
export function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_JSON_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) { resolve({}); return }
      try {
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new Error('请求体必须是 JSON 对象'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    request.on('error', reject)
  })
}

/** JSON body gate: a plain-text cross-site POST never reaches a mutating route. */
function requireJson(request: IncomingMessage): boolean {
  const media = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  return media === 'application/json'
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function asHosts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** IPv4 interfaces of this machine, in OS order. */
function listIpv4(): { address: string; name: string; internal: boolean }[] {
  const out: { address: string; name: string; internal: boolean }[] = []
  for (const [name, items] of Object.entries(networkInterfaces())) {
    for (const item of items ?? []) {
      // Node 18+ reports the string family; older releases used 4.
      if (item.family !== 'IPv4' && (item.family as unknown) !== 4) continue
      out.push({ address: item.address, name, internal: item.internal })
    }
  }
  return out
}

/** Every address the operator can pick as a listen target. */
function availableHosts(): HostOption[] {
  const options: HostOption[] = [
    { value: '0.0.0.0', label: '所有 IPv4 网卡', family: 'IPv4', internal: false },
  ]
  const seen = new Set<string>()
  for (const nic of listIpv4()) {
    if (seen.has(nic.address)) continue
    seen.add(nic.address)
    options.push({
      value: nic.address,
      label: nic.internal ? `本机回环 ${nic.address}` : `${nic.name} ${nic.address}`,
      family: 'IPv4',
      internal: nic.internal,
    })
  }
  return options
}

/** Every URL the current listeners actually answer on. */
function accessAddresses(status: RemoteStatus): AccessAddress[] {
  const port = status.port
  const lan = listIpv4().filter(nic => !nic.internal)
  const out: AccessAddress[] = []
  const seen = new Set<string>()
  const push = (url: string, label: string, kind: AccessAddress['kind']): void => {
    if (seen.has(url)) return
    seen.add(url)
    out.push({ url, label, kind })
  }
  for (const host of status.hosts) {
    if (host === '0.0.0.0' || host === '::') {
      push(`http://127.0.0.1:${String(port)}`, '本机', 'loopback')
      for (const nic of lan) push(`http://${nic.address}:${String(port)}`, nic.name, 'lan')
    } else if (host === '127.0.0.1' || host === '::1') {
      push(`http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${String(port)}`, '本机', 'loopback')
    } else {
      push(`http://${host.includes(':') ? `[${host}]` : host}:${String(port)}`, '监听地址', 'lan')
    }
  }
  return out
}

/** View model the settings page renders. */
export interface StateView {
  readonly status: RemoteStatus
  /** Loopback entrance, always reachable on this machine. */
  readonly localUrl: string
  /** Advertised external entrance; empty until configured. */
  readonly publicUrl: string
  /** Every URL the current listeners answer on. */
  readonly addresses: readonly AccessAddress[]
  /** Every address the operator can pick as a listen target. */
  readonly availableHosts: readonly HostOption[]
}

/** Build the current view for the settings page. */
export function stateView(server: RemoteAccessServer): StateView {
  const status = server.status()
  return {
    status,
    localUrl: `http://127.0.0.1:${String(status.port)}`,
    publicUrl: status.publicUrl,
    addresses: accessAddresses(status),
    availableHosts: availableHosts(),
  }
}

/**
 * Dispatch one settings request. Admission has already happened at the mount.
 * @param server - the listener whose state is being read or changed.
 * @param request - the incoming request.
 * @param response - the response to own.
 */
export async function handleApi(
  server: RemoteAccessServer,
  request: IncomingMessage,
  response: ServerResponse,
  mount: ApiMount = { nativePick: false },
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname.slice(API_PREFIX.length) || '/'
  try {
    if (request.method === 'GET' && path === '/state') {
      writeJson(response, 200, stateView(server))
      return
    }
    if (request.method === 'POST' && path === '/config') {
      if (!requireJson(request)) { writeJson(response, 415, { error: 'content-type must be application/json' }); return }
      const body = await readJson(request)
      const result = await server.configure({
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        hosts: asHosts(body.hosts),
        port: asInt(body.port),
        sessionDays: asInt(body.sessionDays),
        publicUrl: asString(body.publicUrl),
      })
      if (!result.ok) writeJson(response, 400, { ok: false, error: result.error })
      else writeJson(response, 200, { ok: true, ...stateView(server) })
      return
    }
    if (request.method === 'POST' && path === '/password') {
      if (!requireJson(request)) { writeJson(response, 415, { error: 'content-type must be application/json' }); return }
      const body = await readJson(request)
      const result = await server.setPassword(asString(body.next) ?? '')
      if (!result.ok) writeJson(response, 400, { ok: false, error: result.error })
      else writeJson(response, 200, { ok: true, ...stateView(server) })
      return
    }
    if (request.method === 'POST' && path === '/pick-directory') {
      if (!mount.nativePick) {
        // 公开监听器上没有这个能力：对话框属于 Host 的屏幕，远端调用没有意义。
        writeJson(response, 404, { error: 'not found' })
        return
      }
      if (!requireJson(request)) { writeJson(response, 415, { error: 'content-type must be application/json' }); return }
      try {
        const result = await (mount.pickDirectory ?? (() => pickWindowsDirectory()))()
        writeJson(response, 200, { ok: true, path: result.path })
      } catch (error) {
        writeJson(response, 501, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    writeJson(response, 404, { error: 'not found' })
  } catch (error) {
    writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}
