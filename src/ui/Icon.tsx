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
          // En rem, pas en px : une icone doit suivre l'echelle d'UI globale
          // (variable racine sur `html`) comme le reste des tokens dimensionnels.
          '--_icon-size': `${size / 16}rem`,
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
