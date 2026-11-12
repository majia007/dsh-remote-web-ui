/**
 * Remote access plugin, browser half.
 *
 * Two surfaces:
 * - the Web Settings page (`settings.section`) reading the Host settings API;
 * - a desktop-client-only quick entry that opens the Windows folder chooser,
 *   creates the picked directory as a Workspace, and switches to it.
 *
 * The quick entry renders only inside the DSH desktop client: the chooser runs
 * on the Host display, so a remote browser (or a plain browser on this
 * machine) must not offer it. The desktop client serves its page from the
 * custom `dsh-app://` scheme, while every browser (remote entry or local) is
 * http/https — the page's own protocol is the exact signal.
 */
import type { Context } from '@deepseek-ai/cordis'
import { API_PREFIX } from '../shared.ts'
import { CreateWorkspaceEntry } from './CreateWorkspace.tsx'
import { RemoteAccessNavIcon } from './SectionIcon.tsx'
import { createApi, RemoteAccessSection } from './SettingsTab.tsx'
import { en, LOCALE_NS, zh } from './locales.ts'

/**
 * Services `apply` touches. Cordis gates property access on this list, and a
 * missing export fails activation — which, on the desktop shell, rewrites the
 * profile (see the package AGENTS.md).
 */
export const inject = ['slots', 'locale']

/** The Workspace Controller's create face (only `create` is needed here). */
interface WorkspaceCreateApi {
  create(input: { path: string }): Promise<{ workspaceId: string }>
}

/** The ui-workspace navigation face used to switch after creating. */
interface UiWorkspaceApi {
  startSession(workspaceId: string, options?: { clearPreviousDraft?: boolean }): void
}

/** Whether this page runs inside the DSH desktop client (Electron renderer). */
function inDesktopClient(): boolean {
  // 桌面客户端把页面装在自己的自定义协议下（`dsh-app://app/`，见
  // apps/desktop/src/main.ts 的 protocol.handle），普通浏览器——包括远程
  // 入口和本机浏览器——都是 http/https。协议是页面自己就能读到的精确信号。
  return globalThis.location?.protocol === 'dsh-app:'
}

/**
 * Register the dictionaries, the settings section, and (desktop client only)
 * the quick workspace entry.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'remote-web-ui: dictionaries')

  const t = ctx.locale.bind(LOCALE_NS)
  // Stable references: the page's load effect depends on `load`, so an API
  // object rebuilt per render would re-request on every keystroke.
  const api = createApi()

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote-web-ui',
    order: 80,
    label: () => t('nav'),
    inject: () => ({ t, ...api }),
  }, RemoteAccessSection))

  // 导航行图标：不注册就落回宿主的设置齿轮（和「设置」本身同一个字形），
  // id 必须与上面的 section id 一致，否则宿主永远不渲染。
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon',
    id: 'remote-web-ui',
  }, RemoteAccessNavIcon))

  if (!inDesktopClient()) return

  // 桌面客户端专用：系统目录框开在 Host 屏幕上。workspaces / uiWorkspace
  // 由 ui-workspace 的 client 半边提供服务，到达顺序不保证，所以用
  // ctx.inject 等待而不是直接 ctx.get。
  ctx.inject(['workspaces', 'uiWorkspace'], (scoped) => {
    const workspaces = scoped.get('workspaces') as WorkspaceCreateApi | undefined
    const uiWorkspace = scoped.get('uiWorkspace') as UiWorkspaceApi | undefined
    if (workspaces === undefined) return

    const pick = async (): Promise<void> => {
      const response = await fetch(`${API_PREFIX}/pick-directory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const payload = await response.json().catch(() => ({})) as {
        ok?: unknown
        path?: unknown
        error?: unknown
      }
      if (!response.ok || payload.ok !== true) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${String(response.status)}`)
      }
      // 取消：系统框返回空，什么也不做。
      if (typeof payload.path !== 'string' || payload.path === '') return
      const workspace = await workspaces.create({ path: payload.path })
      uiWorkspace?.startSession?.(workspace.workspaceId, { clearPreviousDraft: false })
    }
    // 主会话工作区行：紧贴工作区 chip（order 0 排在 heroOptions 内最前；
    // 侧栏工作区标题行的右侧是宿主 WorkspaceBrowser 的内部按钮组，没有
    // 插件槽，所以侧栏不放入口）。位置由 CreateWorkspace.module.css 的
    // hero 行规则配合（把 heroOptions 拉回左侧、模式选择器排到后面）。
    scoped.slots.inject('conversation.hero.options', () => scoped.slots.register({
      name: 'conversation.hero.options',
      id: 'remote-web-ui-create',
      order: 0,
      label: () => t('createLabel'),
      inject: () => ({ t, pick }),
    }, CreateWorkspaceEntry))
  })
}
