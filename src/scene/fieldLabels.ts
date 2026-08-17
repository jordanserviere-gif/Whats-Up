/**
 * Etiquettes des objets fixes presents dans le champ.
 *
 * Nommer tout le catalogue couvrirait le ciel de texte ; n'en nommer aucun
 * laisse l'observateur devant des points anonymes. Le compromis tenu ici est
 * celui d'un atlas : on ne nomme que ce qu'on regarde, et parmi cela, les plus
 * brillants d'abord.
 *
 * Le seuil de magnitude n'est pas fixe. Il suit le champ affiche : au grand
 * angle on ne veut que les astres de premiere grandeur, tandis qu'a fort
 * grossissement le champ ne contient plus grand-chose et l'on peut descendre
 * beaucoup plus bas sans encombrer.
 */
import { Matrix4 } from 'three'
import { NAMED_STARS } from '@/astro/catalog'
import { equatorialToHorizontal, precessFromJ2000 } from '@/astro/coords'
import { DEEP_SKY_INDEX, buildDeepSkyGeometry } from '@/astro/deepsky'
import type { GeoLocation, Horizontal } from '@/astro/types'
import { sceneDirectionToEquatorial } from './sceneMath'

const DEG = Math.PI / 180

export interface FieldLabel {
  id: string
  name: string
  magnitude: number
  horizontal: Horizontal
  kind: 'star' | 'deepsky'
  /** Demi-grand axe apparent, en degres. Nul pour une etoile. */
  angularRadiusDeg: number
}

/** Nombre d'etiquettes au-dela duquel le champ devient illisible. */
const MAX_LABELS = 14

/**
 * Magnitude la plus faible que l'on accepte de nommer, pour un champ donne.
 *
 * A soixante degres de champ on s'arrete a la deuxieme grandeur — les astres que
 * l'on nomme a l'oeil nu. En resserrant, le seuil descend d'environ deux
 * magnitudes par facteur dix de champ, ce qui maintient a peu pres constant le
 * nombre d'objets nommes a l'ecran. Le resultat reste borne par ce que le ciel
 * laisse effectivement voir.
 */
export function labelMagnitudeLimit(fovDeg: number, limitingMagnitude: number): number {
  const scaled = 2.2 + 2 * Math.log10(60 / Math.max(0.02, fovDeg))
  return Math.min(scaled, limitingMagnitude)
}

/**
 * Objets fixes nommables dans le champ courant.
 *
 * `direction` est la direction de visee dans le repere de la scene. Le rayon de
 * recherche couvre les coins de l'ecran, pas seulement le champ vertical : une
 * etiquette qui n'apparaitrait qu'au centre serait plus deroutante qu'absente.
 */
export function fieldLabels(
  direction: readonly [number, number, number],
  fovDeg: number,
  date: Date,
  location: GeoLocation,
  limitingMagnitude: number,
  options: { includeStars: boolean; includeDeepSky: boolean },
  scratch = new Matrix4(),
): FieldLabel[] {
  const magLimit = labelMagnitudeLimit(fovDeg, limitingMagnitude)
  if (magLimit < -2) return []

  const radiusDeg = Math.min(90, fovDeg * 0.75)
  const cosRadius = Math.cos(radiusDeg * DEG)

  const eq = sceneDirectionToEquatorial(direction, date, location, scratch)
  const norm = Math.hypot(eq[0], eq[1], eq[2]) || 1
  const ux = eq[0] / norm
  const uy = eq[1] / norm
  const uz = eq[2] / norm

  const found: Array<Omit<FieldLabel, 'horizontal'> & { resolve: () => Horizontal }> = []

  if (options.includeStars) {
    for (const s of NAMED_STARS) {
      if (s.magnitude > magLimit) continue
      const p = precessFromJ2000({ ra: s.ra, dec: s.dec }, date)
      const ra = p.ra * DEG
      const dec = p.dec * DEG
      const cd = Math.cos(dec)
      const dot = ux * cd * Math.cos(ra) + uy * cd * Math.sin(ra) + uz * Math.sin(dec)
      if (dot < cosRadius) continue
      found.push({
        id: `field-star-${s.index}`,
        name: s.name,
        magnitude: s.magnitude,
        kind: 'star',
        angularRadiusDeg: 0,
        resolve: () => equatorialToHorizontal(p, location, date),
      })
    }
  }

  if (options.includeDeepSky) {
    // La geometrie du ciel profond est deja precessee et mise en cache pour le
    // rendu : on la relit plutot que de refaire mille sept cents precessions.
    const geo = buildDeepSkyGeometry(date)
    for (let k = 0; k < geo.count; k++) {
      const o = DEEP_SKY_INDEX[geo.indices[k]]
      if (!o || !Number.isFinite(o.magnitude) || o.magnitude > magLimit) continue
      const dot =
        ux * geo.positions[k * 3] + uy * geo.positions[k * 3 + 1] + uz * geo.positions[k * 3 + 2]
      if (dot < cosRadius) continue
      found.push({
        id: `field-dso-${o.index}`,
        name: o.messier > 0 ? `M${o.messier}` : o.id,
        magnitude: o.magnitude,
        kind: 'deepsky',
        angularRadiusDeg: Math.max(0, geo.semiMajor[k] / DEG),
        resolve: () => equatorialToHorizontal(precessFromJ2000({ ra: o.ra, dec: o.dec }, date), location, date),
      })
    }
  }

  // Les plus brillants d'abord : si le champ en contient trop, ce sont eux qu'on
  // veut voir nommes. La conversion en coordonnees horizontales n'a lieu qu'ici,
  // pour les seuls retenus.
  found.sort((a, b) => a.magnitude - b.magnitude)

  const out: FieldLabel[] = []
  for (const f of found) {
    if (out.length >= MAX_LABELS) break
    const horizontal = f.resolve()
    // Sous l'horizon, l'objet est derriere le sol : le nommer serait mentir.
    if (horizontal.altitude < 0) continue
    out.push({
      id: f.id,
      name: f.name,
      magnitude: f.magnitude,
      kind: f.kind,
      angularRadiusDeg: f.angularRadiusDeg,
      horizontal,
    })
  }
  return out
}
