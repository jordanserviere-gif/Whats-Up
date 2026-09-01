/**
 * Validation de la table de ciel.
 *
 * Contrairement a la table de colonne, celle-ci est **lue directement par le
 * rendu** : son erreur se voit a l'ecran. Elle est donc mesuree la ou elle
 * compte — en **niveaux d'affichage**, apres exposition et transform, et non en
 * ecart relatif sur une radiance.
 *
 * La distinction n'est pas rhetorique. Mesuree en relatif, l'erreur au bord de
 * l'ombre terrestre atteint plusieurs centaines de pour cent : l'interpolation
 * ne peut pas representer une discontinuite. Mesuree en niveaux, elle vaut
 * trois — parce que les deux valeurs y sont sombres, et que c'est ce que l'oeil
 * voit.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { uniformSpectralGrid } from '../spectral/SpectralGrid'
import { skyRadiance } from '../transport/singleScattering'
import { buildColumnLut } from './transmittanceLut'
import {
  buildSkyViewLut,
  fillSkyViewRows,
  sampleSkyViewLut,
  skyViewAltitudeDeg,
  skyViewV,
} from './skyViewLut'
import { displayTransform } from '@/scene/display/tonemap'
import { SKY_DISPLAY_EXPOSURE } from '@/scene/display/exposure'

const grid = uniformSpectralGrid(360, 830, 16)

/** Encodage sRGB, pour mesurer l'erreur dans l'unite ou elle se voit. */
const encodeSrgb = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)

const toBytes = (rgb: readonly [number, number, number]): [number, number, number] => {
  const display = displayTransform([
    rgb[0] * SKY_DISPLAY_EXPOSURE,
    rgb[1] * SKY_DISPLAY_EXPOSURE,
    rgb[2] * SKY_DISPLAY_EXPOSURE,
  ])
  return [
    Math.round(255 * encodeSrgb(Math.max(0, Math.min(1, display[0])))),
    Math.round(255 * encodeSrgb(Math.max(0, Math.min(1, display[1])))),
    Math.round(255 * encodeSrgb(Math.max(0, Math.min(1, display[2])))),
  ]
}

