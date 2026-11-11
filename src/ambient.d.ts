/**
 * Host 与 Client 两半消费到的宿主包最小类型面。
 *
 * 这些包不在本仓库 node_modules 里（运行期由宿主进程 / module-table 供给），
 * 所以裸名对 tsc 不可解析；此处只声明实际用到的成员。宿主升级后按 checkout 复核。
 */

declare module '@deepseek-ai/cordis' {
  export type Disposable<T = any> = () => T

  /** Host 侧 HTTP 载体（packages/host/webserver/src/index.ts 的消费面）。 */
  export interface WebServerLike {
    /** 实际监听端口（listen 之后才有值）。 */
    readonly port: number
    readonly protocol: 'http:' | 'https:'
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void | Promise<void>
    }): () => void
  }

  /** Host 侧 connection 服务（packages/client/connection/src/rpc-host.ts 的消费面）。 */
  export interface ConnectionLike {
    /** Host/Origin 栅栏；undefined 表示放行。 */
    requestRejection(request: { readonly headers: import('node:http').IncomingMessage['headers'] }): 401 | 403 | undefined
    /** 给应用 URL 附上本进程启动令牌。 */
    authenticatedUrl(baseUrl: string): string
  }

  export interface Context {
    effect(execute: () => Disposable | Iterable<Disposable> | void, label?: string): Disposable
    get(name: string): unknown
    inject(names: readonly string[], callback: (scoped: this) => void): Disposable
    slots: import('@deepseek-ai/dsh-client-ui-slots').SlotRegistry
    locale: import('@deepseek-ai/dsh-client-locale/client').LocaleRuntime
    webServer: WebServerLike
    connection: ConnectionLike
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export type SlotLabel = string | (() => string)

  /** 本包用到的槽位注册表面。 */
  export interface SlotRegistry {
    register(options: {
      name: string
      id?: string
      order?: number
      label?: SlotLabel
      locale?: string
      inject?: () => Record<string, unknown>
    }, component: unknown): () => void
    inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
  }
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  export type LocaleDict = Record<string, string>

  export interface LocaleRuntime {
    register(namespace: string, dicts: Record<string, LocaleDict>): () => void
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  }
}
