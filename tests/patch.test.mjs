import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The bundle patch and the Host-side installer are two halves of the same
 * decision: the patch disables the Host's boot-time auto row (cold start) and
 * the installer mounts the browse pair at apply time. These assertions guard
 * the split: browse rows must NOT be statically inserted (runtime enablement
 * does not replay the disable override, so a static insert collides with the
 * still-running native backend), and the two package names must agree with the
 * installer.
 */
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const installer = readFileSync(new URL('../src/host/directory-picker.ts', import.meta.url), 'utf8')

/** Split the file into top-level patch entries (each starts with `- ` at column 0). */
function entries(source) {
  return source.split(/^- /m).slice(1).map(block => `- ${block}`)
}

const blocks = entries(patch)

test('目录选择器：patch 禁用宿主 auto 行（冷启动路径）', () => {
  const auto = blocks.find(block => /^- id: directory-picker\s*$/m.test(block))
  assert.ok(auto, '缺少 `- id: directory-picker` 覆盖条目：冷启动会继续解析成 native')
  assert.match(auto, /^\s+disabled: true\s*$/m, 'auto 行没有被禁用')
})

test('browse 两行不得静态 insert（运行期启用会与 native 服务重名）', () => {
  assert.doesNotMatch(
    patch,
    /@deepseek-ai\/dsh-(?:client-ui-)?directory-picker-(?:browse|native)/,
    'browse/native 行必须由 src/host/directory-picker.ts 在运行时装；静态 insert 会在'
    + '「禁用 → 启用」时与仍在运行的 native 后端撞 service "directoryPicker"',
  )
  assert.match(installer, /'@deepseek-ai\/dsh-host-directory-picker-browse'/, '安装器缺少 browse 后端包名')
  assert.match(installer, /'@deepseek-ai\/dsh-client-ui-directory-picker-browse'/, '安装器缺少 browse 表面包名')
})

test('insert 行 id 不与官方行 id 相撞', () => {
  // Insert rows are indented under `- insert:`; the top-level `- id: directory-picker`
  // override is a patch target, not a new row.
  const ids = [...patch.matchAll(/^ {4}- id: (\S+)\s*$/gm)].map(match => match[1])
  assert.ok(ids.includes('remote-web-ui'), '缺少插件自己的 loader 行')
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  assert.deepEqual(duplicates, [], '同一个 patch 里出现重复 id')
  // 官方 base/web-app bundle 已占的行 id：撞名会顶掉官方行（remote-access 的先例）。
  for (const reserved of ['remote-access', 'directory-picker']) {
    assert.equal(
      ids.includes(reserved),
      false,
      `insert 行 id 不能叫 ${reserved}：那是官方行 id，同名 insert 会顶掉它`,
    )
  }
})
