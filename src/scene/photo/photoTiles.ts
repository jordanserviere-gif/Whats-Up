/**
 * Mode photo — les tuiles d'altitude a la demande, et la projection locale.
 *
 * ## Une grille de tuiles geographique
 *
 * Les tuiles suivent la grille `WGS84G` de la Geoplateforme : au niveau `z`, le
 * monde tient en `2^(z+1)` tuiles en longitude et `2^z` en latitude, chacune de
 * 256 cases. Au niveau 17, une case vaut 0,60 m en latitude et 0,43 m en
 * longitude a 44° — le pas du LiDAR HD, 0,50 m, tombe entre les deux. Une grille **fixe**, et non des emprises a la carte : deux photos au meme
 * endroit demandent les memes tuiles, et la seconde les trouve en cache.
 *
 * Chaque tuile porte 257 × 257 points, bords compris : deux tuiles voisines
 * partagent leur bord, et une lecture bilineaire n'a jamais besoin de sa
 * voisine.
 *
 * ## La quantification
 *
 * Une altitude par point, sur seize bits, au-dessus du point le plus bas de la
 * tuile. Le pas s'adapte au denivele de la tuile : un deux-cent-cinquante-
 * sixieme de metre sur une tuile LiDAR de cent cinquante metres, ou l'arrondi
 * ferait sinon onduler les pentes ; plus grossier sur une tuile de quarante
 * kilometres qui porte deux mille metres de denivele. La memoire est moitie de
 * celle des flottants, et elle compte : les tuiles d'une photo sont copiees vers
 * chaque worker d'ombrage.
 */
import { enuToGeodetic } from '../terrain/geodesy'

export const TILE_CELLS = 256
export const TILE_POINTS = TILE_CELLS + 1
/** Pas de quantification le plus fin, metres. */
const FINEST_QUANTUM_M = 1 / 256
/** Valeur reservee : point inconnu. */
const UNKNOWN = 0xffff

/** Etendue d'une tuile du niveau `z`, degres — la meme en longitude et en latitude. */
export const tileSpanDeg = (z: number): number => 360 / 2 ** (z + 1)

/** Taille d'une case au niveau `z`, metres, dans la direction la plus grossiere (le nord). */
export const tileCellM = (z: number): number => (tileSpanDeg(z) / TILE_CELLS) * 111_320

/** Le niveau le plus grossier dont la case tient sous `targetM`, borne a `maxZ`. */
export function tileLevelFor(targetM: number, maxZ: number): number {
  for (let z = 0; z <= maxZ; z++) if (tileCellM(z) <= targetM) return z
  return maxZ
}

/** Cle numerique d'une tuile : exacte jusqu'au niveau 17 sous 2^53. */
export const tileKey = (z: number, x: number, y: number): number => z * 2 ** 36 + x * 2 ** 18 + y

export function tileOf(lat: number, lon: number, z: number): { x: number; y: number } {
  const span = tileSpanDeg(z)
  return { x: Math.floor((lon + 180) / span), y: Math.floor((90 - lat) / span) }
}

/** Emprise d'une tuile, degres. */
export function tileBounds(z: number, x: number, y: number) {
  const span = tileSpanDeg(z)
  const lonMin = x * span - 180
  const latMax = 90 - y * span
  return { lonMin, lonMax: lonMin + span, latMin: latMax - span, latMax }
}

/** Une tuile d'altitudes, quantifiee. */
export interface HeightTile {
  z: number
  x: number
  y: number
  /** Altitude du code zero, metres. */
  base: number
  /** Pas d'un code, metres. */
  quantum: number
  /** `TILE_POINTS²` codes, rangee 0 au nord. */
  codes: Uint16Array
}

/** Quantifie 257 × 257 altitudes (NaN pour inconnu). `null` si toutes sont inconnues. */
export function quantizeTile(z: number, x: number, y: number, heights: Float32Array): HeightTile | null {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] < min) min = heights[i]
    if (heights[i] > max) max = heights[i]
  }
  if (!Number.isFinite(min)) return null
  const quantum = Math.max(FINEST_QUANTUM_M, (max - min) / (UNKNOWN - 2))
  const codes = new Uint16Array(heights.length)
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i]
    codes[i] = Number.isNaN(h) ? UNKNOWN : Math.min(UNKNOWN - 1, Math.round((h - min) / quantum))
  }
  return { z, x, y, base: min, quantum, codes }
}

/**
 * Magasin de tuiles et lecture multi-resolution.
 *
 * La lecture prend la tuile la plus fine qui couvre le point et y connait sa
 * valeur ; sinon la suivante ; sinon le repli. Les niveaux presents sont tenus a
 * part, du plus fin au plus grossier : une lecture ne teste que ceux-la.
 */
