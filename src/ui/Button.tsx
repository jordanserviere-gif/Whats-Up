import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Icon } from './Icon'
import { cx } from './utils'
import './Button.css'

export type ButtonVariant = 'filled' | 'tonal' | 'elevated' | 'outlined' | 'text'
/** Cinq tailles, de 32 a 72 px de haut. */
export type ButtonSize = 'xs' | 's' | 'm' | 'l' | 'xl'
/** Pilule par defaut, ou angles de 4 px. */
export type ButtonShape = 'round' | 'square'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  shape?: ButtonShape
  icon?: string
  trailingIcon?: string
  /** Etat selectionne : bascule pleine sur l'accent. */
  selected?: boolean
  fullWidth?: boolean
  children?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'filled',
    size = 's',
    shape = 'round',
    icon,
    trailingIcon,
    selected,
    fullWidth,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  const iconSize = size === 'xs' ? 20 : size === 's' ? 20 : size === 'm' ? 24 : size === 'l' ? 32 : 40
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      aria-pressed={selected === undefined ? undefined : selected}
      className={cx(
        'wu-button',
        `wu-button--${variant}`,
        `wu-button--${size}`,
        `wu-button--${shape}`,
        selected && 'is-selected',
        fullWidth && 'wu-button--full',
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={iconSize} filled={selected} />}
      {children != null && <span className="wu-button__label">{children}</span>}
      {trailingIcon && <Icon name={trailingIcon} size={iconSize} />}
    </button>
  )
})
