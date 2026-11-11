import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultState, normalizeState } from '../src/host/state.ts'

test('缺省状态没有密码，服务默认关闭', () => {
  const state = defaultState()
  assert.equal(state.version, 1)
  assert.equal(state.enabled, false, '初始状态不监听：没有密码就不能对外')
  assert.deepEqual(state.hosts, ['127.0.0.1'])
  assert.equal(state.port, 39321)
  assert.equal(state.sessionDays, 30)
  assert.equal(state.auth, null)
})

test('监听地址归一化', () => {
  assert.deepEqual(normalizeState({ hosts: ['0.0.0.0'] }).hosts, ['0.0.0.0'])
  assert.deepEqual(normalizeState({ hosts: ['10.0.20.68', '127.0.0.1'] }).hosts, ['10.0.20.68', '127.0.0.1'])
  assert.deepEqual(normalizeState({ hosts: [] }).hosts, ['127.0.0.1'])
  assert.deepEqual(normalizeState({ hosts: ['  ', 5] }).hosts, ['127.0.0.1'])
  assert.deepEqual(normalizeState({ hosts: ['127.0.0.1', '127.0.0.1'] }).hosts, ['127.0.0.1'], '去重')
})

test('归一化接受合法值并丢弃畸形值', () => {
  assert.deepEqual(normalizeState(null), defaultState())
  assert.deepEqual(normalizeState('nope'), defaultState())
  assert.equal(normalizeState({ port: 8080 }).port, 8080)
  assert.equal(normalizeState({ port: 0 }).port, 39321, '端口 0 不是合法监听目标，回落默认')
  assert.equal(normalizeState({ port: 70000 }).port, 39321)
  assert.equal(normalizeState({ sessionDays: 0 }).sessionDays, 30)
  assert.equal(normalizeState({ sessionDays: 400 }).sessionDays, 30)
  assert.equal(normalizeState({ publicUrl: '  https://a.example  ' }).publicUrl, 'https://a.example')
  assert.equal(normalizeState({ enabled: true }).enabled, true)
  assert.equal(normalizeState({ enabled: false }).enabled, false)
  assert.equal(normalizeState({ enabled: 'true' }).enabled, false, '只有显式 true 才算打开')
})

test('密码材料缺字段时整体作废，不会半认', () => {
  assert.equal(normalizeState({ auth: { salt: 'a' } }).auth, null)
  assert.equal(normalizeState({ auth: { salt: 'a', hash: 'b' } }).auth, null)
  assert.equal(normalizeState({ auth: { salt: 'a', hash: 'b', secret: 'short' } }).auth, null)
  const valid = normalizeState({ auth: { salt: 'a', hash: 'b', secret: 'x'.repeat(64), version: 2 } })
  assert.deepEqual(valid.auth, { salt: 'a', hash: 'b', secret: 'x'.repeat(64), version: 2 })
})
