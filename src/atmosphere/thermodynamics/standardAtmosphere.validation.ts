/**
 * Validation de l'atmosphere standard.
 *
 * Trois familles de controles, d'exigence croissante :
 *
 * 1. **Contre les tables publiees** — les huit altitudes de base de l'US1976.
 *    Le module derive ses pressions par recurrence ; les tables ne servent donc
 *    pas de source mais de juge.
 * 2. **Contre une constante de la nature** — la densite numerique aux
 *    conditions normales doit retrouver le nombre de Loschmidt, qui ne vient
 *    d'aucune table atmospherique.
 * 3. **Contre les equations elles-memes** — l'integration analytique est
 *    reconfrontee a une integration **numerique independante** de l'equilibre
 *    hydrostatique. Ce controle-la ne depend d'aucune donnee exterieure : il
 *    dirait encore la verite si toutes les tables du monde disparaissaient.
 */
import { BOLTZMANN, CELSIUS_ZERO, STANDARD_GRAVITY, DRY_AIR_MOLAR_MASS, US1976_GAS_CONSTANT } from '../core/constants'
import { suite, type SuiteResult } from '../validation/harness'
import {
  US1976_LAYERS,
  US1976_TOP_GEOPOTENTIAL_M,
  geometricFromGeopotential,
  geopotentialFromGeometric,
  scaleHeight,
  standardProfile,
} from './standardAtmosphere'

/**
 * Valeurs publiees de l'US Standard Atmosphere 1976 aux altitudes de base des
 * couches, en altitude **geopotentielle**.
 *
 * Source : NOAA-S/T 76-1562, tableau 4. Ces nombres n'entrent nulle part dans
 * le calcul du module — ils ne servent qu'ici.
 */
const PUBLISHED = [
  { geopotentialKm: 0, temperatureK: 288.15, pressurePa: 101325, densityKgPerM3: 1.225 },
  { geopotentialKm: 11, temperatureK: 216.65, pressurePa: 22632.06, densityKgPerM3: 0.363918 },
  { geopotentialKm: 20, temperatureK: 216.65, pressurePa: 5474.889, densityKgPerM3: 0.0880349 },
  { geopotentialKm: 32, temperatureK: 228.65, pressurePa: 868.0187, densityKgPerM3: 0.0132250 },
  { geopotentialKm: 47, temperatureK: 270.65, pressurePa: 110.9063, densityKgPerM3: 0.00142753 },
  { geopotentialKm: 51, temperatureK: 270.65, pressurePa: 66.93887, densityKgPerM3: 0.000861605 },
  { geopotentialKm: 71, temperatureK: 214.65, pressurePa: 3.956420, densityKgPerM3: 0.0000642110 },
  { geopotentialKm: 84.852, temperatureK: 186.946, pressurePa: 0.3734, densityKgPerM3: 0.000006958 },
] as const

/**
 * Integration numerique **independante** de l'equilibre hydrostatique.
 *
 * On integre `d(ln P)/dH = −g₀M / (R* T(H))` par la methode de Simpson sur des
 * intervalles de 10 m d'altitude geopotentielle. Passer par le logarithme est
 * ce qui rend l'exercice honnete : la pression varie de cinq ordres de grandeur,
 * et une integration directe de `dP/dH` verrait son erreur relative exploser en
 * altitude.
 *
 * Le pas est volontairement fin et fixe : les ruptures de pente de `T(H)` aux
 * limites de couches degradent l'ordre de la methode, et l'on prefere payer des
 * pas plutot que de raisonner sur un ordre de convergence qui ne tient pas.
 */
function integratePressureNumerically(targetGeopotentialM: number, stepM = 10): number {
  const gmr = (STANDARD_GRAVITY * DRY_AIR_MOLAR_MASS) / US1976_GAS_CONSTANT
  // `standardProfile` prend une altitude geometrique : on convertit a chaque
  // evaluation, de sorte que l'integration ne partage aucun chemin de code avec
  // la forme analytique qu'elle controle.
  const inverseTemperature = (geopotentialM: number) => 1 / standardProfile(geometricFromGeopotential(geopotentialM)).temperatureK

  const steps = Math.max(1, Math.round(targetGeopotentialM / stepM))
  const h = targetGeopotentialM / steps
  let logRatio = 0

  for (let i = 0; i < steps; i++) {
    const a = i * h
    const b = a + h
    const m = a + h / 2
    // Simpson sur l'intervalle.
    logRatio += (h / 6) * (inverseTemperature(a) + 4 * inverseTemperature(m) + inverseTemperature(b))
  }

  return 101_325 * Math.exp(-gmr * logRatio)
}

