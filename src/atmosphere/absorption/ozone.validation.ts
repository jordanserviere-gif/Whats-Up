/**
 * Validation de l'ozone — phase 7.
 *
 * La phase 5 avait laisse **deux cibles chiffrees**, et cette suite verifie
 * qu'elles sont atteintes :
 *
 * 1. le ciel de journee depassait les paliers publies de 5 a 35 % — l'ecart
 *    doit se reduire ;
 * 2. le zenith crepusculaire ressortait quasi blanc (0,339 · 0,346) la ou le
 *    ciel reel est franchement bleu — il doit devenir bleu.
 *
 * La seconde est la plus interessante, parce qu'elle ne se joue pas sur une
 * intensite mais sur une **couleur**, et qu'elle reproduit un resultat
 * classique : Hulburt (1953). Le bleu du ciel crepusculaire ne vient pas de
 * Rayleigh mais de la bande de Chappuis.
 *
 * La comparaison se fait a colonne d'ozone nulle contre 300 DU, c'est-a-dire
 * **par le meme chemin de code**. Aucun ancien resultat n'est recopie : les
 * deux termes de la comparaison sont recalcules.
 */
import { solarIlluminance } from '@/astro/photometry'
import { suite, type SuiteResult } from '../validation/harness'
import { uniformSpectralGrid } from '../spectral/SpectralGrid'
import { buildColumnLut } from '../lut/transmittanceLut'
import { columnsToSpace } from '../transport/slantPath'
import { directSolar } from '../transport/directSolar'
import { diffuseHorizontalIlluminance, skyRadiance } from '../transport/singleScattering'
import {
  DEFAULT_OZONE_COLUMN_DU,
  DOBSON_UNIT,
  OZONE_BOTTOM_M,
  OZONE_PEAK_M,
  OZONE_PROFILE_INTEGRAL_M,
  OZONE_TOP_M,
  ozoneCrossSection,
  ozoneNumberDensity,
  ozoneProfileShape,
  ozoneVerticalOpticalDepth,
  rawOzoneCrossSection,
} from './ozone'

const grid = uniformSpectralGrid(360, 830, 16)
const WHITE = [0.3127, 0.329] as const
const distanceToWhite = (c: readonly [number, number]) => Math.hypot(c[0] - WHITE[0], c[1] - WHITE[1])

