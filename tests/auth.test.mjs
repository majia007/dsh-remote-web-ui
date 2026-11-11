import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSecret,
  hashPassword,
  LoginThrottle,
  signSession,
  verifyPassword,
  verifySession,
} from '../src/host/auth.ts'

test('密码哈希可验证且拒绝错误密码', async () => {
  const { salt, hash } = await hashPassword('correct horse battery')
  assert.equal(await verifyPassword('correct horse battery', salt, hash), true)
  assert.equal(await verifyPassword('wrong password', salt, hash), false)
  assert.equal(await verifyPassword('', salt, hash), false)
})

test('每次哈希使用独立 salt', async () => {
  const first = await hashPassword('same-password')
  const second = await hashPassword('same-password')
  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.hash, second.hash)
})

test('会话签名可验证、拒绝篡改与过期', () => {
  const secret = createSecret()
  const now = 1_700_000_000_000
  const value = signSession(secret, now + 60_000, 3)
  assert.deepEqual(verifySession(value, secret, now), { exp: now + 60_000, pv: 3 })
  assert.equal(verifySession(value, createSecret(), now), undefined, '换密钥后必须失效')
  assert.equal(verifySession(value, secret, now + 120_000), undefined, '过期必须失效')
  assert.equal(verifySession(`${value}x`, secret, now), undefined, '签名被篡改必须失效')
  assert.equal(verifySession('garbage', secret, now), undefined)
})

test('限速窗口在阈值内累计，触发后阻断', () => {
  const throttle = new LoginThrottle(3, 60_000, 30_000)
  const now = 1_700_000_000_000
  assert.equal(throttle.retryAfter('a', now), 0)
  throttle.recordFailure('a', now)
  throttle.recordFailure('a', now)
  assert.equal(throttle.retryAfter('a', now), 0, '未到阈值不禁用')
  throttle.recordFailure('a', now)
  assert.equal(throttle.retryAfter('a', now), 30, '到阈值后按秒返回等待时间')
  assert.equal(throttle.retryAfter('b', now), 0, '按客户端隔离')
  assert.equal(throttle.retryAfter('a', now + 31_000), 0, '阻断到期后恢复')
})

test('成功登录清除失败记录', () => {
  const throttle = new LoginThrottle(2, 60_000, 30_000)
  const now = 1_700_000_000_000
  throttle.recordFailure('a', now)
  throttle.clear('a')
  throttle.recordFailure('a', now)
  assert.equal(throttle.retryAfter('a', now), 0)
})
