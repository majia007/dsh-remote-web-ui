/**
 * Remote access plugin, browser half.
 *
 * Registers one page in Web Settings' top-level navigation
 * (`settings.section`). The page reads and writes the loopback-only settings
 * API served by the Host half; it never talks to the public listener directly.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createApi, RemoteAccessSection } from './SettingsTab.tsx'
import { RemoteAccessNavIcon } from './SectionIcon.tsx'
import { en, LOCALE_NS, zh } from './locales.ts'

/**
 * Services `apply` touches. Cordis gates property access on this list, and a
 * missing export fails activation — which, on the desktop shell, rewrites the
 * profile (see the package AGENTS.md).
 */
export const inject = ['slots', 'locale']

/**
 * Register the dictionaries and the settings section.
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
}
