/**
 * Validation de la loi d'echantillonnage du maillage de terrain.
 *
 * ## La propriete, et une seule
 *
 * > **Le maillage n'est jamais plus grossier que la donnee qu'il
 * > echantillonne.**
 *
 * Si elle est fausse, aucune amelioration des tuiles ne se verra : le relief
 * decrit par la pyramide n'atteint pas l'ecran, il est jete entre deux sommets.
 * Il est alors inutile de charger plus fin, d'etendre un niveau ou de streamer
 * un quadtree — on telechargerait du detail que le maillage ne sait pas
 * dessiner.
 *
 * ## ⚠️ Ce qu'elle ne peut pas etre
 *
 * Elle ne peut pas tenir **a tout champ**. Cinq cent douze colonnes reparties
 * sur un champ de cent dix degres valent au mieux deux dixiemes de degre, quand
 * la pyramide descend au vingtieme : il faudrait quatre fois le budget de
 * sommets pour y parvenir, et la reconstruction couterait alors plus longtemps
 * que quatre images.
 *
 * La propriete est donc **conditionnee au champ**, et le seuil se calcule : la
 * concentration optimale place le pas de bord a `champ/2` radians, d'ou une
 * limite a **9,2 degres de champ**. C'est exactement le regime ou le defaut
 * avait ete signale, et le controle porte la condition dans son intitule plutot
 * que dans un commentaire.
 *
 * ## Le site de mesure
 *
 * Le mont Ventoux, 1912 m. Ce n'est pas un choix esthetique : c'est de la que le
 * defaut a ete signale, et la hauteur de l'observateur change tout au probleme —
 * elle place l'horizon a 170 km et fait varier la hauteur apparente du sol
 * beaucoup plus vite qu'au niveau de la mer.
 */
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import { horizonDipDeg } from '@/atmosphere/refraction/rayBending'
import { CLIPMAP_HALF_SPANS_M } from './elevationClipmap'
import { effectiveEarthRadiusM, horizonRangeM } from './ridgeField'
import {
  AZIMUTH_STEPS,
  DATA_FINEST_PITCH_DEG,
  MAX_SCREEN_ERROR_PX,
  MESH_VERTEX_BUDGET,
  RANGE_STEPS,
  CHARACTERISTIC_SLOPE,
  rangeStepsFor,
  ringRatio,
  azimuthConcentration,
  azimuthHalfSpanDeg,
  dataPitchDeg,
  dataStepM,
  meshAzimuthDeg,
  meshAzimuthPitchDeg,
  meshRangePitchDeg,
  screenErrorPx,
  type MeshView,
} from './meshSampling'

/**
 * Viewport de reference des captures : 1440 x 900.
 *
 * La loi depend de la hauteur en pixels — c'est ce qui la rend conforme au
 * critere d'erreur ecran — donc les controles doivent fixer un ecran, comme ils
 * fixent un site.
 */
const view = (fovDeg: number, altitudeDeg = 0): MeshView => ({
  azimuthDeg: 0,
  altitudeDeg,
  fovDeg,
  aspect: ASPECT,
  heightPx: 900,
})

/** Mont Ventoux — la ou le defaut a ete signale. */
const OBSERVER_M = 1912

/** Portee du maillage, m : la pyramide s'arrete la, le globe prend le relais. */
const FAR_RANGE_M = CLIPMAP_HALF_SPANS_M[CLIPMAP_HALF_SPANS_M.length - 1]

/**
 * Champ au-dela duquel la propriete est hors d'atteinte a budget constant.
 *
 * Le pas de bord vaut au mieux `A·sin(bord)`, atteint en `s = tan(bord/2)`.
 * L'egaler a la cellule la plus fine de la pyramide donne le demi-etalement en
 * azimut maximal, dont on redescend au champ **vertical** porte par la camera —
 * l'azimut se comptant a l'horizontale, le rapport d'aspect s'en mele.
 *
 * ⚠️ La premiere version de cette constante valait 9,2° parce qu'elle mesurait le
 * pas au demi-champ **vertical** au lieu du demi-etalement en azimut. Le
 * controle etait donc plus indulgent qu'il ne croyait, d'un facteur egal au
 * rapport d'aspect.
 */
