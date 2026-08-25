/**
 * Validation de la base spectrale — phase 2.
 *
 * Quatre familles, d'independance croissante vis-a-vis des donnees :
 *
 * 1. **Invariance a la resolution.** Un illuminant d'energie egale doit rendre
 *    la meme chromaticite a 8 bandes qu'a 471. C'est le controle qui distingue
 *    une integration par bande correcte d'un prelevement au centre — lequel
 *    passerait tous les autres tests en apparence.
 * 2. **Contre les tables publiees.** Integrales des fonctions colorimetriques,
 *    chromaticite du blanc D65, irradiance solaire.
 * 3. **Contre l'algebre.** Les deux matrices sRGB doivent etre inverses l'une
 *    de l'autre — ce qui detecte une faute de frappe dans l'une ou l'autre.
 * 4. **En boucle fermee, sans aucune donnee externe.** Un spectre de Planck a
 *    temperature T, passe dans toute la chaine, doit ressortir a T. Ce seul
 *    controle teste d'un coup le chargement des fonctions colorimetriques,
 *    l'integration par bande, la conversion XYZ et la chromaticite.
 */
import { suite, type SuiteResult } from '../validation/harness'
import {
  CIE_MAX_NM,
  CIE_MIN_NM,
  LUMINOUS_EFFICACY,
  colourMatchingOn,
  rawColourMatching,
} from './colourMatching'
import { WIEN_DISPLACEMENT, colourTemperatureFromBv, planckRadiance, wienPeakNm } from './blackbody'
import {
  SOLAR_MAX_NM,
  SOLAR_MIN_NM,
  rawSolarSpectrum,
  scaleToDistance,
  solarIrradianceOn,
  totalIrradiance,
} from './SolarSpectrum'
import {
  LINEAR_SRGB_TO_XYZ,
  XYZ_TO_LINEAR_SRGB,
  chromaticity,
  correlatedColourTemperature,
  linearSrgbToXyz,
  luminance,
  spectralToXyz,
  xyzToLinearSrgb,
} from './SpectralSensor'
import {
  integratePiecewiseLinear,
  integrateOverGrid,
  resampleToGrid,
  sampleFunctionToGrid,
  uniformSpectralGrid,
} from './SpectralGrid'

/** Grille couvrant tout le domaine des fonctions colorimetriques. */
const gridOf = (count: number) => uniformSpectralGrid(CIE_MIN_NM, CIE_MAX_NM, count)

/** Illuminant d'energie egale : radiance constante sur toute la grille. */
const equalEnergy = (count: number) => new Float64Array(count).fill(1)

export function spectralGridSuite(): SuiteResult {
  return suite('Grille spectrale (phase 2)', {}, (t) => {
    const grid = uniformSpectralGrid(400, 700, 6)
    t.check('nombre de bandes', grid.count, 6, 0)
    t.check('premiere borne', grid.edgesNm[0], 400, 1e-12, ' nm')
    t.check('derniere borne', grid.edgesNm[6], 700, 1e-12, ' nm')
    t.check('largeur de bande', grid.widthNm[0], 50, 1e-12, ' nm')
    t.check('centre de la premiere bande', grid.lambdaNm[0], 425, 1e-12, ' nm')

    // Integrale d'une fonction affine : la formule trapezoidale est exacte,
    // donc tout ecart signale un bug d'indexation, pas une approximation.
    const lambda = [0, 10, 20, 30]
    const affine = [0, 20, 40, 60] // f(x) = 2x
    t.check('integrale exacte d’une fonction affine', integratePiecewiseLinear(lambda, affine, 0, 30), 900, 1e-12)
    // ∫2x dx de 5 a 15 = 15² − 5² = 200.
    t.check('integrale sur un sous-intervalle', integratePiecewiseLinear(lambda, affine, 5, 15), 200, 1e-12)
    t.check('integrale hors du domaine tabule', integratePiecewiseLinear(lambda, affine, 40, 50), 0, 1e-12)
    t.check('integrale d’intervalle vide', integratePiecewiseLinear(lambda, affine, 10, 10), 0, 1e-12)

    // Le reechantillonnage doit conserver l'integrale, quelle que soit la
    // grille : c'est la propriete dont depend toute la colorimetrie.
    const source = { l: [] as number[], v: [] as number[] }
    for (let x = 400; x <= 700; x += 1) {
      source.l.push(x)
      source.v.push(Math.exp(-((x - 550) ** 2) / 2000) + 0.1)
    }
    const reference = integratePiecewiseLinear(source.l, source.v, 400, 700)
    for (const count of [3, 8, 16, 64, 300]) {
      const g = uniformSpectralGrid(400, 700, count)
      const resampled = resampleToGrid(g, source.l, source.v)
      t.checkRelative(`integrale conservee a ${count} bandes`, integrateOverGrid(g, resampled), reference, 1e-12)
    }

    // Simpson sur une fonction analytique : exact jusqu'au degre 3.
    const cubic = uniformSpectralGrid(0, 12, 4)
    const sampled = sampleFunctionToGrid(cubic, (x) => x * x * x, 2)
    t.checkRelative('echantillonnage analytique d’un cubique', integrateOverGrid(cubic, sampled), 12 ** 4 / 4, 1e-12)
  })
}

