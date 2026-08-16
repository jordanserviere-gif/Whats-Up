import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { Ripple } from './Ripple'
import { cx } from './utils'
import './List.css'

export function List({ className, children }: { className?: string; children: ReactNode }) {
  return <ul className={cx('md-list', className)}>{children}</ul>
}

export interface ListItemProps {
  headline: ReactNode
  supportingText?: ReactNode
  overline?: ReactNode
  /** Valeur alignee a droite (coordonnee, magnitude…). */
  trailingText?: ReactNode
  leadingIcon?: string
  /** Pastille coloree en tete de ligne. */
  leadingDot?: string
  leading?: ReactNode
  trailing?: ReactNode
  selected?: boolean
  disabled?: boolean
  onClick?: () => void
  className?: string
}

export function ListItem({
  headline,
  supportingText,
  overline,
  trailingText,
  leadingIcon,
  leadingDot,
  leading,
  trailing,
  selected,
  disabled,
  onClick,
  className,
}: ListItemProps) {
  const interactive = Boolean(onClick)
  return (
    <li className={cx('md-list-item', selected && 'is-selected', disabled && 'is-disabled', interactive && 'is-interactive', className)}>
      {interactive ? (
        <button type="button" className="md-list-item__surface" onClick={onClick} disabled={disabled} aria-pressed={selected}>
          <Ripple disabled={disabled} />
          <ListItemContent {...{ headline, supportingText, overline, trailingText, leadingIcon, leadingDot, leading, trailing }} />
        </button>
      ) : (
        <div className="md-list-item__surface">
          <ListItemContent {...{ headline, supportingText, overline, trailingText, leadingIcon, leadingDot, leading, trailing }} />
        </div>
      )}
    </li>
  )
}

function ListItemContent({
  headline,
  supportingText,
  overline,
  trailingText,
  leadingIcon,
  leadingDot,
  leading,
  trailing,
}: Omit<ListItemProps, 'selected' | 'disabled' | 'onClick' | 'className'>) {
  return (
    <>
      {leadingDot && <span className="md-list-item__dot" style={{ background: leadingDot }} />}
      {leadingIcon && <Icon name={leadingIcon} size={22} className="md-list-item__icon" />}
      {leading}
      <span className="md-list-item__text">
        {overline && <span className="md-type-label-small md-list-item__overline">{overline}</span>}
        <span className="md-type-body-large md-list-item__headline">{headline}</span>
        {supportingText && <span className="md-type-body-small md-list-item__support">{supportingText}</span>}
      </span>
      {trailingText && <span className="md-type-label-large md-numeric md-list-item__trailing-text">{trailingText}</span>}
      {trailing}
    </>
  )
}

export function ListSubheader({ children }: { children: ReactNode }) {
  return <li className="md-type-label-medium is-emphasized md-list__subheader">{children}</li>
}
