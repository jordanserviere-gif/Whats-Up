/**
 * Validation de la diffusion multiple.
 *
 * ## Ce qui est verifiable sans donnee externe
 *
 * L'approximation de Hillaire n'a pas de table de reference a laquelle se
 * comparer : c'est un modele, pas une mesure. Ce qui se verifie, ce sont ses
 * **invariants**, et ils sont contraignants.
 *
 * - La serie geometrique ne converge que si `f_ms < 1`. C'est une condition de
 *   validite, pas une tolerance : au-dela, `1/(1−f)` change de signe et la
 *   table rend des radiances negatives.
 * - Ajouter des ordres de diffusion ne peut **qu'ajouter** de la lumiere. Un
 *   seul point ou le ciel s'assombrit signalerait une erreur de signe ou de
 *   normalisation.
 * - L'apport doit croitre avec la profondeur optique : plus fort a l'horizon
 *   qu'au zenith, plus fort quand le trouble monte.
 * - Le facteur `1/4π` de la phase isotrope ne se controle que par la seule
 *   grandeur qui le porte en valeur absolue : le bilan d'eclairement.
 *
 * ## Le facteur 4π que ces controles ont attrape
 *
 * La premiere version omettait le `p_u = 1/4π` de la source solaire dans `L_f`.
 * Les profils restaient plausibles — degrade vertical correct, horizon plus
 * clair que le zenith, couleurs dans le bon ordre — mais le ciel etait **trois
 * a six fois trop lumineux**, et le bilan de journee passait de +1 % a +17 %.
 * Seule une mesure ancree en valeur absolue pouvait le voir.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { uniformSpectralGrid } from '../spectral/SpectralGrid'
import { buildColumnLut } from '../lut/transmittanceLut'
import { CONTINENTAL_AEROSOL, aerosolOptics, aodFromTurbidity, withAod } from '../mie/aerosol'
import { standardProfile } from '../thermodynamics/standardAtmosphere'
import { solarIlluminance } from '@/astro/photometry'
import { directSolar } from './directSolar'
import { diffuseHorizontalIlluminance, skyRadiance } from './singleScattering'
import {
  buildMultipleScatteringLut,
  createMultipleScatteringLut,
  fillMultipleScatteringEntries,
  msAltitude,
  msCosSun,
  sampleMultipleScattering,
} from './multipleScattering'

const grid = uniformSpectralGrid(360, 830, 16)
const columnLut = buildColumnLut({ aerosolScaleHeightM: CONTINENTAL_AEROSOL.scaleHeightM })
const referenceAod = aodFromTurbidity(1)
const baseOptics = aerosolOptics(grid, { ...CONTINENTAL_AEROSOL, aod550: referenceAod })
const opticsFor = (turbidity: number) => withAod(baseOptics, aodFromTurbidity(turbidity), referenceAod)

const clearAir = opticsFor(1)
const lut = buildMultipleScatteringLut(grid, { aerosols: clearAir, columnLut })

const single = { columnLut, aerosols: clearAir }
const multiple = { columnLut, aerosols: clearAir, multipleScattering: lut }

export function multipleScatteringSuite(): SuiteResult {
  return suite(
    'Diffusion multiple',
    { reference: 'Hillaire (2020), Computer Graphics Forum 39(4) — approximation isotrope' },
    (t) => {
      // --- Condition de convergence de la serie -----------------------------
      // `Ψ_ms = L_f / (1 − f_ms)` n'a de sens que sous 1. Ce n'est pas une
      // tolerance a assouplir : au-dela, la table rend des radiances negatives.
      t.checkTrue(
        'la serie geometrique converge (f_ms < 1)',
        lut.maxTransferFactor < 1,
        `f_ms maximal = ${lut.maxTransferFactor.toFixed(4)}`,
      )
      t.checkTrue(
        'le facteur de transfert reste physiquement modeste',
        lut.maxTransferFactor > 0.1 && lut.maxTransferFactor < 0.9,
        `f_ms maximal = ${lut.maxTransferFactor.toFixed(4)} — hors de [0,1 ; 0,9], le milieu ` +
          'serait soit transparent soit proche de la diffusion pure',
      )

      // --- La table ne contient que des radiances positives et finies -------
      let negatives = 0
      let nonFinite = 0
      for (let i = 0; i < lut.data.length; i++) {
        if (lut.data[i] < 0) negatives++
        if (!Number.isFinite(lut.data[i])) nonFinite++
      }
      t.check('aucune radiance negative dans la table', negatives, 0, 0)
      t.check('aucune valeur non finie dans la table', nonFinite, 0, 0)

      // --- Parametrisation ---------------------------------------------------
      t.check('v = 0 designe le sol', msAltitude(0), 0, 1e-12, 'm')
      t.check('u = 0,5 designe un Soleil a l’horizon', msCosSun(0.5), 0, 1e-12)
      t.check('u = 1 designe un Soleil au zenith', msCosSun(1), 1, 1e-12)

      // --- Le remplissage par tranches donne la meme table -------------------
      // C'est ce que fait le rendu, qui etale la construction sur une soixantaine
      // d'images. Le pas de sept ne divise ni la largeur de la table ni son
      // nombre d'entrees : les coupes tombent donc au milieu des lignes, ce qui
      // est precisement le cas qu'une reprise mal ecrite raterait.
      const sliced = createMultipleScatteringLut(grid)
      const entries = sliced.width * sliced.height
      for (let from = 0; from < entries; from += 7) {
        fillMultipleScatteringEntries(sliced, grid, from, Math.min(entries, from + 7), {
          aerosols: clearAir,
          columnLut,
        })
      }
      let worstSlice = 0
      for (let i = 0; i < lut.data.length; i++) {
        const ref = Math.abs(lut.data[i])
        if (ref > 1e-12) worstSlice = Math.max(worstSlice, Math.abs(sliced.data[i] - lut.data[i]) / ref)
      }
      t.check('construction par tranches identique a la construction entiere', worstSlice, 0, 1e-12)

      // --- La diffusion multiple ne peut qu'ajouter --------------------------
      // Un seul point ou le ciel s'assombrit signalerait une erreur de signe.
      let darkened = 0
      let bestRatio = 0
      for (const sunAltitude of [60, 30, 10, 2, -2]) {
        for (const viewAltitude of [1, 5, 20, 45, 88]) {
          for (const azimuth of [0, 60, 120, 180]) {
            const a = skyRadiance(grid, viewAltitude, azimuth, sunAltitude, single)
            const b = skyRadiance(grid, viewAltitude, azimuth, sunAltitude, multiple)
            if (a.luminanceCdPerM2 < 1e-6) continue
            const ratio = b.luminanceCdPerM2 / a.luminanceCdPerM2
            if (ratio < 1) darkened++
            bestRatio = Math.max(bestRatio, ratio)
          }
        }
      }
      t.check('aucune direction assombrie par les ordres superieurs', darkened, 0, 0)
      t.checkTrue(
        'l’apport reste dans un rapport physiquement plausible',
        bestRatio < 3,
        `rapport maximal x${bestRatio.toFixed(2)} — au-dela, soupconner le facteur 1/4π de la phase isotrope`,
      )

      // --- L'apport croit avec la profondeur optique -------------------------
      // C'est la signature meme de la diffusion multiple : negligeable quand
      // τ ≪ 1, dominante quand τ approche l'unite.
      const gainAt = (viewAltitude: number, sunAltitude: number) =>
        skyRadiance(grid, viewAltitude, 90, sunAltitude, multiple).luminanceCdPerM2 /
        skyRadiance(grid, viewAltitude, 90, sunAltitude, single).luminanceCdPerM2

      const zenithGain = gainAt(88, 45)
      const horizonGain = gainAt(2, 45)
      t.checkTrue(
        'l’apport est plus fort a l’horizon qu’au zenith',
        horizonGain > zenithGain,
        `zenith x${zenithGain.toFixed(2)} contre horizon x${horizonGain.toFixed(2)} — ` +
          'le trajet rasant est optiquement bien plus epais',
      )

      // Plus d'aerosols, plus de diffuseurs, donc plus d'ordres superieurs.
      const hazy = opticsFor(5)
      const hazyLut = buildMultipleScatteringLut(grid, { aerosols: hazy, columnLut })
      const hazyGain =
        skyRadiance(grid, 45, 90, 45, { columnLut, aerosols: hazy, multipleScattering: hazyLut })
          .luminanceCdPerM2 /
        skyRadiance(grid, 45, 90, 45, { columnLut, aerosols: hazy }).luminanceCdPerM2
      const clearGain = gainAt(45, 45)
      t.checkTrue(
        'l’apport croit avec le trouble',
        hazyGain > clearGain,
        `trouble 1 : x${clearGain.toFixed(2)} — trouble 5 : x${hazyGain.toFixed(2)}`,
      )

      // --- Le bilan d'eclairement, seul controle en valeur absolue -----------
      // C'est le seul controle capable de voir un facteur de normalisation. Les
      // paliers de `astro/photometry.ts` sont grossiers — interpolation
      // log-lineaire entre quatre noeuds de jour — et ne bornent qu'un ordre de
      // grandeur. Le noeud a 5° est ecarte : il est incompatible avec ses
      // propres voisins, voir la note de phase 8 dans `docs/atmosphere-engine.md`.
      const hemisphere = { ...multiple, zenithSamples: 16, azimuthSamples: 32 }
      for (const sunAltitude of [20, 45, 90]) {
        const total =
          directSolar(grid, sunAltitude, { aerosols: clearAir }).horizontalIlluminanceLux +
          diffuseHorizontalIlluminance(grid, sunAltitude, hemisphere)
        t.checkRelative(
          `eclairement horizontal a ${sunAltitude}° de hauteur solaire`,
          total,
          solarIlluminance(sunAltitude),
          0.1,
          'lx',
        )
      }

      // --- Le sol participe, et son albedo se voit ---------------------------
      // `groundAlbedo` etait declare depuis la phase 1 sans etre lu par
      // personne. La lumiere renvoyee par la surface est une composante de la
      // diffusion multiple : un albedo plus fort doit eclaircir le ciel.
      const dark = buildMultipleScatteringLut(grid, { aerosols: clearAir, columnLut, groundAlbedo: 0 })
      const snow = buildMultipleScatteringLut(grid, { aerosols: clearAir, columnLut, groundAlbedo: 0.8 })
      const withoutGround = skyRadiance(grid, 30, 90, 45, {
        columnLut,
        aerosols: clearAir,
        multipleScattering: dark,
      }).luminanceCdPerM2
      const overSnow = skyRadiance(grid, 30, 90, 45, {
        columnLut,
        aerosols: clearAir,
        multipleScattering: snow,
      }).luminanceCdPerM2
      t.checkTrue(
        'un sol clair eclaircit le ciel',
        overSnow > withoutGround * 1.02,
        `albedo 0 : ${withoutGround.toFixed(0)} cd/m² — albedo 0,8 : ${overSnow.toFixed(0)} cd/m²`,
      )

      // --- Lecture de la table ------------------------------------------------
      const probe = new Float64Array(grid.count)
      sampleMultipleScattering(lut, 0, 1, probe)
      t.checkTrue(
        'la lecture au sol, Soleil au zenith, rend une radiance positive',
        Array.from(probe).every((v) => v > 0),
        `minimum sur les bandes : ${Math.min(...Array.from(probe)).toExponential(3)}`,
      )
      // Hors domaine, la lecture doit etre bornee et non extrapolee.
      const above = new Float64Array(grid.count)
      sampleMultipleScattering(lut, 1e9, 1, above)
      t.checkTrue(
        'la lecture hors domaine est bornee, pas extrapolee',
        Array.from(above).every((v) => v >= 0 && Number.isFinite(v)),
        'une altitude au-dela du sommet de l’atmosphere doit saturer sur la derniere ligne',
      )

      // --- Le milieu diffusant s'epuise en montant ---------------------------
      //
      // Attention a ce qui est affirme ici. J'avais d'abord ecrit que Ψ_ms
      // devait **decroitre** avec l'altitude, et le controle l'a refute :
      // 1,74·10⁻² au sol contre 1,78·10⁻² a 60 km. La raison est instructive.
      //
      // Ψ_ms est une **radiance moyennee sur toute la sphere**. Depuis le sol,
      // la moitie basse des directions bute sur la surface et n'apporte presque
      // rien ; depuis 60 km, cette meme moitie est remplie par l'atmosphere
      // eclairee vue d'en haut, qui est lumineuse. Les deux moyennes sont donc
      // du meme ordre, et c'est correct.
      //
      // Ce qui doit s'effondrer, c'est le **terme source** `σ_s · Ψ_ms`, celui
      // que la marche integre reellement : σ_s suit la densite, qui perd
      // quatre ordres de grandeur en 60 km. C'est cette grandeur-la qu'il faut
      // controler.
      const lowAltitude = new Float64Array(grid.count)
      const highAltitude = new Float64Array(grid.count)
      sampleMultipleScattering(lut, 0, 0.5, lowAltitude)
      sampleMultipleScattering(lut, 60_000, 0.5, highAltitude)
      const sourceGround = standardProfile(0).numberDensityPerM3 * lowAltitude[8]
      const sourceHigh = standardProfile(60_000).numberDensityPerM3 * highAltitude[8]
      t.checkTrue(
        'le terme source de diffusion multiple s’effondre en altitude',
        sourceHigh < sourceGround * 1e-3,
        `a 550 nm : ${sourceGround.toExponential(2)} au sol contre ` +
          `${sourceHigh.toExponential(2)} a 60 km — il n’y a presque plus de diffuseurs`,
      )
      t.checkTrue(
        'la radiance isotrope, elle, ne s’effondre pas',
        highAltitude[8] > lowAltitude[8] * 0.5,
        `${lowAltitude[8].toExponential(2)} au sol contre ${highAltitude[8].toExponential(2)} a 60 km — ` +
          'vue d’en haut, la moitie basse de la sphere est remplie par l’atmosphere eclairee',
      )

      // --- Et avec le Soleil sous l'horizon ----------------------------------
      const night = new Float64Array(grid.count)
      sampleMultipleScattering(lut, 0, -0.5, night)
      t.checkTrue(
        'un Soleil a 30° sous l’horizon ne laisse presque plus rien',
        night[8] < lowAltitude[8] * 1e-3,
        `${night[8].toExponential(2)} contre ${lowAltitude[8].toExponential(2)} — le sol est dans ` +
          'l’ombre de la Terre, seule la haute atmosphere reste eclairee',
      )
    },
  )
}