export function colourMatchingSuite(): SuiteResult {
  return suite(
    'Fonctions colorimetriques CIE 1931 2°',
    { reference: 'table CIE via colour-science/colour, 360–830 nm a 1 nm' },
    (t) => {
      const raw = rawColourMatching()
      t.check('domaine tabule : borne basse', CIE_MIN_NM, 360, 0, ' nm')
      t.check('domaine tabule : borne haute', CIE_MAX_NM, 830, 0, ' nm')
      t.check('nombre d’entrees', raw.lambdaNm.length, 471, 0)

      // Integrales publiees des trois fonctions. Elles ne sont pas egales entre
      // elles — leger ecart voulu par la CIE — et c'est justement pourquoi les
      // verifier separement a du sens.
      t.checkRelative('∫x̄ dλ', integratePiecewiseLinear(raw.lambdaNm, raw.x, 360, 830), 106.865, 1e-4)
      t.checkRelative('∫ȳ dλ', integratePiecewiseLinear(raw.lambdaNm, raw.y, 360, 830), 106.857, 1e-4)
      t.checkRelative('∫z̄ dλ', integratePiecewiseLinear(raw.lambdaNm, raw.z, 360, 830), 106.892, 1e-4)

      // ȳ est la fonction d'efficacite lumineuse photopique : son maximum est a
      // 555 nm, et il vaut 1 par normalisation.
      const peakIndex = raw.y.indexOf(Math.max(...raw.y))
      t.check('pic de ȳ', raw.lambdaNm[peakIndex], 555, 0, ' nm')
      t.checkRelative('ȳ normalisee a son pic', raw.y[peakIndex], 1, 1e-6)

      // Positivite : une sensibilite negative n'a aucun sens physique et
      // signalerait une table corrompue ou un decalage de colonnes.
      t.checkTrue(
        'les trois fonctions sont positives ou nulles',
        raw.x.every((v) => v >= 0) && raw.y.every((v) => v >= 0) && raw.z.every((v) => v >= 0),
      )
      // z̄ s'annule dans le rouge : l'oeil n'a aucune reponse « bleue » au-dela
      // de ~650 nm. Si ce n'etait pas le cas, les couleurs chaudes seraient fausses.
      t.checkTrue(
        'z̄ est nulle au-dela de 650 nm',
        raw.z[raw.lambdaNm.indexOf(700)] === 0,
        `z̄(700 nm) = ${raw.z[raw.lambdaNm.indexOf(700)]}`,
      )

      // Moyenne de bande : la somme ponderee doit reconstituer l'integrale, a
      // n'importe quelle resolution.
      for (const count of [8, 16, 471]) {
        const g = gridOf(count)
        const cmfs = colourMatchingOn(g)
        t.checkRelative(
          `∫ȳ reconstituee a ${count} bandes`,
          integrateOverGrid(g, cmfs.y),
          integratePiecewiseLinear(raw.lambdaNm, raw.y, 360, 830),
          1e-12,
        )
      }

      t.check('efficacite lumineuse maximale (definition de la candela)', LUMINOUS_EFFICACY, 683, 0, ' lm/W')
    },
  )
}

