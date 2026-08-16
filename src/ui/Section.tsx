import { useId, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { cx } from './utils'
import './Section.css'

export interface SectionProps {
  title: string
  icon?: string
  /** Valeur resumee affichee dans l'en-tete quand la section est repliee. */
  summary?: ReactNode
  defaultOpen?: boolean
  collapsible?: boolean
  actions?: ReactNode
  className?: string
  children: ReactNode
}

/** Bloc repliable — brique de structuration des panneaux. */
export function Section({
  title,
  icon,
  summary,
  defaultOpen = true,
  collapsible = true,
  actions,
  className,
  children,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  const expanded = collapsible ? open : true

  return (
    <section className={cx('md-section', expanded && 'is-open', className)}>
      <div className="md-section__header">
        {collapsible ? (
          <button
            type="button"
            className="md-section__toggle"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setOpen((v) => !v)}
          >
            {icon && <Icon name={icon} size={20} className="md-section__icon" />}
            <span className="md-type-title-small is-emphasized md-section__title">{title}</span>
            {!expanded && summary && <span className="md-type-label-medium md-section__summary">{summary}</span>}
            <Icon name="expand_more" size={20} className="md-section__chevron" />
          </button>
        ) : (
          <div className="md-section__toggle md-section__toggle--static">
            {icon && <Icon name={icon} size={20} className="md-section__icon" />}
            <span className="md-type-title-small is-emphasized md-section__title">{title}</span>
          </div>
        )}
        {actions && <div className="md-section__actions">{actions}</div>}
      </div>
      <div id={id} className="md-section__body" hidden={!expanded}>
        {children}
      </div>
    </section>
  )
}
