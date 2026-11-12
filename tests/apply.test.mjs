import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** Free loopback port. */
async function freePort() {
  const probe = http.createServer()
  await new Promise((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
  const port = probe.address().port
  await new Promise((resolve) => { probe.close(resolve) })
  return port
}

/** 合法的密码材料；健康检查只看有没有密码，不校验口令。 */
const AUTH = { salt: 'salt', hash: 'hash', secret: 'x'.repeat(64), version: 1 }

/**
 * 用一份状态文件跑一次 apply，并在 1 秒内探健康检查。
 * @param {object} state - 写进状态文件的记录。
 * @param {number} port - 监听端口。
 * @returns {Promise<{routes: object[], health: Response | undefined, dispose: () => void}>}
 */
async function boot(state, port) {
  const home = mkdtempSync(join(tmpdir(), 'dsrw-apply-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  writeFileSync(join(home, 'remote-web-ui.json'), JSON.stringify(state))

  const disposers = []
  const routes = []
  const ctx = {
    inject(_names, callback) { callback(ctx) },
    get() { return undefined },
    effect(execute) {
      const result = execute()
      const dispose = typeof result === 'function' ? result : () => {}
      disposers.push(dispose)
      return dispose
    },
    webServer: {
      port: 1,
      protocol: 'http:',
      register(route) { routes.push(route); return () => {} },
    },
    connection: {
      requestRejection() { return undefined },
      authenticatedUrl(p) { return `http://127.0.0.1:${String(p)}/?token=fake` },
    },
  }

  apply(ctx)

  let health
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      health = await fetch(`http://127.0.0.1:${String(port)}/__remote/health`)
      break
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    }
  }

  return {
    routes,
    health,
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
      rmSync(home, { recursive: true, force: true })
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

test('开关关闭时不监听，但仍注册设置 API', async () => {
  const port = await freePort()
  const app = await boot({
    version: 1, enabled: false, hosts: ['127.0.0.1'], port, sessionDays: 30, publicUrl: '', auth: AUTH,
  }, port)
  try {
    assert.equal(app.routes.length, 1, '设置 API 路由必须注册')
    assert.equal(app.routes[0].path, '/remote-web-ui/api')
    assert.equal(app.health, undefined, '开关关闭时端口不能监听')
  } finally {
    app.dispose()
  }
})

test('开关打开且有密码时 apply 后起监听', async () => {
  const port = await freePort()
  const app = await boot({
    version: 1, enabled: true, hosts: ['127.0.0.1'], port, sessionDays: 30, publicUrl: '', auth: AUTH,
  }, port)
  try {
    assert.ok(app.health !== undefined, '监听器必须在 apply 后开始监听')
    assert.deepEqual(await app.health.json(), { ok: true, hasPassword: true })
  } finally {
    app.dispose()
  }
})
