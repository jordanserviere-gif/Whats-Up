/**
 * Validation du milieu nuageux — phases, extinction, trainees.
 *
 * Rien ici ne se compare a une table recopiee. Chaque grandeur est confrontee
 * soit a une forme close dont le code ne sait rien, soit a un autre module du
 * moteur :
 *
 * 1. **Les phases sont normalisees** et leurs cosinus moyens valent ce que
 *    donnent leurs formes closes.
 * 2. **L'ajustement de Jendersie & d'Eon contre notre solveur de Mie.** Leur
 *    reference est une population de gouttes log-normale (ecart-type 0,25),
 *    moyennee de 400 a 700 nm ; on la recalcule ici par Bohren & Huffman. Deux
 *    chemins independants vers la meme fonction de phase.
 * 3. **L'extinction** `3W/2ρr` contre `Q_ext` de Mie pour des gouttes reelles.
 * 4. **Le tube de trainee** : l'epaisseur optique analytique contre une
 *    integration numerique de la densite le long du rayon, et la conservation
 *    de l'extinction lineique quand la section s'elargit.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { aircraftLayout, vortexSpacingM, type AircraftLayout } from '../../astro/aircraftTypes'
import { mieCoefficients, mieEfficiencies, miePhaseFunction, sizeParameter, type Complex } from '../mie/mie'
import {
  draine,
  draineMeanCosine,
  dropletMeanCosine,
  dropletPhase,
  dropletPhaseParameters,
  henyeyGreenstein,
  iceMeanCosine,
  icePhase,
} from './phase'
import { WATER_DENSITY_KG_M3, extinctionCoefficient } from './microphysics'
import {
  contrailConditions,
  mixingLineSlope,
  schumannTangentTemperatureC,
  tangentTemperatureK,
} from './contrailFormation'
import { saturationVapourPressureOverIce, saturationVapourPressureOverWater } from '../thermodynamics/waterVapour'
import {
  contrailDeathAgeS,
  contrailEffectiveRadiusM,
  contrailIceKgPerM,
  initialExtinctionPerLengthM,
  crowModulation,
  enginePlumeOpticalDepth,
  plumePositionsM,
  crowWavelengthM,
  DEFAULT_CONTRAIL,
  contrailExtinctionAt,
  contrailExtinctionPerLengthM,
  contrailOpticalDepth,
  contrailSigmaM,
} from './contrail'

const WATER: Complex = { re: 1.333, im: 0 }

/**
 * Integrale d'une fonction de `mu` sur la sphere.
 *
 * ⚠️ En variable logarithmique, `x = ln(1 − mu)` : le pic avant des gouttes
 * (g_HG = 0,997 a 40 µm) tient dans un millieme de radian, et un pas uniforme
 * en `mu` le manquait — l'integrale tombait a 0,78 sans que la fonction soit
 * fausse.
 */
function overSphere(f: (mu: number) => number, steps = 40000): number {
  const x0 = Math.log(1e-14)
  const x1 = Math.log(2)
  const dx = (x1 - x0) / steps
  let sum = 0
  for (let i = 0; i < steps; i++) {
    const e = Math.exp(x0 + (i + 0.5) * dx)
    sum += f(1 - e) * e
  }
  return 2 * Math.PI * sum * dx
}

/**
 * Phase de Mie d'une population log-normale de gouttes, moyennee sur le
 * visible — exactement la reference de Jendersie & d'Eon.
 */
function mieReferencePhase(medianDiameterUm: number, mus: readonly number[]): { phase: number[]; meanCosine: number } {
  const sigmaLn = 0.25
  const wavelengths = [400, 450, 500, 550, 600, 650, 700]
  const sizes = 25
  const phase = new Array(mus.length).fill(0)
  let weightSum = 0
  let gSum = 0
  for (const lambda of wavelengths) {
    for (let k = 0; k < sizes; k++) {
      // Quadrature de la log-normale sur ±3σ, en ln(d).
      const z = -3 + (6 * (k + 0.5)) / sizes
      const w = Math.exp(-0.5 * z * z)
      const d = medianDiameterUm * Math.exp(sigmaLn * z)
      const coefficients = mieCoefficients(sizeParameter((d / 2) * 1e-6, lambda), WATER)
      const eff = mieEfficiencies(coefficients)
      // Poids de diffusion : nombre × section efficace de diffusion.
      const scatter = w * eff.qSca * d * d
      for (let i = 0; i < mus.length; i++) phase[i] += scatter * miePhaseFunction(coefficients, mus[i], eff.qSca)
      gSum += scatter * eff.asymmetry
      weightSum += scatter
    }
  }
  return { phase: phase.map((p) => p / weightSum), meanCosine: gSum / weightSum }
}

