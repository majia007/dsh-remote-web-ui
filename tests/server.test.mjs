import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteAccessServer } from '../src/host/server.ts'

/** Listen on an OS-assigned loopback port and return it. */
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(server.address().port) })
  })
}

/** Pick a currently free loopback port. */
async function freePort() {
  const probe = http.createServer()
  const port = await listen(probe)
  await new Promise((resolve) => { probe.close(resolve) })
  return port
}

/** Wait until the listener answers its health probe (a rebind is deferred one tick). */
async function waitListening(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${String(port)}/__remote/health`)
      return
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 25) })
    }
  }
  throw new Error(`listener on ${String(port)} did not start`)
}

/**
 * Boot a fake DSH upstream plus the listener under test.
 * The upstream mimics the two facts the proxy relies on: the token URL answers
 * 303 with the Host cookie, every other request is recorded.
 */
async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'dsrw-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const seen = []
  const upstream = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://upstream')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      response.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-test=cookie-value; Path=/' })
      response.end()
      return
    }
    seen.push({ url: request.url, headers: request.headers })
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('upstream-ok')
  })
  const upstreamPort = await listen(upstream)
  const listenerPort = await freePort()

  const server = new RemoteAccessServer({
    internalPort: () => upstreamPort,
    authenticatedUrl: port => `http://127.0.0.1:${String(port)}/?token=fake-token`,
    log: () => {},
  })
  // 先设密码再开开关：没有密码时 configure({ enabled: true }) 会被拒绝。
  await server.setPassword('correct-password')
  await server.configure({ port: listenerPort, enabled: true })
  await waitListening(listenerPort)

  return {
    server,
    upstreamPort,
    listenerPort,
    base: `http://127.0.0.1:${String(listenerPort)}`,
    seen,
    async dispose() {
      await server.stop()
      await new Promise((resolve) => { upstream.close(resolve) })
      rmSync(home, { recursive: true, force: true })
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

/** Extract `name=value` from the first Set-Cookie header. */
function sessionCookie(response) {
  const all = response.headers.getSetCookie()
  assert.ok(all.length > 0, '登录响应必须设置 cookie')
  const pair = all[0].split(';', 1)[0]
  assert.match(pair, /^dsh-remote-web-ui=v1\./)
  return pair
}

test('未登录访问页面时重定向到登录页', async () => {
  const app = await boot()
  try {
    const response = await fetch(`${app.base}/some/path?a=1`, { redirect: 'manual' })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), '/__remote/login?next=%2Fsome%2Fpath%3Fa%3D1')
  } finally {
    await app.dispose()
  }
})

test('登录页可直接打开', async () => {
  const app = await boot()
  try {
    const response = await fetch(`${app.base}/__remote/login`, { redirect: 'manual' })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /name="password"/)
  } finally {
    await app.dispose()
  }
})

test('错误密码返回 401 且不设置 cookie', async () => {
  const app = await boot()
  try {
    const response = await fetch(`${app.base}/__remote/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'nope' }),
    })
    assert.equal(response.status, 401)
    assert.equal(response.headers.getSetCookie().length, 0)
    assert.match(await response.text(), /密码错误/)
  } finally {
    await app.dispose()
  }
})

test('正确密码签发会话并放行代理，上游收到回环 authority 与内部凭据', async () => {
  const app = await boot()
  try {
    const login = await fetch(`${app.base}/__remote/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'correct-password' }),
    })
    assert.equal(login.status, 303)
    const session = sessionCookie(login)

    const response = await fetch(`${app.base}/api/state`, {
      redirect: 'manual',
      headers: { cookie: session, origin: 'https://external.example' },
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'upstream-ok')

    assert.equal(app.seen.length, 1)
    const forwarded = app.seen[0]
    assert.equal(forwarded.url, '/api/state')
    assert.equal(forwarded.headers.host, `127.0.0.1:${String(app.upstreamPort)}`)
    assert.equal(forwarded.headers.cookie, 'dsh-auth-test=cookie-value')
    assert.equal(forwarded.headers.origin, undefined, 'Origin 必须被剥掉，否则宿主 Origin 栅栏拒绝')
  } finally {
    await app.dispose()
  }
})

