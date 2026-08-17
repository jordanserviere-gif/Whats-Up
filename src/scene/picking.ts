/**
 * Designation d'un objet a partir d'une direction de visee.
 *
 * Le trace de rayons de react-three-fiber ne convient pas ici : a champ large,
 * une planete occupe une fraction de pixel et une etoile n'a pas de geometrie du
 * tout. On ne cherche donc pas une intersection, mais le catalogue le plus
 * proche de la direction pointee — ce qui rend cliquable tout ce qui est
 * visible, y compris les objets sous-pixel.
 */
import { Matrix4 } from 'three'
import { NAMED_STARS } from '@/astro/catalog'
import { equatorialToHorizontal, precessFromJ2000 } from '@/astro/coords'
import { DEEP_SKY_INDEX, buildDeepSkyGeometry } from '@/astro/deepsky'
import type { SkyTarget } from '@/astro/search'
import type { BodyState, GeoLocation, Horizontal, OrbitalElements, SatelliteState } from '@/astro/types'
import { angularDistance, sceneDirectionToEquatorial } from './sceneMath'

const DEG = Math.PI / 180

export interface PickCandidateInputs {
  bodies: readonly BodyState[]
  /** Satellites affiches, avec leur etat instantane. */
  satellites: ReadonlyArray<{ element: OrbitalElements; state: SatelliteState }>
  /** Magnitude limite du moment : rien de moins visible n'est proposable. */
  limitingMagnitude: number
  /** Les etoiles et le ciel profond sont-ils affiches ? */
  includeStars: boolean
  includeDeepSky: boolean
}

export interface PickResult {
  target: SkyTarget
  /** Ecart angulaire entre la direction pointee et l'objet, en degres. */
  distance: number
  /** Position apparente de l'objet retenu : c'est elle qui recentre la vue. */
  horizontal: Horizontal
}

/**
 * Poids de famille. Un objet mieux pondere l'emporte a ecart legerement
 * superieur : entre une planete et l'etoile de fond qui la jouxte, c'est la
 * planete qu'on visait.
 */
const KIND_PRIORITY: Record<string, number> = {
  body: 2.2,
  satellite: 1.8,
  star: 1,
  deepsky: 1.1,
}

/**
 * Objet le plus proche de `direction`, dans la limite de `toleranceDeg`.
 *
 * `direction` est un vecteur du repere de la scene ; il n'a pas besoin d'etre
 * unitaire. Renvoie `null` si rien d'identifiable ne se trouve dans le cone.
 */
