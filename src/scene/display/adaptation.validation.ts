/**
 * Validation de l'adaptation visuelle.
 *
 * ## Le controle qui porte le module
 *
 * La luminance qui pilote l'exposition est **mesuree sur la table de ciel
 * elle-meme**, en moyennant sa tranche lointaine. Elle doit donc egaler
 * `E_diffus/π`, que le solveur calcule par une integrale sur l'hemisphere — deux
 * chemins qui n'ont en commun que la physique.
 *
 * ## Ce qui est derive et ce qui est choisi
 *
 * L'exposant d'adaptation **n'est pas un reglage** : c'est
 * `1 − decades_ecran/decades_scene`. La suite le verifie plutot que de le
 * supposer, pour que modifier l'une des deux bornes le mette a jour sans que
 * personne ne l'oublie.
 *
 * Le seul choix est `DISPLAY_DECADES`, et la suite mesure sa **consequence** :
 * l'ecart d'affichage entre un midi et une nuit.
 *
 * ## La continuite
 *
 * A la luminance de reference, l'exposition adaptative doit rendre **exactement**
 * ce que rendait l'exposition fixe. Sans quoi on ne pourrait pas juger le
 * changement : tout aurait bouge partout.
 */
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import { uniformSpectralGrid } from '@/atmosphere/spectral/SpectralGrid'
import { buildColumnLut } from '@/atmosphere/lut/transmittanceLut'
import { CONTINENTAL_AEROSOL, aerosolOptics, aodFromTurbidity } from '@/atmosphere/mie/aerosol'
import { skyRadiance } from '@/atmosphere/transport/singleScattering'
import {
  createAerialLut,
  fillAerialRows,
  measureMeanSkyLuminance,
} from '@/atmosphere/lut/aerialPerspectiveLut'
import { SKY_DISPLAY_EXPOSURE } from './exposure'
import {
  ADAPTATION_EXPONENT,
  ADAPTATION_FLOOR,
  DISPLAY_DECADES,
  REFERENCE_SKY_LUMINANCE,
  SCENE_DECADES,
  PHOTOPIC_FLOOR,
  SCOTOPIC_CEILING,
  adaptiveSkyExposure,
  adaptiveWhiteLuminance,
  EYE_POINT_SPREAD_SR,
  pointSourceRetinalLuminance,
  scotopicWeight,
} from './adaptation'

const grid = uniformSpectralGrid(360, 830, 16)

