import { cx } from './utils'

export interface IconProps {
  /** Nom du glyphe Material Symbols (ex. « play_arrow »). */
  name: string
  /** Taille en px — correspond aussi a l'axe optique de la fonte. */
  size?: number
  filled?: boolean
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700
  grade?: number
  className?: string
}

/** Glyphe Material Symbols Rounded, pilote par ses axes variables. */
export function Icon({ name, size = 24, filled = false, weight = 400, grade = 0, className }: IconProps) {
  return (
    <span
      className={cx('md-icon', className)}
      aria-hidden="true"
      style={
        {
          '--_icon-size': `${size}px`,
          '--_icon-fill': filled ? 1 : 0,
          '--_icon-weight': weight,
          '--_icon-grade': grade,
          '--_icon-opsz': size,
        } as React.CSSProperties
      }
    >
      {name}
    </span>
  )
}