test('健康检查无需登录', async () => {
  const app = await boot()
  try {
    const response = await fetch(`${app.base}/__remote/health`, { redirect: 'manual' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, hasPassword: true })
  } finally {
    await app.dispose()
  }
})

test('改密码后旧会话立即失效', async () => {
  const app = await boot()
  try {
    const login = await fetch(`${app.base}/__remote/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'correct-password' }),
    })
    const session = sessionCookie(login)

    const changed = await app.server.setPassword('another-password')
    assert.equal(changed.ok, true)

    const response = await fetch(`${app.base}/`, { redirect: 'manual', headers: { cookie: session } })
    assert.equal(response.status, 302, '旧 cookie 的密码版本已过期')
  } finally {
    await app.dispose()
  }
})

test('未登录时外部入口不提供设置 API', async () => {
  const app = await boot()
  try {
    const response = await fetch(`${app.base}/remote-web-ui/api/state`, { redirect: 'manual' })
    assert.equal(response.status, 401)
    assert.equal(app.seen.length, 0)
  } finally {
    await app.dispose()
  }
})

test('登录后可从外部入口读取与修改设置', async () => {
  const app = await boot()
  try {
    const login = await fetch(`${app.base}/__remote/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'correct-password' }),
    })
    const session = sessionCookie(login)

    const state = await fetch(`${app.base}/remote-web-ui/api/state`, { headers: { cookie: session } })
    assert.equal(state.status, 200)
    const body = await state.json()
    assert.equal(body.status.port, app.listenerPort)
    assert.deepEqual(body.status.hosts, ['127.0.0.1'])
    assert.ok(body.addresses.some(entry => entry.url === `http://127.0.0.1:${String(app.listenerPort)}`))
    assert.ok(body.availableHosts.some(option => option.value === '0.0.0.0'))

    const change = await fetch(`${app.base}/remote-web-ui/api/config`, {
      method: 'POST',
      headers: { cookie: session, 'content-type': 'application/json' },
      body: JSON.stringify({ hosts: ['0.0.0.0'], sessionDays: 7 }),
    })
    assert.equal(change.status, 200)
    const changed = await change.json()
    assert.equal(changed.status.sessionDays, 7)
    assert.deepEqual(changed.status.hosts, ['0.0.0.0'])
  } finally {
    await app.dispose()
  }
})

test('监听地址可选且非法值被拒', async () => {
  const app = await boot()
  try {
    const bad = await app.server.configure({ hosts: ['not an address'] })
    assert.equal(bad.ok, false)
    const empty = await app.server.configure({ hosts: [] })
    assert.equal(empty.ok, false, '至少保留一个监听地址')
    const good = await app.server.configure({ hosts: ['127.0.0.1'] })
    assert.equal(good.ok, true)
    assert.deepEqual(good.status.hosts, ['127.0.0.1'])
  } finally {
    await app.dispose()
  }
})

test('没有密码时拒绝启用，开关保持关闭', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsrw-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const server = new RemoteAccessServer({
    internalPort: () => 1,
    authenticatedUrl: port => `http://127.0.0.1:${String(port)}/?token=fake-token`,
    log: () => {},
  })
  try {
    const rejected = await server.configure({ enabled: true })
    assert.equal(rejected.ok, false)
    assert.match(rejected.error, /密码/)
    assert.equal(server.status().enabled, false, '被拒后开关不能落成 true')
    assert.equal(server.status().listening, false)
  } finally {
    await server.stop()
    rmSync(home, { recursive: true, force: true })
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('关闭开关后释放端口', async () => {
  const app = await boot()
  try {
    const off = await app.server.configure({ enabled: false })
    assert.equal(off.ok, true)
    assert.equal(off.status.enabled, false)
    const deadline = Date.now() + 3000
    let closed = false
    while (Date.now() < deadline) {
      try {
        await fetch(`${app.base}/__remote/health`)
      } catch {
        closed = true
        break
      }
      await new Promise((resolve) => { setTimeout(resolve, 25) })
    }
    assert.equal(closed, true, '关闭开关后端口必须不再应答')
    assert.equal(app.server.status().listening, false)
  } finally {
    await app.dispose()
  }
})
