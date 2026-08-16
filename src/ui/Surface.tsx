import type { CSSProperties, ElementType, ReactNode } from 'react'
import { cx } from './utils'
import './Surface.css'

export type SurfaceLevel = 0 | 1 | 2 | 3 | 4 | 5
export type SurfaceShape =
  | 'none'
  | 'extra-small'
  | 'small'
  | 'medium'
  | 'large'
  | 'large-increased'
  | 'extra-large'
  | 'extra-large-increased'
  | 'extra-extra-large'
  | 'full'

export interface SurfaceProps {
  as?: ElementType
  /** Niveau d'elevation MD3 : pilote l'ombre et la teinte du conteneur. */
  level?: SurfaceLevel
  shape?: SurfaceShape
  /** Fond translucide + flou : pour le chrome pose sur la scene 3D. */
  glass?: boolean
  outlined?: boolean
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

/**
 * Brique de base de tout conteneur : traduit un niveau d'elevation et un palier
 * de l'echelle de forme en tokens CSS. Tous les panneaux en derivent.
 */
export function Surface({
  as: Tag = 'div',
  level = 0,
  shape = 'large',
  glass = false,
  outlined = false,
  className,
  style,
  children,
}: SurfaceProps) {
  return (
    <Tag
      className={cx('md-surface', `md-surface--l${level}`, glass && 'md-surface--glass', outlined && 'md-surface--outlined', className)}
      style={{ '--_shape': `var(--md-sys-shape-corner-${shape})`, ...style } as CSSProperties}
    >
      {children}
    </Tag>
  )
}
