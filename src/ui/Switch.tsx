import { useId } from 'react'
import { cx } from './utils'
import './Switch.css'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  supportingText?: string
  disabled?: boolean
  className?: string
}

export function Switch({ checked, onChange, label, supportingText, disabled, className }: SwitchProps) {
  const id = useId()
  return (
    <div className={cx('wu-switch-row', disabled && 'is-disabled', className)}>
      {label && (
        <label className="wu-switch-row__text" htmlFor={id}>
          <span className="wu-type-body">{label}</span>
          {supportingText && <span className="wu-type-body-s wu-switch-row__support">{supportingText}</span>}
        </label>
      )}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={cx('wu-switch', checked && 'is-checked')}
        onClick={() => onChange(!checked)}
      >
        <span className="wu-switch__track">
          <span className="wu-switch__handle" />
        </span>
      </button>
    </div>
  )
}
