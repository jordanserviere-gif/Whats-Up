import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { Ripple } from './Ripple'
import { cx } from './utils'
import './NavigationRail.css'

export interface NavDestination<T extends string> {
  value: T
  label: string
  icon: string
  badge?: number | string
}

export interface NavigationRailProps<T extends string> {
  destinations: ReadonlyArray<NavDestination<T>>
  value: T
  onChange: (value: T) => void
  header?: ReactNode
  footer?: ReactNode
  className?: string
}

/**
 * Rail de navigation MD3 Expressive : indicateur pilule anime au ressort,
 * bascule automatiquement en barre inferieure sous 900 px.
 */
export function NavigationRail<T extends string>({
  destinations,
  value,
  onChange,
  header,
  footer,
  className,
}: NavigationRailProps<T>) {
  return (
    <nav className={cx('md-nav-rail', className)} aria-label="Navigation principale">
      {header && <div className="md-nav-rail__header">{header}</div>}
      <ul className="md-nav-rail__list">
        {destinations.map((d) => {
          const active = d.value === value
          return (
            <li key={d.value}>
              <button
                type="button"
                aria-current={active ? 'page' : undefined}
                className={cx('md-nav-rail__item', active && 'is-active')}
                onClick={() => onChange(d.value)}
              >
                <span className="md-nav-rail__indicator">
                  <Ripple />
                  <Icon name={d.icon} size={24} filled={active} />
                  {d.badge != null && <span className="md-nav-rail__badge md-type-label-small">{d.badge}</span>}
                </span>
                <span className={cx('md-nav-rail__label', 'md-type-label-medium', active && 'is-emphasized')}>{d.label}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {footer && <div className="md-nav-rail__footer">{footer}</div>}
    </nav>
  )
}
