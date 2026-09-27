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
  /** Niveau du conteneur. Sans ombre dans ce systeme : il ne change que le fond. */
  level?: SurfaceLevel
  shape?: SurfaceShape
  /** Chrome pose sur la scene 3D : fond plein et trait fort, jamais translucide. */
  glass?: boolean
  outlined?: boolean
  className?: string
  style?: CSSProperties
  role?: string
  children?: ReactNode
}

/** Paliers de forme historiques, replies sur les quatre rayons du systeme. */
const RADIUS: Record<SurfaceShape, string> = {
  none: 'var(--radius-0)',
  'extra-small': 'var(--radius-s)',
  small: 'var(--radius-s)',
  medium: 'var(--radius-m)',
  large: 'var(--radius-m)',
  'large-increased': 'var(--radius-l)',
  'extra-large': 'var(--radius-l)',
  'extra-large-increased': 'var(--radius-l)',
  'extra-extra-large': 'var(--radius-l)',
  full: 'var(--radius-pill)',
}

/**
 * Brique de base de tout conteneur : traduit un niveau et un palier de forme en
 * tokens CSS. Tous les panneaux en derivent.
 */
export function Surface({
  as: Tag = 'div',
  level = 0,
  shape = 'large',
  glass = false,
  outlined = false,
  className,
  style,
  role,
  children,
}: SurfaceProps) {
  return (
    <Tag
      role={role}
      className={cx('wu-surface', `wu-surface--l${level}`, glass && 'wu-surface--glass', outlined && 'wu-surface--outlined', className)}
      style={{ '--_shape': RADIUS[shape], ...style } as CSSProperties}
    >
      {children}
    </Tag>
  )
}
