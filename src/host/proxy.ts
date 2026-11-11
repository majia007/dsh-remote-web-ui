/**
 * Reverse proxy onto the loopback DSH listener.
 *
 * The local Host binds `127.0.0.1` and sits behind a trust fence that accepts
 * loopback, its own bind address, or a declared `trustedHosts` entry. Rather
 * than asking a deployment to declare the public authority, this proxy
 * presents the loopback authority to the Host and replays the Host's own
 * browser cookie, so an external browser needs no DSH token and the profile
 * needs no change.
 *
 * The Host's Origin fence is satisfied by REMOVING `Origin`: an absent Origin
 * is accepted (a browser sends one on every fetch, so it cannot be absent
 * there — the request arrives here from another hop, and this proxy is the
 * one vouching for it). `sec-fetch-site` is likewise dropped because the
 * upstream authority no longer matches what the browser saw.
 */
import http from 'node:http'
import type { Duplex } from 'node:stream'

/** Upstream facts resolved per request. */
export interface ProxyTarget {
  /** Loopback port the local DSH Host listens on. */
  readonly port: number
  /** The Host's browser cookie in `name=value` form. */
  readonly cookie: string
}

/** Headers that must not be replayed to the upstream Host. */
const DROPPED_REQUEST_HEADERS = [
  'host',
  'origin',
  'cookie',
  'referer',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
] as const

/** Hop-by-hop response headers owned by the socket, not the message. */
const DROPPED_RESPONSE_HEADERS = [
  'set-cookie',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
] as const

/** Request headers rewritten for the upstream authority. */
function upstreamHeaders(request: http.IncomingMessage, target: ProxyTarget): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if ((DROPPED_REQUEST_HEADERS as readonly string[]).includes(name)) continue
    headers[name] = value
  }
  headers.host = `127.0.0.1:${String(target.port)}`
  headers.cookie = target.cookie
  return headers
}

/** Forward one HTTP request, streaming both directions. */
export function forwardHttp(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  target: ProxyTarget,
): void {
  const upstream = http.request({
    host: '127.0.0.1',
    port: target.port,
    path: request.url ?? '/',
    method: request.method,
    headers: upstreamHeaders(request, target),
  }, (upstreamResponse) => {
    const headers: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value === undefined) continue
      if ((DROPPED_RESPONSE_HEADERS as readonly string[]).includes(name)) continue
      headers[name] = value
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers)
    upstreamResponse.pipe(response)
    upstreamResponse.on('error', () => { response.destroy() })
  })
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('上游 DSH 不可达')
  })
  request.pipe(upstream)
  response.on('close', () => { upstream.destroy() })
}

/**
 * Forward a WebSocket upgrade. The 101 handshake is replayed verbatim so the
 * `Sec-WebSocket-Accept` the browser validates stays the upstream Host's.
 * @param request - the browser's upgrade request (already authenticated).
 * @param socket - the client socket to take over.
 * @param head - bytes already read past the request line.
 * @param target - upstream authority and cookie.
 */
export function forwardUpgrade(
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: ProxyTarget,
): void {
  const upstream = http.request({
    host: '127.0.0.1',
    port: target.port,
    path: request.url ?? '/',
    method: request.method,
    headers: upstreamHeaders(request, target),
  })
  upstream.on('upgrade', (upstreamResponse, upstreamSocket: Duplex, upstreamHead: Buffer) => {
    const lines = ['HTTP/1.1 101 Switching Protocols']
    const raw = upstreamResponse.rawHeaders
    for (let index = 0; index + 1 < raw.length; index += 2) {
      lines.push(`${raw[index] ?? ''}: ${raw[index + 1] ?? ''}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.on('error', () => { socket.destroy() })
    socket.on('error', () => { upstreamSocket.destroy() })
    upstreamSocket.pipe(socket).pipe(upstreamSocket)
  })
  upstream.on('response', (upstreamResponse) => {
    // The upstream refused the upgrade; hand its status back so the browser
    // reports a failed handshake instead of a hang.
    socket.write(
      `HTTP/1.1 ${String(upstreamResponse.statusCode ?? 502)} ${upstreamResponse.statusMessage ?? ''}\r\n`
      + `content-length: 0\r\nconnection: close\r\n\r\n`,
    )
    socket.destroy()
  })
  upstream.on('error', () => { socket.destroy() })
  socket.on('error', () => { upstream.destroy() })
  upstream.end()
}