export function ozoneSuite(): SuiteResult {
  return suite(
    'Ozone et bande de Chappuis (phase 7)',
    { reference: 'IUP Bremen o3spectra2011 (233 K) ; Hulburt (1953)' },
    (t) => {
      // --- Les sections efficaces --------------------------------------------
      const raw = rawOzoneCrossSection()
      t.check('nombre d’intervalles tabules', raw.lambdaNm.length, 48, 0)

      const peakIndex = raw.crossSection.indexOf(Math.max(...raw.crossSection))
      t.checkRelative('pic de la bande de Chappuis', raw.crossSection[peakIndex], 5.019e-25, 1e-6, ' m²')
      t.checkTrue(
        'la bande de Chappuis culmine dans l’orange',
        raw.lambdaNm[peakIndex] > 580 && raw.lambdaNm[peakIndex] < 620,
        `${raw.lambdaNm[peakIndex]} nm — c’est-a-dire precisement ce que la diffusion Rayleigh laisse passer`,
      )
      t.checkTrue(
        'l’ozone absorbe peu dans le bleu',
        ozoneCrossSection(450) < 0.1 * ozoneCrossSection(600),
        `σ(450) = ${ozoneCrossSection(450).toExponential(2)} m² contre ` +
          `σ(600) = ${ozoneCrossSection(600).toExponential(2)} m² — un facteur ` +
          `${(ozoneCrossSection(600) / ozoneCrossSection(450)).toFixed(0)}`,
      )
      t.check('aucune absorption hors du domaine tabule', ozoneCrossSection(300), 0, 0, ' m²')

      // --- Epaisseur optique verticale ---------------------------------------
      // Modeste : negligeable au zenith, decisive au crepuscule ou la geometrie
      // rasante multiplie le trajet par plusieurs dizaines.
      t.check('epaisseur optique verticale a 600 nm (300 DU)', ozoneVerticalOpticalDepth(600), 0.039, 0.004)
      t.note(
        `epaisseur optique verticale (300 DU) : ${[450, 500, 550, 600, 650, 700]
          .map((nm) => `${nm} nm → ${ozoneVerticalOpticalDepth(nm).toFixed(4)}`)
          .join(' · ')}`,
      )

      // --- Le profil vertical -------------------------------------------------
      t.check('profil nul sous 10 km', ozoneProfileShape(OZONE_BOTTOM_M - 1), 0, 0)
      t.check('profil nul au-dessus de 40 km', ozoneProfileShape(OZONE_TOP_M + 1), 0, 0)
      t.check('profil maximal a 25 km', ozoneProfileShape(OZONE_PEAK_M), 1, 1e-12)
      t.check('integrale du profil normalise', OZONE_PROFILE_INTEGRAL_M, 15_000, 1e-9, ' m')

      // La colonne totale doit valoir exactement ce qu'on a demande : c'est la
      // grandeur mesurable, et la seule que les satellites publient.
      let column = 0
      const step = 25
      for (let z = 0; z < 50_000; z += step) column += ozoneNumberDensity(z + step / 2) * step
      t.checkRelative(
        'colonne totale = 300 unites Dobson',
        column,
        DEFAULT_OZONE_COLUMN_DU * DOBSON_UNIT,
        1e-4,
        ' m⁻²',
      )
      t.note(`1 DU = ${DOBSON_UNIT.toExponential(3)} molecules/m² ; 300 DU = ${column.toExponential(3)} m⁻²`)

      // --- Le second canal de la table ----------------------------------------
      // L'ozone n'a pas le meme profil vertical que l'air : son rapport
      // oblique/vertical differe, et c'est ce qui interdit de garder une seule
      // colonne pour les deux especes.
      const grazing = columnsToSpace(0, 0.02, 1024)
      const vertical = columnsToSpace(0, 1, 1024)
      const airRatio = grazing.air / vertical.air
      const ozoneRatio = grazing.ozone / vertical.ozone
      // L'ozone s'allonge **moins** que l'air, et la geometrie l'explique : un
      // rayon rasant parti du sol y voyage tangentiellement, donc traverse
      // l'air bas sous une incidence extreme. Quand il atteint 25 km il a deja
      // grimpe, la verticale locale a tourne de cinq degres, et son angle
      // zenithal local n'est plus que 85°. C'est l'inverse de ce que
      // l'intuition suggere, et c'est mesure.
      t.checkTrue(
        'l’ozone s’allonge moins que l’air en visee rasante',
        ozoneRatio < airRatio * 0.7,
        `air ×${airRatio.toFixed(1)}, ozone ×${ozoneRatio.toFixed(1)} — l’air bas est traverse ` +
          `tangentiellement, l’ozone a 25 km sous 85° seulement. Deux rapports differents : ` +
          `une seule colonne ne peut plus servir les deux especes.`,
      )

      // --- Cible 1 : le depassement de journee doit se reduire ----------------
      const columnLut = buildColumnLut()
      const withoutOzone = { columnLut: buildColumnLut({ ozoneColumnDobsonUnits: 0 }), ozoneColumnDobsonUnits: 0 }
      const hemisphere = { zenithSamples: 12, azimuthSamples: 24 }

      for (const h of [90, 45, 20]) {
        const published = solarIlluminance(h)
        const before =
          directSolar(grid, h, { ozoneColumnDobsonUnits: 0 }).horizontalIlluminanceLux +
          diffuseHorizontalIlluminance(grid, h, { ...hemisphere, ...withoutOzone })
        const after =
          directSolar(grid, h).horizontalIlluminanceLux +
          diffuseHorizontalIlluminance(grid, h, { ...hemisphere, columnLut })
        t.checkTrue(
          `a ${h}°, l’ozone reduit le depassement`,
          Math.abs(after / published - 1) < Math.abs(before / published - 1),
          `sans ozone +${((before / published - 1) * 100).toFixed(0)} % → ` +
            `avec ozone ${after > published ? '+' : ''}${((after / published - 1) * 100).toFixed(0)} %`,
        )
      }

      // --- Cible 2 : le zenith crepusculaire doit devenir bleu ----------------
      // C'est le resultat de Hulburt, et il se lit sur une chromaticite.
      const duskWithout = skyRadiance(grid, 88, 0, -4, withoutOzone)
      const duskWith = skyRadiance(grid, 88, 0, -4, { columnLut })

      t.checkTrue(
        'sans ozone, le zenith crepusculaire est quasi blanc',
        distanceToWhite(duskWithout.chromaticity) < 0.05,
        `(${duskWithout.chromaticity.map((v) => v.toFixed(3)).join(', ')}) contre (${WHITE.join(', ')})`,
      )
      t.checkTrue(
        'avec ozone, le zenith crepusculaire devient bleu',
        duskWith.chromaticity[0] < 0.29 && duskWith.chromaticity[1] < 0.29,
        `(${duskWith.chromaticity.map((v) => v.toFixed(3)).join(', ')}) — ` +
          `le bleu du ciel crepusculaire vient de la bande de Chappuis, pas de Rayleigh (Hulburt 1953)`,
      )
      t.checkTrue(
        'l’ozone eloigne le crepuscule du blanc',
        distanceToWhite(duskWith.chromaticity) > 2 * distanceToWhite(duskWithout.chromaticity),
        `distance au blanc : ${distanceToWhite(duskWithout.chromaticity).toFixed(4)} → ` +
          `${distanceToWhite(duskWith.chromaticity).toFixed(4)}`,
      )

      // --- L'ozone absorbe : il ne peut qu'enlever ----------------------------
      // Verification structurelle. Si l'absorption etait branchee sur le terme
      // source au lieu de l'extinction, le ciel s'eclaircirait au lieu de
      // s'assombrir — et rien d'autre ne le signalerait.
      for (const [altitude, azimuth, sun] of [
        [88, 90, 60],
        [20, 0, 30],
        [2, 90, 10],
      ] as const) {
        const dim = skyRadiance(grid, altitude, azimuth, sun, { columnLut }).luminanceCdPerM2
        const bright = skyRadiance(grid, altitude, azimuth, sun, withoutOzone).luminanceCdPerM2
        t.checkTrue(
          `l’ozone assombrit le ciel a ${altitude}°/${azimuth}°, Soleil ${sun}°`,
          dim < bright,
          `${bright.toFixed(0)} → ${dim.toFixed(0)} cd/m² (−${((1 - dim / bright) * 100).toFixed(1)} %)`,
        )
      }

      // --- Monotonie en colonne ------------------------------------------------
      const byColumn: number[] = []
      for (const du of [0, 150, 300, 450]) {
        byColumn.push(directSolar(grid, 20, { ozoneColumnDobsonUnits: du }).normalIlluminanceLux)
      }
      t.checkMonotonic('plus d’ozone, moins de lumiere directe', byColumn, 'decroissant')
    },
  )
}
