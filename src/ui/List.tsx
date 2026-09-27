import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { cx } from './utils'
import './List.css'

export function List({ className, children }: { className?: string; children: ReactNode }) {
  return <ul className={cx('wu-list', className)}>{children}</ul>
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
    <li className={cx('wu-list-item', selected && 'is-selected', disabled && 'is-disabled', interactive && 'is-interactive', className)}>
      {interactive ? (
        <button type="button" className="wu-list-item__surface" onClick={onClick} disabled={disabled} aria-pressed={selected}>
          <ListItemContent {...{ headline, supportingText, overline, trailingText, leadingIcon, leadingDot, leading, trailing }} />
        </button>
      ) : (
        <div className="wu-list-item__surface">
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
      {leadingDot && <span className="wu-list-item__dot" style={{ background: leadingDot }} />}
      {leadingIcon && <Icon name={leadingIcon} size={22} className="wu-list-item__icon" />}
      {leading}
      <span className="wu-list-item__text">
        {overline && <span className="wu-type-label wu-list-item__overline">{overline}</span>}
        <span className="wu-type-body wu-list-item__headline">{headline}</span>
        {supportingText && <span className="wu-type-body-s wu-list-item__support">{supportingText}</span>}
      </span>
      {trailingText && <span className="wu-type-strong wu-numeric wu-list-item__trailing-text">{trailingText}</span>}
      {trailing}
    </>
  )
}

export function ListSubheader({ children }: { children: ReactNode }) {
  return <li className="wu-type-caption is-emphasized wu-list__subheader">{children}</li>
}
