/**
 * Le champ proche — sept kilometres de relief a trois metres.
 *
 * ## Pourquoi il n'est pas un quatrieme niveau de la pyramide
 *
 * Il aurait ete tentant d'ajouter un niveau a `elevationClipmap`, et ce serait
 * faux : ce grille-la ne partage rien avec les trois autres. Elle vient d'une
 * **autre source** — l'IGN plutot qu'AWS —, d'une **autre projection** —
 * geographique plutot que Mercator —, elle stocke ses altitudes au quart de
 * metre et non au metre, et elle **n'existe qu'en France**. Prendre trois de ces
 * differences pour des details afin de gagner une case dans un tableau aurait
 * produit une abstraction qui ment.
 *
 * Elle se compose donc plutot qu'elle ne s'insere : `groundAltitudeM` la lit en
 * premier, et retombe sur la pyramide partout ou elle se tait.
 *
 * ## ⚠️ Le quart de metre, et pourquoi le metre ne suffisait pas
 *
 * La pyramide stocke des entiers de seize bits en **metres**, ce qui est trois
 * fois plus fin que le bruit d'une source a trente metres. Mais le denivele
 * type entre deux points distants de 3,4 metres vaut **1,01 metre** : arrondir
 * au metre detruirait donc la moitie de ce qu'on est venu chercher.
 *
 * L'unite est le quart de metre. Seize bits signes portent alors ±8191 metres,
 * de quoi loger le Mont Blanc trois fois.
 *
 * ## L'etendue, qui vient du budget et non du gout
 *
 * Deux mille quarante-huit points sur sept kilometres font **3,42 metres par
 * cellule** — le pas du RGE ALTI a la latitude de la France, a un centieme
 * pres. Prendre plus large diluerait la source ; prendre plus etroit gacherait
 * des tuiles deja telechargees. Huit megaoctets, et une cinquantaine de tuiles.
 */
import { enuToGeodetic } from './geodesy'
import {
  RGE_ALTI_TILE_SIZE,
  fetchRgeAltiTile,
  rgeAltiTile,
  rgeAltiResolutionM,
} from './rgeAlti'

/** Demi-etendue couverte, metres. */
export const NEAR_FIELD_HALF_SPAN_M = 3_500

/** Cote de la grille, en cellules. */
export const NEAR_FIELD_SIZE = 2048

/** Metres represents par une unite stockee — voir l'en-tete. */
export const NEAR_FIELD_UNIT_M = 0.25

/** Distance entre deux cellules, metres. */
export const NEAR_FIELD_STEP_M = (2 * NEAR_FIELD_HALF_SPAN_M) / (NEAR_FIELD_SIZE - 1)

/**
 * Largeur de la frange de fondu, en fraction de la demi-etendue.
 *
 * Les deux sources ne donnent pas exactement la meme altitude au meme point —
 * elles n'ont ni la meme resolution ni tout a fait le meme systeme altimetrique.
 * Un basculement franc dessinerait un anneau visible ; on fond donc sur le bord,
 * comme le fait deja la pyramide entre ses niveaux.
 */
const BLEND_FRACTION = 0.15

interface NearField {
  readonly heights: Int16Array
  readonly latitudeDeg: number
  readonly longitudeDeg: number
  ready: boolean
}

let field: NearField | null = null
let loading: Promise<boolean> | null = null
let loadedKey = ''

/** Vrai quand un champ proche est disponible pour le site courant. */
export const nearFieldReady = (): boolean => field?.ready === true

/** Cle a inclure dans les memoisations qui echantillonnent le relief. */
export const nearFieldRevision = (): string => (field?.ready ? `proche:${loadedKey}` : 'proche:0')

/**
 * Altitude en un point du plan local, metres. `null` hors du domaine.
 *
 * Le `null` distingue « je ne sais pas » de « altitude nulle », que le niveau de
 * la mer rend autrement indiscernables.
 */
