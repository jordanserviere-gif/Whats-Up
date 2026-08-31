/**
 * Chargement du relief reel autour du site.
 *
 * ## Ce que ce module orchestre
 *
 * Trois niveaux de pyramide, chacun rempli depuis un zoom de tuiles different.
 * Pour chaque niveau : determiner les tuiles couvrant le carre, les recuperer,
 * les decoder, puis **rassembler** — parcourir les cellules du niveau et lire la
 * tuile correspondante.
 *
 * Rassembler plutot que disperser, parce que la projection n'est pas une
 * homothetie : une tuile Mercator ne recouvre pas un nombre entier de cellules
 * du plan local, et disperser laisserait des trous d'une cellule que rien ne
 * comblerait.
 *
 * ## La projection n'est evaluee que sur un treillis
 *
 * Douze millions de cellules, chacune demandant un probleme direct geodesique
 * complet, feraient plusieurs secondes de trigonometrie. Or la fonction est
 * lisse : on l'evalue **exactement** sur un treillis de 65 par 65 et on
 * interpole bilineairement entre.
 *
 * L'erreur de cette interpolation se majore par `h^2 |f''| / 8`. La seule
 * non-linearite notable est celle de la longitude avec la latitude,
 * `tan(phi) / (R^2 cos(phi))`. Au niveau le plus grossier, un bloc de treillis
 * vaut quatorze kilometres et l'erreur ressort a **sept metres** — pour une
 * cellule qui en mesure quatre cent quarante. Au niveau fin elle tombe a trois
 * centimetres.
 *
 * ## Le remplissage rend la main
 *
 * Le rassemblement est decoupe en blocs de lignes, avec un rendu de la main
 * entre deux. Sans cela, une seconde entiere de calcul bloquerait le fil
 * principal — donc l'image — pendant que la pyramide se construit.
 *
 * ## Ce module ne tourne qu'au navigateur
 *
 * Le decodage passe par `createImageBitmap` et un canevas hors ecran. La partie
 * calculable — geodesie, decodage terrarium, echantillonnage — vit dans les
 * modules voisins, et c'est elle que la validation controle.
 */
import { fetchBinary } from '@/data-sources/fetchJson'
import {
  CLIPMAP_HALF_SPANS_M,
  CLIPMAP_SIZE,
  createClipmap,
  sampleClipmap,
  type ClipmapLevel,
  type ElevationClipmap,
} from './elevationClipmap'
import {
  TILE_SIZE,
  enuToGeodetic,
  geodeticToEnu,
  lonLatToTile,
  tileGroundResolutionM,
  tileToLonLat,
  zoomForResolution,
} from './geodesy'
import {
  TERRARIUM_MAX_ZOOM,
  decodeTerrariumTile,
  terrainSurfaceM,
  terrariumUrl,
} from './terrarium'

/** Cote du treillis sur lequel la projection est evaluee exactement. */
const LATTICE = 65

/** Lignes remplies avant de rendre la main au navigateur. */
const ROWS_PER_CHUNK = 128

/** Requetes simultanees. Au-dela, le navigateur les met en file lui-meme. */
const CONCURRENCY = 8

/** Un mois : le relief ne bouge pas, et le cache evite de tout retelecharger. */
const TILE_TTL_MS = 30 * 24 * 3600 * 1000

export interface ElevationProgress {
  /** Tuiles recuperees, toutes qualites confondues. */
  done: number
  /** Tuiles attendues. */
  total: number
  /** Tuiles que le reseau n'a pas rendues — leur zone reste au niveau de la mer. */
  failed: number
  /** Niveaux prets. */
  levelsReady: number
}

/** Etat du module : une seule pyramide a la fois, celle du site courant. */
let current: ElevationClipmap | null = null
let currentKey = ''
let loading: Promise<void> | null = null

/**
 * Altitude en un point du plan local, m.
 *
 * Rend zero tant que rien n'est charge — le niveau de la mer est la seule
 * valeur qu'on puisse affirmer sans donnee, et elle laisse le globe intact.
 */
