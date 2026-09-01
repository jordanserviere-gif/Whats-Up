/**
 * Capteur spectral — `L(λ) → XYZ → RGB lineaire`.
 *
 * Dernier maillon de la chaine physique, et **frontiere de sortie du moteur** :
 * en amont tout est radiometrique et spectral, en aval tout est colorimetrique
 * et trichromatique.
 *
 * ```
 * radiance spectrale  →  CIE XYZ  →  RGB lineaire  →  [exposition, tone mapping]  →  ecran
 *        ^                                                        ^
 *        |                                                        |
 *   ce module s'arrete ici -------------------------- ce qui reste a faire (phase 0.5)
 * ```
 *
 * **Ce module ne fait ni exposition ni tone mapping.** Il rend du RGB lineaire
 * non borne, qui peut valoir 10⁴ pour un disque solaire. La compression vers
 * l'ecran est une decision d'affichage, pas de physique, et elle appartient a
 * la passe d'affichage unique que la phase 0.5 introduira. C'est precisement ce
 * melange que le rendu actuel opere a l'interieur de chaque materiau, et qui
 * empeche aujourd'hui une radiance de survivre jusqu'a l'ecran.
 */
import { LUMINOUS_EFFICACY, colourMatchingOn, type ColourMatchingFunctions } from './colourMatching'
import type { SpectralArray, SpectralGrid } from './SpectralGrid'

export type Xyz = readonly [number, number, number]
export type LinearRgb = readonly [number, number, number]

/**
 * Matrice sRGB lineaire → CIE XYZ (illuminant D65).
 *
 * IEC 61966-2-1. La **deuxieme ligne est la luminance relative** :
 * `(0,2126729, 0,7151522, 0,0721750)` — exactement le triplet deja utilise par
 * `scene/atmosphere.ts` dans sa resaturation post-courbe. La coincidence n'en
 * est pas une, et la suite de validation la verifie : c'est un point de
 * raccord entre le nouveau moteur et le rendu existant.
 */
export const LINEAR_SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
] as const

/** Matrice CIE XYZ → sRGB lineaire (illuminant D65). Inverse de la precedente. */
export const XYZ_TO_LINEAR_SRGB = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.9692660, 1.8760108, 0.0415560],
  [0.0556434, -0.2040259, 1.0572252],
] as const

/**
 * Integre une radiance spectrale en tristimulus CIE XYZ.
 *
 * `XYZ = ∫ L(λ) · (x̄, ȳ, z̄)(λ) dλ`, discretise en `Σ Lᵢ · cmfᵢ · largeurᵢ`.
 *
 * Les fonctions colorimetriques etant **moyennees par bande** (voir
 * `SpectralGrid.ts`), `cmfᵢ × largeurᵢ` vaut exactement l'integrale de la
 * courbe sur la bande : le resultat est donc independant du nombre de bandes
 * pour un spectre lisse, ce que la suite de validation verifie explicitement.
 *
 * Les unites du resultat sont celles de l'entree. Une radiance en W·m⁻²·sr⁻¹·nm⁻¹
 * rend un `Y` qui devient une luminance en cd/m² une fois multiplie par
 * `LUMINOUS_EFFICACY` — voir `luminance()`.
 */
export function spectralToXyz(
  grid: SpectralGrid,
  spectrum: SpectralArray,
  cmfs: ColourMatchingFunctions = colourMatchingOn(grid),
): Xyz {
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < grid.count; i++) {
    const weight = spectrum[i] * grid.widthNm[i]
    x += weight * cmfs.x[i]
    y += weight * cmfs.y[i]
    z += weight * cmfs.z[i]
  }
  return [x, y, z]
}

