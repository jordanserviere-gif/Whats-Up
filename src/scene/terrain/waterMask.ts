import { DataTexture, LinearFilter, RGFormat, UnsignedByteType, ClampToEdgeWrapping } from 'three'
import { CLIPMAP_SIZE } from './elevationClipmap'
import type { WaterRequest, WaterResult } from './waterWorker'

/**
 * Masque d'eau du site, par niveau de la pyramide d'altitudes — voir
 * `waterWorker.ts` pour la source et le trace.
 *
 * Chaque niveau devient une texture RG (eau, ocean) de la taille du niveau,
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
 * Lance le trace du masque pour un site. Idempotent pour un meme site ;
 * un nouveau site abandonne le precedent.
 */
export async function loadWaterAround(latitudeDeg: number, longitudeDeg: number, levels: { halfSpanM: number; zoom: number }[]) {
  const key = `${latitudeDeg.toFixed(4)}:${longitudeDeg.toFixed(4)}`
  if (key === currentKey) return
  currentKey = key
  textures.forEach((t) => t.dispose())
  textures = []
  halfSpans = []
  anyWater = false
  revision++

  const url = await vectorTilesUrl()
  if (!url || key !== currentKey) return
  worker ??= new Worker(new URL('./waterWorker.ts', import.meta.url), { type: 'module' })
  const requestId = nextId++
  const request: WaterRequest = { requestId, latitudeDeg, longitudeDeg, size: CLIPMAP_SIZE, levels, tilesUrl: url }
  const result = await new Promise<WaterResult>((resolve) => {
    const listener = (event: MessageEvent<WaterResult>) => {
      if (event.data.requestId !== requestId) return
      worker!.removeEventListener('message', listener)
      resolve(event.data)
    }
    worker!.addEventListener('message', listener)
    worker!.postMessage(request)
  })
  if (key !== currentKey) return
  textures = result.masks.map((mask) => {
    const t = new DataTexture(mask as Uint8Array<ArrayBuffer>, CLIPMAP_SIZE, CLIPMAP_SIZE, RGFormat, UnsignedByteType)
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
}
