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
