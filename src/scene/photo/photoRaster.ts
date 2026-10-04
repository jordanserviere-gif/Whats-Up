/**
 * Mode photo — le relief rendu pixel par pixel.
 *
 * ## Pourquoi plus de maillage
 *
 * Un maillage decrit le relief **partout** a une finesse donnee, puis le GPU en
 * jette la plus grande part : ce qui est cache, ce qui sort du cadre, ce qui
 * tient sous le pixel. Pour l'ecran en mouvement, c'est le bon compromis. Pour
 * une image figee a un degre de champ, c'est absurde : la donnee utile se
 * reduit aux points que **chaque pixel voit**.
 *
 * C'est la methode des generateurs de panoramas — celui d'Ulrich Deuschle en
 * est l'exemple : un rayon par colonne d'image, qui avance le long du profil du
 * terrain et ne retient que ce qui depasse l'horizon deja vu. Les lignes se
 * remplissent de bas en haut ; une crete proche cache ce qui est derriere elle
 * sans qu'on ait rien a trier, et ce qu'elle cache n'est jamais charge.
 *
 * ## Le cadre, en azimut et en hauteur
 *
 * Une colonne de la grille est un plan vertical, d'azimut fixe : c'est ce qui
 * rend la marche par colonne exacte. Les colonnes et les lignes sont espacees
 * **comme les pixels de l'ecran**, pas a angle constant :
 *
 *     u = tan(az − az₀)                 — l'abscisse de l'ecran
 *     v = tan(h − h₀) / cos(az − az₀)   — son ordonnee
 *
 * a pas egal en `u` et en `v`. Pour une camera horizontale, c'est exactement la
 * projection de l'image ; inclinee de quelques degres, a peine moins.
 *
 * ⚠️ Une grille a pas angulaire constant tombait juste au centre de l'image,
 * mais un pixel du bord n'y couvre que la moitie de l'angle d'un pixel du
 * centre : la grille y etait deux fois trop grossiere, et le GPU dupliquait des
 * colonnes entieres — des tranches verticales franches.
 *
 * ## Ce module est pur
 *
 * Il tourne dans les workers du mode photo, et la validation le controle.
 */
import { apparentElevationRad } from '../terrain/ridgeField'
import { sunVisibility, SHADOW_REACH_M, type PhotoView, type Sampler } from './photoPlan'

const DEG = Math.PI / 180

// --- Le cadre ------------------------------------------------------------------

/** Grille qui couvre le cadre, espacee comme l'ecran. Angles en radians, azimut depuis le nord. */
export interface PhotoFrame {
  /** Azimut et hauteur du centre de l'image. */
  az0: number
  el0: number
  /** `u` et `v` du bord de la premiere case. */
  uMin: number
  vMin: number
  /** Pas en `u` et en `v` — c'est aussi l'angle d'une case au centre de l'image. */
  step: number
  cols: number
  rows: number
}

/** Ecart d'azimut au centre de la colonne `c`. */
export const colDa = (f: PhotoFrame, c: number): number => Math.atan(f.uMin + (c + 0.5) * f.step)

/** Hauteur apparente du centre de la ligne `r`, dans une colonne d'ecart `cosDa`. */
export const rowEl = (f: PhotoFrame, cosDa: number, r: number): number => f.el0 + Math.atan((f.vMin + (r + 0.5) * f.step) * cosDa)

/** Angle d'une case en travers de la visee, pour un ecart d'azimut donne : il fixe la finesse voulue. */
export const cellAngle = (f: PhotoFrame, da: number): number => f.step * Math.cos(da) ** 2

