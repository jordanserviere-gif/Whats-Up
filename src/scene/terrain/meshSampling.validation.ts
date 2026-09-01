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
  AZIMUTH_MARGIN_DEG,
  AZIMUTH_STEPS,
  MESH_VERTEX_BUDGET,
  RANGE_STEPS,
  azimuthConcentration,
  dataPitchDeg,
  dataStepM,
  meshAzimuthDeg,
  meshAzimuthPitchDeg,
  meshRangePitchDeg,
} from './meshSampling'

/** Mont Ventoux — la ou le defaut a ete signale. */
const OBSERVER_M = 1912

/** Portee du maillage, m : la pyramide s'arrete la, le globe prend le relais. */
const FAR_RANGE_M = CLIPMAP_HALF_SPANS_M[CLIPMAP_HALF_SPANS_M.length - 1]

/**
 * Champ au-dela duquel la propriete est hors d'atteinte a budget constant.
 *
 * Le pas de bord vaut au mieux le demi-champ en radians — le minimum de
 * `s + (champ/2)²/4s` est atteint en `s = champ/4` et vaut `champ/2`. L'egaler a
 * la donnee la plus fine, 0,0562°, donne 0,0799 radian de demi-champ.
 */
const RESOLVABLE_FOV_DEG = 2 * (0.0799 / (Math.PI / 180))

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
const RESOLVED_FOV_DEG = [0.02, 0.5, 2, 9]

/** Champs ou elle ne peut pas tenir, et qu'on mesure quand meme. */
const WIDE_FOV_DEG = [20, 60, 110]

/**
 * Pire rapport maillage/donnee **dans le champ**, sur toute l'echelle.
 *
 * Le bord du champ, et non son centre : c'est la que la concentration est la
 * plus lache, donc la que la propriete est le plus a la peine.
 */
function worstInField(fovDeg: number): { ratio: number; distanceM: number } {
  let ratio = 0
  let distanceM = 0
  const edgeDeg = fovDeg / 2
  for (const d of LADDER_M) {
    const r = meshAzimuthPitchDeg(edgeDeg, 0, fovDeg) / dataPitchDeg(d)
    if (r > ratio) {
      ratio = r
      distanceM = d
    }
  }
  return { ratio, distanceM }
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
      // --- La propriete, dans le regime ou elle peut tenir ------------------
      const resolved = RESOLVED_FOV_DEG.map((fov) => ({ fov, ...worstInField(fov) }))
      const worst = resolved.reduce((a, b) => (b.ratio > a.ratio ? b : a))
      t.checkTrue(
        `le maillage n est jamais plus grossier que la donnee, jusqu a ${RESOLVABLE_FOV_DEG.toFixed(1)}° de champ`,
        worst.ratio <= 1,
        resolved
          .map(
            (r) =>
              `champ ${String(r.fov).padStart(5)}° : bord ${meshAzimuthPitchDeg(r.fov / 2, 0, r.fov).toFixed(4)}° ` +
              `contre donnee ${dataPitchDeg(r.distanceM).toFixed(4)}° a ${(r.distanceM / 1000).toFixed(0)} km ` +
              `— ${r.ratio.toFixed(2)}x`,
          )
          .join('\n'),
      )

      // ⚠️ Au-dela, la propriete est hors d'atteinte a budget constant. On la
      // mesure quand meme : un chiffre inscrit vaut mieux qu'un silence, et
      // c'est lui qui dira si un jour le budget doit bouger.
      t.note(
        'champ large, hors du regime resolvable : ' +
          WIDE_FOV_DEG.map((fov) => `${fov}° -> ${worstInField(fov).ratio.toFixed(1)}x`).join(', ') +
          ` (avant ce chantier : ${(0.703125 / dataPitchDeg(27_900)).toFixed(1)}x a tout champ)`,
      )

      // --- La loi suit bien la camera --------------------------------------
      const wide = meshAzimuthPitchDeg(0, 0, 110)
      const narrow = meshAzimuthPitchDeg(0, 0, 0.5)
      t.checkTrue(
        'le pas d azimut se resserre quand le champ se resserre',
        narrow < wide,
        `champ 110° -> ${wide.toFixed(4)}° ; champ 0,5° -> ${narrow.toFixed(4)}° ` +
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
        let total = 0
        const azimuths: number[] = []
        for (let i = 0; i < AZIMUTH_STEPS; i++) azimuths.push(meshAzimuthDeg(i, 0, fovDeg))
        for (let i = 0; i < AZIMUTH_STEPS; i++) {
          const here = azimuths[i]
          const next = i + 1 === AZIMUTH_STEPS ? azimuths[0] + 360 : azimuths[i + 1]
          total += next - here
        }
        t.check(`la loi referme le cercle a ${fovDeg}° de champ`, total, 360, 1e-9, '°')
        t.checkMonotonic(`les colonnes restent ordonnees a ${fovDeg}° de champ`, azimuths, 'croissant')
      }

      // La loi doit **contenir** l'ancienne, et non s'y substituer : a
      // concentration un, elle est uniforme. C'est ce qui garantit qu'aucun
      // chemin de code separe ne subsiste pour le champ large.
      t.check(
        'a concentration un, la loi redevient uniforme',
        meshAzimuthPitchDeg(137, 0, 360, AZIMUTH_STEPS),
        360 / AZIMUTH_STEPS,
        1e-12,
        '°',
      )
      t.check('la concentration sature a un', azimuthConcentration(360), 1, 0)

      // --- Ce que la concentration coute derriere la tete ------------------
      //
      // ⚠️ Elle n'est pas gratuite : ce qui est donne devant est pris derriere.
      // Le maillage y devient tres grossier, et c'est acceptable **parce qu'on
      // ne le voit pas** — mais uniquement tant que la reconstruction rattrape
      // le panoramique. C'est ce que la marge fine paie.
      t.note(
        'pas a l oppose de la visee : ' +
          [110, 20, 2].map((fov) => `${fov}° -> ${meshAzimuthPitchDeg(180, 0, fov).toFixed(1)}°`).join(', ') +
          ` — invisible, couvert par la marge de ${AZIMUTH_MARGIN_DEG}° et la reconstruction en tache de fond`,
      )

      // --- Le budget de sommets ------------------------------------------
      //
      // Il garde la solution autant que le probleme : resserrer l'azimut en
      // multipliant les colonnes rendrait la reconstruction plus longue que
      // plusieurs images. Le budget est **redistribue**, pas augmente.
      t.check('le budget de sommets ne bouge pas', MESH_VERTEX_BUDGET, 106_496, 0, ' sommets')
      t.note(
        `${AZIMUTH_STEPS} azimuts x ${RANGE_STEPS} anneaux — reconstruction mesuree a 18 ms, ` +
          'etalee a 24 anneaux par image',
      )

      // --- Ce que les anneaux font bien, et qu'il ne faut pas casser -------
      //
      // La hauteur apparente du sol est **stationnaire a l'horizon** : sa
      // derivee `h/d² − 1/2R` s'y annule. Les anneaux, espaces en logarithme,
      // s'y resserrent donc d'eux-memes en angle — la ou l'oeil regarde. Ce
      // n'est pas un reglage, c'est une consequence de la geometrie, et c'est
      // la meilleure propriete du maillage actuel.
      const atHorizon = meshRangePitchDeg(horizonM, OBSERVER_M, radiusM, FAR_RANGE_M)
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
        const r = meshRangePitchDeg(d, OBSERVER_M, radiusM, FAR_RANGE_M) / dataPitchDeg(d)
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