export function sensorSuite(): SuiteResult {
  return suite(
    'Capteur spectral : XYZ et sRGB',
    { reference: 'IEC 61966-2-1 (sRGB, D65) ; CIE 15' },
    (t) => {
      // --- Les deux matrices sont-elles inverses l'une de l'autre ? ----------
      // Une faute de frappe dans l'une des dix-huit valeurs se voit ici, et
      // nulle part ailleurs.
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          let sum = 0
          for (let k = 0; k < 3; k++) sum += XYZ_TO_LINEAR_SRGB[i][k] * LINEAR_SRGB_TO_XYZ[k][j]
          t.check(`matrices sRGB : produit [${i}][${j}]`, sum, i === j ? 1 : 0, 1e-6)
        }
      }

      // --- Le blanc sRGB est bien D65 ----------------------------------------
      const white = linearSrgbToXyz([1, 1, 1])
      const [wx, wy] = chromaticity(white)
      t.check('blanc sRGB : x', wx, 0.3127, 5e-4)
      t.check('blanc sRGB : y', wy, 0.329, 5e-4)
      t.checkRelative('blanc sRGB : Y normalise a 1', white[1], 1, 1e-6)

      // --- La ligne de luminance recoupe le rendu existant --------------------
      // `scene/atmosphere.ts` utilise (0,2126 · 0,7152 · 0,0722) dans sa
      // resaturation. Ce n'est pas une coincidence : c'est la meme grandeur.
      t.check('luminance sRGB : coefficient R', LINEAR_SRGB_TO_XYZ[1][0], 0.2126, 1e-4)
      t.check('luminance sRGB : coefficient V', LINEAR_SRGB_TO_XYZ[1][1], 0.7152, 1e-4)
      t.check('luminance sRGB : coefficient B', LINEAR_SRGB_TO_XYZ[1][2], 0.0722, 1e-4)
      t.checkRelative(
        'les coefficients de luminance somment a 1',
        LINEAR_SRGB_TO_XYZ[1][0] + LINEAR_SRGB_TO_XYZ[1][1] + LINEAR_SRGB_TO_XYZ[1][2],
        1,
        1e-6,
      )

      // --- Aller-retour XYZ → RGB → XYZ ---------------------------------------
      for (const xyz of [[0.5, 0.4, 0.3], [0.9505, 1, 1.089], [0.1, 0.9, 0.2]] as const) {
        const back = linearSrgbToXyz(xyzToLinearSrgb(xyz))
        const gap = Math.max(...back.map((v, i) => Math.abs(v - xyz[i])))
        t.check(`aller-retour XYZ (${xyz.join(', ')})`, gap, 0, 1e-6)
      }

      // --- LE test : invariance a la resolution spectrale ---------------------
      // Un illuminant d'energie egale a, par definition, la chromaticite
      // (1/3, 1/3). Avec un prelevement au centre de bande au lieu d'une
      // moyenne, ce controle echouerait a 8 bandes et passerait a 471 : c'est
      // exactement le bug qu'il existe pour attraper.
      const chromaticities = []
      for (const count of [8, 16, 32, 64, 235, 471]) {
        const g = gridOf(count)
        const xy = chromaticity(spectralToXyz(g, equalEnergy(count)))
        chromaticities.push(xy)
        t.check(`illuminant E a ${count} bandes : x`, xy[0], 1 / 3, 1e-4)
        t.check(`illuminant E a ${count} bandes : y`, xy[1], 1 / 3, 1e-4)
      }
      const spreadX = Math.max(...chromaticities.map((c) => c[0])) - Math.min(...chromaticities.map((c) => c[0]))
      const spreadY = Math.max(...chromaticities.map((c) => c[1])) - Math.min(...chromaticities.map((c) => c[1]))
      t.check('illuminant E : dispersion de x entre 8 et 471 bandes', spreadX, 0, 1e-12)
      t.check('illuminant E : dispersion de y entre 8 et 471 bandes', spreadY, 0, 1e-12)
      t.note(
        `illuminant E : chromaticite (${chromaticities[0][0].toFixed(6)}, ${chromaticities[0][1].toFixed(6)}) ` +
          `— l’ecart a 1/3 vient des integrales CIE, legerement inegales, pas de la discretisation`,
      )

      // --- Luminance photometrique -------------------------------------------
      // Une radiance monochromatique a 555 nm de 1 W·m⁻²·sr⁻¹ doit rendre
      // 683 cd/m², par definition de la candela. On l'approche par une bande
      // etroite centree sur le pic.
      const narrow = uniformSpectralGrid(554.5, 555.5, 1)
      t.checkRelative(
        'luminance a 555 nm : definition de la candela',
        luminance(narrow, new Float64Array([1])),
        683,
        2e-3,
        ' cd/m²',
      )
    },
  )
}

