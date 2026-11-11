/**
 * 设置导航行的图标（槽位 `settings.section.icon`，id 必须等于对应 section 的 id）。
 *
 * 手写而不用宿主 ui-primitives 的 `IconGlobeOutlineMedium`：本包 client 产物刻意
 * 不含任何 `@deepseek-ai/*` require（见 AGENTS.md「产物检查」）。模块表缺项会让整个
 * entry 激活失败，桌面端 web-boot 门禁随即回滚 profile——为一个 16px 字形付这个风险不值。
 * 地球 = 「从外部 Web 进来」，与「本机 / 局域网」那几行是同一层语义。
 */
import type { ReactNode } from 'react'

/** 宿主导航行传给图标的 props（`SettingsSectionIconOwnerProps`）。 */
export interface SectionIconProps {
  /** 请求的方形边长；导航行固定 16。 */
  size: number
  /** 该分区是否为当前选中项。宿主默认字形不区分，这里也不用。 */
  active: boolean
}

/** 渲染地球字形。 */
export function RemoteAccessNavIcon({ size }: SectionIconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.1" />
      <ellipse cx="8" cy="8" rx="2.7" ry="6.1" />
      <path d="M1.9 8h12.2" />
    </svg>
  )
}
