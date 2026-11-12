/**
 * 本地构建 preset:在独立仓库里复刻官方 `packages/client/tsdown.client.ts` 的产物契约。
 *
 * 官方 preset 不能直接 import——它依赖 checkout 内部文件(web/src/platform.ts、modules/src/assets.ts、
 * scripts/*),外部仓库拿不到。这里只复刻产物契约四条(镜像 2026-11-08 对 tag dsh-v0.2.2-rc.1 的实证):
 *   1. client 产物调 window.__ModuleLoader__.load({ id: <包名>, factory }),id 必须等于包名;
 *   2. externals = 平台基线(PLATFORM_MODULES,11 项)+ 包声明 dsh.client.external;
 *      基线在构建期用 DSH_SRC 指向 checkout 校验,清单不符显式报错,不静默放行;
 *   3. *.module.css 由 lightningcss 编译成类名映射,并在 factory 执行时按文件注入带 tag 的
 *      <style>(tag=包名/文件名,attr 与官方一致);Node 半边输出 lib/index.js,tsc 输出 lib/types/**;
 *   4. build.mjs 负责编排:tsc(出 lib/types)→ tsdown(出 lib/index.js + lib/client.js)。
 *
 * 与官方 preset 的偏差(完整清单见 AGENTS.md「与官方 preset 的偏差」):
 * - CSS Modules 类名模式用 `dsrw-[local]` 而非官方 `[hash]_[local]`:本包类名是局部名
 *   (section/header 等,不是完整命名空间名,不能用恒等映射),前缀让真机 DOM 与调试习惯稳定。
 * - client bundle 直接从 src/client/index.ts 构建,不走官方的两段式 lib/types 链
 *   (官方为 host/client 双 pass 架构所需;独立仓库单 pass,sourcemap 直指 TS 源更简单)。
 * - 只实现本仓库用到的契约面:无 assets 路由、无 require.async 局部 chunk、无 bundle 纯度门
 *   (官方的这些门是 workspace 治理;外部仓库无 @deepseek-ai/* 值导入,风险不存在)。
 * - 样式注入经注册表按固定序落盘(官方是每文件独立即注):dsrw-[local] 前缀使跨文件
 *   同名类坍缩为同一全局选择器,最终视觉由 <style> 顺序决定;注册表按 CSS_SHEET_ORDER
 *   等全部到齐后一次性注入,import 链重排不会翻转冲突属性的胜者(本包目前只有一张表,
 *   清单仍是顺序契约)。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'

/** 包根(build/ 的上一级);tsdown 把配置里的相对路径按配置文件目录解析,所以入口一律给绝对路径。 */
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 本插件包名;client 产物的 __ModuleLoader__.load id 与 style tag 都用它。 */
const PKG_NAME = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name

/** CSS Modules 类名前缀(不含连字符)。 */
export const CSS_PREFIX = 'dsrw'

/** 本地钉住的平台基线;每次构建与 checkout 的 platform.ts 比对,漂移即报错。 */
export const PLATFORM_MODULES_BASELINE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const DEFAULT_CHECKOUT = 'D:/workspace/IDE/deepseek-harness'

/**
 * 解析 checkout 根并校验平台基线:环境变量 DSH_SRC 优先,缺省用仓库惯例的 checkout 路径
 * (根 AGENTS.md:checkout 迁移时同步改)。platform.ts 的形状漂移或清单不符都显式抛错。
 */
export function verifyBaseline() {
  const root = process.env.DSH_SRC ?? DEFAULT_CHECKOUT
  const platformPath = resolve(root, 'packages/client/web/src/platform.ts')
  if (!existsSync(platformPath)) {
    throw new Error(`build preset: 找不到 ${platformPath};用 DSH_SRC 指向 deepseek-harness checkout 根`)
  }
  const source = readFileSync(platformPath, 'utf8')
  const start = source.indexOf('export const PLATFORM_MODULES = [')
  const end = start < 0 ? -1 : source.indexOf('] as const', start)
  if (start < 0 || end < 0) {
    throw new Error(`build preset: ${platformPath} 的 PLATFORM_MODULES 形状变了,人工核对后更新本 preset 的提取器与基线`)
  }
  const found = [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1])
  const missing = PLATFORM_MODULES_BASELINE.filter((name) => !found.includes(name))
  const extra = found.filter((name) => !PLATFORM_MODULES_BASELINE.includes(name))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `build preset: 平台基线漂移(对照 ${platformPath})。`
      + (missing.length > 0 ? ` 本地缺: ${missing.join(', ')}。` : '')
      + (extra.length > 0 ? ` checkout 新增: ${extra.join(', ')}。` : '')
      + ' 更新 PLATFORM_MODULES_BASELINE 后重跑。',
    )
  }
  return root
}