export function cloudSuite(): SuiteResult {
  return suite(
    'Milieu nuageux — phases, extinction, trainees',
    { reference: 'Jendersie & d’Eon (2023) ; Draine (2003) ; Bohren & Huffman (1983)' },
    (t) => {
      // --- 1. Normalisation et cosinus moyens --------------------------------
      for (const g of [0, 0.5, 0.85]) {
        t.checkRelative(`Henyey-Greenstein normalisee, g = ${g}`, overSphere((mu) => henyeyGreenstein(g, mu)), 1, 1e-4)
        t.check(`cosinus moyen de Henyey-Greenstein = g, g = ${g}`, overSphere((mu) => mu * henyeyGreenstein(g, mu)), g, 2e-4)
      }
      for (const [g, alpha] of [[0.3, 1], [0.6, 20], [0.45, 250]] as const) {
        t.checkRelative(`Draine normalisee, g = ${g}, α = ${alpha}`, overSphere((mu) => draine(g, alpha, mu)), 1, 1e-4)
        t.check(
          `cosinus moyen de Draine, forme close, g = ${g}, α = ${alpha}`,
          overSphere((mu) => mu * draine(g, alpha, mu)),
          draineMeanCosine(g, alpha),
          5e-4,
        )
      }
      t.check('Draine(g = 0, α = 1) = Rayleigh', draine(0, 1, 0.3), (3 / (16 * Math.PI)) * (1 + 0.09), 1e-12)
      t.checkRelative('phase de la glace normalisee', overSphere(icePhase), 1, 1e-4)
      t.check('facteur d’asymetrie de la glace dans la fourchette publiee', iceMeanCosine(), 0.775, 0.025)

      for (const d of [2, 5, 10, 20, 40]) {
        const p = dropletPhaseParameters(d)
        t.checkRelative(`phase des gouttes normalisee, d = ${d} µm`, overSphere((mu) => dropletPhase(p, mu)), 1, 2e-4)
        t.checkTrue(
          `parametres des gouttes dans leur domaine, d = ${d} µm`,
          p.gHG > 0 && p.gHG < 1 && p.gD > 0 && p.gD < 1 && p.alpha >= 0 && p.wD >= 0 && p.wD <= 1,
          `gHG ${p.gHG.toFixed(3)} · gD ${p.gD.toFixed(3)} · α ${p.alpha.toFixed(1)} · wD ${p.wD.toFixed(3)}`,
        )
      }
      // Raccord des deux ajustements a 5 µm : sans lui, un nuage dont les
      // gouttes grossissent changerait d'aspect d'un coup.
      const below = dropletPhaseParameters(4.999)
      const above = dropletPhaseParameters(5)
      t.check('raccord a 5 µm, cosinus moyen continu', dropletMeanCosine(below), dropletMeanCosine(above), 0.01)

      // --- 2. Jendersie & d'Eon contre notre Mie ----------------------------
      // Leur modele renonce a l'arc-en-ciel et a la gloire : l'accord se juge
      // sur le cosinus moyen et sur la moitie avant, pas angle par angle a
      // l'arriere.
      for (const d of [5, 10, 20]) {
        const forward = Array.from({ length: 60 }, (_, i) => Math.cos(((i + 0.5) / 60) * (Math.PI / 2)))
        const ref = mieReferencePhase(d, forward)
        const p = dropletPhaseParameters(d)
        t.check(`cosinus moyen, modele contre Mie, d = ${d} µm`, dropletMeanCosine(p), ref.meanCosine, 0.03)
        // Ecart logarithmique moyen sur la moitie avant, pondere comme dans leur
        // perte (sin θ |cos θ|).
        let err = 0
        let wsum = 0
        forward.forEach((mu, i) => {
          const w = Math.sqrt(1 - mu * mu) * Math.abs(mu)
          err += w * Math.abs(Math.log(dropletPhase(p, mu) / ref.phase[i]))
          wsum += w
        })
        t.check(`moitie avant, ecart log moyen, d = ${d} µm`, err / wsum, 0, 0.35)
        t.note(`d = ${d} µm : g Mie ${ref.meanCosine.toFixed(3)}, g modele ${dropletMeanCosine(p).toFixed(3)}, ecart log avant ${(err / wsum).toFixed(3)}`)
      }

      // --- 3. Extinction ------------------------------------------------------
      // 3W/2ρr suppose Q_ext = 2 ; Mie le verifie pour des gouttes de nuage.
      for (const radiusUm of [5, 10, 20]) {
        const q = mieEfficiencies(mieCoefficients(sizeParameter(radiusUm * 1e-6, 550), WATER)).qExt
        const content = 0.3e-3 // 0,3 g/m³, un cumulus ordinaire
        const r = radiusUm * 1e-6
        const numberDensity = content / ((4 / 3) * Math.PI * r ** 3 * WATER_DENSITY_KG_M3)
        const mie = numberDensity * Math.PI * r * r * q
        t.checkRelative(`extinction 3W/2ρr contre Mie, r = ${radiusUm} µm`, extinctionCoefficient(content, r, 'liquide'), mie, 0.08)
      }

      // --- 4. Tube de trainee -------------------------------------------------
      for (const [age, miss, sinAngle] of [[10, 0, 1], [60, 40, 0.8], [600, 200, 0.4]] as const) {
        // Integration numerique de la densite le long du rayon.
        const sigma = contrailSigmaM(age)
        const span = (8 * sigma) / sinAngle
        const steps = 4000
        let tau = 0
        for (let i = 0; i < steps; i++) {
          const s = -span + ((i + 0.5) * 2 * span) / steps
          const r = Math.hypot(miss, s * sinAngle)
          tau += contrailExtinctionAt(age, r) * ((2 * span) / steps)
        }
        t.checkRelative(
          `epaisseur optique analytique contre integration, t = ${age} s, b = ${miss} m`,
          contrailOpticalDepth(age, miss, sinAngle),
          tau,
          1e-3,
        )
      }
      // Integree sur toute la section, l'epaisseur optique rend l'extinction
      // lineique : l'elargissement dilue la glace, il ne la cree pas.
      for (const age of [5, 120, 1800]) {
        const sigma = contrailSigmaM(age)
        let integral = 0
        const steps = 4000
        for (let i = 0; i < steps; i++) {
          const b = -8 * sigma + ((i + 0.5) * 16 * sigma) / steps
          integral += contrailOpticalDepth(age, b, 1) * ((16 * sigma) / steps)
        }
        t.checkRelative(`conservation de l’extinction lineique, t = ${age} s`, integral, contrailExtinctionPerLengthM(age), 1e-4)
      }
      t.checkMonotonic('la section s’elargit avec l’age', [0, 10, 60, 600, 3600].map((a) => contrailSigmaM(a)), 'croissant')
      t.check('invisible au passage des reacteurs', contrailOpticalDepth(0, 0, 1), 0, 1e-12)
      const young = contrailOpticalDepth(10, 0, 1)
      t.check('trainee jeune : epaisseur optique au centre', young, 0.4, 0.1)
      // --- 4 bis. Structure fine ----------------------------------------------
      // Les panaches se partagent la glace : integree sur la section, leur
      // somme rend l'extinction lineique du tube unique, quel que soit leur
      // nombre.
      const a380 = aircraftLayout('A388', 'A5')
      const narrowbody = aircraftLayout('A320', 'A3')
      for (const [layout, label] of [[narrowbody, 'biréacteur'], [a380, 'quadrireacteur']] as const) {
        for (const age of [2, 40]) {
          const sigma = contrailSigmaM(age)
          const span = 8 * sigma + layout.spanM
          let integral = 0
          const steps = 8000
          for (let i = 0; i < steps; i++) {
            const b = -span + ((i + 0.5) * 2 * span) / steps
            integral += enginePlumeOpticalDepth(age, b, 1, layout) * ((2 * span) / steps)
          }
          t.checkRelative(`${label} : meme glace qu’un tube unique, t = ${age} s`, integral, contrailExtinctionPerLengthM(age), 1e-4)
        }
      }
      // Combien de trainees distinctes voit-on ? Un maximum local du profil
      // d'epaisseur optique en travers, a plus de 2 % du maximum, en est une.
      // En air sature, pour que la trainee vive assez pour etre comptee a tout age.
      const saturatedAir = { shearPerS: 0.004, excessVapourKgM3: 0 }
      const trails = (layout: AircraftLayout, age: number) => {
        const values: number[] = []
        for (let b = -80; b <= 80; b += 0.25) values.push(enginePlumeOpticalDepth(age, b, 1, layout, saturatedAir))
        const peak = Math.max(...values)
        let count = 0
        for (let i = 1; i < values.length - 1; i++) {
          if (values[i] > values[i - 1] && values[i] >= values[i + 1] && values[i] > 0.02 * peak) count++
        }
        return count
      }
      t.check('quadrireacteur : quatre trainees derriere l’avion', trails(a380, 1), 4, 0)
      t.check('quadrireacteur : deux apres l’enroulement', trails(a380, 40), 2, 0)
      t.check('quadrireacteur : une apres la fusion des tourbillons', trails(a380, 200), 1, 0)
      t.check('biréacteur : deux trainees derriere l’avion', trails(narrowbody, 1), 2, 0)
      t.check('biréacteur : toujours deux a 40 s, une par tourbillon', trails(narrowbody, 40), 2, 0)
      t.check('biréacteur : une apres la fusion des tourbillons', trails(narrowbody, 200), 1, 0)
      t.check(
        'ecartement des trainees apres enroulement : π/4 de l’envergure',
        Math.abs(plumePositionsM(40, a380)[3] - plumePositionsM(40, a380)[0]),
        vortexSpacingM(a380),
        0.5,
        'm',
      )
      // Crow deplace la glace le long de l'axe sans en creer.
      {
        const n = 2000
        const wavelength = crowWavelengthM(narrowbody)
        let mean = 0
        for (let i = 0; i < n; i++) mean += crowModulation(600, ((i + 0.5) / n) * wavelength, narrowbody) / n
        t.check('pincement de Crow de moyenne 1 sur une longueur d’onde', mean, 1, 1e-6)
      }
      t.check('pas de pincement avant le debut de l’instabilite', crowModulation(10, 0), 1, 1e-12)
      t.note(
        `longueur d’onde de Crow : ${crowWavelengthM(narrowbody).toFixed(0)} m pour un monocouloir, ` +
          `${crowWavelengthM(a380).toFixed(0)} m pour un A380`,
      )

      // --- 5. Critere de Schmidt-Appleman -----------------------------------
      for (const pressureHPa of [200, 250, 300]) {
        const g = mixingLineSlope(pressureHPa * 100)
        const exact = tangentTemperatureK(g) - 273.15
        t.check(
          `temperature de tangence contre Schumann (1996), ${pressureHPa} hPa`,
          exact,
          schumannTangentTemperatureC(g),
          0.6,
          '°C',
        )
      }
      // Rapport des saturations eau / glace a −40 °C : 1,47 environ, la raison
      // pour laquelle un air « sec » a 70 % sur eau est sursature sur glace.
      t.check(
        'saturation eau / glace a −40 °C',
        saturationVapourPressureOverWater(233.15) / saturationVapourPressureOverIce(233.15),
        1.47,
        0.02,
      )
      {
        const p = 250e2
        const tangent = tangentTemperatureK(mixingLineSlope(p))
        t.checkTrue('air sec tres froid : la trainee se forme', contrailConditions(tangent - 12, 0, p).forms)
        t.checkTrue('air plus chaud que la tangence : jamais', !contrailConditions(tangent + 1, 1, p).forms)
        t.checkTrue(
          'a la meme temperature, l’humidite fait passer le seuil',
          !contrailConditions(tangent - 1, 0, p).forms && contrailConditions(tangent - 1, 1, p).forms,
        )
        t.note(`a 250 hPa, η = 0,3 : tangence a ${(tangent - 273.15).toFixed(1)} °C`)
      }
      // --- 6. Etalement dans un vent cisaille, contre des particules ----------
      // Les formules de dispersion gaussienne en cisaillement se retrouvent par
      // une marche aleatoire independante : des particules diffusent et sont
      // entrainees par un vent qui croit lineairement avec l'altitude. Phase de
      // sillage neutralisee, pour comparer exactement a la forme close.
      {
        const params = { ...DEFAULT_CONTRAIL, wakeSigmaZM: DEFAULT_CONTRAIL.initialSigmaM }
        const env = { shearPerS: 0.006, excessVapourKgM3: 0 }
        let seed = 12345
        const uniform = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0
          return (seed + 0.5) / 4294967296
        }
        const gauss = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
        const n = 6000
        const ys = new Float64Array(n)
        const zs = new Float64Array(n)
        for (let i = 0; i < n; i++) {
          ys[i] = params.initialSigmaM * gauss()
          zs[i] = params.initialSigmaM * gauss()
        }
        const dt = 2
        let clock = 0
        for (const target of [300, 1200]) {
          while (clock < target) {
            for (let i = 0; i < n; i++) {
              ys[i] += env.shearPerS * zs[i] * dt + Math.sqrt(2 * params.horizontalDiffusivityM2S * dt) * gauss()
              zs[i] += Math.sqrt(2 * params.verticalDiffusivityM2S * dt) * gauss()
            }
            clock += dt
          }
          let m = 0
          for (let i = 0; i < n; i++) m += ys[i]
          m /= n
          let v = 0
          for (let i = 0; i < n; i++) v += (ys[i] - m) ** 2
          const sigmaMc = Math.sqrt(v / (n - 1))
          t.checkRelative(`largeur en cisaillement contre particules, t = ${target} s`, contrailSigmaM(target, env, params), sigmaMc, 0.04)
        }
      }

      // --- 7. Bilan de glace ----------------------------------------------------
      {
        const saturated = { shearPerS: 0.004, excessVapourKgM3: 0 }
        t.checkRelative(
          'air sature : la glace se conserve',
          contrailIceKgPerM(1800, saturated),
          DEFAULT_CONTRAIL.initialIceKgPerM,
          1e-12,
        )
        t.checkRelative(
          'extinction initiale 3M/2ρr',
          initialExtinctionPerLengthM(),
          extinctionCoefficient(DEFAULT_CONTRAIL.initialIceKgPerM, DEFAULT_CONTRAIL.initialEffectiveRadiusM, 'glace'),
          1e-12,
        )
        // Air a 80 % sur glace a −50 °C, puis sursature a 120 %.
        const temperatureK = 223.15
        const esi = saturationVapourPressureOverIce(temperatureK)
        const excess = (ratio: number) => ((ratio - 1) * esi) / (461.5 * temperatureK)
        const dry = { shearPerS: 0.004, excessVapourKgM3: excess(0.8) }
        const humid = { shearPerS: 0.004, excessVapourKgM3: excess(1.2) }
        const death = contrailDeathAgeS(dry)
        t.checkTrue('air sous-sature : la trainee meurt', Number.isFinite(death) && death > 0)
        t.check('glace epuisee a l’age de mort', contrailIceKgPerM(death * 1.001, dry), 0, 1e-12, 'kg/m')
        t.checkTrue('air sursature : la trainee ne meurt pas', !Number.isFinite(contrailDeathAgeS(humid)))
        t.checkMonotonic(
          'air sursature : la glace croit',
          [0, 60, 300, 900, 1800].map((a) => contrailIceKgPerM(a, humid)),
          'croissant',
        )
        // Ordres de grandeur observes d'une trainee persistante d'une demi-heure :
        // un a quelques kilometres de large, une epaisseur optique de 0,1 a 0,5.
        const fwhm30 = 2.355 * contrailSigmaM(1800, humid)
        const tau30 = contrailOpticalDepth(1800, 0, 1, humid)
        t.checkTrue('persistante a 30 min : large de 1 a 5 km', fwhm30 > 1000 && fwhm30 < 5000, `${(fwhm30 / 1000).toFixed(2)} km`)
        t.checkTrue('persistante a 30 min : τ de 0,1 a 1', tau30 > 0.1 && tau30 < 1, `τ = ${tau30.toFixed(2)}`)
        t.note(
          `a −50 °C, cisaillement 0,004 s⁻¹ : 80 % sur glace → morte a ${death.toFixed(0)} s ; ` +
            `120 % → ${(fwhm30 / 1000).toFixed(2)} km de large et τ ${tau30.toFixed(2)} a 30 min, ` +
            `cristaux de ${(contrailEffectiveRadiusM(1800, humid) * 1e6).toFixed(1)} µm`,
        )
      }

      t.note(
        `largeur a mi-hauteur (environnement par defaut) : ${(2.355 * contrailSigmaM(60)).toFixed(0)} m a 1 min ; ` +
          `τ au centre ${young.toFixed(2)} a 10 s ; morte a ${contrailDeathAgeS().toFixed(0)} s`,
      )
    },
  )
}