export function blackbodySuite(): SuiteResult {
  return suite(
    'Corps noir et bouclage colorimetrique',
    { reference: 'loi de Planck ; Ballesteros (2012) pour B−V → T' },
    (t) => {
      // --- Constante de Wien, derivee et non saisie ---------------------------
      t.checkRelative('constante de deplacement de Wien', WIEN_DISPLACEMENT, 2.897771955e-3, 1e-9, ' m·K')

      // Le maximum numerique de Planck doit tomber sur la prediction de Wien.
      for (const temperature of [3000, 5772, 10_000]) {
        let bestLambda = 0
        let best = -1
        for (let l = 50; l < 20_000; l += 0.05) {
          const v = planckRadiance(l, temperature)
          if (v > best) {
            best = v
            bestLambda = l
          }
        }
        t.checkRelative(`pic de Planck a ${temperature} K`, bestLambda, wienPeakNm(temperature), 1e-4, ' nm')
      }
      t.note(`pic de Planck a 5772 K : ${wienPeakNm(5772).toFixed(1)} nm`)

      // --- Bouclage : Planck(T) → XYZ → CCT doit rendre T --------------------
      // Aucune donnee externe n'intervient dans ce controle en dehors des
      // fonctions colorimetriques. S'il passe, toute la chaine tient.
      for (const temperature of [3000, 4000, 5000, 5772, 6500]) {
        const grid = gridOf(471)
        const spectrum = sampleFunctionToGrid(grid, (l) => planckRadiance(l, temperature))
        const cct = correlatedColourTemperature(spectralToXyz(grid, spectrum))
        t.checkRelative(`bouclage Planck → CCT a ${temperature} K`, cct, temperature, 5e-3, ' K')
      }

      // Le meme bouclage a resolution grossiere : c'est le regime dans lequel le
      // moteur tournera reellement.
      for (const count of [8, 16, 32]) {
        const grid = gridOf(count)
        const spectrum = sampleFunctionToGrid(grid, (l) => planckRadiance(l, 5772))
        const cct = correlatedColourTemperature(spectralToXyz(grid, spectrum))
        t.checkRelative(`bouclage Planck a 5772 K sur ${count} bandes`, cct, 5772, 2e-2, ' K')
      }

      // --- Ordre des couleurs -------------------------------------------------
      // Une etoile chaude doit etre bleue, une froide rouge. Si ce test
      // s'inversait, tout le champ d'etoiles serait faux.
      const grid = gridOf(64)
      const rgbAt = (temperature: number) =>
        xyzToLinearSrgb(spectralToXyz(grid, sampleFunctionToGrid(grid, (l) => planckRadiance(l, temperature))))
      const cool = rgbAt(3000)
      const hot = rgbAt(15_000)
      t.checkTrue(
        'un corps noir froid est plus rouge que bleu',
        cool[0] / cool[2] > 1,
        `R/B = ${(cool[0] / cool[2]).toFixed(2)} a 3000 K`,
      )
      t.checkTrue(
        'un corps noir chaud est plus bleu que rouge',
        hot[2] / hot[0] > 1,
        `B/R = ${(hot[2] / hot[0]).toFixed(2)} a 15 000 K`,
      )

      // --- B−V → temperature --------------------------------------------------
      // Ballesteros est cale pour rendre la temperature effective du Soleil a
      // partir de son indice de couleur : c'est l'ancre de la formule.
      t.check('B−V du Soleil (0,656) → temperature effective', colourTemperatureFromBv(0.656), 5772, 30, ' K')
      t.checkTrue(
        'un B−V croissant donne une temperature decroissante',
        colourTemperatureFromBv(-0.3) > colourTemperatureFromBv(0.0) &&
          colourTemperatureFromBv(0.0) > colourTemperatureFromBv(1.5),
        `B−V −0,3 → ${colourTemperatureFromBv(-0.3).toFixed(0)} K · ` +
          `0,0 → ${colourTemperatureFromBv(0).toFixed(0)} K · 1,5 → ${colourTemperatureFromBv(1.5).toFixed(0)} K`,
      )
    },
  )
}