/** Direction d'un rayon de la camera, pour `x, y ∈ [−1, 1]` sur l'image. */
function rayOf(view: PhotoView, x: number, y: number): { az: number; el: number } {
  const az0 = view.azimuthDeg * DEG
  const el0 = view.altitudeDeg * DEG
  // Repere de la camera, en (est, haut, nord).
  const f = [Math.cos(el0) * Math.sin(az0), Math.sin(el0), Math.cos(el0) * Math.cos(az0)]
  const r = [Math.cos(az0), 0, -Math.sin(az0)]
  const u = [-Math.sin(el0) * Math.sin(az0), Math.cos(el0), -Math.sin(el0) * Math.cos(az0)]
  const tv = Math.tan((view.fovDeg / 2) * DEG)
  const th = tv * view.aspect
  const d = [0, 1, 2].map((k) => f[k] + x * th * r[k] + y * tv * u[k])
  const len = Math.hypot(d[0], d[1], d[2])
  return { az: Math.atan2(d[0], d[2]), el: Math.asin(d[1] / len) }
}

/** Ecart d'azimut le plus grand que la grille accepte : `u = tan(Δaz)` doit rester fini. */
const MAX_DA = 85 * DEG

/** La grille du cadre, au pas du pixel, avec deux pas de marge. */
export function photoFrame(view: PhotoView): PhotoFrame {
  // Un pixel, en unites de l'ecran : 2·tan(champ/2) sur la hauteur.
  const step = (2 * Math.tan((view.fovDeg / 2) * DEG)) / Math.max(1, view.heightPx)
  const az0 = view.azimuthDeg * DEG
  const el0 = view.altitudeDeg * DEG
  let uLo = Infinity
  let uHi = -Infinity
  let vLo = Infinity
  let vHi = -Infinity
  const N = 16
  for (let i = 0; i <= N; i++) {
    for (const [x, y] of [
      [-1 + (2 * i) / N, -1],
      [-1 + (2 * i) / N, 1],
      [-1, -1 + (2 * i) / N],
      [1, -1 + (2 * i) / N],
    ]) {
      const { az, el } = rayOf(view, x, y)
      // Azimut relatif au centre, ramene dans ]−π, π] — et borne : une camera
      // qui vise le sol voit tous les azimuts sous elle.
      let da = az - az0
      da = Math.max(-MAX_DA, Math.min(MAX_DA, Math.atan2(Math.sin(da), Math.cos(da))))
      const u = Math.tan(da)
      const v = Math.tan(el - el0) / Math.cos(da)
      uLo = Math.min(uLo, u)
      uHi = Math.max(uHi, u)
      vLo = Math.min(vLo, v)
      vHi = Math.max(vHi, v)
    }
  }
  uLo -= 2 * step
  uHi += 2 * step
  vLo -= 2 * step
  vHi += 2 * step
  return {
    az0,
    el0,
    uMin: uLo,
    vMin: vLo,
    step,
    cols: Math.max(2, Math.ceil((uHi - uLo) / step)),
    rows: Math.max(2, Math.ceil((vHi - vLo) / step)),
  }
}

/** Une grille angulaire plus grossiere d'un facteur entier — pour la passe de visibilite. */
export function coarsenFrame(frame: PhotoFrame, factor: number): PhotoFrame {
  return {
    ...frame,
    step: frame.step * factor,
    cols: Math.max(2, Math.ceil(frame.cols / factor)),
    rows: Math.max(2, Math.ceil(frame.rows / factor)),
  }
}

// --- Majorants d'altitude --------------------------------------------------------

/**
 * Altitude maximale possible par case kilometrique, voisines comprises.
 *
 * C'est elle qui rend la marche rapide en teleobjectif : un troncon de profil
 * dont meme le majorant ne depasse pas l'horizon deja vu est saute d'un bloc.
 * Elle se calcule sur le relief courant, et la marge couvre ce que la donnee
 * fine peut y ajouter — un sommet effile que la case de 547 m a manque.
 */
export interface MaxGrid {
  half: number
  cell: number
  n: number
  max: Float32Array
}

