/**
 * Mode photo — ce qu'il faut charger, et comment le mailler.
 *
 * ## Le probleme
 *
 * Le relief courant est calibre pour **l'ecran en mouvement** : une pyramide
 * d'altitudes a deux pixels par cellule a cinquante degres de champ, un maillage
 * de deux cent mille sommets sur tout le tour d'horizon, une carte d'ombre a
 * deux cent trente-quatre metres. C'est le bon compromis pour tenir la cadence,
 * et c'est trop grossier pour une image qu'on garde.
 *
 * Une photo n'a pas de cadence a tenir. Elle a un **cadrage** : un champ, une
 * definition, une direction. Tout ce qui sort du cadre est inutile, et tout ce
 * qui est dedans peut etre aussi fin que ce que le pixel resout.
 *
 * ## La regle : la donnee suit le pixel
 *
 * Un pixel couvre au sol `distance × angle d'un pixel`. A trois mille deux cents
 * pixels sur soixante degres, c'est **33 cm a un kilometre** et **130 m a quatre
 * cents**. Charger du 50 cm a quatre cents kilometres serait absurde ; charger
 * du 30 m a un kilometre gacherait la photo. La portee est donc decoupee en
 * **tranches de distance** d'un facteur deux, et chaque tranche est chargee au
 * pas que son bord proche implique — borne par la source (50 cm pour le LiDAR
 * HD) et par un plafond d'echantillons par tranche.
 *
 * ## ⚠️ Le plafond, et ce qu'il coute
 *
 * Une tranche d'un facteur deux en distance contient toujours a peu pres le
 * meme nombre d'echantillons au pas du pixel — environ `tan(champ/2)·3/angle²`,
 * seize millions a 3 200 pixels. C'est trop : le plafond tombe a trois millions
 * par tranche, et le pas effectif vaut alors **environ deux pixels** au sol, en
 * travers de la visee.
 *
 * Le compromis est moins couteux qu'il n'y parait : en visee rasante, un pixel
 * couvre le sol bien plus loin **le long** de la visee qu'en travers. L'isotropie
 * de la grille surechantillonne donc deja la direction qui compte le moins.
 *
 * ## Ce module est pur
 *
 * Ni DOM, ni three.js : il tourne dans le worker du mode photo, et la
 * validation le controle sans navigateur.
 */
import { CLIPMAP_HALF_SPANS_M } from '../terrain/elevationClipmap'
import { NEAR_M, ringSlabM, slabSamplesFor, terrainDepth } from '../terrain/meshSampling'
import { apparentElevationRad } from '../terrain/ridgeField'

const DEG = Math.PI / 180

/** Ce que voit la photo : le cadrage et sa definition. */
export interface PhotoView {
  /** Azimut du centre de l'image, degres depuis le nord vers l'est. */
  azimuthDeg: number
  /** Hauteur du centre de l'image, degres. */
  altitudeDeg: number
  /** Champ **vertical**, degres. */
  fovDeg: number
  /** Largeur sur hauteur. */
  aspect: number
  /** Definition de la photo, pixels. */
  widthPx: number
  heightPx: number
}

/** Angle d'un pixel de la photo, radians. */
export const photoPixelAngleRad = (view: PhotoView): number => (view.fovDeg * DEG) / Math.max(1, view.heightPx)

/**
 * Demi-ouverture en azimut que le cadre couvre, degres, marge comprise.
 *
 * Le champ horizontal ne suffit pas : en visant vers le bas, le bas de l'image
 * balaie un eventail d'azimuts plus large que son centre — a la limite, en
 * visant ses pieds, il les couvre tous. On elargit donc par la secante de la
 * visee la plus basse du cadre, puis on ajoute quatre pour cent de marge.
 */
export function photoAzimuthHalfSpanDeg(view: PhotoView): number {
  const halfV = (view.fovDeg / 2) * DEG
  const halfH = Math.atan(Math.tan(halfV) * view.aspect)
  const lowest = Math.min(89, Math.abs(view.altitudeDeg) + view.fovDeg / 2)
  const widen = 1 / Math.max(0.12, Math.cos(lowest * DEG))
  return Math.min(180, (Math.atan(Math.tan(halfH) * widen) / DEG) * 1.04 + 0.5)
}

// --- Tranches de chargement ------------------------------------------------------

/** Rectangle du plan local, metres. */
export interface EnuBox {
  eastMin: number
  eastMax: number
  northMin: number
  northMax: number
}

