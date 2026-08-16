import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react'
import { Icon } from './Icon'
import { cx } from './utils'
import './TextField.css'

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: string
  /** Unite ou symbole affiche a droite du champ (km, °, …). */
  suffix?: string
  leadingIcon?: string
  supportingText?: ReactNode
  errorText?: string
  variant?: 'outlined' | 'filled'
  /** Aligne le contenu en chiffres tabulaires : valeurs numeriques. */
  numeric?: boolean
  density?: 'default' | 'compact'
}

/** Champ texte MD3 a label flottant. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    label,
    suffix,
    leadingIcon,
    supportingText,
    errorText,
    variant = 'outlined',
    numeric = false,
    density = 'default',
    className,
    id,
    disabled,
    ...rest
  },
  ref,
) {
  const autoId = useId()
  const fieldId = id ?? autoId
  const helpId = `${fieldId}-help`
  const invalid = Boolean(errorText)

  return (
    <div
      className={cx(
        'md-text-field',
        `md-text-field--${variant}`,
        density === 'compact' && 'md-text-field--compact',
        invalid && 'is-invalid',
        disabled && 'is-disabled',
        className,
      )}
    >
      <div className="md-text-field__box">
        {leadingIcon && <Icon name={leadingIcon} size={20} className="md-text-field__leading" />}
        <input
          ref={ref}
          id={fieldId}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={supportingText || errorText ? helpId : undefined}
          placeholder=" "
          className={cx('md-text-field__input', numeric && 'md-numeric')}
          {...rest}
        />
        <label className="md-text-field__label" htmlFor={fieldId}>
          {label}
        </label>
        {suffix && <span className="md-text-field__suffix md-type-body-small">{suffix}</span>}
      </div>
      {(errorText || supportingText) && (
        <p id={helpId} className="md-type-body-small md-text-field__support">
          {errorText ?? supportingText}
        </p>
      )}
    </div>
  )
})
