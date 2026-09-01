/**
 * Validation de la turbulence optique.
 *
 * ## Le modele se valide lui-meme
 *
 * **HV 5/7** tire son nom de ce qu'il doit produire : `r₀ = 5 cm` et
 * `θ₀ = 7 µrad` a 500 nm au zenith. Ce ne sont pas des valeurs a comparer a une
 * table exterieure — ce sont celles qui **definissent** le jeu de parametres.
 * Une constante mal recopiee dans le profil, et les deux nombres ne tombent
 * plus.
 *
 * ## Les lois d'echelle sont exactes, pas approchees
 *
 * `r₀ ∝ λ^(6/5)` et `r₀ ∝ (cos ζ)^(3/5)` sortent directement de la definition
 * de Fried. Elles doivent donc etre verifiees a la precision machine, et non a
 * quelques pour cent : ce sont des identites algebriques, pas des mesures.
 *
 * ## Un recoupement gratuit
 *
 * La litterature de la turbulence emploie une refractivite a **un seul terme**,
 * `79·10⁻⁶ P/T`, la ou la phase 10 en emploie une quinzaine. Les deux doivent
 * decrire le meme air.
 *
 * ## Et un resultat qui emerge
 *
 * Le seeing et la scintillation ne viennent **pas de la meme couche**. Rien ne
 * l'ecrit : c'est la consequence de leurs poids en altitude, `h⁰` pour l'un,
 * `h^(5/6)` pour l'autre. La suite le mesure.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { airRefractiveIndex } from '../refraction/airIndex'
import { standardProfile } from '../thermodynamics/standardAtmosphere'
import {
  FREE_ATMOSPHERE_SCALES,
  kolmogorovSpectrum,
  refractiveIndexTemperatureSensitivity,
  refractiveStructureConstant,
  simpleRefractivity,
  structureFunction,
  vonKarmanSpectrum,
} from './structureConstant'
import {
  HV57,
  buftonWind,
  friedParameter,
  greenwoodFrequency,
  hufnagelValley,
  isoplanaticAngleRad,
  scintillationIndex,
  seeingArcsec,
  turbulenceMoment,
} from './turbulenceProfile'

/** Contribution d'une tranche d'altitude a un moment de `C_n²`. */
function layerShare(power: number, fromM: number, toM: number, steps = 4000): number {
  let total = 0
  for (let i = 0; i < steps; i++) {
    const h = fromM + ((toM - fromM) * (i + 0.5)) / steps
    total += hufnagelValley(h) * Math.pow(h, power) * ((toM - fromM) / steps)
  }
  return total
}