export function standardAtmosphereSuite(): SuiteResult {
  return suite(
    'Atmosphere standard (US Standard Atmosphere 1976)',
    { reference: 'NOAA-S/T 76-1562, tableau 4' },
    (t) => {
      // --- 1. Contre les tables publiees -----------------------------------
      for (const ref of PUBLISHED) {
        const geometricM = geometricFromGeopotential(ref.geopotentialKm * 1000)
        const point = standardProfile(geometricM)

        t.check(`T a ${ref.geopotentialKm} km'`, point.temperatureK, ref.temperatureK, 0.01, ' K')
        t.checkRelative(`P a ${ref.geopotentialKm} km'`, point.pressurePa, ref.pressurePa, 2e-4, ' Pa')
        t.checkRelative(`ρ a ${ref.geopotentialKm} km'`, point.densityKgPerM3, ref.densityKgPerM3, 5e-4, ' kg/m³')
      }

      // --- 2. Contre une constante de la nature ----------------------------
      // Nombre de Loschmidt : densite numerique d'un gaz parfait a 273,15 K et
      // 101 325 Pa. Il ne provient d'aucun modele atmospherique, ce qui en fait
      // un juge exterieur du couple (equation d'etat, constantes).
      const loschmidt = 101_325 / (BOLTZMANN * CELSIUS_ZERO)
      t.checkRelative('nombre de Loschmidt (273,15 K, 1 atm)', loschmidt, 2.6867811e25, 1e-6, ' m⁻³')

      const seaLevel = standardProfile(0)
      t.checkRelative('N au niveau de la mer (288,15 K)', seaLevel.numberDensityPerM3, 2.5469e25, 1e-4, ' m⁻³')

      // --- 3. Contre les equations, sans donnee exterieure -----------------
      for (const km of [11, 20, 47, 71]) {
        const analytic = standardProfile(geometricFromGeopotential(km * 1000)).pressurePa
        const numeric = integratePressureNumerically(km * 1000)
        t.checkRelative(`P a ${km} km' : analytique vs integration numerique`, analytic, numeric, 1e-8)
      }

      // --- Continuite aux limites de couches -------------------------------
      // Une discontinuite de pression a une interface serait physiquement
      // absurde et passerait totalement inapercue a l'oeil.
      for (const layer of US1976_LAYERS.slice(1)) {
        const zBelow = geometricFromGeopotential(layer.baseGeopotentialM - 0.001)
        const zAbove = geometricFromGeopotential(layer.baseGeopotentialM + 0.001)
        const below = standardProfile(zBelow)
        const above = standardProfile(zAbove)
        const km = layer.baseGeopotentialM / 1000
        t.checkRelative(`continuite de P a ${km} km'`, above.pressurePa, below.pressurePa, 1e-6)
        t.check(`continuite de T a ${km} km'`, above.temperatureK, below.temperatureK, 1e-4, ' K')
      }

      // --- Monotonie -------------------------------------------------------
      // Aucune reference n'est necessaire, et c'est ce qui attrape les erreurs
      // de signe — la faute la plus frequente et la moins visible.
      const altitudes: number[] = []
      for (let z = 0; z <= 86_000; z += 500) altitudes.push(z)
      t.checkMonotonic('P decroit avec l’altitude', altitudes.map((z) => standardProfile(z).pressurePa), 'decroissant')
      t.checkMonotonic('ρ decroit avec l’altitude', altitudes.map((z) => standardProfile(z).densityKgPerM3), 'decroissant')
      t.checkMonotonic(
        'N decroit avec l’altitude',
        altitudes.map((z) => standardProfile(z).numberDensityPerM3),
        'decroissant',
      )

      // La temperature, elle, n'est PAS monotone : elle remonte dans la
      // stratosphere. C'est cette non-monotonie qui fait exister la couche
      // d'ozone et les inversions — la verifier evite qu'un futur « lissage »
      // du profil ne l'efface par megarde.
      t.checkTrue(
        'T remonte dans la stratosphere (non-monotone)',
        standardProfile(47_000).temperatureK > standardProfile(20_000).temperatureK,
        `T(20 km) = ${standardProfile(20_000).temperatureK.toFixed(2)} K, T(47 km) = ${standardProfile(47_000).temperatureK.toFixed(2)} K`,
      )

      // --- Altitude geopotentielle ----------------------------------------
      t.checkRelative(
        '11 km geopotentiels en altitude geometrique',
        geometricFromGeopotential(11_000),
        11_019.1,
        1e-4,
        ' m',
      )
      for (const z of [0, 1000, 11_019, 50_000, 86_000]) {
        t.check(
          `aller-retour geometrique↔geopotentiel a ${z} m`,
          geometricFromGeopotential(geopotentialFromGeometric(z)),
          z,
          1e-6,
          ' m',
        )
      }
      t.checkTrue(
        'l’altitude geopotentielle est toujours inferieure a la geometrique',
        [1000, 10_000, 50_000, 86_000].every((z) => geopotentialFromGeometric(z) < z),
      )

      // --- Hauteur d'echelle ------------------------------------------------
      t.checkRelative('hauteur d’echelle au niveau de la mer', scaleHeight(0), 8434.5, 1e-3, ' m')
      t.checkTrue(
        'la hauteur d’echelle chute a la tropopause',
        scaleHeight(11_019) < scaleHeight(0),
        `H(0) = ${scaleHeight(0).toFixed(0)} m, H(11 km) = ${scaleHeight(11_019).toFixed(0)} m — le modele de rendu actuel fige 8 000 m`,
      )

      // --- Domaine de validite ---------------------------------------------
      t.checkTrue(
        'aucune extrapolation sous le sommet du domaine US1976',
        !standardProfile(geometricFromGeopotential(US1976_TOP_GEOPOTENTIAL_M - 1)).extrapolated,
      )
      t.checkTrue(
        'l’extrapolation au-dela de 86 km est signalee',
        standardProfile(100_000).extrapolated,
      )

      const top = standardProfile(geometricFromGeopotential(US1976_TOP_GEOPOTENTIAL_M))
      const karman = standardProfile(100_000)
      t.note(
        `pression a 100 km (extrapolee) : ${karman.pressurePa.toExponential(3)} Pa, ` +
          `soit ${(karman.pressurePa / 101_325).toExponential(2)} atm — l’extrapolation porte ` +
          `${(top.pressurePa / 101_325).toExponential(2)} de la colonne au plus`,
      )
      t.note(
        `hauteurs d’echelle : ${scaleHeight(0).toFixed(0)} m au sol, ` +
          `${scaleHeight(11_019).toFixed(0)} m a la tropopause, ${scaleHeight(50_000).toFixed(0)} m a 50 km`,
      )
    },
  )
}
