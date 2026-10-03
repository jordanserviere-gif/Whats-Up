/**
 * Worker du mode photo — deux roles.
 *
 * **Preparer** (une instance) : la passe de visibilite grossiere, le choix des
 * tuiles au pas du pixel, leur chargement, le rendu du relief au pixel, les
 * normales, et une carte d'ombre fine pour le voile atmospherique.
 *
 * **Ombrer** (plusieurs instances, une bande de lignes chacune) : un rayon vers
 * le Soleil par pixel, et la part de ciel que le relief laisse a chaque point.
 * C'est le poste le plus cher, et il se partage sans peine : chaque pixel est
 * independant.
 *
 * Le fil principal ne recoit que des tableaux prets pour le GPU, transferes
 * sans copie.
 */
/// <reference lib="webworker" />
import { CLIPMAP_SIZE, sampleClipmap, type ElevationClipmap } from '../terrain/elevationClipmap'
import {
  NEAR_FIELD_HALF_SPAN_M,
  NEAR_FIELD_SIZE,
  NEAR_FIELD_STEP_M,
  NEAR_FIELD_UNIT_M,
  nearFieldWeight,
} from '../terrain/nearField'
import { castSunShadow } from '../terrain/sunShadow'
import type { PhotoView, Sampler } from './photoPlan'
import {
  buildMaxGrid,
  coarsenFrame,
  marchColumns,
  photoFrame,
  pixelNormals,
  shadePixels,
  tileNeeds,
  toHalf,
  type PhotoFrame,
  type PhotoGBuffer,
} from './photoRaster'
import { fetchHeightTile, LIDAR_MAX_LEVEL, pointInFrance, TERRARIUM_MAX_LEVEL } from './photoSources'
import { LocalProjector, TileStore, tileCellM, tileKey, tileLevelFor, tileSpanDeg, type HeightTile } from './photoTiles'

/** Le relief courant, copie depuis le fil principal. */
export interface CurrentRelief {
  latitudeDeg: number
  longitudeDeg: number
  clipmap: Array<{ halfSpanM: number; stepM: number; heights: Int16Array; ready: boolean }>
  near: Int16Array | null
}

export interface PrepareJob extends CurrentRelief {
  view: PhotoView
  eyeM: number
  effectiveRadiusM: number
  reachM: number
  peakM: number
  sunAltitudeDeg: number
  sunAzimuthDeg: number
}

export interface ShadeJob extends CurrentRelief {
  frame: PhotoFrame
  range: Float32Array
  altitude: Float32Array
  coverage: Float32Array
  /** Normales des lignes `[rowStart, rowEnd[`, flottants interleaves. */
  normals: Float32Array
  rowStart: number
  rowEnd: number
  tiles: HeightTile[]
  projector: { lat: Float64Array; lon: Float64Array; half: number }
  sunAltitudeDeg: number
  sunAzimuthDeg: number
  effectiveRadiusM: number
  peakM: number
}

export type PhotoPhase = 'visibilite' | 'relief' | 'rendu' | 'ombres'

export interface PrepareResult {
  type: 'prepared'
  frame: PhotoFrame
  range: Float32Array
  altitude: Float32Array
  coverage: Float32Array
  normals: Float32Array
  tiles: HeightTile[]
  projector: { lat: Float64Array; lon: Float64Array; half: number }
  shadow: { size: number; halfSpanM: number; height: Float32Array }
  stats: { tiles: number; failed: number; levels: Record<number, number>; milliseconds: number }
}

export type PhotoWorkerMessage =
  | { type: 'progress'; phase: PhotoPhase; fraction: number; detail?: string }
  | PrepareResult
  | { type: 'shaded'; rowStart: number; rowEnd: number; g: Uint16Array }
  | { type: 'error'; message: string }

const post = (msg: PhotoWorkerMessage, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer)

let abort: AbortController | null = null

