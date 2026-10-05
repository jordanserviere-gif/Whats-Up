/**
 * Imagerie satellite et aerienne du sol — tuiles composees, partout sur Terre.
 *
 * ## Les sources
 *
 * Comme pour le relief, chaque territoire prend son service le plus fin, et une
 * imagerie mondiale couvre le reste :
 *
 * | Territoire | Service                                   | Finesse | Licence          |
 * |------------|-------------------------------------------|---------|------------------|
 * | France     | IGN, BD ORTHO (Geoplateforme, WMTS)       | 20 cm   | Licence Ouverte  |
 * | Espagne    | IGN, PNOA (WMTS)                          | 25 cm   | CC BY 4.0        |
 * | Etats-Unis | USGS, NAIP (The National Map)             | 60 cm   | domaine public   |
 * | Ailleurs   | EOX, Sentinel-2 cloudless 2016            | 10 m    | CC BY 4.0        |
 *
 * Toutes sont en pseudo-Mercator (`z/x/y` de la grille du web) : une tuile du
 * niveau `z` est la meme case quel que soit le service.
 *
 * ⚠️ Sentinel-2 cloudless existe en millesimes plus recents, plus beaux, mais
 * sous licence non commerciale : 2016 est le dernier en CC BY.
 *
 * ## Les frontieres
 *
 * Hors de son pays, l'IGN remplit la tuile de blanc, et le PNOA y met une
 * imagerie mondiale grossiere. Une tuile qu'une frontiere traverse est donc
 * **composee** : Sentinel-2 en fond, le service national par-dessus, masque au
 * pixel par les frontieres d'OpenStreetMap. Les autres — presque toutes — sont
 * prises telles quelles : le masque ne se calcule que la ou il sert.
 *
 * Ce module tourne dans le fil principal comme dans les workers du mode photo.
 */
import type { TerritoryId } from '../photo/photoCoverage'

/** Cote d'une tuile, pixels. */
export const IMAGERY_TILE_SIZE = 256

interface ImagerySource {
  name: string
  /** `null` : partout — le fond. */
  territory: TerritoryId | null
  /** Niveau le plus fin servi ; au-dela, la tuile de ce niveau est agrandie. */
  maxZoom: number
  url: (z: number, x: number, y: number) => string
}

const SOURCES: ImagerySource[] = [
  {
    name: 'IGN BD ORTHO',
    territory: 'france',
    maxZoom: 19,
    url: (z, x, y) =>
      `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=HR.ORTHOIMAGERY.ORTHOPHOTOS` +
      `&STYLE=normal&TILEMATRIXSET=PM_6_19&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/jpeg`,
  },
  {
    name: 'IGN PNOA',
    territory: 'spain',
    maxZoom: 19,
    url: (z, x, y) =>
      `https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=OI.OrthoimageCoverage` +
      `&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image/jpeg`,
  },
  {
    name: 'USGS NAIP',
    territory: 'usa',
    maxZoom: 16,
    url: (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`,
  },
  {
    name: 'Sentinel-2 cloudless',
    territory: null,
    maxZoom: 14,
    url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${z}/${y}/${x}.jpg`,
  },
]
const BACKGROUND = SOURCES[SOURCES.length - 1]

/** Niveau le plus fin qu'un point puisse recevoir — pour borner le choix des tuiles. */
export function imageryMaxZoom(territory: TerritoryId | null): number {
  return (SOURCES.find((s) => s.territory === territory) ?? BACKGROUND).maxZoom
}

// --- Le cache ---------------------------------------------------------------------

const CACHE_NAME = 'whats-up-imagery-v1'
let cachePromise: Promise<Cache | null> | null = null
const imageryCache = (): Promise<Cache | null> =>
  (cachePromise ??= typeof caches === 'undefined' ? Promise.resolve(null) : caches.open(CACHE_NAME).catch(() => null))

/** Une image decodee, ou `null` : hors couverture (404, ou reponse d'erreur), ou service muet. */
async function fetchImage(url: string, signal?: AbortSignal): Promise<ImageBitmap | null> {
  const cache = await imageryCache()
  let blob: Blob | null = null
  const hit = cache ? await cache.match(url) : undefined
  if (hit) blob = await hit.blob()
  else {
    for (let attempt = 0; attempt < 2 && !blob; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500))
      const res = await fetch(url, { signal }).catch((err) => {
        if (signal?.aborted) throw err
        return null
      })
      if (!res) continue
      if (res.status === 404) return null
      if (!res.ok) continue
      blob = await res.blob()
      if (cache) void cache.put(url, new Response(blob.slice(0), { headers: { 'content-type': blob.type || 'image/jpeg' } }))
    }
  }
  // ⚠️ Hors couverture, certains services rendent un rapport d'erreur XML de
  // quelques centaines d'octets, en code 200 : on le reconnait a sa taille.
  if (!blob || blob.size < 1024 || !blob.type.startsWith('image')) return null
  try {
    return await createImageBitmap(blob)
  } catch {
    return null
  }
}

// --- Les frontieres -----------------------------------------------------------------

