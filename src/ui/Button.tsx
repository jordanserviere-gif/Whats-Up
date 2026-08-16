import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Icon } from './Icon'
import { Ripple } from './Ripple'
import { cx } from './utils'
import './Button.css'

export type ButtonVariant = 'filled' | 'tonal' | 'elevated' | 'outlined' | 'text'
/** Expressive introduit cinq tailles de bouton (xs → xl). */
export type ButtonSize = 'xs' | 's' | 'm' | 'l' | 'xl'
/** Expressive introduit la forme carree-arrondie en alternative au stade « full ». */
export type ButtonShape = 'round' | 'square'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  shape?: ButtonShape
  icon?: string
  trailingIcon?: string
  /** Etat selectionne : la forme morphe de « round » a « square » (shape morphing). */
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
        'md-button',
        `md-button--${variant}`,
        `md-button--${size}`,
        `md-button--${shape}`,
        selected && 'is-selected',
        fullWidth && 'md-button--full',
        className,
      )}
      {...rest}
    >
      <Ripple disabled={disabled} />
      {icon && <Icon name={icon} size={iconSize} filled={selected} />}
      {children != null && <span className="md-button__label">{children}</span>}
      {trailingIcon && <Icon name={trailingIcon} size={iconSize} />}
    </button>
  )
})