/** Le relief courant, recompose : pyramide puis champ proche. */
function currentSampler(job: CurrentRelief): Sampler {
  const clipmap: ElevationClipmap = {
    latitudeDeg: job.latitudeDeg,
    longitudeDeg: job.longitudeDeg,
    levels: job.clipmap.map((l, i) => ({
      halfSpanM: l.halfSpanM,
      zoom: i,
      heightM: l.heights,
      stepM: l.stepM,
      ready: l.ready && l.heights.length === CLIPMAP_SIZE * CLIPMAP_SIZE,
      maxHeightM: 0,
    })),
  }
  const near = job.near
  return (e, n) => {
    const coarse = sampleClipmap(clipmap, e, n)
    if (!near) return coarse
    const fx = (e + NEAR_FIELD_HALF_SPAN_M) / NEAR_FIELD_STEP_M
    const fz = (n + NEAR_FIELD_HALF_SPAN_M) / NEAR_FIELD_STEP_M
    if (fx < 0 || fz < 0 || fx > NEAR_FIELD_SIZE - 1 || fz > NEAR_FIELD_SIZE - 1) return coarse
    const ix = Math.min(NEAR_FIELD_SIZE - 2, Math.floor(fx))
    const iz = Math.min(NEAR_FIELD_SIZE - 2, Math.floor(fz))
    const tx = fx - ix
    const tz = fz - iz
    const k = iz * NEAR_FIELD_SIZE + ix
    const units =
      (near[k] * (1 - tx) + near[k + 1] * tx) * (1 - tz) + (near[k + NEAR_FIELD_SIZE] * (1 - tx) + near[k + NEAR_FIELD_SIZE + 1] * tx) * tz
    const w = nearFieldWeight(e, n)
    return units * NEAR_FIELD_UNIT_M * w + coarse * (1 - w)
  }
}

/** Le pas du relief courant a une distance donnee, metres. */
function currentStepAt(job: CurrentRelief, d: number): number {
  if (job.near && d < NEAR_FIELD_HALF_SPAN_M * 0.85) return NEAR_FIELD_STEP_M
  for (const l of job.clipmap) if (d < l.halfSpanM) return l.stepM
  return job.clipmap[job.clipmap.length - 1]?.stepM ?? 500
}

/** Les tuiles, puis le relief courant la ou elles se taisent. */
function compose(store: TileStore, projector: LocalProjector, fallback: Sampler): Sampler {
  const ll = { lat: 0, lon: 0 }
  return (e, n) => {
    projector.toLatLon(e, n, ll)
    const h = store.sample(ll.lat, ll.lon)
    return Number.isNaN(h) ? fallback(e, n) : h
  }
}

/** Plafond de tuiles par photo : 900 × 132 ko, 120 Mo. */
const MAX_TILES = 900
/** Requetes simultanees. */
const CONCURRENCY = 8
/** Carte d'ombre du voile : 4 096 cases sur 120 km, trente metres. */
const SHADOW_SIZE = 4096
const SHADOW_HALF_SPAN_M = 60_000

/**
 * Les tuiles a charger pour des besoins donnes, borne au plafond.
 *
 * Chaque besoin donne une case voulue ; on prend le niveau correspondant, borne
 * par la source — 50 cm en France, le plancher Terrarium ailleurs — et la
 * tuile qui le couvre, avec ses huit voisines : la passe fine ne retombera pas
 * exactement sur les points de la passe grossiere. Une tuile qui ne serait pas
 * plus fine que le relief courant n'est pas demandee. Au-dela du plafond, tout
 * le monde passe au niveau superieur.
 */
/** Part d'une tuile, pres de chaque bord, ou la voisine est demandee aussi. */
const EDGE = 0.06
function chooseTiles(
  needs: ReturnType<typeof tileNeeds>,
  projector: LocalProjector,
  job: CurrentRelief,
  have: Set<number>,
): Array<{ z: number; x: number; y: number }> {
  const ll = { lat: 0, lon: 0 }
  for (let coarsen = 1; coarsen <= 64; coarsen *= 2) {
    const wanted = new Map<number, { z: number; x: number; y: number }>()
    for (const need of needs) {
      projector.toLatLon(need.eastM, need.northM, ll)
      const maxZ = pointInFrance(ll.lat, ll.lon) ? LIDAR_MAX_LEVEL : TERRARIUM_MAX_LEVEL
      const z = tileLevelFor(need.cellM * coarsen, maxZ)
      const d = Math.hypot(need.eastM, need.northM)
      if (tileCellM(z) >= 0.8 * currentStepAt(job, d)) continue
      // La tuile du point, et ses voisines seulement s'il tombe pres d'un bord :
      // les huit voisines systematiques multipliaient la demande par neuf, et
      // le plafond faisait alors tomber toute la photo d'un niveau.
      const span = tileSpanDeg(z)
      const gx = (ll.lon + 180) / span
      const gy = (90 - ll.lat) / span
      const x = Math.floor(gx)
      const y = Math.floor(gy)
      const fx = gx - x
      const fy = gy - y
      const x0 = fx < EDGE ? -1 : 0
      const x1 = fx > 1 - EDGE ? 1 : 0
      const y0 = fy < EDGE ? -1 : 0
      const y1 = fy > 1 - EDGE ? 1 : 0
      for (let dy = y0; dy <= y1; dy++) {
        for (let dx = x0; dx <= x1; dx++) {
          const k = tileKey(z, x + dx, y + dy)
          if (!have.has(k)) wanted.set(k, { z, x: x + dx, y: y + dy })
        }
      }
      if (wanted.size > MAX_TILES * 1.5) break
    }
    if (wanted.size + have.size <= MAX_TILES) return [...wanted.values()]
  }
  return []
}

