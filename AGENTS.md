# AGENTS.md — @jia-tools/dsh-remote-web-ui

给本机 DSH 加一个带独立密码的 Web 入口：插件自己监听一个固定回环端口，自己登录，再把请求反向代理到 DSH 的随机回环端口。插件不提供公网访问渠道、自身不经过中转服务器，也没有账号体系；隧道、域名、TLS 与访问控制由部署方自备。

**权限与作用边界**：只监听一个回环端口、读写 `$DSH_HOME/remote-web-ui.json`、在 Host 的 `webServer` 上注册一条 `/remote-web-ui/api` 前缀路由（供本机设置页调用），并由插件自己的监听器在插件会话校验后提供同一套 API（供远程浏览器配置）；另在**自己的 bundle patch 层**禁用宿主的 `directory-picker` 自动行（冷启动），并在 apply 时通过 Loader 装载 browse 交互两行（见「远端创建工作区」）。不改 profile 官方行，不碰 `trustedHosts`，不读会话记录。

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
| `src/client/SettingsTab.tsx` | 配置页；只调当前 origin 的 `/remote-web-ui/api`（本机与远程入口共用同一实现，后者要求插件会话）。可达地址与「外部地址」共用同一行结构（地址 / 类型标签 / 复制按钮） |
| `src/client/CreateWorkspace.tsx` | 桌面客户端专用的「选择文件夹…」入口（`conversation.hero.options`，紧贴工作区 chip）：弹 Host 的 Windows 系统目录框 → `workspaces.create({path})` → `uiWorkspace.startSession`；非桌面客户端不注册 |
| `src/host/native-pick.ts` | PowerShell + `FolderBrowserDialog` 的系统目录框（插件 import 不到宿主 native 包，见「本机专用入口」） |
| `src/shared.ts` | Host 与 client 共享的纯常量（`API_PREFIX`） |
| `build/preset.mjs` | 复刻官方产物契约；CSS 前缀 `dsrw-` |
| `src/host/directory-picker.ts` | 装载 browse 目录选择交互：运行期先停掉已激活的宿主 auto 行（native），再 create browse 后端 + 表面两行；Loader 缺失时静默跳过 |
| `cordis.patch.yml` | 插件行 + 冷启动覆盖：禁用宿主 `directory-picker`（auto）行。**browse 两行不在这里**（运行期启用不重放 disabled 覆盖，静态 insert 会撞服务） |

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

- 安装：`plugin_manager` 的 `install_bundle` 指向本目录；返回 `application: applied` 即 profile 文件更新 + 运行期装载。
- ⚠️ **判据用 `apply` 的副作用，不要用 `fiberPhase`**：`list_plugins` 的 `fiberPhase` 来自静态清单，新行未必已进入 loader 组合、`apply` 未必已执行。判据是诊断日志 + `/remote-web-ui/api` 的状态码（401/200 都算路由在，404 才是没注册）+ 设置页分区是否渲染。
- 安装后即运行期装载，无需重启桌面：`install_bundle` 返回 `application: applied` 后 `apply` 在约 1 秒内跑完——`$DSH_HOME/remote-web-ui.log` 依次 `apply entered` → `services resolved` → `start requested` → `disabled: not listening`，`/remote-web-ui/api` 探到 401，设置页导航出现「远程访问」。冷启动仍以 web-boot 门禁为准。
- ⚠️ **页面存活期间不会卸载已装载的 client entry**：换包后页面里会同时存在两个设置分区，已装载但 API 前缀失效的那个显示 `读取配置失败：HTTP 404`；桌面重启后消失，不要据此判断新包没生效（按 CSS 类名前缀 `dsrw-` / 是否报 404 区分两个分区）。
- client bundle 由桌面自带 HMR 在 build 后自动重挂，不要刷新页面。
- **路由栅栏**：Host 侧 `/remote-web-ui/api` 先过 `ctx.connection.requestRejection`（401/403 直接回，POST 才读 JSON）；插件自己的公开监听器另有一套登录（cookie），两条认证面不要混。

