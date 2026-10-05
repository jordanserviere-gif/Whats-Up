/**
 * Worker du mode photo — deux roles.
 *
 * **Preparer** (une instance) : la passe de visibilite grossiere, le choix des
 * tuiles au pas du pixel, leur chargement, et une carte d'ombre fine pour le
 * voile atmospherique.
 *
 * **Rendre** (un groupe) : chaque worker recoit les tuiles une fois, puis des
 * bandes de colonnes, passe apres passe. Pour chacune : la marche des rayons,
 * les normales, un rayon vers le Soleil par pixel et la part de ciel. Les
 * passes ne different que d'un decalage de la grille d'une fraction de pixel :
 * leur moyenne est l'anticrenelage de l'image.
 *
 * Le fil principal ne recoit que des tableaux prets pour le GPU, transferes
 * sans copie.
 */
/// <reference lib="webworker" />
import { CLIPMAP_SIZE, sampleClipmap, type ElevationClipmap } from '../terrain/elevationClipmap'
import { NEAR_FIELD_HALF_SPAN_M, NEAR_FIELD_SIZE, NEAR_FIELD_STEP_M, NEAR_FIELD_UNIT_M, nearFieldWeight } from '../terrain/nearField'
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
  fromHalf,
  cellAngle,
  reuseShading,
  type PhotoGBuffer,
  type MaxGrid,
  type PhotoFrame,
} from './photoRaster'
import { fetchHeightTile, SOURCES, sourcesAt } from './photoSources'
import { LocalProjector, TileStore, tileCellM, tileKey, tileLevelAt, tileSpanDeg, type HeightTile } from './photoTiles'

/** Le relief courant, copie depuis le fil principal. */
export interface CurrentRelief {
  latitudeDeg: number
  longitudeDeg: number
  clipmap: Array<{
    halfSpanM: number
    stepM: number
    heights: Int16Array
    ready: boolean
  }>
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
  /** Precharger seulement : les tuiles du cadre vont au cache, et l'on s'arrete la. */
  prefetch?: boolean
}

/** Ce que chaque worker du groupe garde pour toutes ses bandes. */
export interface RenderInit extends CurrentRelief {
  frame: PhotoFrame
  tiles: HeightTile[]
  projector: { lat: Float64Array; lon: Float64Array; half: number }
  maxGrid: MaxGrid
  eyeM: number
  reachM: number
  sunAltitudeDeg: number
  sunAzimuthDeg: number
  effectiveRadiusM: number
  peakM: number
}

/** Une bande de colonnes d'une passe. */
export interface BandJob {
  /** Decalages de la grille de chaque passe, en pas : des fractions de pixel. La premiere fait reference. */
  jitters: Array<[number, number]>
  colStart: number
  colEnd: number
}

export type PhotoPhase = 'visibilite' | 'relief' | 'rendu' | 'ombres'

export interface PrepareResult {
  type: 'prepared'
  frame: PhotoFrame
  tiles: HeightTile[]
  projector: { lat: Float64Array; lon: Float64Array; half: number }
  maxGrid: MaxGrid
  shadow: { size: number; halfSpanM: number; height: Float32Array }
  stats: {
    tiles: number
    failed: number
    levels: Record<number, number>
    milliseconds: number
  }
}

export type PhotoWorkerMessage =
  | { type: 'progress'; phase: PhotoPhase; fraction: number; detail?: string }
  | { type: 'prefetched'; tiles: number }
  | PrepareResult
  | {
      type: 'band'
      pass: number
      colStart: number
      colEnd: number
      g: Uint16Array
      /** Part des pixels calcules exactement — un pour la passe de reference. */
      exact: number
    }
  | { type: 'error'; message: string }

const post = (msg: PhotoWorkerMessage, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer)

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
    const units = (near[k] * (1 - tx) + near[k + 1] * tx) * (1 - tz) + (near[k + NEAR_FIELD_SIZE] * (1 - tx) + near[k + NEAR_FIELD_SIZE + 1] * tx) * tz
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

/** Les tuiles d'une photo, un magasin par service. */
class Stores {
  readonly bySource = SOURCES.map(() => new TileStore())
  add(tile: HeightTile): void {
    this.bySource[tile.source].add(tile)
  }
  get size(): number {
    return this.bySource.reduce((a, s) => a + s.size, 0)
  }
  all(): HeightTile[] {
    return this.bySource.flatMap((s) => s.all())
  }
}

/** Cle d'une tuile d'un service : la grille est la meme pour tous. */
const sourceKey = (source: number, z: number, x: number, y: number) => tileKey(z, x, y) * 8 + source

