/**
 * Mode photo — le relief le plus fin que l'on sache obtenir, la ou le cadre le
 * demande.
 *
 * ## La source : le MNT LiDAR HD de l'IGN, par WMS
 *
 * Le relief courant passe par des **tuiles** : Terrarium a trente metres dans le
 * monde, le RGE ALTI a trois metres et demi en France. Une tuile a une emprise
 * et un pas imposes ; une photo veut l'inverse — une emprise exacte, le secteur
 * du cadre, a un pas choisi par tranche de distance.
 *
 * Le service WMS de la Geoplateforme le permet : `GetMap` rend un raster
 * d'altitudes en flottants (BIL 32 bits) pour **n'importe quelle** emprise et
 * **n'importe quelle** definition. La couche `MIXED` du LiDAR HD descend a
 * cinquante centimetres et retombe d'elle-meme sur le RGE ALTI la ou le LiDAR
 * n'est pas encore leve. Mesure : 512 × 512 points au sommet du Ventoux,
 * 1 797 a 1 909 m ; CORS ouvert ; une requete de 2 048 × 2 048 en huit
 * secondes.
 *
 * Hors de France, le service repond −9999 partout. Ce n'est pas une erreur : la
 * photo garde alors le relief courant, sur un maillage et des ombres plus fins.
 *
 * ## Le reechantillonnage, une fois
 *
 * Le raster est en degres ; tout le reste du mode photo travaille dans le plan
 * local. On convertit donc **une fois**, sur une grille locale au meme pas, avec
 * la meme astuce que la pyramide : la conversion geodesique exacte sur un
 * treillis, interpolee entre ses noeuds.
 */
import { enuToGeodetic } from '../terrain/geodesy'
import type { EnuGrid, PhotoBand } from './photoPlan'

const WMS = 'https://data.geopf.fr/wms-r'
const LAYER = 'IGNF_LIDAR-HD_MNT_ELEVATION.MIXED.WGS84G'

/** Cote maximal d'une requete, points : au-dela, le service ralentit sans gain. */
const CHUNK_PX = 2048
/** Requetes simultanees. */
const CONCURRENCY = 4
/** Valeur sous laquelle le service signifie « pas de donnee ». */
const NODATA_BELOW = -1000
/** Metres par degre de latitude — assez juste pour dimensionner un raster. */
const M_PER_DEG = 111_320
/** Cote du treillis geodesique exact. */
const LATTICE = 33

/** Emprise metropolitaine et corse, avec une marge : en dehors, inutile d'interroger. */
const FRANCE = { latMin: 41.2, latMax: 51.3, lonMin: -5.6, lonMax: 9.8 }

interface LatLonBox {
  latMin: number
  latMax: number
  lonMin: number
  lonMax: number
}

/** Emprise geographique d'un rectangle du plan local. */
function boxToLatLon(lat0: number, lon0: number, band: PhotoBand): LatLonBox {
  const { eastMin, eastMax, northMin, northMax } = band.box
  const out: LatLonBox = { latMin: 90, latMax: -90, lonMin: 180, lonMax: -180 }
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      if (i > 0 && i < 4 && j > 0 && j < 4) continue
      const g = enuToGeodetic(lat0, lon0, eastMin + ((eastMax - eastMin) * i) / 4, northMin + ((northMax - northMin) * j) / 4)
      out.latMin = Math.min(out.latMin, g.latitudeDeg)
      out.latMax = Math.max(out.latMax, g.latitudeDeg)
      out.lonMin = Math.min(out.lonMin, g.longitudeDeg)
      out.lonMax = Math.max(out.lonMax, g.longitudeDeg)
    }
  }
  return out
}

const intersectsFrance = (b: LatLonBox): boolean =>
  b.latMax > FRANCE.latMin && b.latMin < FRANCE.latMax && b.lonMax > FRANCE.lonMin && b.lonMin < FRANCE.lonMax

/** Un raster geographique : rangee 0 au nord. */
interface Raster {
  box: LatLonBox
  width: number
  height: number
  data: Float32Array
}

/** File d'attente bornee : au plus `CONCURRENCY` requetes en vol. */
async function runLimited<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

async function fetchChunk(box: LatLonBox, width: number, height: number, signal: AbortSignal): Promise<Float32Array | null> {
  // WMS 1.3.0 en EPSG:4326 : l'ordre des axes est latitude puis longitude.
  const url =
    `${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=&FORMAT=image/x-bil;bits=32` +
    `&LAYERS=${LAYER}&CRS=EPSG:4326` +
    `&BBOX=${box.latMin},${box.lonMin},${box.latMax},${box.lonMax}&WIDTH=${width}&HEIGHT=${height}`
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength !== width * height * 4) return null
    // Petit-boutiste, comme toutes les machines qui feront tourner ceci.
    return new Float32Array(buf)
  } catch (err) {
    if (signal.aborted) throw err
    return null
  }
}

/**
 * Raster d'une tranche, assemble depuis des requetes d'au plus 2 048 de cote.
 *
 * `null` quand la tranche sort de France ou que le service ne rend rien.
 */
