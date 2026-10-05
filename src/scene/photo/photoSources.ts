/**
 * Mode photo — d'ou viennent les tuiles d'altitude.
 *
 * Chaque tuile va au service le plus fin qui couvre son territoire — voir
 * `photoCoverage.ts` pour les contours —, et Terrarium sert partout ailleurs.
 *
 * ## France : le MNT LiDAR HD de l'IGN, par WMS — 50 cm
 *
 * `GetMap` rend un raster d'altitudes en flottants (BIL 32 bits) pour n'importe
 * quelle emprise et definition. La couche `MIXED` descend a cinquante
 * centimetres et retombe d'elle-meme sur le RGE ALTI la ou le LiDAR n'est pas
 * leve. Hors de France, elle rend −9999.
 *
 * ## Etats-Unis : le 3DEP de l'USGS, par ImageServer — 1 m
 *
 * `exportImage` en `bsq` 32 bits : les flottants bruts, suivis d'un masque de
 * validite d'un bit par point. La source est multi-resolution — un metre la ou
 * le LiDAR est leve, dix ailleurs.
 *
 * ## Espagne : le MDT05 de l'IGN, par WCS — 5 m
 *
 * Issu du LiDAR PNOA. `GetCoverage` en grille ASCII ArcInfo, dans une reponse
 * multipart. Hors d'Espagne, il rend zero : zero est donc lu comme inconnu —
 * la mer retombe sur le repli, qui y vaut zero aussi.
 *
 * Toutes trois sont demandees en 257 × 257 sur une emprise **elargie d'une
 * demi-case** de chaque cote : les services placent leurs points au centre des
 * pixels, et c'est ainsi qu'ils tombent sur la grille de la tuile, bords
 * compris.
 *
 * ## Ailleurs : les tuiles Terrarium, jusqu'a leur plancher
 *
 * Trente metres — le SRTM. Plus fin ne serait que de l'interpolation : le niveau
 * de tuile est donc borne la ou la case vaut une vingtaine de metres.
 *
 * ## Le cache
 *
 * Les reponses vont dans le Cache Storage du navigateur, sous leur adresse
 * exacte : la grille etant fixe, une seconde photo au meme endroit ne
 * retelecharge rien.
 */
import { decodeTerrariumTile, terrariumUrl } from '../terrain/terrarium'
import { lonLatToTile, TILE_SIZE } from '../terrain/geodesy'
import { cellAt, type TerritoryId } from './photoCoverage'
import { quantizeTile, tileBounds, TILE_CELLS, TILE_POINTS, type HeightTile } from './photoTiles'

const WMS = 'https://data.geopf.fr/wms-r'
const LAYER = 'IGNF_LIDAR-HD_MNT_ELEVATION.MIXED.WGS84G'
const NODATA_BELOW = -1000
const CACHE_NAME = 'whats-up-photo-relief-v1'

/** Niveau de tuile le plus fin de Terrarium : une case d'une vingtaine de metres. */
export const TERRARIUM_MAX_LEVEL = 12

type Fetched = HeightTile | null | 'failed'

/** Un service d'altitude : son territoire, sa finesse, et comment lui demander une tuile. */
export interface Source {
  name: string
  /** `null` : partout — le repli. */
  territory: TerritoryId | null
  /** Niveau de tuile le plus fin qui vaille la peine — la case juste sous le pas du service. */
  maxLevel: number
  fetch: (z: number, x: number, y: number, signal: AbortSignal) => Promise<Fetched>
}

/** Emprise d'une tuile elargie d'une demi-case : les points des services au centre des pixels. */
function paddedBounds(z: number, x: number, y: number) {
  const b = tileBounds(z, x, y)
  const half = (b.lonMax - b.lonMin) / TILE_CELLS / 2
  return { latMin: b.latMin - half, latMax: b.latMax + half, lonMin: b.lonMin - half, lonMax: b.lonMax + half }
}

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

/** Telechargement sans laisser filer l'erreur, sauf l'annulation. */
const download = (url: string, signal: AbortSignal) =>
  cachedArrayBuffer(url, signal).catch((err) => {
    if (signal.aborted) throw err
    return null
  })

/** Tuile LiDAR HD / RGE ALTI : `null` hors couverture, `'failed'` si le service n'a pas repondu. */
async function lidarTile(z: number, x: number, y: number, signal: AbortSignal): Promise<Fetched> {
  const b = paddedBounds(z, x, y)
  // WMS 1.3.0 en EPSG:4326 : latitude puis longitude.
  const url =
    `${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=&FORMAT=image/x-bil;bits=32` +
    `&LAYERS=${LAYER}&CRS=EPSG:4326` +
    `&BBOX=${b.latMin},${b.lonMin},${b.latMax},${b.lonMax}` +
    `&WIDTH=${TILE_POINTS}&HEIGHT=${TILE_POINTS}`
  const buf = await download(url, signal)
  if (!buf || buf.byteLength !== TILE_POINTS * TILE_POINTS * 4) return 'failed'
  const raw = new Float32Array(buf)
  const heights = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) heights[i] = raw[i] < NODATA_BELOW ? Number.NaN : raw[i]
  return quantizeTile(z, x, y, heights)
}

// --- Etats-Unis : 3DEP ----------------------------------------------------------

const USGS = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'