async function loadTiles(
  list: Array<{ z: number; x: number; y: number }>,
  store: TileStore,
  have: Set<number>,
  signal: AbortSignal,
  stats: PrepareResult['stats'],
  onProgress: (fraction: number) => void,
): Promise<void> {
  let done = 0
  // Deux tours : le service rate des tuiles sous la charge, et les rend sans
  // difficulte une fois les autres servies. Le second tour, moins presse, reprend
  // celles-la.
  let queue = list
  for (let round = 0; round < 2 && queue.length > 0; round++) {
    const missed: typeof list = []
    let next = 0
    const run = async () => {
      while (next < queue.length) {
        const t = queue[next++]
        have.add(tileKey(t.z, t.x, t.y))
        const tile = await fetchHeightTile(t.z, t.x, t.y, signal)
        if (tile) {
          store.add(tile)
          stats.levels[t.z] = (stats.levels[t.z] ?? 0) + 1
          onProgress(++done / list.length)
        } else if (round === 0) {
          missed.push(t)
        } else {
          stats.failed++
          onProgress(++done / list.length)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(round === 0 ? CONCURRENCY : 3, queue.length) }, run))
    queue = missed
  }
}

async function prepare(job: PrepareJob, signal: AbortSignal): Promise<void> {
  const started = performance.now()
  const stats: PrepareResult['stats'] = { tiles: 0, failed: 0, levels: {}, milliseconds: 0 }
  const fallback = currentSampler(job)
  const projector = new LocalProjector(job.latitudeDeg, job.longitudeDeg, job.reachM + 5000)
  const store = new TileStore()
  const have = new Set<number>()
  const sample = compose(store, projector, fallback)

  // --- Visibilite grossiere, sur le relief courant ---------------------------------
  post({ type: 'progress', phase: 'visibilite', fraction: 0 })
  // Majorants : le relief courant plus une marge qui couvre ce que la donnee fine
  // peut y ajouter — la moitie d'une case, et cent cinquante metres.
  const maxGrid = buildMaxGrid(fallback, job.reachM, (d) => 150 + 0.5 * currentStepAt(job, d))
  const frame = photoFrame(job.view)
  const coarse = coarsenFrame(frame, 4)
  const march = (s: Sampler, f: PhotoFrame) =>
    marchColumns(s, f, {
      observerM: job.eyeM,
      effectiveRadiusM: job.effectiveRadiusM,
      reachM: job.reachM,
      fineStepAt: (d) => d * f.step * 2.5,
      maxGrid,
    })
  const rough = march(fallback, coarse)
  if (signal.aborted) return

  // --- Les tuiles du visible --------------------------------------------------------
  const first = chooseTiles(tileNeeds(rough, frame.step), projector, job, have)
  post({ type: 'progress', phase: 'relief', fraction: 0, detail: `${first.length} tuiles` })
  await loadTiles(first, store, have, signal, stats, (f) =>
    post({ type: 'progress', phase: 'relief', fraction: f * 0.8, detail: `${first.length} tuiles` }),
  )
  if (signal.aborted) return

  // --- Le rendu au pixel, et un complement pour ce qui vient d'apparaitre -------------
  //
  // Le relief fin deplace un peu les cretes : des points que la passe grossiere
  // croyait caches deviennent visibles. Une passe intermediaire les trouve, et
  // l'on charge ce qui leur manque avant le rendu definitif.
  post({ type: 'progress', phase: 'rendu', fraction: 0 })
  const mid = march(sample, coarsenFrame(frame, 2))
  const extra = chooseTiles(tileNeeds(mid, frame.step), projector, job, have)
  if (extra.length > 0) {
    await loadTiles(extra, store, have, signal, stats, (f) =>
      post({ type: 'progress', phase: 'relief', fraction: 0.8 + f * 0.2, detail: `${first.length + extra.length} tuiles` }),
    )
  }
  if (signal.aborted) return
  post({ type: 'progress', phase: 'rendu', fraction: 0.3 })
  const gb: PhotoGBuffer = march(sample, frame)
  post({ type: 'progress', phase: 'rendu', fraction: 0.7 })
  const normals = pixelNormals(sample, gb)

  // --- Carte d'ombre du voile ---------------------------------------------------------
  const shadowHeight = new Float32Array(SHADOW_SIZE * SHADOW_SIZE)
  const step = (2 * SHADOW_HALF_SPAN_M) / (SHADOW_SIZE - 1)
  for (let j = 0; j < SHADOW_SIZE; j++) {
    for (let i = 0; i < SHADOW_SIZE; i++) shadowHeight[j * SHADOW_SIZE + i] = sample(i * step - SHADOW_HALF_SPAN_M, j * step - SHADOW_HALF_SPAN_M)
  }
  castSunShadow(shadowHeight, SHADOW_SIZE, SHADOW_HALF_SPAN_M, job.sunAltitudeDeg, job.sunAzimuthDeg, job.effectiveRadiusM)
  post({ type: 'progress', phase: 'rendu', fraction: 1 })

  const tiles = store.all()
  stats.tiles = tiles.length
  stats.milliseconds = Math.round(performance.now() - started)
  const proj = projector.export()
  // Les tuiles et la projection repartent par copie vers les workers d'ombrage :
  // on ne les transfere pas, le fil principal les redistribue.
  post(
    {
      type: 'prepared',
      frame,
      range: gb.range,
      altitude: gb.altitude,
      coverage: gb.coverage,
      normals,
      tiles,
      projector: proj,
      shadow: { size: SHADOW_SIZE, halfSpanM: SHADOW_HALF_SPAN_M, height: shadowHeight },
      stats,
    },
    [gb.coverage.buffer, shadowHeight.buffer],
  )
}

