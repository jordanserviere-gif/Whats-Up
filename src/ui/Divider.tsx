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
      className={cx('wu-divider', inset && 'wu-divider--inset', vertical && 'wu-divider--vertical', className)}
    />
  )
}
