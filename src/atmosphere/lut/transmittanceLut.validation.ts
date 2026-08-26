/**
 * Validation de la table de colonne moleculaire.
 *
 * Une LUT n'a pas de reference externe : elle **est** l'approximation d'un
 * calcul qui, lui, est deja valide. Ce qui se teste ici est donc :
 *
 * 1. **La parametrisation**, par aller-retour. Une erreur de signe ou
 *    d'inversion dans le mappage de Bruneton ne se verrait nulle part ailleurs
 *    qu'ici — elle produirait un ciel plausible mais faux.
 * 2. **L'erreur d'interpolation**, mesuree sur la grandeur qui compte : la
 *    **transmittance**, pas la colonne. La colonne varie sur des dizaines
 *    d'ordres de grandeur et son erreur relative n'a aucun sens la ou elle tend
 *    vers zero ; la transmittance, elle, est bornee et c'est elle qui entre
 *    dans l'image.
 * 3. **La coherence avec le solveur de reference** : la meme radiance de ciel,
 *    calculee avec et sans la table.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { EARTH_MEAN_RADIUS_M } from '../core/units'
import { rayleighCrossSection } from '../rayleigh/rayleigh'
import { uniformSpectralGrid } from '../spectral/SpectralGrid'
import { ATMOSPHERE_TOP_M, columnToSpace } from '../transport/slantPath'
import { skyRadiance } from '../transport/singleScattering'
import {
  buildColumnLut,
  columnLutParams,
  columnLutUv,
  fromTexelRange,
  sampleColumnLut,
  toTexelRange,
} from './transmittanceLut'

const R = EARTH_MEAN_RADIUS_M
const TOP = R + ATMOSPHERE_TOP_M

/** Cosinus zenithal du rayon rasant depuis une altitude donnee. */
const horizonCosine = (altitudeM: number) => -Math.sqrt(Math.max(0, 1 - (R / (R + altitudeM)) ** 2))

