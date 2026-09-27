/**
 * Genre des nuages — deduit de la donnee, comme le font les classifications
 * publiees.
 *
 * Deux references, qui disent la meme chose par deux chemins :
 *
 * - **ISCCP** (Rossow & Schiffer 1999) classe par la pression du sommet et
 *   l'epaisseur optique : bas, moyen, haut × mince, moyen, epais. En haut,
 *   τ < 3,6 donne des cirrus, 3,6 a 23 des cirrostratus, au-dela de la
 *   convection profonde.
 * - **Wang & Sassen (2001)**, repris par le produit 2B-CLDCLASS de CloudSat,
 *   ajoute la hauteur de base, l'epaisseur, la temperature et les
 *   precipitations : c'est ce qui separe un stratus d'un stratocumulus, un
 *   cumulus d'un cumulonimbus, un altostratus d'un nimbostratus.
 *
 * On a tout cela par maille : base et sommet, temperature, epaisseur optique,
 * pluie, et le panache convectif (libre ou bride) de `convection.ts`.
 *
 * Chaque genre porte ensuite ce que le rendu doit savoir : son **profil
 * vertical de densite** (la silhouette d'un cumulus n'est pas celle d'un
 * stratus), la **taille de ses cellules** rapportee a son epaisseur, et le
 * **style de ses bords** — bourgeons ou filaments.
 */

export type CloudGenus = 'St' | 'Sc' | 'Cu' | 'Cb' | 'Ns' | 'Ac' | 'As' | 'Ci' | 'Cs'

/** Code numerique, tel qu'il est range dans la texture du champ. */
export const GENUS_CODE: Record<CloudGenus, number> = { St: 0, Sc: 1, Cu: 2, Cb: 3, Ns: 4, Ac: 5, As: 6, Ci: 7, Cs: 8 }

export interface GenusInputs {
  stage: 'bas' | 'moyen' | 'haut'
  coverage: number
  baseM: number
  topM: number
  opticalDepth: number
  /** Temperature au sommet, °C. */
  topTemperatureC: number
  /** Precipitations, mm/h. */
  precipitationMmH: number
  /** Le nuage vient-il du panache convectif, et monte-t-il librement ? */
  convective: 'libre' | 'bride' | null
}

export function cloudGenus(i: GenusInputs): CloudGenus {
  const depth = i.topM - i.baseM
  if (i.stage === 'haut') {
    if (i.opticalDepth > 23) return 'Cb'
    return i.opticalDepth > 3.6 || i.coverage > 0.85 ? 'Cs' : 'Ci'
  }
  if (i.stage === 'moyen') {
    if (i.precipitationMmH >= 0.5 && depth > 2000) return 'Ns'
    return i.coverage > 0.8 && depth > 800 ? 'As' : 'Ac'
  }
  // Etage bas.
  if (i.convective) {
    // Convection profonde : sommet glace et epais, ou averse.
    if (depth > 3000 && (i.topTemperatureC < -20 || i.precipitationMmH >= 1)) return 'Cb'
    // Une nappe convective presque continue est un stratocumulus.
    return i.coverage > 0.75 ? 'Sc' : 'Cu'
  }
  if (i.precipitationMmH >= 0.5 && depth > 2000) return 'Ns'
  return depth < 500 && i.coverage > 0.8 ? 'St' : 'Sc'
}

/**
 * Ce que le rendu tire du genre.
 *
 * - `profile` : points (hauteur relative, densite relative) du profil
 *   vertical, lineaires par morceaux — les « gradients de hauteur » d'Horizon,
 *   ici par genre et non au jugé : un cumulus est plein de sa base plate a un
 *   sommet arrondi ; un stratus, dense au milieu et flou aux bords ; un
 *   stratocumulus, cellulaire et aplati.
 * - `cellToDepth` : largeur des cellules sur l'epaisseur. Cumulus de beau
 *   temps : ~1,5 ; stratocumulus : 5 a 10 (cellules de Benard aplaties).
 * - `billow` : 1 pour des bords en bourgeons, 0 pour des bords effiles.
 */
export interface GenusShape {
  profile: [number, number][]
  cellToDepth: number
  billow: number
}

export const GENUS_SHAPE: Record<CloudGenus, GenusShape> = {
  St: { profile: [[0, 0], [0.15, 1], [0.85, 1], [1, 0]], cellToDepth: 12, billow: 0 },
  Sc: { profile: [[0, 0], [0.1, 0.9], [0.6, 1], [1, 0]], cellToDepth: 6, billow: 0.5 },
  // Dôme continu : les flancs rentrent regulierement jusqu'au sommet, pas de mur vertical.
  Cu: { profile: [[0, 0], [0.04, 1], [0.25, 0.95], [0.5, 0.78], [0.75, 0.5], [0.92, 0.22], [1, 0]], cellToDepth: 1.5, billow: 1 },
  Cb: { profile: [[0, 0], [0.03, 1], [0.6, 0.9], [0.85, 0.75], [1, 0.3]], cellToDepth: 1, billow: 1 },
  Ns: { profile: [[0, 0.6], [0.1, 1], [0.9, 1], [1, 0]], cellToDepth: 15, billow: 0 },
  Ac: { profile: [[0, 0], [0.3, 1], [0.7, 1], [1, 0]], cellToDepth: 4, billow: 0.6 },
  As: { profile: [[0, 0], [0.2, 1], [0.9, 1], [1, 0]], cellToDepth: 15, billow: 0 },
  Ci: { profile: [[0, 0], [0.5, 1], [1, 0]], cellToDepth: 8, billow: 0 },
  Cs: { profile: [[0, 0], [0.3, 1], [0.8, 1], [1, 0]], cellToDepth: 15, billow: 0 },
}

/** Profil vertical d'un genre, a la hauteur relative `h`. */
export function genusProfile(genus: CloudGenus, h: number): number {
  const p = GENUS_SHAPE[genus].profile
  if (h <= p[0][0]) return p[0][1]
  for (let k = 1; k < p.length; k++) {
    if (h <= p[k][0]) {
      const [h0, d0] = p[k - 1]
      const [h1, d1] = p[k]
      return d0 + ((d1 - d0) * (h - h0)) / (h1 - h0)
    }
  }
  return p[p.length - 1][1]
}

/**
 * Le profil de chaque genre pour le nuanceur : une table de 9 genres × 16
 * hauteurs, lue par \`cloudGenusProfile(code, h)\`.
 */
export const GENUS_PROFILE_SAMPLES = 16
export function genusProfileTable(): Float32Array {
  const genera = Object.keys(GENUS_CODE) as CloudGenus[]
  const out = new Float32Array(genera.length * GENUS_PROFILE_SAMPLES)
  for (const g of genera)
    for (let k = 0; k < GENUS_PROFILE_SAMPLES; k++) out[GENUS_CODE[g] * GENUS_PROFILE_SAMPLES + k] = genusProfile(g, k / (GENUS_PROFILE_SAMPLES - 1))
  return out
}
