import type { ReactNode } from 'react'
import { Icon } from './Icon'
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
 * Rail de navigation : pilule pleine sur la destination active, bascule
 * automatiquement en barre inferieure sous 900 px.
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
    <nav className={cx('wu-nav-rail', className)} aria-label="Navigation principale">
      {header && <div className="wu-nav-rail__header">{header}</div>}
      <ul className="wu-nav-rail__list">
        {destinations.map((d) => {
          const active = d.value === value
          return (
            <li key={d.value}>
              <button
                type="button"
                aria-current={active ? 'page' : undefined}
                className={cx('wu-nav-rail__item', active && 'is-active')}
                onClick={() => onChange(d.value)}
              >
                <span className="wu-nav-rail__indicator">
                  <Icon name={d.icon} size={24} filled={active} />
                  {d.badge != null && <span className="wu-nav-rail__badge wu-type-label">{d.badge}</span>}
                </span>
                <span className={cx('wu-nav-rail__label', 'wu-type-caption', active && 'is-emphasized')}>{d.label}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {footer && <div className="wu-nav-rail__footer">{footer}</div>}
    </nav>
  )
}