/**
 * Les tuiles, fondues entre niveaux selon la distance — voir
 * `TileStore.sampleBlend` —, puis le relief courant la ou elles se taisent.
 *
 * Les services sont lus en cascade, celui du territoire du point d'abord :
 * chacun s'arrete a sa frontiere, et la donnee la trace au point pres. Les
 * autres suivent, pour qu'aucun trou ne reste la ou une case mixte s'est
 * trompee de cote.
 */
function compose(stores: Stores, projector: LocalProjector, fallback: Sampler, photo: PhotoFrame): Sampler {
  const ll = { lat: 0, lon: 0 }
  const all = SOURCES.map((_, i) => i)
  return (e, n) => {
    projector.toLatLon(e, n, ll)
    // La finesse voulue suit celle des pixels, plus fins vers les bords de l'image.
    const da = Math.atan2(e, n) - photo.az0
    const angle = cellAngle(photo, Math.min(1.5, Math.abs(Math.atan2(Math.sin(da), Math.cos(da)))))
    const zf = tileLevelAt(Math.hypot(e, n) * angle)
    const first = sourcesAt(ll.lat, ll.lon)
    for (const i of first) {
      const h = stores.bySource[i].sampleBlend(ll.lat, ll.lon, Math.min(zf, SOURCES[i].maxLevel))
      if (!Number.isNaN(h)) return h
    }
    for (const i of all) {
      if (first.includes(i) || stores.bySource[i].size === 0) continue
      const h = stores.bySource[i].sampleBlend(ll.lat, ll.lon, Math.min(zf, SOURCES[i].maxLevel))
      if (!Number.isNaN(h)) return h
    }
    return fallback(e, n)
  }
}

/**
 * Plafond de tuiles par photo : 1 300 × 132 ko, 170 Mo — copies dans chaque
 * worker du groupe.
 */
const MAX_TILES = 1300
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
/** Niveau le plus grossier du filet de tuiles parentes. */
const NET_FLOOR = 8
/** Part d'une tuile, pres de chaque bord, ou la voisine est demandee aussi. */
const EDGE = 0.06
function chooseTiles(needs: ReturnType<typeof tileNeeds>, projector: LocalProjector, job: CurrentRelief, have: Set<number>): TileRef[] {
  const ll = { lat: 0, lon: 0 }
  // Au-dela du plafond, la finesse recule par paliers de racine de deux : un
  // depassement d'un cheveu ne fait plus tomber toute la photo d'un niveau.
  for (let coarsen = 1; coarsen <= 64; coarsen *= Math.SQRT2) {
    const wanted = new Map<number, TileRef>()
    for (const need of needs) {
      projector.toLatLon(need.eastM, need.northM, ll)
      const d = Math.hypot(need.eastM, need.northM)
      // Chaque service du point — un seul dans une case evidente, ceux de
      // chaque cote dans une case qu'une frontiere traverse.
      for (const src of sourcesAt(ll.lat, ll.lon)) {
        const zf = Math.min(SOURCES[src].maxLevel, tileLevelAt(need.cellM * coarsen))
        // Les deux niveaux que la lecture fondra ici.
        const z1 = Math.ceil(zf)
        for (const z of z1 > zf ? [z1, z1 - 1] : [z1]) {
          if (z < 0 || tileCellM(z) >= 0.8 * currentStepAt(job, d)) continue
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
              const k = sourceKey(src, z, x + dx, y + dy)
              if (!have.has(k)) wanted.set(k, { src, z, x: x + dx, y: y + dy })
            }
          }
          // Le filet : l'aieule de trois niveaux au-dessus, soixante-quatre fois
          // moins nombreuse. La ou une tuile fine manque — refusee par le service,
          // ou tombee sur un point que les passes grossieres croyaient cache —, la
          // lecture retombe sur elle, et non sur le relief courant, plus lisse et
          // decale de quelques metres : il en sortait des plaques rectangulaires.
          if (z >= 3 + NET_FLOOR) {
            const k = sourceKey(src, z - 3, x >> 3, y >> 3)
            if (!have.has(k)) wanted.set(k, { src, z: z - 3, x: x >> 3, y: y >> 3 })
          }
        }
      }
      if (wanted.size > MAX_TILES * 1.5) break
    }
    if (wanted.size + have.size <= MAX_TILES) return [...wanted.values()]
  }
  return []
}

/** Une tuile a demander : son service et sa place dans la grille. */
interface TileRef {
  src: number
  z: number
  x: number
  y: number
}