/** 包声明的 dsh.client.external(模块表请求);与基线一起构成 client bundle 的请求面。 */
function requestedExternals() {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const external = manifest?.dsh?.client?.external
  if (external === undefined) return []
  if (!Array.isArray(external) || external.some((item) => typeof item !== 'string')) {
    throw new Error('build preset: package.json 的 dsh.client.external 声明必须是字符串数组')
  }
  return external
}

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const CSS_REGISTRY_SPEC = 'dsh-css-registry'
const CSS_REGISTRY_ID = '\0dsh-css-registry.mjs'

/**
 * 样式表的注入顺序清单(相对 src/client 的 POSIX 路径)。顺序是视觉契约的一部分:
 * 前缀式类名让跨文件同名类坍缩成同一选择器,冲突属性的胜者由后注入的表决定
 * (rows 两文件的 iconButton/renameInput 同属性冲突,Browser 版在迁移前就是胜者)。
 * 清单与迁移前自制编译聚合表的 sort 序逐条一致;新增 *.module.css 必须登记进这里,
 * 漏登记构建直接报错,而不是静默注入乱序或无样式。
 */
const CSS_SHEET_ORDER = [
  // 字体变量（body 上的 --dsh-plugin-fs-*）在第一个表里定义，后面的表引用它。
  'SettingsTab.module.css',
  'CreateWorkspace.module.css',
]

/** 扫描 src/client 下实际存在的 *.module.css(POSIX 相对路径,目录递归)。 */
function scanCssSheets() {
  const clientDir = resolve(PKG_ROOT, 'src/client')
  const out = []
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) visit(path)
      else if (name.endsWith('.module.css')) out.push(relative(clientDir, path).split(sep).join('/'))
    }
  }
  visit(clientDir)
  return out
}

/** 清单必须与磁盘文件集完全一致:多出的文件没登记(顺序未定义)、清单里的文件不存在(永不到齐)。 */
function verifySheetOrder() {
  const found = scanCssSheets()
  const extra = found.filter((rel) => !CSS_SHEET_ORDER.includes(rel))
  const missing = CSS_SHEET_ORDER.filter((rel) => !found.includes(rel))
  if (extra.length > 0 || missing.length > 0) {
    throw new Error(
      'build preset: CSS 清单漂移。'
      + (extra.length > 0 ? ` 未登记: ${extra.join(', ')}(顺序敏感,登记进 CSS_SHEET_ORDER)。` : '')
      + (missing.length > 0 ? ` 清单里不存在: ${missing.join(', ')}。` : ''),
    )
  }
}

/**
 * 样式注册表模块:各 *.module.css 注入器把编译产物登记进来,全部到齐后按
 * CSS_SHEET_ORDER 一次性注入(顺序即视觉契约,见 CSS_SHEET_ORDER 注释)。
 */
function registryModule() {
  return [
    `const ORDER = ${JSON.stringify(CSS_SHEET_ORDER)};`,
    `const PKG = ${JSON.stringify(PKG_NAME)};`,
    'const pending = new Map();',
    'let flushed = false;',
    'export function register(rel, css) {',
    '  if (typeof document === \'undefined\') return;',
    '  const tagId = PKG + \'/\' + rel.split(\'/\').pop();',
    '  if (document.querySelector(\'style[data-plugin-css="\' + tagId + \'"]\') !== null) { flushed = true; return; }',
    '  pending.set(rel, css);',
    '  if (!flushed && pending.size === ORDER.length) {',
    '    flushed = true;',
    '    for (const sheet of ORDER) {',
    '      const sheetCss = pending.get(sheet);',
    '      if (sheetCss === undefined) continue;',
    '      const tag = document.createElement(\'style\');',
    '      tag.dataset.plugin = PKG;',
    '      tag.dataset.pluginCss = PKG + \'/\' + sheet.split(\'/\').pop();',
    '      tag.textContent = sheetCss;',
    '      document.head.appendChild(tag);',
    '    }',
    '  }',
    '}',
  ].join('\n')
}