export function pickSkyTarget(
  direction: readonly [number, number, number],
  aim: Horizontal,
  toleranceDeg: number,
  date: Date,
  location: GeoLocation,
  inputs: PickCandidateInputs,
  scratch = new Matrix4(),
): PickResult | null {
  let best: { target: SkyTarget; distance: number; resolve: () => Horizontal } | null = null
  let bestScore = Number.POSITIVE_INFINITY

  /**
   * `resolve` est differe : convertir en coordonnees horizontales n'a d'interet
   * que pour l'objet finalement retenu, pas pour les mille sept cents candidats
   * du ciel profond qu'on écarte.
   */
  const consider = (target: SkyTarget, distance: number, resolve: () => Horizontal) => {
    if (distance > toleranceDeg) return
    const score = distance / (KIND_PRIORITY[target.kind] ?? 1)
    if (score >= bestScore) return
    bestScore = score
    best = { target, distance, resolve }
  }

  // --- Corps du systeme solaire ---
  for (const b of inputs.bodies) {
    if (b.horizontal.altitude < -2) continue
    consider(
      {
        kind: 'body',
        id: b.id,
        name: b.name,
        detail: b.id === 'sun' || b.id === 'moon' ? 'système solaire' : 'planète',
        magnitude: b.magnitude,
        equatorialJ2000: null,
      },
      angularDistance(aim, b.horizontal),
      () => b.horizontal,
    )
  }

  // --- Satellites ---
  for (const { element, state } of inputs.satellites) {
    if (state.horizontal.altitude < -2) continue
    consider(
      {
        kind: 'satellite',
        id: element.id,
        name: element.name,
        detail: element.noradId ? `NORAD ${element.noradId}` : 'orbite saisie',
        magnitude: state.magnitude,
        equatorialJ2000: null,
      },
      angularDistance(aim, state.horizontal),
      () => state.horizontal,
    )
  }

  // Les objets fixes se comparent dans leur propre repere : on y transporte la
  // direction visee une seule fois, plutot que d'amener chaque objet ici.
  const eq = sceneDirectionToEquatorial(direction, date, location, scratch)
  const norm = Math.hypot(eq[0], eq[1], eq[2]) || 1
  const ux = eq[0] / norm
  const uy = eq[1] / norm
  const uz = eq[2] / norm
  const cosTolerance = Math.cos(toleranceDeg * DEG)

  /** Ecart angulaire a la direction visee, pour un vecteur unitaire equatorial. */
  const separation = (x: number, y: number, z: number): number | null => {
    const dot = ux * x + uy * y + uz * z
    if (dot < cosTolerance) return null
    return Math.acos(Math.min(1, dot)) / DEG
  }

  // --- Etoiles nommees ---
  //
  // Seules celles qui portent un nom sont designables : le catalogue embarque ne
  // conserve pas d'identifiant pour les autres, et une fiche sans identite
  // n'apprendrait rien. Une centaine d'entrees, precessees a la volee.
  if (inputs.includeStars) {
    for (const s of NAMED_STARS) {
      if (s.magnitude > inputs.limitingMagnitude + 1) continue
      const p = precessFromJ2000({ ra: s.ra, dec: s.dec }, date)
      const ra = p.ra * DEG
      const dec = p.dec * DEG
      const cd = Math.cos(dec)
      const d = separation(cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec))
      if (d === null) continue
      consider(
        {
          kind: 'star',
          id: `star-${s.index}`,
          name: s.name,
          detail: s.designation,
          magnitude: s.magnitude,
          equatorialJ2000: { ra: s.ra, dec: s.dec },
          catalogIndex: s.index,
        },
        d,
        () => equatorialToHorizontal(p, location, date),
      )
    }
  }

  // --- Ciel profond ---
  //
  // La geometrie est deja precessee et mise en cache pour le rendu : on la
  // reutilise telle quelle plutot que de refaire mille sept cents precessions.
  if (inputs.includeDeepSky) {
    const geo = buildDeepSkyGeometry(date)
    for (let k = 0; k < geo.count; k++) {
      const o = DEEP_SKY_INDEX[geo.indices[k]]
      if (!o) continue
      const d = separation(geo.positions[k * 3], geo.positions[k * 3 + 1], geo.positions[k * 3 + 2])
      if (d === null) continue
      // Un objet etendu se designe sur toute sa surface, pas sur son seul centre.
      const reach = Math.max(0, geo.semiMajor[k] / DEG)
      consider(
        {
          kind: 'deepsky',
          id: `dso-${o.index}`,
          name: o.messier > 0 ? `M${o.messier}` : o.id,
          detail: o.name ? `${o.typeLabel} · ${o.name}` : o.typeLabel,
          magnitude: Number.isFinite(o.magnitude) ? o.magnitude : null,
          equatorialJ2000: { ra: o.ra, dec: o.dec },
          catalogIndex: o.index,
        },
        Math.max(0, d - reach),
        () => equatorialToHorizontal(precessFromJ2000({ ra: o.ra, dec: o.dec }, date), location, date),
      )
    }
  }

  if (!best) return null
  const winner = best as { target: SkyTarget; distance: number; resolve: () => Horizontal }
  return { target: winner.target, distance: winner.distance, horizontal: winner.resolve() }
}
