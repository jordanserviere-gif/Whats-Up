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
import { HORIZON_MARGIN_DEG } from '../horizonMargin'
import { ATMOSPHERE_TOP_M } from '../transport/slantPath'
import { standardAirIndexAt } from './airIndex'
import { horizonDipDeg, refractionForApparent, scaledIndexProfile, type RayBendingOptions } from './rayBending'

export interface RefractionTable {
  /** Hauteurs apparentes de la grille, degres — croissantes. */
  readonly apparentDeg: Float64Array
  /** Hauteurs vraies correspondantes, degres — croissantes elles aussi. */
  readonly trueDeg: Float64Array
  /** Hauteur vraie la plus basse encore visible, degres. */
  readonly horizonTrueDeg: number
  /** Refraction a l'horizon apparent, degres. */
  readonly horizonRefractionDeg: number
  /** Hauteur vraie la plus basse **tabulee**, degres — horizon moins la marge. */
  readonly floorTrueDeg: number
  /** Compression verticale a l'horizon, `dA/da`. */
  readonly horizonCompression: number
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

  // --- Ou commence le domaine ------------------------------------------------
  //
  // ⚠️ **Pas a zero degre.** La table partait de l'horizontale, ce qui revient a
  // supposer l'observateur au niveau de la mer. Des qu'il prend de la hauteur,
  // son horizon **descend** — 0,17° a trente-cinq metres, 0,93° a mille, 3,1° a
  // dix kilometres — et toute la bande comprise entre l'horizontale et cet
  // horizon est du ciel parfaitement visible, que la table ignorait.
  //
  // `refractionForApparent` sait deja la traiter : elle suit la **branche
  // descendante** du rayon, qui plonge, atteint un point tangent, puis remonte.
  // C'est la meme integrale que celle de `horizonDipDeg`. Il ne manquait que de
  // la lui demander.
  const dipDeg = observerElevationM > 0 ? horizonDipDeg(observerElevationM, integration) : 0
  // Un cheveu au-dessus de l'horizon : a la depression exacte, le rayon rase le
  // sol et l'integrale n'a plus de solution.
  const minApparent = -dipDeg * (1 - 1e-6)
  const span = 90 - minApparent

  const apparentAbove = new Float64Array(count)
  const trueAbove = new Float64Array(count)

  for (let i = 0; i < count; i++) {
    const u = i / (count - 1)
    // Concentre pres de l'horizon, ou la refraction varie de dix minutes d'arc
    // par degre ; espace vers le zenith, ou elle ne bouge plus.
    const apparent = minApparent + span * u * u
    const refraction = radToDeg(refractionForApparent(apparent, integration))
    apparentAbove[i] = apparent
    trueAbove[i] = apparent - refraction
  }

  // --- Prolongement sous l'horizon ------------------------------------------
  //
  // ⚠️ **Il n'y a la aucune image, et le prolongement n'est pas physique.** Sous
  // l'horizon apparent, plus aucun rayon ne parvient a l'observateur : le
  // modele de Bouguer n'a plus de solution, et toute valeur est une
  // extrapolation. Ce qu'on choisit ici, c'est **comment** extrapoler.
  //
  // Le prolongement precedent gardait la refraction constante, ce qui revient a
  // une pente `dA/da = 1`. La fonction restait continue, mais **sa derivee
  // sautait** — de 0,4 a 1 en franchissant l'horizon. Or cette derivee est
  // exactement la compression verticale du disque : le Soleil reprenait sa
  // forme ronde a l'instant ou il se couchait.
  //
  // Le prolongement retenu conserve **valeur et pente** a l'horizon, puis laisse
  // la pente rejoindre 1 — le regime sans atmosphere — sur l'echelle de la
  // marge :
  //
  //     dA/da = s_h·exp(−d/λ) + (1 − exp(−d/λ))     d = a_h − a,  λ = marge/3
  //
  // Il est C¹ par construction, et strictement croissant puisque sa pente reste
  // entre `s_h` et 1, tous deux positifs — ce dont dependent la dichotomie et
  // l'interpolation de la texture.
  const horizonTrueDeg = trueAbove[0]

  // Pente mesuree sur un intervalle assez large pour ne pas dependre du bruit
  // d'integration du premier pas, qui ne fait qu'une seconde d'arc.
  let j = 1
  while (j < count - 1 && apparentAbove[j] - apparentAbove[0] < 0.05) j++
  const horizonCompression = (apparentAbove[j] - apparentAbove[0]) / (trueAbove[j] - trueAbove[0])

  const below = 96
  const lambda = HORIZON_MARGIN_DEG / 3
  const apparentDeg = new Float64Array(below + count)
  const trueDeg = new Float64Array(below + count)
  for (let i = 0; i < below; i++) {
    const d = HORIZON_MARGIN_DEG * (1 - i / below)
    const e = 1 - Math.exp(-d / lambda)
    trueDeg[i] = horizonTrueDeg - d
    apparentDeg[i] = apparentAbove[0] - horizonCompression * lambda * e - (d - lambda * e)
  }
  apparentDeg.set(apparentAbove, below)
  trueDeg.set(trueAbove, below)

  return {
    apparentDeg,
    trueDeg,
    horizonTrueDeg,
    horizonRefractionDeg: apparentAbove[0] - horizonTrueDeg,
    floorTrueDeg: trueDeg[0],
    horizonCompression,
  }
}