## 诊断

`apply` 与监听器把诊断写到 `$DSH_HOME/remote-web-ui.log`（Host 的 stdout 归 Electron，看不到）。正常启动应看到：

```
apply entered
services resolved
start requested
binding http://127.0.0.1:39321
listening on http://127.0.0.1:39321
```

只看到前两行说明 `webServer` / `connection` 没就绪；看到 `binding` 没有 `listening` 说明端口绑定失败（错误原文在下一行）。开关关闭时第四行是 `disabled: not listening`（默认状态，不是故障）。

## 认证与会话

- 密码用 scrypt（64 字节派生）+ 每密码独立 salt；改密码会换 `secret` 并把 `auth.version` +1，**所有已签发会话立即失效**。
- Cookie 值 `v1.<body>.<hmac>`，`body = {exp, pv}`；`exp` 绝对时间，`pv` 必须等于当前版本。
- Cookie 属性 `HttpOnly; SameSite=Lax; Path=/`，**刻意不加 `Secure`**：监听器是明文 HTTP，加了会让 HTTP 接入登录后掉线；TLS 由前置代理负责。
- 登录失败按 `socket.remoteAddress` 计数：默认 5 次/分钟，命中后冷却 60 秒，内存态（重启即清空，避免攻击者用失败填满磁盘）。经前置代理时所有外部客户端看到的都是代理地址，会共享同一份额度。

## 代理行为

- 请求头：删 `host/origin/cookie/referer/forwarded/x-forwarded-*/x-real-ip/sec-fetch-*`，设 `host=127.0.0.1:<port>`、`cookie=<内部 cookie>`。
- 响应头：删 `set-cookie`（内部 cookie 不外泄）与 hop-by-hop 头；状态码、正文流式透传。
- WebSocket：`server.on('upgrade')` 独立认证，用 `http.request` 转发升级，101 握手按上游 `rawHeaders` 原样回写（`Sec-WebSocket-Accept` 必须是上游算的），双向 pipe。
- 内部 cookie 缓存 5 分钟，端口变化即重取；DSH Host 重启后端口变，第一次请求会自动换新的。
- `/remote-web-ui/api*` 由插件在公开监听器上就地处理（要求插件会话），**不转发给上游 DSH**；其余 `/remote-web-ui/*` 按普通路径代理，由上游自行响应。

## 远端创建工作区（目录选择器必须 pin 成 browse）

宿主把「选择工作区目录」固定成一次 boot 期二选一：`directory-picker` 行（`@deepseek-ai/dsh-host-directory-picker-auto`）按 `webServer.host`、`connection.allowsRemoteAuthorities`（`trustedHosts`）、SSH、显示会话解析 `native | browse`（`packages/host/directory-picker-auto/src/resolve.ts`）。桌面部署（Windows/macOS、回环、无 `trustedHosts`）**必然解析成 native**：对话框开在 Host 的屏幕上，client 侧 pick 走 Electron preload 注入的 `__DSH_DIRECTORY_PICKER__` 或经 RPC 落到 Host 的 OS chooser，远端浏览器既看不到也点不到——现象就是「远端没法创建工作区」，而本机窗口正常。

本插件在代理这一跳把 `Host` 改写成回环并注入内部 cookie，远端页面被当作 owner，native 交互照常注册，正好把这个问题完整暴露出来。

正解是把交互换成 browse，分两半实现（**不能把 browse 行静态 insert 进 bundle patch**，原因见下）：

