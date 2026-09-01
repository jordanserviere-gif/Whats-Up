/**
 * Frontiere entre unites physiques et unites de rendu.
 *
 * **Regle du moteur : aucun solveur ne voit une unite Three.js.** Les solveurs
 * travaillent en SI strict — metres, pascals, kelvins, radians, m⁻¹ — et ce
 * fichier est le seul endroit ou une grandeur change de monde.
 *
 * Il y a deux frontieres, et elles n'ont pas la meme nature :
 *
 * 1. **Les longueurs**, qui changent reellement d'unite. La scene comprime les
 *    distances en logarithme (voir `scene/sceneMath.ts`) : une profondeur de
 *    scene n'est pas une distance et ne peut pas etre reconvertie en metres.
 *    C'est pourquoi la distance reelle voyage **a cote** de la position, jamais
 *    a travers elle.
 *
 * 2. **Les directions**, qui ne changent pas d'unite du tout. Le repere de la
 *    scene (+X est, +Y zenith, −Z nord) est deja un repere physique local
 *    orthonorme. Un vecteur unitaire y est le meme objet mathematique que dans
 *    le repere topocentrique du solveur. **Aucune conversion n'est necessaire,
 *    et c'est precisement ce qui rend l'integration possible.**
 */
import { US1976_EARTH_RADIUS } from './constants'

// ---------------------------------------------------------------------------
// Les rayons terrestres du projet
// ---------------------------------------------------------------------------

/**
 * Rayon terrestre moyen, m — pour la geometrie du transport radiatif.
 *
 * C'est le rayon d'une sphere de meme volume que l'ellipsoide. Il sert aux
 * intersections rayon-sphere du transfert radiatif, ou l'ecart equateur-pole
 * (21 km, soit 0,3 %) est sans consequence sur la profondeur optique, alors que
 * la simplicite d'une sphere l'est enormement.
 *
 * Coherent avec `PLANET_RADIUS_M` de `scene/atmosphere.ts`.
 */
export const EARTH_MEAN_RADIUS_M = 6_371_000

/**
 * **Le projet utilise trois rayons terrestres differents, et c'est correct.**
 *
 * Les confondre serait une erreur ; les unifier aussi. Chacun repond a une
 * question distincte :
 *
 * | Constante | Valeur | Question a laquelle elle repond |
 * | --- | --- | --- |
 * | `EARTH_RADIUS_KM` (`astro/coords.ts`) | 6 378,137 km | ou est physiquement l'observateur ? (WGS84, equatorial, avec aplatissement) |
 * | `EARTH_MEAN_RADIUS_M` (ici) | 6 371 km | quelle epaisseur d'air le rayon traverse-t-il ? (sphere de meme volume) |
 * | `US1976_EARTH_RADIUS` (`constants.ts`) | 6 356,766 km | quelle altitude geopotentielle correspond a cette altitude geometrique ? |
 *
 * Le troisieme n'est meme pas une longueur geometrique : c'est un parametre de
 * changement de variable. Cette table existe pour qu'une future relecture ne
 * « corrige » pas une incoherence qui n'en est pas une.
 */
export const EARTH_RADII_RATIONALE = {
  wgs84EquatorialM: 6_378_137,
  meanM: EARTH_MEAN_RADIUS_M,
  us1976GeopotentialM: US1976_EARTH_RADIUS,
} as const

// ---------------------------------------------------------------------------
// Longueurs
// ---------------------------------------------------------------------------

export const kmToM = (km: number): number => km * 1000
export const mToKm = (m: number): number => m / 1000

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

export const DEG_TO_RAD = Math.PI / 180
export const RAD_TO_DEG = 180 / Math.PI

export const degToRad = (deg: number): number => deg * DEG_TO_RAD
export const radToDeg = (rad: number): number => rad * RAD_TO_DEG

/** Secondes d'arc vers radians — unite naturelle de la refraction astronomique. */
export const arcsecToRad = (arcsec: number): number => (arcsec / 3600) * DEG_TO_RAD
export const radToArcsec = (rad: number): number => (rad * RAD_TO_DEG) * 3600

// ---------------------------------------------------------------------------
// Longueurs d'onde
// ---------------------------------------------------------------------------

/**
 * Les longueurs d'onde circulent en **nanometres** dans les interfaces, et en
 * metres dans les formules qui l'exigent.
 *
 * Ce n'est pas une inconsistance mais un choix explicite : la litterature
 * optique parle en nanometres (« 550 nm »), et une interface qui parlerait en
 * 5,5·10⁻⁷ m serait illisible et propice aux erreurs d'ordre de grandeur. Les
 * conversions sont donc locales aux formules, et **tout parametre nomme
 * `lambdaNm` est en nanometres**, sans exception.
 */
export const VISIBLE_MIN_NM = 360
export const VISIBLE_MAX_NM = 830

/** Longueur d'onde de reference de l'optique atmospherique, nm. */
export const REFERENCE_WAVELENGTH_NM = 550

// ---------------------------------------------------------------------------
// Geometrie de l'observateur
// ---------------------------------------------------------------------------

/**
 * Position de l'observateur dans le repere centre sur la planete, en metres.
 *
 * L'observateur regarde depuis `(0, R + altitude, 0)` : le zenith local est
 * +Y, ce qui aligne ce repere sur celui de la scene et rend les directions
 * directement transportables (voir l'en-tete de ce fichier).
 *
 * **`elevationM` n'est pas optionnel.** Le rendu actuel place l'observateur au
 * niveau de la mer en dur, alors que le lieu porte son altitude — de 12 m a
 * Marseille a 2 877 m au Pic du Midi. A cette derniere, un quart de la masse
 * atmospherique est deja sous l'observateur : ignorer l'altitude n'est pas une
 * approximation, c'est une autre atmosphere. Le parametre est donc obligatoire,
 * pour qu'aucun appelant ne puisse l'oublier par defaut.
 */
export function observerPosition(elevationM: number): [number, number, number] {
  return [0, EARTH_MEAN_RADIUS_M + elevationM, 0]
}

/**
 * Altitude au-dessus du sol d'un point du repere centre sur la planete, en m.
 */
export function altitudeOf(position: readonly [number, number, number]): number {
  return Math.hypot(position[0], position[1], position[2]) - EARTH_MEAN_RADIUS_M
}

// ---------------------------------------------------------------------------
// Directions : la frontiere qui n'en est pas une
// ---------------------------------------------------------------------------

/**
 * Direction de visee a partir de coordonnees horizontales, dans le repere
 * physique local — **identique au repere de la scene**.
 *
 * Volontairement identique a `viewDirection()` de `scene/sceneMath.ts`. La
 * duplication est assumee : le solveur ne doit pas dependre du module de scene,
 * sous peine d'ouvrir un chemin par lequel une unite de rendu finirait par
 * remonter jusqu'a la physique. `units.validation.ts` verifie que les deux
 * fonctions coincident, ce qui transforme cette duplication en invariant teste
 * plutot qu'en dette.
 */
export function directionFromHorizontal(azimuthRad: number, altitudeRad: number): [number, number, number] {
  const ca = Math.cos(altitudeRad)
  return [ca * Math.sin(azimuthRad), Math.sin(altitudeRad), -ca * Math.cos(azimuthRad)]
}

/** Hauteur au-dessus de l'horizon d'une direction unitaire, en radians. */
export function altitudeAngleOf(direction: readonly [number, number, number]): number {
  const n = Math.hypot(direction[0], direction[1], direction[2]) || 1
  return Math.asin(Math.min(1, Math.max(-1, direction[1] / n)))
}
