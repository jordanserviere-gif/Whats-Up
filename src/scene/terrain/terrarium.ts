/**
 * Tuiles d'altitude « terrarium » — la donnee, et rien que la donnee.
 *
 * ## Ce que c'est
 *
 * Un modele numerique de terrain **mondial**, publie en tuiles PNG sur le
 * programme des donnees ouvertes d'AWS. Pas de jeton, pas de quota, CORS
 * permissif. Chaque pixel porte une altitude encodee sur trois canaux :
 *
 *     h = R x 256 + V + B / 256 - 32768        (metres)
 *
 * Le decalage de 32768 laisse la place aux profondeurs oceaniques ; le canal
 * bleu donne le seizieme de metre, bien au-dela de la precision reelle.
 *
 * ## Ce qu'elle vaut vraiment
 *
 * La resolution native est de **trente metres** — SRTM sous 60° de latitude,
 * complete ailleurs par des sources nationales. C'est le plafond de qualite du
 * relief proche, et **aucun choix de format ne le releve** : a cinq kilometres,
 * trente metres sous-tendent 0,34°, soit une dizaine de pixels. Le relief
 * lointain, lui, est largement sur-echantillonne par cette meme donnee.
 *
 * Demander un zoom au-dela de z=13 ne cree donc aucune information : les
 * tuiles y sont interpolees depuis la meme grille de trente metres.
 *
 * ## Le piege de la mer
 *
 * ⚠️ Terrarium encode aussi la **bathymetrie** : au large, les valeurs sont
 * franchement negatives — plusieurs milliers de metres. Prises telles quelles,
 * elles creusent l'ocean en cuvette et l'observateur cotier se retrouve au bord
 * d'une falaise de quatre kilometres.
 *
 * On ecrete donc a zero. Le prix est connu et assume : les depressions
 * continentales sous le niveau de la mer — mer Morte a -430 m, vallee de la
 * Mort a -86 m — sont mises a plat. Les distinguer demanderait un masque
 * terre/eau, une source de plus.
 *
 * Attribution requise par le jeu de donnees : Mapzen / AWS Open Data, a partir
 * de SRTM (NASA), NED (USGS) et sources nationales.
 */
import { TILE_SIZE } from './geodesy'

/** Racine des tuiles, sans jeton. */
const TERRARIUM_ROOT = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

/** Attribution a afficher, exigee par la source. */
export const TERRARIUM_ATTRIBUTION = 'Relief : Mapzen / AWS Open Data (SRTM, NED)'

/**
 * Zoom au-dela duquel la source n'apporte plus rien.
 *
 * A z=13 le pixel vaut environ treize metres a nos latitudes, soit deja moins
 * que les trente metres natifs. Au-dela, on telechargerait de l'interpolation.
 */
export const TERRARIUM_MAX_ZOOM = 13

/** Resolution native de la source, m. */
export const TERRARIUM_NATIVE_RESOLUTION_M = 30

export const terrariumUrl = (zoom: number, x: number, y: number): string =>
  `${TERRARIUM_ROOT}/${zoom}/${x}/${y}.png`

/**
 * Altitude portee par un pixel, m.
 *
 * Separee du decodage d'une tuile entiere pour que la validation puisse la
 * verifier sur des triplets connus, sans decodeur PNG ni navigateur.
 */
export const terrariumHeightM = (r: number, g: number, b: number): number =>
  r * 256 + g + b / 256 - 32768

/**
 * Convertit les octets RGBA d'une tuile decodee en altitudes signees, m.
 *
 * ⚠️ **La bathymetrie est conservee ici.** L'ecretage appartient a la surface du
 * terrain, pas au decodage : la carte de selection du lieu a besoin du signe
 * pour distinguer la mer de la plaine cotiere, que zero rendrait identiques.
 *
 * Les bornes ne servent qu'a contenir un pixel corrompu dans un entier signe de
 * seize bits : la fosse des Mariannes et l'Everest y tiennent l'un et l'autre.
 */
export function decodeTerrariumTile(rgba: Uint8ClampedArray | Uint8Array): Int16Array {
  const count = TILE_SIZE * TILE_SIZE
  if (rgba.length < count * 4) {
    throw new Error(`tuile tronquee : ${rgba.length} octets pour ${count * 4} attendus`)
  }
  const out = new Int16Array(count)
  for (let i = 0; i < count; i++) {
    const j = i * 4
    const h = terrariumHeightM(rgba[j], rgba[j + 1], rgba[j + 2])
    out[i] = Math.max(-11_000, Math.min(9000, Math.round(h)))
  }
  return out
}

/**
 * Altitude de la **surface** sur laquelle on marche, m.
 *
 * ⚠️ Terrarium encode la bathymetrie : au large, les valeurs descendent a
 * plusieurs milliers de metres negatifs. Prises telles quelles, elles creusent
 * l'ocean en cuvette et l'observateur cotier se retrouve au bord d'une falaise
 * de quatre kilometres.
 *
 * On ecrete donc a zero. Le prix est connu et assume : les depressions
 * continentales sous le niveau de la mer — mer Morte a -430 m, vallee de la Mort
 * a -86 m — sont mises a plat. Les distinguer demanderait un masque terre/eau,
 * une source de plus.
 */
export const terrainSurfaceM = (rawHeightM: number): number => Math.max(0, rawHeightM)
