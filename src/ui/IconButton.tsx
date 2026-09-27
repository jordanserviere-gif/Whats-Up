import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Icon } from './Icon'
import { LoadingIndicator } from './LoadingIndicator'
import { cx } from './utils'
import './IconButton.css'

export type IconButtonVariant = 'standard' | 'filled' | 'tonal' | 'outlined'
export type IconButtonSize = 'xs' | 's' | 'm' | 'l'
export type IconButtonWidth = 'narrow' | 'default' | 'wide'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  icon: string
  /** Glyphe affiche a l'etat selectionne (defaut : le meme, rempli). */
  selectedIcon?: string
  variant?: IconButtonVariant
  size?: IconButtonSize
  /** La largeur est un axe independant de la hauteur. */
  width?: IconButtonWidth
  shape?: 'round' | 'square'
  selected?: boolean
  /** Remplace le glyphe par un indicateur, le temps d'une operation en cours. */
  loading?: boolean
  /** Libelle accessible — obligatoire, le bouton n'a pas de texte visible. */
  label: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    selectedIcon,
    variant = 'standard',
    size = 's',
    width = 'default',
    shape = 'round',
    selected,
    loading = false,
    label,
    className,
    disabled,
    ...rest
  },
  ref,
) {
  const iconSize = size === 'xs' ? 20 : size === 's' ? 24 : size === 'm' ? 24 : 32
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={selected === undefined ? undefined : selected}
      className={cx(
        'wu-icon-button',
        `wu-icon-button--${variant}`,
        `wu-icon-button--${size}`,
        `wu-icon-button--w-${width}`,
        `wu-icon-button--${shape}`,
        selected && 'is-selected',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <LoadingIndicator size={iconSize} label={label} className="wu-icon-button__loading" />
      ) : (
        <Icon name={selected && selectedIcon ? selectedIcon : icon} size={iconSize} filled={!!selected} />
      )}
    </button>
  )
})
