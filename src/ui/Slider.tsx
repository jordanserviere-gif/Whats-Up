import { useId, type CSSProperties } from 'react'
import { cx, clamp } from './utils'
import './Slider.css'

export interface SliderProps {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  label?: string
  /** Valeur formatee affichee au-dessus de la poignee. */
  format?: (value: number) => string
  showValue?: boolean
  disabled?: boolean
  /** Repere fixe sur la piste (ex. « maintenant » sur la frise temporelle). */
  anchor?: number
  className?: string
}

/**
 * Slider Material 3 Expressive : poignee en barre, pistes active et inactive
 * separees par un ecart, indicateur de butee. Un `input[type=range]`
 * transparent porte l'accessibilite clavier et pointeur.
 */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  label,
  format,
  showValue = false,
  disabled = false,
  anchor,
  className,
}: SliderProps) {
  const id = useId()
  const pct = max === min ? 0 : clamp(((value - min) / (max - min)) * 100, 0, 100)
  const anchorPct = anchor === undefined || max === min ? null : clamp(((anchor - min) / (max - min)) * 100, 0, 100)
  const text = format ? format(value) : String(value)

  return (
    <div className={cx('md-slider', disabled && 'is-disabled', className)} style={{ '--_pct': `${pct}%` } as CSSProperties}>
      {(label || showValue) && (
        <div className="md-slider__header">
          {label && (
            <label className="md-type-label-medium md-slider__label" htmlFor={id}>
              {label}
            </label>
          )}
          {/* La valeur se lit en permanence ici. La bulle qui suit la poignee ne
            * paraît que pendant la manipulation : posee au-dessus de la piste,
            * elle recouvrait le libelle le reste du temps. */}
          {showValue && <span className="md-type-label-medium is-emphasized md-slider__readout">{text}</span>}
        </div>
      )}
      <div className="md-slider__track-row">
        <div className="md-slider__track" aria-hidden="true">
          <div className="md-slider__track-active" />
          <div className="md-slider__track-inactive" />
          {anchorPct !== null && <div className="md-slider__anchor" style={{ left: `${anchorPct}%` }} />}
          <div className="md-slider__handle">
            {showValue && (
              <span className="md-slider__value md-type-label-medium is-emphasized" aria-hidden="true">
                {text}
              </span>
            )}
          </div>
        </div>
        <input
          id={id}
          className="md-slider__input"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          aria-valuetext={format ? format(value) : undefined}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    </div>
  )
}
