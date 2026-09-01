import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchBinary } from '@/data-sources/fetchJson'
import { decodeTile } from '@/scene/terrain/elevationSource'
import { TILE_SIZE, lonLatToTile, tileGroundResolutionM, tileToLonLat } from '@/scene/terrain/geodesy'
import { TERRARIUM_ATTRIBUTION, TERRARIUM_MAX_ZOOM, terrariumUrl } from '@/scene/terrain/terrarium'
import './LocationMap.css'

/**
 * Carte de selection du lieu.
 *
 * ## Pourquoi elle ne charge aucune image de carte
 *
 * Un fond de carte classique demanderait une source de plus, ses conditions
 * d'usage et sa cle. Or le moteur telecharge deja, pour le relief, un modele
 * numerique de terrain **mondial**. Cette carte est dessinee a partir de ces
 * memes tuiles : la mer par le signe de l'altitude, le relief par un ombrage.
 *
 * L'avantage n'est pas seulement d'economiser une dependance. La carte montre
 * **exactement ce que le moteur sait du terrain** — sa resolution, ses defauts,
 * ses trous. Cliquer sur une crete visible ici, c'est cliquer sur la crete qui
 * sera rendue.
 *
 * ## L'ombrage est cartographique, et l'assume
 *
 * L'eclairement vient du nord-ouest a quarante-cinq degres. Ce n'est pas une
 * position solaire, c'est la **convention des cartes topographiques** depuis le
 * dix-neuvieme siecle : elle place les ombres la ou l'oeil les attend et evite
 * l'illusion de relief inverse.
 *
 * C'est une image d'interface, pas une image du ciel. Aucune de ces couleurs ne
 * touche au rendu de la scene, et rien ici ne remonte dans le moteur.
 */

/** Cote de la carte, pixels. */
const MAP_W = 320
const MAP_H = 220

/** Zoom minimal : le monde entier tient dans la fenetre. */
const MIN_ZOOM = 1
/** Au-dela, on telechargerait de l'interpolation — voir `terrarium`. */
const MAX_ZOOM = TERRARIUM_MAX_ZOOM

/** Un mois, comme le relief : la topographie ne bouge pas. */
const TILE_TTL_MS = 30 * 24 * 3600 * 1000

/** Tuiles decodees, gardees en memoire le temps de la session. */
const tileCache = new Map<string, Int16Array | null>()
const pending = new Map<string, Promise<Int16Array | null>>()

function loadTile(zoom: number, x: number, y: number): Promise<Int16Array | null> {
  const key = `${zoom}/${x}/${y}`
  const cached = tileCache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)
  const inflight = pending.get(key)
  if (inflight) return inflight

  const promise = (async () => {
    try {
      const raw = await fetchBinary(
        terrariumUrl(zoom, x, y),
        { key: `terrarium:${key}`, ttlMs: TILE_TTL_MS, timeoutMs: 12_000, attempts: 2 },
        (buffer) => buffer,
      )
      const decoded = raw ? await decodeTile(raw.value) : null
      tileCache.set(key, decoded)
      return decoded
    } catch {
      tileCache.set(key, null)
      return null
    } finally {
      pending.delete(key)
    }
  })()
  pending.set(key, promise)
  return promise
}

/**
 * Rampe hypsometrique et ombrage.
 *
 * `slopeScale` convertit la difference d'altitude entre deux pixels voisins en
 * pente : sans lui, la meme montagne paraitrait plate au zoom large et
 * verticale au zoom serre, puisque le pixel ne couvre pas la meme distance.
 */
function paint(
  heights: Int16Array,
  width: number,
  height: number,
  metresPerPixel: number,
): ImageData {
  const image = new ImageData(width, height)
  const data = image.data
  // Lumiere du nord-ouest, quarante-cinq degres — la convention des cartes.
  const lx = -Math.SQRT1_2 * Math.SQRT1_2
  const ly = Math.SQRT1_2 * Math.SQRT1_2
  const lz = Math.SQRT1_2

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const h = heights[i]
      const j = i * 4
      data[j + 3] = 255

      if (h < 0) {
        // La mer, par la profondeur. Le signe suffit a la distinguer : c'est
        // pour cela que le decodage garde la bathymetrie.
        const deep = Math.min(1, -h / 5000)
        data[j] = 14 + 22 * (1 - deep)
        data[j + 1] = 42 + 52 * (1 - deep)
        data[j + 2] = 78 + 66 * (1 - deep)
        continue
      }

      // Pente locale, en vraies unites : difference d'altitude sur la distance
      // que couvre reellement un pixel.
      const xl = heights[y * width + Math.max(0, x - 1)]
      const xr = heights[y * width + Math.min(width - 1, x + 1)]
      const yu = heights[Math.max(0, y - 1) * width + x]
      const yd = heights[Math.min(height - 1, y + 1) * width + x]
      const nx = (xl - xr) / (2 * metresPerPixel)
      const ny = (yd - yu) / (2 * metresPerPixel)
      const norm = Math.sqrt(nx * nx + ny * ny + 1)
      const shade = Math.max(0.25, (nx * lx + ny * ly + lz) / norm)

      // Rampe : vert des plaines, ocre des moyennes altitudes, gris puis blanc.
      const t = Math.min(1, h / 4000)
      let r: number
      let g: number
      let b: number
      if (t < 0.35) {
        const u = t / 0.35
        r = 96 + 92 * u
        g = 124 + 46 * u
        b = 84 + 24 * u
      } else if (t < 0.7) {
        const u = (t - 0.35) / 0.35
        r = 188 + 20 * u
        g = 170 + 12 * u
        b = 108 + 40 * u
      } else {
        const u = (t - 0.7) / 0.3
        r = 208 + 47 * u
        g = 182 + 73 * u
        b = 148 + 107 * u
      }
      data[j] = Math.round(r * shade)
      data[j + 1] = Math.round(g * shade)
      data[j + 2] = Math.round(b * shade)
    }
  }
  return image
}

