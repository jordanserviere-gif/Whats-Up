/**
 * Validation de la loi d'echantillonnage du maillage de terrain — phase 0.
 *
 * ## La propriete, et une seule
 *
 * > **Le maillage n'est jamais plus grossier que la donnee qu'il
 * > echantillonne.**
 *
 * Si elle est fausse, aucune amelioration des tuiles ne se verra jamais : le
 * relief decrit par la pyramide n'atteint pas l'ecran, il est jete entre deux
 * sommets. Il est alors inutile de charger plus fin, d'etendre un niveau ou de
 * streamer un quadtree — on telechargerait du detail que le maillage ne sait pas
 * dessiner.
 *
 * ## ⚠️ Deux controles de cette suite echouent, et c'est voulu
 *
 * Ils enoncent la cible du chantier `terrain-mesh-resolution`. Un defaut connu
 * mais non tenu par un controle est un defaut qui revient : c'est le mode de
 * defaillance qui a mordu trois fois sur l'atmosphere — trois horizons
 * incoherents, la troncature de la table en distance, deux expressions du ciel
 * — a chaque fois une propriete vraie « par construction » que rien ne
 * retenait.
 *
 * Ils passeront au vert quand la loi d'azimut suivra la camera, et pas avant.
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
  MESH_VERTEX_BUDGET,
  RANGE_STEPS,
  azimuthResolvedUntilM,
  dataPitchDeg,
  dataStepM,
  meshAzimuthPitchDeg,
  meshRangePitchDeg,
} from './meshSampling'

/** Mont Ventoux — la ou le defaut a ete signale. */
const OBSERVER_M = 1912

/** Portee du maillage, m : la pyramide s'arrete la, le globe prend le relais. */
const FAR_RANGE_M = CLIPMAP_HALF_SPANS_M[CLIPMAP_HALF_SPANS_M.length - 1]

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

const format = (rows: readonly string[]): string => rows.join('\n')

