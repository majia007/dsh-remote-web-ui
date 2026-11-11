# AGENTS.md — @jia-tools/dsh-remote-web-ui

给本机 DSH 加一个带独立密码的 Web 入口：插件自己监听一个固定回环端口，自己登录，再把请求反向代理到 DSH 的随机回环端口。

> 原名 `dsh-remote-access`，2026-11-11 改名 `dsh-remote-web-ui`：loader 行 id、设置分区 id、文案命名空间、API 前缀、cookie 名、状态文件与日志文件名一并改；旧 `$DSH_HOME/remote-access.json` 不再读取（旧配置按废弃处理，从默认值起步）。

**权限与作用边界**：只监听一个回环端口、读写 `$DSH_HOME/remote-web-ui.json`、在 Host 的 `webServer` 上注册一条 `/remote-web-ui/api` 前缀路由（供本机设置页调用）。不改 profile 官方行，不碰 `trustedHosts`，不读会话记录。

## 为什么不需要 trustedHosts / 启动 token

DSH 的 `/api` 栅栏（`packages/client/connection/src/api-request-trust.ts`）只认回环、监听绑定 IP 或 `trustedHosts`；带 `Origin` 时还要求它与 `Host` 同 authority。外部域名直接访问必然 403。

本插件的做法是**在代理这一跳把视角改回本机**：

1. `Host` 改写成 `127.0.0.1:<DSH 端口>`；
2. `Origin` 直接删掉（栅栏对"没有 Origin"放行；`sec-fetch-site` 也一并删，因为上游 authority 已经和浏览器看到的不一致）；
3. 启动时用 `ctx.connection.authenticatedUrl()` 换到 DSH 自己的浏览器 cookie，逐请求注入。

因此外部浏览器既不需要 `?token=`，也不需要 profile 里声明公网域名。代价是：**到达插件的请求被视为已由插件认证**——插件自己的登录就是唯一防线。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Host 入口：`ctx.inject(['webServer','connection'])` 后起监听、注册 `/remote-web-ui/api`、写诊断日志 |
| `src/host/server.ts` | 监听器本体：登录页/登录/登出、会话 cookie、限速、代理调度 |
| `src/host/auth.ts` | scrypt 密码哈希、HMAC 会话签名、按 IP 的失败窗口 |
| `src/host/proxy.ts` | HTTP 与 WebSocket upgrade 的反向代理；头改写规则在这里 |
| `src/host/state.ts` | `$DSH_HOME/remote-web-ui.json` 的读写与归一化 |
| `src/host/login-page.ts` | 自包含登录页 HTML（无外部资源、无内联脚本） |
| `src/client/index.ts` | 注册 `settings.section` 页面与 `settings.section.icon` 导航图标，以及文案字典 |
| `src/client/SectionIcon.tsx` | 导航行图标（手写地球 SVG）：不注册该槽位时宿主落回设置齿轮，与「设置」本身同字形 |
| `src/client/SettingsTab.tsx` | 配置页；只调 `/remote-web-ui/api`，不碰公开监听器。可达地址与「外部地址」共用同一行结构（地址 / 类型标签 / 复制按钮） |
| `build/preset.mjs` | 复刻官方产物契约；CSS 前缀 `dsrw-` |

## 构建与验证

```bash
pnpm install
pnpm build
pnpm test
```

