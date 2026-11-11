/**
 * Persistent settings and credentials for the remote Web UI listener.
 *
 * Deliberately NOT a plugin `Config`: this package's host half must stay
 * dependency-free (a schemastery Config would drag the harness's internal
 * config library, and with it a vendored build of cordis, into the bundle).
 * The file lives next to the other DSH state so it survives plugin upgrades
 * and is intentionally excluded from the DSH settings UI.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Absolute path of this plugin's state file. */
export function statePath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'remote-web-ui.json')
}

/** Stored password material; `hash` is scrypt(password, salt), never the password itself. */
export interface StoredAuth {
  readonly salt: string
  readonly hash: string
  /** HMAC key for session cookies; rotated together with the password. */
  readonly secret: string
  /** Bumped on every password change so older sessions can be rejected. */
  readonly version: number
}

/** The whole persisted record. */
export interface RemoteAccessState {
  readonly version: 1
  /**
   * 操作者的开关意图：为 true 才监听。没有密码时该值不可能为 true——
   * `configure` 拒绝，`start` 还会再拦一次（手改状态文件的兜底）。
   */
  readonly enabled: boolean
  /**
   * Listen addresses. `127.0.0.1` for this machine only, `0.0.0.0` for every
   * IPv4 interface, or one or more concrete local literals.
   */
  readonly hosts: readonly string[]
  readonly port: number
  readonly sessionDays: number
  /** Optional advertisement shown in the settings page; grants nothing. */
  readonly publicUrl: string
  readonly auth: StoredAuth | null
}

const DEFAULT_HOSTS: readonly string[] = ['127.0.0.1']
const DEFAULT_PORT = 39321
const DEFAULT_SESSION_DAYS = 30

/** Fresh state with no password configured yet. */
export function defaultState(): RemoteAccessState {
  return {
    version: 1,
    enabled: false,
    hosts: [...DEFAULT_HOSTS],
    port: DEFAULT_PORT,
    sessionDays: DEFAULT_SESSION_DAYS,
    publicUrl: '',
    auth: null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return fallback
  return value
}

function normalizeHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const host = value.trim()
  if (host.length === 0 || host.length > 64 || /[\s/]/.test(host)) return undefined
  return host
}

function normalizeHosts(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : []
  const unique = [...new Set(raw.map(normalizeHost).filter((host): host is string => host !== undefined))]
  return unique.length > 0 ? unique : [...DEFAULT_HOSTS]
}

function normalizeAuth(value: unknown): StoredAuth | null {
  if (!isRecord(value)) return null
  const { salt, hash, secret, version } = value
  if (typeof salt !== 'string' || salt.length === 0) return null
  if (typeof hash !== 'string' || hash.length === 0) return null
  if (typeof secret !== 'string' || secret.length < 32) return null
  const normalizedVersion = typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : 1
  return { salt, hash, secret, version: normalizedVersion }
}

/** Coerce a parsed file into the current shape, discarding unusable fields field by field. */
export function normalizeState(value: unknown): RemoteAccessState {
  const base = defaultState()
  if (!isRecord(value)) return base
  return {
    version: 1,
    // 只有显式 true 才算打开：缺字段、字符串、1 都不算。
    enabled: value.enabled === true,
    hosts: normalizeHosts(value.hosts),
    port: clampInt(value.port, base.port, 1, 65535),
    sessionDays: clampInt(value.sessionDays, base.sessionDays, 1, 365),
    publicUrl: typeof value.publicUrl === 'string' ? value.publicUrl.trim() : '',
    auth: normalizeAuth(value.auth),
  }
}

/** Read the current state, falling back to defaults on a missing or unreadable file. */
export function readState(): RemoteAccessState {
  let raw: string
  try {
    raw = readFileSync(statePath(), 'utf8')
  } catch {
    return defaultState()
  }
  try {
    return normalizeState(JSON.parse(raw))
  } catch {
    return defaultState()
  }
}

/** Replace the state atomically (write a sibling temp file, then rename). */
export function writeState(state: RemoteAccessState): void {
  const target = statePath()
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${String(process.pid)}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