export async function fetchBandRaster(
  lat0: number,
  lon0: number,
  band: PhotoBand,
  signal: AbortSignal,
  onChunk: () => void,
): Promise<{ raster: Raster | null; chunks: number }> {
  const box = boxToLatLon(lat0, lon0, band)
  if (!intersectsFrance(box)) return { raster: null, chunks: 0 }
  const latMid = (box.latMin + box.latMax) / 2
  const dLat = band.stepM / M_PER_DEG
  const dLon = band.stepM / (M_PER_DEG * Math.cos((latMid * Math.PI) / 180))
  const width = Math.max(2, Math.ceil((box.lonMax - box.lonMin) / dLon))
  const height = Math.max(2, Math.ceil((box.latMax - box.latMin) / dLat))
  const data = new Float32Array(width * height).fill(Number.NaN)
  const cols = Math.ceil(width / CHUNK_PX)
  const rows = Math.ceil(height / CHUNK_PX)
  const tasks: Array<() => Promise<void>> = []
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * CHUNK_PX
      const y0 = cy * CHUNK_PX
      const w = Math.min(CHUNK_PX, width - x0)
      const h = Math.min(CHUNK_PX, height - y0)
      // Emprise exacte du morceau : un pixel couvre (Δlon/largeur) × (Δlat/hauteur).
      const chunkBox: LatLonBox = {
        lonMin: box.lonMin + ((box.lonMax - box.lonMin) * x0) / width,
        lonMax: box.lonMin + ((box.lonMax - box.lonMin) * (x0 + w)) / width,
        latMax: box.latMax - ((box.latMax - box.latMin) * y0) / height,
        latMin: box.latMax - ((box.latMax - box.latMin) * (y0 + h)) / height,
      }
      tasks.push(async () => {
        const got = await fetchChunk(chunkBox, w, h, signal)
        onChunk()
        if (!got) return
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const v = got[y * w + x]
            data[(y0 + y) * width + x0 + x] = v < NODATA_BELOW ? Number.NaN : v
          }
        }
      })
    }
  }
  await runLimited(tasks, CONCURRENCY)
  return { raster: { box, width, height, data }, chunks: tasks.length }
}

/** Nombre de requetes qu'une tranche demandera — pour la barre de progression. */
export function bandChunkCount(lat0: number, lon0: number, band: PhotoBand): number {
  const box = boxToLatLon(lat0, lon0, band)
  if (!intersectsFrance(box)) return 0
  const latMid = (box.latMin + box.latMax) / 2
  const width = Math.ceil((box.lonMax - box.lonMin) / (band.stepM / (M_PER_DEG * Math.cos((latMid * Math.PI) / 180))))
  const height = Math.ceil((box.latMax - box.latMin) / (band.stepM / M_PER_DEG))
  return Math.ceil(width / CHUNK_PX) * Math.ceil(height / CHUNK_PX)
}

/**
 * Le raster, porte sur une grille du plan local au pas de la tranche.
 *
 * Rend `null` si moins d'un quart de la grille est connu : hors de France ou
 * sur la mer, la grille ne ferait que masquer le relief courant.
 */
export function rasterToGrid(lat0: number, lon0: number, band: PhotoBand, raster: Raster): EnuGrid | null {
  const { eastMin, eastMax, northMin, northMax } = band.box
  const step = band.stepM
  const nx = Math.max(2, Math.ceil((eastMax - eastMin) / step) + 1)
  const ny = Math.max(2, Math.ceil((northMax - northMin) / step) + 1)
  const heights = new Float32Array(nx * ny)

  // Treillis exact : latitude et longitude aux noeuds, interpolees entre eux.
  const latL = new Float64Array(LATTICE * LATTICE)
  const lonL = new Float64Array(LATTICE * LATTICE)
  for (let j = 0; j < LATTICE; j++) {
    for (let i = 0; i < LATTICE; i++) {
      const g = enuToGeodetic(
        lat0,
        lon0,
        eastMin + ((nx - 1) * step * i) / (LATTICE - 1),
        northMin + ((ny - 1) * step * j) / (LATTICE - 1),
      )
      latL[j * LATTICE + i] = g.latitudeDeg
      lonL[j * LATTICE + i] = g.longitudeDeg
    }
  }
  const { box, width, height, data } = raster
  const sx = width / (box.lonMax - box.lonMin)
  const sy = height / (box.latMax - box.latMin)
  let known = 0
  for (let iy = 0; iy < ny; iy++) {
    const lj = (iy / (ny - 1)) * (LATTICE - 1)
    const j0 = Math.min(LATTICE - 2, Math.floor(lj))
    const tj = lj - j0
    for (let ix = 0; ix < nx; ix++) {
      const li = (ix / (nx - 1)) * (LATTICE - 1)
      const i0 = Math.min(LATTICE - 2, Math.floor(li))
      const ti = li - i0
      const k = j0 * LATTICE + i0
      const lat =
        (latL[k] * (1 - ti) + latL[k + 1] * ti) * (1 - tj) + (latL[k + LATTICE] * (1 - ti) + latL[k + LATTICE + 1] * ti) * tj
      const lon =
        (lonL[k] * (1 - ti) + lonL[k + 1] * ti) * (1 - tj) + (lonL[k + LATTICE] * (1 - ti) + lonL[k + LATTICE + 1] * ti) * tj
      // Centre des pixels a +0,5 : le point (lon, lat) tombe en (fx, fy).
      const fx = (lon - box.lonMin) * sx - 0.5
      const fy = (box.latMax - lat) * sy - 0.5
      let h = Number.NaN
      if (fx >= 0 && fy >= 0 && fx <= width - 1 && fy <= height - 1) {
        const x = Math.min(width - 2, Math.floor(fx))
        const y = Math.min(height - 2, Math.floor(fy))
        const tx = fx - x
        const ty = fy - y
        const q = y * width + x
        h = (data[q] * (1 - tx) + data[q + 1] * tx) * (1 - ty) + (data[q + width] * (1 - tx) + data[q + width + 1] * tx) * ty
      }
      heights[iy * nx + ix] = h
      if (!Number.isNaN(h)) known++
    }
  }
  if (known < 0.25 * nx * ny) return null
  return { eastMin, northMin, stepM: step, nx, ny, heights }
}
