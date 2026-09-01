/**
 * La loi d'echantillonnage du maillage de terrain, isolee de son rendu.
 *
 * ## Pourquoi ce module existe
 *
 * Le maillage radial de `Terrain` decide **ou** l'on interroge le relief : a
 * quels azimuts, a quelles distances. C'est une strategie d'echantillonnage,
 * pas de la physique — et jusqu'ici elle vivait au milieu d'un composant React
 * qui tire Three.js et le DOM, donc hors de portee de toute validation.
 *
 * Or c'est precisement la grandeur qu'il faut pouvoir mesurer : **le maillage
 * peut etre plus grossier que la donnee qu'il echantillonne**, et dans ce cas
 * aucune amelioration des tuiles ne se verra jamais a l'ecran.
 *
 * ⚠️ Rien ici n'est physique. Les fonctions de ce module decrivent un choix de
 * discretisation, et il faut les lire comme telles : elles disent ce que le
 * maillage **peut representer**, jamais ce que le monde fait.
 *
 * ## Les deux axes ne se comparent pas de la meme facon
 *
 * L'axe des azimuts et l'axe des distances ne subissent pas le meme
 * raccourcissement. Deux points separes de `Δaz` a la meme distance sont
 * separes de `Δaz·cos(elevation)` dans l'image — soit `Δaz` a l'horizon. Deux
 * anneaux consecutifs, eux, sont separes de **kilometres** au sol et de
 * quelques centiemes de degre dans l'image : la visee rasante ecrase la
 * profondeur.
 *
 * Comparer les deux axes en metres au sol donnerait donc une conclusion fausse.
 * Tout se compare ici **en angle apparent**, la seule grandeur que l'oeil voit.
 */
import { CLIPMAP_HALF_SPANS_M, CLIPMAP_SIZE } from './elevationClipmap'
import { apparentElevationRad } from './ridgeField'

const DEG = Math.PI / 180

/** Secteurs d'azimut du maillage. */
export const AZIMUTH_STEPS = 512

/** Anneaux de distance, espaces en logarithme. */
export const RANGE_STEPS = 208

/**
 * Distance du premier anneau, metres.
 *
 * ⚠️ **Vingt metres etait un reste du banc synthetique.** Sa plaine valait zero
 * et l'observateur la survolait de trente-cinq metres : a vingt metres, le sol
 * apparaissait deja soixante degres sous l'horizon, et le premier anneau
 * couvrait le nadir.
 *
 * Le relief reel a supprime cette hauteur. L'oeil repose desormais a
 * `EYE_HEIGHT_M` du sol, et a vingt metres celui-ci n'est plus qu'a **cinq
 * degres** sous l'horizon : tout l'hemisphere inferieur devenait un trou, ou
 * l'on voyait passer les constellations. Un demi-metre le referme jusqu'a
 * soixante-treize degres.
 *
 * ⚠️ **Ces trois nombres ont ete reduits sur une mesure fausse, puis retablis.**
 * Un banc rendait une seconde par image, et j'en avais conclu un cout de
 * remplissage. C'etait le **bridage de `requestAnimationFrame`** : un onglet
 * sans le focus est cadence a 1 Hz par le navigateur, et la comparaison opposait
 * une fenetre au premier plan a une fenetre en arriere-plan.
 *
 * Verifie depuis, focus rendu : **6,1 ms** avec le terrain, l'atmosphere et la
 * table doublee. Le cout n'existait pas.
 */
export const NEAR_M = 0.5

/**
 * Nombre de sommets que le maillage a le droit de consommer.
 *
 * ⚠️ **C'est une contrainte de conception, pas une observation.** Reconstruire
 * le maillage coute une milliseconde par tranche de six mille sommets — mesure
 * sous Node, boucle de `buildGeometry` rejouee sur une pyramide remplie :
 * 18 ms pour 106 496 sommets, 67 ms pour 425 984.
 *
 * Toute amelioration de la resolution doit donc **redistribuer** ce budget, et
 * non l'augmenter : quadrupler les sommets rendrait la reconstruction plus
 * longue que quatre images, et l'on aurait echange un defaut visible contre un
 * a-coup a chaque mouvement de camera.
 */
