/// <reference lib="webworker" />
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { enuToGeodetic, geodeticToEnu, lonLatToTile, tileToLonLat } from './geodesy'
import { waterLevels } from './waterLevels'

/**
 * Masque d'eau d'un site, hors du fil principal.
 *
 * Source : la couche `water` des tuiles vectorielles OpenFreeMap (schema
 * OpenMapTiles) — l'ocean decoupe sur le trait de cote OpenStreetMap, et les
 * lacs en polygones. Les polygones sont projetes sur la grille meme de la
 * pyramide d'altitudes (plan local azimutal equidistant autour du site, voir
 * `geodesy.ts`) et dessines dans un canevas hors ecran : le masque se lit
 * donc exactement comme le relief, cellule pour cellule.
 *
 * Deux canaux par cellule : l'eau, toutes classes retenues confondues, et
 * l'ocean seul (sa lumiere montante n'est pas celle d'un lac).
 *
 * Ce qui est retenu : l'ocean, et les lacs, reservoirs et lagunes d'au moins
 * `MIN_LAKE_M2`. Les mares et les rivieres sont ecartees : trop etroites, elles
 * scintilleraient au loin. Un morceau de lac qui touche le bord de la tuile est
 * garde quelle que soit sa taille : c'est le fragment d'un lac plus grand,
 * coupe par la tuile.
 */

export interface WaterLevelRequest {
  halfSpanM: number
  zoom: number
}

export interface WaterRequest {
  requestId: number
  latitudeDeg: number
  longitudeDeg: number
  size: number
  levels: WaterLevelRequest[]
  tilesUrl: string
}

/** Deuxieme temps : le niveau de chaque plan d'eau, une fois le relief du niveau charge. */
export interface WaterLevelsRequest {
  kind: 'levels'
  requestId: number
  size: number
  /** Masque du niveau (eau, ocean), tel que rendu par le premier temps. */
  mask: Uint8Array
  /** Altitudes du relief sur la meme grille, m. */
  heights: Int16Array
}

export interface WaterLevelsResult {
  kind: 'levels'
  requestId: number
  /** Niveau de l'eau par cellule, m ; propage sur quelques cellules de rivage. */
  level: Float32Array
}

export interface WaterResult {
  kind?: 'mask'
  requestId: number
  /** Un masque par niveau, `size² × 2` octets : eau, ocean. */
  masks: Uint8Array[]
  /** Le site a-t-il de l'eau quelque part ? Evite tout travail inutile ensuite. */
  anyWater: boolean
}

const MIN_LAKE_M2 = 1e6
const LAKE_CLASSES = new Set(['lake', 'reservoir', 'lagoon'])
/** Zoom maximal des tuiles vectorielles. */
const MAX_ZOOM = 14

function levelTiles(lat0: number, lon0: number, halfSpanM: number, zoom: number) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const steps = 8
  for (let j = 0; j <= steps; j++)
    for (let i = 0; i <= steps; i++) {
      const g = enuToGeodetic(lat0, lon0, -halfSpanM + (2 * halfSpanM * i) / steps, -halfSpanM + (2 * halfSpanM * j) / steps)
      const t = lonLatToTile(g.longitudeDeg, g.latitudeDeg, zoom)
      minX = Math.min(minX, t.x)
      maxX = Math.max(maxX, t.x)
      minY = Math.min(minY, t.y)
      maxY = Math.max(maxY, t.y)
    }
  const out: { x: number; y: number }[] = []
  for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) out.push({ x, y })
  return out
}

async function fetchTile(template: string, z: number, x: number, y: number): Promise<VectorTile | null> {
  const n = 2 ** z
  const url = template.replace('{z}', String(z)).replace('{x}', String(((x % n) + n) % n)).replace('{y}', String(y))
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())))
  } catch {
    return null
  }
}

/** Aire d'un anneau en coordonnees locales, m² (formule du lacet). */
function ringArea(ring: { x: number; y: number }[]): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y)
  return Math.abs(a) / 2
}

async function rasterize(req: WaterRequest, level: WaterLevelRequest): Promise<{ mask: Uint8Array; any: boolean }> {
  const { size, latitudeDeg: lat0, longitudeDeg: lon0 } = req
  const zoom = Math.min(MAX_ZOOM, level.zoom)
  const step = (2 * level.halfSpanM) / (size - 1)
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, size, size)

  const tiles = levelTiles(lat0, lon0, level.halfSpanM, zoom)
  const queue = [...tiles]
  const CONCURRENCY = 6
  let any = false

  const drawTile = (tile: VectorTile, tx: number, ty: number) => {
    const layer = tile.layers.water
    if (!layer) return
    const extent = layer.extent
    // Deux passes : l'eau dans le rouge, l'ocean dans le vert.
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i)
      if (f.type !== 3) continue
      const cls = String(f.properties.class ?? '')
      const ocean = cls === 'ocean'
      if (!ocean && !LAKE_CLASSES.has(cls)) continue
      if (f.properties.intermittent === 1) continue
      const rings = f.loadGeometry()
      // Projection de chaque sommet : tuile → longitude, latitude → plan local → cellule.
      const projected = rings.map((ring) =>
        ring.map((p) => {
          const g = tileToLonLat(tx + p.x / extent, ty + p.y / extent, zoom)
          const e = geodeticToEnu(lat0, lon0, g.latitudeDeg, g.longitudeDeg)
          return { x: (e.eastM + level.halfSpanM) / step, y: (e.northM + level.halfSpanM) / step, touches: p.x <= 1 || p.y <= 1 || p.x >= extent - 1 || p.y >= extent - 1, m: e }
        }),
      )
      if (!ocean) {
        const touchesEdge = projected.some((r) => r.some((p) => p.touches))
        const area = projected.reduce((s, r) => s + ringArea(r.map((p) => ({ x: p.m.eastM, y: p.m.northM }))), 0)
        if (!touchesEdge && area < MIN_LAKE_M2) continue
      }
      ctx.beginPath()
      for (const ring of projected) {
        ring.forEach((p, k) => (k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.closePath()
      }
      ctx.fillStyle = ocean ? 'rgb(255,255,0)' : 'rgb(255,0,0)'
      ctx.fill('evenodd')
      any = true
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const t = queue.shift()
        if (!t) return
        const tile = await fetchTile(req.tilesUrl, zoom, t.x, t.y)
        if (tile) drawTile(tile, t.x, t.y)
      }
    }),
  )

  const pixels = ctx.getImageData(0, 0, size, size).data
  const mask = new Uint8Array(size * size * 2)
  for (let k = 0, o = 0; k < size * size; k++, o += 4) {
    mask[2 * k] = pixels[o]
    mask[2 * k + 1] = pixels[o + 1]
  }
  return { mask, any }
}

const scope = self as unknown as DedicatedWorkerGlobalScope
scope.onmessage = async (event: MessageEvent<WaterRequest | WaterLevelsRequest>) => {
  if ('kind' in event.data && event.data.kind === 'levels') {
    const { requestId, size, mask, heights } = event.data
    const level = waterLevels(size, mask, heights)
    const out: WaterLevelsResult = { kind: 'levels', requestId, level }
    scope.postMessage(out, [level.buffer as ArrayBuffer])
    return
  }
  const req = event.data as WaterRequest
  const masks: Uint8Array[] = []
  let anyWater = false
  for (const level of req.levels) {
    const { mask, any } = await rasterize(req, level)
    masks.push(mask)
    anyWater ||= any
  }
  const result: WaterResult = { requestId: req.requestId, masks, anyWater }
  scope.postMessage(result, masks.map((m) => m.buffer as ArrayBuffer))
}
