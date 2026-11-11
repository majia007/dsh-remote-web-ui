# @jia-tools/dsh-remote-web-ui

给本机 DSH 加一个**带独立密码的 Web 入口**，用 frp、cloudflared、路由器端口转发都能接到它前面。插件只负责监听和鉴权，不假设前置代理的类型，也不假设 TLS 在哪一端终止。

## 它做什么

- 在 `127.0.0.1` 上再监听一个固定端口（默认 `39321`）。
- 该端口上先过插件自己的登录页与密码校验，未登录的请求拿不到任何 DSH 内容。
- 登录后用 HMAC 签名的会话 cookie 通行，然后把请求反向代理到本机 DSH 的随机回环端口。
- 代理转发时把 `Host` 改写成回环 authority、剥掉 `Origin`、注入 DSH 自己的浏览器 cookie，因此**不需要**给 DSH 配 `trustedHosts`，也**不需要**每次去取启动 token。

桌面端和外部浏览器访问的是同一个 DSH 进程、同一份会话与工作区。

## 配置

设置 → 插件 → 远程访问。

| 项 | 说明 |
|---|---|
| 监听端口 | 默认 `39321`，保存后立即重绑；被占用会在页面上显示错误 |
| 会话有效期 | 登录一次保持多少天，默认 30 |
| 外部地址 | 可选，只用于展示可复制的入口，不参与鉴权 |
| 访问密码 | 至少 8 位；改密码会让所有已登录会话立即失效 |

密码以 `scrypt(password, salt)` 存于 `$DSH_HOME/remote-web-ui.json`（Windows 下即 `%USERPROFILE%\.dsh\remote-web-ui.json`），不保存明文，也不进入 DSH 的 settings。

## 接到外网

插件不关心谁来转发，只要把它指向 `http://127.0.0.1:39321`：

```yaml
# cloudflared（dashboard 托管型 tunnel 则在 Zero Trust 后台填 Service）
ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:39321
```

```ini
# frp
[dsh]
type = http
local_port = 39321
custom_domains = dsh.example.com
```

外部入口建议挂在**域名根**（`https://dsh.example.com/`），不要挂子路径：DSH 自己的登录跳转按根路径处理，插件也不改写路径前缀。

## 安全模型

这是该入口的**唯一认证层**，请按这个前提配置：

- 密码 + 会话 cookie 之外没有任何旁路；未设置密码时监听器仍然监听，但登录页只显示"尚未设置访问密码"，无法进入。
- 连续失败会按客户端 IP 限速（5 次/分钟，命中后冷却 60 秒）。
- Cookie 是 `HttpOnly; SameSite=Lax`，**不带 `Secure`**——插件无法知道前置代理是否终止了 TLS，而 `Secure` 会让纯 HTTP 接入在登录后立刻掉线。用 HTTPS 时请让前置代理负责加密；如果整条链路都是 HTTP，密码是明文过网的。
- 一旦通过登录，外部浏览器拥有与本机窗口同等的 DSH 权限（当前沙箱与审批策略不变）。别把密码和入口地址一起泄露。

## 限制

- **桌面端退出、更新或重启，外部入口立即断开**，因为它就是同一个 Host 进程。
- 同一时间只有一个全局密码，没有多用户/多角色。
- 插件不代理 `/remote-web-ui/*` 到外部：设置 API 只在 DSH 自己的回环监听器上可用。

## 开发

```bash
pnpm install
pnpm build      # tsc → tsdown，产出 lib/index.js + lib/client.js + lib/types
pnpm test       # tests/**（服务端行为、登录、代理、apply harness）
```

改动 Host 侧后必须重启桌面端才会装载（新增的 Loader 行只在启动时组合）；client bundle 由桌面自带的 HMR 在 build 后自动重挂。

## 许可

MIT