export class TileStore {
  private readonly tiles = new Map<number, HeightTile>()
  private levels: number[] = []

  add(tile: HeightTile): void {
    this.tiles.set(tileKey(tile.z, tile.x, tile.y), tile)
    if (!this.levels.includes(tile.z)) this.levels = [...this.levels, tile.z].sort((a, b) => b - a)
  }

  get size(): number {
    return this.tiles.size
  }

  all(): HeightTile[] {
    return [...this.tiles.values()]
  }

  /** Altitude, metres, ou NaN si aucune tuile ne connait le point. */
  sample(lat: number, lon: number): number {
    for (const z of this.levels) {
      const span = tileSpanDeg(z)
      const gx = (lon + 180) / span
      const gy = (90 - lat) / span
      const x = Math.floor(gx)
      const y = Math.floor(gy)
      const tile = this.tiles.get(tileKey(z, x, y))
      if (!tile) continue
      const fx = (gx - x) * TILE_CELLS
      const fy = (gy - y) * TILE_CELLS
      const ix = Math.min(TILE_CELLS - 1, Math.floor(fx))
      const iy = Math.min(TILE_CELLS - 1, Math.floor(fy))
      const tx = fx - ix
      const ty = fy - iy
      const c = tile.codes
      const k = iy * TILE_POINTS + ix
      const a = c[k]
      const b = c[k + 1]
      const d = c[k + TILE_POINTS]
      const e = c[k + TILE_POINTS + 1]
      if (a === UNKNOWN || b === UNKNOWN || d === UNKNOWN || e === UNKNOWN) continue
      return tile.base + ((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty) * tile.quantum
    }
    return Number.NaN
  }
}

/**
 * Projection du plan local vers les coordonnees geographiques.
 *
 * Le probleme direct geodesique est exact mais cher, et la marche des rayons en
 * demande des centaines de millions. Comme la pyramide, on l'evalue exactement
 * sur un treillis — ici 257 × 257 sur toute la portee — et l'on interpole
 * entre ses noeuds. L'erreur se borne par `h²|f''|/8` : a cinq cent soixante
 * kilometres, un noeud tous les 4,4 km, elle reste sous le metre.
 */
export class LocalProjector {
  private readonly n = 257
  private readonly lat: Float64Array
  private readonly lon: Float64Array
  private readonly half: number
  private readonly step: number

  constructor(lat0: number, lon0: number, halfSpanM: number) {
    this.half = halfSpanM
    this.step = (2 * halfSpanM) / (this.n - 1)
    this.lat = new Float64Array(this.n * this.n)
    this.lon = new Float64Array(this.n * this.n)
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const g = enuToGeodetic(lat0, lon0, i * this.step - halfSpanM, j * this.step - halfSpanM)
        this.lat[j * this.n + i] = g.latitudeDeg
        this.lon[j * this.n + i] = g.longitudeDeg
      }
    }
  }

  /** Coordonnees geographiques d'un point du plan local ; ecrites dans `out`. */
  toLatLon(eastM: number, northM: number, out: { lat: number; lon: number }): void {
    const fx = Math.max(0, Math.min(this.n - 1.000001, (eastM + this.half) / this.step))
    const fy = Math.max(0, Math.min(this.n - 1.000001, (northM + this.half) / this.step))
    const i = Math.floor(fx)
    const j = Math.floor(fy)
    const tx = fx - i
    const ty = fy - j
    const k = j * this.n + i
    const n = this.n
    out.lat = (this.lat[k] * (1 - tx) + this.lat[k + 1] * tx) * (1 - ty) + (this.lat[k + n] * (1 - tx) + this.lat[k + n + 1] * tx) * ty
    out.lon = (this.lon[k] * (1 - tx) + this.lon[k + 1] * tx) * (1 - ty) + (this.lon[k + n] * (1 - tx) + this.lon[k + n + 1] * tx) * ty
  }

  /** Copie transferable, pour les workers d'ombrage. */
  export(): { lat: Float64Array; lon: Float64Array; half: number } {
    return { lat: this.lat, lon: this.lon, half: this.half }
  }

  static from(data: { lat: Float64Array; lon: Float64Array; half: number }): LocalProjector {
    const p = Object.create(LocalProjector.prototype) as LocalProjector
    Object.assign(p, { n: 257, lat: data.lat, lon: data.lon, half: data.half, step: (2 * data.half) / 256 })
    return p
  }
}