/**
 * 生成一个注入器模块:import 它的瞬间把编译产物登记进注册表(全部到齐后按
 * CSS_SHEET_ORDER 注入),并 default 导出类名映射。
 */
function styleInjectionModule(fileId, css, classMap) {
  const rel = relative(resolve(PKG_ROOT, 'src/client'), fileId).split(sep).join('/')
  return [
    `import { register } from '${CSS_REGISTRY_SPEC}';`,
    `register(${JSON.stringify(rel)}, ${JSON.stringify(css)});`,
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/** CSS Modules 内联插件(官方 dsh-css-modules-inline 的契约复刻):编译 + 类名映射 + 注册表注入。 */
function cssModulesPlugin() {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source, importer) {
      if (source === CSS_REGISTRY_SPEC) return CSS_REGISTRY_ID
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolve(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (virtualId === CSS_REGISTRY_ID) return registryModule()
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await import('node:fs/promises').then((m) => m.readFile(fileId))
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: `${CSS_PREFIX}-[local]` },
        minify: true,
      })
      // lightningcss 的 exports 键序跟随内部哈希表迭代,同一文件每次进程都可能不同;
      // 不排序会让生成的类名映射顺序抖动,lib/client.js 因此逐次构建字节不一致
      // (实测连续三次构建三个不同哈希)。按键名排序把产物钉成字节可重复。
      const classMap = {}
      for (const local of Object.keys(cssExports ?? {}).sort()) classMap[local] = cssExports[local].name
      return styleInjectionModule(fileId, code.toString(), classMap)
    },
  }
}

/** client 产物的 banner/footer:factory 包装形态与官方逐字一致,id 必须是包名(契约 1)。 */
function factoryWrapper() {
  return {
    banner: () => `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  }
}

/**
 * 两条 tsdown 配置:Node 半边(tsc 产物 lib/types/index.js → lib/index.js 单文件)
 * 与浏览器半边(src/client/index.ts → lib/client.js,factory 形态)。
 */
export function makeConfigs() {
  verifyBaseline()
  verifySheetOrder()
  const externals = new Set([...PLATFORM_MODULES_BASELINE, ...requestedExternals()])
  const isRequested = (specifier) => externals.has(specifier)
  return [
    {
      name: `${PKG_NAME}/node`,
      entry: { index: resolve(PKG_ROOT, 'lib/types/index.js') },
      outDir: resolve(PKG_ROOT, 'lib'),
      format: 'esm',
      platform: 'node',
      target: 'es2024',
      // 固定 .js 扩展名(package.json main 指 lib/index.js;.mjs 会两处失配)。
      fixedExtension: false,
      dts: false,
      clean: false,
    },
    {
      name: `${PKG_NAME}/client`,
      entry: { client: resolve(PKG_ROOT, 'src/client/index.ts') },
      outDir: resolve(PKG_ROOT, 'lib'),
      format: 'cjs',
      platform: 'browser',
      target: 'es2024',
      dts: false,
      sourcemap: true,
      clean: false,
      // 请求面(基线 + dsh.client.external)保持 import,其余一律内联——require 撞不上表就抛
      // missed the module table,所以边界就是包自己的请求清单(官方同款语义)。
      deps: {
        neverBundle: isRequested,
        alwaysBundle: (specifier) => !isRequested(specifier),
      },
      outputOptions: {
        entryFileNames: 'client.js',
        sourcemapExcludeSources: false,
        ...factoryWrapper(),
      },
      plugins: [cssModulesPlugin()],
    },
  ]
}
