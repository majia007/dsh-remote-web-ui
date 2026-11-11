/**
 * CSS Modules 类型面：构建期由 lightningcss 产出真实映射，运行时类名带 dsrw- 前缀
 * （build/preset.mjs 的 CSS_PREFIX）。
 */
declare module '*.module.css' {
  const classes: { readonly [local: string]: string }
  export default classes
}
