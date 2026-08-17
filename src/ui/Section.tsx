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
      {/* La hauteur repliee n'est jamais connue a l'avance (contenu variable) :
          le ressort porte donc sur `grid-template-rows`, pas sur une hauteur
          fixe — c'est la seule facon d'animer « jusqu'a la hauteur naturelle »
          en CSS pur. `inert` retire le contenu replie du clavier et des
          lecteurs d'ecran, comme le faisait `hidden` avant, sans quoi les
          boutons d'une section fermee resteraient atteignables par tabulation. */}
      <div className="md-section__body-frame">
        <div
          id={id}
          className="md-section__body"
          {...({ inert: !expanded || undefined } as Record<string, unknown>)}
        >
          {/* Le remplissage vit ici, pas sur `.md-section__body` : en
              `box-sizing: border-box`, une hauteur qui tend vers zero ne
              peut jamais descendre sous le remplissage vertical de sa propre
              boite — la section repliee laissait donc toujours depasser une
              vingtaine de pixels de son contenu. En le reportant sur un
              enfant, c'est ce **conteneur** qui se compresse a zero, et son
              remplissage a lui disparait avec. */}
          <div className="md-section__body-inner">{children}</div>
        </div>
      </div>
    </section>
  )
}
