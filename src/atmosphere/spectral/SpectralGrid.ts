/**
 * Grille spectrale — discretisation du domaine des longueurs d'onde.
 *
 * ## Pourquoi une grille, et pourquoi configurable
 *
 * Le coeur physique du moteur ne transporte pas trois canaux RGB mais une
 * grandeur spectrale `L(λ)`. Le nombre de bandes est un **curseur qualite /
 * cout**, pas une constante d'architecture : il doit pouvoir passer de 8
 * bandes pour une LUT temps reel a 471 bandes pour une validation au nanometre,
 * sans qu'aucun code appelant ne change.
 *
 * Aucun module du moteur ne doit donc coder en dur un nombre de bandes, ni
 * supposer un pas constant.
 *
 * ## Le point qui compte : moyenner, pas echantillonner
 *
 * Ramener une courbe fine (une fonction colorimetrique a 1 nm, un spectre
 * solaire dentele de raies de Fraunhofer) sur une grille grossiere se fait par
 * **integration sur la bande**, jamais par prelevement au centre.
 *
 * La difference n'est pas cosmetique. Sur 16 bandes, prelever au centre de
 * chaque bande manque les pics des fonctions colorimetriques et perd de
 * l'energie : le blanc cesse d'etre blanc, et l'erreur depend du nombre de
 * bandes — ce qui rend toute comparaison entre resolutions impossible.
 *
 * Avec la moyenne de bande, `valeur_i × largeur_i` vaut exactement l'integrale
 * de la courbe sur la bande. La somme sur toutes les bandes reconstitue donc
 * l'integrale totale **quelle que soit la grille**. C'est cette propriete qui
 * est verifiee dans `SpectralSensor.validation.ts` : un illuminant d'energie
 * egale doit rendre la meme chromaticite a 8, 16, 32 ou 471 bandes.
 */

/**
 * Grille spectrale : des bandes contigues couvrant un domaine.
 *
 * Les bornes sont conservees explicitement plutot que deduites des centres :
 * une grille non uniforme (bandes serrees dans le bleu, larges dans le rouge)
 * reste ainsi representable sans changer le type.
 */
export interface SpectralGrid {
  readonly count: number
  /** Centre de chaque bande, nm. */
  readonly lambdaNm: Float64Array
  /** Bornes des bandes, nm — `count + 1` valeurs croissantes. */
  readonly edgesNm: Float64Array
  /** Largeur de chaque bande, nm. */
  readonly widthNm: Float64Array
}

/** Valeurs echantillonnees sur une grille : une par bande. */
export type SpectralArray = Float64Array

/**
 * Domaine du systeme visuel humain, nm.
 *
 * Ce sont les bornes des fonctions colorimetriques CIE 1931. Sortir de ce
 * domaine est inutile pour l'image : l'oeil n'y repond pas. Mais un solveur
 * peut avoir besoin d'aller au-dela pour un bilan energetique — la grille ne
 * force donc rien, elle propose.
 */
export const VISIBLE_MIN_NM = 360
export const VISIBLE_MAX_NM = 830

/**
 * Nombre de bandes par defaut.
 *
 * Seize bandes sur 360–830 nm donnent des bandes de ~29 nm. C'est assez fin
 * pour que la loi de Rayleigh en λ⁻⁴ varie proprement d'un bout a l'autre du
 * visible (facteur 28 entre 360 et 830 nm), et assez grossier pour rester
 * abordable dans une LUT. Ce n'est **pas** une valeur imposee : c'est le point
 * de depart raisonnable que la phase 19 pourra ajuster sur mesure.
 */
export const DEFAULT_BAND_COUNT = 16

/** Grille a bandes de largeur constante. */
export function uniformSpectralGrid(
  minNm = VISIBLE_MIN_NM,
  maxNm = VISIBLE_MAX_NM,
  count = DEFAULT_BAND_COUNT,
): SpectralGrid {
  if (!(count >= 1) || !Number.isInteger(count)) throw new Error(`nombre de bandes invalide : ${count}`)
  if (!(maxNm > minNm)) throw new Error(`domaine spectral invalide : ${minNm}–${maxNm} nm`)

  const edgesNm = new Float64Array(count + 1)
  const lambdaNm = new Float64Array(count)
  const widthNm = new Float64Array(count)
  const step = (maxNm - minNm) / count

  for (let i = 0; i <= count; i++) edgesNm[i] = minNm + step * i
  for (let i = 0; i < count; i++) {
    lambdaNm[i] = (edgesNm[i] + edgesNm[i + 1]) / 2
    widthNm[i] = edgesNm[i + 1] - edgesNm[i]
  }

  return { count, lambdaNm, edgesNm, widthNm }
}