async function loadTiles(
  list: TileRef[],
  store: Stores,
  have: Set<number>,
  signal: AbortSignal,
  stats: PrepareResult['stats'],
  onProgress: (fraction: number) => void,
): Promise<void> {
  let done = 0
  // Trois tours. Le service rate des tuiles sous la charge, et les rend sans
  // difficulte une fois les autres servies : le second tour, moins presse,
  // reprend celles-la. Ce qui echoue encore est remplace par sa parente.
  let queue = list
  for (let round = 0; round < 3 && queue.length > 0; round++) {
    const missed: typeof list = []
    let next = 0
    const run = async () => {
      while (next < queue.length) {
        const t = queue[next++]
        have.add(sourceKey(t.src, t.z, t.x, t.y))
        const tile = await fetchHeightTile(t.src, t.z, t.x, t.y, signal)
        if (tile === 'failed') {
          const parent = sourceKey(t.src, t.z - 1, t.x >> 1, t.y >> 1)
          if (round === 0) missed.push(t)
          else {
            stats.failed++
            if (round === 1 && t.z > 0 && !have.has(parent)) {
              have.add(parent)
              missed.push({ src: t.src, z: t.z - 1, x: t.x >> 1, y: t.y >> 1 })
            }
          }
        } else if (tile) {
          store.add(tile)
          stats.levels[t.z] = (stats.levels[t.z] ?? 0) + 1
        }
        if (round === 0) onProgress(++done / list.length)
      }
    }
    await Promise.all(Array.from({ length: Math.min(round === 0 ? CONCURRENCY : 3, queue.length) }, run))
    queue = missed
  }
}

async function prepare(job: PrepareJob, signal: AbortSignal): Promise<void> {
  const started = performance.now()
  const stats: PrepareResult['stats'] = {
    tiles: 0,
    failed: 0,
    levels: {},
    milliseconds: 0,
  }
  const fallback = currentSampler(job)
  const projector = new LocalProjector(job.latitudeDeg, job.longitudeDeg, job.reachM + 5000)
  const store = new Stores()
  const have = new Set<number>()
  const frame = photoFrame(job.view)
  const sample = compose(store, projector, fallback, frame)

  // --- Visibilite grossiere, sur le relief courant ---------------------------------
  post({ type: 'progress', phase: 'visibilite', fraction: 0 })
  // Majorants : le relief courant plus une marge qui couvre ce que la donnee fine
  // peut y ajouter — la moitie d'une case, et cent cinquante metres.
  const maxGrid = buildMaxGrid(fallback, job.reachM, (d) => 150 + 0.5 * currentStepAt(job, d))
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
  const first = chooseTiles(tileNeeds(rough, frame), projector, job, have)
  post({
    type: 'progress',
    phase: 'relief',
    fraction: 0,
    detail: `${first.length} tuiles`,
  })
  await loadTiles(first, store, have, signal, stats, (f) =>
    post({
      type: 'progress',
      phase: 'relief',
      fraction: f * 0.8,
      detail: `${first.length} tuiles`,
    }),
  )
  if (signal.aborted) return

  // --- Le rendu au pixel, et un complement pour ce qui vient d'apparaitre -------------
  //
  // Le relief fin deplace un peu les cretes : des points que la passe grossiere
  // croyait caches deviennent visibles. Une passe intermediaire les trouve, et
  // l'on charge ce qui leur manque avant le rendu definitif.
  post({ type: 'progress', phase: 'rendu', fraction: 0 })
  const mid = march(sample, coarsenFrame(frame, 2))
  const extra = chooseTiles(tileNeeds(mid, frame), projector, job, have)
  if (extra.length > 0) {
    await loadTiles(extra, store, have, signal, stats, (f) =>
      post({
        type: 'progress',
        phase: 'relief',
        fraction: 0.8 + f * 0.2,
        detail: `${first.length + extra.length} tuiles`,
      }),
    )
  }
  if (job.prefetch) {
    post({ type: 'prefetched', tiles: store.size })
    return
  }

  if (signal.aborted) return

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
  // Les tuiles, la projection et les majorants repartent par copie vers le
  // groupe : on ne les transfere pas, le fil principal les redistribue.
  post(
    {
      type: 'prepared',
      frame,
      tiles,
      projector: projector.export(),
      maxGrid,
      shadow: {
        size: SHADOW_SIZE,
        halfSpanM: SHADOW_HALF_SPAN_M,
        height: shadowHeight,
      },
      stats,
    },
    [shadowHeight.buffer],
  )
}

// --- Rendre : une bande de colonnes d'une passe ----------------------------------------

let renderer: { init: RenderInit; sample: Sampler; coarse: Sampler } | null = null

