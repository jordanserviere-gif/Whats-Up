import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icon'
import { cx } from './utils'
import './Dialog.css'

export interface DialogProps {
  open: boolean
  onClose: () => void
  icon?: string
  title: string
  supportingText?: ReactNode
  actions?: ReactNode
  className?: string
  children?: ReactNode
}

/** Boite de dialogue MD3 basee sur `<dialog>` natif (focus trap + touche Echap). */
export function Dialog({ open, onClose, icon, title, supportingText, actions, className, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className={cx('md-dialog', className)}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <div className="md-dialog__panel">
        {icon && (
          <span className="md-dialog__icon">
            <Icon name={icon} size={24} />
          </span>
        )}
        <h2 className={cx('md-type-headline-small', 'is-emphasized', icon && 'md-dialog__title--centered')}>{title}</h2>
        {supportingText && <p className="md-type-body-medium md-dialog__support">{supportingText}</p>}
        {children && <div className="md-dialog__content">{children}</div>}
        {actions && <div className="md-dialog__actions">{actions}</div>}
      </div>
    </dialog>
  )
}