export function buildMaxGrid(sample: Sampler, halfSpanM: number, marginAt: (distanceM: number) => number, cellM = 1000): MaxGrid {
  const n = Math.ceil((2 * halfSpanM) / cellM) + 1
  const raw = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const e0 = i * cellM - halfSpanM
      const n0 = j * cellM - halfSpanM
      let m = -Infinity
      for (let a = 0; a <= 2; a++) for (let b = 0; b <= 2; b++) m = Math.max(m, sample(e0 + ((a - 1) * cellM) / 2, n0 + ((b - 1) * cellM) / 2))
      raw[j * n + i] = m + marginAt(Math.hypot(e0, n0))
    }
  }
  // Dilatation d'une case : un troncon qui frole un coin de case reste borne.
  const max = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let m = -Infinity
      for (let b = Math.max(0, j - 1); b <= Math.min(n - 1, j + 1); b++)
        for (let a = Math.max(0, i - 1); a <= Math.min(n - 1, i + 1); a++) m = Math.max(m, raw[b * n + a])
      max[j * n + i] = m
    }
  }
  return { half: halfSpanM, cell: cellM, n, max }
}

function maxAt(g: MaxGrid, e: number, n: number): number {
  const i = Math.round((e + g.half) / g.cell)
  const j = Math.round((n + g.half) / g.cell)
  if (i < 0 || j < 0 || i >= g.n || j >= g.n) return Infinity
  return g.max[j * g.n + i]
}

// --- La marche par colonne -----------------------------------------------------------

/** Ce qu'un pixel voit : distance (0 = ciel), altitude, part couverte. */
export interface PhotoGBuffer {
  frame: PhotoFrame
  range: Float32Array
  altitude: Float32Array
  coverage: Float32Array
}

export interface MarchOptions {
  observerM: number
  effectiveRadiusM: number
  reachM: number
  /** Pas fin le long du profil a une distance donnee, metres. */
  fineStepAt: (distanceM: number) => number
  maxGrid: MaxGrid
  /** Colonnes a traiter, `[debut, fin[`. */
  colStart?: number
  colEnd?: number
}

/** Plus grand pas grossier, metres — sous la case des majorants. */
const COARSE_MAX_M = 800
/** Pas grossier minimal, en fraction de la distance. */
const COARSE_RATIO = 0.004

