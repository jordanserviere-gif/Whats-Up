/**
 * La couture entre le relief et tout ce qui le regarde.
 *
 * Deux consommateurs, et deux seulement : le maillage radial de `Terrain`, et
 * le balayage d'ombre de `sunShadow`. Tous deux posent la meme question — quelle
 * altitude en ce point du plan local — et c'est la seule que ce module repond.
 *
 * Il existe parce que la **source** doit pouvoir changer sans que rien d'autre
 * bouge :
 *
 * - `reel` — la pyramide chargee depuis les tuiles d'altitude ;
 * - `banc` — la chaine synthetique, deterministe et hors ligne, sur laquelle la
 *   validation et les mesures de performance ont ete etalonnees.
 *
 * Garder le banc n'est pas de la nostalgie : c'est le seul relief dont on
 * connaisse la reponse exacte, donc le seul contre lequel on puisse mesurer une
 * regression sans dependre du reseau.
 */
import {
  elevationM as realElevationM,
  elevationReady,
  maxElevationM,
  readyLevelCount,
} from './elevationSource'
import { RIDGE_PEAK_M, ridgeAltitudeM } from './ridgeField'

export type TerrainSource = 'reel' | 'banc'

let source: TerrainSource = 'reel'

/** Choisit la source. Un changement invalide tout ce qui a ete echantillonne. */
export function setTerrainSource(next: TerrainSource): void {
  source = next
}

export const terrainSource = (): TerrainSource => source

/**
 * Altitude du sol en un point du plan local, m.
 *
 * En mode reel et tant que rien n'est charge, rend zero : le globe est alors une
 * sphere au niveau de la mer, ce qui est faux mais **visiblement** faux, et se
 * corrige de soi-meme des que les tuiles arrivent.
 */
export function groundAltitudeM(eastM: number, northM: number): number {
  return source === 'banc' ? ridgeAltitudeM(eastM, northM) : realElevationM(eastM, northM)
}

/** Vrai quand le relief affiche est celui du monde reel. */
export const groundIsReal = (): boolean => source === 'reel' && elevationReady()

/**
 * Cle a inclure dans toute memoisation qui echantillonne le relief.
 *
 * Un maillage construit avant l'arrivee des tuiles decrit une mer plate ; sans
 * cette cle, il ne serait jamais reconstruit.
 */
export const terrainRevision = (): string =>
  source === 'banc' ? 'banc' : `reel:${readyLevelCount()}`

/**
 * Point le plus haut du relief charge, m.
 *
 * Le plancher de cent metres evite qu'une mer parfaitement plate ne reduise la
 * portee du maillage a l'horizon geometrique : il y a toujours quelque chose a
 * voir un peu au-dela, et une portee nulle produirait un maillage degenere.
 */
/**
 * Hauteur de l'oeil au-dessus du sol sur lequel il repose, m.
 *
 * Ce n'est pas un reglage d'apparence mais une **condition d'existence** de la
 * scene. Avec un relief synthetique dont la plaine valait zero, l'observateur
 * place a l'altitude du site flottait au-dessus d'elle et voyait le sol occuper
 * tout l'hemisphere inferieur.
 *
 * Avec le relief **reel**, l'altitude du site et celle du terrain sous les pieds
 * sont la meme grandeur, a quelques metres pres. L'oeil se retrouvait donc
 * exactement sur la surface, voire dedans — et tout le sol se projetait sur
 * l'horizon, laissant l'hemisphere inferieur vide.
 *
 * Un metre soixante-dix : la hauteur d'un oeil humain debout.
 */
export const EYE_HEIGHT_M = 1.7

/** Altitude du sol sous l'observateur, m. */
export const observerGroundM = (): number => groundAltitudeM(0, 0)

/**
 * Altitude de l'oeil, m.
 *
 * Le maximum des deux lectures possibles : le sol sous les pieds plus la taille
 * d'un homme, ou l'altitude demandee pour le site. Le maximum, et non l'une ou
 * l'autre, parce que les deux situations sont legitimes — on peut se tenir au
 * sol, et on peut survoler la vallee a trois mille metres. Ce qui ne l'est
 * jamais, c'est d'avoir la tete sous terre.
 */
export function eyeAltitudeM(siteElevationM: number, extraHeightM = 0): number {
  return Math.max(siteElevationM, observerGroundM() + EYE_HEIGHT_M) + Math.max(0, extraHeightM)
}

export function terrainPeakM(): number {
  if (source === 'banc') return RIDGE_PEAK_M
  return Math.max(100, maxElevationM())
}
