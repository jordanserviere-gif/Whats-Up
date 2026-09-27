/**
 * Validation de la surface de l'eau.
 *
 * 1. Fresnel : 2,0 % a l'incidence normale pour n = 1,333, 100 % en rasant,
 *    croissance monotone — formes closes.
 * 2. Cox & Munk : la variance publiee a 10 m/s (0,0542).
 * 3. JONSWAP : l'integrale du spectre vaut Hs²/16 (definition de Hs).
 * 4. Trains de vagues : la variance de l'elevation est conservee, et leur
 *    variance de pentes reste sous celle de Cox & Munk — la part non resolue,
 *    rendue en statistique, n'est jamais negative.
 */
import { suite, type SuiteResult } from '../validation/harness'
import {
  coxMunkSlopeVariance,
  fetchLimitedSea,
  fresnelDielectric,
  fullyDevelopedSea,
  jonswap,
  slopeVarianceOf,
  waveTrains,
} from './seaSurface'

export function seaSurfaceSuite(): SuiteResult {
  return suite('Surface de l’eau — Fresnel, Cox & Munk, JONSWAP', { reference: 'Cox & Munk (1954) ; Hasselmann et al. (1973) ; Goda (1988) ; Bruneton et al. (2010)' }, (t) => {
    t.check('Fresnel a l’incidence normale, n = 1,333', fresnelDielectric(1), ((1.333 - 1) / (1.333 + 1)) ** 2, 1e-12)
    t.check('Fresnel en rasant → 1', fresnelDielectric(0), 1, 1e-9)
    t.checkMonotonic('Fresnel croissant vers le rasant', [1, 0.8, 0.6, 0.4, 0.2, 0.05].map((c) => fresnelDielectric(c)), 'croissant')

    t.check('Cox & Munk a 10 m/s', coxMunkSlopeVariance(10), 0.0542, 1e-9)

    for (const [hs, tp] of [[1, 6], [3, 10]] as const) {
      let m0 = 0
      const n = 20000
      for (let i = 0; i < n; i++) {
        const f = 0.01 + (i + 0.5) * (2 / n)
        m0 += jonswap(f, hs, tp) * (2 / n)
      }
      t.checkRelative(`JONSWAP : ∫S = Hs²/16, Hs = ${hs} m, Tp = ${tp} s`, m0, (hs * hs) / 16, 0.03)
    }

    const sea = fullyDevelopedSea(8)
    const waves = waveTrains({ hs: sea.hs, tp: sea.tp, towardDeg: 90, spreading: 4 }, 24, 7)
    const variance = waves.reduce((s, w) => s + (w.amplitude * w.amplitude) / 2, 0)
    t.checkRelative('trains de vagues : variance de l’elevation = Hs²/16 (a la bande tiree pres)', variance, (sea.hs * sea.hs) / 16, 0.08)
    t.checkTrue(
      `pentes des trains (${slopeVarianceOf(waves).toFixed(4)}) sous Cox & Munk (${coxMunkSlopeVariance(8).toFixed(4)})`,
      slopeVarianceOf(waves) < coxMunkSlopeVariance(8),
    )
    const lake = fetchLimitedSea(8, 5000)
    t.checkTrue(`lac : mer limitee par le fetch (Hs ${lake.hs.toFixed(2)} m) sous la mer levee (${sea.hs.toFixed(2)} m)`, lake.hs < sea.hs && lake.tp < sea.tp)
  })
}
