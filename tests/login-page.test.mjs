import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderLoginPage } from '../src/host/login-page.ts'

test('登录页含表单与字段', () => {
  const html = renderLoginPage({ configured: true })
  assert.match(html, /<form method="post" action="\.\/login"/)
  assert.match(html, /name="password"/)
  assert.match(html, /type="password"/)
})

test('未配置密码时给出提示', () => {
  const html = renderLoginPage({ configured: false })
  assert.match(html, /尚未设置访问密码/)
})

test('错误与 next 都会被转义，不产生标签注入', () => {
  const html = renderLoginPage({
    configured: true,
    error: '<img src=x onerror=alert(1)>',
    next: '"/><script>alert(1)</script>',
  })
  assert.doesNotMatch(html, /<img src=x/)
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /&lt;img src=x/)
})