export function marchColumns(sample: Sampler, frame: PhotoFrame, opt: MarchOptions, out?: PhotoGBuffer): PhotoGBuffer {
  const { cols, rows } = frame
  const gb = out ?? {
    frame,
    range: new Float32Array(cols * rows),
    altitude: new Float32Array(cols * rows),
    coverage: new Float32Array(cols * rows),
  }
  const { observerM: eye, effectiveRadiusM: R, reachM, maxGrid } = opt

  for (let c = opt.colStart ?? 0; c < (opt.colEnd ?? cols); c++) {
    const da = colDa(frame, c)
    const az = frame.az0 + da
    const sa = Math.sin(az)
    const ca = Math.cos(az)
    const cosDa = Math.cos(da)
    const elRow = (r: number) => rowEl(frame, cosDa, r)
    // Hauteur d'une ligne, la ou la marche en est : elle varie le long de la colonne.
    let de = elRow(1) - elRow(0)
    const lineAt = (r: number) => {
      de = elRow(r + 1) - elRow(r)
      return de
    }
    let filled = 0
    let topEl = -Infinity
    let topD = 0
    let topH = 0

    // Point precedent du profil. Le tout premier est sous les pieds, a −90° :
    // les lignes plus basses que le premier echantillon sont le sol tout proche.
    let pd = 0.3
    let ph = sample(0, 0)
    let pel = -Math.PI / 2

    const write = (r: number, d: number, h: number, cover: number) => {
      const k = r * cols + c
      gb.range[k] = d
      gb.altitude[k] = h
      gb.coverage[k] = cover
    }
    /** Un segment du profil : expose les lignes que son extremite depasse. */
    const segment = (d: number, h: number, el: number) => {
      while (filled < rows && elRow(filled) <= el) {
        const t = el > pel ? Math.max(0, Math.min(1, (elRow(filled) - pel) / (el - pel))) : 1
        write(filled, pd + t * (d - pd), ph + t * (h - ph), 1)
        filled++
        lineAt(filled)
      }
      if (el > topEl) {
        topEl = el
        topD = d
        topH = h
      }
      pd = d
      ph = h
      pel = el
    }
    /** Avance d'un point, en subdivisant si le relief grimpe de plus d'une ligne et demie. */
    const advance = (d: number) => {
      const h = sample(d * sa, d * ca)
      const el = apparentElevationRad(d, h, eye, R)
      if (el - pel > 1.5 * de && el > elRow(filled) && filled < rows) {
        const k = Math.min(48, Math.ceil((el - pel) / de))
        const d0 = pd
        for (let i = 1; i < k; i++) {
          const di = d0 + ((d - d0) * i) / k
          const hi = sample(di * sa, di * ca)
          segment(di, hi, apparentElevationRad(di, hi, eye, R))
        }
      }
      segment(d, h, el)
    }

    let d = 1
    advance(d)
    while (d < reachM && filled < rows) {
      const coarse = Math.min(COARSE_MAX_M, Math.max(2, d * COARSE_RATIO))
      const dNext = Math.min(reachM, d + coarse)
      // Majorant du troncon : le plus haut relief possible, vu au plus pres.
      const hMax = Math.max(maxAt(maxGrid, d * sa, d * ca), maxAt(maxGrid, ((d + dNext) / 2) * sa, ((d + dNext) / 2) * ca), maxAt(maxGrid, dNext * sa, dNext * ca))
      const elUpper = Math.atan((hMax - eye) / d) - d / (2 * R)
      if (elUpper < elRow(filled) - de) {
        // Rien dans ce troncon ne peut montrer une ligne de plus : on le saute,
        // en posant son extremite comme point precedent.
        d = dNext
        const h = sample(d * sa, d * ca)
        pd = d
        ph = h
        pel = Math.min(pel, apparentElevationRad(d, h, eye, R))
        continue
      }
      const fine = Math.max(0.4, opt.fineStepAt(d))
      while (d < dNext && filled < rows) {
        d = Math.min(dNext, d + fine)
        advance(d)
      }
    }

    // La silhouette contre le ciel : la part de pixel que le relief couvre
    // vraiment. La crete la plus haute tombe soit dans la moitie haute de la
    // derniere ligne de relief — qui n'est alors couverte qu'en partie —, soit
    // dans la moitie basse de la premiere ligne de ciel, qui l'est un peu.
    // C'est l'anticrenelage vertical des cretes, exact au lieu d'estime.
    if (filled > 0 && Number.isFinite(topEl)) {
      const last = filled - 1
      const deLast = lineAt(last)
      const coverLast = (topEl - (elRow(last) - deLast / 2)) / deLast
      if (coverLast < 1) gb.coverage[last * cols + c] = Math.max(0, coverLast)
      if (filled < rows) {
        const deNext = lineAt(filled)
        const coverNext = (topEl - (elRow(filled) - deNext / 2)) / deNext
        if (coverNext > 0.02) write(filled, topD, topH, Math.min(1, coverNext))
      }
    }
  }
  return gb
}

// --- La selection des tuiles --------------------------------------------------------

export interface TileNeed {
  /** Taille voulue d'une case au sol, metres. */
  cellM: number
  eastM: number
  northM: number
}

/**
 * Ce qu'il faut charger : pour chaque pixel visible de la passe grossiere, la
 * taille au sol du pixel **de la photo** a sa distance.
 *
 * En travers de la visee, c'est `distance × angle d'un pixel`. On ne descend pas
 * plus bas : le long de la visee, un pixel couvre bien davantage, et c'est la
 * subdivision de la marche, pas la donnee, qui y rattrape le relief raide.
 */