- `cordis.patch.yml` 的 `- id: directory-picker` + `disabled: true`：冷启动（全量组合）时禁掉 auto 行。patch 层按 `dsh.profile.bundles` 顺序叠加（`packages/boot/app-boot/src/profile.ts`），本包排在 `@deepseek-ai/dsh-web-app` 之后；`applyPatches` 对非 insert 条目按 id 覆盖（`vendor/include/src/patch.ts`）。卸载插件即撤销这一层。
- `src/host/directory-picker.ts` 的 `installBrowseDirectoryPicker`：apply 时装载 `@deepseek-ai/dsh-host-directory-picker-browse`（`ctx.directoryPicker` 的 browse capability：`list` / `createDirectory`）与 `@deepseek-ai/dsh-client-ui-directory-picker-browse`（页面里的「选择工作区目录」对话框，占 `conversation.hero.workspace.directoryFlow` 与 `sidebar.workspaces.directoryFlow` 两个 single 槽）。**装载前先看 `loader.store['directory-picker']` 有没有 fiber**：运行期「禁用 → 启用」不重放 patch 的 `disabled` 覆盖（plugin-manager 的 `bundleRows` 只发布本 bundle 的 insert 行，`packages/boot/plugin-manager/src/index.ts`），auto 行仍激活且已注册 native 后端；先 `fiber.dispose()` 再 create browse，否则撞 `service "directoryPicker" has been registered at <NativeDirectoryPicker>`（真机报错原文：`启用失败：1 entry did not activate remote-web-ui-directory-picker ...`）。

为什么 browse 行不能静态 insert：静态 insert 在运行期启用时会被立即装载，而同一 patch 文件的 `disabled` 覆盖不重放 → native 后端还在 → 服务重名、整个启用失败。把它交给 Host apply 后，两条路径都能按「先停 native 再装 browse」排序。

browse 的浏览与新建都在页面里，读写的仍是 **Host 文件系统**，返回的路径直接就是 Host 路径；本机桌面窗口也用同一对话框（方案取舍：远端可用优先，代价是本机不弹 Windows 原生框）。

验证口径：冷启动后本机与远端都应看到「选择工作区目录」对话框、`POST /api/directoryPicker/list` 能列出 Host 目录。运行期「禁用 → 启用」只保证 Host 侧切换成功（`$DSH_HOME/remote-web-ui.log` 里没有 `directory picker: ...`）；**页面里已装载的 native client entry 不会卸载**，当前页仍需刷新、或重启桌面后才看得到新对话框——这是 client bundle 的宿主限制，不是本插件的状态丢失。

验证：loader 的 `applyPatches` 先叠 web-app patch 再叠本包 patch，本包把 `directory-picker` 的 `disabled` 覆盖成 `true`（`tests/patch.test.mjs` 守 patch 形态，`tests/directory-picker.test.mjs` 守装载/卸载顺序与部分失败清理）。**静态 insert browse 行会撞服务**有真机报错截图佐证，不是推断。

## 本机专用入口（Windows 系统目录框）

除宿主自带的「添加工作区」（browse 交互，两端可用）外，插件自己还挂一个「选择文件夹…」入口：`conversation.hero.options`（session 作用域，主会话工作区行，紧贴工作区 chip），点一下弹 Windows 系统目录框 → 选中目录 → `workspaces.create({ path })` → `uiWorkspace.startSession(workspaceId, { clearPreviousDraft: false })` 切过去。

**侧栏不放这个入口**：工作区标题行右侧（搜索/视图/加号那一排）是宿主 `WorkspaceBrowser` 的内部按钮组，`sidebar.workspaces` 的子槽只有 directoryFlow 与 session 行，没有 header action；要进那一排只能替换整个 `sidebar.workspaces` 组件（复刻 1400 行，且与 dsh-workspace-sidebar 的替换冲突），不做。侧栏的「添加工作区」用宿主自带加号即可（browse，两端可用）。