export function elevationM(eastM: number, northM: number): number {
  return current ? sampleClipmap(current, eastM, northM) : 0
}

/** Vrai des qu'au moins un niveau porte du relief. */
export const elevationReady = (): boolean =>
  current !== null && current.levels.some((level) => level.ready)

/**
 * Nombre de niveaux remplis.
 *
 * Sert de revision : les niveaux arrivent l'un apres l'autre, et tout ce qui a
 * echantillonne le relief avant doit etre reconstruit a chaque palier.
 */
export const readyLevelCount = (): number =>
  current ? current.levels.filter((level) => level.ready).length : 0

/**
 * Point le plus haut charge, m.
 *
 * C'est lui qui fixe la portee du maillage : un sommet se voit de
 * `sqrt(2 R h)` plus loin que l'horizon, et porter au-dela ne ferait que
 * mailler du vide.
 */
export const maxElevationM = (): number =>
  current ? current.levels.reduce((best, level) => Math.max(best, level.maxHeightM), 0) : 0

/** Cle d'un site, arrondie pour ne pas relancer sur un dixieme de seconde d'arc. */
const siteKey = (latitudeDeg: number, longitudeDeg: number): string =>
  `${latitudeDeg.toFixed(3)}:${longitudeDeg.toFixed(3)}`

/** Decode une tuile PNG en altitudes signees. Navigateur uniquement. */
export async function decodeTile(raw: ArrayBuffer): Promise<Int16Array> {
  const bitmap = await createImageBitmap(new Blob([raw], { type: 'image/png' }))
  try {
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('canevas hors ecran indisponible')
    context.drawImage(bitmap, 0, 0)
    return decodeTerrariumTile(context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data)
  } finally {
    bitmap.close()
  }
}

/**
 * Lecture bilineaire dans le jeu de tuiles d'un niveau.
 *
 * Traverse les bords : un point tombant sur la derniere colonne d'une tuile
 * interpole avec la premiere colonne de sa voisine. Sans cela, une couture d'un
 * pixel apparaitrait a chaque limite de tuile — invisible sur la carte, mais
 * pas sur une crete vue de profil.
 */
