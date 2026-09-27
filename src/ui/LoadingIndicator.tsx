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
 * Indicateur de chargement. Indetermine : trois barres penchees aux 12° du
 * logotype, qui s'allument tour a tour. Determine : un anneau plat qui se
 * remplit.
 */
export function LoadingIndicator({ progress, size = 48, label = 'Chargement', className }: LoadingIndicatorProps) {
  const determinate = progress !== undefined
  const r = 18
  const circumference = 2 * Math.PI * r
  return (
    <div
      className={cx('wu-loading', determinate ? 'is-determinate' : 'is-indeterminate', className)}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-label={label}
      aria-valuenow={determinate ? Math.round(progress * 100) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {determinate ? (
        <svg viewBox="0 0 48 48" className="wu-loading__svg">
          <circle className="wu-loading__track" cx="24" cy="24" r={r} />
          <circle className="wu-loading__arc" cx="24" cy="24" r={r} strokeDasharray={`${circumference * progress} ${circumference}`} />
        </svg>
      ) : (
        <span className="wu-loading__bars">
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  )
}

export function LinearProgress({ progress, className }: { progress?: number; className?: string }) {
  const determinate = progress !== undefined
  return (
    <div
      className={cx('wu-linear-progress', determinate ? 'is-determinate' : 'is-indeterminate', className)}
      role="progressbar"
      aria-valuenow={determinate ? Math.round(progress * 100) : undefined}
    >
      <div className="wu-linear-progress__bar" style={determinate ? { width: `${progress * 100}%` } : undefined} />
    </div>
  )
}
