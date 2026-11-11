# @jia-tools/dsh-remote-web-ui

给本机 DSH 加一个**带独立密码的 Web 入口**。插件只在本机多监听一个回环端口，自己完成登录与鉴权，再把请求反向代理到 DSH 的随机回环端口；公网怎么进来由你自己决定。

**这个插件不提供任何公网访问渠道，自身也不经过任何中转服务器。** 它不建隧道、不做云端配对、没有账号体系；公网入口、域名、TLS 与访问控制都由你用自己的方案（cloudflared、frp、路由器端口转发、自建反代）处理。

## 纯本地，不带云服务

这个插件只做「本机多一个带密码的 HTTP 端口」这一件事：

- **不提供公网渠道**：不建隧道、不生成配对链接、不替你申请域名或证书；公网怎么进由你决定。
- **插件自身不连任何服务器**：登录页、密码校验、会话 cookie、反向代理全部在本机进程内完成。你选的隧道是否经过第三方网络，由该方案自己决定，不是插件内置的账号或中转。
- **没有账号体系**：没有注册、没有设备配对、没有云端会话；唯一凭据是你在设置页设的访问密码。
- **安全边界在你手里**：公网入口的 TLS、防火墙、访问策略、DDoS 防护都在插件之外；插件只保证「未通过本地密码校验的请求拿不到 DSH 内容」。

这样做的好处是入口完全归你控制，代价是公网链路要自己搭、自己守。

## 安装

要求 DSH `>=0.2.2-rc.1 <0.3.0`（prerelease 参与匹配）。

```sh
dsh plugin --profile <profile> add @jia-tools/dsh-remote-web-ui
```

桌面端 / Web 在「插件」页搜索 `@jia-tools/dsh-remote-web-ui` 安装。

本地源码安装（开发）：`dsh plugin --profile <profile> add <本目录>`；改代码后 `pnpm build`，Host 侧改动需 disable → enable 或重启宿主，client bundle 由桌面自带 HMR 在 build 后自动重挂。

## 它做什么

- 默认在 `127.0.0.1` 上再监听一个固定端口（默认 `39321`），可在设置里改成局域网地址或所有 IPv4 网卡。
- 该端口上先过插件自己的登录页与密码校验，未登录的请求拿不到任何 DSH 内容。
- 登录后用 HMAC 签名的会话 cookie 通行，然后把请求反向代理到本机 DSH 的随机回环端口。
- 代理转发时把 `Host` 改写成回环 authority、剥掉 `Origin`、注入 DSH 自己的浏览器 cookie，因此**不需要**给 DSH 配 `trustedHosts`，也**不需要**每次去取启动 token。

桌面端和外部浏览器访问的是同一个 DSH 进程、同一份会话与工作区。

## 配置

设置 → 远程访问（设置面板的顶层导航行，不在「插件」页里）。

| 项 | 说明 |
|---|---|
| 服务开关 | 默认关闭；没有设置密码时无法打开，监听器也不会启动 |
| 监听地址 | 默认 `127.0.0.1`；可多选「所有 IPv4 网卡」或具体网卡地址。改成局域网/所有网卡后，同网段可直接访问，此时密码是唯一防线 |
| 监听端口 | 默认 `39321`，保存后立即重绑；被占用会在页面上显示错误 |
| 会话有效期 | 登录一次保持多少天，默认 30，范围 1-365 |
| 外部地址 | 可选，只用于展示可复制的入口，不参与鉴权，也不会自动配置 TLS 或反代 |
| 访问密码 | 至少 8 位；改密码会让所有已登录会话立即失效 |

密码以 `scrypt(password, salt, 64)` 派生后存于 `$DSH_HOME/remote-web-ui.json`（Windows 下即 `%USERPROFILE%\.dsh\remote-web-ui.json`），不保存明文，也不进入 DSH 的 settings。

## 接到外网

插件不关心谁来转发，只要把它指向 `http://127.0.0.1:39321`。下面两种是常见做法；用哪种、怎么配 TLS 和访问策略，都由你决定。

### Cloudflare Tunnel

适合有域名、想让 Cloudflare 终结 TLS 的情况。

