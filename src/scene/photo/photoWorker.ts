/**
 * Worker du mode photo.
 *
 * Tout le travail lourd d'une photo vit ici, hors du fil principal : les
 * requetes, le reechantillonnage de dizaines de millions de points, le maillage
 * de plusieurs millions de sommets, et un rayon d'ombre par sommet. Le fil
 * principal ne recoit que des tampons prets a partir vers le GPU, transferes
 * sans copie.
 *
 * Ordre : tranches → rasters → grilles locales → maillage → ombres.
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
import {
  buildPhotoMesh,
  composeSampler,
  finestStepAt,
  photoBands,
  photoMeshPlan,
  sunVisibility,
  SHADOW_REACH_M,
  type EnuGrid,
  type PhotoView,
  type Sampler,
} from './photoPlan'
import { bandChunkCount, fetchBandRaster, rasterToGrid } from './photoSources'

export interface PhotoJob {
  view: PhotoView
  latitudeDeg: number
  longitudeDeg: number
  /** Altitude de l'oeil, metres. */
  eyeM: number
  effectiveRadiusM: number
  reachM: number
  peakM: number
  sunAltitudeDeg: number
  sunAzimuthDeg: number
  /** Pyramide courante, copiee : niveaux du plus fin au plus grossier. */
  clipmap: Array<{ halfSpanM: number; stepM: number; heights: Int16Array; ready: boolean }>
  /** Champ proche courant, en quarts de metre, ou `null` hors de France. */
  near: Int16Array | null
}

export type PhotoWorkerMessage =
  | { type: 'progress'; phase: PhotoPhase; fraction: number; detail?: string }
  | {
      type: 'done'
      columns: number
      rings: number
      positions: Float32Array
      normals: Float32Array
      ranges: Float32Array
      altitudes: Float32Array
      sunVisibility: Float32Array
      index: Uint32Array
      stats: PhotoStats
    }
  | { type: 'error'; message: string }

export type PhotoPhase = 'relief' | 'maillage' | 'ombres'

export interface PhotoStats {
  bands: Array<{ nearM: number; farM: number; stepM: number; points: number; source: 'lidar' | 'courant' }>
  vertices: number
  milliseconds: number
}

let abort: AbortController | null = null

const post = (msg: PhotoWorkerMessage, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer)

/** Le relief courant, recompose a partir des copies : pyramide puis champ proche. */
function currentSampler(job: PhotoJob): Sampler {
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
    const units = (near[k] * (1 - tx) + near[k + 1] * tx) * (1 - tz) + (near[k + NEAR_FIELD_SIZE] * (1 - tx) + near[k + NEAR_FIELD_SIZE + 1] * tx) * tz
    const w = nearFieldWeight(e, n)
    return units * NEAR_FIELD_UNIT_M * w + coarse * (1 - w)
  }
}