export function tileNeeds(gb: PhotoGBuffer, photo: PhotoFrame): TileNeed[] {
  const { cols, rows } = gb.frame
  const needs: TileNeed[] = []
  for (let c = 0; c < cols; c++) {
    const da = colDa(gb.frame, c)
    const az = gb.frame.az0 + da
    const angle = cellAngle(photo, da)
    for (let r = 0; r < rows; r++) {
      const d = gb.range[r * cols + c]
      if (!(d > 0)) continue
      needs.push({ cellM: d * angle, eastM: d * Math.sin(az), northM: d * Math.cos(az) })
    }
  }
  return needs
}

// --- Normales, ombres, ciel ----------------------------------------------------------

/**
 * Pas de differences finies pour la normale d'un pixel : une fois et demie sa
 * taille au sol, et jamais moins de deux cases LiDAR.
 *
 * ⚠️ Plus court, la difference tombe a l'interieur d'une case bilineaire et
 * sur l'arrondi des altitudes : la pente se met a onduler de plusieurs degres,
 * et toute surface rasee par le Soleil se couvre de stries regulieres.
 */
const normalStep = (d: number, stepRad: number) => Math.max(1.25, 1.5 * d * stepRad)

/** Normales de scene (+X est, +Y haut, −Z nord) de chaque pixel vu. */
export function pixelNormals(sample: Sampler, gb: PhotoGBuffer, rowStart = 0, rowEnd = gb.frame.rows): Float32Array {
  const { cols, step } = gb.frame
  const out = new Float32Array((rowEnd - rowStart) * cols * 3)
  for (let r = rowStart; r < rowEnd; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c
      const d = gb.range[k]
      const o = ((r - rowStart) * cols + c) * 3
      if (!(d > 0)) {
        out[o + 1] = 1
        continue
      }
      const az = gb.frame.az0 + colDa(gb.frame, c)
      const e = d * Math.sin(az)
      const n = d * Math.cos(az)
      const g = normalStep(d, step)
      const he = (sample(e + g, n) - sample(e - g, n)) / (2 * g)
      const hn = (sample(e, n + g) - sample(e, n - g)) / (2 * g)
      const len = Math.hypot(he, 1, hn)
      out[o] = -he / len
      out[o + 1] = 1 / len
      out[o + 2] = hn / len
    }
  }
  return out
}

export interface ShadeOptions {
  sunAltitudeDeg: number
  sunAzimuthDeg: number
  effectiveRadiusM: number
  peakM: number
}

/**
 * Longueur de rayon lue sur les tuiles fines, metres.
 *
 * Au-dela, le relief courant suffit : une crete qui ombre ou masque le ciel
 * depuis plusieurs kilometres est grande devant sa case de 27 a 110 m, et la
 * lire sur les tuiles coutait dix fois plus pour le meme angle a un pixel pres.
 * C'est ce qui rend l'ombrage de la photo cinq a huit fois plus rapide.
 */
const FINE_RAY_M = 1500

/** Directions de la recherche d'horizon pour le ciel visible. */
const SKY_DIRECTIONS = 8
/** Portee de cette recherche, metres : au-dela, le relief n'assombrit plus le ciel d'un point. */
const SKY_REACH_M = 6000

/**
 * Part du Soleil et part du ciel que voit chaque pixel, pour les lignes
 * `[debut, fin[`.
 *
 * Le Soleil : un rayon par pixel, penombre du disque comprise — voir
 * `sunVisibility`. Le ciel : l'horizon dans huit directions, rapporte au plan
 * tangent du point, pour que la pente ne compte pas deux fois avec le terme
 * `½(1 + N·haut)` du nuanceur. Un fond de vallee etroite y perd la moitie de
 * son ciel ; une crete le garde entier. C'est ce que le rendu courant, qui ne
 * voit que la pente locale, ne peut pas dire.
 *
 * Le ciel est calcule un pixel sur deux dans chaque sens et recopie sur ses
 * voisins : il varie lentement, et c'est le terme le plus cher.
 */