/** Une tranche de distance a charger, et le pas auquel la charger. */
export interface PhotoBand {
  nearM: number
  farM: number
  /** Pas de la grille, metres. */
  stepM: number
  /** Emprise du secteur dans le plan local. */
  box: EnuBox
}

/** Pas le plus fin que publie la source — le MNT LiDAR HD de l'IGN. */
export const SOURCE_FLOOR_M = 0.5

/**
 * Plafond d'echantillons par tranche.
 *
 * Trois millions de flottants, douze megaoctets : une tranche se telecharge en
 * deux requetes et tient en memoire avec ses voisines. Les tranches lointaines,
 * qui ne couvrent qu'une bande mince sous l'horizon, en prennent moitie moins.
 */
export const BAND_MAX_SAMPLES = 3_000_000
const FAR_BAND_FROM_M = 12_000

/** Emprise du secteur `[azimut ± demi-ouverture] × [proche, loin]` dans le plan local. */
export function sectorBox(azimuthDeg: number, halfSpanDeg: number, nearM: number, farM: number): EnuBox {
  const box: EnuBox = { eastMin: Infinity, eastMax: -Infinity, northMin: Infinity, northMax: -Infinity }
  const add = (d: number, azDeg: number) => {
    const e = d * Math.sin(azDeg * DEG)
    const n = d * Math.cos(azDeg * DEG)
    box.eastMin = Math.min(box.eastMin, e)
    box.eastMax = Math.max(box.eastMax, e)
    box.northMin = Math.min(box.northMin, n)
    box.northMax = Math.max(box.northMax, n)
  }
  // Les arcs sont echantillonnes assez finement pour qu'une corde ne coupe pas
  // le bombement du secteur.
  const steps = Math.max(8, Math.ceil(halfSpanDeg / 4))
  for (let k = 0; k <= 2 * steps; k++) {
    const az = azimuthDeg - halfSpanDeg + (halfSpanDeg * k) / steps
    add(nearM, az)
    add(farM, az)
  }
  if (nearM <= 0 || halfSpanDeg >= 180) add(0, azimuthDeg)
  return box
}

/**
 * Les tranches de chargement d'une photo.
 *
 * La premiere va du pied de l'observateur a la distance ou le pixel vaut le pas
 * de la source ; les suivantes doublent. Chaque tranche deborde de huit pour
 * cent sur sa voisine, pour que le fondu entre deux grilles ait ou se faire.
 */
export function photoBands(view: PhotoView, reachM: number, sourceFloorM = SOURCE_FLOOR_M): PhotoBand[] {
  const pa = photoPixelAngleRad(view)
  const halfSpan = photoAzimuthHalfSpanDeg(view)
  const first = Math.max(300, sourceFloorM / pa)
  const edges = [0, first]
  while (edges[edges.length - 1] < reachM) edges.push(Math.min(reachM, edges[edges.length - 1] * 2))
  const bands: PhotoBand[] = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const nearM = edges[i] / 1.08
    const farM = Math.min(reachM, edges[i + 1] * 1.08)
    const box = sectorBox(view.azimuthDeg, halfSpan, nearM, farM)
    const area = (box.eastMax - box.eastMin) * (box.northMax - box.northMin)
    const cap = edges[i] >= FAR_BAND_FROM_M ? BAND_MAX_SAMPLES / 2 : BAND_MAX_SAMPLES
    const stepM = Math.max(sourceFloorM, edges[i] * pa, Math.sqrt(area / cap))
    bands.push({ nearM, farM, stepM, box })
  }
  return bands
}

// --- Grilles locales et echantillonneur ------------------------------------------

/**
 * Grille d'altitudes alignee sur le plan local (est, nord), metres.
 *
 * Les rasters arrivent en degres de longitude et de latitude ; ils sont
 * rééchantillonnes **une fois** sur cette grille, et tout le reste — le maillage,
 * les millions de rayons d'ombre — n'echantillonne plus que du plan local, ou
 * une lecture bilineaire coute quelques nanosecondes.
 */
export interface EnuGrid {
  eastMin: number
  northMin: number
  stepM: number
  nx: number
  ny: number
  /** Altitudes, `[iNorth * nx + iEast]`, NaN la ou rien n'est connu. */
  heights: Float32Array
}

/** Fraction de la grille, depuis le bord, sur laquelle elle cede a la suivante. */
const GRID_BLEND = 0.06

export type Sampler = (eastM: number, northM: number) => number

