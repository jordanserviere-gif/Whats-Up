import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { cx } from './utils'
import './DataRow.css'

export interface DataRowProps {
  label: ReactNode
  value: ReactNode
  unit?: string
  icon?: string
  /** Met la valeur en avant (couleur primaire + graisse). */
  emphasis?: boolean
  hint?: string
  className?: string
}

/** Ligne « libelle → valeur » pour les fiches d'ephemerides. */
export function DataRow({ label, value, unit, icon, emphasis = false, hint, className }: DataRowProps) {
  return (
    <div className={cx('md-data-row', emphasis && 'is-emphasis', className)} title={hint}>
      {icon && <Icon name={icon} size={18} className="md-data-row__icon" />}
      <span className="md-type-body-medium md-data-row__label">{label}</span>
      <span className="md-data-row__value md-numeric md-type-label-large">
        {value}
        {unit && <span className="md-data-row__unit"> {unit}</span>}
      </span>
    </div>
  )
}

export interface StatTileProps {
  label: string
  value: ReactNode
  unit?: string
  icon?: string
  tone?: 'neutral' | 'primary' | 'secondary' | 'tertiary'
  className?: string
}

/** Tuile de statistique : grande valeur, libelle discret. */
export function StatTile({ label, value, unit, icon, tone = 'neutral', className }: StatTileProps) {
  return (
    <div className={cx('md-stat-tile', `md-stat-tile--${tone}`, className)}>
      <div className="md-stat-tile__head">
        {icon && <Icon name={icon} size={18} />}
        <span className="md-type-label-medium">{label}</span>
      </div>
      <p className="md-stat-tile__value md-numeric">
        {value}
        {unit && <span className="md-stat-tile__unit"> {unit}</span>}
      </p>
    </div>
  )
}

export function DataGrid({ columns = 2, className, children }: { columns?: number; className?: string; children: ReactNode }) {
  return (
    <div className={cx('md-data-grid', className)} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {children}
    </div>
  )
}