export function shadePixels(
  sample: Sampler,
  /** Le relief courant : il suffit au loin d'un rayon, et il coute dix fois moins. */
  coarse: Sampler,
  gb: PhotoGBuffer,
  normals: Float32Array,
  normalsRowStart: number,
  opt: ShadeOptions,
  rowStart: number,
  rowEnd: number,
  /** Pixels a calculer, indexes comme la grille ; tous si absent. */
  mask?: Uint8Array,
): { sun: Float32Array; sky: Float32Array } {
  const { cols, step } = gb.frame
  const n = (rowEnd - rowStart) * cols
  const sun = new Float32Array(n)
  const sky = new Float32Array(n).fill(1)
  const sunAlt = opt.sunAltitudeDeg * DEG
  const sunAz = opt.sunAzimuthDeg * DEG
  const sx = Math.cos(sunAlt) * Math.sin(sunAz)
  const sy = Math.sin(sunAlt)
  const sz = -Math.cos(sunAlt) * Math.cos(sunAz)
  const R = opt.effectiveRadiusM
  const dirs = [...Array(SKY_DIRECTIONS)].map((_, i) => [Math.sin((2 * Math.PI * i) / SKY_DIRECTIONS), Math.cos((2 * Math.PI * i) / SKY_DIRECTIONS)])

  for (let r = rowStart; r < rowEnd; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c
      const d = gb.range[k]
      const o = (r - rowStart) * cols + c
      if (!(d > 0) || (mask && !mask[k])) continue
      const az = gb.frame.az0 + colDa(gb.frame, c)
      const e = d * Math.sin(az)
      const nn = d * Math.cos(az)
      const h = gb.altitude[k]
      const ni = ((r - normalsRowStart) * cols + c) * 3
      const nx = normals[ni]
      const ny = normals[ni + 1]
      const nz = normals[ni + 2]
      const g = normalStep(d, step)

      // --- Le Soleil.
      const facing = nx * sx + ny * sy + nz * sz
      if (facing > 0) {
        sun[o] =
          d > SHADOW_REACH_M
            ? 1
            : sunVisibility(sample, e, nn, h, opt.sunAltitudeDeg, opt.sunAzimuthDeg, R, opt.peakM, 2 * g, coarse, FINE_RAY_M)
      }

      // --- Le ciel, un pixel sur deux.
      // Avec un masque, chaque pixel demande est un bord : il recoit son propre ciel.
      if ((mask || ((r & 1) === 0 && (c & 1) === 0)) && d < 150_000) {
        // Pente du plan tangent : h_e = −nx/ny, h_n = nz/ny.
        const he = -nx / Math.max(1e-3, ny)
        const hn = nz / Math.max(1e-3, ny)
        let occluded = 0
        for (const [dx, dy] of dirs) {
          const plane = Math.atan(he * dx + hn * dy)
          let best = plane
          for (let t = 2 * g + 1; t < SKY_REACH_M; t *= 1.3) {
            const ht = (t < FINE_RAY_M ? sample : coarse)(e + t * dx, nn + t * dy) - (t * t) / (2 * R)
            const a = Math.atan((ht - h) / t)
            if (a > best) best = a
          }
          occluded += Math.max(0, Math.sin(best) - Math.sin(plane))
        }
        const v = Math.max(0, 1 - occluded / SKY_DIRECTIONS)
        if (mask) sky[o] = v
        else for (let b = 0; b < 2 && r + b < rowEnd; b++) for (let a = 0; a < 2 && c + a < cols; a++) sky[o + b * cols + a] = v
      }
    }
  }
  return { sun, sky }
}

/**
 * Reprise de l'ombre et du ciel d'une passe voisine — l'echantillonnage
 * adaptatif.
 *
 * Les passes de l'anticrenelage ne different que d'une fraction de pixel. La
 * ou le relief est continu, la part du Soleil et celle du ciel n'y changent
 * pas d'une passe a l'autre au-dela de l'interpolation : on les relit sur la
 * passe de reference, entre ses quatre cases voisines. On ne refait le calcul
 * exact qu'aux discontinuites — une crete devant un fond, un bord d'ombre, un
 * pli de ciel —, la seule ou les passes apportent quelque chose.
 *
 * `dc`, `dr` : decalage de cette passe sur la reference, en cases. Rend le
 * masque des pixels a calculer ; les autres sont deja remplis dans `sun` et
 * `sky`.
 */