export function turbulenceSuite(): SuiteResult {
  return suite(
    'Turbulence optique',
    { reference: 'Roddier (1981) ; Hufnagel-Valley 5/7 ; Fried (1966)' },
    (t) => {
      // --- Le modele porte son nom -------------------------------------------
      const r0 = friedParameter(500, 0)
      t.checkRelative('HV 5/7 : parametre de Fried a 500 nm au zenith', r0, 0.05, 0.03, 'm')
      t.checkRelative(
        'HV 5/7 : angle isoplanetique',
        isoplanaticAngleRad(500, 0),
        7e-6,
        0.05,
        'rad',
      )
      t.checkTrue(
        'le seeing correspondant est celui d’un site mediocre',
        seeingArcsec(500, 0) > 1.5 && seeingArcsec(500, 0) < 2.5,
        `${seeingArcsec(500, 0).toFixed(3)}″ — HV 5/7 decrit un site ordinaire, pas un sommet`,
      )

      // --- Les lois d'echelle sont des identites -----------------------------
      let worstLambda = 0
      for (const lambdaNm of [400, 800, 1650, 2200]) {
        const ratio = friedParameter(lambdaNm, 0) / r0
        worstLambda = Math.max(worstLambda, Math.abs(ratio / Math.pow(lambdaNm / 500, 6 / 5) - 1))
      }
      t.checkTrue(
        'r₀ suit exactement λ^(6/5)',
        worstLambda < 1e-9,
        `ecart relatif maximal ${worstLambda.toExponential(2)} — c’est une identite algebrique, ` +
          'pas une mesure',
      )

      let worstZenith = 0
      for (const zenithDeg of [30, 45, 60, 70]) {
        const ratio = friedParameter(500, zenithDeg) / r0
        worstZenith = Math.max(
          worstZenith,
          Math.abs(ratio / Math.pow(Math.cos((zenithDeg * Math.PI) / 180), 3 / 5) - 1),
        )
      }
      t.checkTrue(
        'r₀ suit exactement (cos ζ)^(3/5)',
        worstZenith < 1e-9,
        `ecart relatif maximal ${worstZenith.toExponential(2)}`,
      )

      // Consequence : le seeing s'ameliore vers l'infrarouge, en λ^(−1/5).
      const visible = seeingArcsec(500, 0)
      const infrared = seeingArcsec(2200, 0)
      t.checkTrue(
        'le seeing s’ameliore vers l’infrarouge, et lentement',
        infrared < visible && infrared > visible * 0.5,
        `${visible.toFixed(2)}″ a 500 nm contre ${infrared.toFixed(2)}″ a 2,2 µm — ` +
          `un facteur ${(visible / infrared).toFixed(2)} pour un rapport de longueur d’onde de 4,4`,
      )

      // --- La refractivite simplifiee contre Ciddor --------------------------
      let worstRefractivity = 0
      for (const altitudeM of [0, 2000, 10_000, 20_000]) {
        const point = standardProfile(altitudeM)
        const simple = simpleRefractivity(point.pressurePa, point.temperatureK)
        const ciddor =
          airRefractiveIndex(550, {
            temperatureK: point.temperatureK,
            pressurePa: point.pressurePa,
            relativeHumidity: 0,
          }) - 1
        worstRefractivity = Math.max(worstRefractivity, Math.abs(simple - ciddor) / ciddor)
      }
      t.checkTrue(
        'la refractivite a un terme de la turbulence retombe sur Ciddor',
        worstRefractivity < 2e-3,
        `ecart relatif maximal ${(worstRefractivity * 100).toFixed(3)} % — une constante contre ` +
          'une quinzaine, et le meme air',
      )

      // --- Du thermique a l'optique -------------------------------------------
      const sensitivity = refractiveIndexTemperatureSensitivity(101_325, 288.15)
      t.checkTrue(
        'l’indice decroit quand la temperature monte',
        sensitivity < 0,
        `dn/dT = ${sensitivity.toExponential(3)} K⁻¹ — l’air chaud est moins dense, ` +
          'donc moins refringent : c’est le meme signe qui produit les mirages',
      )
      const cn2 = refractiveStructureConstant(0.1, 101_325, 288.15)
      t.checkTrue(
        'une turbulence thermique ordinaire donne un C_n² d’ordre 10⁻¹³',
        cn2 > 1e-14 && cn2 < 1e-12,
        `C_T² = 0,1 K²·m^(−2/3) donne C_n² = ${cn2.toExponential(3)} m^(−2/3), ` +
          'ce qui est l’ordre observe dans une couche limite diurne',
      )

      // --- La fonction de structure --------------------------------------------
      const exponent =
        Math.log(structureFunction(1e-14, 10) / structureFunction(1e-14, 1)) / Math.log(10)
      t.check('exposant de la fonction de structure', exponent, 2 / 3, 1e-12)

      // --- von Karman et Kolmogorov ---------------------------------------------
      // Ils doivent se confondre dans le domaine inertiel, et diverger aux deux
      // bouts — c'est toute la raison d'etre du second.
      for (const kappa of [5, 50]) {
        t.checkRelative(
          `spectres confondus dans le domaine inertiel (κ = ${kappa} m⁻¹)`,
          vonKarmanSpectrum(1e-14, kappa),
          kolmogorovSpectrum(1e-14, kappa),
          0.01,
        )
      }
      t.checkTrue(
        'l’echelle externe borne le spectre aux grandes echelles',
        vonKarmanSpectrum(1e-14, 0.5) < 0.8 * kolmogorovSpectrum(1e-14, 0.5),
        `rapport ${(vonKarmanSpectrum(1e-14, 0.5) / kolmogorovSpectrum(1e-14, 0.5)).toFixed(3)} ` +
          `a κ = 0,5 m⁻¹, pour une echelle externe de ${FREE_ATMOSPHERE_SCALES.outerScaleM} m`,
      )
      t.checkTrue(
        'et l’echelle interne l’amortit aux petites',
        vonKarmanSpectrum(1e-14, 500) < 0.9 * kolmogorovSpectrum(1e-14, 500),
        `rapport ${(vonKarmanSpectrum(1e-14, 500) / kolmogorovSpectrum(1e-14, 500)).toFixed(3)} ` +
          'a κ = 500 m⁻¹ — c’est la viscosite qui dissipe',
      )

      // --- Le resultat qui emerge -----------------------------------------------
      // Deux poids en altitude differents, deux couches responsables. Rien ne
      // l'ecrit : c'est `h⁰` contre `h^(5/6)`.
      const seeingTotal = turbulenceMoment(0)
      const scintTotal = turbulenceMoment(5 / 6)
      const seeingGround = layerShare(0, 0, 100) / seeingTotal
      const scintGround = layerShare(5 / 6, 0, 100) / scintTotal
      const scintHigh = layerShare(5 / 6, 5000, 15_000) / scintTotal

      t.checkTrue(
        'le seeing vient du sol',
        seeingGround > 0.4,
        `${(seeingGround * 100).toFixed(1)} % de l’integrale de r₀ tient dans les cent ` +
          'premiers metres',
      )
      t.checkTrue(
        'la scintillation, non',
        scintGround < 0.1,
        `${(scintGround * 100).toFixed(1)} % seulement pour la meme couche`,
      )
      t.checkTrue(
        'elle vient de la haute troposphere',
        scintHigh > 0.4,
        `${(scintHigh * 100).toFixed(1)} % de l’integrale de scintillation vient de 5 a 15 km — ` +
          'c’est pourquoi une turbulence de sol brouille l’image sans faire scintiller',
      )

      // --- Monotonies attendues --------------------------------------------------
      const calm = friedParameter(500, 0, (h) => hufnagelValley(h, { groundCn2: 1e-15 }))
      const rough = friedParameter(500, 0, (h) => hufnagelValley(h, { groundCn2: 1e-13 }))
      t.checkTrue(
        'plus de turbulence au sol, plus petit r₀',
        rough < r0 && r0 < calm,
        `r₀ passe de ${(calm * 100).toFixed(1)} cm a ${(rough * 100).toFixed(1)} cm quand ` +
          'C_n² au sol passe de 10⁻¹⁵ a 10⁻¹³',
      )

      // --- Le profil de vent et l'echelle de temps --------------------------------
      t.checkTrue(
        'le vent de Bufton culmine au courant-jet',
        buftonWind(9400) > buftonWind(0) && buftonWind(9400) > buftonWind(20_000),
        `${buftonWind(0).toFixed(1)} m/s au sol, ${buftonWind(9400).toFixed(1)} a 9,4 km, ` +
          `${buftonWind(20_000).toFixed(1)} a 20 km`,
      )
      const greenwood = greenwoodFrequency(500)
      t.checkTrue(
        'la frequence de Greenwood est de quelques dizaines de hertz',
        greenwood > 20 && greenwood < 200,
        `${greenwood.toFixed(0)} Hz — trop rapide pour que l’oeil suive, d’ou un flou ` +
          'plutot qu’un tremblement, sauf a l’oculaire ou l’image « bout »',
      )

      // --- Scintillation : regime et signalement -----------------------------------
      const sigma = scintillationIndex(500, 0)
      t.checkTrue(
        'l’indice de scintillation reste dans le regime faible au zenith',
        sigma > 0.01 && sigma < 1,
        `σ_I² = ${sigma.toFixed(4)} — au-dela de 1 la theorie de perturbation cesse d’etre ` +
          'valable et l’indice sature, ce que la formule ne corrige pas',
      )
      t.checkTrue(
        'et il croit fortement vers l’horizon',
        scintillationIndex(500, 70) > 3 * sigma,
        `${scintillationIndex(500, 70).toFixed(3)} a 70° de distance zenithale contre ` +
          `${sigma.toFixed(3)} au zenith — les etoiles basses scintillent, et en ` +
          'sec^(11/6) ζ',
      )

      // --- Convergence de la quadrature ---------------------------------------------
      const coarse = turbulenceMoment(0, hufnagelValley, 25_000, 2000)
      const fine = turbulenceMoment(0, hufnagelValley, 25_000, 40_000)
      t.checkRelative('l’integrale verticale est convergee', coarse, fine, 1e-3)
      t.checkTrue(
        'et le domaine d’integration suffit',
        turbulenceMoment(0, hufnagelValley, 40_000) / turbulenceMoment(0, hufnagelValley, 25_000) <
          1.001,
        'au-dela de 25 km il ne reste rien a melanger',
      )
      t.check('le jeu HV 5/7 est bien celui qui est employe', HV57.groundCn2, 1.7e-14, 0)
    },
  )
}
