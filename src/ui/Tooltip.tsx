import type { ReactNode } from 'react'
import { cx } from './utils'
import './Tooltip.css'

export interface TooltipProps {
  content: ReactNode
  placement?: 'top' | 'bottom' | 'start' | 'end'
  /** Info-bulle riche : conteneur clair, titre + texte, plus large. */
  rich?: boolean
  title?: string
  className?: string
  children: ReactNode
}

/** Info-bulle purement CSS : aucun repositionnement JS, donc zero cout au rendu. */
export function Tooltip({ content, placement = 'top', rich = false, title, className, children }: TooltipProps) {
  return (
    <span className={cx('wu-tooltip-anchor', className)}>
      {children}
      <span role="tooltip" className={cx('wu-tooltip', `wu-tooltip--${placement}`, rich && 'wu-tooltip--rich')}>
        {rich && title && <span className="wu-type-title-s is-emphasized wu-tooltip__title">{title}</span>}
        <span className={rich ? 'wu-type-body-m' : 'wu-type-body-s'}>{content}</span>
      </span>
    </span>
  )
}
