/**
 * Trajet oblique a travers une atmosphere spherique.
 *
 * ## Pourquoi pas une secante
 *
 * L'approximation plan-parallele donne `masse d'air = 1/cos z`. Elle est
 * excellente jusqu'a 60° et **diverge a l'horizon**, ou elle predit une masse
 * d'air infinie. La realite plafonne autour de 38 : la courbure de la Terre
 * fait remonter le rayon hors de l'atmosphere dense avant qu'il n'ait traverse
 * une colonne infinie.
 *
 * Or c'est precisement pres de l'horizon que se joue tout ce que ce moteur
 * cherche a rendre — le rougissement, l'aplatissement, le rayon vert. Le trajet
 * y est donc integre **le long de sa vraie geometrie**, sans forme fermee.
 *
 * ## Geometrie
 *
 * Observateur en `(0, r₀, 0)` avec `r₀ = R + altitude_observateur`, visee a un
 * angle zenithal `z`. Le long du rayon, a l'abscisse curviligne `s` :
 *
 *     |p(s)|² = s² + 2·s·r₀·cos z + r₀²
 *     altitude(s) = |p(s)| − R
 *
 * La colonne moleculaire est `∫ N(altitude(s)) ds`, integree jusqu'a la sortie
 * de l'atmosphere.
 *
 * ## Ce qui n'est pas encore la
 *
 * **Le rayon est droit.** La refraction le courberait, allongeant encore le
 * trajet et abaissant la position apparente du Soleil d'environ 35′ a
 * l'horizon — plus que son propre diametre. Elle arrive aux phases 10 et 11 ;
 * jusque-la, les hauteurs manipulees ici sont **geometriques**, coherentes avec
 * la scene, qui l'est aussi.
 */
import { EARTH_MEAN_RADIUS_M } from '../core/units'
import { standardProfile } from '../thermodynamics/standardAtmosphere'
import { ozoneNumberDensity } from '../absorption/ozone'

/**
 * Sommet de l'atmosphere retenu pour l'integration, m.
 *
 * Cent kilometres : la ligne de Karman. Au-dela, `standardProfile` extrapole et
 * la densite y porte moins de 4·10⁻⁶ de la colonne — sans effet mesurable sur
 * une profondeur optique.
 */
export const ATMOSPHERE_TOP_M = 100_000

/** Distance parcourue avant de sortir de l'atmosphere, m. */
export function pathLengthToTop(zenithAngleRad: number, observerElevationM = 0): number {
  const r0 = EARTH_MEAN_RADIUS_M + observerElevationM
  const rTop = EARTH_MEAN_RADIUS_M + ATMOSPHERE_TOP_M
  const cosZ = Math.cos(zenithAngleRad)
  // Racine positive de s² + 2·s·r₀·cos z + r₀² − r_top² = 0.
  const discriminant = r0 * r0 * cosZ * cosZ - (r0 * r0 - rTop * rTop)
  if (!(discriminant > 0)) return 0
  return -r0 * cosZ + Math.sqrt(discriminant)
}

/**
 * Colonne moleculaire le long d'un rayon oblique, m⁻².
 *
 * Integration par point milieu. Le pas est **proportionnel a la longueur du
 * trajet** plutot que fixe : une visee rasante parcourt onze cents kilometres
 * la ou une visee zenithale en parcourt cent, et un pas unique serait soit trop
 * grossier pour l'une, soit gaspille pour l'autre.
 *
 * Le point milieu est preferable au bord sur une exponentielle, qui est convexe :
 * evaluer au bord biaiserait systematiquement la somme dans le meme sens.
 */
export function slantColumn(zenithAngleRad: number, observerElevationM = 0, steps = 4096): number {
  const r0 = EARTH_MEAN_RADIUS_M + observerElevationM
  const cosZ = Math.cos(zenithAngleRad)
  const total = pathLengthToTop(zenithAngleRad, observerElevationM)
  if (!(total > 0)) return 0

  const step = total / steps
  let column = 0

  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * step
    const radius = Math.sqrt(s * s + 2 * s * r0 * cosZ + r0 * r0)
    column += standardProfile(radius - EARTH_MEAN_RADIUS_M).numberDensityPerM3 * step
  }

  return column
}

/**
 * Masse d'air relative : rapport de la colonne oblique a la colonne zenithale.
 *
 * Sans dimension, vaut 1 au zenith. C'est la meme grandeur que celle que
 * `astro/photometry.ts` calcule par la formule empirique de Pickering (2002),
 * par un chemin entierement different — les confronter est une validation
 * croisee gratuite.
 */
export function relativeAirmass(zenithAngleRad: number, observerElevationM = 0, steps?: number): number {
  const vertical = slantColumn(0, observerElevationM, steps)
  if (!(vertical > 0)) return 0
  return slantColumn(zenithAngleRad, observerElevationM, steps) / vertical
}

/**
 * Colonne oblique a partir d'une **hauteur** au-dessus de l'horizon, en degres.
 *
 * Sous l'horizon geometrique la fonction rend `Infinity` : le rayon rencontre
 * la Terre, plus aucune lumiere directe ne parvient a l'observateur. C'est une
 * reponse physique, pas un cas limite a rattraper — et elle cessera d'etre
 * exacte quand la refraction, en phase 11, fera reapparaitre le Soleil sous
 * l'horizon geometrique.
 */
