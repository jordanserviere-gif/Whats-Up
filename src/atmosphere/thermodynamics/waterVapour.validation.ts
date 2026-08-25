/**
 * Validation de la vapeur d'eau.
 *
 * **Le point de cette suite : ne pas comparer la formule a elle-meme.** Les
 * coefficients de Buck ont ete saisis a la main ; les confronter a des valeurs
 * de pression de vapeur saturante connues **independamment** est le seul moyen
 * de detecter une faute de frappe. Un chiffre errone dans `18,678` ou `257,14`
 * deplacerait la courbe de plusieurs pour cent et serait invisible autrement.
 */
import { CELSIUS_ZERO, US1976_GAS_CONSTANT } from '../core/constants'
import { suite, type SuiteResult } from '../validation/harness'
import {
  MOLAR_MASS_RATIO,
  enhancementFactor,
  moistAirDensity,
  saturationVapourPressureOverIce,
  saturationVapourPressureOverWater,
  vapourPressure,
  waterVapourMoleFraction,
} from './waterVapour'
import { standardProfile } from './standardAtmosphere'

const celsius = (tc: number) => tc + CELSIUS_ZERO

export function waterVapourSuite(): SuiteResult {
  return suite(
    'Vapeur d’eau (Buck 1981)',
    { reference: 'Buck, A. L. (1981), J. Appl. Meteorol. 20, 1527–1532, eq. ew2 / ei2' },
    (t) => {
      // --- Ancres independantes de la formule -------------------------------
      // Valeurs de pression de vapeur saturante largement tabulees, connues
      // hors de tout modele : c'est ce qui rend ces trois controles utiles.
      t.checkRelative('e_w(0 °C)', saturationVapourPressureOverWater(celsius(0)), 611.2, 1e-3, ' Pa')
      t.checkRelative('e_w(20 °C)', saturationVapourPressureOverWater(celsius(20)), 2338.8, 1e-3, ' Pa')
      t.checkRelative('e_w(50 °C)', saturationVapourPressureOverWater(celsius(50)), 12344, 1e-3, ' Pa')

      // 100 °C sort du domaine annonce (−80 à +50 °C) : l'ecart mesure ici
      // documente la qualite de l'extrapolation, il ne valide pas le modele.
      const boiling = saturationVapourPressureOverWater(celsius(100))
      t.note(
        `e_w(100 °C) extrapolee = ${boiling.toFixed(0)} Pa contre 101 325 Pa a l’ebullition ` +
          `(ecart ${((boiling / 101_325 - 1) * 100).toFixed(3)} %) — hors du domaine annonce`,
      )

      // --- Eau liquide et glace ---------------------------------------------
      t.checkRelative(
        'continuite eau/glace a 0 °C',
        saturationVapourPressureOverIce(celsius(0)),
        saturationVapourPressureOverWater(celsius(0)),
        2e-4,
        ' Pa',
      )
      // Sous zero, la glace sature plus bas que l'eau surfondue. C'est cet ecart
      // qui fera croitre les cristaux aux depens des gouttelettes (phase 18) :
      // s'il changeait de signe, toute la microphysique froide serait inversee.
      t.checkTrue(
        'e_i < e_w en dessous de 0 °C',
        [-5, -10, -20, -40].every((tc) => saturationVapourPressureOverIce(celsius(tc)) < saturationVapourPressureOverWater(celsius(tc))),
        `a −20 °C : glace ${saturationVapourPressureOverIce(celsius(-20)).toFixed(2)} Pa, ` +
          `eau surfondue ${saturationVapourPressureOverWater(celsius(-20)).toFixed(2)} Pa`,
      )

      // --- Monotonie --------------------------------------------------------
      const temperatures: number[] = []
      for (let tc = -80; tc <= 50; tc += 2) temperatures.push(tc)
      t.checkMonotonic(
        'e_w croit avec la temperature',
        temperatures.map((tc) => saturationVapourPressureOverWater(celsius(tc))),
        'croissant',
      )

      // --- Facteur d'accroissement -------------------------------------------
      const f = enhancementFactor(101_325)
      t.check('facteur d’accroissement au niveau de la mer', f, 1.0042, 5e-4)
      t.checkTrue('le facteur d’accroissement tend vers 1 en altitude', enhancementFactor(1000) < f)
      t.note(
        `facteur d’accroissement : +${((f - 1) * 100).toFixed(2)} % au niveau de la mer — ` +
          `coefficient a confronter a la publication avant la phase 10`,
      )

      // --- Coherence de l'humidite -------------------------------------------
      const surface = standardProfile(0)
      const e = vapourPressure(surface.temperatureK, surface.pressurePa, 0.5)
      const eSat = vapourPressure(surface.temperatureK, surface.pressurePa, 1)
      t.checkRelative('50 % d’humidite donne la moitie de la saturation', e, eSat / 2, 1e-12, ' Pa')
      t.checkTrue('l’humidite relative est bornee a [0, 1]', vapourPressure(surface.temperatureK, surface.pressurePa, 3) === eSat)

      const xw = waterVapourMoleFraction(e, surface.pressurePa)
      t.checkTrue(
        'fraction molaire de vapeur plausible a 15 °C / 50 %',
        xw > 0.005 && xw < 0.012,
        `x_w = ${(xw * 100).toFixed(3)} %`,
      )

      // --- Air humide plus leger que l'air sec -------------------------------
      // Contre-intuitif, et pourtant : la molecule d'eau pese 18 g/mol contre
      // 29 pour l'air. Si ce test s'inversait, la convection du moteur serait
      // fausse a la racine.
      const dry = moistAirDensity(surface.temperatureK, surface.pressurePa, 0, US1976_GAS_CONSTANT)
      const moist = moistAirDensity(surface.temperatureK, surface.pressurePa, eSat, US1976_GAS_CONSTANT)
      t.checkTrue(
        'l’air sature est moins dense que l’air sec',
        moist < dry,
        `sec ${dry.toFixed(5)} kg/m³, sature ${moist.toFixed(5)} kg/m³`,
      )
      t.checkRelative('air sec : densite retrouvee', dry, surface.densityKgPerM3, 1e-12, ' kg/m³')

      t.checkRelative('rapport des masses molaires eau/air', MOLAR_MASS_RATIO, 0.62198, 1e-4)
    },
  )
}