export const MESH_VERTEX_BUDGET = AZIMUTH_STEPS * RANGE_STEPS

/**
 * Raison geometrique entre deux anneaux consecutifs.
 *
 * Les anneaux sont equirepartis en logarithme entre `NEAR_M` et la portee, donc
 * chaque anneau est un facteur constant plus loin que le precedent.
 */
export function ringRatio(farRangeM: number, rangeSteps = RANGE_STEPS): number {
  return Math.exp(Math.log(farRangeM / NEAR_M) / (rangeSteps - 1))
}

/**
 * Erreur tolerée sur l'ecran, pixels — **la constante qui gouverne le maillage**.
 *
 * C'est la taille apparente que doit avoir une cellule du maillage. Seize
 * pixels : c'est le `maximumScreenSpaceError` par defaut de CesiumJS, dont le
 * critere de raffinement est
 *
 *     SSE = erreur_geometrique × hauteur_ecran / (distance × 2·tan(champ/2))
 *
 * ⚠️ **Ce n'est pas la meme grandeur que la SSE stricte.** Celle-ci se calcule
 * sur l'**erreur geometrique** — l'ecart en metres entre la representation et le
 * terrain reel — la ou nous prenons la taille d'une cellule. Une plaine a une
 * erreur quasi nulle a n'importe quel niveau et meriterait donc peu de sommets
 * meme de pres ; nous lui en donnons autant qu'a une arete. L'approximation
 * tient parce que la pyramide a une resolution fixe, mais elle est a signaler :
 * une SSE stricte demanderait une mesure de rugosite par region, precalculee
 * avec les tuiles.
 *
 * Voir le registre.
 */
export const MAX_SCREEN_ERROR_PX = 16

/**
 * Pas angulaire le plus fin que la pyramide sache offrir, degres.
 *
 * Il ne depend d'aucun niveau : chaque niveau couvre `2·halfSpan` avec
 * `CLIPMAP_SIZE` cellules, donc une cellule vue depuis le bord de son propre
 * niveau sous-tend `atan(2/(CLIPMAP_SIZE−1))` — la meme valeur pour les trois.
 * C'est une propriete de la construction de la pyramide, pas une mesure.
 */
export const DATA_FINEST_PITCH_DEG = Math.atan(2 / (CLIPMAP_SIZE - 1)) / DEG

/**
 * Concentration de la loi d'azimut — deduite, non choisie.
 *
 * ## Deux bornes, et la plus serree gagne
 *
 * - **L'ecran** : une colonne ne doit pas depasser `MAX_SCREEN_ERROR_PX`, ce qui
 *   vaut `k·champ/hauteur` degres. C'est la borne qui commande a fort
 *   grossissement.
 * - **La donnee** : descendre sous `DATA_FINEST_PITCH_DEG` n'apporte rien, et
 *   surtout **rester au-dessus jette du relief**. C'est la borne qui commande a
 *   champ large, ou seize pixels sont deja plus grossiers qu'une cellule.
 *
 * ⚠️ Prendre la seule borne d'ecran laissait le maillage trois fois plus
 * grossier que la pyramide a neuf degres de champ. Prendre la seule borne de
 * donnee — ce que faisait la version precedente — figeait la loi en degres et
 * l'empechait de suivre le zoom. Il faut les deux.
 *
 * ## Resoudre pour `s`
 *
 * Le pas au **bord du champ** doit valoir la cible. En posant `A = 360/N`,
 * `c = cos(bord/2)` et `n = sin(bord/2)`, `pas(bord) = (A/s)(s²c² + n²)` donne
 *
 *     s²·c² − (cible/A)·s + n² = 0
 *
 * Les deux racines atteignent la cible ; on prend **la plus grande**, qui
 * l'atteint avec le secteur fin le plus large, donc la marge la plus generreuse
 * pour le panoramique.
 *
 * Quand le discriminant est negatif, la cible est hors d'atteinte a budget
 * constant : on retombe sur `s = tan(bord/2)`, qui **minimise** le pas de bord —
 * le mieux que cinq cent douze colonnes puissent faire.
 */