1. 安装 `cloudflared`（Windows 可用 `winget install --id Cloudflare.cloudflared`）。
2. 登录并授权域名：`cloudflared tunnel login`。
3. 创建 tunnel：`cloudflared tunnel create dsh`。
4. 在 `%USERPROFILE%\.cloudflared\config.yml` 写入口配置（`<tunnel-id>` 用上一步输出的 id）：

   ```yaml
   tunnel: <tunnel-id>
   credentials-file: C:\Users\<你>\.cloudflared\<tunnel-id>.json
   ingress:
     - hostname: dsh.example.com
       service: http://127.0.0.1:39321
     - service: http_status:404
   ```

5. 绑定 DNS：`cloudflared tunnel route dns dsh dsh.example.com`。
6. 前台试跑：`cloudflared tunnel run dsh`；确认可用后可用 `cloudflared service install` 做成系统服务。
7. 打开 `https://dsh.example.com`，应看到插件的登录页。

临时验证可以不走域名：`cloudflared tunnel --url http://127.0.0.1:39321` 会生成一个 `trycloudflare.com` 随机域名，不需要域名和账号；它只适合短时间验证，不要长期用，也不要把随机域名当成私密地址。

Cloudflare 只加密到边缘，`cloudflared` 到 `127.0.0.1:39321` 这一段是本机明文回环。插件只认自己的密码，不校验 Cloudflare Access 头；需要额外一层访问控制时，在 Cloudflare Zero Trust 里配 Access，它会在请求到达插件之前拦截。

### frp

```ini
# frpc.ini
[dsh]
type = http
local_port = 39321
custom_domains = dsh.example.com
```

TLS 可以在 frps 侧终止，也可以在前面再套一层 Nginx/Caddy。

### 通用要求

- 外部入口建议挂在**域名根**（`https://dsh.example.com/`），不要挂子路径：DSH 自己的登录跳转按根路径处理，插件也不改写路径前缀。
- 不要把监听地址改成 `0.0.0.0` 后直接暴露到公网；如果确实要监听所有网卡，至少用系统防火墙限制来源。
- 带宽、并发、证书续期、DNS 解析都由你的隧道/反代负责，插件不参与。

## 安全模型

这是该入口的**唯一应用层认证**，请按这个前提配置：

- 密码 + 会话 cookie 之外没有任何旁路；未设置密码时监听器不会启动（服务开关也打不开，手改状态文件也会在启动时再被拦一次）。
- 连续失败会按 TCP 对端地址限速（5 次/分钟，命中后冷却 60 秒）。经前置代理时，所有外部客户端在插件看来都是代理的地址，会共享同一份额度。
- Cookie 是 `HttpOnly; SameSite=Lax`，**不带 `Secure`**——插件无法知道前置代理是否终止了 TLS，而 `Secure` 会让纯 HTTP 接入在登录后立刻掉线。用 HTTPS 时请让前置代理负责加密；如果整条链路都是 HTTP，密码是明文过网的。
- 一旦通过登录，外部浏览器拥有与本机窗口同等的 DSH 权限（当前沙箱与审批策略不变）。别把密码和入口地址一起泄露。
- 插件自身不做 IP 白名单、设备管理、审计日志或账号体系；需要这些能力时，在前置代理/零信任网关侧做。

## 限制

- **桌面端退出、更新或重启，外部入口立即断开**，因为它就是同一个 Host 进程。
- 同一时间只有一个全局密码，没有多用户/多角色。
- 设置 API 同时挂在本机 DSH 和公开入口上：公开入口要求先通过插件登录；`/remote-web-ui/api` 由插件自己处理，不转发给上游 DSH，其余路径按普通请求代理。
- 插件不管理隧道进程、证书与 DNS；隧道断了、证书过期了，都不在插件的能力范围内。
- 公网可达性取决于你的隧道/端口映射和防火墙配置，插件不做网络探测，也不保证入口一直在线。

## 开发

```bash
pnpm install
pnpm build      # tsc → tsdown，产出 lib/index.js + lib/client.js + lib/types
pnpm test       # tests/**（服务端行为、登录、代理、apply harness）
pnpm typecheck  # tsc --noEmit
```

改动 Host 侧后需要 disable → enable（或重启桌面端）才会装载新产物；client bundle 由桌面自带的 HMR 在 build 后自动重挂。

## 许可

MIT。仓库：<https://github.com/majia007/dsh-remote-web-ui>
