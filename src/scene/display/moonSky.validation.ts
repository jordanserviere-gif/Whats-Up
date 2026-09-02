/**
 * Validation du ciel eclaire par la Lune.
 *
 * ## Ce qui est verifie, et pourquoi c'est verifiable
 *
 * Le clair de lune ne demande **aucun modele nouveau**. La diffusion est
 * lineaire en l'eclairement de la source : le ciel de pleine Lune est le ciel
 * de jour avec le Soleil place ou est la Lune, divise par cinq cent mille. Tout
 * repose donc sur un seul nombre, `moonToSunIrradianceRatio`, et sur le fait que
 * le solveur soit deja juste.
 *
 * Ce nombre se recoupe par deux chemins independants, et c'est ce qui rend la
 * suite utile plutot que tautologique :
 *
 * 1. l'**eclairement** qu'il predit au sol — 0,25 a 0,3 lux pour une pleine
 *    Lune au zenith, valeur de manuel ;
 * 2. la **brillance de ciel** qui en resulte — 18 a 19 magnitudes par seconde
 *    d'arc carree sous pleine Lune, soit 3·10⁻³ a 8·10⁻³ cd/m², mesuree par les
 *    photometres de ciel et publiee par les observatoires.
 *
 * Le second controle traverse tout le solveur : geometrie, Rayleigh, Mie,
 * ozone, diffusion multiple. Une erreur d'echelle nulle part ailleurs ne
 * passerait.
 */
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import { uniformSpectralGrid } from '@/atmosphere/spectral/SpectralGrid'
import {
  CONTINENTAL_AEROSOL,
  aerosolOptics,
  aodFromTurbidity,
  withAod,
} from '@/atmosphere/mie/aerosol'
import { fillSkyViewRows } from '@/atmosphere/lut/skyViewLut'
import { moonToSunIrradianceRatio, solarIlluminance } from '@/astro/photometry'

/** Seize bandes suffisent a une luminance, et gardent la suite executable. */
const grid = uniformSpectralGrid(360, 830, 16)

/** Table volontairement grossiere : on mesure une moyenne, pas un degrade. */
const WIDTH = 16
const HEIGHT = 8

/**
 * Luminance moyenne d'une table de ciel, ponderee par l'angle solide, cd/m².
 *
 * Meme calcul que celui qui alimente l'adaptation dans `useAerialLut` — c'est
 * volontaire : la suite doit mesurer la grandeur que le rendu emploie, et non
 * une variante.
 */
function meanLuminance(data: Float32Array): number {
  let total = 0
  let weightTotal = 0
  for (let y = 0; y < HEIGHT; y++) {
    const v = HEIGHT > 1 ? y / (HEIGHT - 1) : 0
    const altitudeRad = ((90 * v * v) * Math.PI) / 180
    const weight = Math.cos(altitudeRad) * v
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4
      const y709 = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
      total += Math.max(0, y709) * weight
      weightTotal += weight
    }
  }
  return weightTotal > 0 ? (683 * total) / weightTotal : 0
}

export function moonSkySuite(): SuiteResult {
  return suite(
    'Ciel eclaire par la Lune',
    {
      reference:
        'eclairement de pleine Lune 0,25-0,3 lx ; brillance de ciel sous pleine Lune 18-19 mag/arcsec²',
    },
    (t) => {
      // --- Le nombre, par le premier chemin : l'eclairement -----------------
      const fullMoonLux = moonToSunIrradianceRatio(0) * solarIlluminance(90)
      t.check('eclairement de la pleine Lune au zenith', fullMoonLux, 0.27, 0.05, ' lx')
      t.note(
        `soit 1/${Math.round(1 / moonToSunIrradianceRatio(0))} de l eclairement solaire — ` +
          'le rapport de manuel est un quatre-cent-millieme',
      )

      // Le terme en φ⁴ de la magnitude lunaire rend l'effondrement du croissant.
      // Au premier quartier il ne reste qu'un dixieme environ de la pleine Lune,
      // et non la moitie que suggererait la fraction eclairee.
      const quarter = moonToSunIrradianceRatio(90) / moonToSunIrradianceRatio(0)
      t.checkTrue(
        'au quartier il reste environ un dixieme de la pleine Lune',
        quarter > 0.06 && quarter < 0.14,
        `${(quarter * 100).toFixed(1)} % — la moitie du disque est eclairee, pas la moitie de la lumiere`,
      )
      t.checkMonotonic(
        'l eclairement decroit avec l angle de phase',
        [0, 30, 60, 90, 120, 150].map((a) => moonToSunIrradianceRatio(a)),
        'decroissant',
      )

      // --- Le meme nombre, par le second : la brillance du ciel -------------
      //
      // Il traverse cette fois tout le solveur. C'est le controle qui attraperait
      // une erreur d'echelle ailleurs dans la chaine.
      const aerosols = withAod(
        aerosolOptics(grid, { ...CONTINENTAL_AEROSOL, aod550: aodFromTurbidity(1) }),
        aodFromTurbidity(1),
        aodFromTurbidity(1),
      )
      const data = new Float32Array(WIDTH * HEIGHT * 4)
      fillSkyViewRows(data, grid, 45, WIDTH, HEIGHT, 0, HEIGHT, { aerosols })
      const moonlit = meanLuminance(data) * moonToSunIrradianceRatio(0)
      // 18 mag/arcsec² valent 6,8·10⁻³ cd/m², 19 valent 2,7·10⁻³. La fourchette
      // est large parce que la brillance depend du site, de la hauteur de la
      // Lune et de la charge en aerosols — ce qui compte est l'ordre de grandeur.
      t.checkTrue(
        'le ciel de pleine Lune tombe dans la fourchette publiee',
        moonlit > 1e-3 && moonlit < 2e-2,
        `${moonlit.toExponential(2)} cd/m² pour une Lune a 45°, contre 2,7·10⁻³ a 6,8·10⁻³ ` +
          'publies (19 a 18 mag/arcsec²)',
      )

      // Le ciel sans Lune vaut environ 2·10⁻⁴ cd/m². Le clair de lune doit donc
      // le dominer d'un facteur dix a cent : c'est ce qui fait perdre trois
      // magnitudes limites, de 6,6 a 3,6 — voir `skyLuminance`.
      t.checkTrue(
        'la pleine Lune domine le fond de ciel d un a deux ordres de grandeur',
        moonlit / 2.1e-4 > 5 && moonlit / 2.1e-4 < 200,
        `${(moonlit / 2.1e-4).toFixed(0)}x le ciel sans Lune`,
      )

      t.note(
        '⚠️ le spectre lunaire est suppose solaire : l albedo de la Lune croit avec ' +
          'la longueur d onde, et le clair de lune reel est un peu plus rouge — voir le registre',
      )
    },
  )
}
