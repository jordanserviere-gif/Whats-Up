/**
 * Table de refraction — la meme physique, au prix d'une lecture.
 *
 * ## Pourquoi une table
 *
 * `refractionForApparent` integre le long du rayon : 512 pas, trois evaluations
 * de l'indice de Ciddor par pas. Mesure : **0,2 ms par appel**, et 1,6 ms pour
 * l'inversion vers la hauteur apparente. Dix astres coutent alors 14 ms — presque
 * une image entiere a 60 Hz — et les etoiles se comptent par milliers.
 *
 * La table ne change rien a la physique. Elle evite de la recalculer.
 *
 * ## Le sens de construction evite l'inversion
 *
 * L'integrale part naturellement de la hauteur **apparente**. Le rendu, lui,
 * connait la hauteur **vraie** et cherche l'apparente : il faudrait donc
 * inverser, ce qui coute huit iterations de Newton par appel.
 *
 * La table contourne le probleme : elle est construite sur une grille de
 * hauteurs **apparentes**, dont on deduit les hauteurs vraies par simple
 * soustraction. La suite obtenue est croissante, et la lecture dans l'autre sens
 * n'est plus qu'une recherche dichotomique. **L'inversion disparait.**
 *
 * ## Le maillage
 *
 * `a = a_min + (90 − a_min)·u²` concentre les entrees pres de l'horizon, ou la
 * refraction varie de dix minutes d'arc par degre, et les espace vers le zenith,
 * ou elle ne bouge plus. C'est la meme raison qui gouverne la parametrisation
 * verticale de la table de ciel.
 *
 * ## Ce que la table porte, et ce qu'elle ne porte pas
 *
 * Elle est construite pour **une** longueur d'onde, **une** altitude
 * d'observateur et **un** jeu de conditions au sol. Aucun des trois ne change
 * d'une image a l'autre : la table se construit une fois.
 *
 * La longueur d'onde merite un mot. La refraction est chromatique — 54 secondes
 * d'arc d'ecart entre 400 et 700 nm a l'horizon, soit 2,8 % du diametre solaire.
 * Une table par canal donnerait le liseré coloré du limbe, et donc le rayon
 * vert. Ce n'est pas fait ici : la position d'un astre se traite a 550 nm, et le
 * traitement spectral du disque est un travail de rendu, pas de transport.
 */
import { radToDeg } from '../core/units'
import { ATMOSPHERE_TOP_M } from '../transport/slantPath'
import { standardAirIndexAt } from './airIndex'
import { refractionForApparent, scaledIndexProfile, type RayBendingOptions } from './rayBending'

export interface RefractionTable {
  /** Hauteurs apparentes de la grille, degres — croissantes. */
  readonly apparentDeg: Float64Array
  /** Hauteurs vraies correspondantes, degres — croissantes elles aussi. */
  readonly trueDeg: Float64Array
  /** Hauteur vraie la plus basse encore visible, degres. */
  readonly horizonTrueDeg: number
  /** Refraction a l'horizon apparent, degres. */
  readonly horizonRefractionDeg: number
}

export interface RefractionTableOptions extends RayBendingOptions {
  /** Nombre d'entrees. */
  count?: number
}

/**
 * Profil d'indice tabule, pour que la construction reste abordable.
 *
 * Sans lui, chaque pas de chaque integrale appelle Ciddor trois fois : la
 * construction de la table coute alors une centaine de millisecondes. Avec, elle
 * en coute quelques-unes.
 *
 * L'espacement est **quadratique** : le premier intervalle fait dix centimetres,
 * ce qui est plus fin que le pas de derivation d'un metre — l'interpolation
 * lineaire ne peut donc pas lisser le gradient qu'on cherche a mesurer.
 */
export function tabulatedIndexProfile(
  base: (altitudeM: number) => number,
  count = 1024,
  topAltitudeM = ATMOSPHERE_TOP_M,
): (altitudeM: number) => number {
  const values = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    values[i] = base(topAltitudeM * (i / (count - 1)) ** 2)
  }
  // Pente du premier intervalle, pour prolonger sous le sol.
  const firstStep = topAltitudeM * (1 / (count - 1)) ** 2
  const groundSlope = (values[1] - values[0]) / firstStep

  return (altitudeM: number) => {
    // **Extrapolation sous le sol, et non ecretage.** La derivee du profil est
    // prise par difference finie sur un metre : a dix centimetres d'altitude,
    // elle interroge donc `n(−0,9 m)`. Ecreter y rendrait `n(0)`, ce qui **halve
    // le gradient** au ras du sol — la ou la refraction a l'horizon se joue
    // presque entierement. Mesure de l'erreur ainsi introduite : 9,3 secondes
    // d'arc sur les 33 minutes de la refraction horizontale.
    if (altitudeM <= 0) return values[0] + groundSlope * altitudeM
    if (altitudeM >= topAltitudeM) return values[count - 1]
    const u = Math.sqrt(altitudeM / topAltitudeM) * (count - 1)
    const i = Math.min(count - 2, Math.floor(u))
    const t = u - i
    return values[i] * (1 - t) + values[i + 1] * t
  }
}