/** Lecture bilineaire ; NaN hors de la grille ou sur une case inconnue. */
export function sampleGrid(grid: EnuGrid, eastM: number, northM: number): number {
  const fx = (eastM - grid.eastMin) / grid.stepM
  const fy = (northM - grid.northMin) / grid.stepM
  if (!(fx >= 0 && fy >= 0 && fx <= grid.nx - 1 && fy <= grid.ny - 1)) return Number.NaN
  const ix = Math.min(grid.nx - 2, Math.floor(fx))
  const iy = Math.min(grid.ny - 2, Math.floor(fy))
  const tx = fx - ix
  const ty = fy - iy
  const h = grid.heights
  const k = iy * grid.nx + ix
  return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + grid.nx] * (1 - tx) + h[k + grid.nx + 1] * tx) * ty
}

/** Poids d'une grille en un point : un au coeur, zero au bord. */
function gridWeight(grid: EnuGrid, eastM: number, northM: number): number {
  const ux = (eastM - grid.eastMin) / ((grid.nx - 1) * grid.stepM)
  const uy = (northM - grid.northMin) / ((grid.ny - 1) * grid.stepM)
  const edge = Math.min(ux, 1 - ux, uy, 1 - uy) / GRID_BLEND
  if (edge >= 1) return 1
  if (edge <= 0) return 0
  return edge * edge * (3 - 2 * edge)
}

/**
 * Echantillonneur compose : les grilles de la photo, de la plus fine a la plus
 * grossiere, puis le relief courant.
 *
 * Chaque grille fond vers la suivante sur sa frange — deux tranches voisines
 * n'ont ni le meme pas ni exactement les memes valeurs, et un basculement franc
 * dessinerait une marche dans le maillage.
 */
export function composeSampler(grids: readonly EnuGrid[], fallback: Sampler): Sampler {
  const ordered = [...grids].sort((a, b) => a.stepM - b.stepM)
  const from = (i: number, e: number, n: number): number => {
    for (let k = i; k < ordered.length; k++) {
      const g = ordered[k]
      const h = sampleGrid(g, e, n)
      if (Number.isNaN(h)) continue
      const w = gridWeight(g, e, n)
      if (w >= 1) return h
      return h * w + from(k + 1, e, n) * (1 - w)
    }
    return fallback(e, n)
  }
  return (e, n) => from(0, e, n)
}

/** Pas de la grille la plus fine qui couvre un point, metres — `fallbackStepM` sinon. */
export function finestStepAt(grids: readonly EnuGrid[], eastM: number, northM: number, fallbackStepM: number): number {
  let best = fallbackStepM
  for (const g of grids) {
    if (g.stepM >= best) continue
    const fx = (eastM - g.eastMin) / g.stepM
    const fy = (northM - g.northMin) / g.stepM
    if (fx >= 0 && fy >= 0 && fx <= g.nx - 1 && fy <= g.ny - 1) best = g.stepM
  }
  return best
}

// --- Maillage ------------------------------------------------------------------

/**
 * Plan du maillage : des colonnes dans le seul secteur du cadre, des anneaux en
 * progression geometrique comme le maillage courant.
 *
 * Un sommet tous les 1,5 pixel dans les deux sens : c'est la plus grosse maille
 * qui ne se voie pas, et elle borne le maillage a quelques millions de sommets
 * a 3 200 × 2 000.
 */
export interface PhotoMeshPlan {
  azimuthsDeg: Float64Array
  distances: Float64Array
}

const PIXELS_PER_VERTEX = 1.5
const MAX_COLUMNS = 3200
const MAX_RINGS = 2600

export function photoMeshPlan(view: PhotoView, reachM: number): PhotoMeshPlan {
  const halfSpan = photoAzimuthHalfSpanDeg(view)
  const pa = photoPixelAngleRad(view)
  const columns = Math.max(64, Math.min(MAX_COLUMNS, Math.round((2 * halfSpan * DEG) / (pa * PIXELS_PER_VERTEX))))
  const rings = Math.max(256, Math.min(MAX_RINGS, Math.round(view.heightPx / PIXELS_PER_VERTEX * 1.25)))
  const azimuthsDeg = new Float64Array(columns)
  for (let a = 0; a < columns; a++) {
    azimuthsDeg[a] = view.azimuthDeg - halfSpan + (2 * halfSpan * a) / (columns - 1)
  }
  const logNear = Math.log(NEAR_M)
  const logSpan = Math.log(reachM) - logNear
  const distances = new Float64Array(rings)
  for (let r = 0; r < rings; r++) distances[r] = Math.exp(logNear + (logSpan * r) / (rings - 1))
  return { azimuthsDeg, distances }
}

