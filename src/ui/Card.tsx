import type { ReactNode } from 'react'
import { Surface, type SurfaceShape } from './Surface'
import { Icon } from './Icon'
import { cx } from './utils'
import './Card.css'

export type CardVariant = 'elevated' | 'filled' | 'outlined'

export interface CardProps {
  variant?: CardVariant
  shape?: SurfaceShape
  glass?: boolean
  className?: string
  children?: ReactNode
}

export function Card({ variant = 'filled', shape = 'extra-large', glass, className, children }: CardProps) {
  const level = variant === 'elevated' ? 1 : variant === 'filled' ? 2 : 0
  return (
    <Surface
      level={level}
      shape={shape}
      glass={glass}
      outlined={variant === 'outlined'}
      className={cx('md-card', className)}
    >
      {children}
    </Surface>
  )
}

export interface CardHeaderProps {
  icon?: string
  overline?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  trailing?: ReactNode
  className?: string
}

export function CardHeader({ icon, overline, title, subtitle, trailing, className }: CardHeaderProps) {
  return (
    <header className={cx('md-card__header', className)}>
      {icon && (
        <span className="md-card__header-icon">
          <Icon name={icon} size={20} />
        </span>
      )}
      <div className="md-card__header-text">
        {overline && <p className="md-type-label-small md-card__overline">{overline}</p>}
        <h3 className="md-type-title-medium is-emphasized">{title}</h3>
        {subtitle && <p className="md-type-body-small md-card__subtitle">{subtitle}</p>}
      </div>
      {trailing && <div className="md-card__header-trailing">{trailing}</div>}
    </header>
  )
}

export function CardBody({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cx('md-card__body', className)}>{children}</div>
}

export function CardActions({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cx('md-card__actions', className)}>{children}</div>
}
