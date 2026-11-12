/**
 * Windows 系统目录框（自建「选择文件夹…」入口用）。
 *
 * 为什么不复用宿主那套 `@deepseek-ai/dsh-host-directory-picker-native`：
 * 它在宿主安装的依赖树里，本包的裸 `import` 从插件目录出发解析不到（Node
 * 的 ESM 解析不会进 asar）；经 `ctx.loader` 加载它会实例化 default class，
 * 注册 `ctx.directoryPicker`，与远端可用的 browse 后端重名（一个进程只能有
 * 一种 directoryPicker 实现）。
 *
 * 所以这里用系统自带的 PowerShell + System.Windows.Forms.FolderBrowserDialog：
 * 零额外依赖、只在 win32 可用、对话框开在 Host 的屏幕上——只有坐在 Host 前
 * 的人用它（远端页面会隐藏这个入口，公开监听器也不提供该路由）。
 */
import { spawn } from 'node:child_process'

/** Outcome of one chooser session. */
export interface NativePickResult {
  /** Selected absolute path; null when the operator cancelled. */
  readonly path: string | null
}

/** The minimal child-process surface, injectable for tests. */
export interface PickRunner {
  (command: string, args: string[]): {
    readonly stdout: NodeJS.ReadableStream
    readonly stderr: NodeJS.ReadableStream
    readonly once: (event: 'error' | 'close', listener: (...args: any[]) => void) => unknown
    readonly kill: () => unknown
  }
}

/**
 * The chooser script, passed with -EncodedCommand (UTF-16LE base64) so no
 * shell quoting or code-page issue can mangle it. The owner form is never
 * shown; it exists so the dialog can be top-most over the DSH window.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择工作区目录'
$dialog.ShowNewFolderButton = $true
try {
  $answer = $dialog.ShowDialog($owner)
  if ($answer -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
`.trim()

/** Default runner: a hidden PowerShell child. */
const runPowerShell: PickRunner = (command, args) => spawn(command, args, {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})

/** Windows PowerShell's console host, falling back to pwsh when only it exists is not worth a probe: powershell.exe ships with Windows. */
const POWERSHELL = 'powershell.exe'

/** No chooser session may outlive this bound (an abandoned dialog would leak a child process). */
const TIMEOUT_MS = 10 * 60_000

/**
 * Open the Windows folder chooser on the Host display.
 * @param options - injectable runner (tests) and a caller lifetime.
 * @returns the selected path, or null when cancelled.
 * @throws when the platform is not Windows, the child fails, or the caller aborts.
 */
export function pickWindowsDirectory(options: { run?: PickRunner; signal?: AbortSignal } = {}): Promise<NativePickResult> {
  if (process.platform !== 'win32') {
    throw new Error('系统目录框只在 Windows 上可用')
  }
  const run = options.run ?? runPowerShell
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')

  return new Promise<NativePickResult>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      settle()
    }
    const child = run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
    child.once('error', (error: Error) => {
      finish(() => { reject(error) })
    })
    child.once('close', (code: number | null) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `系统目录框退出码 ${String(code)}`))
          return
        }
        const path = stdout.replace(/[\r\n]+$/, '')
        resolve({ path: path === '' ? null : path })
      })
    })

    const stop = (reason: Error): void => {
      finish(() => { reject(reason) })
      child.kill()
    }
    const onAbort = (): void => { stop(new Error('选择已取消')) }
    timer = setTimeout(() => { stop(new Error('系统目录框超时')) }, TIMEOUT_MS)
    if (options.signal?.aborted === true) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
