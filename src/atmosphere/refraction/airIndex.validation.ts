/**
 * Validation de l'indice de refraction de l'air.
 *
 * ## Le probleme particulier de ce module
 *
 * Il est presque entierement fait de **constantes publiees** — quatre pour la
 * dispersion de l'air sec, quatre pour celle de la vapeur, neuf pour l'equation
 * d'etat, quatre pour la pression saturante. Une coquille dans l'une d'elles
 * decalerait le resultat de quelques pour cent au plus, c'est-a-dire de rien du
 * tout a l'oeil : l'indice de l'air vaut 1,0003, et il vaudrait encore 1,0003.
 *
 * Les controles de forme sont donc sans valeur ici. Ce qui compte, ce sont les
 * **recoupements independants** :
 *
 * 1. **Ciddor contre Peck & Reeder.** Deux formulations publiees a vingt-quatre
 *    ans d'intervalle, par des chemins sans rapport, doivent donner le meme
 *    indice aux conditions standard. C'est le controle qui attraperait une
 *    coquille dans les constantes de dispersion.
 * 2. **La densite du CIPM contre celle de l'US Standard Atmosphere.** Elles
 *    different, et l'ecart doit valoir **exactement le facteur de
 *    compressibilite** — l'US1976 supposant le gaz parfait.
 * 3. **La pression saturante de Ciddor contre celle de Buck**, deja dans le
 *    moteur.
 * 4. **La refraction astronomique.** Une formule de metrologie doit retomber sur
 *    les 58 secondes d'arc que publient les ephemerides a 45° de distance
 *    zenithale. C'est le seul controle qui sorte du laboratoire.
 *
 * S'y ajoute un invariant de signe que rien d'autre ne verifierait :
 * **l'humidite abaisse l'indice**. C'est contre-intuitif, et une erreur de signe
 * y passerait inapercue sur les ordres de grandeur.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { standardAirRefractiveIndex } from '../rayleigh/standardAir'
import { standardDensity } from '../thermodynamics/standardAtmosphere'
import { saturationVapourPressureOverWater, enhancementFactor } from '../thermodynamics/waterVapour'
import {
  airCompressibility,
  airRefractiveIndex,
  ciddorEnhancementFactor,
  ciddorSaturationVapourPressure,
  ciddorWaterMoleFraction,
  cipmDensity,
  dryAirMolarMass,
  planeParallelRefraction,
  standardAirIndexAt,
} from './airIndex'

const STANDARD = { temperatureK: 288.15, pressurePa: 101_325, relativeHumidity: 0 }
const ARCSEC_PER_RAD = 206_264.806

export function airIndexSuite(): SuiteResult {
  return suite(
    'Indice de refraction de l’air',
    { reference: 'Ciddor (1996), Applied Optics 35(9), 1566–1573' },
    (t) => {
      // --- Le garde-fou : deux formulations independantes ---------------------
      // Peck & Reeder (1972) et Ciddor (1996) n'ont ni les memes coefficients, ni
      // la meme structure, ni les memes mesures derriere. Aux conditions
      // standard, ils decrivent pourtant le meme air.
      let worstAgreement = 0
      let worstLambda = 0
      for (const lambdaNm of [380, 400, 450, 500, 550, 633, 700, 780]) {
        const ciddor = airRefractiveIndex(lambdaNm, { ...STANDARD, co2MoleFraction: 450e-6 }) - 1
        const peckReeder = standardAirRefractiveIndex(lambdaNm, 450e-6) - 1
        const error = Math.abs(ciddor - peckReeder) / peckReeder
        if (error > worstAgreement) {
          worstAgreement = error
          worstLambda = lambdaNm
        }
      }
      t.checkTrue(
        'Ciddor et Peck & Reeder decrivent le meme air standard',
        worstAgreement < 1e-4,
        `ecart relatif maximal ${worstAgreement.toExponential(2)} a ${worstLambda} nm — ` +
          'deux formulations publiees a vingt-quatre ans d’intervalle',
      )

      // --- La valeur publiee par l'article lui-meme ---------------------------
      // Ciddor donne n = 1,000271800 a 633 nm, 20 °C, 101 325 Pa, air sec,
      // 450 ppm. C'est le seul point ou ce module se compare a son propre
      // article plutot qu'a un autre.
      t.check(
        'n a 633 nm, 20 °C, air sec, 450 ppm',
        airRefractiveIndex(633, {
          temperatureK: 293.15,
          pressurePa: 101_325,
          relativeHumidity: 0,
          co2MoleFraction: 450e-6,
        }),
        1.000_271_800,
        5e-10,
      )

      // La refractivite classique de l'air standard, celle que tout ouvrage
      // d'optique atmospherique cite.
      t.checkRelative(
        'refractivite de l’air standard a 633 nm',
        airRefractiveIndex(633, { ...STANDARD, co2MoleFraction: 450e-6 }) - 1,
        2.7653e-4,
        2e-4,
      )

      // --- Dispersion normale --------------------------------------------------
      // L'indice croit quand la longueur d'onde diminue : c'est ce qui deviera le
      // bleu davantage que le rouge, et de la sortira le rayon vert.
      const indices = [400, 450, 500, 550, 600, 650, 700, 780].map((l) =>
        airRefractiveIndex(l, STANDARD),
      )
      t.checkMonotonic('dispersion normale : n decroit avec λ', indices, 'decroissant')
      t.checkTrue(
        'la dispersion sur le visible est de l’ordre du pour cent de la refractivite',
        (indices[0] - indices[indices.length - 1]) / (indices[0] - 1) > 0.02,
        `du bleu au rouge, n−1 passe de ${(indices[0] - 1).toExponential(4)} a ` +
          `${(indices[indices.length - 1] - 1).toExponential(4)}, soit ` +
          `${(((indices[0] - indices[indices.length - 1]) / (indices[0] - 1)) * 100).toFixed(1)} %`,
      )

      // --- Proportionnalite a la densite ---------------------------------------
      // Lorentz-Lorenz au premier ordre : la refractivite suit la densite. A
      // temperature fixee, halver la pression doit halver n−1, a la
      // compressibilite pres.
      const full = airRefractiveIndex(550, STANDARD) - 1
      const half = airRefractiveIndex(550, { ...STANDARD, pressurePa: 101_325 / 2 }) - 1
      t.checkRelative('la refractivite suit la pression', half, full / 2, 1e-3)

      const cold = airRefractiveIndex(550, { ...STANDARD, temperatureK: 288.15 / 2 }) - 1
      t.checkRelative('la refractivite suit l’inverse de la temperature', cold, full * 2, 5e-3)

      // --- L'humidite abaisse l'indice ------------------------------------------
      // L'invariant de signe. Une erreur ici serait invisible : les deux resultats
      // valent 1,0003.
      const dry = airRefractiveIndex(550, { temperatureK: 293.15, pressurePa: 101_325, relativeHumidity: 0 })
      const humid = airRefractiveIndex(550, { temperatureK: 293.15, pressurePa: 101_325, relativeHumidity: 1 })
      t.checkTrue(
        'l’air humide est moins refringent que l’air sec',
        humid < dry,
        `n−1 passe de ${(dry - 1).toExponential(6)} a sec a ${(humid - 1).toExponential(6)} a saturation, ` +
          `soit ${(((humid - dry) / (dry - 1)) * 100).toFixed(2)} % — la vapeur est moins refringente ` +
          'par molecule que l’air, et l’air humide est moins dense',
      )
      t.checkTrue(
        'l’effet de l’humidite reste de l’ordre du pour mille',
        Math.abs((humid - dry) / (dry - 1)) < 0.01,
        `${(Math.abs((humid - dry) / (dry - 1)) * 100).toFixed(3)} % entre air sec et air sature`,
      )

      // --- Compressibilite -------------------------------------------------------
      t.checkRelative(
        'facteur de compressibilite de l’air standard',
        airCompressibility(288.15, 101_325, 0),
        0.99959,
        1e-4,
      )
      t.check(
        'la compressibilite tend vers 1 a pression nulle',
        airCompressibility(288.15, 0, 0),
        1,
        1e-12,
      )

      // --- La densite du CIPM contre celle de l'US Standard Atmosphere ----------
      // Les deux modules calculent la masse volumique de l'air standard par des
      // chemins differents : l'US1976 suppose le **gaz parfait**, le CIPM non.
      // L'ecart doit donc valoir le facteur de compressibilite, et rien d'autre.
      const cipm = cipmDensity(288.15, 101_325, 0, 450e-6)
      const us1976 = standardDensity(0)
      const observed = cipm / us1976 - 1
      const predicted = 1 / airCompressibility(288.15, 101_325, 0) - 1
      t.checkTrue(
        'l’ecart entre les deux modeles de densite est la compressibilite',
        Math.abs(observed - predicted) < 1e-4,
        `mesure ${(observed * 100).toFixed(4)} %, predit par 1/Z ${(predicted * 100).toFixed(4)} % — ` +
          'le reste vient des masses molaires et des constantes des gaz, qui different aussi',
      )

      // --- Masse molaire ----------------------------------------------------------
      t.checkRelative('masse molaire de l’air sec a 400 ppm', dryAirMolarMass(400e-6), 28.9635e-3, 1e-9)
      t.checkTrue(
        'plus de CO₂, plus lourd',
        dryAirMolarMass(800e-6) > dryAirMolarMass(400e-6),
        `${(dryAirMolarMass(400e-6) * 1000).toFixed(6)} g/mol a 400 ppm contre ` +
          `${(dryAirMolarMass(800e-6) * 1000).toFixed(6)} a 800 ppm`,
      )

      // --- Pression saturante : Ciddor contre Buck --------------------------------
      let worstSvp = 0
      for (const temperatureK of [253.15, 273.15, 283.15, 293.15, 303.15, 313.15]) {
        const c = ciddorSaturationVapourPressure(temperatureK)
        const b = saturationVapourPressureOverWater(temperatureK)
        worstSvp = Math.max(worstSvp, Math.abs(c - b) / b)
      }
      t.checkTrue(
        'les deux pressions saturantes du moteur s’accordent',
        worstSvp < 2e-3,
        `ecart relatif maximal ${(worstSvp * 100).toFixed(3)} % entre Ciddor et Buck sur −20 a +40 °C`,
      )
      t.checkRelative(
        'pression saturante a 20 °C',
        ciddorSaturationVapourPressure(293.15),
        2339,
        1e-3,
        'Pa',
      )

      // --- Facteur d'accroissement -------------------------------------------------
      // Les deux formes coexistent volontairement — voir l'en-tete des deux
      // modules. Ce controle mesure leur ecart plutot que de le masquer.
      const fCiddor = ciddorEnhancementFactor(293.15, 101_325)
      const fBuck = enhancementFactor(101_325)
      t.checkTrue(
        'les deux facteurs d’accroissement restent proches',
        Math.abs(fCiddor - fBuck) / fBuck < 1e-3,
        `Ciddor ${fCiddor.toFixed(6)} contre Buck ${fBuck.toFixed(6)}, soit ` +
          `${(((fCiddor - fBuck) / fBuck) * 100).toFixed(4)} % — chacune reste avec sa formulation`,
      )
      t.checkTrue(
        'le facteur d’accroissement depasse l’unite',
        fCiddor > 1,
        'l’air comprime fait de la place a un peu plus de vapeur que la thermodynamique ' +
          'de la vapeur pure ne le prevoit',
      )

      // --- Fraction molaire de vapeur -----------------------------------------------
      t.check('air sec : fraction molaire nulle', ciddorWaterMoleFraction(293.15, 101_325, 0), 0, 0)
      t.checkRelative(
        'air sature a 20 °C au niveau de la mer',
        ciddorWaterMoleFraction(293.15, 101_325, 1),
        0.0232,
        0.02,
      )

      // --- Le profil vertical, celui dont la phase 11 aura besoin ---------------------
      const profile = [0, 500, 1000, 2000, 5000, 11_000, 20_000, 50_000].map((h) =>
        standardAirIndexAt(h, 550),
      )
      t.checkMonotonic('l’indice decroit avec l’altitude', profile, 'decroissant')
      t.checkTrue(
        'a 50 km il ne reste presque plus rien a devier',
        (profile[profile.length - 1] - 1) / (profile[0] - 1) < 1e-3,
        `n−1 passe de ${(profile[0] - 1).toExponential(4)} au sol a ` +
          `${(profile[profile.length - 1] - 1).toExponential(4)} a 50 km`,
      )

      // Le **gradient** est ce qui courbe les rayons, pas l'indice lui-meme. Sa
      // valeur au sol fixe l'echelle de tous les phenomenes de la phase 11.
      const gradient = (standardAirIndexAt(1, 550) - standardAirIndexAt(0, 550)) / 1
      t.checkTrue(
        'le gradient vertical d’indice est de l’ordre de −2,7·10⁻⁸ par metre',
        gradient < -2e-8 && gradient > -4e-8,
        `${gradient.toExponential(3)} m⁻¹ — c’est cette pente qui courbe les rayons, ` +
          'et une inversion locale la retournera',
      )

      // --- La confrontation astronomique ------------------------------------------------
      // Une formule de metrologie doit retomber sur une constante d'ephemeride.
      const n0 = airRefractiveIndex(550, {
        temperatureK: 283.15,
        pressurePa: 101_325,
        relativeHumidity: 0,
      })
      const at45 = planeParallelRefraction(45, n0) * ARCSEC_PER_RAD
      t.checkRelative('refraction astronomique a 45° de distance zenithale', at45, 58.2, 0.02, '″')
      t.check('refraction nulle au zenith', planeParallelRefraction(0, n0), 0, 1e-18)
      t.checkTrue(
        'la refraction croit avec la distance zenithale',
        planeParallelRefraction(60, n0) > planeParallelRefraction(45, n0),
        `${(planeParallelRefraction(60, n0) * ARCSEC_PER_RAD).toFixed(1)}″ a 60° contre ` +
          `${at45.toFixed(1)}″ a 45°`,
      )

      // La dispersion chromatique de la refraction : le bleu est plus devie que le
      // rouge, et c'est de cet ecart que naitra le rayon vert a la phase 11.
      const blue = planeParallelRefraction(85, airRefractiveIndex(450, STANDARD)) * ARCSEC_PER_RAD
      const red = planeParallelRefraction(85, airRefractiveIndex(650, STANDARD)) * ARCSEC_PER_RAD
      t.checkTrue(
        'le bleu est plus devie que le rouge',
        blue > red,
        `a 85° de distance zenithale, ${blue.toFixed(1)}″ dans le bleu contre ${red.toFixed(1)}″ ` +
          `dans le rouge, soit ${(blue - red).toFixed(2)}″ d’ecart — c’est le germe du rayon vert`,
      )
    },
  )
}
