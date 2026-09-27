import { DataTexture, LinearFilter, RGBAFormat, UnsignedByteType, ClampToEdgeWrapping } from 'three'
import { CLIPMAP_SIZE } from './elevationClipmap'
import type { WaterLevelsRequest, WaterLevelsResult, WaterRequest, WaterResult } from './waterWorker'
import { currentClipmap } from './elevationSource'

/**
 * Masque d'eau du site, par niveau de la pyramide d'altitudes — voir
 * `waterWorker.ts` pour la source et le trace.
 *
 * Chaque niveau devient une texture RGBA (eau, ocean, niveau de l'eau sur deux
 * octets) de la taille du niveau,
 * filtree lineairement : le trait de cote en sort anticrenele, a la
 * resolution meme du relief. Le nuanceur du relief la lit a la position au
 * sol de chaque fragment, avec la meme regle de choix du niveau.
 *
 * Aucun appel n'est fait si le relief n'est pas charge : le masque vit avec
 * lui. Les tuiles vectorielles, elles, restent dans le cache HTTP du
 * navigateur (OpenFreeMap les sert avec une longue duree de vie).
 */

const TILEJSON = 'https://tiles.openfreemap.org/planet'

let tilesUrl: Promise<string | null> | null = null
function vectorTilesUrl(): Promise<string | null> {
  tilesUrl ??= fetch(TILEJSON)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j?.tiles?.[0] as string | undefined) ?? null)
    .catch(() => null)
  return tilesUrl
}

let worker: Worker | null = null
let nextId = 1
let currentKey = ''
let textures: DataTexture[] = []
let masks: Uint8Array[] = []
let levelsDone: boolean[] = []
let levelsPending: boolean[] = []
let halfSpans: number[] = []
let anyWater = false
let revision = 0

/** Masques du site courant, du niveau fin au grossier, ou liste vide. */
export const waterTextures = (): readonly DataTexture[] => textures
export const waterHalfSpans = (): readonly number[] => halfSpans
/** Y a-t-il de l'eau sur le site ? Tant que non, rien d'autre ne doit travailler pour elle. */
export const siteHasWater = (): boolean => anyWater
/** Change a chaque masque publie. */
export const waterRevision = (): number => revision

/**
 * Niveau de l'eau, code sur 16 bits dans les canaux bleu et alpha : pas de
 * 12,5 cm, de −500 a 7 692 m. 65 535 veut dire « niveau inconnu » — tant que le
 * relief n'est pas charge, l'eau n'est pas decoupee par lui.
 */
const LEVEL_UNKNOWN = 65535
const encodeLevel = (m: number) => Math.min(65534, Math.max(0, Math.round((m + 500) * 8)))

function packTexture(mask: Uint8Array, level: Float32Array | null): Uint8Array {
  const n = CLIPMAP_SIZE * CLIPMAP_SIZE
  const out = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const q = level ? encodeLevel(level[i]) : LEVEL_UNKNOWN
    out[4 * i] = mask[2 * i]
    out[4 * i + 1] = mask[2 * i + 1]
    out[4 * i + 2] = q >> 8
    out[4 * i + 3] = q & 255
  }
  return out
}

function ensureWorker(): Worker {
  worker ??= new Worker(new URL('./waterWorker.ts', import.meta.url), { type: 'module' })
  return worker
}

function ask<T extends { requestId: number }>(message: { requestId: number }, transfer: Transferable[] = []): Promise<T> {
  const w = ensureWorker()
  return new Promise<T>((resolve) => {
    const listener = (event: MessageEvent<T>) => {
      if (event.data.requestId !== message.requestId) return
      w.removeEventListener('message', listener)
      resolve(event.data)
    }
    w.addEventListener('message', listener)
    w.postMessage(message, transfer)
  })
}

/**
 * Lance le trace du masque pour un site. Idempotent pour un meme site ;
 * un nouveau site abandonne le precedent.
 */
export async function loadWaterAround(latitudeDeg: number, longitudeDeg: number, levels: { halfSpanM: number; zoom: number }[]) {
  const key = `${latitudeDeg.toFixed(4)}:${longitudeDeg.toFixed(4)}`
  if (key === currentKey) return
  currentKey = key
  textures.forEach((t) => t.dispose())
  textures = []
  masks = []
  levelsDone = []
  levelsPending = []
  halfSpans = []
  anyWater = false
  revision++

  const url = await vectorTilesUrl()
  if (!url || key !== currentKey) return
  const request: WaterRequest = { requestId: nextId++, latitudeDeg, longitudeDeg, size: CLIPMAP_SIZE, levels, tilesUrl: url }
  const result = await ask<WaterResult>(request)
  if (key !== currentKey) return
  masks = result.masks
  levelsDone = masks.map(() => false)
  levelsPending = masks.map(() => false)
  textures = masks.map((mask) => {
    const t = new DataTexture(packTexture(mask, null) as Uint8Array<ArrayBuffer>, CLIPMAP_SIZE, CLIPMAP_SIZE, RGBAFormat, UnsignedByteType)
    t.magFilter = LinearFilter
    t.minFilter = LinearFilter
    t.wrapS = ClampToEdgeWrapping
    t.wrapT = ClampToEdgeWrapping
    t.unpackAlignment = 1
    t.needsUpdate = true
    return t
  })
  halfSpans = levels.map((l) => l.halfSpanM)
  anyWater = result.anyWater
  revision++
  refreshWaterLevels()
}

/**
 * Mesure le niveau des plans d'eau dans chaque niveau de relief deja charge.
 * A appeler quand le relief progresse ; sans effet pour les niveaux traites.
 */
export function refreshWaterLevels() {
  const clipmap = currentClipmap()
  if (!clipmap || !anyWater) return
  const key = currentKey
  // Le relief et le masque doivent decrire le meme site.
  if (`${clipmap.latitudeDeg.toFixed(4)}:${clipmap.longitudeDeg.toFixed(4)}` !== key) return
  clipmap.levels.forEach((lvl, i) => {
    if (!lvl.ready || !masks[i] || levelsDone[i] || levelsPending[i]) return
    levelsPending[i] = true
    const message: WaterLevelsRequest = {
      kind: 'levels',
      requestId: nextId++,
      size: CLIPMAP_SIZE,
      mask: masks[i].slice(),
      heights: lvl.heightM.slice(),
    }
    void ask<WaterLevelsResult>(message, [message.mask.buffer as ArrayBuffer, message.heights.buffer as ArrayBuffer]).then((r) => {
      if (key !== currentKey || !textures[i]) return
      ;(textures[i].image.data as unknown as Uint8Array).set(packTexture(masks[i], r.level))
      textures[i].needsUpdate = true
      levelsDone[i] = true
      revision++
    })
  })
}
