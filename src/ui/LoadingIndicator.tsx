import { cx } from './utils'
import './LoadingIndicator.css'

export interface LoadingIndicatorProps {
  /** 0..1 pour un indicateur determine ; omis = indetermine. */
  progress?: number
  size?: number
  label?: string
  className?: string
}

/**
 * Indicateur de chargement Expressive : une forme qui morphe en tournant
 * (contained loading indicator), plutot que l'arc circulaire de M3 de base.
 */
export function LoadingIndicator({ progress, size = 48, label = 'Chargement', className }: LoadingIndicatorProps) {
  const determinate = progress !== undefined
  const r = 18
  const circumference = 2 * Math.PI * r
  return (
    <div
      className={cx('md-loading', determinate ? 'is-determinate' : 'is-indeterminate', className)}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-label={label}
      aria-valuenow={determinate ? Math.round(progress * 100) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <svg viewBox="0 0 48 48" className="md-loading__svg">
        <circle className="md-loading__track" cx="24" cy="24" r={r} />
        <circle
          className="md-loading__arc"
          cx="24"
          cy="24"
          r={r}
          strokeDasharray={determinate ? `${circumference * progress} ${circumference}` : undefined}
        />
      </svg>
    </div>
  )
}

export function LinearProgress({ progress, className }: { progress?: number; className?: string }) {
  const determinate = progress !== undefined
  return (
    <div
      className={cx('md-linear-progress', determinate ? 'is-determinate' : 'is-indeterminate', className)}
      role="progressbar"
      aria-valuenow={determinate ? Math.round(progress * 100) : undefined}
    >
      <div className="md-linear-progress__bar" style={determinate ? { width: `${progress * 100}%` } : undefined} />
      <div className="md-linear-progress__stop" />
    </div>
  )
}
