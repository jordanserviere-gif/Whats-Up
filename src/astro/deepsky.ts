/**
 * Catalogue du ciel profond (OpenNGC), embarque au build.
 *
 * Meme parti pris que pour les etoiles : les positions sont figees une fois
 * dans le repere equatorial, la rotation diurne etant portee par la matrice du
 * groupe. Les objets etendus sont dessines a leur taille apparente reelle —
 * M31 fait pres de trois degres, six fois la Lune, et doit se lire comme tel.
 */
import deepSkyData from '@/data/deepsky.json'
import { precessFromJ2000 } from './coords'
import { surfaceBrightness } from './photometry'

interface RawDeepSky {
  epoch: string
  magLimit: number
  count: number
  typeNames: string[]
  typeLabels: string[]
  id: string[]
  name: string[]
  type: number[]
  ra: number[]
  dec: number[]
  mag: number[]
  /** Grand axe en minutes d'arc ; 0 = dimension inconnue. */
  major: number[]
  minor: number[]
  /** Angle de position du grand axe, en degres depuis le nord. */
  angle: number[]
  messier: number[]
}

const RAW = deepSkyData as RawDeepSky

export const DEEP_SKY_COUNT = RAW.count
export const DEEP_SKY_MAG_LIMIT = RAW.magLimit
export const DEEP_SKY_TYPES = RAW.typeNames
export const DEEP_SKY_TYPE_LABELS = RAW.typeLabels

export interface DeepSkyObject {
  index: number
  id: string
  name: string
  type: string
  typeLabel: string
  /** Ascension droite J2000, en degres. */
  ra: number
  dec: number
  magnitude: number
  majorArcmin: number
  minorArcmin: number
  positionAngle: number
  messier: number
  /** Brillance de surface en mag/arcsec², nulle si les dimensions manquent. */
  surfaceBrightness: number | null
}

function objectAt(i: number): DeepSkyObject {
  return {
    index: i,
    id: RAW.id[i],
    name: RAW.name[i],
    type: RAW.typeNames[RAW.type[i]],
    typeLabel: RAW.typeLabels[RAW.type[i]],
    ra: RAW.ra[i],
    dec: RAW.dec[i],
    magnitude: RAW.mag[i],
    majorArcmin: RAW.major[i],
    minorArcmin: RAW.minor[i],
    positionAngle: RAW.angle[i],
    messier: RAW.messier[i],
    surfaceBrightness: surfaceBrightness(RAW.mag[i], RAW.major[i], RAW.minor[i]),
  }
}

/** Objets Messier, tries par numero — la liste la plus utile a l'observateur. */
export const MESSIER_OBJECTS: DeepSkyObject[] = RAW.messier
  .map((m, i) => (m > 0 ? objectAt(i) : null))
  .filter((o): o is DeepSkyObject => o !== null)
  .sort((a, b) => a.messier - b.messier)

/** Recherche par identifiant de catalogue (« NGC0224 ») ou numero Messier (« M31 »). */
export function findDeepSkyObject(query: string): DeepSkyObject | null {
  const q = query.trim().toUpperCase().replace(/\s+/g, '')
  const messier = /^M(\d{1,3})$/.exec(q)
  if (messier) {
    const n = Number(messier[1])
    return MESSIER_OBJECTS.find((o) => o.messier === n) ?? null
  }
  const i = RAW.id.findIndex((id) => id.toUpperCase() === q)
  return i < 0 ? null : objectAt(i)
}

export interface DeepSkyGeometry {
  /** Positions unitaires dans le repere equatorial de la date. */
  positions: Float32Array
  /** Demi-grand axe et demi-petit axe, en radians. */
  semiMajor: Float32Array
  semiMinor: Float32Array
  /** Angle de position, en radians. */
  angle: Float32Array
  magnitudes: Float32Array
  /** Brillance de surface ; les objets ponctuels recoivent la valeur 0. */
  surfaceBrightness: Float32Array
  /** 1 si l'objet a des dimensions connues, 0 sinon. */
  extended: Float32Array
  types: Uint8Array
  count: number
  /** Indices du catalogue, dans l'ordre du tampon. */
  indices: Int32Array
}

const DEG = Math.PI / 180
const ARCMIN = DEG / 60

let cachedYear: number | null = null
let cachedLimit: number | null = null
let cachedGeometry: DeepSkyGeometry | null = null

/**
 * Prepare les tableaux de rendu, precesses vers l'epoque demandee.
 *
 * Mis en cache par annee : la precession ne bouge pas a l'echelle d'une session.
 */
export function buildDeepSkyGeometry(date: Date, magnitudeLimit = DEEP_SKY_MAG_LIMIT): DeepSkyGeometry {
  const year = date.getUTCFullYear()
  if (cachedGeometry && cachedYear === year && cachedLimit === magnitudeLimit) return cachedGeometry

  const kept: number[] = []
  for (let i = 0; i < RAW.count; i++) if (RAW.mag[i] <= magnitudeLimit) kept.push(i)

  const n = kept.length
  const positions = new Float32Array(n * 3)
  const semiMajor = new Float32Array(n)
  const semiMinor = new Float32Array(n)
  const angle = new Float32Array(n)
  const magnitudes = new Float32Array(n)
  const sb = new Float32Array(n)
  const extended = new Float32Array(n)
  const types = new Uint8Array(n)
  const indices = new Int32Array(n)

  for (let k = 0; k < n; k++) {
    const i = kept[k]
    const eq = precessFromJ2000({ ra: RAW.ra[i], dec: RAW.dec[i] }, date)
    const ra = eq.ra * DEG
    const dec = eq.dec * DEG
    const cd = Math.cos(dec)
    positions[k * 3] = cd * Math.cos(ra)
    positions[k * 3 + 1] = cd * Math.sin(ra)
    positions[k * 3 + 2] = Math.sin(dec)

    const major = RAW.major[i]
    const minor = RAW.minor[i] > 0 ? RAW.minor[i] : major
    // Demi-axes : le catalogue donne les axes complets.
    semiMajor[k] = (major * ARCMIN) / 2
    semiMinor[k] = (minor * ARCMIN) / 2
    angle[k] = RAW.angle[i] * DEG
    magnitudes[k] = RAW.mag[i]

    const brightness = surfaceBrightness(RAW.mag[i], major, minor)
    sb[k] = brightness ?? 0
    extended[k] = brightness === null ? 0 : 1
    types[k] = RAW.type[i]
    indices[k] = i
  }

  const geometry: DeepSkyGeometry = {
    positions,
    semiMajor,
    semiMinor,
    angle,
    magnitudes,
    surfaceBrightness: sb,
    extended,
    types,
    count: n,
    indices,
  }
  cachedYear = year
  cachedLimit = magnitudeLimit
  cachedGeometry = geometry
  return geometry
}

/** Retrouve l'objet du catalogue derriere un indice du tampon de rendu. */
export const deepSkyObjectAt = (catalogIndex: number): DeepSkyObject => objectAt(catalogIndex)
