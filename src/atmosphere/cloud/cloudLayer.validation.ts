/**
 * Validation des nappes nuageuses.
 *
 * 1. **Eddington** : conservation de l'energie, limites mince et epaisse, et
 *    l'albedo d'un stratus contre l'ordre de grandeur mesure (~0,6 pour τ = 10).
 * 2. **Liou (1992)** : valeurs de la formule a −40 et −60 °C, et croissance du
 *    contenu en glace avec la temperature.
 * 3. **Epaisseurs optiques** d'un stratus et d'un cirrus types, dans les
 *    fourchettes restituees par satellite.
 * 4. **La structure sous-maille rend la couverture du modele** : fraction
 *    couverte mesuree sur 40 000 points contre `C`, champ resolu ou non.
 */
import { suite, type SuiteResult } from '../validation/harness'
import {
  VALUE_NOISE_VARIANCE,
  WATER_ASYMMETRY,
  eddingtonSlab,
  expectedCover,
  liouIceContentKgM3,
  normalCdf,
  normalQuantile,
  stageSlab,
  structureField,
  structureSigma,
  valueNoise,
} from './cloudLayer'

export function cloudLayerSuite(): SuiteResult {
  return suite(
    'Nappes nuageuses — Eddington, Liou, couverture sous-maille',
    { reference: 'Joseph, Wiscombe & Weinman (1976) ; Liou (1992) ; Abramowitz & Stegun 7.1.26' },
    (t) => {
      // --- 1. Eddington ------------------------------------------------------
      for (const [tau, mu0] of [[0.5, 0.8], [10, 0.5], [60, 0.2]] as const) {
        const s = eddingtonSlab(tau, WATER_ASYMMETRY, mu0)
        t.check(`R + T_diffuse + T_directe = 1, τ = ${tau}, μ₀ = ${mu0}`, s.reflectance + s.diffuseTransmittance + s.directTransmittance, 1, 1e-12)
      }
      t.check('couche vide : ni reflexion ni diffusion', eddingtonSlab(0, WATER_ASYMMETRY, 0.6).reflectance, 0, 1e-12)
      t.check('stratus τ = 10, Soleil a 30° : albedo ≈ 0,6', eddingtonSlab(10, 0.85, 0.5).reflectance, 0.59, 0.02)
      t.checkTrue('couche tres epaisse : albedo → 1', eddingtonSlab(2000, WATER_ASYMMETRY, 0.5).reflectance > 0.99)
      t.checkMonotonic(
        'albedo croissant avec τ',
        [1, 3, 10, 30, 100].map((tau) => eddingtonSlab(tau, WATER_ASYMMETRY, 0.5).reflectance),
        'croissant',
      )

      // --- 2. Liou -----------------------------------------------------------
      const liou = (c: number) => Math.exp(-7.6 + 4 * Math.exp(-2.443e-4 * Math.pow(Math.abs(c) - 20, 2.455))) * 1e-3
      t.checkRelative('Liou a −40 °C', liouIceContentKgM3(-40), liou(-40), 1e-12)
      t.check('Liou a −40 °C ≈ 7,7 mg/m³', liouIceContentKgM3(-40) * 1e6, 7.7, 0.2, ' mg/m³')
      t.checkMonotonic('glace croissante avec la temperature', [-60, -50, -40, -30, -20].map(liouIceContentKgM3), 'croissant')

      // --- 3. Epaisseurs optiques types --------------------------------------
      const stratus = stageSlab(
        'bas',
        1,
        [
          { heightM: 110, cloudFraction: 0, temperatureC: 1 },
          { heightM: 330, cloudFraction: 0.45, temperatureC: 0 },
          { heightM: 540, cloudFraction: 1, temperatureC: -1 },
          { heightM: 760, cloudFraction: 0, temperatureC: 2 },
        ],
        160,
      )
      t.checkTrue(`stratus : base ${stratus.baseM.toFixed(0)} m, sommet ${stratus.topM.toFixed(0)} m`, stratus.baseM > 300 && stratus.topM < 700)
      t.checkTrue(`stratus : τ = ${stratus.opticalDepth.toFixed(1)}, dans [3, 30]`, stratus.opticalDepth > 3 && stratus.opticalDepth < 30 && !stratus.ice)
      const cirrus = stageSlab(
        'haut',
        1,
        [
          { heightM: 7200, cloudFraction: 0, temperatureC: -30 },
          { heightM: 9200, cloudFraction: 0.8, temperatureC: -45 },
          { heightM: 10400, cloudFraction: 0.9, temperatureC: -52 },
          { heightM: 11800, cloudFraction: 0, temperatureC: -56 },
        ],
        160,
      )
      t.checkTrue(`cirrus : τ = ${cirrus.opticalDepth.toFixed(2)}, dans [0,1, 3], glace`, cirrus.opticalDepth > 0.1 && cirrus.opticalDepth < 3 && cirrus.ice)

      // --- 4. Couverture sous-maille -----------------------------------------
      t.check('Φ(Φ⁻¹(0,3)) = 0,3', normalCdf(normalQuantile(0.3)), 0.3, 1e-6)
      let m = 0
      let m2 = 0
      const N = 40_000
      for (let i = 0; i < N; i++) {
        const v = valueNoise(i * 0.7311 + 0.13, i * 0.2917 + 5.7)
        m += v
        m2 += v * v
      }
      const variance = m2 / N - (m / N) ** 2
      t.checkRelative('variance d’une octave de bruit de valeur (constante du module)', VALUE_NOISE_VARIANCE, variance, 0.05)

      const field: number[] = []
      for (let j = 0; j < 200; j++) for (let i = 0; i < 200; i++) field.push(structureField(i * 0.913, j * 0.913))
      for (const c of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        // Champ resolu : un pixel est nuage ou ciel, la fraction doit valoir C.
        const theta = structureSigma() * normalQuantile(c)
        const covered = field.filter((n) => n < theta).length / field.length
        t.check(`champ resolu, C = ${c} : fraction couverte`, covered, c, 0.04)
        // Champ non resolu : chaque pixel porte l'esperance, qui doit valoir C.
        t.check(`champ non resolu, C = ${c} : couverture moyenne`, expectedCover(c, 0, structureSigma()), c, 1e-6)
      }
    },
  )
}