export function solarSpectrumSuite(): SuiteResult {
  return suite(
    'Spectre solaire hors atmosphere',
    { reference: 'ASTM G173-03, colonne extraterrestrial (AM0, 1 UA), via pvlib' },
    (t) => {
      const raw = rawSolarSpectrum()
      t.check('domaine tabule : borne basse', SOLAR_MIN_NM, 280, 0, ' nm')
      t.check('domaine tabule : borne haute', SOLAR_MAX_NM, 4000, 0, ' nm')

      // Integrale sur tout le domaine tabule. Elle ne vaut PAS la constante
      // solaire : l'infrarouge au-dela de 4 µm manque. Voir `SolarSpectrum.ts`.
      const tabulated = integratePiecewiseLinear(raw.lambdaNm, raw.irradiance, 280, 4000)
      t.checkRelative('irradiance tabulee 280–4000 nm', tabulated, 1347.9, 2e-3, ' W/m²')
      t.checkTrue(
        'l’ecart a la constante solaire est l’infrarouge lointain',
        tabulated < 1361 && (1361 - tabulated) / 1361 < 0.02,
        `${(1361 - tabulated).toFixed(1)} W/m² manquants, soit ${(((1361 - tabulated) / 1361) * 100).toFixed(2)} % — ` +
          `au-dela de 4 µm, hors du domaine tabule`,
      )

      const visible = integratePiecewiseLinear(raw.lambdaNm, raw.irradiance, 360, 830)
      t.checkRelative('irradiance visible 360–830 nm', visible, 734.8, 2e-3, ' W/m²')
      t.note(`le visible porte ${((visible / tabulated) * 100).toFixed(1)} % de l’irradiance tabulee`)

      // Reechantillonnage : l'energie du domaine visible doit survivre a la
      // grille, malgre les raies de Fraunhofer.
      for (const count of [8, 16, 64]) {
        const grid = gridOf(count)
        t.checkRelative(
          `irradiance visible conservee a ${count} bandes`,
          totalIrradiance(grid, solarIrradianceOn(grid)),
          visible,
          1e-12,
          ' W/m²',
        )
      }

      // --- Loi en 1/d² --------------------------------------------------------
      const grid = gridOf(64)
      const base = solarIrradianceOn(grid)
      t.checkRelative('irradiance a 1 UA inchangee', totalIrradiance(grid, scaleToDistance(base, 1)), visible, 1e-12)
      t.checkRelative(
        'irradiance a 2 UA divisee par 4',
        totalIrradiance(grid, scaleToDistance(base, 2)),
        visible / 4,
        1e-12,
      )
      const perihelion = totalIrradiance(grid, scaleToDistance(base, 0.98329))
      const aphelion = totalIrradiance(grid, scaleToDistance(base, 1.01671))
      t.checkRelative('ecart perihelie / aphelie', perihelion / aphelion, 1.0691, 1e-3)
      t.note(
        `variation annuelle d’irradiance : ${(((perihelion - aphelion) / aphelion) * 100).toFixed(1)} % ` +
          `entre perihelie et aphelie`,
      )

      // --- Couleur du Soleil hors atmosphere ---------------------------------
      // Sa temperature de couleur doit etre voisine de sa temperature
      // effective (5772 K) sans lui etre egale : le Soleil n'est pas un corps
      // noir parfait, son spectre est creuse de raies d'absorption.
      const solarXyz = spectralToXyz(grid, solarIrradianceOn(grid))
      const [sx, sy] = chromaticity(solarXyz)
      const cct = correlatedColourTemperature(solarXyz)
      t.checkTrue(
        'temperature de couleur du Soleil hors atmosphere plausible',
        cct > 5300 && cct < 6300,
        `${cct.toFixed(0)} K — a comparer a la temperature effective de 5772 K`,
      )
      t.note(`Soleil hors atmosphere : chromaticite (${sx.toFixed(4)}, ${sy.toFixed(4)}), CCT ${cct.toFixed(0)} K`)
      // --- Raccord avec le modele photometrique existant ---------------------
      // L'entree etant une irradiance (W/m²/nm), `luminance()` rend ici un
      // **eclairement lumineux en lux**. C'est le premier point de contact
      // chiffre entre le nouveau moteur spectral et `astro/photometry.ts`, qui
      // calcule tout son bilan en lux par un chemin entierement independant :
      // ses paliers plafonnent a 120 000 lx pour un Soleil au zenith **au
      // niveau de la mer**, donc apres extinction atmospherique. Obtenir un peu
      // plus hors atmosphere est exactement ce qu'on attend ; l'ecart mesure
      // sera la profondeur optique zenithale, que la phase 3 devra retrouver.
      const solarIlluminance = luminance(grid, solarIrradianceOn(grid))
      t.checkTrue(
        'eclairement solaire hors atmosphere coherent avec la litterature',
        solarIlluminance > 125_000 && solarIlluminance < 140_000,
        `${(solarIlluminance / 1000).toFixed(1)} klx (litterature : 127–136 klx) — ` +
          `a comparer aux 120 klx au sol de photometry.ts, l'ecart etant l'extinction zenithale`,
      )
      t.note(
        `transmission zenithale impliquee : ${((120_000 / solarIlluminance) * 100).toFixed(1)} % ` +
          `— la phase 3 devra retrouver cette valeur a partir du Rayleigh seul`,
      )

      // Positivite : une irradiance negative signalerait un decalage de colonnes.
      t.checkTrue('irradiance positive partout', raw.irradiance.every((v) => v >= 0))
    },
  )
}
