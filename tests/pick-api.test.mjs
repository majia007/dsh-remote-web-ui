import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleApi } from '../src/host/api.ts'

/** Response double collecting status/headers/body. */
function responseOf() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(body) { out.body = body ?? '' },
  }
}

const requestOf = ({ method = 'POST', path = '/remote-web-ui/api/pick-directory', type = 'application/json' } = {}) => ({
  method,
  url: path,
  headers: type === undefined ? {} : { 'content-type': type },
})

/** The pick route never touches the settings server. */
const SERVER = {}

test('系统目录框只在本机挂载面提供，远端面 404', async () => {
  const response = responseOf()
  await handleApi(SERVER, requestOf(), response, { nativePick: false })
  assert.equal(response.out.status, 404)
  assert.deepEqual(JSON.parse(response.out.body), { error: 'not found' })
})

test('本机面调用选择器并回传路径', async () => {
  const response = responseOf()
  let calls = 0
  await handleApi(SERVER, requestOf(), response, {
    nativePick: true,
    pickDirectory: async () => { calls += 1; return { path: 'D:\\projects\\demo' } },
  })
  assert.equal(calls, 1)
  assert.equal(response.out.status, 200)
  assert.deepEqual(JSON.parse(response.out.body), { ok: true, path: 'D:\\projects\\demo' })
})

test('取消时回 null（客户端据此什么都不做）', async () => {
  const response = responseOf()
  await handleApi(SERVER, requestOf(), response, {
    nativePick: true,
    pickDirectory: async () => ({ path: null }),
  })
  assert.equal(response.out.status, 200)
  assert.deepEqual(JSON.parse(response.out.body), { ok: true, path: null })
})

test('选择器失败时保留错误原文（如非 Windows）', async () => {
  const response = responseOf()
  await handleApi(SERVER, requestOf(), response, {
    nativePick: true,
    pickDirectory: async () => { throw new Error('系统目录框只在 Windows 上可用') },
  })
  assert.equal(response.out.status, 501)
  assert.deepEqual(JSON.parse(response.out.body), { ok: false, error: '系统目录框只在 Windows 上可用' })
})

test('非 JSON 请求体被拒（掐掉简单跨站提交）', async () => {
  const response = responseOf()
  await handleApi(SERVER, requestOf({ type: 'text/plain' }), response, { nativePick: true })
  assert.equal(response.out.status, 415)
})
