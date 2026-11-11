/**
 * Minimal self-contained login page.
 *
 * It is served by this package's listener, not the DSH frontend: the browser
 * has no DSH cookie yet, and the page must work before any asset loads. No
 * external resources, no inline script — a plain form post keeps it usable on
 * the oldest browser a tunnel might front, and keeps the password out of URLs.
 */

/** Escape text for HTML attribute or element context. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Render the login page, optionally with an error or a setup hint. */
export function renderLoginPage(options: { error?: string; configured: boolean; next?: string }): string {
  const error = options.error === undefined
    ? ''
    : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
  const setup = options.configured
    ? ''
    : '<p class="setup" role="status">尚未设置访问密码。请先在 DSH 设置 → 插件 → 远程访问 中设置密码。</p>'
  const next = options.next === undefined ? '' : `<input type="hidden" name="next" value="${escapeHtml(options.next)}">`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 远程访问</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: Canvas; color: CanvasText;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { width: min(360px, calc(100vw - 32px)); padding: 24px; }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
  p.sub { margin: 0 0 20px; color: GrayText; font-size: 13px; }
  label { display: block; margin-bottom: 6px; font-size: 13px; }
  input[type=password] {
    width: 100%; padding: 9px 11px; border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
    background: color-mix(in srgb, CanvasText 4%, Canvas); color: inherit;
    font: inherit;
  }
  input[type=password]:focus-visible {
    outline: 2px solid AccentColor; outline-offset: 1px;
    border-color: transparent;
  }
  button {
    margin-top: 14px; width: 100%; padding: 10px 14px; border: 0; border-radius: 8px;
    background: AccentColor; color: AccentColorText; font: inherit; font-weight: 600;
    cursor: pointer;
  }
  button:disabled { opacity: .6; cursor: default; }
  p.error { margin: 0 0 14px; color: #d9534f; font-size: 13px; }
  p.setup {
    margin: 0 0 14px; padding: 9px 11px; border-radius: 8px; font-size: 13px;
    background: color-mix(in srgb, CanvasText 6%, Canvas);
  }
</style>
</head>
<body>
<main>
  <h1>DSH 远程访问</h1>
  <p class="sub">请输入访问密码</p>
  ${setup}
  ${error}
  <form method="post" action="./login" autocomplete="current-password">
    ${next}
    <label for="password">密码</label>
    <input id="password" name="password" type="password" required autofocus
      autocomplete="current-password" spellcheck="false">
    <button type="submit">登录</button>
  </form>
</main>
</body>
</html>`
}
