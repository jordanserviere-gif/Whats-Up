/**
 * Mode photo — d'ou viennent les tuiles d'altitude.
 *
 * ## En France : le MNT LiDAR HD de l'IGN, par WMS
 *
 * `GetMap` rend un raster d'altitudes en flottants (BIL 32 bits) pour n'importe
 * quelle emprise et definition. La couche `MIXED` descend a cinquante
 * centimetres et retombe d'elle-meme sur le RGE ALTI la ou le LiDAR n'est pas
 * leve. Mesure : 512 × 512 points au sommet du Ventoux, 1 797 a 1 909 m ; CORS
 * ouvert. Hors de France, elle rend −9999 partout.
 *
 * Chaque tuile est demandee en 257 × 257 sur une emprise **elargie d'une
 * demi-case** de chaque cote : le service place ses points au centre des
 * pixels, et c'est ainsi qu'ils tombent exactement sur la grille de la tuile,
 * bords compris.
 *
 * ## Ailleurs : les tuiles Terrarium, jusqu'a leur plancher
 *
 * Trente metres — le SRTM. Plus fin ne serait que de l'interpolation : le niveau
 * de tuile est donc borne la ou la case vaut une vingtaine de metres.
 *
 * ## Le cache
 *
 * Les reponses WMS vont dans le Cache Storage du navigateur, sous leur adresse
 * exacte : la grille etant fixe, une seconde photo au meme endroit ne
 * retelecharge rien.
 */
import { decodeTerrariumTile, terrariumUrl } from '../terrain/terrarium'
import { lonLatToTile, TILE_SIZE } from '../terrain/geodesy'
import { quantizeTile, tileBounds, TILE_CELLS, TILE_POINTS, type HeightTile } from './photoTiles'

const WMS = 'https://data.geopf.fr/wms-r'
const LAYER = 'IGNF_LIDAR-HD_MNT_ELEVATION.MIXED.WGS84G'
const NODATA_BELOW = -1000
const CACHE_NAME = 'whats-up-photo-relief-v1'

/** Emprise metropolitaine et corse, avec une marge. */
const FRANCE = { latMin: 41.2, latMax: 51.3, lonMin: -5.6, lonMax: 9.8 }

/** Niveau de tuile le plus fin pour chaque source. */
export const LIDAR_MAX_LEVEL = 17
export const TERRARIUM_MAX_LEVEL = 12

export function tileInFrance(z: number, x: number, y: number): boolean {
  const b = tileBounds(z, x, y)
  return b.latMax > FRANCE.latMin && b.latMin < FRANCE.latMax && b.lonMax > FRANCE.lonMin && b.lonMin < FRANCE.lonMax
}

export const pointInFrance = (lat: number, lon: number): boolean =>
  lat > FRANCE.latMin && lat < FRANCE.latMax && lon > FRANCE.lonMin && lon < FRANCE.lonMax

let cachePromise: Promise<Cache | null> | null = null
const photoCache = (): Promise<Cache | null> =>
  (cachePromise ??= typeof caches === 'undefined' ? Promise.resolve(null) : caches.open(CACHE_NAME).catch(() => null))

async function cachedArrayBuffer(url: string, signal: AbortSignal): Promise<ArrayBuffer | null> {
  const cache = await photoCache()
  const hit = cache ? await cache.match(url) : undefined
  if (hit) return hit.arrayBuffer()
  // Le service refuse parfois une requete sous la charge : deux nouvelles
  // tentatives, espacees, avant de renoncer.
  let res: Response | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt))
    res = await fetch(url, { signal }).catch((err) => {
      if (signal.aborted) throw err
      return null
    })
    if (res?.ok) break
  }
  if (!res?.ok) return null
  const buf = await res.arrayBuffer()
  if (cache) void cache.put(url, new Response(buf.slice(0), { headers: { 'content-type': res.headers.get('content-type') ?? '' } }))
  return buf
}

/** Tuile LiDAR HD / RGE ALTI. `null` hors couverture. */
async function lidarTile(z: number, x: number, y: number, signal: AbortSignal): Promise<HeightTile | null> {
  const b = tileBounds(z, x, y)
  const half = (b.lonMax - b.lonMin) / TILE_CELLS / 2
  // WMS 1.3.0 en EPSG:4326 : latitude puis longitude.
  const url =
    `${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=&FORMAT=image/x-bil;bits=32` +
    `&LAYERS=${LAYER}&CRS=EPSG:4326` +
    `&BBOX=${b.latMin - half},${b.lonMin - half},${b.latMax + half},${b.lonMax + half}` +
    `&WIDTH=${TILE_POINTS}&HEIGHT=${TILE_POINTS}`
  const buf = await cachedArrayBuffer(url, signal).catch((err) => {
    if (signal.aborted) throw err
    return null
  })
  if (!buf || buf.byteLength !== TILE_POINTS * TILE_POINTS * 4) return null
  const raw = new Float32Array(buf)
  const heights = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) heights[i] = raw[i] < NODATA_BELOW ? Number.NaN : raw[i]
  return quantizeTile(z, x, y, heights)
}