function sampleTiles(
  tiles: Map<string, Int16Array>,
  zoom: number,
  longitudeDeg: number,
  latitudeDeg: number,
): number {
  const { x, y } = lonLatToTile(longitudeDeg, latitudeDeg, zoom)
  // Coordonnee en pixels sur la grille mondiale du zoom, recentree sur les
  // centres de pixel.
  const px = x * TILE_SIZE - 0.5
  const py = y * TILE_SIZE - 0.5
  const x0 = Math.floor(px)
  const y0 = Math.floor(py)
  const tx = px - x0
  const ty = py - y0

  const at = (gx: number, gy: number): number => {
    const tileX = Math.floor(gx / TILE_SIZE)
    const tileY = Math.floor(gy / TILE_SIZE)
    const tile = tiles.get(`${tileX}/${tileY}`)
    if (!tile) return 0
    const ix = gx - tileX * TILE_SIZE
    const iy = gy - tileY * TILE_SIZE
    return tile[iy * TILE_SIZE + ix]
  }

  const a = at(x0, y0)
  const b = at(x0 + 1, y0)
  const c = at(x0, y0 + 1)
  const d = at(x0 + 1, y0 + 1)
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

/** Rend la main au navigateur, pour qu'il dessine une image. */
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Treillis des coordonnees geodesiques d'un niveau.
 *
 * Deux tableaux de `LATTICE^2`, lus ensuite par interpolation — voir l'en-tete.
 */
function buildLattice(level: ClipmapLevel, latitudeDeg: number, longitudeDeg: number) {
  const lat = new Float64Array(LATTICE * LATTICE)
  const lon = new Float64Array(LATTICE * LATTICE)
  for (let j = 0; j < LATTICE; j++) {
    const northM = -level.halfSpanM + (2 * level.halfSpanM * j) / (LATTICE - 1)
    for (let i = 0; i < LATTICE; i++) {
      const eastM = -level.halfSpanM + (2 * level.halfSpanM * i) / (LATTICE - 1)
      const g = enuToGeodetic(latitudeDeg, longitudeDeg, eastM, northM)
      lat[j * LATTICE + i] = g.latitudeDeg
      lon[j * LATTICE + i] = g.longitudeDeg
    }
  }
  return { lat, lon }
}

/**
 * Les tuiles couvrant un niveau, deduites de l'etendue du treillis.
 *
 * Le domaine stocke est un **carre**, mais rien ne lit ses coins : le maillage
 * du relief est un disque centre sur l'observateur, et la carte d'ombre un carre
 * bien plus petit. On ecarte donc les tuiles qui n'intersectent pas le disque de
 * rayon `halfSpanM` — un cinquieme du telechargement, pour du terrain que
 * personne ne regarderait.
 */
function tilesFor(
  level: ClipmapLevel,
  latitudeDeg: number,
  longitudeDeg: number,
  lattice: { lat: Float64Array; lon: Float64Array },
): Array<{ x: number; y: number }> {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let k = 0; k < lattice.lat.length; k++) {
    const { x, y } = lonLatToTile(lattice.lon[k], lattice.lat[k], level.zoom)
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const span = 2 ** level.zoom
  const wrap = (v: number) => ((v % span) + span) % span

  // Rayon d'acceptation : le disque utile, elargi de la demi-diagonale d'une
  // tuile pour qu'une tuile qui **effleure** le disque soit gardee.
  const tileSideM = tileGroundResolutionM(latitudeDeg, level.zoom) * TILE_SIZE
  const reachM = level.halfSpanM + tileSideM * Math.SQRT1_2

  const out: Array<{ x: number; y: number }> = []
  for (let ty = Math.floor(minY); ty <= Math.floor(maxY); ty++) {
    if (ty < 0 || ty >= span) continue
    for (let tx = Math.floor(minX); tx <= Math.floor(maxX); tx++) {
      const centre = tileToLonLat(tx + 0.5, ty + 0.5, level.zoom)
      const offset = geodeticToEnu(
        latitudeDeg,
        longitudeDeg,
        centre.latitudeDeg,
        centre.longitudeDeg,
      )
      if (Math.hypot(offset.eastM, offset.northM) > reachM) continue
      out.push({ x: wrap(tx), y: ty })
    }
  }
  return out
}

/** Recupere un lot de tuiles, quelques-unes a la fois. */
async function fetchTiles(
  zoom: number,
  wanted: ReadonlyArray<{ x: number; y: number }>,
  onTile: () => void,
): Promise<{ tiles: Map<string, Int16Array>; failed: number }> {
  const tiles = new Map<string, Int16Array>()
  let failed = 0
  let next = 0

  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= wanted.length) return
      const { x, y } = wanted[index]
      try {
        const raw = await fetchBinary(
          terrariumUrl(zoom, x, y),
          { key: `terrarium:${zoom}/${x}/${y}`, ttlMs: TILE_TTL_MS, timeoutMs: 12_000, attempts: 2 },
          (buffer) => buffer,
        )
        if (raw) tiles.set(`${x}/${y}`, await decodeTile(raw.value))
        else failed++
      } catch {
        // Une tuile manquante laisse sa zone au niveau de la mer. C'est
        // localement faux, mais c'est visible et borne — bien preferable a une
        // exception qui priverait de relief tout le reste du disque.
        failed++
      }
      onTile()
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker))
  return { tiles, failed }
}