export function azimuthConcentration(view: MeshView, azimuthSteps = AZIMUTH_STEPS): number {
  const uniformPitchDeg = 360 / azimuthSteps
  const fromScreen = (MAX_SCREEN_ERROR_PX * view.fovDeg) / view.heightPx
  const targetDeg = Math.min(fromScreen, DATA_FINEST_PITCH_DEG)

  const half = (azimuthHalfSpanDeg(view) * DEG) / 2
  const c = Math.cos(half)
  const n = Math.sin(half)
  const b = targetDeg / uniformPitchDeg
  const discriminant = b * b - 4 * c * c * n * n
  const s = discriminant >= 0 ? (b + Math.sqrt(discriminant)) / (2 * c * c) : n / c
  return Math.min(1, s)
}

/**
 * Demi-etendue en azimut du champ de vision, degres.
 *
 * Le champ porte par la camera est **vertical** ; l'azimut, lui, se compte le
 * long de l'horizontale, d'ou le rapport d'aspect. Et une visee plongeante
 * elargit encore cette etendue en `1/cos(hauteur)` — au nadir, un champ d'un
 * degre couvre tous les azimuts.
 */
export function azimuthHalfSpanDeg(view: MeshView): number {
  const halfH = Math.atan(Math.tan((view.fovDeg * DEG) / 2) * view.aspect) / DEG
  const cos = Math.abs(Math.cos(view.altitudeDeg * DEG))
  return Math.min(180, halfH / Math.max(0.02, cos))
}

/** Ce que la camera impose au maillage. */
export interface MeshView {
  /** Azimut de la visee, degres. */
  azimuthDeg: number
  /** Hauteur de la visee, degres — elle elargit l'etendue en azimut du champ. */
  altitudeDeg: number
  /** Champ **vertical**, degres, comme le porte la camera de three. */
  fovDeg: number
  /** Rapport largeur sur hauteur du viewport. */
  aspect: number
  /** Hauteur du viewport, pixels — c'est elle qui convertit les degres en SSE. */
  heightPx: number
}

/**
 * Azimut de la colonne `i`, degres.
 *
 * ## La deformation, et pourquoi celle-ci
 *
 * Les colonnes sont equirepartis dans un parametre `t ∈ [−1, 1[`, puis
 * deformees par
 *
 *     θ(t) = 2·atan( s·tan(π t / 2) )
 *
 * autour de la direction visee. Trois proprietes en font le bon choix, et
 * aucune n'est cosmetique :
 *
 * - elle est **exacte et inversible**, sans table ni recherche ;
 * - elle **referme le cercle** : `t = ±1` donne `θ = ±π`, le meme point ;
 * - elle **degenere en uniforme** a `s = 1`, donc le comportement d'avant est
 *   un cas particulier de la loi et non un chemin separe.
 *
 * ⚠️ Un secteur fin a bord franc aurait ete plus simple, et faux : la densite y
 * sauterait d'un facteur dix en une colonne, et cette frontiere balaierait
 * l'image a chaque panoramique. Ici la densite varie continument.
 *
 * La forme `atan2` evite la tangente infinie en `t = ±1`, ou la formule directe
 * demanderait un cas particulier.
 */
export function meshAzimuthDeg(i: number, view: MeshView, azimuthSteps = AZIMUTH_STEPS): number {
  const s = azimuthConcentration(view, azimuthSteps)
  const half = (Math.PI * (-1 + (2 * i) / azimuthSteps)) / 2
  const offset = 2 * Math.atan2(s * Math.sin(half), Math.cos(half))
  return view.azimuthDeg + offset / DEG
}

/**
 * Pas d'azimut du maillage a un azimut donne, degres.
 *
 * Derivee analytique de `meshAzimuthDeg`, ecrite sans tangente :
 *
 *     pas(θ) = (360 / (N·s)) · ( s²·cos²(θ/2) + sin²(θ/2) )
 *
 * On y lit directement les deux extremes : `360·s/N` face a la visee, `360/(N·s)`
 * a l'oppose.
 */
