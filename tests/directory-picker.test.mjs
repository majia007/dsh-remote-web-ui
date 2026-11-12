import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installBrowseDirectoryPicker } from '../src/host/directory-picker.ts'

const BROWSE_HOST = '@deepseek-ai/dsh-host-directory-picker-browse'
const BROWSE_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-browse'

/**
 * Minimal Loader double: records create/dispose order and can refuse one
 * package to exercise the partial-install cleanup.
 */
class FakeLoader {
  constructor({ failOn } = {}) {
    this.store = {}
    this.failOn = failOn
    this.events = []
    this.count = 0
  }

  async create(options) {
    if (options.name === this.failOn) throw new Error(`boom: ${options.name}`)
    this.count += 1
    const id = `row-${this.count}`
    this.store[id] = {
      fiber: {
        await: async () => {},
        dispose: async () => { this.events.push(`dispose:${options.name}`) },
      },
    }
    this.events.push(`create:${options.name}`)
    return id
  }

  resolve(id) {
    return this.store[id]
  }

  remove(id) {
    this.events.push(`remove:${id}`)
    delete this.store[id]
  }
}

const ctxWith = loader => ({ get: name => (name === 'loader' ? loader : undefined) })

test('装载 browse 后端与表面两行，顺序与宿主 auto 的成对装载一致', async () => {
  const loader = new FakeLoader()
  const unmount = await installBrowseDirectoryPicker(ctxWith(loader))

  assert.deepEqual(loader.events.filter(event => event.startsWith('create:')), [
    `create:${BROWSE_HOST}`,
    `create:${BROWSE_SURFACE}`,
  ])

  await unmount()
  assert.deepEqual(loader.events.filter(event => event.startsWith('dispose:')), [
    `dispose:${BROWSE_SURFACE}`,
    `dispose:${BROWSE_HOST}`,
  ], '卸载逆序：先摘表面，再摘后端')
  assert.deepEqual(loader.store, {}, '清理后不留装载行')
})

test('运行期启用：先停掉已激活的 auto 行，再装载 browse', async () => {
  const loader = new FakeLoader()
  const autoDisposals = []
  loader.store['directory-picker'] = {
    fiber: {
      await: async () => {},
      dispose: async () => { autoDisposals.push('auto') },
    },
  }

  const unmount = await installBrowseDirectoryPicker(ctxWith(loader))
  assert.deepEqual(autoDisposals, ['auto'], 'native 后端必须先于 browse 卸载，否则服务重名')
  assert.equal(loader.events[0], `create:${BROWSE_HOST}`)
  await unmount()
})

test('auto 行存在但没有 fiber（冷启动被 patch 禁用）时不误停', async () => {
  const loader = new FakeLoader()
  loader.store['directory-picker'] = { fiber: undefined }
  const unmount = await installBrowseDirectoryPicker(ctxWith(loader))
  assert.deepEqual(loader.events.filter(event => event.startsWith('create:')), [
    `create:${BROWSE_HOST}`,
    `create:${BROWSE_SURFACE}`,
  ])
  await unmount()
})

test('装载中途失败：抛错并清掉已建的行', async () => {
  const loader = new FakeLoader({ failOn: BROWSE_SURFACE })
  await assert.rejects(() => installBrowseDirectoryPicker(ctxWith(loader)), /boom/)
  assert.deepEqual(loader.events.filter(event => event.startsWith('create:')), [`create:${BROWSE_HOST}`])
  assert.deepEqual(loader.events.filter(event => event.startsWith('dispose:')), [`dispose:${BROWSE_HOST}`])
  assert.deepEqual(loader.store, {})
})

test('没有 loader 服务时静默跳过（不拖垮远程入口）', async () => {
  const unmount = await installBrowseDirectoryPicker({ get: () => undefined })
  await unmount()
})
