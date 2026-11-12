/**
 * 本机专用入口：用 Windows 系统目录框选一个 Host 目录，创建并切换到该工作区。
 *
 * 远端浏览器用不了（对话框开在 Host 的屏幕上），所以远端页面根本不注册这个
 * 入口：插件监听器登录时写了可读的 {@link REMOTE_ENTRY_COOKIE}，client 读到
 * 就跳过注册；Host 侧 `/remote-web-ui/api/pick-directory` 也只注册在本机 DSH
 * 的 webServer 上，公开监听器回答 404（双保险）。
 */
import { useState } from 'react'
import css from './CreateWorkspace.module.css'

/**
 * 文件夹字形：沿用宿主 `ui-primitives` 的 `folder-close` 产品图标路径
 * （`icons/artwork.ts`，16 viewBox、regular 1px stroke），因此与工作区 chip、
 * 模式选择器旁的图标同一画风、同一视觉尺寸。手写内联而不 import 宿主包：
 * 本包 client 产物刻意不含任何 `@deepseek-ai/*` require（见 AGENTS.md「产物检查」）。
 * @param props - requested square size.
 * @returns the folder glyph.
 */
function FolderIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
    >
      <path d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z" />
      <path d="M3.63501 7.66614H12.3647" />
    </svg>
  )
}

/** Injected face of one registration; `wide` is absent on the hero slot. */
export interface CreateWorkspaceInjected {
  t: (key: string) => string
  /** Run the whole flow (chooser → create → switch); rejects with a user-facing message. */
  pick: () => Promise<void>
  /** Sidebar footer passes the shell width state; absent elsewhere. */
  wide?: boolean
}

/**
 * One entry in either slot: a folder button plus an inline failure line.
 * @param props - injected copy and flow.
 * @returns the button entry.
 */
export function CreateWorkspaceEntry({ t, pick, wide }: CreateWorkspaceInjected) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    pick().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setBusy(false) })
  }
  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={css.button}
        onClick={run}
        disabled={busy}
        title={error ?? t('createTitle')}
        aria-label={t('createLabel')}
      >
        <FolderIcon size={16} />
        {wide !== false && <span className={css.label}>{busy ? t('createBusy') : t('createLabel')}</span>}
      </button>
      {error !== null && <span className={css.error} role="alert">{error}</span>}
    </span>
  )
}
