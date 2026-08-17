import { Icon } from './Icon'
import { Ripple } from './Ripple'
import { cx } from './utils'
import './SegmentedButton.css'

export interface Segment<T extends string> {
  value: T
  label: string
  icon?: string
  /**
   * Libelle developpe, quand l'abreviation affichee ne se suffit pas.
   * Sert d'etiquette accessible et d'info-bulle native.
   */
  title?: string
  /** Masque le libelle sous les petits ecrans. */
  compact?: boolean
}

export interface SegmentedButtonProps<T extends string> {
  segments: ReadonlyArray<Segment<T>>
  value: T
  onChange: (value: T) => void
  /** Densite compacte pour les barres d'outils flottantes. */
  size?: 's' | 'm'
  fullWidth?: boolean
  ariaLabel: string
  className?: string
}

/** Groupe de boutons connectes (single-select). */
export function SegmentedButton<T extends string>({
  segments,
  value,
  onChange,
  size = 's',
  fullWidth = false,
  ariaLabel,
  className,
}: SegmentedButtonProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cx('md-segmented', `md-segmented--${size}`, fullWidth && 'md-segmented--full', className)}
    >
      {segments.map((seg) => {
        const selected = seg.value === value
        return (
          <button
            key={seg.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={seg.title}
            title={seg.title}
            className={cx('md-segmented__item', selected && 'is-selected')}
            onClick={() => onChange(seg.value)}
          >
            <Ripple />
            {seg.icon && <Icon name={seg.icon} size={18} filled={selected} />}
            <span className={cx('md-segmented__label', 'md-type-label-large', selected && 'is-emphasized', seg.compact && 'md-segmented__label--compact')}>
              {seg.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
