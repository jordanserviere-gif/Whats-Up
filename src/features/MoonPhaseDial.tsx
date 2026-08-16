import { cx } from '@/ui'
import './MoonPhaseDial.css'

export interface MoonPhaseDialProps {
  /** Fraction eclairee, 0 a 1. */
  illumination: number
  /** Angle de phase 0-360° : au-dela de 180°, le croissant s'inverse. */
  phaseAngle: number
  size?: number
  className?: string
  label?: string
}

/**
 * Disque lunaire a phase reelle, en SVG.
 *
 * Le terminateur est une demi-ellipse dont le demi-axe suit |1 − 2k| ; le
 * masque combine cette ellipse a un demi-disque pour couvrir croissants et
 * gibbeuses avec une seule construction.
 */
export function MoonPhaseDial({ illumination, phaseAngle, size = 56, className, label }: MoonPhaseDialProps) {
  const k = Math.min(1, Math.max(0, illumination))
  const r = 50
  // Demi-axe horizontal du terminateur, signe selon gibbeuse ou croissant.
  const semi = r * (1 - 2 * k)
  const waxing = phaseAngle < 180
  const sweepOuter = waxing ? 1 : 0
  const sweepInner = semi >= 0 ? (waxing ? 0 : 1) : waxing ? 1 : 0
  const rx = Math.abs(semi)

  // Contour de la partie eclairee : demi-cercle exterieur + demi-ellipse interieure.
  const litPath = `M 0 ${-r} A ${r} ${r} 0 0 ${sweepOuter} 0 ${r} A ${rx} ${r} 0 0 ${sweepInner} 0 ${-r} Z`

  return (
    <div
      className={cx('moon-dial', className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label ?? `Lune éclairée à ${Math.round(k * 100)} %`}
    >
      <svg viewBox="-55 -55 110 110">
        <circle className="moon-dial__dark" cx="0" cy="0" r={r} />
        {k > 0.005 && <path className="moon-dial__lit" d={litPath} />}
        <circle className="moon-dial__rim" cx="0" cy="0" r={r} />
      </svg>
    </div>
  )
}
