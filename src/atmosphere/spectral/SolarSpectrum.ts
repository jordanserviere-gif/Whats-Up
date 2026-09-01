/**
 * Spectre solaire hors atmosphere.
 *
 * C'est l'**entree** du moteur : tout ce que le transport atmospherique fera
 * ensuite consiste a retirer et redistribuer de l'energie de ce spectre. Il
 * remplace `SUN_INTENSITY_REF = 22` du rendu actuel, que son propre commentaire
 * decrivait comme « une constante de calibrage du modele, pas une grandeur
 * physique en lux ».
 *
 * Donnees : `src/data/solar-am0.json`, genere par `npm run data:spectral` a
 * partir de l'ASTM G173-03 (colonne « extraterrestrial », derivee de l'ASTM
 * E-490), tabulee de 280 a 4000 nm en W/m²/nm.
 *
 * ## Deux nombres a ne pas confondre
 *
 * L'integrale de la table vaut **1347,9 W/m²**, pas la constante solaire de
 * 1361 W/m². Les 13,1 W/m² d'ecart — 0,96 % — sont l'infrarouge lointain
 * au-dela de 4 µm et l'ultraviolet sous 280 nm, simplement hors du domaine
 * tabule. Renormaliser la table pour « retrouver » 1361 serait une erreur :
 * cela ajouterait dans le visible une energie qui est ailleurs.
 *
 * Le domaine qui interesse le moteur, 360–830 nm, porte **734,8 W/m²**.
 *
 * ## Distance
 *
 * La table est donnee a 1 UA. L'irradiance suit l'inverse du carre de la
 * distance, et l'orbite terrestre est excentrique : l'ecart perihelie-aphelie
 * atteint 6,9 % sur l'annee, ce qui n'est pas negligeable devant les effets que
 * le moteur cherche a rendre. `scaleToDistance` applique la correction.
 */
import data from '@/data/solar-am0.json'
import {
  integrateOverGrid,
  resampleToGrid,
  type SpectralArray,
  type SpectralGrid,
  gridKey,
} from './SpectralGrid'

/** Domaine tabule, nm. */
export const SOLAR_MIN_NM = data.lambdaNm[0]
export const SOLAR_MAX_NM = data.lambdaNm[data.lambdaNm.length - 1]

/** Provenance de la table, pour les rapports de validation. */
export const SOLAR_SOURCE = data.source

const cache = new Map<string, SpectralArray>()

/**
 * Irradiance solaire spectrale a 1 UA, en **W/m²/nm**, sur une grille.
 *
 * Moyennee par bande : le spectre solaire est herisse de raies de Fraunhofer,
 * et un prelevement au centre de bande tomberait au hasard dans ou a cote d'une
 * raie. C'est le cas ou l'integration par bande compte le plus.
 */
export function solarIrradianceOn(grid: SpectralGrid): SpectralArray {
  const key = gridKey(grid)
  const cached = cache.get(key)
  if (cached) return cached

  const values = resampleToGrid(grid, data.lambdaNm, data.irradiance)
  cache.set(key, values)
  return values
}

/**
 * Met a l'echelle une irradiance pour une distance donnee, en UA.
 *
 * Loi en `1/d²`. A l'aphelie (1,0167 UA) le Soleil rayonne 3,3 % de moins qu'a
 * la moyenne, au perihelie 3,4 % de plus.
 */
export function scaleToDistance(irradiance: SpectralArray, distanceAu: number): SpectralArray {
  const factor = 1 / (distanceAu * distanceAu)
  const out = new Float64Array(irradiance.length)
  for (let i = 0; i < irradiance.length; i++) out[i] = irradiance[i] * factor
  return out
}

/** Irradiance totale portee par une grille, W/m². */
export function totalIrradiance(grid: SpectralGrid, irradiance: SpectralArray): number {
  return integrateOverGrid(grid, irradiance)
}

/** Table brute, au pas natif — pour la validation et les bilans energetiques. */
export function rawSolarSpectrum(): { lambdaNm: readonly number[]; irradiance: readonly number[] } {
  return { lambdaNm: data.lambdaNm, irradiance: data.irradiance }
}