/** Maillage pret a partir vers le GPU, et ses positions physiques. */
export interface PhotoMesh {
  columns: number
  rings: number
  /** Positions de scene (profondeur logarithmique), comme le maillage courant. */
  positions: Float32Array
  normals: Float32Array
  ranges: Float32Array
  altitudes: Float32Array
  /** Positions physiques (est, altitude, nord), metres — pour le calcul des ombres. */
  local: Float64Array
  index: Uint32Array
}

/**
 * Construit le maillage du cadre.
 *
 * Meme algorithme que le maillage courant — voir `advanceBuild` dans
 * `Terrain.tsx` : le point le plus haut de chaque tranche d'anneau, pour une
 * ligne de crete juste au loin, et des normales prises sur la facette reellement
 * affichee. Seuls changent la densite et le fait que l'azimut ne boucle pas.
 */
export function buildPhotoMesh(
  sample: Sampler,
  plan: PhotoMeshPlan,
  observerM: number,
  effectiveRadiusM: number,
  onProgress?: (fraction: number) => void,
): PhotoMesh {
  const columns = plan.azimuthsDeg.length
  const rings = plan.distances.length
  const n = columns * rings
  const positions = new Float32Array(n * 3)
  const normals = new Float32Array(n * 3)
  const ranges = new Float32Array(n)
  const altitudes = new Float32Array(n)
  const local = new Float64Array(n * 3)
  const sinAz = new Float64Array(columns)
  const cosAz = new Float64Array(columns)
  for (let a = 0; a < columns; a++) {
    sinAz[a] = Math.sin(plan.azimuthsDeg[a] * DEG)
    cosAz[a] = Math.cos(plan.azimuthsDeg[a] * DEG)
  }
  const slab = new Float64Array(8)

  for (let r = 0; r < rings; r++) {
    const s = ringSlabM(plan.distances, r, rings)
    const samples = slabSamplesFor(s.nearM, s.farM)
    for (let k = 0; k < samples; k++) {
      const t = samples > 1 ? k / (samples - 1) : 0.5
      slab[k] = s.nearM * (s.farM / s.nearM) ** t
    }
    for (let a = 0; a < columns; a++) {
      let bestEl = -Infinity
      let bestD = plan.distances[r]
      let bestH = 0
      for (let k = 0; k < samples; k++) {
        const d = samples > 1 ? slab[k] : plan.distances[r]
        const h = sample(d * sinAz[a], d * cosAz[a])
        const el = apparentElevationRad(d, h, observerM, effectiveRadiusM)
        if (el > bestEl) {
          bestEl = el
          bestD = d
          bestH = h
        }
      }
      const depth = terrainDepth(bestD)
      const cosEl = Math.cos(bestEl)
      const i = r * columns + a
      positions[i * 3] = depth * cosEl * sinAz[a]
      positions[i * 3 + 1] = depth * Math.sin(bestEl)
      positions[i * 3 + 2] = -depth * cosEl * cosAz[a]
      ranges[i] = bestD
      altitudes[i] = bestH
      local[i * 3] = bestD * sinAz[a]
      local[i * 3 + 1] = bestH
      local[i * 3 + 2] = bestD * cosAz[a]
    }
    if (onProgress && r % 64 === 0) onProgress(r / rings)
  }

  // Normales de la facette affichee, en coordonnees physiques (est, haut, −nord
  // pour rester dans le repere de la scene).
  for (let r = 0; r < rings; r++) {
    for (let a = 0; a < columns; a++) {
      const i = r * columns + a
      const pa = r * columns + Math.max(0, a - 1)
      const na = r * columns + Math.min(columns - 1, a + 1)
      const pr = Math.max(0, r - 1) * columns + a
      const nr = Math.min(rings - 1, r + 1) * columns + a
      const ax = local[na * 3] - local[pa * 3]
      const ay = local[na * 3 + 1] - local[pa * 3 + 1]
      const az = -(local[na * 3 + 2] - local[pa * 3 + 2])
      const rx = local[nr * 3] - local[pr * 3]
      const ry = local[nr * 3 + 1] - local[pr * 3 + 1]
      const rz = -(local[nr * 3 + 2] - local[pr * 3 + 2])
      let nx = ay * rz - az * ry
      let ny = az * rx - ax * rz
      let nz = ax * ry - ay * rx
      if (ny < 0) {
        nx = -nx
        ny = -ny
        nz = -nz
      }
      const len = Math.hypot(nx, ny, nz)
      const inv = len > 0 ? 1 / len : 0
      normals[i * 3] = nx * inv
      normals[i * 3 + 1] = len > 0 ? ny * inv : 1
      normals[i * 3 + 2] = nz * inv
    }
  }

  const index = new Uint32Array((rings - 1) * (columns - 1) * 6)
  let k = 0
  for (let r = 0; r < rings - 1; r++) {
    for (let a = 0; a < columns - 1; a++) {
      const i00 = r * columns + a
      const i01 = i00 + 1
      const i10 = i00 + columns
      const i11 = i10 + 1
      index[k++] = i00
      index[k++] = i10
      index[k++] = i11
      index[k++] = i00
      index[k++] = i11
      index[k++] = i01
    }
  }
  onProgress?.(1)
  return { columns, rings, positions, normals, ranges, altitudes, local, index }
}