export function nearAltitudeM(eastM: number, northM: number): number | null {
  if (!field?.ready) return null
  const fx = (eastM + NEAR_FIELD_HALF_SPAN_M) / NEAR_FIELD_STEP_M
  const fz = (northM + NEAR_FIELD_HALF_SPAN_M) / NEAR_FIELD_STEP_M
  if (fx < 0 || fz < 0 || fx > NEAR_FIELD_SIZE - 1 || fz > NEAR_FIELD_SIZE - 1) return null
  const ix = Math.min(NEAR_FIELD_SIZE - 2, Math.floor(fx))
  const iz = Math.min(NEAR_FIELD_SIZE - 2, Math.floor(fz))
  const tx = fx - ix
  const tz = fz - iz
  const h = field.heights
  const a = h[iz * NEAR_FIELD_SIZE + ix]
  const b = h[iz * NEAR_FIELD_SIZE + ix + 1]
  const c = h[(iz + 1) * NEAR_FIELD_SIZE + ix]
  const d = h[(iz + 1) * NEAR_FIELD_SIZE + ix + 1]
  const units = (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz
  return units * NEAR_FIELD_UNIT_M
}

/**
 * Poids du champ proche en un point : un au coeur, zero au-dela du bord.
 *
 * Expose pour que la composition avec la pyramide vive dans un seul endroit et
 * puisse etre validee sans rendu.
 */
export function nearFieldWeight(eastM: number, northM: number): number {
  const reach = Math.max(Math.abs(eastM), Math.abs(northM)) / NEAR_FIELD_HALF_SPAN_M
  const start = 1 - BLEND_FRACTION
  if (reach <= start) return 1
  if (reach >= 1) return 0
  const t = (reach - start) / BLEND_FRACTION
  // Meme lissage que partout ailleurs : la derivee s'annule aux deux bouts, donc
  // aucune arete ne se lit sur la pente.
  return 1 - t * t * (3 - 2 * t)
}

/** Rend la main au navigateur entre deux tranches de remplissage. */
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Lignes remplies entre deux respirations. */
const ROWS_PER_CHUNK = 64

/** Points du treillis geodesique — la conversion exacte est chere, on l'interpole. */
const LATTICE = 17

/**
 * Charge le champ proche autour d'un site.
 *
 * Rend `false` hors couverture : c'est le cas normal partout hors de France, et
 * l'appelant se contente alors de la pyramide mondiale.
 *
 * Idempotent pour un meme site.
 */
export async function loadNearField(latitudeDeg: number, longitudeDeg: number): Promise<boolean> {
  const key = `${latitudeDeg.toFixed(4)},${longitudeDeg.toFixed(4)}`
  if (loadedKey === key && loading) return loading
  loadedKey = key
  field = null
  loading = fill(latitudeDeg, longitudeDeg, key)
  return loading
}

async function fill(latitudeDeg: number, longitudeDeg: number, key: string): Promise<boolean> {
  // --- Le treillis geodesique -------------------------------------------
  //
  // Convertir chaque cellule coute une racine et deux arctangentes ; sur quatre
  // millions de cellules c'est plusieurs secondes. Sur sept kilometres la
  // conversion est quasi affine, et dix-sept points par cote suffisent
  // largement — l'ecart residuel se compte en centimetres.
  const lat = new Float64Array(LATTICE * LATTICE)
  const lon = new Float64Array(LATTICE * LATTICE)
  for (let j = 0; j < LATTICE; j++) {
    const northM = -NEAR_FIELD_HALF_SPAN_M + (2 * NEAR_FIELD_HALF_SPAN_M * j) / (LATTICE - 1)
    for (let i = 0; i < LATTICE; i++) {
      const eastM = -NEAR_FIELD_HALF_SPAN_M + (2 * NEAR_FIELD_HALF_SPAN_M * i) / (LATTICE - 1)
      const g = enuToGeodetic(latitudeDeg, longitudeDeg, eastM, northM)
      lat[j * LATTICE + i] = g.latitudeDeg
      lon[j * LATTICE + i] = g.longitudeDeg
    }
  }

  // --- Les tuiles a demander --------------------------------------------
  const wanted = new Map<string, { col: number; row: number }>()
  for (let k = 0; k < lat.length; k++) {
    const t = rgeAltiTile(lon[k], lat[k])
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const col = t.col + dc
        const row = t.row + dr
        wanted.set(`${col}/${row}`, { col, row })
      }
    }
  }

  const tiles = new Map<string, Float32Array>()
  let missing = 0
  const list = [...wanted.values()]
  // Quatre a la fois : assez pour saturer la liaison, assez peu pour ne pas
  // etouffer les tuiles de la pyramide qui se chargent en meme temps.
  for (let i = 0; i < list.length; i += 4) {
    const batch = list.slice(i, i + 4)
    const got = await Promise.all(batch.map((t) => fetchRgeAltiTile(t.col, t.row)))
    got.forEach((data, n) => {
      if (data) tiles.set(`${batch[n].col}/${batch[n].row}`, data)
      else missing++
    })
    // Hors couverture, les premieres tuiles suffisent a le dire : inutile de
    // demander les cinquante autres pour se l'entendre repeter.
    if (i === 0 && missing === batch.length) return false
  }
  if (tiles.size === 0) return false

  // --- Le remplissage ----------------------------------------------------
  const heights = new Int16Array(NEAR_FIELD_SIZE * NEAR_FIELD_SIZE)
  const cellsPerBlock = (NEAR_FIELD_SIZE - 1) / (LATTICE - 1)
  for (let rowStart = 0; rowStart < NEAR_FIELD_SIZE; rowStart += ROWS_PER_CHUNK) {
    const rowEnd = Math.min(NEAR_FIELD_SIZE, rowStart + ROWS_PER_CHUNK)
    for (let iz = rowStart; iz < rowEnd; iz++) {
      const fz = iz / cellsPerBlock
      const j0 = Math.min(LATTICE - 2, Math.floor(fz))
      const wz = fz - j0
      for (let ix = 0; ix < NEAR_FIELD_SIZE; ix++) {
        const fx = ix / cellsPerBlock
        const i0 = Math.min(LATTICE - 2, Math.floor(fx))
        const wx = fx - i0
        const k00 = j0 * LATTICE + i0
        const k10 = k00 + 1
        const k01 = k00 + LATTICE
        const k11 = k01 + 1
        const la =
          (lat[k00] * (1 - wx) + lat[k10] * wx) * (1 - wz) +
          (lat[k01] * (1 - wx) + lat[k11] * wx) * wz
        const lo =
          (lon[k00] * (1 - wx) + lon[k10] * wx) * (1 - wz) +
          (lon[k01] * (1 - wx) + lon[k11] * wx) * wz
        const h = sampleTiles(tiles, lo, la)
        heights[iz * NEAR_FIELD_SIZE + ix] =
          h === null ? 0 : Math.round(h / NEAR_FIELD_UNIT_M)
      }
    }
    await yieldToBrowser()
  }

  field = { heights, latitudeDeg, longitudeDeg, ready: true }
  loadedKey = key
  return true
}