async function run(job: PhotoJob, signal: AbortSignal): Promise<void> {
  const started = performance.now()
  const bands = photoBands(job.view, job.reachM)
  const stats: PhotoStats = { bands: [], vertices: 0, milliseconds: 0 }

  // --- Le relief -------------------------------------------------------------
  const totalChunks = bands.reduce((s, b) => s + bandChunkCount(job.latitudeDeg, job.longitudeDeg, b), 0)
  let doneChunks = 0
  post({ type: 'progress', phase: 'relief', fraction: 0, detail: `${bands.length} tranches, ${totalChunks} requêtes` })
  const grids: EnuGrid[] = []
  // Les tranches partent ensemble : le service est lent par requete, pas par
  // nombre de requetes, et la file de `fetchBandRaster` borne le parallelisme.
  const rasters = await Promise.all(
    bands.map((band) =>
      fetchBandRaster(job.latitudeDeg, job.longitudeDeg, band, signal, () => {
        doneChunks++
        post({ type: 'progress', phase: 'relief', fraction: totalChunks ? doneChunks / totalChunks : 1 })
      }),
    ),
  )
  bands.forEach((band, i) => {
    const raster = rasters[i].raster
    const grid = raster ? rasterToGrid(job.latitudeDeg, job.longitudeDeg, band, raster) : null
    if (grid) grids.push(grid)
    stats.bands.push({
      nearM: Math.round(band.nearM),
      farM: Math.round(band.farM),
      stepM: +band.stepM.toFixed(2),
      points: grid ? grid.nx * grid.ny : 0,
      source: grid ? 'lidar' : 'courant',
    })
  })
  if (signal.aborted) return
  const sample = composeSampler(grids, currentSampler(job))

  // --- Le maillage -------------------------------------------------------------
  const plan = photoMeshPlan(job.view, job.reachM)
  const mesh = buildPhotoMesh(sample, plan, job.eyeM, job.effectiveRadiusM, (f) =>
    post({ type: 'progress', phase: 'maillage', fraction: f }),
  )
  stats.vertices = mesh.columns * mesh.rings
  if (signal.aborted) return

  // --- Les ombres ----------------------------------------------------------------
  //
  // Un rayon par sommet, vers le Soleil. Les faces qui lui tournent le dos sont
  // de toute facon dans leur propre ombre (le cosinus d'incidence est nul) :
  // inutile d'y lancer un rayon. Au-dela de la portee des rayons, rien n'ombre,
  // comme pour la carte courante.
  const n = mesh.columns * mesh.rings
  const visibility = new Float32Array(n)
  const sunAlt = job.sunAltitudeDeg * (Math.PI / 180)
  const sunAz = job.sunAzimuthDeg * (Math.PI / 180)
  // Direction du Soleil dans le repere de la scene (+X est, +Y haut, −Z nord).
  const sx = Math.cos(sunAlt) * Math.sin(sunAz)
  const sy = Math.sin(sunAlt)
  const sz = -Math.cos(sunAlt) * Math.cos(sunAz)
  const coarseStep = job.clipmap[0]?.stepM ?? 30
  for (let i = 0; i < n; i++) {
    const facing = mesh.normals[i * 3] * sx + mesh.normals[i * 3 + 1] * sy + mesh.normals[i * 3 + 2] * sz
    const range = mesh.ranges[i]
    if (facing <= 0) {
      visibility[i] = 0
    } else if (range > SHADOW_REACH_M) {
      visibility[i] = 1
    } else {
      const e = mesh.local[i * 3]
      const nn = mesh.local[i * 3 + 2]
      // Le rayon part a un pas et demi de la grille locale : plus pres, il lirait
      // la facette meme qu'il eclaire et s'ombrerait lui-meme.
      const start = 1.5 * finestStepAt(grids, e, nn, coarseStep)
      visibility[i] = sunVisibility(
        sample,
        e,
        nn,
        mesh.local[i * 3 + 1],
        job.sunAltitudeDeg,
        job.sunAzimuthDeg,
        job.effectiveRadiusM,
        job.peakM,
        start,
      )
    }
    if ((i & 0x3fff) === 0) {
      post({ type: 'progress', phase: 'ombres', fraction: i / n })
      if (signal.aborted) return
    }
  }

  stats.milliseconds = Math.round(performance.now() - started)
  post(
    {
      type: 'done',
      columns: mesh.columns,
      rings: mesh.rings,
      positions: mesh.positions,
      normals: mesh.normals,
      ranges: mesh.ranges,
      altitudes: mesh.altitudes,
      sunVisibility: visibility,
      index: mesh.index,
      stats,
    },
    [mesh.positions.buffer, mesh.normals.buffer, mesh.ranges.buffer, mesh.altitudes.buffer, visibility.buffer, mesh.index.buffer],
  )
}

self.onmessage = (event: MessageEvent<{ type: 'start'; job: PhotoJob } | { type: 'cancel' }>) => {
  const msg = event.data
  if (msg.type === 'cancel') {
    abort?.abort()
    abort = null
    return
  }
  abort?.abort()
  abort = new AbortController()
  const signal = abort.signal
  run(msg.job, signal).catch((err) => {
    if (!signal.aborted) post({ type: 'error', message: String(err?.message ?? err) })
  })
}