hero 行的位置靠 CSS 配合：宿主把插件选项包进 `.heroOptions`（`margin-left:auto` 推到行尾），盒内的 `order` 出不了盒，所以本包把该 div 摊平成 `display: contents`（它无边框/内距/底色，gap 与行同为 2px），再用 `[data-slot=…]` 锚点给三组排 `order`：工作区 chip（宿主默认 0）→ 本入口（1）→ 模式选择器（2）→ 同槽其它插件选项（3）。副作用只此一条：同槽其它条目落到模式选择器之后——宿主里 agentPreset 本就渲染在 heroOptions 之前，这个相对顺序与宿主一致，条目之间的先后不变。

**只在 DSH 桌面客户端里注册**。判断用页面协议：桌面客户端把页面装在自己的自定义协议 `dsh-app://app/` 下（`apps/desktop/src/main.ts` 的 `protocol.handle`，宿主自己判断窗口也用 `mainFrame.url.startsWith('dsh-app://app/')`），普通浏览器——含远程入口与本机浏览器——都是 http/https。`location.protocol === 'dsh-app:'` 即精确信号；`window.__DSH_DIRECTORY_PICKER__` 存在与否同样可用，但协议更直接。

- Host 侧 `src/host/native-pick.ts`：`powershell.exe -NoProfile -NonInteractive -STA -EncodedCommand <UTF-16LE base64>` 跑 `System.Windows.Forms.FolderBrowserDialog`；10 分钟超时、AbortSignal 取消（kill 子进程）、stdout 去行尾换行、空输出=用户取消。
- 为什么不复用宿主 `@deepseek-ai/dsh-host-directory-picker-native`：它在宿主 asar 的依赖树里，本包裸 `import` 从插件目录解析不到；经 `ctx.loader` 加载会实例化其 default class 并注册 `ctx.directoryPicker`，与远端可用的 browse 后端重名。所以只能自己弹系统框（经典对话框，观感比宿主那套 IFileOpenDialog 旧）。
- API：`POST /remote-web-ui/api/pick-directory`（JSON body），`handleApi` 的 `mount.nativePick` 只有本机 DSH webServer 挂载面是 `true`；插件的公开监听器面固定 `false` → 404（远端即使硬调也弹不出框）。失败回 501 + 错误原文。
- 创建后切换与宿主 `WorkspaceBrowser` 的 `onPick` 同路径；`workspaces`/`uiWorkspace` 由 ui-workspace 的 client 提供，到达顺序不保证，用 `ctx.inject(['workspaces','uiWorkspace'], …)` 等待。

验证：`pnpm test` 覆盖选择器成功/取消/非零退出/abort（`tests/native-pick.test.mjs`）与两端挂载面差异（`tests/pick-api.test.mjs`）；客户端 UI 与宿主交互尚需真机截图验收。

## 样式与字号（本地副本）

两个 CSS Modules：`src/client/SettingsTab.module.css` 与 `src/client/CreateWorkspace.module.css`，类名前缀 `dsrw-`。设计语言以宿主 checkout 为唯一来源：视觉按名引用 `--dsw-*` token；兜底用 CSS 系统色（Canvas / CanvasText / GrayText / AccentColor 及其 color-mix），**禁止抄宿主 hex**；实心状态色块前景用 `--dsw-alias-bg-layer-3` 或 `--dsw-alias-label-primary-foreground`；`border-radius: 50%` / `999px` 等不封顶圆角必须在同一规则里配 `corner-shape: round`（宿主给 `*` 套了 `superellipse(1.5)`）；禁止 inline style 对象，样式写 `*.module.css`、构建期 lightningcss 编译、factory 求值期注入带 `data-plugin-css` 的 `<style>`；`[data-slot]` 是唯一稳定锚点，CSS Module 类名带哈希不可当契约。

**字号响应（全插件统一）**：字号随 `--dsh-content-font-size`（标准 14px）缩放；14/15px 用设计字号，更小以用户字号为上限，更大按 `max(0, 用户字号 - 15px)` 增量上调。变量块贴在本插件主 CSS 顶部（两份 CSS 共用一份、同一 bundle 一起注入）：