/** Lecture bilineaire d'un point geographique dans le lot de tuiles. */
function sampleTiles(
  tiles: Map<string, Float32Array>,
  longitudeDeg: number,
  latitudeDeg: number,
): number | null {
  const t = rgeAltiTile(longitudeDeg, latitudeDeg)
  const read = (col: number, row: number, x: number, y: number): number | null => {
    const tile = tiles.get(`${col}/${row}`)
    return tile ? tile[y * RGE_ALTI_TILE_SIZE + x] : null
  }
  // Les quatre voisins peuvent tomber dans des tuiles differentes : on resout
  // chacun par ses propres indices plutot que de supposer qu'ils partagent une
  // tuile, ce qui serait faux sur un bord.
  const x0 = Math.floor(t.x)
  const y0 = Math.floor(t.y)
  const tx = t.x - x0
  const ty = t.y - y0
  const at = (dx: number, dy: number): number | null => {
    let col = t.col
    let row = t.row
    let x = x0 + dx
    let y = y0 + dy
    if (x >= RGE_ALTI_TILE_SIZE) {
      x -= RGE_ALTI_TILE_SIZE
      col += 1
    }
    if (y >= RGE_ALTI_TILE_SIZE) {
      y -= RGE_ALTI_TILE_SIZE
      row += 1
    }
    return read(col, row, x, y)
  }
  const a = at(0, 0)
  const b = at(1, 0)
  const c = at(0, 1)
  const d = at(1, 1)
  if (a === null || b === null || c === null || d === null) return null
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

/** Resolution effective de la source au site, metres — pour les controles. */
export const nearFieldSourceResolutionM = (latitudeDeg: number) => rgeAltiResolutionM(latitudeDeg)
