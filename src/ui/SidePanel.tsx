import { useEffect, useRef, type ReactNode } from 'react'
import { IconButton } from './IconButton'
import { cx } from './utils'
import './SidePanel.css'

export interface SidePanelProps {
  open: boolean
  title: string
  subtitle?: string
  onClose?: () => void
  /** Actions dans l'en-tete, a droite du titre. */
  actions?: ReactNode
  /** Zone collee en bas du panneau (boutons de validation). */
  footer?: ReactNode
  side?: 'start' | 'end'
  className?: string
  children: ReactNode
}

/**
 * Feuille laterale (side sheet) — devient une feuille inferieure sous 900 px.
 * Entree/sortie sur le ressort spatial, avec un leger depassement.
 */
export function SidePanel({
  open,
  title,
  subtitle,
  onClose,
  actions,
  footer,
  side = 'end',
  className,
  children,
}: SidePanelProps) {
  const ref = useRef<HTMLElement>(null)

  // `inert` retire tout le sous-arbre du parcours clavier quand le panneau est
  // ferme. L'attribut n'etant pas encore typé par React, on le pose a la main.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open) el.removeAttribute('inert')
    else el.setAttribute('inert', '')
  }, [open])

  return (
    <aside
      ref={ref}
      className={cx('md-side-panel', `md-side-panel--${side}`, open ? 'is-open' : 'is-closed', className)}
      aria-hidden={!open}
    >
      <header className="md-side-panel__header">
        <div className="md-side-panel__titles">
          {subtitle && <p className="md-type-label-small md-side-panel__overline">{subtitle}</p>}
          <h2 className="md-type-title-large is-emphasized">{title}</h2>
        </div>
        <div className="md-side-panel__actions">
          {actions}
          {onClose && <IconButton icon="close" label="Fermer le panneau" onClick={onClose} />}
        </div>
      </header>
      <div className="md-side-panel__content">{children}</div>
      {footer && <footer className="md-side-panel__footer">{footer}</footer>}
    </aside>
  )
}
