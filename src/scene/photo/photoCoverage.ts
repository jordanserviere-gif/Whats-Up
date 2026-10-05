/**
 * Mode photo — ou chaque service d'altitude fine repond.
 *
 * ⚠️ La France etait un rectangle de 41,2 a 51,3° de latitude et de −5,6 a
 * 9,8° de longitude : il englobait le nord de l'Espagne, la Suisse, le Benelux,
 * l'ouest de l'Allemagne, le Piemont et le sud de l'Angleterre, ou le mode photo
 * demandait des centaines de tuiles LiDAR que le service rendait vides.
 *
 * ## Les frontieres
 *
 * Celles d'OpenStreetMap — au metre sur terre, la limite des eaux territoriales
 * en mer —, simplifiees a une dizaine de metres : voir
 * `scripts/build-borders.mjs`. Donnees © contributeurs OpenStreetMap, ODbL.
 *
 * ## Ne pas tester chaque pixel
 *
 * Le terrain est decoupe en cases d'un centieme de degre — un kilometre. Une
 * case qu'aucun trait de frontiere ne traverse est **evidente** : un seul test,
 * en son centre, vaut pour tous ses points. Seules les cases que la frontiere
 * traverse sont **mixtes** : elles portent la liste des territoires qui s'y
 * touchent, et l'on y demande les tuiles de chacun.
 *
 * Il n'est pas besoin d'y trancher point par point : chaque service s'arrete de
 * lui-meme a sa frontiere — l'IGN France rend « sans donnee » en Espagne, l'IGN
 * Espagne rend zero en France —, et la lecture essaie les services l'un apres
 * l'autre. C'est la donnee qui trace la frontiere, au point pres.
 */
import BORDERS from './borders.json'

export type TerritoryId = 'france' | 'spain' | 'usa'
export const TERRITORY_IDS: readonly TerritoryId[] = ['france', 'spain', 'usa']

/** Taille d'une case, degres : un kilometre la ou une frontiere passe, onze ailleurs. */
const CELL_DEG = 0.01
const COARSE_DEG = 0.1
/** Hauteur d'une tranche de l'index des segments, degres. */
const SLAB_DEG = 0.05

interface Index {
  /** Segments a plat : x0, y0, x1, y1, en degres. */
  segs: Float64Array
  /** Tranche de latitude → segments qui la traversent. */
  slabs: Map<number, number[]>
  box: { lonMin: number; lonMax: number; latMin: number; latMax: number }
}

function buildIndex(rings: number[][], quantum: number): Index {
  const flat: number[] = []
  const box = { lonMin: Infinity, lonMax: -Infinity, latMin: Infinity, latMax: -Infinity }
  for (const enc of rings) {
    const pts: number[] = []
    let x = 0
    let y = 0
    for (let i = 0; i < enc.length; i += 2) {
      x += enc[i]
      y += enc[i + 1]
      pts.push(x / quantum, y / quantum)
    }
    const n = pts.length / 2
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      flat.push(pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1])
      box.lonMin = Math.min(box.lonMin, pts[2 * i])
      box.lonMax = Math.max(box.lonMax, pts[2 * i])
      box.latMin = Math.min(box.latMin, pts[2 * i + 1])
      box.latMax = Math.max(box.latMax, pts[2 * i + 1])
    }
  }
  const segs = new Float64Array(flat)
  const slabs = new Map<number, number[]>()
  for (let s = 0; s < segs.length; s += 4) {
    const a = Math.floor(Math.min(segs[s + 1], segs[s + 3]) / SLAB_DEG)
    const b = Math.floor(Math.max(segs[s + 1], segs[s + 3]) / SLAB_DEG)
    for (let k = a; k <= b; k++) {
      let list = slabs.get(k)
      if (!list) slabs.set(k, (list = []))
      list.push(s)
    }
  }
  return { segs, slabs, box }
}

let indexes: Record<TerritoryId, Index> | null = null
function index(): Record<TerritoryId, Index> {
  if (!indexes) {
    const data = BORDERS as unknown as Record<TerritoryId, number[][]> & { quantum: number }
    indexes = {
      france: buildIndex(data.france, data.quantum),
      spain: buildIndex(data.spain, data.quantum),
      usa: buildIndex(data.usa, data.quantum),
    }
  }
  return indexes
}

