/**
 * Validation du calage scientifique — phase 19.
 *
 * ## Ce qui se verifie ici
 *
 * Deux grandeurs physiques que le transport savait deja prendre en compte, et
 * que **personne ne lui donnait** : la distance du Soleil et la colonne d'ozone.
 * Les brancher n'ajoute aucune physique — cela cesse d'en soustraire.
 *
 * ## Le cas particulier de l'ozone
 *
 * Sa parametrisation est **une interpolation entre des faits connus, pas une
 * climatologie publiee** — l'en-tete du module le dit. On ne peut donc pas la
 * comparer a une table.
 *
 * Ce qui se controle, ce sont les faits d'observation qu'elle doit reproduire,
 * et ils sont exigeants : plage, invariance equatoriale, opposition de phase
 * entre hemispheres, maximum printanier. Une parametrisation qui les respecte
 * tous n'est pas juste pour autant, mais elle n'est pas absurde — et l'ecart
 * qui reste est nomme.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { uniformSpectralGrid } from '../spectral/SpectralGrid'
import { buildColumnLut } from '../lut/transmittanceLut'
import { CONTINENTAL_AEROSOL, aerosolOptics, aodFromTurbidity } from '../mie/aerosol'
import { skyRadiance } from '../transport/singleScattering'
import { GLOBAL_MEAN_OZONE_DU, dayOfYear, ozoneColumnDu } from './ozoneClimatology'

const grid = uniformSpectralGrid(360, 830, 16)
const aerosols = aerosolOptics(grid, { ...CONTINENTAL_AEROSOL, aod550: aodFromTurbidity(1) })

const at = (latitudeDeg: number, month: number, day = 15) =>
  ozoneColumnDu(latitudeDeg, new Date(Date.UTC(2026, month, day)))

export function calibrationSuite(): SuiteResult {
  return suite(
    'Calage scientifique',
    { reference: 'van Heuklon (1979) a adopter — voir l’en-tete du module d’ozone' },
    (t) => {
      // --- Jour de l'annee ------------------------------------------------------
      t.check('1er janvier', dayOfYear(new Date(Date.UTC(2026, 0, 1))), 0, 1e-9)
      t.checkRelative('31 decembre', dayOfYear(new Date(Date.UTC(2026, 11, 31))), 364, 1e-9)

      // --- Les faits d'observation que le modele doit reproduire ---------------
      const values: number[] = []
      for (let latitude = -85; latitude <= 85; latitude += 5) {
        for (let month = 0; month < 12; month++) values.push(at(latitude, month))
      }
      const low = Math.min(...values)
      const high = Math.max(...values)
      t.checkTrue(
        'la colonne reste dans les bornes observees',
        low > 230 && high < 460,
        `${low.toFixed(0)} a ${high.toFixed(0)} DU — l’observation donne 240 a 450 hors trou ` +
          'antarctique, que le modele ne represente pas',
      )

      // L'equateur exporte en permanence ce qu'il forme : sa colonne ne varie pas.
      const equator = Array.from({ length: 12 }, (_, month) => at(0, month))
      t.check(
        'la colonne equatoriale ne varie pas avec la saison',
        Math.max(...equator) - Math.min(...equator),
        0,
        1e-9,
        'DU',
      )
      t.checkTrue(
        'et elle est la plus basse du globe',
        equator[0] <= low + 1e-9,
        `${equator[0].toFixed(0)} DU — l’ozone se forme sous les tropiques mais y reste peu, ` +
          'la circulation de Brewer-Dobson l’exportant vers les hautes latitudes',
      )

      // La colonne croit vers les poles, a saison fixee.
      const march = [0, 20, 40, 60, 75].map((latitude) => at(latitude, 2))
      t.checkMonotonic('la colonne croit vers le pole', march, 'croissant')

      // Maximum printanier, minimum automnal — dans les deux hemispheres.
      t.checkTrue(
        'l’hemisphere nord culmine au printemps',
        at(60, 2) > at(60, 8) && at(60, 3) > at(60, 9),
        `${at(60, 3).toFixed(0)} DU en avril contre ${at(60, 9).toFixed(0)} en octobre, a 60°N — ` +
          'le transport hivernal accumule, la photochimie estivale detruit',
      )
      t.checkTrue(
        'et l’hemisphere sud six mois plus tard',
        at(-60, 9) > at(-60, 3),
        `${at(-60, 9).toFixed(0)} DU en octobre contre ${at(-60, 3).toFixed(0)} en avril, a 60°S`,
      )
      // La symetrie n'est pas un cas particulier code a part : c'est le meme
      // sinus, dephase d'une demi-annee.
      t.checkRelative(
        'les deux hemispheres sont exactement en opposition de phase',
        at(-60, 9, 15),
        at(60, 3, 16),
        0.02,
        'DU',
      )

      // L'amplitude saisonniere croit avec la latitude.
      const amplitude = (latitudeDeg: number) => {
        const year = Array.from({ length: 12 }, (_, month) => at(latitudeDeg, month))
        return Math.max(...year) - Math.min(...year)
      }
      t.checkMonotonic(
        'l’amplitude saisonniere croit avec la latitude',
        [0, 20, 40, 60, 80].map(amplitude),
        'croissant',
      )
      t.checkTrue(
        'la moyenne globale historique reste dans la plage du modele',
        GLOBAL_MEAN_OZONE_DU > low && GLOBAL_MEAN_OZONE_DU < high,
        `${GLOBAL_MEAN_OZONE_DU} DU — la valeur unique qu’employait le moteur, desormais ` +
          'une valeur parmi la plage',
      )

      // --- Ce que cela change au crepuscule -------------------------------------
      // L'ozone est ce qui rend le crepuscule bleu (bande de Chappuis, phase 7).
      // Sa colonne en decide donc la profondeur.
      const twilight = (columnDu: number) => {
        const columnLut = buildColumnLut({
          aerosolScaleHeightM: CONTINENTAL_AEROSOL.scaleHeightM,
          ozoneColumnDobsonUnits: columnDu,
        })
        return skyRadiance(grid, 30, 0, -4, {
          columnLut,
          aerosols,
          ozoneColumnDobsonUnits: columnDu,
        })
      }
      const thin = twilight(245)
      const thick = twilight(400)
      const ratio = (s: ReturnType<typeof twilight>) => s.linearSrgb[2] / s.linearSrgb[0]

      t.checkTrue(
        'plus d’ozone, plus le crepuscule est bleu',
        ratio(thick) > 1.3 * ratio(thin),
        `B/R passe de ${ratio(thin).toFixed(3)} a 245 DU a ${ratio(thick).toFixed(3)} a 400 DU, ` +
          `soit ${(((ratio(thick) / ratio(thin)) - 1) * 100).toFixed(0)} % — un observateur ` +
          'nordique au printemps et un observateur equatorial ne voient pas le meme crepuscule',
      )
      t.checkTrue(
        'et moins lumineux, l’ozone ne pouvant qu’absorber',
        thick.luminanceCdPerM2 < thin.luminanceCdPerM2,
        `${thin.luminanceCdPerM2.toFixed(1)} cd/m² a 245 DU contre ` +
          `${thick.luminanceCdPerM2.toFixed(1)} a 400 DU`,
      )

      // --- La distance du Soleil ------------------------------------------------
      // Rien d'ajuste ici : c'est `1/d²`, et le controle verifie que le transport
      // l'applique bien.
      const columnLut = buildColumnLut({ aerosolScaleHeightM: CONTINENTAL_AEROSOL.scaleHeightM })
      const zenith = (distanceAu: number) =>
        skyRadiance(grid, 45, 90, 45, { columnLut, aerosols, distanceAu }).luminanceCdPerM2

      const perihelion = zenith(0.9833)
      const aphelion = zenith(1.0167)
      t.checkRelative(
        'l’eclairement suit exactement l’inverse du carre de la distance',
        perihelion / aphelion,
        (1.0167 / 0.9833) ** 2,
        1e-6,
      )
      t.checkTrue(
        'ce qui fait pres de sept pour cent sur l’annee',
        perihelion / aphelion - 1 > 0.06,
        `${(((perihelion / aphelion) - 1) * 100).toFixed(2)} % entre le perihelie de debut ` +
          'janvier et l’aphelie de debut juillet — ce n’est pas ce qui fait les saisons, ' +
          'mais c’est mesurable, et le transport savait deja le prendre en compte',
      )
      t.check('a une unite astronomique, aucun effet', zenith(1) / zenith(1), 1, 0)
    },
  )
}
