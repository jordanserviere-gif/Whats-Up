/**
 * Fonctions colorimetriques CIE 1931 2° — la reponse de l'oeil.
 *
 * C'est le dernier maillon avant l'ecran : trois courbes qui reduisent un
 * spectre entier a trois nombres. Tout ce que le moteur calcule en amont — des
 * dizaines de bandes, des sections efficaces, des profondeurs optiques — finit
 * projete a travers elles.
 *
 * Donnees : `src/data/cie1931.json`, genere par `npm run data:spectral` depuis
 * la table republiee par `colour-science/colour` (BSD-3-Clause), 360–830 nm au
 * pas de 1 nm. **Jamais saisies a la main** : une valeur fausse au milieu d'une
 * courbe de sensibilite ne se voit sur aucune image mais decale toutes les
 * couleurs du moteur.
 *
 * ## Observateur 2° et non 10°
 *
 * Le CIE 1931 2° decrit la vision fovéale, sur un champ de deux degres. C'est
 * la convention de la colorimetrie standard et celle sur laquelle sRGB est
 * defini — l'utiliser garantit que la chaine `spectre → XYZ → sRGB` reste
 * coherente de bout en bout. L'observateur 10° serait plus fidele a la
 * perception d'un grand champ comme un ciel, mais il briserait cette coherence
 * avec l'espace de sortie. Choix assume ; le module est remplacable.
 */
import data from '@/data/cie1931.json'
import { gridKey, resampleToGrid, type SpectralArray, type SpectralGrid } from './SpectralGrid'

/** Les trois fonctions colorimetriques echantillonnees sur une grille. */
export interface ColourMatchingFunctions {
  readonly x: SpectralArray
  readonly y: SpectralArray
  readonly z: SpectralArray
}

/** Domaine tabule, nm. */
export const CIE_MIN_NM = data.lambdaNm[0]
export const CIE_MAX_NM = data.lambdaNm[data.lambdaNm.length - 1]

/** Provenance de la table, pour les rapports de validation. */
export const CIE_SOURCE = data.source

/**
 * Constante photometrique de rayonnement, lm/W.
 *
 * `K_cd = 683 lm/W` a 540 THz est **exacte par definition** : c'est ainsi que
 * la candela est definie depuis 1979. Elle relie la radiometrie (W) a la
 * photometrie (lm), et c'est par elle que la luminance du moteur pourra etre
 * confrontee aux lux que `astro/photometry.ts` calcule deja par un tout autre
 * chemin — la meilleure validation croisee disponible dans ce depot.
 */
export const LUMINOUS_EFFICACY = 683

// Les grilles sont peu nombreuses et reutilisees a chaque image : on garde les
// fonctions reechantillonnees plutot que de refaire l'integration de 471 points
// par bande. C'est un cache de calcul scientifique, pas une approximation.
const cache = new Map<string, ColourMatchingFunctions>()

/**
 * Fonctions colorimetriques moyennees sur les bandes d'une grille.
 *
 * Moyennees, **pas prelevees au centre** : voir `SpectralGrid.ts`. C'est ce qui
 * rend la chromaticite d'un illuminant independante du nombre de bandes.
 */
export function colourMatchingOn(grid: SpectralGrid): ColourMatchingFunctions {
  const key = gridKey(grid)
  const cached = cache.get(key)
  if (cached) return cached

  const cmfs: ColourMatchingFunctions = {
    x: resampleToGrid(grid, data.lambdaNm, data.x),
    y: resampleToGrid(grid, data.lambdaNm, data.y),
    z: resampleToGrid(grid, data.lambdaNm, data.z),
  }
  cache.set(key, cmfs)
  return cmfs
}

/** Table brute, au pas natif de 1 nm — pour la validation et les references. */
export function rawColourMatching(): {
  lambdaNm: readonly number[]
  x: readonly number[]
  y: readonly number[]
  z: readonly number[]
} {
  return { lambdaNm: data.lambdaNm, x: data.x, y: data.y, z: data.z }
}
