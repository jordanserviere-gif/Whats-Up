import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Icon } from './Icon'
import { cx } from './utils'
import './Fab.css'

export type FabSize = 'small' | 'medium' | 'large'
export type FabColor = 'primary' | 'secondary' | 'tertiary' | 'surface'

export interface FabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string
  label: string
  /** Affiche le libelle a cote de l'icone (FAB etendu). */
  extended?: boolean
  size?: FabSize
  color?: FabColor
}

export const Fab = forwardRef<HTMLButtonElement, FabProps>(function Fab(
  { icon, label, extended = false, size = 'medium', color = 'primary', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={extended ? undefined : label}
      title={extended ? undefined : label}
      className={cx('wu-fab', `wu-fab--${size}`, `wu-fab--${color}`, extended && 'wu-fab--extended', className)}
      {...rest}
    >
      <Icon name={icon} size={size === 'large' ? 36 : 24} />
      {extended && <span className="wu-fab__label">{label}</span>}
    </button>
  )
})