export function meshAzimuthPitchDeg(
  azimuthDeg: number,
  view: MeshView,
  azimuthSteps = AZIMUTH_STEPS,
): number {
  const s = azimuthConcentration(view, azimuthSteps)
  let offsetDeg = (azimuthDeg - view.azimuthDeg) % 360
  if (offsetDeg > 180) offsetDeg -= 360
  if (offsetDeg < -180) offsetDeg += 360
  const half = (offsetDeg * DEG) / 2
  const c = Math.cos(half)
  const sn = Math.sin(half)
  return (360 / (azimuthSteps * s)) * (s * s * c * c + sn * sn)
}

/** Taille apparente d'un pas angulaire, pixels — l'unite du critere. */
export const screenErrorPx = (pitchDeg: number, view: MeshView): number =>
  (pitchDeg * view.heightPx) / view.fovDeg

/**
 * Pas apparent entre deux anneaux consecutifs, degres d'elevation.
 *
 * C'est l'ecart de **hauteur apparente** entre l'anneau qui passe par
 * `distanceM` et le suivant, sur un sol plat. Le relief le modifie point par
 * point ; le sol plat donne la trame, qui est ce qu'on veut mesurer.
 */
export function meshRangePitchDeg(
  distanceM: number,
  observerElevationM: number,
  effectiveRadiusM: number,
  farRangeM: number,
  rangeSteps = RANGE_STEPS,
): number {
  const next = distanceM * ringRatio(farRangeM, rangeSteps)
  const here = apparentElevationRad(distanceM, 0, observerElevationM, effectiveRadiusM)
  const there = apparentElevationRad(next, 0, observerElevationM, effectiveRadiusM)
  return Math.abs(there - here) / DEG
}

/**
 * Indice du niveau de pyramide qui sert une distance, dans la direction la
 * moins favorable.
 *
 * Le domaine de chaque niveau est un **carre**, et `sampleClipmap` choisit par
 * la distance de Tchebychev. Une visee cardinale sort donc du niveau fin a
 * `halfSpan`, une visee diagonale seulement a `halfSpan·√2`. On prend la
 * cardinale : un controle doit tenir dans la direction la plus defavorable.
 */
export function clipmapLevelForDistance(distanceM: number): number {
  for (let i = 0; i < CLIPMAP_HALF_SPANS_M.length; i++) {
    if (distanceM <= CLIPMAP_HALF_SPANS_M[i]) return i
  }
  return CLIPMAP_HALF_SPANS_M.length - 1
}

/** Pas de la pyramide qui sert une distance, metres. */
export function dataStepM(distanceM: number): number {
  const halfSpanM = CLIPMAP_HALF_SPANS_M[clipmapLevelForDistance(distanceM)]
  return (2 * halfSpanM) / (CLIPMAP_SIZE - 1)
}

/**
 * Taille apparente d'une cellule de donnee, degres.
 *
 * Mesuree **transversalement** a la visee : c'est la seule direction ou la
 * cellule n'est pas ecrasee par la perspective rasante, donc la seule ou son
 * angle dise quelque chose de ce que l'oeil peut resoudre.
 */
export function dataPitchDeg(distanceM: number): number {
  return Math.atan(dataStepM(distanceM) / distanceM) / DEG
}

/**
 * Distance au-dela de laquelle le maillage cesse de resoudre la donnee, metres.
 *
 * En deca, deux colonnes voisines tombent dans la meme cellule de la pyramide
 * et le maillage ne perd rien. Au-dela, il **saute** des cellules : le relief
 * decrit par la donnee ne peut plus atteindre l'ecran, quelle que soit la
 * finesse des tuiles telechargees.
 */
export function azimuthResolvedUntilM(azimuthSteps = AZIMUTH_STEPS): number {
  const pitchRad = ((360 / azimuthSteps) * Math.PI) / 180
  return dataStepM(0) / Math.tan(pitchRad)
}