- 测试分两层：`tests/*.test.mjs` 直读 `src/`（Node 类型擦除）；`tests/apply.test.mjs` 加载 `lib/index.js`，用假 ctx 走完整 `apply → listen → health`。**改 `src/` 后必须先 build 再跑 apply 测试**。
- ⚠️ **Node 的类型擦除不支持构造函数参数属性**（`constructor(private readonly x: T)`）。测试直读 `src/` 时会抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`；类字段一律显式声明并在构造函数里赋值。
- 产物检查：`lib/client.js` 里不应出现 `require("@deepseek-ai/...")`（模块表外裸 require 会在浏览器抛 `missed the module table`）；`__ModuleLoader__.load` 的 id 必须是包名。

## 装载与热重载

- 安装：`plugin_manager` 的 `install_bundle` 指向本目录，返回 `application: applied` 只代表 profile 文件更新。
- ⚠️ **新增的 Loader 行必须重启桌面端才会装载**。实测 `install_bundle` 后 `list_plugins` 显示 `include:remote-web-ui` 为 `active`，但 `cordis_inspect_query` 的 `Config.listConfigs` 返回 `unknown entry id "remote-web-ui"`，且 `apply` 无任何副作用（无日志、无路由、端口未监听）——那个 `active` 是 plugin_manager 的静态清单，不是运行时 fiber。`set_bundle` 的 false→true 同样只改文件。判据用 `apply` 的副作用（诊断日志 + `/remote-web-ui/api` 是否 401 而非 404），不要用 `fiberPhase`。
- client bundle 由桌面自带 HMR 在 build 后自动重挂，不要刷新页面。

## 诊断

`apply` 与监听器把诊断写到 `$DSH_HOME/remote-web-ui.log`（Host 的 stdout 归 Electron，看不到）。正常启动应看到：

```
apply entered
services resolved
start requested
binding http://127.0.0.1:39321
listening on http://127.0.0.1:39321
```

只看到前两行说明 `webServer` / `connection` 没就绪；看到 `binding` 没有 `listening` 说明端口绑定失败（错误原文在下一行）。

## 认证与会话

- 密码用 scrypt（64 字节派生）+ 每密码独立 salt；改密码会换 `secret` 并把 `auth.version` +1，**所有旧会话立即失效**。
- Cookie 值 `v1.<body>.<hmac>`，`body = {exp, pv}`；`exp` 绝对时间，`pv` 必须等于当前版本。
- Cookie 属性 `HttpOnly; SameSite=Lax; Path=/`，**刻意不加 `Secure`**：监听器是明文 HTTP，加了会让 HTTP 接入登录后掉线；TLS 由前置代理负责。
- 登录失败按 `socket.remoteAddress` 计数：默认 5 次/分钟，命中后冷却 60 秒，内存态（重启即清空，避免攻击者用失败填满磁盘）。

## 代理行为

- 请求头：删 `host/origin/cookie/referer/forwarded/x-forwarded-*/x-real-ip/sec-fetch-*`，设 `host=127.0.0.1:<port>`、`cookie=<内部 cookie>`。
- 响应头：删 `set-cookie`（内部 cookie 不外泄）与 hop-by-hop 头；状态码、正文流式透传。
- WebSocket：`server.on('upgrade')` 独立认证，用 `http.request` 转发升级，101 握手按上游 `rawHeaders` 原样回写（`Sec-WebSocket-Accept` 必须是上游算的），双向 pipe。
- 内部 cookie 缓存 5 分钟，端口变化即重取；DSH Host 重启后端口变，第一次请求会自动换新的。
- `/remote-web-ui*` 在公开监听器上一律 404，绝不转发。

## 坑

> ⚠️ **loader 行 id 不能叫 `remote-access`（撞官方行，2026-11-11 真机定案）**
> 症状：装本插件后桌面冷启动报 `desktop welcome: Web request failed` 反复起不来，报错完全不指向本插件。
> 根因：官方 base bundle 的 `remote-access` 行（`@deepseek-ai/dsh-api-remote-access`）提供 `ctx.remoteAccess` 服务；同名 insert 把官方行顶掉，api-gateway/session-controller/workspace-controller/api-remotes/ui-deliverables 五条目永远 pending，`/api/settings/describe` 404。
> 正解：行 id 用包名去前缀的 `remote-web-ui`（与官方 `remote-access` 不同名；改名前的临时 id 是 `remote-access-proxy`）。排查利器：用与桌面相同方式手动起 Host（Electron exe + `ELECTRON_RUN_AS_NODE=1` + `dsh-desktop-host/lib/index.js <asar/dsh> <profile> <primaryRuntime> <pnpm.mjs> <bin>`），stderr 会直接点名 pending 链，再按桌面同序列 curl `/api/settings/describe` 看真实状态码。

> ⚠️ **`list_plugins` 的 `fiberPhase` 不等于 `apply` 已执行**
> 症状：新装的 insert 行显示 active，但插件没有任何副作用。
> 根因：该字段来自静态清单；新行尚未进入 loader 组合。
> 正解：以 `Config.listConfigs` 能否找到 entry、以及 `apply` 的副作用为准；新行必须重启桌面端。

> ⚠️ **测试直读 `src/` 时不能用构造函数参数属性**
> 症状：`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode`。
> 正解：显式字段 + 构造函数赋值（`src/host/server.ts` 的 `options`）。

> ⚠️ **`Origin` 必须删而不是改写**
> 症状：只改写 `Host` 时，页面能打开但所有 `/api` 返回 403。
> 根因：栅栏在 `Origin` 存在时要求它与 `Host` 同 authority，改 `Host` 反而制造了不一致。
> 正解：删掉 `Origin`（栅栏把"没有 Origin"视为非浏览器跨站请求）并同时删 `sec-fetch-*`。

## 约定

- 全文中文；代码标识符英文。
- 包名 `dsh-` + kebab-case；行 id 是包名去掉 `dsh-` 前缀，即 `remote-web-ui`。**不能叫 `remote-access`**：官方 base bundle 已占该行（提供 `ctx.remoteAccess` 服务），同名 insert 会顶掉它，见坑。
- 不导出 `Config`：Host 侧保持零宿主依赖，配置由插件自己的数据文件 + 设置页 API 承担。想改成 settings 表单就得引入 schemastery 的 vendor 构建，得不偿失。
- 文档与代码冲突时以代码为准。
