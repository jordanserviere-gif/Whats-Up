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
    <div className={cx('wu-data-row', emphasis && 'is-emphasis', className)} title={hint}>
      {icon && <Icon name={icon} size={18} className="wu-data-row__icon" />}
      <span className="wu-type-body-m wu-data-row__label">{label}</span>
      <span className="wu-data-row__value wu-numeric wu-type-strong">
        {value}
        {unit && <span className="wu-data-row__unit"> {unit}</span>}
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
    <div className={cx('wu-stat-tile', `wu-stat-tile--${tone}`, className)}>
      <div className="wu-stat-tile__head">
        {icon && <Icon name={icon} size={18} />}
        <span className="wu-type-caption">{label}</span>
      </div>
      <p className="wu-stat-tile__value">
        {value}
        {unit && <span className="wu-stat-tile__unit"> {unit}</span>}
      </p>
    </div>
  )
}

export function DataGrid({ columns = 2, className, children }: { columns?: number; className?: string; children: ReactNode }) {
  return (
    <div className={cx('wu-data-grid', className)} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {children}
    </div>
  )
}
