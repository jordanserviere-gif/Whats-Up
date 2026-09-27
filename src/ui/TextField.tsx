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

/** Champ texte, libelle en capitales dans le haut de la boite. */
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
        'wu-text-field',
        `wu-text-field--${variant}`,
        density === 'compact' && 'wu-text-field--compact',
        invalid && 'is-invalid',
        disabled && 'is-disabled',
        className,
      )}
    >
      <div className="wu-text-field__box">
        {leadingIcon && <Icon name={leadingIcon} size={20} className="wu-text-field__leading" />}
        <input
          ref={ref}
          id={fieldId}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={supportingText || errorText ? helpId : undefined}
          placeholder=" "
          className={cx('wu-text-field__input', numeric && 'wu-numeric')}
          {...rest}
        />
        <label className="wu-text-field__label" htmlFor={fieldId}>
          {label}
        </label>
        {suffix && <span className="wu-text-field__suffix wu-type-body-s">{suffix}</span>}
      </div>
      {(errorText || supportingText) && (
        <p id={helpId} className="wu-type-body-s wu-text-field__support">
          {errorText ?? supportingText}
        </p>
      )}
    </div>
  )
})
