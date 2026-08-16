/**
 * Catalogue stellaire embarque (HYG v4.1, mag ≤ 6,0) et figures de constellations.
 * Les donnees sont en J2000 : la precession vers la date est appliquee une fois
 * par changement d'epoque significatif, pas a chaque image.
 */
import starsData from '@/data/stars.json'
import constellationsData from '@/data/constellations.json'
import { precessFromJ2000 } from './coords'

interface RawStars {
  magLimit: number
  epoch: string
  count: number
  ra: number[]
  dec: number[]
  mag: number[]
  ci: number[]
  named: Array<{ i: number; n: string; d: string }>
}

interface RawConstellations {
  epoch: string
  constellations: Array<{
    id: string
    name: string
    ra: number
    dec: number
    segs: Array<Array<[number, number]>>
  }>
}

const RAW = starsData as RawStars
const RAW_CONST = constellationsData as RawConstellations

export const STAR_COUNT = RAW.count
export const STAR_MAG_LIMIT = RAW.magLimit

export interface NamedStar {
  index: number
  name: string
  designation: string
  ra: number
  dec: number
  magnitude: number
}

/** Etoiles portant un nom propre, triees par eclat. */
export const NAMED_STARS: NamedStar[] = RAW.named
  .map((s) => ({
    index: s.i,
    name: s.n,
    designation: s.d,
    ra: RAW.ra[s.i],
    dec: RAW.dec[s.i],
    magnitude: RAW.mag[s.i],
  }))
  .sort((a, b) => a.magnitude - b.magnitude)

export interface ConstellationFigure {
  id: string
  name: string
  labelRa: number
  labelDec: number
  segments: Array<Array<[number, number]>>
}

export const CONSTELLATIONS: ConstellationFigure[] = RAW_CONST.constellations.map((c) => ({
  id: c.id,
  name: c.name,
  labelRa: c.ra,
  labelDec: c.dec,
  segments: c.segs,
}))

/**
 * Indice de couleur B-V vers couleur RVB perceptuelle.
 * Approximation de la temperature de couleur stellaire (Ballesteros).
 */
export function bvToRgb(bv: number): [number, number, number] {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62))
  // Approximation du corps noir de Tanner Helland, normalisee.
  const k = t / 100
  let r: number
  let g: number
  let b: number

  if (k <= 66) {
    r = 255
    g = 99.4708025861 * Math.log(k) - 161.1195681661
  } else {
    r = 329.698727446 * Math.pow(k - 60, -0.1332047592)
    g = 288.1221695283 * Math.pow(k - 60, -0.0755148492)
  }
  if (k >= 66) b = 255
  else if (k <= 19) b = 0
  else b = 138.5177312231 * Math.log(k - 10) - 305.0447927307

  const clamp255 = (v: number) => Math.min(255, Math.max(0, v)) / 255
  return [clamp255(r), clamp255(g), clamp255(b)]
}

export interface StarGeometry {
  /** Positions sur la sphere unite dans le repere equatorial de la date. */
  positions: Float32Array
  colors: Float32Array
  /** Taille de rendu deja derivee de la magnitude. */
  sizes: Float32Array
  magnitudes: Float32Array
  ra: Float32Array
  dec: Float32Array
  count: number
}

/**
 * Prepare les tableaux de rendu du champ d'etoiles pour une epoque donnee.
 * Le resultat est mis en cache : l'operation ne se refait que si l'epoque change
 * de plus d'un an, la precession etant imperceptible en deca.
 */
let cachedYear: number | null = null
let cachedGeometry: StarGeometry | null = null

export function buildStarGeometry(date: Date, magnitudeLimit = 6.0): StarGeometry {
  const year = date.getUTCFullYear()
  if (cachedGeometry && cachedYear === year && magnitudeLimit >= STAR_MAG_LIMIT) return cachedGeometry

  const kept: number[] = []
  for (let i = 0; i < RAW.count; i++) if (RAW.mag[i] <= magnitudeLimit) kept.push(i)

  const n = kept.length
  const positions = new Float32Array(n * 3)
  const colors = new Float32Array(n * 3)
  const sizes = new Float32Array(n)
  const magnitudes = new Float32Array(n)
  const raOut = new Float32Array(n)
  const decOut = new Float32Array(n)

  const DEG = Math.PI / 180
  for (let k = 0; k < n; k++) {
    const i = kept[k]
    const eq = precessFromJ2000({ ra: RAW.ra[i], dec: RAW.dec[i] }, date)
    const ra = eq.ra * DEG
    const dec = eq.dec * DEG
    const cd = Math.cos(dec)
    // Repere equatorial : x vers l'equinoxe, z vers le pole nord celeste.
    positions[k * 3] = cd * Math.cos(ra)
    positions[k * 3 + 1] = cd * Math.sin(ra)
    positions[k * 3 + 2] = Math.sin(dec)

    const [r, g, b] = bvToRgb(RAW.ci[i])
    colors[k * 3] = r
    colors[k * 3 + 1] = g
    colors[k * 3 + 2] = b

    // Le flux varie en 10^(-0,4·m) ; on prend la racine pour obtenir un rayon.
    const m = RAW.mag[i]
    sizes[k] = Math.max(0.9, 7.5 * Math.pow(2.512, -m / 3.2))
    magnitudes[k] = m
    raOut[k] = eq.ra
    decOut[k] = eq.dec
  }

  const geometry: StarGeometry = { positions, colors, sizes, magnitudes, ra: raOut, dec: decOut, count: n }
  if (magnitudeLimit >= STAR_MAG_LIMIT) {
    cachedYear = year
    cachedGeometry = geometry
  }
  return geometry
}

/** Segments des figures de constellations, precesses et projetes sur la sphere unite. */
export function buildConstellationGeometry(date: Date): { positions: Float32Array; count: number } {
  const DEG = Math.PI / 180
  const points: number[] = []

  for (const c of CONSTELLATIONS) {
    for (const seg of c.segments) {
      for (let i = 0; i + 1 < seg.length; i++) {
        for (const [ra0, dec0] of [seg[i], seg[i + 1]]) {
          const eq = precessFromJ2000({ ra: ra0, dec: dec0 }, date)
          const ra = eq.ra * DEG
          const dec = eq.dec * DEG
          const cd = Math.cos(dec)
          points.push(cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec))
        }
      }
    }
  }

  return { positions: new Float32Array(points), count: points.length / 3 }
}

/** Etiquettes des constellations, precessees. */
export function constellationLabels(date: Date) {
  return CONSTELLATIONS.map((c) => ({
    id: c.id,
    name: c.name,
    ...precessFromJ2000({ ra: c.labelRa, dec: c.labelDec }, date),
  }))
}
