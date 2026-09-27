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
    <section className={cx('wu-section', expanded && 'is-open', className)}>
      <div className="wu-section__header">
        {collapsible ? (
          <button
            type="button"
            className="wu-section__toggle"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setOpen((v) => !v)}
          >
            {icon && <Icon name={icon} size={20} className="wu-section__icon" />}
            <span className="wu-type-title-s is-emphasized wu-section__title">{title}</span>
            {!expanded && summary && <span className="wu-type-caption wu-section__summary">{summary}</span>}
            <Icon name="expand_more" size={20} className="wu-section__chevron" />
          </button>
        ) : (
          <div className="wu-section__toggle wu-section__toggle--static">
            {icon && <Icon name={icon} size={20} className="wu-section__icon" />}
            <span className="wu-type-title-s is-emphasized wu-section__title">{title}</span>
          </div>
        )}
        {actions && <div className="wu-section__actions">{actions}</div>}
      </div>
      {/* La hauteur repliee n'est jamais connue a l'avance (contenu variable) :
          le ressort porte donc sur `grid-template-rows`, pas sur une hauteur
          fixe — c'est la seule facon d'animer « jusqu'a la hauteur naturelle »
          en CSS pur. `inert` retire le contenu replie du clavier et des
          lecteurs d'ecran, comme le faisait `hidden` avant, sans quoi les
          boutons d'une section fermee resteraient atteignables par tabulation.
          Il vaut la chaine vide et non `true` : React 18 ne connait pas `inert`
          comme attribut booleen, posait bien l'attribut mais avertissait a
          chaque rendu. `inert=""` est de toute facon la forme HTML exacte. */}
      <div className="wu-section__body-frame">
        <div
          id={id}
          className="wu-section__body"
          {...({ inert: !expanded ? '' : undefined } as Record<string, unknown>)}
        >
          {/* Le remplissage vit ici, pas sur `.wu-section__body` : en
              `box-sizing: border-box`, une hauteur qui tend vers zero ne
              peut jamais descendre sous le remplissage vertical de sa propre
              boite — la section repliee laissait donc toujours depasser une
              vingtaine de pixels de son contenu. En le reportant sur un
              enfant, c'est ce **conteneur** qui se compresse a zero, et son
              remplissage a lui disparait avec. */}
          <div className="wu-section__body-inner">{children}</div>
        </div>
      </div>
    </section>
  )
}