/** Tuile 3DEP : flottants bruts, puis un bit de validite par point, poids fort d'abord. */
async function usgsTile(z: number, x: number, y: number, signal: AbortSignal): Promise<Fetched> {
  const b = paddedBounds(z, x, y)
  const url =
    `${USGS}?bbox=${b.lonMin},${b.latMin},${b.lonMax},${b.latMax}&bboxSR=4326&imageSR=4326` +
    `&size=${TILE_POINTS},${TILE_POINTS}&format=bsq&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image`
  const buf = await download(url, signal)
  const n = TILE_POINTS * TILE_POINTS
  if (!buf || buf.byteLength < n * 4) return 'failed'
  const raw = new Float32Array(buf, 0, n)
  const mask = buf.byteLength >= n * 4 + Math.ceil(n / 8) ? new Uint8Array(buf, n * 4) : null
  const heights = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const valid = !mask || (mask[i >> 3] >> (7 - (i & 7))) & 1
    heights[i] = valid && raw[i] > NODATA_BELOW ? raw[i] : Number.NaN
  }
  return quantizeTile(z, x, y, heights)
}

// --- Espagne : MDT05 ------------------------------------------------------------

const IDEE = 'https://servicios.idee.es/wcs-inspire/mdt'

/** Tuile MDT05 : une grille ASCII ArcInfo dans une reponse multipart. */
async function spainTile(z: number, x: number, y: number, signal: AbortSignal): Promise<Fetched> {
  const b = paddedBounds(z, x, y)
  const url =
    `${IDEE}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=Elevacion4258_5&FORMAT=application/asc` +
    `&SUBSET=lat(${b.latMin},${b.latMax})&SUBSET=long(${b.lonMin},${b.lonMax})` +
    `&SCALESIZE=lat(${TILE_POINTS}),long(${TILE_POINTS})`
  const buf = await download(url, signal)
  if (!buf) return 'failed'
  const heights = parseArcGrid(new TextDecoder().decode(buf))
  if (!heights) return 'failed'
  // Hors d'Espagne, le service rend zero : inconnu.
  for (let i = 0; i < heights.length; i++) if (heights[i] === 0) heights[i] = Number.NaN
  return quantizeTile(z, x, y, heights)
}

/** Les 257 × 257 valeurs d'une grille ASCII ArcInfo, rangee 0 au nord ; `null` si elle n'a pas cette forme. */
export function parseArcGrid(text: string): Float32Array | null {
  const start = text.indexOf('ncols')
  if (start < 0) return null
  const end = text.indexOf('--wcs', start)
  const tokens = text.slice(start, end < 0 ? undefined : end).split(/\s+/)
  const header: Record<string, number> = {}
  let k = 0
  while (k + 1 < tokens.length && /^[a-z_]+$/i.test(tokens[k])) {
    header[tokens[k].toLowerCase()] = Number(tokens[k + 1])
    k += 2
  }
  if (header.ncols !== TILE_POINTS || header.nrows !== TILE_POINTS) return null
  const nodata = header.nodata_value
  const n = TILE_POINTS * TILE_POINTS
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = Number(tokens[k + i])
    out[i] = Number.isFinite(v) && v !== nodata ? v : Number.NaN
  }
  return out
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

// --- Le choix de la source --------------------------------------------------------

/** Les services, du plus fin au plus grossier ; Terrarium en dernier, partout. */
export const SOURCES: Source[] = [
  { name: 'LiDAR HD', territory: 'france', maxLevel: 17, fetch: lidarTile },
  { name: '3DEP', territory: 'usa', maxLevel: 16, fetch: usgsTile },
  { name: 'MDT05', territory: 'spain', maxLevel: 14, fetch: spainTile },
  { name: 'Terrarium', territory: null, maxLevel: TERRARIUM_MAX_LEVEL, fetch: (z, x, y, signal) => terrariumTile(z, x, y, signal) },
]
const TERRARIUM = SOURCES.length - 1
const SOURCE_OF = new Map<TerritoryId | null, number>(SOURCES.map((s, i) => [s.territory, i]))

const orders = new WeakMap<object, readonly number[]>()

/**
 * Les services d'un point, celui de son territoire en tete.
 *
 * Une case evidente n'en a qu'un ; une case qu'une frontiere traverse a ceux de
 * chaque cote — les tuiles de chacun y sont demandees, et la lecture les essaie
 * dans l'ordre.
 */
export function sourcesAt(lat: number, lon: number): readonly number[] {
  const cell = cellAt(lat, lon)
  let order = orders.get(cell)
  if (!order) {
    const first = SOURCE_OF.get(cell.label) ?? TERRARIUM
    const others = cell.present.map((t) => SOURCE_OF.get(t) ?? TERRARIUM).filter((i) => i !== first)
    order = [first, ...new Set(others.sort((a, b) => a - b))]
    orders.set(cell, order)
  }
  return order
}

/**
 * Une tuile d'un service : `null` s'il n'y a rien, `'failed'` s'il n'a pas
 * repondu.
 *
 * ⚠️ Un echec d'un service fin ne retombe **pas** sur Terrarium : une tuile
 * Terrarium au milieu de tuiles fines fait une plaque lisse, decalee de
 * quelques metres, aux bords droits. L'appelant reprend la tuile, ou se rabat
 * sur sa parente. Une tuile toute hors du service — la mer au-dela des eaux
 * territoriales —, elle, prend Terrarium la ou il existe.
 */
export async function fetchHeightTile(source: number, z: number, x: number, y: number, signal: AbortSignal): Promise<Fetched> {
  let tile = await SOURCES[source].fetch(z, x, y, signal)
  if (tile === null && source !== TERRARIUM && z <= TERRARIUM_MAX_LEVEL) tile = await terrariumTile(z, x, y, signal)
  if (tile && tile !== 'failed') tile.source = source
  return tile
}