export function columnLutSuite(): SuiteResult {
  return suite(
    'Table de colonne moleculaire',
    { reference: 'parametrisation de Bruneton (2008, revisee 2017)' },
    (t) => {
      const width = 256
      const height = 64

      // --- Recentrage sur les texels -----------------------------------------
      for (const size of [16, 64, 256]) {
        for (const x of [0, 0.25, 0.5, 1]) {
          t.check(`aller-retour texel (taille ${size}, x = ${x})`, fromTexelRange(toTexelRange(x, size), size), x, 1e-12)
        }
      }

      // --- Aller-retour de la parametrisation ---------------------------------
      // C'est le controle le plus important du module : une inversion fausse
      // produirait un ciel plausible et faux, sans rien signaler.
      //
      // Le balayage s'arrete **juste sous** le sommet de l'atmosphere. Au
      // sommet exact, toute visee montante donne `d = 0` — le rayon est deja
      // dehors — et la parametrisation y est donc legitimement non injective :
      // tous les µ positifs s'y projettent sur `u = 0`. Ce n'est pas un defaut,
      // et c'est sans consequence puisque la colonne y est nulle, ce que le
      // controle suivant verifie.
      let worstAltitude = 0
      let worstCosine = 0
      for (let i = 0; i <= 12; i++) {
        const altitude = (i / 12) ** 2 * ATMOSPHERE_TOP_M * 0.999
        const muHorizon = horizonCosine(altitude)
        for (let j = 0; j <= 12; j++) {
          const mu = 1 - (j / 12) * (1 - muHorizon)
          const [u, v] = columnLutUv(altitude, mu, width, height)
          const back = columnLutParams(u, v, width, height)
          worstAltitude = Math.max(worstAltitude, Math.abs(back.altitudeM - altitude))
          worstCosine = Math.max(worstCosine, Math.abs(back.cosZenith - mu))
        }
      }
      t.check('aller-retour de la parametrisation : altitude', worstAltitude, 0, 1e-6, ' m')
      t.check('aller-retour de la parametrisation : cosinus zenithal', worstCosine, 0, 1e-9)

      // La degenerescence au sommet est inoffensive : rien a traverser.
      t.checkTrue(
        'au sommet, la colonne est nulle quelle que soit la visee montante',
        [1, 0.5, 0.2, 0.01].every((mu) => columnToSpace(ATMOSPHERE_TOP_M, mu, 64) === 0),
        'c’est pourquoi la parametrisation peut y perdre l’information de direction',
      )

      // --- Ce que designent les bords de la table -----------------------------
      const zenithGround = columnLutParams(toTexelRange(0, width), toTexelRange(0, height), width, height)
      t.check('u = 0 designe la visee zenithale', zenithGround.cosZenith, 1, 1e-9)
      t.check('v = 0 designe le sol', zenithGround.altitudeM, 0, 1e-6, ' m')

      const grazingGround = columnLutParams(toTexelRange(1, width), toTexelRange(0, height), width, height)
      t.check('u = 1 designe la visee rasante', grazingGround.cosZenith, horizonCosine(0), 1e-9)

      const top = columnLutParams(toTexelRange(0, width), toTexelRange(1, height), width, height)
      t.checkRelative('v = 1 designe le sommet de l’atmosphere', R + top.altitudeM, TOP, 1e-9, ' m')

      // --- Erreur d'interpolation, sur la transmittance -----------------------
      const lut = buildColumnLut({ width, height })
      const sigmas = [400, 550, 700].map((nm) => rayleighCrossSection(nm))

      let worstTransmittance = 0
      let worstAt = ''
      for (let i = 0; i <= 40; i++) {
        const altitude = (i / 40) ** 2 * ATMOSPHERE_TOP_M
        const muHorizon = horizonCosine(altitude)
        for (let j = 0; j <= 40; j++) {
          // On s'arrete juste avant le rasant exact : au-dela, le rayon coupe
          // la Terre et la table n'a rien a en dire.
          const mu = 1 - (j / 40) * (1 - muHorizon) * 0.999
          const reference = columnToSpace(altitude, mu, 2048)
          const sampled = sampleColumnLut(lut, altitude, mu)
          if (!Number.isFinite(reference) || !Number.isFinite(sampled)) continue
          for (const sigma of sigmas) {
            const gap = Math.abs(Math.exp(-sigma * sampled) - Math.exp(-sigma * reference))
            if (gap > worstTransmittance) {
              worstTransmittance = gap
              worstAt = `${(altitude / 1000).toFixed(1)} km, µ = ${mu.toFixed(4)}`
            }
          }
        }
      }
      t.check('erreur maximale sur la transmittance', worstTransmittance, 0, 1.5e-3)
      t.note(
        `erreur maximale sur la transmittance : ${(worstTransmittance * 100).toFixed(3)} % ` +
          `(pire cas ${worstAt}) — table ${width}x${height}, ${((width * height * 4) / 1024).toFixed(0)} ko`,
      )

      // --- Coherence avec le solveur de reference -----------------------------
      const grid = uniformSpectralGrid(360, 830, 16)
      for (const [altitude, azimuth, sunAltitude] of [
        [88, 90, 60],
        [30, 180, 20],
        [2, 90, 45],
        [10, 0, -4],
      ] as const) {
        const exact = skyRadiance(grid, altitude, azimuth, sunAltitude).luminanceCdPerM2
        const viaLut = skyRadiance(grid, altitude, azimuth, sunAltitude, { columnLut: lut }).luminanceCdPerM2
        t.checkRelative(
          `radiance a ${altitude}°/${azimuth}°, Soleil ${sunAltitude}° : table vs integration`,
          viaLut,
          exact,
          2e-3,
          ' cd/m²',
        )
      }

      // --- Monotonies ---------------------------------------------------------
      const withAltitude: number[] = []
      for (let z = 0; z <= 90_000; z += 5000) withAltitude.push(sampleColumnLut(lut, z, 1))
      t.checkMonotonic('la colonne zenithale decroit avec l’altitude', withAltitude, 'decroissant')

      const withAngle: number[] = []
      for (let k = 0; k <= 20; k++) withAngle.push(sampleColumnLut(lut, 0, 1 - (k / 20) * (1 - horizonCosine(0)) * 0.99))
      t.checkMonotonic('la colonne croit quand la visee s’abaisse', withAngle, 'croissant')

      // --- Le test d'ombre reste hors de la table ------------------------------
      t.checkTrue(
        'un rayon qui rencontre la Terre rend une colonne infinie',
        sampleColumnLut(lut, 0, -0.5) === Number.POSITIVE_INFINITY,
        'le test d’intersection reste hors de la table : c’est lui qui produit l’ombre de la Terre, ' +
          'et il ne doit pas etre interpole',
      )
      t.checkTrue(
        'un rayon rasant depuis 50 km reste fini',
        Number.isFinite(sampleColumnLut(lut, 50_000, -0.05)),
      )

      // --- Bornes -------------------------------------------------------------
      t.check('colonne nulle au sommet, visee zenithale', sampleColumnLut(lut, ATMOSPHERE_TOP_M, 1), 0, 1e-3, ' m⁻²')
      t.checkRelative(
        'colonne zenithale au sol vs integration directe',
        sampleColumnLut(lut, 0, 1),
        columnToSpace(0, 1, 2048),
        2e-3,
        ' m⁻²',
      )
    },
  )
}