// --- Ombres --------------------------------------------------------------------

/**
 * Demi-diametre apparent du Soleil, degres.
 *
 * C'est lui qui fait la penombre : un point voit une fraction du disque, pas
 * tout ou rien. La carte d'ombre courante l'ignore et dessine une frontiere
 * nette ; la photo, qui suit un rayon par sommet, peut la rendre.
 */
export const SUN_SEMI_DIAMETER_DEG = 0.2666

/**
 * Raison de la progression des pas d'un rayon d'ombre.
 *
 * ⚠️ Elle valait 1,045, et la validation l'a recalee : un pas de 4,5 % de la
 * distance peut enjamber le haut d'une crete proche, et l'horizon lu tombe
 * alors jusqu'a un degre trop bas — l'ombre glisse, et la penombre, large d'un
 * demi-degre, disparait. A 2,5 % l'erreur reste sous le demi-diametre solaire.
 */
const SHADOW_STEP_RATIO = 1.025

/** Portee des rayons d'ombre, metres — celle de la carte courante. */
export const SHADOW_REACH_M = 60_000

/**
 * Part du disque solaire visible depuis un point, de 0 a 1.
 *
 * On remonte la direction du Soleil depuis le point et l'on garde l'angle le
 * plus haut sous lequel le relief se dresse, courbure de la Terre comprise :
 *
 *     horizon = max sur t de atan[(h(P + t·L) − t²/2R − h(P)) / t]
 *
 * La visibilite est alors la part du disque au-dessus de cet horizon,
 * interpolee lineairement sur son diametre — une corde de disque serait plus
 * juste de quelques pour cent, et ne se verrait pas.
 *
 * Le pas croit geometriquement : un metre au pied du point, trois kilometres a
 * soixante. Le relief qui ombre de loin est grand, et c'est pres du point que
 * la crete fine compte.
 *
 * La marche s'arrete des que meme le plus haut sommet connu ne pourrait plus
 * remonter l'horizon au-dessus du bas du disque : par Soleil haut, quelques pas
 * suffisent.
 */
export function sunVisibility(
  sample: Sampler,
  eastM: number,
  northM: number,
  altitudeM: number,
  sunAltitudeDeg: number,
  sunAzimuthDeg: number,
  effectiveRadiusM: number,
  peakM: number,
  startM: number,
): number {
  const lx = Math.sin(sunAzimuthDeg * DEG)
  const ly = Math.cos(sunAzimuthDeg * DEG)
  const low = Math.tan((sunAltitudeDeg - SUN_SEMI_DIAMETER_DEG) * DEG)
  let maxTan = -Infinity
  let t = Math.max(1, startM)
  while (t < SHADOW_REACH_M) {
    const drop = (t * t) / (2 * effectiveRadiusM)
    const h = sample(eastM + t * lx, northM + t * ly) - drop
    const tanH = (h - altitudeM) / t
    if (tanH > maxTan) maxTan = tanH
    // Plus rien ne peut masquer le disque, meme le plus haut sommet.
    const bound = (peakM - drop - altitudeM) / t
    if (bound < low && bound < maxTan) break
    t = t * SHADOW_STEP_RATIO + 0.5
  }
  const horizonDeg = Math.atan(maxTan) / DEG
  const v = (sunAltitudeDeg - horizonDeg) / (2 * SUN_SEMI_DIAMETER_DEG) + 0.5
  return v <= 0 ? 0 : v >= 1 ? 1 : v
}

/** Portee du maillage photo : celle du maillage courant, bornee par la pyramide. */
export const PHOTO_MAX_REACH_M = CLIPMAP_HALF_SPANS_M[CLIPMAP_HALF_SPANS_M.length - 1]