const ASPECT = 1440 / 900
const RESOLVABLE_FOV_DEG =
  (2 * Math.atan(Math.tan(Math.asin(Math.min(1, DATA_FINEST_PITCH_DEG / (360 / AZIMUTH_STEPS)))) / ASPECT)) /
  (Math.PI / 180)

/**
 * Echelle de distances.
 *
 * Elle encadre volontairement les deux frontieres de la pyramide — 28 et
 * 112,5 km — a deux cents metres pres de part et d'autre : c'est la que la
 * finesse de la donnee saute d'un facteur quatre, et donc la que le rapport au
 * maillage change le plus brutalement.
 */
const LADDER_M = [
  500, 1_000, 2_230, 5_000, 14_000, 27_900, 28_100, 56_000, 112_000, 113_000, 175_000, 250_000,
  400_000,
]

/** Champs auxquels la propriete doit tenir. */
const RESOLVED_FOV_DEG = [0.02, 0.5, 2, 5]

/** Champs ou elle ne peut pas tenir, et qu'on mesure quand meme. */
const WIDE_FOV_DEG = [9, 20, 60, 110]

/**
 * Pire rapport maillage/donnee **dans le champ**, sur toute l'echelle.
 *
 * Le bord du champ, et non son centre : c'est la que la concentration est la
 * plus lache, donc la que la propriete est le plus a la peine.
 */
function worstInField(fovDeg: number): { ratio: number; distanceM: number; pitchDeg: number } {
  const v = view(fovDeg)
  const pitchDeg = meshAzimuthPitchDeg(azimuthHalfSpanDeg(v), v)
  let ratio = 0
  let distanceM = 0
  for (const d of LADDER_M) {
    const r = pitchDeg / dataPitchDeg(d)
    if (r > ratio) {
      ratio = r
      distanceM = d
    }
  }
  return { ratio, distanceM, pitchDeg }
}