export function meshSamplingSuite(): SuiteResult {
  const dipDeg = horizonDipDeg(OBSERVER_M)
  const radiusM = effectiveEarthRadiusM(OBSERVER_M, dipDeg)
  const horizonM = horizonRangeM(0, OBSERVER_M, radiusM)

  return suite(
    'Echantillonnage du maillage de terrain (phase 0)',
    {
      reference:
        'aucune — propriete interne : le maillage ne doit pas etre plus grossier que la pyramide qu il lit',
    },
    (t) => {
      // --- L'axe des azimuts --------------------------------------------
      //
      // C'est lui, le defaut signale. Le pas est uniforme sur trois cent
      // soixante degres et ne depend ni du champ ni de la visee : a plein zoom,
      // une colonne de sommets couvre plusieurs largeurs d'ecran, et l'on ne
      // voit plus que deux ou trois aretes etirees.
      const rows: string[] = ['distance   donnee     azimut     ratio    anneau     ratio']
      let worstAzimuth = 0
      let worstAzimuthAtM = 0
      let worstRangeNear = 0
      let worstRangeNearAtM = 0

      for (const distanceM of LADDER_M) {
        const data = dataPitchDeg(distanceM)
        // Champ resserre : c'est la condition ou le defaut se voit. La loi
        // actuelle ignore cet argument, ce qui est precisement le probleme.
        const azimuth = meshAzimuthPitchDeg(0, 0, 0.5)
        const range = meshRangePitchDeg(distanceM, OBSERVER_M, radiusM, FAR_RANGE_M)
        const azRatio = azimuth / data
        const rgRatio = range / data

        if (azRatio > worstAzimuth) {
          worstAzimuth = azRatio
          worstAzimuthAtM = distanceM
        }
        // Le deficit des anneaux vit dans le champ proche et moyen ; au-dela de
        // la premiere frontiere, ils resolvent la donnee. On mesure les deux
        // separement plutot que de melanger deux regimes dans un seul nombre.
        if (distanceM <= CLIPMAP_HALF_SPANS_M[0] && rgRatio > worstRangeNear) {
          worstRangeNear = rgRatio
          worstRangeNearAtM = distanceM
        }

        rows.push(
          `${(distanceM / 1000).toFixed(1).padStart(7)} km ${data.toFixed(4).padStart(8)}° ` +
            `${azimuth.toFixed(4).padStart(9)}° ${azRatio.toFixed(1).padStart(7)}x ` +
            `${range.toFixed(4).padStart(9)}° ${rgRatio.toFixed(1).padStart(7)}x`,
        )
      }

      // ⚠️ ECHEC ATTENDU — c'est la cible du chantier.
      t.checkTrue(
        'le maillage n est jamais plus grossier que la donnee, en azimut',
        worstAzimuth <= 1,
        format([
          `pire rapport ${worstAzimuth.toFixed(1)}x a ${(worstAzimuthAtM / 1000).toFixed(0)} km`,
          `l azimut ne resout la donnee que jusqu a ${(azimuthResolvedUntilM() / 1000).toFixed(2)} km`,
          '',
          ...rows,
        ]),
      )

      // ⚠️ ECHEC ATTENDU — la loi doit apprendre a suivre la camera.
      //
      // Le controle precedent dit *combien* il manque ; celui-ci dit *pourquoi*.
      // Les separer evite qu'un raffinement uniforme, qui ferait exploser le
      // budget de sommets, passe pour une solution.
      const wide = meshAzimuthPitchDeg(0, 0, 110)
      const narrow = meshAzimuthPitchDeg(0, 0, 0.5)
      t.checkTrue(
        'le pas d azimut se resserre quand le champ se resserre',
        narrow < wide,
        `champ 110° -> ${wide.toFixed(4)}° ; champ 0,5° -> ${narrow.toFixed(4)}° — ` +
          'identiques : la loi ignore le champ, et paie des colonnes derriere la tete',
      )

      // --- Le budget de sommets ------------------------------------------
      //
      // Il garde la solution autant que le probleme : resserrer l'azimut en
      // multipliant les colonnes rendrait la reconstruction plus longue que
      // plusieurs images. Le budget doit etre **redistribue**, pas augmente.
      t.check(
        'le budget de sommets ne bouge pas',
        MESH_VERTEX_BUDGET,
        106_496,
        0,
        ' sommets',
      )
      t.note(
        `${AZIMUTH_STEPS} azimuts x ${RANGE_STEPS} anneaux — reconstruction mesuree a 18 ms, ` +
          'soit une milliseconde par tranche de six mille sommets',
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

      // --- Ce que la mesure a corrige -------------------------------------
      //
      // ⚠️ J'avais conclu que l'axe des distances etait « mesure correct, ne pas
      // y toucher ». C'est vrai **a l'horizon et au-dela de la premiere
      // frontiere**, et faux entre deux et vingt-huit kilometres, ou les
      // anneaux sont quatre fois trop grossiers. La conclusion initiale avait
      // ete tiree du seul champ lointain.
      t.note(
        `anneaux sous la premiere frontiere : jusqu a ${worstRangeNear.toFixed(1)}x trop grossiers ` +
          `a ${(worstRangeNearAtM / 1000).toFixed(0)} km — reel, connu, hors cible de la phase 1`,
      )

      // --- La couture entre niveaux ---------------------------------------
      //
      // Elle est invisible aujourd'hui parce que le maillage est trois fois plus
      // grossier que l'ecart qu'elle produit. Affiner l'azimut la rendra
      // visible : c'est une consequence attendue de la phase 1, pas une
      // regression.
      const inner = dataStepM(CLIPMAP_HALF_SPANS_M[0] - 100)
      const outer = dataStepM(CLIPMAP_HALF_SPANS_M[0] + 100)
      t.note(
        `frontiere a ${(CLIPMAP_HALF_SPANS_M[0] / 1000).toFixed(0)} km : le pas passe de ` +
          `${inner.toFixed(1)} m a ${outer.toFixed(1)} m (${(outer / inner).toFixed(2)}x) — ` +
          'noye aujourd hui sous un maillage plus grossier encore',
      )
    },
  )
}
