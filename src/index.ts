/**
 * Remote access plugin, Host half.
 *
 * Owns one independent HTTP listener in front of the local DSH Web UI. The
 * listener has its own password login; the DSH Host keeps its normal loopback
 * bind and its normal browser authentication, which this plugin mints and
 * replays internally. No `trustedHosts`, no `--public-url`, no assumption
 * about what forwards to the port (frp, cloudflared, a router rule).
 *
 * The settings API is mounted twice with different admission: on the DSH Host
 * listener behind the connection fence (desktop shell), and on this plugin's
 * own listener behind the plugin session (a remote browser configuring the
 * plugin it is using).
 */
import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { API_PREFIX, handleApi, writeJson } from './host/api.ts'
import { installBrowseDirectoryPicker } from './host/directory-picker.ts'
import { RemoteAccessServer } from './host/server.ts'

/** 宿主准入判定所需的 connection 面（两代入口各自可选，见 ambient.d.ts）。 */
type AdmissionConnection = {
  admit?(request: { readonly headers: IncomingMessage['headers'] }): { readonly rejection?: 401 | 403 | 503 }
  requestRejection?(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/**
 * 宿主请求准入：rc.1 起 `admit` 返回 `{ peer }` 或 `{ rejection }`，master 删除
 * `requestRejection` 后只剩它；极老构建仍只有 `requestRejection`，作为兜底。
 * @param connection - 宿主 connection 服务。
 * @param request - 待准入的 HTTP 请求。
 * @returns 拒绝时返回 401/403/503，放行返回 undefined。
 */
function admissionStatus(
  connection: AdmissionConnection,
  request: { readonly headers: IncomingMessage['headers'] },
): 401 | 403 | 503 | undefined {
  const admission = connection.admit?.(request)
  if (admission !== undefined) return admission.rejection
  return connection.requestRejection?.(request)
}

/** 拒绝状态到响应体错误码的映射。 */
function rejectionLabel(rejection: 401 | 403 | 503): string {
  if (rejection === 401) return 'unauthorized'
  if (rejection === 503) return 'unavailable'
  return 'forbidden'
}

/** Diagnostic sink: Host stdout is owned by Electron, so a file is the only observable channel. */
function log(message: string): void {
  console.warn(`[remote-web-ui] ${message}`)
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    appendFileSync(join(home, 'remote-web-ui.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Diagnostics must never break the listener.
  }
}

/**
 * Start the listener and expose the loopback-only settings API.
 * @param ctx - Host context carrying `webServer` and `connection`.
 */
export function apply(ctx: Context): void {
  log('apply entered')
  ctx.inject(['webServer', 'connection'], (scoped) => {
    log('services resolved')
    const server = new RemoteAccessServer({
      internalPort: () => scoped.webServer.port,
      authenticatedUrl: port => scoped.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}/`),
      log,
    })

    // A bind failure is recorded on the server, never thrown at the Host: the
    // DSH window must keep working even when the configured port is taken.
    void server.start()

    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (request, response) => {
        void (async () => {
          // 宿主 webServer 的默认路由认证不替代这条语义判断：每条插件路由仍自己过准入。
          const rejection = admissionStatus(scoped.connection, request)
          if (rejection !== undefined) {
            writeJson(response, rejection, { error: rejectionLabel(rejection) })
            return
          }
          await handleApi(server, request, response, { nativePick: true })
        })()
      },
    }), 'remote-web-ui: settings API')

    scoped.effect(() => () => { void server.stop() }, 'remote-web-ui: listener')

    // 目录选择器：宿主在桌面部署里固定用 native（对话框只在 Host 屏幕上），
    // 远端浏览器无法使用；换成 browse 交互（页面内浏览 Host 目录）。
    // 失败只记日志：装不上目录选择器不该拖垮远程入口本身。
    scoped.effect(() => {
      let disposed = false
      let cleanup: (() => Promise<void>) | undefined
      void (async () => {
        try {
          const unmount = await installBrowseDirectoryPicker(scoped)
          if (disposed) {
            await unmount()
            return
          }
          cleanup = unmount
        } catch (error) {
          log(`directory picker: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
      return () => {
        disposed = true
        void cleanup?.()
      }
    }, 'remote-web-ui: directory picker')
  })
}