export interface LocationMapProps {
  latitudeDeg: number
  longitudeDeg: number
  onPick: (latitudeDeg: number, longitudeDeg: number) => void
}

export function LocationMap({ latitudeDeg, longitudeDeg, onPick }: LocationMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [zoom, setZoom] = useState(5)
  const [centre, setCentre] = useState({ lat: latitudeDeg, lon: longitudeDeg })
  const [loading, setLoading] = useState(false)

  // Le lieu change ailleurs — saisie manuelle, geolocalisation, prereglage — et
  // la carte doit suivre plutot que de rester ou elle etait.
  useEffect(() => {
    setCentre({ lat: latitudeDeg, lon: longitudeDeg })
  }, [latitudeDeg, longitudeDeg])

  const draw = useCallback(async () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const centreTile = lonLatToTile(centre.lon, centre.lat, zoom)
    const originX = centreTile.x * TILE_SIZE - MAP_W / 2
    const originY = centreTile.y * TILE_SIZE - MAP_H / 2
    const worldPx = TILE_SIZE * 2 ** zoom

    // Quelles tuiles couvrent la fenetre.
    const needed: Array<{ x: number; y: number }> = []
    for (let ty = Math.floor(originY / TILE_SIZE); ty <= Math.floor((originY + MAP_H) / TILE_SIZE); ty++) {
      if (ty < 0 || ty >= 2 ** zoom) continue
      for (let tx = Math.floor(originX / TILE_SIZE); tx <= Math.floor((originX + MAP_W) / TILE_SIZE); tx++) {
        needed.push({ x: ((tx % 2 ** zoom) + 2 ** zoom) % 2 ** zoom, y: ty })
      }
    }

    setLoading(true)
    const loaded = await Promise.all(needed.map((t) => loadTile(zoom, t.x, t.y)))
    setLoading(false)
    const tiles = new Map<string, Int16Array | null>()
    needed.forEach((t, i) => tiles.set(`${t.x}/${t.y}`, loaded[i]))

    // Rassemblement : pour chaque pixel de la carte, l'altitude de la tuile qui
    // le contient. Le meme sens que le remplissage de la pyramide, et pour la
    // meme raison — disperser laisserait des trous.
    const heights = new Int16Array(MAP_W * MAP_H)
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        let gx = Math.round(originX + x)
        const gy = Math.round(originY + y)
        gx = ((gx % worldPx) + worldPx) % worldPx
        if (gy < 0 || gy >= worldPx) continue
        const tx = Math.floor(gx / TILE_SIZE)
        const ty = Math.floor(gy / TILE_SIZE)
        const tile = tiles.get(`${tx}/${ty}`)
        if (!tile) continue
        heights[y * MAP_W + x] = tile[(gy - ty * TILE_SIZE) * TILE_SIZE + (gx - tx * TILE_SIZE)]
      }
    }

    context.putImageData(paint(heights, MAP_W, MAP_H, tileGroundResolutionM(centre.lat, zoom)), 0, 0)

    // Le lieu courant, s'il tombe dans la fenetre.
    const here = lonLatToTile(longitudeDeg, latitudeDeg, zoom)
    const hx = here.x * TILE_SIZE - originX
    const hy = here.y * TILE_SIZE - originY
    if (hx >= 0 && hx < MAP_W && hy >= 0 && hy < MAP_H) {
      context.strokeStyle = '#ff4d4d'
      context.lineWidth = 2
      context.beginPath()
      context.arc(hx, hy, 6, 0, Math.PI * 2)
      context.stroke()
      context.beginPath()
      context.moveTo(hx - 10, hy)
      context.lineTo(hx + 10, hy)
      context.moveTo(hx, hy - 10)
      context.lineTo(hx, hy + 10)
      context.stroke()
    }
  }, [centre, zoom, latitudeDeg, longitudeDeg])

  useEffect(() => {
    void draw()
  }, [draw])

  const pickAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * MAP_W
    const y = ((event.clientY - rect.top) / rect.height) * MAP_H
    const centreTile = lonLatToTile(centre.lon, centre.lat, zoom)
    const gx = centreTile.x * TILE_SIZE - MAP_W / 2 + x
    const gy = centreTile.y * TILE_SIZE - MAP_H / 2 + y
    const picked = tileToLonLat(gx / TILE_SIZE, gy / TILE_SIZE, zoom)
    onPick(picked.latitudeDeg, picked.longitudeDeg)
  }

  return (
    <div className="location-map">
      <canvas
        ref={canvasRef}
        width={MAP_W}
        height={MAP_H}
        onClick={pickAt}
        aria-label="Carte du relief — cliquer pour choisir le lieu d’observation"
      />
      <div className="location-map__zoom">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 1))}
          disabled={zoom <= MIN_ZOOM}
          aria-label="Dézoomer"
        >
          −
        </button>
        <span>{loading ? '…' : `z${zoom}`}</span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 1))}
          disabled={zoom >= MAX_ZOOM}
          aria-label="Zoomer"
        >
          +
        </button>
      </div>
      <p className="md-type-body-small location-map__hint">
        {TERRARIUM_ATTRIBUTION}. Un pixel couvre{' '}
        {tileGroundResolutionM(centre.lat, zoom) < 1000
          ? `${Math.round(tileGroundResolutionM(centre.lat, zoom))} m`
          : `${(tileGroundResolutionM(centre.lat, zoom) / 1000).toFixed(1)} km`}
        .
      </p>
    </div>
  )
}
