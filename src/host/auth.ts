/**
 * Password verification, signed session cookies, and login throttling.
 *
 * The listener is the only authentication boundary this package owns, so the
 * primitives here are deliberately conservative: scrypt with a per-password
 * salt, HMAC-signed stateless cookies bound to a password version, and a
 * per-client failure window that blocks repeated guesses.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const KEY_BYTES = 64
const SALT_BYTES = 16
const SECRET_BYTES = 32
const COOKIE_VERSION = 'v1'

function derive(password: string, salt: Buffer, bytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, bytes, (error, key) => {
      if (error !== null) reject(error)
      else resolve(key)
    })
  })
}

/** Hash a new password with a fresh random salt. */
export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(SALT_BYTES)
  const derived = await derive(password, salt, KEY_BYTES)
  return { salt: salt.toString('hex'), hash: derived.toString('hex') }
}

/** Constant-time verification against stored material. */
export async function verifyPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  let expected: Buffer
  try {
    expected = Buffer.from(hashHex, 'hex')
  } catch {
    return false
  }
  if (expected.byteLength !== KEY_BYTES) return false
  const derived = await derive(password, Buffer.from(saltHex, 'hex'), KEY_BYTES)
  return timingSafeEqual(derived, expected)
}

/** Fresh HMAC key for session cookies. */
export function createSecret(): string {
  return randomBytes(SECRET_BYTES).toString('hex')
}

/** Cookie payload: absolute expiry plus the password version it was issued for. */
export interface SessionPayload {
  readonly exp: number
  readonly pv: number
}

/** Encode and sign one session value. */
export function signSession(secret: string, exp: number, pv: number): string {
  const body = Buffer.from(JSON.stringify({ exp, pv }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  return `${COOKIE_VERSION}.${body}.${signature}`
}

/** Verify a session value; undefined for malformed, forged, expired, or stale-version cookies. */
export function verifySession(value: string, secret: string, now: number): SessionPayload | undefined {
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION) return undefined
  const body = parts[1] ?? ''
  const signature = parts[2] ?? ''
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  if (signature.length !== expected.length) return undefined
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof decoded !== 'object' || decoded === null) return undefined
  const { exp, pv } = decoded as Record<string, unknown>
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= now) return undefined
  if (typeof pv !== 'number' || !Number.isSafeInteger(pv)) return undefined
  return { exp, pv }
}

interface AttemptRecord {
  windowStart: number
  failures: number
  blockedUntil: number
}

/**
 * Per-client failure window. Deliberately in-memory: a restart clears it, and
 * persisting lockouts would let a remote attacker fill the state file.
 */
export class LoginThrottle {
  private readonly attempts = new Map<string, AttemptRecord>()
  private readonly maxFailures: number
  private readonly windowMs: number
  private readonly blockMs: number

  /**
   * @param maxFailures - failures inside one window before a block starts.
   * @param windowMs - length of the counting window.
   * @param blockMs - how long a triggered block lasts.
   */
  constructor(maxFailures = 5, windowMs = 60_000, blockMs = 60_000) {
    this.maxFailures = maxFailures
    this.windowMs = windowMs
    this.blockMs = blockMs
  }

  /**
   * Seconds the caller must wait, or 0 when a login attempt may proceed.
   * @param key - client identity (remote address).
   * @param now - current time in milliseconds.
   */
  retryAfter(key: string, now = Date.now()): number {
    const record = this.attempts.get(key)
    if (record === undefined) return 0
    if (record.blockedUntil > now) return Math.ceil((record.blockedUntil - now) / 1000)
    return 0
  }

  /**
   * Record one failed attempt, starting a block once the window is exhausted.
   * @param key - client identity.
   * @param now - current time in milliseconds.
   */
  recordFailure(key: string, now = Date.now()): void {
    const existing = this.attempts.get(key)
    const record = existing === undefined || now - existing.windowStart > this.windowMs
      ? { windowStart: now, failures: 0, blockedUntil: 0 }
      : existing
    record.failures += 1
    if (record.failures >= this.maxFailures) {
      record.failures = 0
      record.windowStart = now
      record.blockedUntil = now + this.blockMs
    }
    this.attempts.set(key, record)
    this.prune(now)
  }

  /** Forget a client after a successful login. */
  clear(key: string): void {
    this.attempts.delete(key)
  }

  private prune(now: number): void {
    if (this.attempts.size < 1024) return
    for (const [key, record] of this.attempts) {
      if (record.blockedUntil <= now && now - record.windowStart > this.windowMs) this.attempts.delete(key)
    }
  }
}
