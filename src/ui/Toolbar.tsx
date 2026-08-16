import type { ReactNode } from 'react'
import { Surface } from './Surface'
import { cx } from './utils'
import './Toolbar.css'

export interface ToolbarProps {
  /** Barre flottante ancree au-dessus du contenu (docked toolbar Expressive). */
  floating?: boolean
  align?: 'start' | 'center' | 'end'
  vertical?: boolean
  className?: string
  children: ReactNode
}

export function Toolbar({ floating = true, align = 'center', vertical = false, className, children }: ToolbarProps) {
  return (
    <Surface
      as="div"
      level={floating ? 3 : 0}
      shape="full"
      glass={floating}
      className={cx('md-toolbar', `md-toolbar--${align}`, vertical && 'md-toolbar--vertical', className)}
    >
      {children}
    </Surface>
  )
}

export function ToolbarGroup({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('md-toolbar__group', className)}>{children}</div>
}