export function reuseShading(
  ref: { range: Float32Array; sun: Float32Array; sky: Float32Array },
  gb: PhotoGBuffer,
  dc: number,
  dr: number,
  sun: Float32Array,
  sky: Float32Array,
): Uint8Array {
  const { cols, rows } = gb.frame
  const mask = new Uint8Array(cols * rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c
      const d = gb.range[k]
      if (!(d > 0)) continue
      // La position de ce pixel dans la grille de reference, centres de cases.
      const fc = c + dc
      const fr = r + dr
      const c0 = Math.floor(fc)
      const r0 = Math.floor(fr)
      if (c0 < 0 || r0 < 0 || c0 + 1 >= cols || r0 + 1 >= rows) {
        mask[k] = 1
        continue
      }
      const k00 = r0 * cols + c0
      const k10 = k00 + 1
      const k01 = k00 + cols
      const k11 = k01 + 1
      const d00 = ref.range[k00]
      const d10 = ref.range[k10]
      const d01 = ref.range[k01]
      const d11 = ref.range[k11]
      const dMin = Math.min(d00, d10, d01, d11)
      const dMax = Math.max(d00, d10, d01, d11)
      const s00 = ref.sun[k00]
      const s10 = ref.sun[k10]
      const s01 = ref.sun[k01]
      const s11 = ref.sun[k11]
      const q00 = ref.sky[k00]
      const q10 = ref.sky[k10]
      const q01 = ref.sky[k01]
      const q11 = ref.sky[k11]
      if (
        !(dMin > 0) ||
        dMax > dMin * REUSE_RANGE ||
        d < dMin / REUSE_RANGE ||
        d > dMax * REUSE_RANGE ||
        Math.max(s00, s10, s01, s11) - Math.min(s00, s10, s01, s11) > REUSE_SPREAD ||
        Math.max(q00, q10, q01, q11) - Math.min(q00, q10, q01, q11) > REUSE_SPREAD
      ) {
        mask[k] = 1
        continue
      }
      const tx = fc - c0
      const ty = fr - r0
      sun[k] = (s00 * (1 - tx) + s10 * tx) * (1 - ty) + (s01 * (1 - tx) + s11 * tx) * ty
      sky[k] = (q00 * (1 - tx) + q10 * tx) * (1 - ty) + (q01 * (1 - tx) + q11 * tx) * ty
    }
  }
  return mask
}

/** Ecart de distance relatif admis entre les quatre cases d'une reprise : au-dela, c'est un bord. */
const REUSE_RANGE = 1.02
/** Ecart admis de la part du Soleil ou du ciel entre ces cases : au-dela, un bord d'ombre. */
const REUSE_SPREAD = 0.04

/** Conversion flottant → demi-flottant IEEE, pour des textures moitie moins lourdes. */
export function toHalf(value: number): number {
  const f = new Float32Array(1)
  const u = new Uint32Array(f.buffer)
  f[0] = value
  const x = u[0]
  const sign = (x >>> 16) & 0x8000
  let exp = ((x >>> 23) & 0xff) - 127 + 15
  let mant = x & 0x7fffff
  if (exp <= 0) {
    if (exp < -10) return sign
    mant = (mant | 0x800000) >> (1 - exp)
    return sign | ((mant + 0x1000) >> 13)
  }
  if (exp >= 31) return sign | 0x7c00
  const half = sign | (exp << 10) | ((mant + 0x1000) >> 13)
  return half
}

/** Conversion demi-flottant → flottant : pour connaitre ce que l'arrondi a perdu. */
export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >> 10) & 0x1f
  const mant = h & 0x3ff
  if (exp === 0) return sign * mant * 2 ** -24
  if (exp === 31) return mant ? Number.NaN : sign * Infinity
  return sign * (1 + mant / 1024) * 2 ** (exp - 15)
}