/** Remplit un niveau depuis ses tuiles, par blocs de lignes. */
async function fillLevel(
  level: ClipmapLevel,
  lattice: { lat: Float64Array; lon: Float64Array },
  tiles: Map<string, Int16Array>,
): Promise<void> {
  const cellsPerBlock = (CLIPMAP_SIZE - 1) / (LATTICE - 1)

  for (let rowStart = 0; rowStart < CLIPMAP_SIZE; rowStart += ROWS_PER_CHUNK) {
    const rowEnd = Math.min(CLIPMAP_SIZE, rowStart + ROWS_PER_CHUNK)
    for (let iz = rowStart; iz < rowEnd; iz++) {
      const fz = iz / cellsPerBlock
      const j0 = Math.min(LATTICE - 2, Math.floor(fz))
      const wz = fz - j0

      for (let ix = 0; ix < CLIPMAP_SIZE; ix++) {
        const fx = ix / cellsPerBlock
        const i0 = Math.min(LATTICE - 2, Math.floor(fx))
        const wx = fx - i0

        const k00 = j0 * LATTICE + i0
        const k10 = k00 + 1
        const k01 = k00 + LATTICE
        const k11 = k01 + 1
        const lat =
          (lattice.lat[k00] * (1 - wx) + lattice.lat[k10] * wx) * (1 - wz) +
          (lattice.lat[k01] * (1 - wx) + lattice.lat[k11] * wx) * wz
        const lon =
          (lattice.lon[k00] * (1 - wx) + lattice.lon[k10] * wx) * (1 - wz) +
          (lattice.lon[k01] * (1 - wx) + lattice.lon[k11] * wx) * wz

        // L'ecretage bathymetrique appartient a la surface, pas au decodage.
        const h = Math.round(terrainSurfaceM(sampleTiles(tiles, level.zoom, lon, lat)))
        level.heightM[iz * CLIPMAP_SIZE + ix] = h
        if (h > level.maxHeightM) level.maxHeightM = h
      }
    }
    await yieldToBrowser()
  }
  level.ready = true
}

/**
 * Charge le relief autour d'un site.
 *
 * Idempotent : rappelee pour le meme site, elle rend la meme promesse. Les
 * niveaux deviennent utilisables **au fur et a mesure**, du plus fin au plus
 * grossier — c'est le proche qui compte le plus a l'oeil, et c'est aussi le
 * moins de tuiles a attendre.
 */
export function loadElevationAround(
  latitudeDeg: number,
  longitudeDeg: number,
  onProgress?: (progress: ElevationProgress) => void,
): Promise<void> {
  const key = siteKey(latitudeDeg, longitudeDeg)
  if (key === currentKey && loading) return loading

  currentKey = key
  // Resolution visee par niveau : celle de sa propre cellule. Demander plus fin
  // ne ferait que telecharger de l'interpolation — voir `terrarium`.
  const zooms = CLIPMAP_HALF_SPANS_M.map((halfSpanM) =>
    Math.min(
      TERRARIUM_MAX_ZOOM,
      zoomForResolution(latitudeDeg, (2 * halfSpanM) / (CLIPMAP_SIZE - 1)),
    ),
  )
  const clipmap = createClipmap(latitudeDeg, longitudeDeg, zooms)
  current = clipmap

  loading = (async () => {
    let done = 0
    let failed = 0
    let total = 0
    const plans = clipmap.levels.map((level) => {
      const lattice = buildLattice(level, latitudeDeg, longitudeDeg)
      const wanted = tilesFor(level, latitudeDeg, longitudeDeg, lattice)
      total += wanted.length
      return { level, lattice, wanted }
    })

    const report = () =>
      onProgress?.({
        done,
        total,
        failed,
        levelsReady: clipmap.levels.filter((level) => level.ready).length,
      })
    report()

    for (const plan of plans) {
      // Un site change en cours de route abandonne le chargement precedent :
      // remplir une pyramide que plus personne ne lit gaspillerait le fil
      // principal au pire moment.
      if (currentKey !== key) return
      const { tiles, failed: missed } = await fetchTiles(plan.level.zoom, plan.wanted, () => {
        done++
        report()
      })
      failed += missed
      if (currentKey !== key) return
      await fillLevel(plan.level, plan.lattice, tiles)
      report()
    }
  })()

  return loading
}
