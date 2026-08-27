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
 * ## Sous l'horizon apparent
 *
 * Il n'y a la, au sens strict, **aucune image** : plus aucun rayon ne parvient a
 * l'observateur, et la hauteur apparente n'est pas definie. Rendre la hauteur
 * vraie telle quelle serait pourtant un mauvais choix — la fonction ferait alors
 * un saut de trente-trois minutes d'arc a la frontiere, et tout ce qui en
 * derive avec elle : la texture lue par les nuanceurs, et le mouvement d'un
 * astre qui se couche.
 *
 * Le prolongement retenu conserve la refraction horizontale : l'astre continue
 * de descendre au meme rythme, en restant sous l'horizon. La fonction reste
 * **continue et croissante**, ce dont dependent l'interpolation de la texture et
 * la lecture par dichotomie.
 *
 * La visibilite ne se decide donc pas au signe du resultat mais par
 * `isVisible`, qui compare a `horizonTrueDeg`.
 */
export function apparentFromTable(table: RefractionTable, trueAltitudeDeg: number): number {
  const { trueDeg, apparentDeg } = table
  const last = trueDeg.length - 1
  if (trueAltitudeDeg <= trueDeg[0]) return trueAltitudeDeg - trueDeg[0]
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
 * Hauteur **vraie** d'un astre vu a une hauteur apparente donnee.
 *
 * L'inverse exact de `apparentFromTable`, et la forme dont a besoin tout ce qui
 * part d'une **direction de visee** pour remonter a sa source : « je regarde
 * la, d'ou vient la lumiere ? »
 *
 * Les deux sens existent parce que les deux questions existent. Placer un astre
 * dont on connait l'ephemeride demande le premier ; echantillonner le ciel dans
 * la direction d'un pixel demande le second. Les confondre ajoute la refraction
 * la ou il faut la retrancher — deux fois l'erreur, soit plus d'un degre a
 * l'horizon.
 */
export function trueFromTable(table: RefractionTable, apparentAltitudeDeg: number): number {
  const { trueDeg, apparentDeg } = table
  const last = apparentDeg.length - 1
  if (apparentAltitudeDeg <= apparentDeg[0]) return apparentAltitudeDeg + trueDeg[0] - apparentDeg[0]
  if (apparentAltitudeDeg >= apparentDeg[last]) return apparentAltitudeDeg

  let low = 0
  let high = last
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (apparentDeg[mid] <= apparentAltitudeDeg) low = mid
    else high = mid
  }
  const span = apparentDeg[high] - apparentDeg[low]
  const t = span > 0 ? (apparentAltitudeDeg - apparentDeg[low]) / span : 0
  return trueDeg[low] * (1 - t) + trueDeg[high] * t
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

// ---------------------------------------------------------------------------
// Application au rendu — phase 12
// ---------------------------------------------------------------------------

/**
 * Table partagee, memoisee par altitude d'observateur.
 *
 * Elle ne depend ni de l'heure, ni de la direction, ni du Soleil : une seule
 * construction pour toute la duree de vie de l'application, tant que
 * l'observateur ne change pas de site. Seize millisecondes, une fois.
 */
/**
 * Y a-t-il une atmosphere ?
 *
 * Le calque « atmosphere » de l'application peut etre eteint : la vue est alors
 * celle qu'on aurait depuis l'espace, ou les rayons redeviennent droits. Ce
 * n'est pas une option de rendu mais un **etat du modele**, et c'est pourquoi le
 * drapeau vit ici plutot que dans la scene : la couche astronomique doit le lire
 * elle aussi, sans quoi une etiquette resterait a la position apparente d'un
 * astre dessine a sa position geometrique.
 */
let refractionEnabled = true
export const setRefractionEnabled = (value: boolean): void => {
  refractionEnabled = value
}
export const isRefractionEnabled = (): boolean => refractionEnabled

const sharedTables = new Map<number, RefractionTable>()
export function sharedRefractionTable(observerElevationM = 0): RefractionTable {
  const key = Math.round(observerElevationM)
  const cached = sharedTables.get(key)
  if (cached) return cached
  const table = buildRefractionTable({ observerElevationM: key })
  sharedTables.set(key, table)
  return table
}

/**
 * Redresse une direction du repere de la scene (+Y zenith).
 *
 * L'azimut est **conserve** : la refraction ne depend que de la hauteur, dans
 * une atmosphere a stratification spherique. C'est ce qui fait qu'un disque
 * s'aplatit sans se retrecir lateralement.
 */
export function refractSceneDirection(
  table: RefractionTable,
  dir: readonly [number, number, number],
): [number, number, number] {
  const length = Math.hypot(dir[0], dir[1], dir[2]) || 1
  const y = Math.max(-1, Math.min(1, dir[1] / length))
  const trueAltitudeDeg = (Math.asin(y) * 180) / Math.PI
  const apparentDeg = apparentFromTable(table, trueAltitudeDeg)
  if (apparentDeg === trueAltitudeDeg) return [dir[0], dir[1], dir[2]]

  const horizontal = Math.hypot(dir[0], dir[2])
  const rad = (apparentDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  if (horizontal < 1e-12) return [0, length * Math.sin(rad), 0]
  const scale = (length * cos) / horizontal
  return [dir[0] * scale, length * Math.sin(rad), dir[2] * scale]
}

/** Largeur de la texture de refraction lue par les nuanceurs. */
export const REFRACTION_LUT_WIDTH = 512

/**
 * Parametrisation de la texture : `u = √((h + 1,2)/91,2)`.
 *
 * Le carre concentre les texels pres de l'horizon, ou la refraction varie de dix
 * minutes d'arc par degre, et les espace vers le zenith ou elle ne bouge plus.
 * Le decalage de 1,2° couvre les astres encore visibles alors qu'ils sont
 * geometriquement couches.
 */
export const refractionLutU = (trueAltitudeDeg: number): number =>
  Math.sqrt(Math.max(0, Math.min(1, (trueAltitudeDeg + 1.2) / 91.2)))

/** Hauteur vraie portee par une coordonnee de texture. */
export const refractionLutAltitude = (u: number): number => u * u * 91.2 - 1.2

/**
 * Remplit la texture : **la refraction**, en degres, et non la hauteur apparente.
 *
 * Stocker l'ecart plutot que la valeur garde le contenu petit et lisse — de zero
 * au zenith a un demi-degre a l'horizon — la ou la hauteur apparente couvrirait
 * quatre-vingt-dix degres. L'erreur d'interpolation porte alors sur la petite
 * quantite, pas sur la grande.
 */
export function fillRefractionLut(target: Float32Array, table: RefractionTable): void {
  const width = target.length / 4
  for (let i = 0; i < width; i++) {
    const trueAltitudeDeg = refractionLutAltitude(i / (width - 1))
    const refraction = apparentFromTable(table, trueAltitudeDeg) - trueAltitudeDeg
    target[i * 4] = refraction
    target[i * 4 + 1] = 0
    target[i * 4 + 2] = 0
    target[i * 4 + 3] = 0
  }
}

/**
 * Echantillonneur GPU.
 *
 * Il redresse une direction du repere de la scene. Les etoiles, le ciel profond
 * et les constellations sont places par rotation d'une direction equatoriale :
 * c'est donc **la** ou la refraction doit entrer pour elles, et le meme calcul
 * est fait sur le processeur pour les corps du systeme solaire — memes valeurs,
 * meme table.
 */
export const REFRACTION_LUT_GLSL = /* glsl */ `
  uniform sampler2D uRefractionLut;
  uniform float uRefractionWidth;
  uniform float uRefractionActive;

  /** Refraction en degres pour une hauteur vraie donnee. */
  float refractionDeg(float trueAltDeg) {
    float u = sqrt(clamp((trueAltDeg + 1.2) / 91.2, 0.0, 1.0));
    float x = 0.5 / uRefractionWidth + u * (1.0 - 1.0 / uRefractionWidth);
    return texture2D(uRefractionLut, vec2(x, 0.5)).r;
  }

  /**
   * Direction redressee. L'azimut est conserve : la refraction ne depend que de
   * la hauteur.
   */
  vec3 refractSceneDirection(vec3 dir) {
    if (uRefractionActive < 0.5) return dir;
    float len = length(dir);
    if (len < 1e-9) return dir;
    vec3 unit = dir / len;
    float trueAlt = degrees(asin(clamp(unit.y, -1.0, 1.0)));
    float apparent = radians(trueAlt + refractionDeg(trueAlt));

    // \`flat\` est un mot reserve du langage — qualificateur d'interpolation.
    // Le nommer ainsi fait echouer la compilation des trois nuanceurs qui
    // incluent ce fragment, et seule une verification a l'execution le revele :
    // le chemin processeur, lui, fonctionne.
    vec2 ground = vec2(unit.x, unit.z);
    float groundLen = length(ground);
    if (groundLen < 1e-9) return vec3(0.0, len * sign(unit.y), 0.0);
    ground /= groundLen;
    return vec3(ground.x * cos(apparent), sin(apparent), ground.y * cos(apparent)) * len;
  }
`
