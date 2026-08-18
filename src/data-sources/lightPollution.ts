/**
 * Pollution lumineuse mesuree du lieu d'observation — Light Pollution Atlas de
 * David J. Lorenz, derive des observations VIIRS DNB du satellite Suomi NPP et
 * calibre sur le World Atlas de Falchi et al. (2016).
 *
 * https://djlorenz.github.io/astronomy/lp/ — CORS ouvert, sans cle.
 *
 * L'atlas ne sert pas que des images : il expose aussi les **tuiles binaires**
 * qui portent les valeurs numeriques, et c'est celles-la qu'on lit. La grandeur
 * qu'elles donnent est la brillance du fond de ciel au zenith, en magnitudes
 * par seconde d'arc carree : exactement celle sur laquelle `BORTLE_CLASSES` est
 * ancree. Aucune conversion approximative n'est donc necessaire entre la mesure
 * et le modele — voir `bortleFromSkyBrightness`.
 */
import { fetchBinary } from './fetchJson'
import type { Sourced } from './types'

/**
 * Millesime de l'atlas interroge.
 *
 * La pollution lumineuse evolue d'annee en annee — a la hausse a peu pres
 * partout — mais pas a l'echelle d'une session : une valeur annuelle est la
 * bonne granularite, contrairement a la qualite de l'air qui change dans la
 * journee.
 */
const ATLAS_YEAR = 2025

/**
 * Duree de validite en cache : un mois.
 *
 * L'atlas n'est republie qu'une fois par an. Garder la tuile un mois evite de
 * la retelecharger a chaque session tout en laissant le millesime suivant
 * arriver sans purge manuelle.
 */
const CACHE_TTL_MS = 30 * 24 * 3600_000

/** Cote d'une tuile, en points. Chaque tuile couvre 5° x 5° au 1/120e de degre. */
const TILE_POINTS = 600
const TILE_DEGREES = 5

/**
 * Couverture en latitude : les tuiles vont de 65° S a 75° N.
 *
 * Au-dela, il n'y a de toute facon pas grand-chose a eclairer — et l'orbite de
 * Suomi NPP ne donne pas de nuit exploitable aux hautes latitudes en ete.
 */
const TILE_Y_MIN = 1
const TILE_Y_MAX = 28

const mod = (a: number, n: number) => ((a % n) + n) % n

/**
 * Decompression du rapport de brillance encode dans la tuile.
 *
 * L'atlas stocke un entier compresse logarithmiquement ; cette fonction rend
 * le rapport entre la lumiere artificielle et la luminosite naturelle du ciel
 * (0 = ciel naturel pur). Formule de l'atlas, reprise telle quelle.
 */
const compressedToBrightnessRatio = (x: number) => (5.0 / 195.0) * (Math.exp(0.0195 * x) - 1.0)

/** Decompresse un flux gzip avec l'API native du navigateur. */
async function gunzip(raw: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

export interface SkyBrightnessMeasurement {
  /** Brillance du fond de ciel au zenith, en magnitudes par seconde d'arc carree. */
  skyBrightness: number
  /** Rapport lumiere artificielle / ciel naturel. 0 = aucune pollution mesuree. */
  brightnessRatio: number
}

/**
 * Brillance du fond de ciel au lieu donne, ou `null` hors couverture.
 *
 * Le decodage suit le schema de compression de l'atlas : le coin inferieur
 * gauche porte une valeur absolue sur deux octets, et tout le reste n'est
 * qu'une suite d'ecarts d'un octet par rapport au point precedent. Atteindre un
 * point demande donc de cumuler les ecarts le long de sa colonne puis de sa
 * ligne, pas de lire un offset — c'est ce qui permet a une grille de 360 000
 * points de tenir en une centaine de kilo-octets.
 */
export async function fetchSkyBrightness(
  latitude: number,
  longitude: number,
): Promise<Sourced<SkyBrightnessMeasurement> | null> {
  const lonFromDateLine = mod(longitude + 180, 360)
  const latFromStart = latitude + 65
  const tileX = Math.floor(lonFromDateLine / TILE_DEGREES) + 1
  const tileY = Math.floor(latFromStart / TILE_DEGREES) + 1
  if (tileY < TILE_Y_MIN || tileY > TILE_Y_MAX) return null

  const url = `https://djlorenz.github.io/astronomy/binary_tiles/${ATLAS_YEAR}/binary_tile_${tileX}_${tileY}.dat.gz`

  // Indices du point de grille le plus proche, dans la tuile.
  const ix = Math.round(TILE_POINTS / TILE_DEGREES * (lonFromDateLine - TILE_DEGREES * (tileX - 1)) + 0.5)
  const iy = Math.round(TILE_POINTS / TILE_DEGREES * (latFromStart - TILE_DEGREES * (tileY - 1)) + 0.5)

  // La decompression gzip precede la mise en cache par `fetchBinary`, qui
  // conserve la charge telle qu'elle arrive : on garde donc les octets
  // compresses en cache, et on ne les detend qu'a la lecture.
  const raw = await fetchBinary<ArrayBuffer>(
    url,
    { key: `light-pollution:${ATLAS_YEAR}:${tileX}:${tileY}`, ttlMs: CACHE_TTL_MS, timeoutMs: 8000 },
    (buffer) => buffer,
  )
  if (!raw) return null

  let bytes: Int8Array
  try {
    bytes = new Int8Array(await gunzip(raw.value))
  } catch {
    return null
  }
  if (bytes.length < TILE_POINTS * TILE_POINTS) return null

  // Coin inferieur gauche : seule valeur absolue de la tuile, sur deux octets.
  let value = 128 * bytes[0] + bytes[1]
  // Puis les ecarts, colonne d'abord — le premier point vaut deja deux octets,
  // d'ou le decalage de 1 sur chaque indice.
  for (let i = 1; i < iy; i++) value += bytes[TILE_POINTS * i + 1]
  for (let i = 1; i < ix; i++) value += bytes[TILE_POINTS * (iy - 1) + 1 + i]

  const brightnessRatio = compressedToBrightnessRatio(value)
  if (!Number.isFinite(brightnessRatio)) return null

  // Relation de l'atlas : un ciel naturel vaut 22 mag/arcsec², et chaque
  // facteur cent de lumiere ajoutee en retranche cinq.
  const skyBrightness = 22.0 - 5.0 * Math.log(1.0 + brightnessRatio) / Math.log(100)

  return { value: { skyBrightness, brightnessRatio }, status: raw.status }
}