type Coverage = typeof import('../photo/photoCoverage')
let coverage: Promise<Coverage> | null = null
/** Les frontieres, chargees a la premiere tuile : elles pesent sept cents kilooctets. */
const loadCoverage = (): Promise<Coverage> => (coverage ??= import('../photo/photoCoverage'))

/** Latitude et longitude d'un pixel de la grille mondiale du niveau `z`. */
export function pixelToLatLon(px: number, py: number, z: number): { lat: number; lon: number } {
  const n = 2 ** z * IMAGERY_TILE_SIZE
  const lon = (px / n) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * 180) / Math.PI
  return { lat, lon }
}

/** Pixel de la grille mondiale du niveau `z`, fractionnaire. */
export function latLonToPixel(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z * IMAGERY_TILE_SIZE
  const s = Math.sin((lat * Math.PI) / 180)
  return { x: ((lon + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n }
}

/**
 * Territoires touches par une tuile. Les cases de couverture d'un kilometre —
 * onze la ou aucune frontiere ne passe — disent sans calcul qu'une tuile est
 * d'un seul tenant ; seules les tuiles frontalieres en touchent plusieurs.
 */
function territoriesOf(cov: Coverage, z: number, x: number, y: number): Set<TerritoryId | null> {
  const out = new Set<TerritoryId | null>()
  const steps = 4
  for (let j = 0; j <= steps; j++) {
    for (let i = 0; i <= steps; i++) {
      const { lat, lon } = pixelToLatLon((x + i / steps) * IMAGERY_TILE_SIZE, (y + j / steps) * IMAGERY_TILE_SIZE, z)
      for (const t of cov.cellAt(lat, lon).present) out.add(t)
    }
  }
  return out
}

// --- La tuile composee --------------------------------------------------------------

/** Pixels d'une tuile composee, RGBA, rangee 0 au nord. */
export type ImageryTile = Uint8ClampedArray

let scratch: OffscreenCanvas | null = null
function canvas2d(): OffscreenCanvasRenderingContext2D {
  scratch ??= new OffscreenCanvas(IMAGERY_TILE_SIZE, IMAGERY_TILE_SIZE)
  return scratch.getContext('2d', { willReadFrequently: true })!
}

/** Tuile d'une source au niveau `z`, prise au niveau le plus fin servi et agrandie si besoin. */
async function sourceTile(source: ImagerySource, z: number, x: number, y: number, signal?: AbortSignal): Promise<ImageData | null> {
  const zs = Math.min(z, source.maxZoom)
  const k = 2 ** (z - zs)
  const bitmap = await fetchImage(source.url(zs, Math.floor(x / k), Math.floor(y / k)), signal)
  if (!bitmap) return null
  const ctx = canvas2d()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  const size = IMAGERY_TILE_SIZE / k
  ctx.drawImage(bitmap, (x % k) * size, (y % k) * size, size, size, 0, 0, IMAGERY_TILE_SIZE, IMAGERY_TILE_SIZE)
  bitmap.close()
  return ctx.getImageData(0, 0, IMAGERY_TILE_SIZE, IMAGERY_TILE_SIZE)
}

/**
 * La tuile `z/x/y`, composee : service national ou fond mondial, masques par
 * les frontieres la ou l'un s'arrete et l'autre prend le relais. `null` si
 * aucun service n'a rien rendu.
 */
export async function imageryTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<ImageryTile | null> {
  const cov = await loadCoverage()
  const present = territoriesOf(cov, z, x, y)
  const national = SOURCES.filter((s) => s.territory && present.has(s.territory))
  // D'un seul tenant : une seule tuile, sans masque.
  if (present.size === 1) {
    const only = national[0] ?? BACKGROUND
    const img = (await sourceTile(only, z, x, y, signal)) ?? (only !== BACKGROUND ? await sourceTile(BACKGROUND, z, x, y, signal) : null)
    return img?.data ?? null
  }
  // Frontaliere : le fond, puis chaque service national sur son seul territoire.
  const base = await sourceTile(BACKGROUND, z, x, y, signal)
  const out = base ? new Uint8ClampedArray(base.data) : new Uint8ClampedArray(IMAGERY_TILE_SIZE * IMAGERY_TILE_SIZE * 4)
  let any = !!base
  for (const source of national) {
    const img = await sourceTile(source, z, x, y, signal)
    if (!img) continue
    any = true
    for (let j = 0; j < IMAGERY_TILE_SIZE; j++) {
      for (let i = 0; i < IMAGERY_TILE_SIZE; i++) {
        const { lat, lon } = pixelToLatLon(x * IMAGERY_TILE_SIZE + i + 0.5, y * IMAGERY_TILE_SIZE + j + 0.5, z)
        const cell = cov.cellAt(lat, lon)
        const mine = cell.present.length === 1 ? cell.label === source.territory : cov.inTerritory(source.territory!, lat, lon)
        if (!mine) continue
        const o = (j * IMAGERY_TILE_SIZE + i) * 4
        out[o] = img.data[o]
        out[o + 1] = img.data[o + 1]
        out[o + 2] = img.data[o + 2]
        out[o + 3] = 255
      }
    }
  }
  return any ? out : null
}
