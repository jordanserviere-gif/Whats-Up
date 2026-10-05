/**
 * Mode photo — l'imagerie du sol, au pas du pixel.
 *
 * La vue en direct drape un atlas de quatre etages : 3,6 m par pixel au pied de
 * l'observateur, 230 m a l'horizon. La photo, elle, choisit l'imagerie **pixel
 * par pixel**, comme le relief : la tuile dont le pixel vaut l'empreinte au sol
 * du pixel de l'image — jusqu'a trente centimetres en France et en Espagne, un
 * metre aux Etats-Unis, dix metres ailleurs.
 *
 * ## L'empreinte
 *
 * En travers de la visee, un pixel couvre `distance × angle` ; le long de la
 * visee, sous un regard rasant, bien davantage — l'ecart de distance entre deux
 * lignes voisines. Prendre la seule empreinte en travers ferait scintiller le
 * sol en moire ; prendre la seule empreinte le long le rendrait flou. On prend
 * leur moyenne geometrique, comme le ferait un filtrage anisotrope modere, et
 * les quatre passes de l'anticrenelage font le reste.
 *
 * ## Le de-eclairage
 *
 * Le meme que celui de l'atlas — voir `orthophoto.ts` : la couleur rapportee a
 * la luminance de la meme imagerie seize fois plus grossiere, quatre niveaux de
 * tuile au-dessus. Le detail vaut un en moyenne ; l'eclairage de la prise de
 * vue part avec le flou.
 */
import { cellAt } from './photoCoverage'
import { colDa, cellAngle, fromHalf, toHalf, type PhotoFrame } from './photoRaster'
import { LocalProjector } from './photoTiles'
import { IMAGERY_TILE_SIZE, imageryMaxZoom, imageryTile, latLonToPixel } from '../terrain/imagery'

/** Metres par pixel au zoom zero, a l'equateur. */
const M_PER_PX_Z0 = 40_075_016.686 / IMAGERY_TILE_SIZE
/** Niveaux de tuile entre l'image et sa version floutee : seize fois plus grossiere. */
const BROAD_LEVELS = 4
/** Niveau le plus grossier demande. */
const MIN_ZOOM = 4
/** Plafond de tuiles d'une photo : 900 × 256 ko, 230 Mo dans ce seul worker. */
const MAX_TILES = 900

/** sRGB 8 bits → lineaire, comme le fait le GPU pour l'atlas. */
const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

const key = (z: number, x: number, y: number) => `${z}/${x}/${y}`

export interface ImageryContext {
  projector: LocalProjector
  tiles: Map<string, Uint8ClampedArray | null>
}

/** Un pixel de l'image : ou il tombe au sol, et a quel niveau de tuile le lire. */
interface Ground {
  lat: number
  lon: number
  zf: number
}

/**
 * Pour chaque pixel de relief d'une passe : latitude, longitude, niveau voulu.
 * `g` est le tampon de la passe — distance en kilometres plus le reste en
 * metres, voir le worker. `coarsen` eloigne tout d'un meme facteur, quand le
 * plafond de tuiles l'exige.
 */
function groundOf(g: Uint16Array, frame: PhotoFrame, projector: LocalProjector, coarsen: number): Array<Ground | null> {
  const { cols, rows } = frame
  const range = new Float32Array(cols * rows)
  for (let i = 0; i < range.length; i++) {
    const km = g[i * 8]
    range[i] = km === 0 ? 0 : fromHalf(km) * 1000 + fromHalf(g[i * 8 + 5])
  }
  const out: Array<Ground | null> = new Array(cols * rows).fill(null)
  const ll = { lat: 0, lon: 0 }
  for (let c = 0; c < cols; c++) {
    const da = colDa(frame, c)
    const az = frame.az0 + da
    const sa = Math.sin(az)
    const ca = Math.cos(az)
    const across = cellAngle(frame, da)
    for (let r = 0; r < rows; r++) {
      const k = r * cols + c
      const d = range[k]
      if (!(d > 0)) continue
      projector.toLatLon(d * sa, d * ca, ll)
      const up = r + 1 < rows ? range[k + cols] : 0
      const down = r > 0 ? range[k - cols] : 0
      const along = Math.max(up > 0 ? Math.abs(up - d) : 0, down > 0 ? Math.abs(d - down) : 0)
      const a = d * across
      const footprint = Math.sqrt(a * Math.max(a, along)) * coarsen
      const maxZ = imageryMaxZoom(cellAt(ll.lat, ll.lon).label)
      const zf = Math.max(MIN_ZOOM, Math.min(maxZ, Math.log2((M_PER_PX_Z0 * Math.cos((ll.lat * Math.PI) / 180)) / Math.max(0.01, footprint))))
      out[k] = { lat: ll.lat, lon: ll.lon, zf }
    }
  }
  return out
}

