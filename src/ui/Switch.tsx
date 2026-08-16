import { useId } from 'react'
import { Icon } from './Icon'
import { cx } from './utils'
import './Switch.css'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  supportingText?: string
  disabled?: boolean
  /** Icone affichee dans la poignee a l'etat actif. */
  icon?: string
  className?: string
}

export function Switch({ checked, onChange, label, supportingText, disabled, icon = 'check', className }: SwitchProps) {
  const id = useId()
  return (
    <div className={cx('md-switch-row', disabled && 'is-disabled', className)}>
      {label && (
        <label className="md-switch-row__text" htmlFor={id}>
          <span className="md-type-body-large">{label}</span>
          {supportingText && <span className="md-type-body-small md-switch-row__support">{supportingText}</span>}
        </label>
      )}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={cx('md-switch', checked && 'is-checked')}
        onClick={() => onChange(!checked)}
      >
        <span className="md-switch__track">
          <span className="md-switch__handle">{checked && <Icon name={icon} size={16} />}</span>
        </span>
      </button>
    </div>
  )
}
