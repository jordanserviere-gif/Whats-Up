import { cx } from './utils'
import './Divider.css'

export function Divider({
  inset = false,
  vertical = false,
  className,
}: {
  inset?: boolean
  vertical?: boolean
  className?: string
}) {
  return (
    <hr
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={cx('md-divider', inset && 'md-divider--inset', vertical && 'md-divider--vertical', className)}
    />
  )
}
