import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { pickWindowsDirectory } from '../src/host/native-pick.ts'

/**
 * Minimal child-process double: the chooser script is never executed, and the
 * test drives stdout/exit by hand.
 */
class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.killed = false
  }

  kill() {
    this.killed = true
    return true
  }
}

const runOf = child => () => child

/** The chooser entry refuses non-Windows hosts outright; the assertions below only apply on Windows. */
const isWindows = process.platform === 'win32'

test('选中目录时返回路径（stdout 去掉行尾换行）', { skip: !isWindows }, async () => {
  const child = new FakeChild()
  const pending = pickWindowsDirectory({ run: runOf(child) })
  child.stdout.write('C:\\work\\demo\r\n')
  child.emit('close', 0)
  assert.deepEqual(await pending, { path: 'C:\\work\\demo' })
})

test('取消（空输出）返回 null', { skip: !isWindows }, async () => {
  const child = new FakeChild()
  const pending = pickWindowsDirectory({ run: runOf(child) })
  child.emit('close', 0)
  assert.deepEqual(await pending, { path: null })
})

test('非零退出码把 stderr 原文作为错误', { skip: !isWindows }, async () => {
  const child = new FakeChild()
  const pending = pickWindowsDirectory({ run: runOf(child) })
  child.stderr.write('Add-Type 失败')
  child.emit('close', 1)
  await assert.rejects(pending, /Add-Type 失败/)
})

test('调用方 abort 会杀掉子进程并拒绝', { skip: !isWindows }, async () => {
  const child = new FakeChild()
  const controller = new AbortController()
  const pending = pickWindowsDirectory({ run: runOf(child), signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /选择已取消/)
  assert.equal(child.killed, true)
})