export function adaptationSuite(): SuiteResult {
  return suite(
    'Adaptation visuelle',
    { reference: 'Ferwerda et al. (1996) pour la methode ; exposant derive des deux dynamiques' },
    (t) => {
      // --- La continuite, d'abord ---------------------------------------------
      t.checkRelative(
        'a la luminance de reference, l’exposition adaptative vaut la fixe',
        adaptiveSkyExposure(REFERENCE_SKY_LUMINANCE),
        SKY_DISPLAY_EXPOSURE,
        1e-12,
      )

      // --- L'exposant est derive, non choisi -----------------------------------
      t.checkRelative(
        'l’exposant est 1 − decades_ecran/decades_scene',
        ADAPTATION_EXPONENT,
        1 - DISPLAY_DECADES / SCENE_DECADES,
        1e-15,
      )
      t.checkTrue(
        'l’adaptation est partielle, et c’est ce qui fait le jour et la nuit',
        ADAPTATION_EXPONENT > 0.5 && ADAPTATION_EXPONENT < 1,
        `${(ADAPTATION_EXPONENT * 100).toFixed(1)} % — a 100 % toutes les scenes rendraient ` +
          'pareil, a 0 % on retrouverait l’exposition fixe',
      )
      t.checkRelative(
        'la scene couvre bien huit decades',
        SCENE_DECADES,
        Math.log10(REFERENCE_SKY_LUMINANCE / ADAPTATION_FLOOR),
        1e-15,
      )

      // --- La consequence du seul choix ----------------------------------------
      // L'ecart d'affichage entre un midi et une nuit doit valoir exactement les
      // decades qu'on a decide de consacrer a cet ecart.
      const dayValue = REFERENCE_SKY_LUMINANCE * adaptiveSkyExposure(REFERENCE_SKY_LUMINANCE)
      const nightValue = ADAPTATION_FLOOR * adaptiveSkyExposure(ADAPTATION_FLOOR)
      t.checkRelative(
        'l’ecart jour/nuit a l’affichage vaut les decades demandees',
        Math.log10(dayValue / nightValue),
        DISPLAY_DECADES,
        1e-12,
        'decades',
      )

      // --- Monotonies ------------------------------------------------------------
      const luminances = [3000, 300, 30, 3, 0.3, 0.03, 3e-3, 3e-4, 3e-5]
      const exposures = luminances.map((l) => adaptiveSkyExposure(l))
      t.checkMonotonic('un ciel plus sombre demande plus d’exposition', exposures, 'croissant')

      const displayed = luminances.map((l, i) => l * exposures[i])
      t.checkMonotonic(
        'mais l’image reste plus sombre — l’adaptation ne compense pas tout',
        displayed,
        'decroissant',
      )

      // --- Le plancher ------------------------------------------------------------
      t.checkRelative(
        'sous le plancher, l’adaptation cesse',
        adaptiveWhiteLuminance(ADAPTATION_FLOOR / 1000),
        adaptiveWhiteLuminance(ADAPTATION_FLOOR),
        1e-12,
        'cd/m²',
      )
      t.checkTrue(
        'et ce plancher est la luminance de l’airglow',
        Math.abs(ADAPTATION_FLOOR - 3.71e-5) < 1e-7,
        `${ADAPTATION_FLOOR.toExponential(3)} cd/m² — l’oeil ne s’adapte pas a une obscurite ` +
          'plus profonde que le ciel lui-meme',
      )

      // --- Le recoupement : deux chemins vers la meme luminance -------------------
      // La table mesure sa moyenne en parcourant ses propres texels ; le solveur
      // integre la radiance sur l'hemisphere. Rien de commun sinon la physique.
      const columnLut = buildColumnLut({ aerosolScaleHeightM: CONTINENTAL_AEROSOL.scaleHeightM })
      const aerosols = aerosolOptics(grid, { ...CONTINENTAL_AEROSOL, aod550: aodFromTurbidity(1) })
      const transport = { columnLut, aerosols }

      // Moyenne en angle solide calculee directement : echantillonnage uniforme
      // en `µ = cos z`, ou la mesure d'angle solide est constante.
      const directMean = (sunAltitudeDeg: number): number => {
        let total = 0
        const zenithSteps = 24
        const azimuthSteps = 48
        for (let i = 0; i < zenithSteps; i++) {
          const mu = (i + 0.5) / zenithSteps
          const altitudeDeg = (Math.asin(mu) * 180) / Math.PI
          for (let j = 0; j < azimuthSteps; j++) {
            const azimuthDeg = (360 * (j + 0.5)) / azimuthSteps
            total += skyRadiance(grid, altitudeDeg, azimuthDeg, sunAltitudeDeg, transport)
              .luminanceCdPerM2
          }
        }
        return total / (zenithSteps * azimuthSteps)
      }

      let worstAgreement = 0
      let worstSun = 0
      for (const sunAltitudeDeg of [60, 20, 5]) {
        const lut = createAerialLut()
        fillAerialRows(lut, grid, sunAltitudeDeg, 0, lut.height, transport)
        const gap = Math.abs(measureMeanSkyLuminance(lut) - directMean(sunAltitudeDeg)) /
          directMean(sunAltitudeDeg)
        if (gap > worstAgreement) {
          worstAgreement = gap
          worstSun = sunAltitudeDeg
        }
      }
      t.checkTrue(
        'la luminance lue sur la table vaut celle qu’integre le solveur',
        worstAgreement < 0.05,
        `ecart relatif maximal ${(worstAgreement * 100).toFixed(1)} % a ${worstSun}° — la table ` +
          'parcourt ses 64 × 32 texels, le solveur echantillonne 24 × 48 directions ' +
          'uniformement en cosinus zenithal. Rien de commun sinon la physique',
      )

      // --- La vision scotopique ------------------------------------------------
      // Les batonnets sont monochromatiques : ce n'est pas une approximation,
      // ils ne portent qu'un pigment. Sous 0,01 cd/m² il n'y a plus de vision
      // des couleurs du tout.
      t.check('vision entierement batonnets sous le plafond scotopique', scotopicWeight(1e-4), 1, 0)
      t.check('et entierement cones au-dessus du plancher photopique', scotopicWeight(10), 0, 0)
      t.checkMonotonic(
        'la bascule est monotone',
        [1e-4, 3e-3, 0.03, 0.3, 1, 3, 30].map((l) => scotopicWeight(l)),
        'decroissant',
      )
      // ⚠️ L'interpolation se fait en **logarithme** de la luminance : l'oeil
      // travaille en decades. En lineaire, un ciel a 1,8 cd/m² — presque
      // photopique — ressortait a 34 % de vision batonnets, et la bande orange
      // du crepuscule nautique en devenait grise.
      t.checkTrue(
        'a 1,8 cd/m², la vision est deja presque entierement photopique',
        scotopicWeight(1.8) < 0.1,
        `${(scotopicWeight(1.8) * 100).toFixed(1)} % de batonnets — en interpolation lineaire ` +
          'ce serait 34 %, et l’horizon crepusculaire virerait au gris',
      )
      t.checkRelative(
        'le milieu du domaine mesopique tombe a la moitie, en decades',
        scotopicWeight(Math.sqrt(SCOTOPIC_CEILING * PHOTOPIC_FLOOR)),
        0.5,
        1e-9,
      )

      // --- Ce que cela change au crepuscule ----------------------------------------
      // C'est le point de tout le module : rendre visible ce qui l'etait a peine.
      const twilight = 25 // cd/m², ciel a trois degres sous l'horizon
      const gain = adaptiveSkyExposure(twilight) / SKY_DISPLAY_EXPOSURE
      t.checkTrue(
        'le crepuscule est nettement releve',
        gain > 20 && gain < 200,
        `x${gain.toFixed(0)} d’exposition a ${twilight} cd/m² — c’est ce qui fait passer le ciel ` +
          'de presque noir a un bleu franc',
      )
      const noonGain = adaptiveSkyExposure(REFERENCE_SKY_LUMINANCE) / SKY_DISPLAY_EXPOSURE
      t.checkRelative('et le plein jour ne bouge pas', noonGain, 1, 1e-12)

      // --- La couleur d'une source ponctuelle ---------------------------------
      //
      // ⚠️ **La desaturation scotopique ne vivait que dans le fond de ciel.**
      // Les etoiles portaient la chromaticite pleine de leur corps noir quelle
      // que soit leur faiblesse, alors qu'a l'oeil nu tout ce qui passe sous la
      // deuxieme magnitude parait blanc.
      //
      // La tache de diffusion de l'oeil n'est pas choisie mais **deduite** du
      // seuil observationnel. Ce controle verifie que la valeur ainsi obtenue
      // tombe dans l'intervalle publie — une a dix minutes d'arc selon la
      // pupille — ce qui est une verification independante et non l'ancrage.
      const psfArcmin = 2 * Math.sqrt(EYE_POINT_SPREAD_SR / Math.PI) * (180 / Math.PI) * 60
      t.checkTrue(
        'la tache deduite tombe dans l’intervalle publie',
        psfArcmin > 1 && psfArcmin < 10,
        `${psfArcmin.toFixed(2)}′ de diametre, pour un oeil nu adapte a l’obscurite`,
      )

      // Les brillantes gardent leur teinte, le champ profond devient blanc, et
      // la transition est monotone — un seul renversement trahirait une erreur
      // de signe.
      const rods = [-1.4, 0, 1, 2, 3, 4, 5, 6].map((m) =>
        scotopicWeight(pointSourceRetinalLuminance(m)),
      )
      let reversals = 0
      for (let i = 1; i < rods.length; i++) if (rods[i] < rods[i - 1]) reversals++
      t.check('la couleur d’une etoile ne peut que s’effacer avec sa magnitude', reversals, 0, 0)
      t.checkTrue(
        'Sirius garde sa couleur, une etoile de sixieme magnitude n’en a plus',
        rods[0] < 0.01 && rods[7] > 0.8,
        `magnitude −1,4 : ${(rods[0] * 100).toFixed(0)} % de batonnets · ` +
          `magnitude 6 : ${(rods[7] * 100).toFixed(0)} %`,
      )
    },
  )
}