/**
 * Hauteur apparente d'un astre de hauteur vraie connue.
 *
 * ## Sous l'horizon apparent
 *
 * Il n'y a la, au sens strict, **aucune image**. La table porte neanmoins une
 * marge tabulee de quelques degres, dont le prolongement conserve **valeur et
 * pente** a l'horizon — voir `buildRefractionTable`. C'est ce qui evite que la
 * compression verticale d'un disque saute de 0,4 a 1 au moment ou il se couche.
 *
 * Sous cette marge, la refraction est figee et la pente revient a un : on est
 * alors dans le regime sans atmosphere, et l'objet est de toute facon occulte
 * par le sol.
 *
 * La visibilite ne se decide donc pas au signe du resultat mais par
 * `isVisible`, qui compare a `horizonTrueDeg`.
 */
export function apparentFromTable(table: RefractionTable, trueAltitudeDeg: number): number {
  const { trueDeg, apparentDeg } = table
  const last = trueDeg.length - 1
  if (trueAltitudeDeg <= trueDeg[0]) return apparentDeg[0] + (trueAltitudeDeg - trueDeg[0])
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
 * Plancher de la texture, degres — **propriete du site, non constante**.
 *
 * ⚠️ **Il valait quatre degres pour tout le monde**, ce qui suffisait au niveau
 * de la mer et pas ailleurs : a dix kilometres, l'horizon vrai descend vers
 * −3,6°, et la marge sous lui demande encore trois degres de plus. La texture
 * s'arretait donc au milieu de ce qui est visible.
 *
 * Le plancher suit desormais le bas de la table, `floorTrueDeg`, qui vaut
 * l'horizon vrai du site moins la marge. Il descend avec l'observateur, et la
 * texture avec lui.
 */
export const refractionLutFloorDeg = (table: RefractionTable): number => table.floorTrueDeg

/**
 * Parametrisation de la texture : `u = √((h − plancher)/etendue)`.
 *
 * Le carre concentre les texels pres de l'horizon, ou la refraction varie de dix
 * minutes d'arc par degre, et les espace vers le zenith ou elle ne bouge plus.
 */
export const refractionLutU = (trueAltitudeDeg: number, floorDeg: number): number =>
  Math.sqrt(Math.max(0, Math.min(1, (trueAltitudeDeg - floorDeg) / (90 - floorDeg))))

/** Hauteur vraie portee par une coordonnee de texture. */
export const refractionLutAltitude = (u: number, floorDeg: number): number =>
  floorDeg + u * u * (90 - floorDeg)

/**
 * Remplit la texture : **la refraction**, en degres, et non la hauteur apparente.
 *
 * Stocker l'ecart plutot que la valeur garde le contenu petit et lisse — de zero
 * au zenith a un demi-degre a l'horizon — la ou la hauteur apparente couvrirait
 * quatre-vingt-dix degres. L'erreur d'interpolation porte alors sur la petite
 * quantite, pas sur la grande.
 */
export function fillRefractionLut(
  target: Float32Array,
  table: RefractionTable,
  airmassAt?: (apparentAltitudeDeg: number) => number,
): void {
  const width = target.length / 4
  const floorDeg = refractionLutFloorDeg(table)
  for (let i = 0; i < width; i++) {
    const trueAltitudeDeg = refractionLutAltitude(i / (width - 1), floorDeg)
    const apparent = apparentFromTable(table, trueAltitudeDeg)
    target[i * 4] = apparent - trueAltitudeDeg
    // Canal vert : la **masse d'air**, sur la meme abscisse.
    //
    // Elle voyage avec la refraction parce qu'elle en partage exactement le
    // domaine — du plancher du site au zenith — et que le nuanceur du champ
    // d'etoiles la calculait de son cote avec une formule **bornee a zero
    // degre**. Deux modeles d'atmosphere dans la meme image, et le second
    // ignorait que l'horizon descend avec l'observateur.
    //
    // Le canal etait libre : la lecture ne coute rien de plus.
    target[i * 4 + 1] = airmassAt ? airmassAt(apparent) : 0
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
  uniform float uRefractionFloor;

  /** Coordonnee de texture pour une hauteur vraie donnee. */
  float refractionLutX(float trueAltDeg) {
    // Le plancher est celui du site : il descend quand l'observateur monte.
    float u = sqrt(clamp((trueAltDeg - uRefractionFloor) / (90.0 - uRefractionFloor), 0.0, 1.0));
    return 0.5 / uRefractionWidth + u * (1.0 - 1.0 / uRefractionWidth);
  }

  /** Refraction en degres pour une hauteur vraie donnee. */
  float refractionDeg(float trueAltDeg) {
    return texture2D(uRefractionLut, vec2(refractionLutX(trueAltDeg), 0.5)).r;
  }

  /**
   * Masse d'air, rapportee au zenith, pour une hauteur **vraie** donnee.
   *
   * Lue dans la meme table que la refraction, donc sur le meme domaine : elle
   * descend jusqu'au plancher du site au lieu de s'arreter a l'horizontale.
   * Vue de dix kilometres, la masse d'air a moins trois degres vaut 219 et non
   * 39 — c'est la difference entre un astre eteint et un astre qui ne l'est pas.
   */
  float airmassAt(float trueAltDeg) {
    return texture2D(uRefractionLut, vec2(refractionLutX(trueAltDeg), 0.5)).g;
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