/** Identifiant stable d'une grille — sert de cle de cache. */
export function gridKey(grid: SpectralGrid): string {
  return `${grid.count}:${grid.edgesNm[0]}:${grid.edgesNm[grid.count]}`
}

/**
 * Integrale d'une courbe echantillonnee, interpolee lineairement entre ses
 * points, sur l'intervalle `[a, b]`.
 *
 * Exacte pour une courbe effectivement affine par morceaux — ce qui est la
 * definition meme d'une table interpolee lineairement. Hors du domaine
 * tabule, la contribution est nulle : on n'extrapole jamais une donnee
 * experimentale.
 */
export function integratePiecewiseLinear(
  sourceLambdaNm: ArrayLike<number>,
  sourceValues: ArrayLike<number>,
  a: number,
  b: number,
): number {
  if (!(b > a)) return 0

  let total = 0
  for (let i = 1; i < sourceLambdaNm.length; i++) {
    const x0 = sourceLambdaNm[i - 1]
    const x1 = sourceLambdaNm[i]
    if (x1 <= a || x0 >= b) continue

    const lo = Math.max(x0, a)
    const hi = Math.min(x1, b)
    if (!(hi > lo)) continue

    const span = x1 - x0
    const y0 = sourceValues[i - 1]
    const y1 = sourceValues[i]
    // Valeurs interpolees aux bornes du sous-intervalle effectivement couvert.
    const vLo = y0 + ((y1 - y0) * (lo - x0)) / span
    const vHi = y0 + ((y1 - y0) * (hi - x0)) / span
    total += ((vLo + vHi) / 2) * (hi - lo)
  }

  return total
}

/**
 * Reechantillonne une courbe tabulee sur une grille, **par moyenne de bande**.
 *
 * C'est la seule facon correcte de changer de resolution spectrale, et la
 * raison est donnee dans l'en-tete du module : elle preserve l'integrale, donc
 * l'energie, donc la couleur.
 */
export function resampleToGrid(
  grid: SpectralGrid,
  sourceLambdaNm: ArrayLike<number>,
  sourceValues: ArrayLike<number>,
): SpectralArray {
  const out = new Float64Array(grid.count)
  for (let i = 0; i < grid.count; i++) {
    const integral = integratePiecewiseLinear(sourceLambdaNm, sourceValues, grid.edgesNm[i], grid.edgesNm[i + 1])
    out[i] = integral / grid.widthNm[i]
  }
  return out
}

/**
 * Echantillonne une fonction analytique sur une grille, par moyenne de bande.
 *
 * Une fonction analytique n'a pas de points tabules : on la subdivise. Huit
 * sous-echantillons par bande suffisent pour les courbes lisses du moteur
 * (Planck, Rayleigh) — toutes sans structure fine a l'echelle du nanometre,
 * contrairement au spectre solaire et a ses raies d'absorption.
 */
export function sampleFunctionToGrid(
  grid: SpectralGrid,
  f: (lambdaNm: number) => number,
  subdivisions = 8,
): SpectralArray {
  const out = new Float64Array(grid.count)
  for (let i = 0; i < grid.count; i++) {
    const a = grid.edgesNm[i]
    const step = grid.widthNm[i] / subdivisions
    // Simpson composite sur la bande : exact jusqu'au degre 3, ce qui suffit
    // largement pour une exponentielle echantillonnee sur quelques nanometres.
    let sum = 0
    for (let k = 0; k < subdivisions; k++) {
      const x0 = a + step * k
      sum += (step / 6) * (f(x0) + 4 * f(x0 + step / 2) + f(x0 + step))
    }
    out[i] = sum / grid.widthNm[i]
  }
  return out
}

/** Integrale d'une grandeur spectrale sur toute la grille : `Σ vᵢ × largeurᵢ`. */
export function integrateOverGrid(grid: SpectralGrid, values: SpectralArray): number {
  let total = 0
  for (let i = 0; i < grid.count; i++) total += values[i] * grid.widthNm[i]
  return total
}

/** Produit terme a terme de deux grandeurs spectrales. */
export function multiplySpectral(a: SpectralArray, b: SpectralArray): SpectralArray {
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] * b[i]
  return out
}
