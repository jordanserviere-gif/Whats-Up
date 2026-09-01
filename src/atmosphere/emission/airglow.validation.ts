/**
 * Validation de l'airglow.
 *
 * ## Ce qui se controle, et ce qui ne se controle pas
 *
 * La **geometrie** est exacte : van Rhijn se derive, et le profil qui en sort —
 * maximum vers dix a quinze degres, effondrement a l'horizon — est le produit de
 * deux fonctions dont aucune ne decrit un degrade. C'est le resultat principal de
 * ce module.
 *
 * L'**amplitude** est ancree sur `AIRGLOW_LUX`, la constante que le moteur
 * portait deja. Le controle est donc un aller-retour : integrer la radiance sur
 * l'hemisphere doit redonner l'ancre.
 *
 * Le **spectre**, lui, n'est pas verifiable. Les longueurs d'onde des raies sont
 * exactes, leurs poids ne le sont pas — l'en-tete du module le dit. Ce qui se
 * controle est la consequence : la teinte doit etre verdatre, la raie a 557,7 nm
 * dominant le signal photopique.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { AIRGLOW_LUX } from '@/astro/photometry'
import { uniformSpectralGrid } from '../spectral/SpectralGrid'
import { chromaticity, luminance, spectralToXyz } from '../spectral/SpectralSensor'
import { buildColumnLut, sampleColumnLut } from '../lut/transmittanceLut'
import { rayleighCrossSection } from '../rayleigh/rayleigh'
import { ozoneCrossSectionOn } from '../absorption/ozone'
import { CONTINENTAL_AEROSOL, aerosolOptics, aodFromTurbidity } from '../mie/aerosol'
import {
  AIRGLOW_LAYER_ALTITUDE_M,
  AIRGLOW_LINES,
  airglowRadiance,
  airglowZenithRadiance,
  vanRhijn,
} from './airglow'

const grid = uniformSpectralGrid(360, 830, 32)

export function airglowSuite(): SuiteResult {
  return suite(
    'Airglow',
    { reference: 'van Rhijn (1921) ; spectre a confronter aux atlas de ciel nocturne' },
    (t) => {
      // --- La geometrie, exacte -----------------------------------------------
      t.check('van Rhijn vaut 1 au zenith', vanRhijn(0), 1, 1e-12)
      t.checkMonotonic(
        'et croit vers l’horizon',
        [0, 30, 60, 75, 85, 89].map((z) => vanRhijn(z)),
        'croissant',
      )
      t.checkRelative(
        'a l’horizon, la couche est vue six fois plus epaisse',
        vanRhijn(90),
        6.01,
        0.01,
      )
      // La valeur limite est fixee par la seule geometrie de la coquille.
      const ratio = 6_371_000 / (6_371_000 + AIRGLOW_LAYER_ALTITUDE_M)
      t.checkRelative(
        'et cette valeur est 1/√(1 − [R/(R+h)]²)',
        vanRhijn(90),
        1 / Math.sqrt(1 - ratio * ratio),
        1e-9,
      )

      // --- L'amplitude : aller-retour sur l'ancre du moteur --------------------
      const zenith = airglowZenithRadiance(grid)
      const zenithLuminance = luminance(grid, zenith)

      // `E = ∫L·cos z dω = 2π ∫₀¹ V(µ)·µ dµ · L_zenith`
      let geometry = 0
      const steps = 2048
      for (let i = 0; i < steps; i++) {
        const mu = (i + 0.5) / steps
        geometry += vanRhijn((Math.acos(mu) * 180) / Math.PI) * mu * (1 / steps)
      }
      geometry *= 2 * Math.PI
      t.checkRelative(
        'l’integrale sur l’hemisphere redonne l’ancre du moteur',
        geometry * zenithLuminance,
        AIRGLOW_LUX,
        1e-3,
        'lx',
      )

      // --- ⚠️ Confrontation a l'observation -------------------------------------
      // Le resultat est **plus faible que le ciel nocturne observe**, et il faut
      // le dire : l'ancre du moteur vaut 2·10⁻⁴ lux, la la litterature donne
      // plutot 10⁻³ pour un ciel sans Lune. L'ecart n'est pas corrige ici —
      // toucher a `AIRGLOW_LUX` decalerait tout le calcul de magnitude limite.
      const magPerArcsec2 = 12.58 - 2.5 * Math.log10(zenithLuminance)
      t.checkTrue(
        'la brillance de surface est du bon ordre, quoique faible',
        magPerArcsec2 > 22 && magPerArcsec2 < 25,
        `${magPerArcsec2.toFixed(2)} mag/arcsec² au zenith. Le ciel nocturne naturel observe ` +
          'vaut 21,8 a 22,3, mais il comprend aussi la lumiere zodiacale et la lumiere ' +
          'stellaire integree, que ce module ne represente pas. L’ancre `AIRGLOW_LUX` ' +
          'parait par ailleurs basse d’un facteur cinq — signale, non corrige',
      )

      // --- La teinte, consequence des poids ------------------------------------
      const xy = chromaticity(spectralToXyz(grid, zenith))
      t.checkTrue(
        'la teinte est verdatre',
        xy[1] > xy[0] && xy[1] > 0.5,
        `chromaticite (${xy[0].toFixed(4)} · ${xy[1].toFixed(4)}) — la raie de l’oxygene a ` +
          '557,7 nm domine le signal photopique',
      )
      t.checkTrue(
        'la raie verte est la plus forte',
        AIRGLOW_LINES[0].lambdaNm === 557.7 &&
          AIRGLOW_LINES.every((line) => line.weight <= AIRGLOW_LINES[0].weight),
        'OI 557,7 nm, poids 1,0 — les autres lui sont rapportees',
      )

      // ⚠️ Trois raies etroites sur une grille large : la chromaticite depend un
      // peu de la resolution, les bords de bande ne tombant pas au meme endroit.
      const byResolution = [16, 32, 64, 128].map((count) => {
        const g = uniformSpectralGrid(360, 830, count)
        return chromaticity(spectralToXyz(g, airglowZenithRadiance(g)))
      })
      const spread = Math.max(...byResolution.map((c) => c[0])) - Math.min(...byResolution.map((c) => c[0]))
      t.checkTrue(
        'la teinte depend un peu de la resolution spectrale, et cela se mesure',
        spread < 0.06,
        `${spread.toFixed(4)} d’ecart en x entre 16 et 128 bandes — c’est la limite de la ` +
          'representation d’un spectre de raies sur une grille large, non une erreur. ' +
          'Le rendu emploie 32 bandes, ou la valeur s’est stabilisee',
      )

      // --- Le resultat principal : le profil emerge -----------------------------
      // Ni van Rhijn ni l'extinction ne decrivent un degrade. Leur produit, si.
      const columnLut = buildColumnLut({ aerosolScaleHeightM: CONTINENTAL_AEROSOL.scaleHeightM })
      const aerosols = aerosolOptics(grid, { ...CONTINENTAL_AEROSOL, aod550: aodFromTurbidity(1) })
      const ozoneSigma = ozoneCrossSectionOn(grid)

      const observed = (altitudeDeg: number): number => {
        const columns = sampleColumnLut(columnLut, 0, Math.sin((altitudeDeg * Math.PI) / 180))
        if (!Number.isFinite(columns.air)) return 0
        const emitted = airglowRadiance(grid, altitudeDeg)
        const attenuated = new Float64Array(grid.count)
        for (let b = 0; b < grid.count; b++) {
          const lambdaNm = (grid.edgesNm[b] + grid.edgesNm[b + 1]) / 2
          const tau =
            rayleighCrossSection(lambdaNm) * columns.air +
            ozoneSigma[b] * columns.ozone +
            aerosols.extinction[b] * columns.aerosolShape * aerosols.groundNumberDensity
          attenuated[b] = emitted[b] * Math.exp(-tau)
        }
        return luminance(grid, attenuated)
      }

      const atZenith = observed(90)
      const samples = [90, 45, 30, 20, 15, 10, 7, 5, 3, 1].map((a) => ({ a, v: observed(a) / atZenith }))
      let peak = samples[0]
      for (const s of samples) if (s.v > peak.v) peak = s

      t.checkTrue(
        'le ciel nocturne est plus clair a mi-hauteur qu’au zenith',
        peak.v > 1.8 && peak.a >= 7 && peak.a <= 20,
        `maximum de ${peak.v.toFixed(2)}× a ${peak.a}° de hauteur — van Rhijn amplifie, ` +
          'l’extinction eteint, et leur produit place le maximum la',
      )
      t.checkTrue(
        'et s’effondre au ras de l’horizon',
        observed(1) / atZenith < 0.5,
        `${(observed(1) / atZenith).toFixed(3)}× a 1° — une visee rasante traverse quarante ` +
          'fois la colonne d’air du zenith',
      )
      t.checkTrue(
        'ce profil ne sort d’aucune des deux fonctions prises seule',
        vanRhijn(90 - 1) > vanRhijn(90 - 15),
        `van Rhijn croit encore a 1° (${vanRhijn(89).toFixed(2)} contre ` +
          `${vanRhijn(75).toFixed(2)} a 15°) : c’est l’extinction qui retourne la courbe`,
      )
    },
  )
}
