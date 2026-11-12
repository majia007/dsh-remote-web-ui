/**
 * 远端可用的目录选择：把宿主在桌面部署里固定使用的 native 交互换成 browse。
 *
 * 宿主 `directory-picker` 行（@deepseek-ai/dsh-host-directory-picker-auto）在
 * boot 时按环境解析交互（packages/host/directory-picker-auto/src/resolve.ts:55）：
 * Windows/macOS + 回环绑定 + 无 trustedHosts → native。native 的对话框开在
 * Host 的屏幕上（client 侧 pick 走 Electron preload 注入的
 * `__DSH_DIRECTORY_PICKER__` 或经 RPC 落到 Host 的 OS chooser），经本插件进入的
 * 远端浏览器既看不见也点不到——现象是远端「添加工作区」没有可用的选择器。
 *
 * 两条装载路径：
 * - 冷启动：bundle patch 的 `- id: directory-picker` + `disabled: true` 生效
 *   （全量组合），auto 行不激活；这里直接装载 browse 的后端与表面两行。
 * - 运行期启用（插件管理页 禁用 → 启用）：plugin-manager 只发布本 bundle 的
 *   insert 行（packages/boot/plugin-manager/src/index.ts:1195 的 bundleRows），
 *   disabled 覆盖不重放，auto 行仍在运行且已注册 native 的 directoryPicker 服务。
 *   静态 insert browse 行会在这一步撞 `service "directoryPicker" has been
 *   registered`（2026-11-12 真机：启用失败，1 entry did not activate），所以这里
 *   先把 auto 行的 fiber 停掉（它的 effect 会连带卸载 native 后端与表面），
 *   再 create browse 两行。页面里已经装载的 native client entry 不会因此卸载，
 *   需刷新/重启页面才看得到新对话框；Host 侧行为是立即正确的。
 */
import type { Context } from '@deepseek-ai/cordis'

/** 宿主按环境二选一的目录选择行 id（packages/bundle/web-app/cordis.patch.yml）。 */
const AUTO_ROW_ID = 'directory-picker'

/** Pin 的 browse 交互：Host 后端（ctx.directoryPicker 的 browse capability）+ 页面表面。 */
const BROWSE_ROWS = [
  '@deepseek-ai/dsh-host-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
] as const

/** Host Loader 在本模块用到的成员（vendor/loader 的 EntryTree / EntryGroup 面）。 */
interface LoaderRowLike {
  readonly fiber?: {
    dispose(): Promise<void>
    await(): Promise<void>
  } | undefined
}

interface LoaderLike {
  readonly store: Record<string, LoaderRowLike | undefined>
  create(options: { name: string }): Promise<string>
  resolve(id: string): LoaderRowLike
  remove(id: string): void
}

/** Loader 不可用时（非常规组合）静默跳过：没有它就无法切换交互，但不能拖垮监听器。 */
function loaderOf(ctx: Context): LoaderLike | undefined {
  const loader = ctx.get('loader')
  return loader as LoaderLike | undefined
}

/**
 * 装载 browse 目录选择交互，并停掉可能已激活的 native auto 行。
 * @param ctx - Host context（需要 loader 服务）。
 * @returns 卸载已装载行的清理函数；Loader 缺失时是空函数。
 */
export async function installBrowseDirectoryPicker(ctx: Context): Promise<() => Promise<void>> {
  const loader = loaderOf(ctx)
  if (loader === undefined) return async () => {}

  // 运行期启用：auto 行已激活，native 的 directoryPicker 服务仍然在册。
  // 停掉 fiber（auto 的 effect 会卸载它 create 的 native 后端与表面），
  // 否则 browse 后端注册同名服务会直接抛 duplicate-service。
  const auto = loader.store[AUTO_ROW_ID]
  if (auto?.fiber !== undefined) {
    await auto.fiber.dispose()
  }

  const ids: string[] = []
  const unmount = async (): Promise<void> => {
    for (const id of [...ids].reverse()) {
      const entry = loader.store[id]
      if (entry === undefined) continue
      // 先从树里摘掉再等 fiber：与 directory-picker-auto 的 unmount 同序，
      // 避免行还在树里时被并发的重组合再拉起来。
      const disposal = entry.fiber?.dispose()
      loader.remove(id)
      await disposal
    }
    ids.length = 0
  }

  try {
    for (const name of BROWSE_ROWS) {
      const id = await loader.create({ name })
      ids.push(id)
      const entry = loader.resolve(id)
      if (entry.fiber === undefined) throw new Error(`failed to load ${name}`)
      await entry.fiber.await()
    }
  } catch (cause) {
    // 装载到一半失败：把已建的行清干净，不留半个交互。
    await unmount()
    throw cause
  }
  return unmount
}
