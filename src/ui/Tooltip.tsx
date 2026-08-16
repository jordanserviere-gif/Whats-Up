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
    <span className={cx('md-tooltip-anchor', className)}>
      {children}
      <span role="tooltip" className={cx('md-tooltip', `md-tooltip--${placement}`, rich && 'md-tooltip--rich')}>
        {rich && title && <span className="md-type-title-small is-emphasized md-tooltip__title">{title}</span>}
        <span className={rich ? 'md-type-body-medium' : 'md-type-body-small'}>{content}</span>
      </span>
    </span>
  )
}