function shade(job: ShadeJob): void {
  const store = new TileStore()
  for (const t of job.tiles) store.add(t)
  const coarse = currentSampler(job)
  const sample = compose(store, LocalProjector.from(job.projector), coarse)
  const gb: PhotoGBuffer = { frame: job.frame, range: job.range, altitude: job.altitude, coverage: new Float32Array(0) }
  const rows = job.rowEnd - job.rowStart
  const sun = new Float32Array(rows * job.frame.cols)
  const skyF = new Float32Array(rows * job.frame.cols)
  // Par paquets de lignes, pour publier l'avancement.
  const chunk = Math.max(1, Math.ceil(rows / 20))
  for (let r = job.rowStart; r < job.rowEnd; r += chunk) {
    const end = Math.min(job.rowEnd, r + chunk)
    const part = shadePixels(sample, coarse, gb, job.normals, job.rowStart, job, r, end)
    sun.set(part.sun, (r - job.rowStart) * job.frame.cols)
    skyF.set(part.sky, (r - job.rowStart) * job.frame.cols)
    post({ type: 'progress', phase: 'ombres', fraction: (end - job.rowStart) / rows })
  }
  // La bande de texture du rendu, deja en demi-flottants et deja entrelacee :
  // deux texels par pixel — distance (km), altitude, part du Soleil,
  // couverture ; puis normale et part du ciel. Une seule texture, parce que le
  // nuanceur du relief n'a plus qu'une unite de texture libre sur seize. La
  // conversion se fait ici, en parallele, plutot que sur le fil principal.
  const cols = job.frame.cols
  const g = new Uint16Array(skyF.length * 8)
  for (let i = 0; i < skyF.length; i++) {
    const k = job.rowStart * cols + i
    const o = i * 8
    g[o] = toHalf(job.range[k] / 1000)
    g[o + 1] = toHalf(job.altitude[k])
    g[o + 2] = toHalf(sun[i])
    g[o + 3] = toHalf(job.coverage[k])
    g[o + 4] = toHalf(job.normals[i * 3])
    g[o + 5] = toHalf(job.normals[i * 3 + 1])
    g[o + 6] = toHalf(job.normals[i * 3 + 2])
    g[o + 7] = toHalf(skyF[i])
  }
  post({ type: 'shaded', rowStart: job.rowStart, rowEnd: job.rowEnd, g }, [g.buffer])
}

self.onmessage = (event: MessageEvent<{ type: 'prepare'; job: PrepareJob } | { type: 'shade'; job: ShadeJob } | { type: 'cancel' }>) => {
  const msg = event.data
  if (msg.type === 'cancel') {
    abort?.abort()
    abort = null
    return
  }
  if (msg.type === 'shade') {
    try {
      shade(msg.job)
    } catch (err) {
      post({ type: 'error', message: String((err as Error)?.message ?? err) })
    }
    return
  }
  abort?.abort()
  abort = new AbortController()
  const signal = abort.signal
  prepare(msg.job, signal).catch((err) => {
    if (!signal.aborted) post({ type: 'error', message: String(err?.message ?? err) })
  })
}