/**
 * Construit la table.
 *
 * `minApparentDeg` peut descendre sous zero pour un observateur en hauteur, ou
 * la depression de l'horizon rend visible une portion de ciel sous l'horizontale.
 */
export function buildRefractionTable(options: RefractionTableOptions = {}): RefractionTable {
  const { count = 512, lambdaNm = 550, surface, observerElevationM = 0 } = options

  const raw =
    options.indexAt ?? (surface ? scaledIndexProfile(lambdaNm, surface) : (h: number) => standardAirIndexAt(h, lambdaNm))
  const indexAt = tabulatedIndexProfile(raw)
  const integration: RayBendingOptions = { ...options, lambdaNm, indexAt, observerElevationM }

  const apparentDeg = new Float64Array(count)
  const trueDeg = new Float64Array(count)

  for (let i = 0; i < count; i++) {
    const u = i / (count - 1)
    // Concentre pres de l'horizon, ou la refraction varie de dix minutes d'arc
    // par degre ; espace vers le zenith, ou elle ne bouge plus.
    const apparent = 90 * u * u
    const refraction = radToDeg(refractionForApparent(apparent, integration))
    apparentDeg[i] = apparent
    trueDeg[i] = apparent - refraction
  }

  return {
    apparentDeg,
    trueDeg,
    horizonTrueDeg: trueDeg[0],
    horizonRefractionDeg: apparentDeg[0] - trueDeg[0],
  }
}

/**
 * Hauteur apparente d'un astre de hauteur vraie connue.
 *
 * Sous `horizonTrueDeg`, l'astre est sous l'horizon apparent : la fonction rend
 * la valeur vraie telle quelle, faute de rayon qui parvienne a l'observateur.
 * C'est au rendu de decider qu'il n'y a rien a montrer.
 */
export function apparentFromTable(table: RefractionTable, trueAltitudeDeg: number): number {
  const { trueDeg, apparentDeg } = table
  const last = trueDeg.length - 1
  if (trueAltitudeDeg <= trueDeg[0]) return trueAltitudeDeg
  if (trueAltitudeDeg >= trueDeg[last]) return trueAltitudeDeg

  // Dichotomie : la suite des hauteurs vraies est croissante par construction,
  // tant que `dR/da > −1` — ce qui est le cas dans toute atmosphere sans
  // conduit.
  let low = 0
  let high = last
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (trueDeg[mid] <= trueAltitudeDeg) low = mid
    else high = mid
  }
  const span = trueDeg[high] - trueDeg[low]
  const t = span > 0 ? (trueAltitudeDeg - trueDeg[low]) / span : 0
  return apparentDeg[low] * (1 - t) + apparentDeg[high] * t
}

/**
 * Taux de dilatation vertical local, `da_apparente/da_vraie`.
 *
 * **C'est le Soleil aplati.** La refraction decroit quand la hauteur augmente :
 * le limbe inferieur d'un disque est donc releve davantage que le superieur, et
 * le disque s'ecrase. Le diametre horizontal, lui, n'est pas touche — d'ou un
 * ovale et non un disque plus petit.
 *
 * Le facteur sort de la pente de la meme table que la position. Il n'y a ni
 * parametre, ni courbe d'ajustement : c'est une derivee.
 */
export function verticalScaleFromTable(table: RefractionTable, trueAltitudeDeg: number): number {
  const eps = 0.05
  const up = apparentFromTable(table, trueAltitudeDeg + eps)
  const down = apparentFromTable(table, trueAltitudeDeg - eps)
  return (up - down) / (2 * eps)
}

/** L'astre est-il au-dessus de l'horizon apparent ? */
export function isVisible(table: RefractionTable, trueAltitudeDeg: number): boolean {
  return trueAltitudeDeg > table.horizonTrueDeg
}