```css
body {
  --dsh-plugin-font-boost: max(0px, calc(var(--dsh-content-font-size, 14px) - 15px));
  --dsh-plugin-fs-11: min(var(--dsh-content-font-size, 14px), calc(11px + var(--dsh-plugin-font-boost)));
  --dsh-plugin-fs-12: min(var(--dsh-content-font-size, 14px), calc(12px + var(--dsh-plugin-font-boost)));
  --dsh-plugin-fs-13: min(var(--dsh-content-font-size, 14px), calc(13px + var(--dsh-plugin-font-boost)));
  --dsh-plugin-fs-14: min(var(--dsh-content-font-size, 14px), calc(14px + var(--dsh-plugin-font-boost)));
}
```

- 四档按信息层级：11 = 角标/计数/代码片段/标签胶囊；12 = 辅助说明与元信息；13 = 正文与行标题；14 = 输入框/按钮文字；没有 10px 档。
- 11–14px 写 `var(--dsh-plugin-fs-N, Npx)`；16px+ 结构字号写 `calc(16px + var(--dsh-plugin-font-boost, 0px))`；固定行高同步加 boost。
- `happy-dom` 不解析 `min()`：结构断言测试要把 `--dsh-plugin-fs-*` 覆盖成设计值。

## client bundle 与模块表（本地副本）

`require` 三层 = 平台种子表 `PLATFORM_MODULES`（11 项，所有 bundle 共享，require 第一跳命中，与 `dsh.client` 声明无关）→ graph 行（声明 `dsh.client` + `exports["./client"]` 的包；要稳定 require 别的包就列进 `dsh.client.external`，未到达抛 `missed the module table`）→ 包内 `require.async` 局部 chunk。`dsh.client` 四字段：`platform` 只认 `'web'`、`inject` = 组合进 entry + factory 先到、`external` 只管模块表请求、`immediately` 启动期预取。表外依赖（`clsx` 等）require 不到；宿主包 face 全 type 绑定写 `import type`。产物检查保持 `lib/client.js` 里没有 `require("@deepseek-ai/...")`、`__ModuleLoader__.load` 的 id 是包名。

## 坑

> ⚠️ **loader 行 id 不能叫 `remote-access`（撞官方行）**
> 症状：装本插件后桌面冷启动报 `desktop welcome: Web request failed` 反复起不来，报错完全不指向本插件。
> 根因：官方 base bundle 的 `remote-access` 行（`@deepseek-ai/dsh-api-remote-access`）提供 `ctx.remoteAccess` 服务；同名 insert 把官方行顶掉，api-gateway/session-controller/workspace-controller/api-remotes/ui-deliverables 五条目永远 pending，`/api/settings/describe` 404。
> 正解：行 id 用包名去前缀的 `remote-web-ui`（与官方 `remote-access` 不同名）。排查利器：用与桌面相同方式手动起 Host（Electron exe + `ELECTRON_RUN_AS_NODE=1` + `dsh-desktop-host/lib/index.js <asar/dsh> <profile> <primaryRuntime> <pnpm.mjs> <bin>`），stderr 会直接点名 pending 链，再按桌面同序列 curl `/api/settings/describe` 看真实状态码。

> ⚠️ **`list_plugins` 的 `fiberPhase` 不等于 `apply` 已执行**
> 症状：新装的 insert 行显示 active，但插件没有任何副作用。
> 根因：该字段来自静态清单；新行尚未进入 loader 组合。
> 正解：以 `Config.listConfigs` 能否找到 entry、以及 `apply` 的副作用为准（判据见「装载与热重载」）。

> ⚠️ **测试直读 `src/` 时不能用构造函数参数属性**
> 症状：`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode`。
> 正解：显式字段 + 构造函数赋值（`src/host/server.ts` 的 `options`）。

