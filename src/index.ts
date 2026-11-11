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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { API_PREFIX, handleApi, writeJson } from './host/api.ts'
import { RemoteAccessServer } from './host/server.ts'

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
          // Every plugin route must run this fence itself: the Host webServer
          // adds no authentication of its own.
          const rejection = scoped.connection.requestRejection(request)
          if (rejection !== undefined) {
            writeJson(response, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
            return
          }
          await handleApi(server, request, response)
        })()
      },
    }), 'remote-web-ui: settings API')

    scoped.effect(() => () => { void server.stop() }, 'remote-web-ui: listener')
  })
}
