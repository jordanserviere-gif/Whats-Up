import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon } from './Icon'
import { Ripple } from './Ripple'
import { cx } from './utils'
import './Chip.css'

export type ChipVariant = 'assist' | 'filter' | 'input' | 'suggestion'

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ChipVariant
  icon?: string
  selected?: boolean
  /** Pastille de couleur (objets celestes) affichee avant le libelle. */
  dot?: string
  onRemove?: () => void
  elevated?: boolean
  children: ReactNode
}

export function Chip({
  variant = 'assist',
  icon,
  selected = false,
  dot,
  onRemove,
  elevated = false,
  className,
  children,
  ...rest
}: ChipProps) {
  return (
    <button
      type="button"
      role={variant === 'filter' ? 'switch' : undefined}
      aria-checked={variant === 'filter' ? selected : undefined}
      aria-pressed={variant === 'filter' ? undefined : selected || undefined}
      className={cx('md-chip', `md-chip--${variant}`, selected && 'is-selected', elevated && 'is-elevated', className)}
      {...rest}
    >
      <Ripple />
      {dot && <span className="md-chip__dot" style={{ background: dot }} />}
      {variant === 'filter' && selected && !icon && <Icon name="check" size={18} />}
      {icon && <Icon name={icon} size={18} filled={selected} />}
      <span className="md-chip__label">{children}</span>
      {/* Zone de retrait : simple cible cliquable, sans role interactif imbrique
          dans le bouton porteur (ce que la specification HTML interdit). */}
      {onRemove && (
        <span
          className="md-chip__remove"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <Icon name="close" size={18} />
        </span>
      )}
    </button>
  )
}

export function ChipSet({
  className,
  scroll = false,
  children,
}: {
  className?: string
  /** Defilement horizontal plutot que passage a la ligne. */
  scroll?: boolean
  children: ReactNode
}) {
  return <div className={cx('md-chip-set', scroll && 'md-chip-set--scroll', className)}>{children}</div>
}