/** Tuiles qu'un pixel lit : les deux niveaux fins qui l'encadrent, et le niveau flou. */
function tilesOf(p: Ground, into: Set<string>): void {
  const z0 = Math.floor(p.zf)
  for (const z of [z0, Math.min(z0 + 1, Math.ceil(p.zf)), Math.max(MIN_ZOOM - BROAD_LEVELS, z0 - BROAD_LEVELS)]) {
    const px = latLonToPixel(p.lat, p.lon, z)
    into.add(key(z, Math.floor(px.x / IMAGERY_TILE_SIZE), Math.floor(px.y / IMAGERY_TILE_SIZE)))
  }
}

/** Couleur lineaire au point, bilineaire dans la tuile — `null` si la tuile manque. */
function sample(ctx: ImageryContext, lat: number, lon: number, z: number, out: Float32Array): boolean {
  const px = latLonToPixel(lat, lon, z)
  const tx = Math.floor(px.x / IMAGERY_TILE_SIZE)
  const ty = Math.floor(px.y / IMAGERY_TILE_SIZE)
  const tile = ctx.tiles.get(key(z, tx, ty))
  if (!tile) return false
  const fx = Math.min(IMAGERY_TILE_SIZE - 1.001, Math.max(0, px.x - tx * IMAGERY_TILE_SIZE - 0.5))
  const fy = Math.min(IMAGERY_TILE_SIZE - 1.001, Math.max(0, px.y - ty * IMAGERY_TILE_SIZE - 0.5))
  const ix = Math.floor(fx)
  const iy = Math.floor(fy)
  const u = fx - ix
  const v = fy - iy
  const o00 = (iy * IMAGERY_TILE_SIZE + ix) * 4
  const o10 = o00 + 4
  const o01 = o00 + IMAGERY_TILE_SIZE * 4
  const o11 = o01 + 4
  for (let c = 0; c < 3; c++) {
    out[c] =
      (SRGB_TO_LINEAR[tile[o00 + c]] * (1 - u) + SRGB_TO_LINEAR[tile[o10 + c]] * u) * (1 - v) +
      (SRGB_TO_LINEAR[tile[o01 + c]] * (1 - u) + SRGB_TO_LINEAR[tile[o11 + c]] * u) * v
  }
  return true
}

const luminance = (c: Float32Array) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

/**
 * L'imagerie d'une passe : pour chaque pixel, la teinte de-eclairee du sol, en
 * demi-flottants RGBA. Un sans imagerie — le ciel, ou une tuile introuvable :
 * le sol garde alors l'albedo du modele.
 */
export async function passImagery(
  ctx: ImageryContext,
  g: Uint16Array,
  frame: PhotoFrame,
  signal: AbortSignal,
  onProgress: (fraction: number, tiles: number) => void,
): Promise<Uint16Array> {
  // Les tuiles a charger, borne au plafond : au-dela, tout s'eloigne d'un
  // meme facteur, par paliers de racine de deux.
  let ground: Array<Ground | null> = []
  let wanted = new Set<string>()
  for (let coarsen = 1; coarsen <= 16; coarsen *= Math.SQRT2) {
    ground = groundOf(g, frame, ctx.projector, coarsen)
    wanted = new Set<string>()
    for (const p of ground) if (p) tilesOf(p, wanted)
    if (wanted.size <= MAX_TILES) break
  }
  const missing = [...wanted].filter((k) => !ctx.tiles.has(k))
  let done = 0
  let next = 0
  const run = async () => {
    while (next < missing.length && !signal.aborted) {
      const k = missing[next++]
      const [z, x, y] = k.split('/').map(Number)
      ctx.tiles.set(k, await imageryTile(z, x, y, signal).catch(() => null))
      onProgress(++done / Math.max(1, missing.length), missing.length)
    }
  }
  await Promise.all(Array.from({ length: 8 }, run))

  const out = new Uint16Array(ground.length * 4)
  const one = toHalf(1)
  const fine0 = new Float32Array(3)
  const fine1 = new Float32Array(3)
  const broad = new Float32Array(3)
  for (let k = 0; k < ground.length; k++) {
    const o = k * 4
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = one
    const p = ground[k]
    if (!p) continue
    const z0 = Math.floor(p.zf)
    const t = p.zf - z0
    if (!sample(ctx, p.lat, p.lon, z0, fine0)) continue
    if (t > 0 && sample(ctx, p.lat, p.lon, z0 + 1, fine1)) for (let c = 0; c < 3; c++) fine0[c] += (fine1[c] - fine0[c]) * t
    if (!sample(ctx, p.lat, p.lon, Math.max(MIN_ZOOM - BROAD_LEVELS, z0 - BROAD_LEVELS), broad)) continue
    const l = luminance(fine0)
    const lb = luminance(broad)
    if (l < 1e-4 || lb < 1e-4) continue
    // teinte × detail = couleur / luminance floutee, le detail borne comme dans
    // le nuanceur de l'atlas.
    const detail = Math.min(2.5, Math.max(0.3, l / lb))
    for (let c = 0; c < 3; c++) out[o + c] = toHalf((fine0[c] / l) * detail)
  }
  return out
}
