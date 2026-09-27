import type { ReactNode } from 'react'
import { Surface } from './Surface'
import { cx } from './utils'
import './Toolbar.css'

export interface ToolbarProps {
  /** Barre flottante posee sur la scene : fond plein, trait fort. */
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
      className={cx('wu-toolbar', `wu-toolbar--${align}`, vertical && 'wu-toolbar--vertical', className)}
    >
      {children}
    </Surface>
  )
}

export function ToolbarGroup({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('wu-toolbar__group', className)}>{children}</div>
}
