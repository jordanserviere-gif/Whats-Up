import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { cx } from './utils'
import './Badge.css'

export interface BadgeProps {
  children: ReactNode
  tone?: 'primary' | 'secondary' | 'tertiary' | 'error' | 'neutral'
  icon?: string
  /** Pastille coloree a la place de l'icone. */
  dot?: string
  className?: string
}

/** Etiquette compacte : statut, unite, categorie. */
export function Badge({ children, tone = 'neutral', icon, dot, className }: BadgeProps) {
  return (
    <span className={cx('md-badge', `md-badge--${tone}`, className)}>
      {dot && <span className="md-badge__dot" style={{ background: dot }} />}
      {icon && <Icon name={icon} size={14} />}
      <span className="md-type-label-small is-emphasized">{children}</span>
    </span>
  )
}