/**
 * Luminance photometrique, cd/m², depuis une radiance spectrale en
 * W·m⁻²·sr⁻¹·nm⁻¹.
 *
 * `L_v = K_cd · ∫ L(λ) ȳ(λ) dλ`, avec `K_cd = 683 lm/W` exact par definition.
 *
 * C'est le pont vers `astro/photometry.ts`, qui calcule deja tout son bilan
 * lumineux en lux par un chemin entierement independant. Confronter les deux
 * sera la meilleure validation croisee disponible dans ce depot — et c'est
 * aussi ce qui remplacera la constante d'exposition arbitraire du rendu actuel.
 */
export function luminance(
  grid: SpectralGrid,
  spectrum: SpectralArray,
  cmfs: ColourMatchingFunctions = colourMatchingOn(grid),
): number {
  let y = 0
  for (let i = 0; i < grid.count; i++) y += spectrum[i] * grid.widthNm[i] * cmfs.y[i]
  return LUMINOUS_EFFICACY * y
}

/** Coordonnees de chromaticite `(x, y)` — la couleur, independamment de l'intensite. */
export function chromaticity(xyz: Xyz): readonly [number, number] {
  const sum = xyz[0] + xyz[1] + xyz[2]
  if (!(sum > 0)) return [0, 0]
  return [xyz[0] / sum, xyz[1] / sum]
}

/**
 * CIE XYZ vers sRGB **lineaire**, non borne.
 *
 * Pas d'ecretage, pas de courbe de transfert : une composante peut sortir
 * negative si la couleur est hors du gamut sRGB — ce qui arrive reellement pour
 * un ciel tres sature ou une raie spectrale. Ecraser ce signe ici perdrait
 * l'information avant que la passe d'affichage n'ait pu decider quoi en faire
 * (compression de gamut, desaturation). **Le capteur mesure, il ne juge pas.**
 */
export function xyzToLinearSrgb(xyz: Xyz): LinearRgb {
  const m = XYZ_TO_LINEAR_SRGB
  return [
    m[0][0] * xyz[0] + m[0][1] * xyz[1] + m[0][2] * xyz[2],
    m[1][0] * xyz[0] + m[1][1] * xyz[1] + m[1][2] * xyz[2],
    m[2][0] * xyz[0] + m[2][1] * xyz[1] + m[2][2] * xyz[2],
  ]
}

/** sRGB lineaire vers CIE XYZ. */
export function linearSrgbToXyz(rgb: LinearRgb): Xyz {
  const m = LINEAR_SRGB_TO_XYZ
  return [
    m[0][0] * rgb[0] + m[0][1] * rgb[1] + m[0][2] * rgb[2],
    m[1][0] * rgb[0] + m[1][1] * rgb[1] + m[1][2] * rgb[2],
    m[2][0] * rgb[0] + m[2][1] * rgb[1] + m[2][2] * rgb[2],
  ]
}

/**
 * Chaine complete : radiance spectrale vers sRGB lineaire.
 *
 * Le raccourci courant du moteur. Toujours non borne, toujours sans tone
 * mapping.
 */
export function spectralToLinearSrgb(
  grid: SpectralGrid,
  spectrum: SpectralArray,
  cmfs?: ColourMatchingFunctions,
): LinearRgb {
  return xyzToLinearSrgb(spectralToXyz(grid, spectrum, cmfs))
}

/**
 * Temperature de couleur correlee, K, par l'approximation de McCamy (1992).
 *
 *     n = (x − 0,3320) / (0,1858 − y)
 *     CCT = 449 n³ + 3525 n² + 6823,3 n + 5520,33
 *
 * **Ce n'est pas de la physique du moteur** : c'est un instrument de mesure,
 * utilise par la validation pour verifier qu'un spectre de Planck a T ressort
 * bien a T. L'approximation est fidele a quelques kelvins entre 2 000 et
 * 12 000 K et se degrade au-dela ; elle n'entre dans aucun rendu.
 */
export function correlatedColourTemperature(xyz: Xyz): number {
  const [x, y] = chromaticity(xyz)
  const n = (x - 0.332) / (0.1858 - y)
  return 449 * n * n * n + 3525 * n * n + 6823.3 * n + 5520.33
}