> ⚠️ **`Origin` 必须删而不是改写**
> 症状：只改写 `Host` 时，页面能打开但所有 `/api` 返回 403。
> 根因：栅栏在 `Origin` 存在时要求它与 `Host` 同 authority，改 `Host` 反而制造了不一致。
> 正解：删掉 `Origin`（栅栏把"没有 Origin"视为非浏览器跨站请求）并同时删 `sec-fetch-*`。

> ⚠️ **远端「添加工作区」点了没反应：宿主的目录选择器是 native**
> 症状：本机桌面窗口创建工作区正常，经远程入口的浏览器里点「添加工作区」后没有可用的选择界面；若坐在 Host 前，会看到 Windows 原生目录框弹在 Host 桌面上。
> 根因：宿主 `directory-picker-auto` 在桌面部署（回环 + 无 `trustedHosts`）下 boot 期固定选 native；远端页面被本插件代理当作 owner，native 交互照常注册，但那套交互只服务 Host 的屏幕/桌面 bridge。
> 正解：本包在 bundle patch 里禁用 `directory-picker` 行（冷启动），并由 Host apply 装载 browse 后端 + 表面（详见「远端创建工作区」）。宿主升级后若行 id 或 browse 包名变化，症状会复发：先 `grep directory-picker packages/bundle/web-app/cordis.patch.yml` 复核行 id，再看 `packages/host/directory-picker-auto/src/index.ts` 的 `BACKEND_PACKAGES`/`SURFACE_PACKAGES`。

> ⚠️ **运行期「禁用 → 启用」报 `service "directoryPicker" has been registered`**
> 症状：插件管理页点启用，弹出「启用失败：1 entry did not activate remote-web-ui-directory-picker (@deepseek-ai/dsh-host-directory-picker-browse): Error: service "directoryPicker" has been registered at <NativeDirectoryPicker>」。
> 根因：`setBundleEnabled` 只发布本 bundle 的 insert 行（`bundleRows` 只组合本包 patch），**bundle patch 里针对别家行的 `disabled` 覆盖不会重放**；auto 还在跑，静态 insert 的 browse 后端撞同名服务。
> 正解：browse 两行不写进 patch，由 `src/host/directory-picker.ts` 在 apply 里「先停 auto 的 fiber，再 create」；patch 只保留 `- id: directory-picker` + `disabled: true` 供冷启动。改动后要重新启用/重启验证。

> ⚠️ **挪动 hero 行的位置会把同槽其它插件的条目一起带走**
> 症状：入口做成「紧贴工作区 chip」时，同槽其它插件条目（`@jia-tools/dsh-session-context-config`，`order: 20`）跟着前移，页面顺序变成「工作区 chip → 本入口 → 档位 chip → 模式选择器」；要求是「工作区 chip → 本入口 → 模式选择器 → 档位 chip」。
> 根因：宿主把 `conversation.hero.options` 包在 `.heroOptions` 盒子里（`margin-left:auto` 推到行尾），盒内条目的 `order` 出不了盒；「`margin-left:0` + 把 agentPreset 推到 `order:1`」会让整个盒子先于模式选择器，盒内所有条目一起前移。
> 正解：`display:contents` 摊平该 div（它没有自己的视觉，gap 与行同为 2px），子项直接参与行内 flex 排布，再按 `[data-slot]` 锚点分三段排 `order`，见「本机专用入口」。

## 约定

- 全文中文；代码标识符英文。
- 包名 `dsh-` + kebab-case；行 id 是包名去掉 `dsh-` 前缀，即 `remote-web-ui`。**不能叫 `remote-access`**：官方 base bundle 已占该行（提供 `ctx.remoteAccess` 服务），同名 insert 会顶掉它，见坑。
- 不导出 `Config`：Host 侧保持零宿主依赖，配置由插件自己的数据文件 + 设置页 API 承担。想改成 settings 表单就得引入 schemastery 的 vendor 构建，得不偿失。
- 文档与代码冲突时以代码为准。