function initRender(init: RenderInit): void {
  const store = new Stores()
  for (const t of init.tiles) store.add(t)
  const coarse = currentSampler(init)
  renderer = {
    init,
    sample: compose(store, LocalProjector.from(init.projector), coarse, init.frame),
    coarse,
  }
}

function renderBand(job: BandJob): void {
  if (!renderer) throw new Error('worker de rendu non initialise')
  const { init, sample, coarse } = renderer
  const base = init.frame
  const opt = {
    observerM: init.eyeM,
    effectiveRadiusM: init.effectiveRadiusM,
    reachM: init.reachM,
    fineStepAt: (d: number) => d * base.step * 2.5,
    maxGrid: init.maxGrid,
  }
  // Les passes de la bande, a la suite : la premiere fait reference, les
  // suivantes en reprennent l'ombre et le ciel hors des bords — voir
  // `reuseShading`.
  let ref: { range: Float32Array; sun: Float32Array; sky: Float32Array } | null = null
  const [jx0, jy0] = job.jitters[0]
  job.jitters.forEach(([jx, jy], pass) => {
    // Une bande de colonnes est elle-meme une grille : la meme, plus etroite, et
    // decalee de la fraction de pixel de sa passe.
    const frame: PhotoFrame = {
      ...base,
      uMin: base.uMin + (job.colStart + jx) * base.step,
      vMin: base.vMin + jy * base.step,
      cols: job.colEnd - job.colStart,
    }
    const gb = marchColumns(sample, frame, opt)
    const normals = pixelNormals(sample, gb)
    let sun: Float32Array
    let sky: Float32Array
    let exact = 1
    if (!ref) {
      ;({ sun, sky } = shadePixels(sample, coarse, gb, normals, 0, init, 0, frame.rows))
      ref = { range: gb.range, sun, sky }
    } else {
      sun = new Float32Array(gb.range.length)
      sky = new Float32Array(gb.range.length).fill(1)
      const mask = reuseShading(ref, gb, jx - jx0, jy - jy0, sun, sky)
      const part = shadePixels(sample, coarse, gb, normals, 0, init, 0, frame.rows, mask)
      let n = 0
      for (let k = 0; k < mask.length; k++) {
        if (!mask[k]) continue
        sun[k] = part.sun[k]
        sky[k] = part.sky[k]
        n++
      }
      exact = n / Math.max(1, mask.length)
    }
    const g = packBand(gb, normals, sun, sky)
    post({ type: 'band', pass, colStart: job.colStart, colEnd: job.colEnd, g, exact }, [g.buffer])
  })
}

/**
 * La bande de texture, deja en demi-flottants et deja entrelacee : deux texels
 * par pixel — distance (km), altitude, part du Soleil, couverture ; puis
 * normale (x, reste de la distance en metres, z) et part du ciel. Une seule
 * texture, parce que le nuanceur du relief n'a plus qu'une unite de texture
 * libre sur seize. La conversion se fait ici, en parallele, plutot que sur le
 * fil principal.
 *
 * ⚠️ La distance ne tient pas dans un demi-flottant : onze bits, soit 16 m
 * d'arrondi a trente kilometres. Le nuanceur en retire la position au sol —
 * l'orthophoto, l'eau, les lumieres des villes —, et l'arrondi la faisait
 * avancer par paliers. Le reste de l'arrondi part dans la place de la
 * composante verticale de la normale, que le nuanceur recalcule : elle est
 * toujours positive sur un relief.
 */
function packBand(gb: PhotoGBuffer, normals: Float32Array, sun: Float32Array, sky: Float32Array): Uint16Array {
  const g = new Uint16Array(sky.length * 8)
  for (let i = 0; i < sky.length; i++) {
    const o = i * 8
    const km = toHalf(gb.range[i] / 1000)
    g[o] = km
    g[o + 1] = toHalf(gb.altitude[i])
    g[o + 2] = toHalf(sun[i])
    g[o + 3] = toHalf(gb.coverage[i])
    g[o + 4] = toHalf(normals[i * 3])
    g[o + 5] = toHalf(gb.range[i] - fromHalf(km) * 1000)
    g[o + 6] = toHalf(normals[i * 3 + 2])
    g[o + 7] = toHalf(sky[i])
  }
  return g
}

type WorkerRequest = { type: 'prepare'; job: PrepareJob } | { type: 'init'; init: RenderInit } | { type: 'band'; job: BandJob } | { type: 'cancel' }

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  if (msg.type === 'cancel') {
    abort?.abort()
    abort = null
    return
  }
  if (msg.type === 'init' || msg.type === 'band') {
    try {
      if (msg.type === 'init') initRender(msg.init)
      else renderBand(msg.job)
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