export function skyViewLutSuite(): SuiteResult {
  return suite('Table de ciel', {}, (t) => {
    // --- Parametrisation verticale ----------------------------------------
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      t.check(`aller-retour de la hauteur (v = ${v})`, skyViewV(skyViewAltitudeDeg(v)), v, 1e-12)
    }
    t.check('v = 0 designe l’horizon', skyViewAltitudeDeg(0), 0, 1e-12, '°')
    t.check('v = 1 designe le zenith', skyViewAltitudeDeg(1), 90, 1e-12, '°')
    // Le carre concentre les lignes pres de l'horizon : la premiere ligne d'une
    // table de trente-deux doit y tomber a une fraction de degre.
    t.checkTrue(
      'la parametrisation concentre les lignes pres de l’horizon',
      skyViewAltitudeDeg(1 / 31) < 0.15,
      `premiere ligne d’une table de 32 : ${skyViewAltitudeDeg(1 / 31).toFixed(3)}° — ` +
        `un maillage uniforme la placerait a 2,9°, au-dessus de toute l’arche crepusculaire`,
    )

    const columnLut = buildColumnLut()
    const options = { columnLut }

    // --- Erreur d'interpolation, en niveaux d'affichage --------------------
    let worst = 0
    let worstAt = ''
    for (const sunAltitude of [64.5, 35, 9, 0, -4, -8]) {
      const lut = buildSkyViewLut(grid, sunAltitude, { width: 64, height: 32, ...options })
      for (let i = 0; i <= 20; i++) {
        for (let j = 0; j <= 20; j++) {
          const altitude = 90 * (i / 20) ** 2
          const azimuth = 180 * (j / 20)
          const reference = toBytes(skyRadiance(grid, altitude, azimuth, sunAltitude, options).linearSrgb)
          const sampled = toBytes(sampleSkyViewLut(lut, altitude, azimuth))
          const gap = Math.max(...reference.map((v, c) => Math.abs(v - sampled[c])))
          if (gap > worst) {
            worst = gap
            worstAt = `Soleil ${sunAltitude}°, visee ${altitude.toFixed(1)}°/${azimuth.toFixed(0)}° : ` +
              `${reference.join(',')} contre ${sampled.join(',')}`
          }
        }
      }
    }
    t.check('erreur maximale, en niveaux d’affichage', worst, 0, 4)
    t.note(`erreur maximale : ${worst} niveaux sur 255 (${worstAt})`)

    // --- La symetrie du plan solaire ---------------------------------------
    // Ne stocker que la moitie du tour n'est exact que si le ciel est
    // reellement symetrique. Si cette propriete cassait, la moitie du ciel
    // serait fausse sans que rien ne le signale.
    const lut = buildSkyViewLut(grid, 25, { width: 64, height: 32, ...options })
    for (const [altitude, azimuth] of [[10, 40], [45, 120], [3, 170]] as const) {
      const left = sampleSkyViewLut(lut, altitude, azimuth)
      const right = sampleSkyViewLut(lut, altitude, -azimuth)
      t.check(`symetrie du plan solaire a ${altitude}°/${azimuth}°`, Math.abs(left[1] - right[1]), 0, 1e-12)
      const wrapped = sampleSkyViewLut(lut, altitude, azimuth + 360)
      t.check(`repliement de l’azimut a ${altitude}°/${azimuth}°`, Math.abs(left[1] - wrapped[1]), 0, 1e-12)
    }

    // --- Sous l'horizon ------------------------------------------------------
    t.checkTrue(
      'aucune radiance sous l’horizon',
      sampleSkyViewLut(lut, -1, 0).every((v) => v === 0),
      'le rayon y rencontre le sol ; le sol est de toute facon dessine par-dessus',
    )

    // --- Construction etalee vs construction d'un trait ----------------------
    // Le rendu construit la table quelques lignes par image. Les deux chemins
    // doivent donner exactement la meme table, sans quoi le ciel changerait
    // selon la charge de la machine.
    const whole = buildSkyViewLut(grid, 12, { width: 32, height: 16, ...options })
    const piecewise = new Float32Array(32 * 16 * 4)
    for (let from = 0; from < 16; from += 3) {
      fillSkyViewRows(piecewise, grid, 12, 32, 16, from, Math.min(16, from + 3), options)
    }
    let pieceGap = 0
    for (let i = 0; i < piecewise.length; i++) pieceGap = Math.max(pieceGap, Math.abs(piecewise[i] - whole.data[i]))
    t.check('construction etalee identique a la construction d’un trait', pieceGap, 0, 0)

    // --- Structures conservees par la table ----------------------------------
    // Les emergences validees en phase 5 doivent survivre a la tabulation.
    const day = buildSkyViewLut(grid, 45, { width: 64, height: 32, ...options })
    const zenith = sampleSkyViewLut(day, 88, 90)
    const horizon = sampleSkyViewLut(day, 2, 90)
    t.checkTrue(
      'le zenith reste plus bleu que rouge',
      zenith[2] > 2 * zenith[0],
      `B/R = ${(zenith[2] / zenith[0]).toFixed(2)}`,
    )
    t.checkTrue(
      'l’horizon reste plus lumineux et moins sature',
      horizon[1] > zenith[1] && horizon[2] / horizon[0] < zenith[2] / zenith[0],
      `zenith B/R ${(zenith[2] / zenith[0]).toFixed(2)} · horizon B/R ${(horizon[2] / horizon[0]).toFixed(2)}`,
    )

    const dusk = buildSkyViewLut(grid, -4, { width: 64, height: 32, ...options })
    t.checkTrue(
      'l’arche crepusculaire survit a la tabulation',
      sampleSkyViewLut(dusk, 2, 0)[0] > 10 * sampleSkyViewLut(dusk, 2, 180)[0],
      `vers le Soleil ${sampleSkyViewLut(dusk, 2, 0)[0].toExponential(2)} · ` +
        `oppose ${sampleSkyViewLut(dusk, 2, 180)[0].toExponential(2)}`,
    )
  })
}