export function slantColumnFromAltitude(altitudeDeg: number, observerElevationM = 0, steps?: number): number {
  if (altitudeDeg < 0) {
    // Le rayon plonge : il coupe la surface si son point le plus bas passe sous
    // le rayon terrestre.
    const r0 = EARTH_MEAN_RADIUS_M + observerElevationM
    const grazing = r0 * Math.cos((altitudeDeg * Math.PI) / 180)
    if (grazing < EARTH_MEAN_RADIUS_M) return Number.POSITIVE_INFINITY
  }
  return slantColumn((Math.PI / 2 - (altitudeDeg * Math.PI) / 180), observerElevationM, steps)
}

/** Rayon du sommet de l'atmosphere, m. */
const TOP_RADIUS = EARTH_MEAN_RADIUS_M + ATMOSPHERE_TOP_M

/**
 * Colonne moleculaire d'un point vers l'espace, dans une direction donnee.
 *
 * `altitudeM` est l'altitude du point, `cosZenith` le cosinus de l'angle entre
 * la direction visee et la verticale **locale a ce point** — et non celle de
 * l'observateur. Par symetrie spherique, ces deux nombres suffisent.
 *
 * Rend `Infinity` si le rayon rencontre la Terre. Ce n'est pas un cas d'erreur
 * mais le fondement du crepuscule : c'est ainsi que l'ombre de la planete entre
 * dans le calcul, sans qu'aucune geometrie d'ombre ne soit ecrite ailleurs.
 */
export interface SpeciesColumns {
  /** Colonne moleculaire de l'air, m⁻² — la diffusion Rayleigh en depend. */
  air: number
  /** Colonne d'ozone, m⁻² — l'absorption de Chappuis en depend. */
  ozone: number
  /**
   * Colonne d'aerosols **normalisee**, en metres : `∫exp(−z/H) ds`.
   *
   * Elle est purement geometrique, sans densite. C'est deliberé : la quantite
   * d'aerosols change avec le trouble, plusieurs fois par session, alors que
   * cette integrale ne depend que de la hauteur d'echelle. Les separer evite de
   * refaire la geometrie a chaque changement de reglage — il suffit de
   * multiplier par la densite au sol et la section efficace.
   */
  aerosolShape: number
}

/**
 * Colonnes de **chaque espece** d'un point vers l'espace, m⁻².
 *
 * Les deux sont integrees dans la meme marche : elles partagent la geometrie,
 * et seule la densite change. Les separer en deux parcours doublerait le cout
 * pour rien.
 *
 * **Il faut bien deux nombres.** Tant que Rayleigh etait seul, la profondeur
 * optique se factorisait en `σ(λ) × colonne` et une seule colonne suffisait a
 * tout le spectre. L'ozone a un autre profil vertical — il culmine vers 25 km,
 * la ou l'air est deja rarefie — donc un autre rapport entre colonne oblique et
 * colonne verticale. La factorisation ne tient plus.
 */
export function columnsToSpace(
  altitudeM: number,
  cosZenith: number,
  steps = 128,
  ozoneColumnDobsonUnits?: number,
  aerosolScaleHeightM = 1200,
): SpeciesColumns {
  const r = EARTH_MEAN_RADIUS_M + altitudeM
  const mu = Math.max(-1, Math.min(1, cosZenith))

  if (mu < 0 && r * Math.sqrt(1 - mu * mu) < EARTH_MEAN_RADIUS_M) {
    return {
      air: Number.POSITIVE_INFINITY,
      ozone: Number.POSITIVE_INFINITY,
      aerosolShape: Number.POSITIVE_INFINITY,
    }
  }

  const discriminant = r * r * mu * mu + (TOP_RADIUS * TOP_RADIUS - r * r)
  if (!(discriminant > 0)) return { air: 0, ozone: 0, aerosolShape: 0 }
  const total = -r * mu + Math.sqrt(discriminant)
  if (!(total > 0)) return { air: 0, ozone: 0, aerosolShape: 0 }

  const step = total / steps
  let air = 0
  let ozone = 0
  let aerosolShape = 0
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * step
    const radius = Math.sqrt(t * t + 2 * t * r * mu + r * r)
    const altitude = radius - EARTH_MEAN_RADIUS_M
    air += standardProfile(altitude).numberDensityPerM3 * step
    ozone += ozoneNumberDensity(altitude, ozoneColumnDobsonUnits) * step
    aerosolShape += Math.exp(-Math.max(0, altitude) / aerosolScaleHeightM) * step
  }
  return { air, ozone, aerosolShape }
}

export function columnToSpace(altitudeM: number, cosZenith: number, steps = 128): number {
  const r = EARTH_MEAN_RADIUS_M + altitudeM
  const mu = Math.max(-1, Math.min(1, cosZenith))

  // Rayon descendant : il n'echappe que si son perigee reste au-dessus du sol.
  if (mu < 0 && r * Math.sqrt(1 - mu * mu) < EARTH_MEAN_RADIUS_M) return Number.POSITIVE_INFINITY

  // Sortie par le sommet de l'atmosphere : racine positive de
  // t² + 2·t·r·µ + r² − r_top² = 0.
  const discriminant = r * r * mu * mu + (TOP_RADIUS * TOP_RADIUS - r * r)
  if (!(discriminant > 0)) return 0
  const total = -r * mu + Math.sqrt(discriminant)
  if (!(total > 0)) return 0

  const step = total / steps
  let column = 0
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * step
    const radius = Math.sqrt(t * t + 2 * t * r * mu + r * r)
    column += standardProfile(radius - EARTH_MEAN_RADIUS_M).numberDensityPerM3 * step
  }
  return column
}
