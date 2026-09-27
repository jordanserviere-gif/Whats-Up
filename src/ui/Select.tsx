import { useId } from 'react'
import { Icon } from './Icon'
import { cx } from './utils'
import './Select.css'

export interface SelectOption<T extends string> {
  value: T
  label: string
  group?: string
}

export interface SelectProps<T extends string> {
  label: string
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onChange: (value: T) => void
  leadingIcon?: string
  supportingText?: string
  disabled?: boolean
  className?: string
}

/** Menu deroulant : `<select>` natif habille, donc utilisable au clavier et sur mobile. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  leadingIcon,
  supportingText,
  disabled,
  className,
}: SelectProps<T>) {
  const id = useId()
  const groups = new Map<string, SelectOption<T>[]>()
  for (const opt of options) {
    const key = opt.group ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(opt)
  }

  return (
    <div className={cx('wu-select', disabled && 'is-disabled', className)}>
      <div className="wu-select__box">
        {leadingIcon && <Icon name={leadingIcon} size={20} className="wu-select__leading" />}
        <label className="wu-type-body-s wu-select__label" htmlFor={id}>
          {label}
        </label>
        <select
          id={id}
          className="wu-select__native wu-type-body"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as T)}
        >
          {[...groups.entries()].map(([group, opts]) =>
            group ? (
              <optgroup key={group} label={group}>
                {opts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ) : (
              opts.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))
            ),
          )}
        </select>
        <Icon name="arrow_drop_down" size={22} className="wu-select__chevron" />
      </div>
      {supportingText && <p className="wu-type-body-s wu-select__support">{supportingText}</p>}
    </div>
  )
}
