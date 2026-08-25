/**
 * Validation de l'etat atmospherique.
 *
 * L'etat n'a pas de reference publiee : c'est une structure, pas un modele. Ce
 * qui se teste ici, ce sont ses **invariants de composition** — qu'un etat par
 * defaut redonne exactement l'atmosphere standard, et qu'un ecart de
 * temperature se propage a la densite dans le bon sens et avec la bonne
 * amplitude. Ce dernier point est ce qui rendra les mirages possibles a la
 * phase 14 : si la densite ne suivait pas la temperature, aucun gradient
 * d'indice n'apparaitrait et aucun rayon ne se courberait.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { standardProfile } from '../thermodynamics/standardAtmosphere'
import { defaultAtmosphereState, sampleAtmosphere } from './AtmosphereState'

export function atmosphereStateSuite(): SuiteResult {
  return suite('Etat atmospherique (phase 1)', {}, (t) => {
    const standard = defaultAtmosphereState()

    // --- L'etat par defaut EST l'atmosphere standard -----------------------
    for (const z of [0, 1000, 11_019, 30_000, 60_000]) {
      const sample = sampleAtmosphere(standard, z)
      const reference = standardProfile(z)
      t.checkRelative(`T a ${z} m : etat par defaut = standard`, sample.temperatureK, reference.temperatureK, 1e-12, ' K')
      t.checkRelative(`P a ${z} m : etat par defaut = standard`, sample.pressurePa, reference.pressurePa, 1e-12, ' Pa')
      t.checkRelative(
        `ρ a ${z} m : etat par defaut = standard`,
        sample.densityKgPerM3,
        reference.densityKgPerM3,
        1e-12,
        ' kg/m³',
      )
    }
    t.checkTrue('l’etat par defaut est sec', sampleAtmosphere(standard, 0).vapourPressurePa === 0)

    // --- Un ecart de temperature se propage a la densite --------------------
    // A pression fixee, `ρ ∝ 1/T`. De l'air surchauffe est donc moins dense,
    // et c'est exactement le mecanisme d'un mirage inferieur.
    const hot = defaultAtmosphereState({ temperatureOffsetK: () => 10 })
    const cold = defaultAtmosphereState({ temperatureOffsetK: () => -10 })
    const atSurface = standardProfile(0)

    const hotSample = sampleAtmosphere(hot, 0)
    t.check('offset thermique applique a T', hotSample.temperatureK, atSurface.temperatureK + 10, 1e-12, ' K')
    t.checkRelative(
      'ρ suit 1/T sous un offset de +10 K',
      hotSample.densityKgPerM3,
      (atSurface.pressurePa * 0.0289644) / (8.31432 * (atSurface.temperatureK + 10)),
      1e-12,
      ' kg/m³',
    )
    t.checkTrue(
      'l’air chaud est moins dense, l’air froid plus dense',
      sampleAtmosphere(hot, 0).densityKgPerM3 < atSurface.densityKgPerM3 &&
        sampleAtmosphere(cold, 0).densityKgPerM3 > atSurface.densityKgPerM3,
      `+10 K : ${sampleAtmosphere(hot, 0).densityKgPerM3.toFixed(4)} kg/m³ · ` +
        `standard : ${atSurface.densityKgPerM3.toFixed(4)} · ` +
        `−10 K : ${sampleAtmosphere(cold, 0).densityKgPerM3.toFixed(4)}`,
    )
    t.checkTrue('la densite numerique suit la meme loi', sampleAtmosphere(hot, 0).numberDensityPerM3 < atSurface.numberDensityPerM3)

    // --- Un offset localise ne deborde pas ---------------------------------
    // Preparation de la phase 14 : une couche surchauffee de trente metres doit
    // laisser le reste de la colonne strictement intact.
    const surfaceLayer = defaultAtmosphereState({ temperatureOffsetK: (z) => (z < 30 ? 12 : 0) })
    t.check('couche surchauffee : effet a 10 m', sampleAtmosphere(surfaceLayer, 10).temperatureK - standardProfile(10).temperatureK, 12, 1e-12, ' K')
    t.check('couche surchauffee : aucun effet a 100 m', sampleAtmosphere(surfaceLayer, 100).temperatureK - standardProfile(100).temperatureK, 0, 1e-12, ' K')

    // --- Humidite -----------------------------------------------------------
    const humid = defaultAtmosphereState({ relativeHumidity: () => 0.8 })
    const humidSample = sampleAtmosphere(humid, 0)
    t.checkTrue(
      'l’humidite produit une pression de vapeur non nulle',
      humidSample.vapourPressurePa > 0 && humidSample.waterVapourMoleFraction > 0,
      `e = ${humidSample.vapourPressurePa.toFixed(1)} Pa, x_w = ${(humidSample.waterVapourMoleFraction * 100).toFixed(2)} %`,
    )
    t.checkTrue(
      'la vapeur reste une trace de la pression totale',
      humidSample.waterVapourMoleFraction < 0.03,
      'a 15 °C et 80 %, la vapeur d’eau represente moins de 3 % des molecules',
    )

    // --- Albedo du sol, condition aux limites -------------------------------
    t.checkTrue(
      'l’albedo du sol est un parametre de l’etat',
      standard.groundAlbedo > 0 && standard.groundAlbedo < 1,
      `${standard.groundAlbedo} — requis par la diffusion multiple (phase 8), ignore par le rendu actuel`,
    )
  })
}