// --- Terrarium ------------------------------------------------------------------

const mercator = new Map<string, Promise<Int16Array | null>>()

function mercatorTile(zoom: number, tx: number, ty: number, signal: AbortSignal): Promise<Int16Array | null> {
  const key = `${zoom}/${tx}/${ty}`
  let hit = mercator.get(key)
  if (!hit) {
    hit = (async () => {
      try {
        const res = await fetch(terrariumUrl(zoom, tx, ty), { signal })
        if (!res.ok) return null
        const bitmap = await createImageBitmap(await res.blob())
        const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
        const ctx = canvas.getContext('2d')
        if (!ctx) return null
        ctx.drawImage(bitmap, 0, 0)
        return decodeTerrariumTile(ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data)
      } catch (err) {
        if (signal.aborted) throw err
        return null
      }
    })()
    mercator.set(key, hit)
  }
  return hit
}

/** Zoom Terrarium dont le pixel colle a une case geographique de niveau `z`. */
function terrariumZoomFor(z: number): number {
  // Une case de niveau z vaut 360/2^(z+1)/256 degres ; un pixel Terrarium de
  // zoom t en vaut 360/2^t/256. Le meme pas : t = z + 1, borne au plancher.
  return Math.min(TERRARIUM_MAX_LEVEL + 1, z + 1)
}

/** Tuile reechantillonnee depuis Terrarium. */
async function terrariumTile(z: number, x: number, y: number, signal: AbortSignal): Promise<HeightTile | null> {
  const b = tileBounds(z, x, y)
  const zoom = terrariumZoomFor(z)
  const nw = lonLatToTile(b.lonMin, b.latMax, zoom)
  const se = lonLatToTile(b.lonMax, b.latMin, zoom)
  const x0 = Math.floor(nw.x)
  const x1 = Math.floor(se.x - 1e-9)
  const y0 = Math.floor(nw.y)
  const y1 = Math.floor(se.y - 1e-9)
  const tiles = new Map<string, Int16Array | null>()
  await Promise.all(
    [...Array(x1 - x0 + 1)].flatMap((_, i) =>
      [...Array(y1 - y0 + 1)].map(async (_, j) => {
        tiles.set(`${x0 + i}/${y0 + j}`, await mercatorTile(zoom, x0 + i, y0 + j, signal))
      }),
    ),
  )
  const heights = new Float32Array(TILE_POINTS * TILE_POINTS)
  const span = b.lonMax - b.lonMin
  for (let j = 0; j < TILE_POINTS; j++) {
    const lat = b.latMax - (span * j) / TILE_CELLS
    for (let i = 0; i < TILE_POINTS; i++) {
      const lon = b.lonMin + (span * i) / TILE_CELLS
      const p = lonLatToTile(lon, lat, zoom)
      const tx = Math.min(x1, Math.floor(p.x))
      const ty = Math.min(y1, Math.floor(p.y))
      const data = tiles.get(`${tx}/${ty}`)
      if (!data) {
        heights[j * TILE_POINTS + i] = Number.NaN
        continue
      }
      // Lecture au plus proche dans la tuile : les pixels Terrarium sont deja a
      // la taille de nos cases, et le bilineaire entre tuiles voisines ne
      // gagnerait rien de visible.
      const px = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor((p.x - tx) * TILE_SIZE)))
      const py = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor((p.y - ty) * TILE_SIZE)))
      heights[j * TILE_POINTS + i] = Math.max(0, data[py * TILE_SIZE + px])
    }
  }
  return quantizeTile(z, x, y, heights)
}

/** La meilleure tuile disponible pour une case de la grille. */
export async function fetchHeightTile(z: number, x: number, y: number, signal: AbortSignal): Promise<HeightTile | null> {
  if (tileInFrance(z, x, y)) {
    const lidar = await lidarTile(z, x, y, signal)
    if (lidar) return lidar
  }
  if (z > TERRARIUM_MAX_LEVEL) return null
  return terrariumTile(z, x, y, signal)
}
