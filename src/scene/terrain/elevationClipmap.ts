/**
 * Pyramide d'altitudes centree sur l'observateur.
 *
 * ## Pourquoi une pyramide, et pas une grille
 *
 * Quatre cent cinquante kilometres de rayon a trente metres feraient neuf cents
 * millions de points — trois gigaoctets et demi. Impossible, et surtout inutile :
 * ce que l'oeil resout n'est pas une longueur mais un **angle**. A cinquante
 * degres de champ sur mille quatre cent quarante pixels, un pixel vaut 0,0347°,
 * donc un echantillon utile mesure `distance x 6,06e-4` :
 *
 *     a  25 km :  15 m
 *     a 100 km :  61 m
 *     a 450 km : 273 m
 *
 * Trois niveaux de meme taille en memoire suffisent donc a couvrir toute la
 * portee en restant partout autour de deux pixels par cellule :
 *
 *     niveau  demi-etendue    pas     source
 *     L2         28 km       27 m     z=12
 *     L1        112 km      110 m     z=10
 *     L0        450 km      440 m     z=8
 *
 * La memoire est **fixe** — trois fois 2048 en Int16, soit 25 Mo — et ne depend
 * ni du rayon demande ni du nombre de tuiles telechargees.
 *
 * ## Int16 plutot que Float32
 *
 * Le metre est trois fois plus fin que le bruit de la source, et l'Everest tient
 * dans un entier signe de seize bits. Le Float32 doublerait l'empreinte pour
 * decrire une precision que la donnee n'a pas.
 *
 * ## La couture entre niveaux
 *
 * Deux niveaux voisins ne viennent pas du meme zoom : leurs altitudes different
 * de quelques metres sur un meme point, et un basculement franc dessinerait un
 * anneau visible autour de l'observateur. On fond donc lineairement sur la
 * frange exterieure de chaque niveau, la ou les deux sont definis.
 */

/** Cote de chaque niveau, en cellules. */
export const CLIPMAP_SIZE = 2048

/**
 * Largeur de la frange de fondu, en fraction de la demi-etendue.
 *
 * Assez large pour que le fondu s'etale sur plusieurs dizaines de cellules,
 * assez etroite pour ne pas gaspiller la resolution du niveau fin.
 */
const BLEND_FRACTION = 0.12

export interface ClipmapLevel {
  /** Demi-etendue couverte, m. */
  readonly halfSpanM: number
  /** Zoom de tuiles dont ce niveau est rempli. */
  readonly zoom: number
  /** Altitudes, m, indexees `[iNorth * CLIPMAP_SIZE + iEast]`. */
  readonly heightM: Int16Array
  /** Distance entre deux cellules, m. */
  readonly stepM: number
  /** Faux tant que le niveau n'a pas ete rempli. */
  ready: boolean
  /**
   * Point le plus haut du niveau, m.
   *
   * Releve pendant le remplissage plutot que par un balayage separe : c'est lui
   * qui fixe jusqu'ou le maillage doit porter, puisqu'un sommet se voit de
   * `sqrt(2 R h)` plus loin que l'horizon.
   */
  maxHeightM: number
}

export interface ElevationClipmap {
  /** Du plus fin au plus grossier. */
  readonly levels: readonly ClipmapLevel[]
  /** Site sur lequel la pyramide est centree. */
  readonly latitudeDeg: number
  readonly longitudeDeg: number
}

/** Demi-etendues des trois niveaux, du plus fin au plus grossier, m. */
export const CLIPMAP_HALF_SPANS_M = [28_000, 112_500, 450_000] as const

/**
 * Alloue une pyramide vide pour un site.
 *
 * Les zooms sont choisis pour que la resolution des tuiles colle a celle du
 * niveau : demander plus fin ne ferait que telecharger de l'interpolation, et
 * plus grossier laisserait des marches d'escalier.
 */
export function createClipmap(
  latitudeDeg: number,
  longitudeDeg: number,
  zooms: readonly number[],
): ElevationClipmap {
  if (zooms.length !== CLIPMAP_HALF_SPANS_M.length) {
    throw new Error('un zoom par niveau est attendu')
  }
  const levels = CLIPMAP_HALF_SPANS_M.map((halfSpanM, i) => ({
    halfSpanM,
    zoom: zooms[i],
    heightM: new Int16Array(CLIPMAP_SIZE * CLIPMAP_SIZE),
    stepM: (2 * halfSpanM) / (CLIPMAP_SIZE - 1),
    ready: false,
    maxHeightM: 0,
  }))
  return { levels, latitudeDeg, longitudeDeg }
}

/** Position, en metres, du centre d'une cellule. */
export const clipmapCellEastM = (level: ClipmapLevel, i: number): number =>
  i * level.stepM - level.halfSpanM

/**
 * Lecture bilineaire d'un niveau. Rend `null` hors du domaine couvert.
 *
 * Le `null` distingue « hors du niveau » de « altitude nulle », que le niveau
 * de la mer rend autrement indiscernables.
 */
function sampleLevel(level: ClipmapLevel, eastM: number, northM: number): number | null {
  if (!level.ready) return null
  const fx = (eastM + level.halfSpanM) / level.stepM
  const fz = (northM + level.halfSpanM) / level.stepM
  if (fx < 0 || fz < 0 || fx > CLIPMAP_SIZE - 1 || fz > CLIPMAP_SIZE - 1) return null
  const ix = Math.min(CLIPMAP_SIZE - 2, Math.floor(fx))
  const iz = Math.min(CLIPMAP_SIZE - 2, Math.floor(fz))
  const tx = fx - ix
  const tz = fz - iz
  const h = level.heightM
  const a = h[iz * CLIPMAP_SIZE + ix]
  const b = h[iz * CLIPMAP_SIZE + ix + 1]
  const c = h[(iz + 1) * CLIPMAP_SIZE + ix]
  const d = h[(iz + 1) * CLIPMAP_SIZE + ix + 1]
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz
}

/**
 * Altitude en un point du plan local, m.
 *
 * Prend le niveau le plus fin qui contient le point, et fond vers le suivant sur
 * la frange exterieure — voir l'en-tete. Hors de tout niveau, rend zero : le
 * niveau de la mer est la seule valeur qu'on puisse affirmer sans donnee.
 */
export function sampleClipmap(clipmap: ElevationClipmap, eastM: number, northM: number): number {
  const { levels } = clipmap
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]
    const fine = sampleLevel(level, eastM, northM)
    if (fine === null) continue

    // A quelle profondeur dans la frange sommes-nous ? Zero au coeur du niveau,
    // un a son bord. La distance de Tchebychev, et non l'euclidienne : le
    // domaine est un carre.
    const reach = Math.max(Math.abs(eastM), Math.abs(northM)) / level.halfSpanM
    const blendStart = 1 - BLEND_FRACTION
    if (reach <= blendStart || i === levels.length - 1) return fine

    const coarse = sampleLevel(levels[i + 1], eastM, northM)
    if (coarse === null) return fine
    const t = (reach - blendStart) / BLEND_FRACTION
    return fine * (1 - t) + coarse * t
  }
  return 0
}

/** Vrai des que le niveau le plus grossier porte quelque chose a montrer. */
export const clipmapHasCoverage = (clipmap: ElevationClipmap): boolean =>
  clipmap.levels.some((level) => level.ready)