/** Le point est-il dans le territoire ? Lancer de rayon vers l'est, sur la seule tranche du point. */
export function inTerritory(id: TerritoryId, lat: number, lon: number): boolean {
  const ix = index()[id]
  const b = ix.box
  if (lat < b.latMin || lat > b.latMax || lon < b.lonMin || lon > b.lonMax) return false
  const list = ix.slabs.get(Math.floor(lat / SLAB_DEG))
  if (!list) return false
  const s = ix.segs
  let inside = false
  for (const k of list) {
    const yi = s[k + 1]
    const yj = s[k + 3]
    if (yi > lat !== yj > lat) {
      const xi = s[k]
      const xj = s[k + 2]
      if (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/** Le territoire d'un point, exact. */
export function territoryAt(lat: number, lon: number): TerritoryId | null {
  for (const id of TERRITORY_IDS) if (inTerritory(id, lat, lon)) return id
  return null
}

/** Une case : son territoire, et si une frontiere la traverse, tout ce qui s'y touche. */
export interface Cell {
  /** Territoire du centre de la case. */
  label: TerritoryId | null
  /** Les territoires presents dans la case — un seul si elle est evidente ; `null` y figure pour « aucun ». */
  present: ReadonlyArray<TerritoryId | null>
}

const coarseCells = new Map<number, Cell>()
const fineCells = new Map<number, Cell>()

/**
 * La case d'un point, calculee une fois puis retenue.
 *
 * Deux etages : une case de onze kilometres qu'aucune frontiere ne traverse
 * vaut pour tous ses points — c'est presque tout le cadre d'une photo ; les
 * autres se redecoupent en cases d'un kilometre. Une photo qui porte a cinq
 * cents kilometres touche ainsi quelques milliers de cases, et non un million.
 */
export function cellAt(lat: number, lon: number): Cell {
  const ci = Math.floor(lat / COARSE_DEG)
  const cj = Math.floor(lon / COARSE_DEG)
  const ckey = (ci + 900) * 4000 + (cj + 2000)
  let coarse = coarseCells.get(ckey)
  if (!coarse) {
    coarse = classify(ci * COARSE_DEG, cj * COARSE_DEG, COARSE_DEG)
    coarseCells.set(ckey, coarse)
  }
  if (coarse.present.length === 1) return coarse
  const i = Math.floor(lat / CELL_DEG)
  const j = Math.floor(lon / CELL_DEG)
  const key = (i + 9000) * 40_000 + (j + 20_000)
  let cell = fineCells.get(key)
  if (!cell) {
    cell = classify(i * CELL_DEG, j * CELL_DEG, CELL_DEG)
    fineCells.set(key, cell)
  }
  return cell
}

function classify(latMin: number, lonMin: number, size: number): Cell {
  const latMax = latMin + size
  const lonMax = lonMin + size
  const label = territoryAt(latMin + size / 2, lonMin + size / 2)
  // Les traits de frontiere qui touchent la case, territoire par territoire.
  const present = new Set<TerritoryId | null>([label])
  const all = index()
  for (const id of TERRITORY_IDS) {
    const ix = all[id]
    const b = ix.box
    if (latMax < b.latMin || latMin > b.latMax || lonMax < b.lonMin || lonMin > b.lonMax) continue
    let touched = false
    for (let slab = Math.floor(latMin / SLAB_DEG); slab <= Math.floor((latMax - 1e-9) / SLAB_DEG) && !touched; slab++) {
      for (const k of ix.slabs.get(slab) ?? []) {
        if (segmentTouchesBox(ix.segs, k, lonMin, latMin, lonMax, latMax)) {
          touched = true
          break
        }
      }
    }
    if (touched) {
      // Un trait de ce territoire traverse la case : lui, et ce qui est de
      // l'autre cote — un autre territoire, ou aucun.
      present.add(id)
      present.add(null)
    }
  }
  // Un trait commun a deux territoires couverts ne laisse pas de vide entre eux :
  // « aucun » n'y figure que si l'un des coins tombe hors de tout.
  if (present.size > 1 && present.has(null) && label !== null) {
    const corners = [territoryAt(latMin, lonMin), territoryAt(latMin, lonMax), territoryAt(latMax, lonMin), territoryAt(latMax, lonMax)]
    if (!corners.includes(null)) present.delete(null)
    for (const c of corners) if (c) present.add(c)
  }
  return { label, present: [...present] }
}

/** Le segment `k` touche-t-il la boite ? Liang-Barsky. */
function segmentTouchesBox(s: Float64Array, k: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const ax = s[k]
  const ay = s[k + 1]
  const dx = s[k + 2] - ax
  const dy = s[k + 3] - ay
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [
    [-dx, ax - x0],
    [dx, x1 - ax],
    [-dy, ay - y0],
    [dy, y1 - ay],
  ]) {
    if (p === 0) {
      if (q < 0) return false
    } else {
      const r = q / p
      if (p < 0) {
        if (r > t1) return false
        if (r > t0) t0 = r
      } else {
        if (r < t0) return false
        if (r < t1) t1 = r
      }
    }
  }
  return true
}