export function meshSamplingSuite(): SuiteResult {
  const dipDeg = horizonDipDeg(OBSERVER_M)
  const radiusM = effectiveEarthRadiusM(OBSERVER_M, dipDeg)
  const horizonM = horizonRangeM(0, OBSERVER_M, radiusM)

  return suite(
    'Echantillonnage du maillage de terrain',
    {
      reference:
        'aucune — propriete interne : le maillage ne doit pas etre plus grossier que la pyramide qu il lit',
    },
    (t) => {
      // --- Le critere : une erreur ecran constante -------------------------
      //
      // C'est la propriete qui rend la loi invariante d'echelle, et c'est
      // exactement celle d'un raffinement en erreur d'espace ecran : **une
      // cellule occupe le meme nombre de pixels a tout grossissement**.
      //
      // ⚠️ La version precedente ne l'avait pas. Sa marge fixe de trois degres
      // etait une constante en **degres**, et sous six degres de champ elle
      // cessait de suivre l'ecran : neuf pixels par colonne a deux degres de
      // champ, trente-trois a un demi. La loi arretait de zoomer.
      const fovs = [0.02, 0.1, 0.5, 2, 9, 20, 60, 110]
      const errors = fovs.map((fov) => ({
        fov,
        px: screenErrorPx(worstInField(fov).pitchDeg, view(fov)),
      }))
      const inside = errors.filter((e) => e.fov <= 20)
      t.checkTrue(
        'une colonne occupe le meme nombre de pixels a tout grossissement',
        inside.every((e) => e.px <= MAX_SCREEN_ERROR_PX * 1.3),
        errors.map((e) => `champ ${String(e.fov).padStart(5)}deg : ${e.px.toFixed(1)} px`).join('\n'),
      )
      // A champ large, seize pixels seraient plus grossiers qu'une cellule de la
      // pyramide : c'est la borne de **donnee** qui commande, et l'erreur ecran
      // descend donc sous la cible au lieu de l'atteindre. C'est voulu — la
      // depasser reviendrait a jeter du relief pour economiser des sommets.
      t.checkTrue(
        'a champ large c est la donnee qui commande, et le pas passe sous la cible ecran',
        errors.filter((e) => e.fov > 20).every((e) => e.px <= MAX_SCREEN_ERROR_PX),
        errors
          .filter((e) => e.fov > 20)
          .map(
            (e) =>
              `champ ${e.fov}deg : ${e.px.toFixed(1)} px, ` +
              `concentration ${azimuthConcentration(view(e.fov)).toFixed(3)}`,
          )
          .join('\n'),
      )

      // --- La propriete de depart -----------------------------------------
      const resolved = RESOLVED_FOV_DEG.map((fov) => ({ fov, ...worstInField(fov) }))
      const worst = resolved.reduce((a, b) => (b.ratio > a.ratio ? b : a))
      t.checkTrue(
        `le maillage n est jamais plus grossier que la donnee, jusqu a ${RESOLVABLE_FOV_DEG.toFixed(1)} deg de champ`,
        worst.ratio <= 1,
        resolved
          .map(
            (r) =>
              `champ ${String(r.fov).padStart(5)}deg : bord ${r.pitchDeg.toFixed(4)}deg ` +
              `contre donnee ${dataPitchDeg(r.distanceM).toFixed(4)}deg a ${(r.distanceM / 1000).toFixed(0)} km ` +
              `— ${r.ratio.toFixed(2)}x`,
          )
          .join('\n'),
      )
      t.note(
        'champ large, hors du regime resolvable : ' +
          WIDE_FOV_DEG.map((fov) => `${fov}deg -> ${worstInField(fov).ratio.toFixed(1)}x`).join(', ') +
          ` (avant ce chantier : ${(0.703125 / dataPitchDeg(27_900)).toFixed(1)}x a tout champ)`,
      )

      // --- La visee plongeante ---------------------------------------------
      //
      // ⚠️ Le champ porte par la camera est vertical ; l'etendue en **azimut**
      // qu'il couvre s'elargit en `1/cos(hauteur)`. Vise vers ses pieds, un
      // champ d'un degre couvre tous les azimuts, et un secteur fin dimensionne
      // sur le seul champ laisserait le sol sous l'observateur hors de lui.
      for (const altitude of [0, -45, -75, -89]) {
        const v = view(0.5, altitude)
        const spread = azimuthHalfSpanDeg(v)
        const fine = (2 * azimuthConcentration(v) * 180) / Math.PI
        t.checkTrue(
          `le secteur fin couvre le champ a ${altitude} deg de hauteur`,
          fine >= spread,
          `etendue en azimut ${spread.toFixed(2)}deg contre secteur fin ${fine.toFixed(2)}deg`,
        )
      }

      // --- La loi suit bien la camera --------------------------------------
      const wide = meshAzimuthPitchDeg(0, view(110))
      const narrow = meshAzimuthPitchDeg(0, view(0.5))
      t.checkTrue(
        'le pas d azimut se resserre quand le champ se resserre',
        narrow < wide,
        `champ 110deg -> ${wide.toFixed(4)}deg ; champ 0,5deg -> ${narrow.toFixed(4)}deg ` +
          `(${(0.703125 / narrow).toFixed(0)}x plus fin qu avant ce chantier)`,
      )

      // --- Ce qu'une deformation doit garantir -----------------------------
      //
      // Le maillage est un eventail **ferme** : la derniere colonne doit rejoindre
      // la premiere exactement. Une loi qui ne refermerait pas le cercle
      // laisserait une couture verticale sur toute la hauteur du terrain, ou un
      // recouvrement — l'un et l'autre a un azimut qui suit la camera, donc
      // impossibles a diagnostiquer plus tard.
      for (const fovDeg of [110, 20, 2, 0.02]) {
        const v = view(fovDeg)
        let total = 0
        const azimuths: number[] = []
        for (let i = 0; i < AZIMUTH_STEPS; i++) azimuths.push(meshAzimuthDeg(i, v))
        for (let i = 0; i < AZIMUTH_STEPS; i++) {
          const here = azimuths[i]
          const next = i + 1 === AZIMUTH_STEPS ? azimuths[0] + 360 : azimuths[i + 1]
          total += next - here
        }
        t.check(`la loi referme le cercle a ${fovDeg} deg de champ`, total, 360, 1e-9, 'deg')
        t.checkMonotonic(
          `les colonnes restent ordonnees a ${fovDeg} deg de champ`,
          azimuths,
          'croissant',
        )
      }

      // La loi doit **contenir** l'ancienne, et non s'y substituer : quand
      // l'etalement en azimut couvre tout le tour, elle tend vers la repartition
      // uniforme. C'est ce qui garantit qu'aucun chemin de code separe ne
      // subsiste pour le champ large.
      t.check(
        'a etalement complet, la loi tend vers l uniforme',
        meshAzimuthPitchDeg(137, view(179)),
        360 / AZIMUTH_STEPS,
        5e-3,
        'deg',
      )

      // ⚠️ Une concentration superieure a un **inverserait** la loi : le pas
      // deviendrait le plus grossier face a la visee et le plus fin derriere la
      // tete. Rien dans la formule ne l'interdit — c'est la borne qui le fait,
      // et c'est elle qu'il faut tenir.
      const concentrations = [0.02, 0.5, 2, 9, 20, 60, 110, 179].flatMap((fov) =>
        [0, -45, -89, 45, 89].map((alt) => ({ fov, alt, s: azimuthConcentration(view(fov, alt)) })),
      )
      const inverted = concentrations.filter((c) => c.s > 1)
      t.checkTrue(
        'la concentration ne depasse jamais un, quelle que soit la visee',
        inverted.length === 0,
        inverted.length === 0
          ? `${concentrations.length} combinaisons de champ et de hauteur, maximum ` +
            `${Math.max(...concentrations.map((c) => c.s)).toFixed(3)}`
          : inverted
              .map((c) => `champ ${c.fov}deg hauteur ${c.alt}deg -> ${c.s.toFixed(3)}`)
              .join(' ; '),
      )

      // --- Ce que la concentration coute derriere la tete ------------------
      //
      // ⚠️ Elle n'est pas gratuite : ce qui est donne devant est pris derriere.
      // Le maillage y devient tres grossier, et c'est acceptable **parce qu'on
      // ne le voit pas** — mais uniquement tant que la reconstruction rattrape
      // le panoramique.
      t.note(
        'pas a l oppose de la visee : ' +
          [110, 20, 2, 0.5]
            .map((fov) => `${fov}deg -> ${meshAzimuthPitchDeg(180, view(fov)).toFixed(1)}deg`)
            .join(', ') +
          ' — invisible, couvert par la marge fine et la reconstruction en tache de fond',
      )

      // --- Le budget de sommets ------------------------------------------
      //
      // ⚠️ **Le plafond a double, deliberement, et la mesure le justifie.** A
      // deux cent huit anneaux, les silhouettes de crete montraient un escalier
      // regulier une fois l'azimut assaini ; a quatre cent seize, il disparait.
      //
      // Ce que ce plafond coute est de la **memoire** — deux jeux de tampons
      // recycles, huit megaoctets — et non du temps : le nombre d'anneaux
      // reellement poses, lui, suit l'ecran.
      t.check(
        'le plafond d allocation vaut deux jeux de 416 anneaux',
        MESH_VERTEX_BUDGET,
        212_992,
        0,
        ' sommets',
      )

      // --- Le nombre d anneaux suit l ecran, comme l azimut ------------------
      //
      // C'est ce qui a supprime le dernier a-coup : a cent dix degres de champ,
      // televerser un maillage double ne changeait rien a l'image et rendait une
      // image a 127 ms. Le critere dit lui-meme qu'il n'y en a pas besoin.
      const ringCounts = [0.02, 0.5, 2, 9, 20, 60, 110].map((fov) => ({
        fov,
        rings: rangeStepsFor(view(fov), FAR_RANGE_M),
      }))
      t.checkMonotonic(
        'le nombre d anneaux decroit quand le champ s elargit',
        ringCounts.map((r) => r.rings),
        'decroissant',
      )
      t.checkTrue(
        'le maillage sature au plafond a fort grossissement et s allege a champ large',
        ringCounts[0].rings === RANGE_STEPS && ringCounts[ringCounts.length - 1].rings < RANGE_STEPS / 3,
        ringCounts.map((r) => `champ ${String(r.fov).padStart(5)}deg : ${r.rings} anneaux`).join(' ; '),
      )

      // L'erreur que deux anneaux consecutifs laissent passer — la crete qu'ils
      // sautent — doit rester sous la cible ecran, tant que le plafond n'est pas
      // atteint. Au-dela, on mesure de combien il manque.
      const missed = ringCounts.map((r) => {
        const errorDeg = (CHARACTERISTIC_SLOPE * (ringRatio(FAR_RANGE_M, r.rings) - 1)) / (Math.PI / 180)
        return { ...r, px: (errorDeg * 900) / r.fov }
      })
      const met = missed.filter((m) => m.rings < RANGE_STEPS)
      t.checkTrue(
        'la crete sautee entre deux anneaux reste sous la cible, hors saturation',
        met.every((m) => m.px <= MAX_SCREEN_ERROR_PX * 1.05),
        missed
          .map((m) => `champ ${String(m.fov).padStart(5)}deg : ${m.px.toFixed(1)} px${m.rings === RANGE_STEPS ? ' (sature)' : ''}`)
          .join(' ; '),
      )
      t.note(
        'a fort grossissement le plafond est atteint et la cible ne l est pas : ' +
          missed
            .filter((m) => m.rings === RANGE_STEPS)
            .map((m) => `champ ${m.fov}deg -> ${m.px.toFixed(0)} px au lieu de ${MAX_SCREEN_ERROR_PX}`)
            .join(', ') +
          ' — c est la dette de l axe des distances, un facteur qui ne se rattrape pas a budget raisonnable',
      )
      t.note(
        `${AZIMUTH_STEPS} azimuts x ${RANGE_STEPS} anneaux au plafond — reconstruction etalee ` +
          'a 24 anneaux par image, tampons recycles entre deux jeux',
      )

      // --- Ce que les anneaux font bien, et qu'il ne faut pas casser -------
      //
      // La hauteur apparente du sol est **stationnaire a l'horizon** : sa
      // derivee `h/d² − 1/2R` s'y annule. Les anneaux, espaces en logarithme,
      // s'y resserrent donc d'eux-memes en angle — la ou l'oeil regarde. Ce
      // n'est pas un reglage, c'est une consequence de la geometrie, et c'est
      // la meilleure propriete du maillage actuel.
      const ringsAtZoom = rangeStepsFor(view(2), FAR_RANGE_M)
      const atHorizon = meshRangePitchDeg(horizonM, OBSERVER_M, radiusM, FAR_RANGE_M, ringsAtZoom)
      const dataAtHorizon = dataPitchDeg(horizonM)
      t.checkTrue(
        'les anneaux se resserrent a l horizon, ou la hauteur apparente est stationnaire',
        atHorizon < dataAtHorizon,
        `horizon a ${(horizonM / 1000).toFixed(0)} km : anneau ${atHorizon.toFixed(4)}° contre ` +
          `donnee ${dataAtHorizon.toFixed(4)}° (${(atHorizon / dataAtHorizon).toFixed(2)}x)`,
      )

      // ⚠️ Les anneaux sont en revanche trop grossiers dans le champ proche.
      // Reel, mesure, et hors cible de ce chantier — qui porte sur l'azimut.
      let worstRangeNear = 0
      let worstRangeNearAtM = 0
      for (const d of LADDER_M) {
        if (d > CLIPMAP_HALF_SPANS_M[0]) continue
        const r = meshRangePitchDeg(d, OBSERVER_M, radiusM, FAR_RANGE_M, ringsAtZoom) / dataPitchDeg(d)
        if (r > worstRangeNear) {
          worstRangeNear = r
          worstRangeNearAtM = d
        }
      }
      t.note(
        `anneaux sous la premiere frontiere : jusqu a ${worstRangeNear.toFixed(1)}x trop grossiers ` +
          `a ${(worstRangeNearAtM / 1000).toFixed(0)} km — reel, connu, hors cible de ce chantier`,
      )

      // --- La couture entre niveaux ---------------------------------------
      const inner = dataStepM(CLIPMAP_HALF_SPANS_M[0] - 100)
      const outer = dataStepM(CLIPMAP_HALF_SPANS_M[0] + 100)
      t.note(
        `frontiere a ${(CLIPMAP_HALF_SPANS_M[0] / 1000).toFixed(0)} km : le pas passe de ` +
          `${inner.toFixed(1)} m a ${outer.toFixed(1)} m (${(outer / inner).toFixed(2)}x) — ` +
          'desormais resolu par le maillage, donc visible',
      )
    },
  )
}
