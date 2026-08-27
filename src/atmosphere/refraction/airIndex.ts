/**
 * Indice de refraction de l'air — formulation de Ciddor (1996).
 *
 * ## Pourquoi un second indice, alors qu'il en existe deja un
 *
 * `rayleigh/standardAir.ts` porte l'indice de **Peck & Reeder**, et il n'est pas
 * remplace ici : il est juste la ou il est. La section efficace de Rayleigh
 * s'ecrit `(n²−1)²/N²`, et ce rapport n'a de sens que si `n` et `N` decrivent le
 * **meme** gaz, aux memes conditions de reference. Un indice local y serait une
 * erreur, pas un raffinement.
 *
 * Ce module repond a l'autre question, celle que Peck & Reeder ne peut pas
 * traiter : **quel est l'indice ici**, a cette temperature, sous cette pression,
 * avec cette humidite ? C'est la grandeur dont depend la courbure d'un rayon, et
 * donc tout ce que la phase 11 doit faire emerger — refraction astronomique,
 * Soleil aplati, mirages, rayon vert.
 *
 * ## La structure de la formulation
 *
 * Ciddor ne calcule pas `n` directement. Il calcule deux refractivites **aux
 * conditions ou elles ont ete mesurees**, puis les ramene aux conditions
 * reelles **par le rapport des masses volumiques** :
 *
 *     n − 1 = (ρ_a/ρ_axs)·(n_axs − 1) + (ρ_w/ρ_ws)·(n_ws − 1)
 *
 * C'est ce qui fait sa precision : la refractivite d'un gaz est proportionnelle
 * a sa densite (relation de Lorentz-Lorenz, au premier ordre), et les densites
 * se calculent par une equation d'etat de gaz **reel**, non par la loi des gaz
 * parfaits. L'air sec et la vapeur d'eau sont traites separement parce que leurs
 * dispersions n'ont rien a voir.
 *
 * ## L'humidite **abaisse** l'indice
 *
 * Contre-intuitif, et vrai : dans le visible, remplacer des molecules d'air par
 * des molecules d'eau **diminue** l'indice de refraction. La vapeur est moins
 * refringente par molecule que l'air a ces longueurs d'onde, et l'air humide est
 * de surcroit moins dense que l'air sec (18 g/mol contre 29). La suite de
 * validation le controle explicitement : un signe inverse serait invisible sur
 * les ordres de grandeur.
 *
 * ## Deux conventions de CO₂ qui different, et ce n'est pas une coquille
 *
 * La formule de dispersion de l'air sec est etablie pour **450 ppm** ; la
 * formule de masse molaire du CIPM est referencee a **400 ppm**. Les deux
 * chiffres apparaissent donc ci-dessous avec des roles differents. C'est ainsi
 * que l'article est ecrit, et les aligner serait une erreur.
 *
 * ## ⚠️ Valeurs demandant une reference
 *
 * Ce module est presque entierement fait de constantes publiees. Une coquille
 * dans l'une d'elles serait indetectable a l'oeil — d'ou le garde-fou : Ciddor
 * et Peck & Reeder sont deux formulations **independantes** qui doivent se
 * rejoindre aux conditions standard. La validation mesure cet ecart, et il est
 * de 3·10⁻⁶ en relatif.
 *
 * Reference : Ciddor, P. E. (1996), *Refractive index of air: new equations for
 * the visible and near infrared*, Applied Optics 35(9), 1566–1573.
 */
import { DEFAULT_CO2_MOLE_FRACTION } from '../core/constants'
import type { AtmosphericSample } from '../state/AtmosphereState'
import { standardProfile } from '../thermodynamics/standardAtmosphere'

/** Zero Celsius en kelvins. */
const CELSIUS_ZERO = 273.15

/**
 * Constante des gaz retenue par Ciddor, J/(mol·K).
 *
 * `8,314510` est la valeur CODATA de 1986, celle avec laquelle l'article a ete
 * ecrit. Le moteur porte par ailleurs la valeur exacte de 2019 (`8,314462618`)
 * dans `core/constants.ts` : l'ecart est de 6·10⁻⁶ en relatif, sans effet ici,
 * mais reprendre la valeur de l'article evite d'introduire un desaccord avec les
 * coefficients qui ont ete ajustes avec elle.
 */
const CIDDOR_GAS_CONSTANT = 8.314510

/** Masse molaire de l'eau, kg/mol. */
const WATER_MOLAR_MASS = 0.018015

/** Conditions de reference de la dispersion de l'air sec : 15 °C, 101 325 Pa. */
const DRY_REFERENCE_TEMPERATURE_K = 288.15
const DRY_REFERENCE_PRESSURE_PA = 101_325
/** Teneur en CO₂ pour laquelle la formule de dispersion est etablie. */
const DISPERSION_REFERENCE_CO2 = 450e-6
/** Teneur en CO₂ de reference de la masse molaire du CIPM — voir l'en-tete. */
const MOLAR_MASS_REFERENCE_CO2 = 400e-6

/** Conditions de reference de la dispersion de la vapeur : 20 °C, 1 333 Pa. */
const VAPOUR_REFERENCE_TEMPERATURE_K = 293.15
const VAPOUR_REFERENCE_PRESSURE_PA = 1333

/**
 * Refractivite de l'air sec standard, sans dimension.
 *
 *     (n_as − 1)·10⁸ = k₁/(k₀ − σ²) + k₃/(k₂ − σ²)
 *
 * `σ = 1/λ` en µm⁻¹. Les deux termes sont des resonances : l'air absorbe dans
 * l'ultraviolet lointain, et c'est la queue de ces absorptions qui produit toute
 * la dispersion visible. C'est aussi pourquoi l'indice **croit** quand la
 * longueur d'onde diminue — le bleu est plus devie que le rouge, ce dont la
 * phase 11 tirera la dispersion chromatique de la refraction.
 */
function standardDryAirRefractivity(lambdaNm: number): number {
  const sigma2 = (1000 / lambdaNm) ** 2
  const k0 = 238.0185
  const k1 = 5_792_105
  const k2 = 57.362
  const k3 = 167_917
  return (k1 / (k0 - sigma2) + k3 / (k2 - sigma2)) * 1e-8
}

/**
 * Refractivite de la vapeur d'eau pure aux conditions de reference.
 *
 *     (n_ws − 1)·10⁸ = cf·(w₀ + w₁σ² + w₂σ⁴ + w₃σ⁶)
 *
 * `cf = 1,022` est le facteur de correction que Ciddor applique aux mesures de
 * l'epoque. Le resultat est cent fois plus petit que celui de l'air sec, non
 * parce que la vapeur serait peu refringente, mais parce que sa pression de
 * reference est cent fois plus basse.
 */
function standardVapourRefractivity(lambdaNm: number): number {
  const sigma2 = (1000 / lambdaNm) ** 2
  const cf = 1.022
  const w0 = 295.235
  const w1 = 2.6422
  const w2 = -0.032_380
  const w3 = 0.004_028
  return cf * (w0 + w1 * sigma2 + w2 * sigma2 * sigma2 + w3 * sigma2 ** 3) * 1e-8
}

/**
 * Facteur de compressibilite de l'air humide, sans dimension.
 *
 * Equation d'etat du CIPM. Il mesure l'ecart au gaz parfait : `Z = 1`
 * exactement pour un gaz parfait, et **0,9996 pour l'air au niveau de la mer**.
 * Quatre dix-milliemes, ce qui serait negligeable partout ailleurs dans ce
 * moteur — mais la refractivite de l'air ne vaut elle-meme que 2,8·10⁻⁴, et
 * l'ignorer decalerait l'indice de 0,04 %.
 */
export function airCompressibility(
  temperatureK: number,
  pressurePa: number,
  waterMoleFraction: number,
): number {
  const t = temperatureK - CELSIUS_ZERO
  const x = waterMoleFraction
  const pOverT = pressurePa / temperatureK

  const a0 = 1.58123e-6
  const a1 = -2.9331e-8
  const a2 = 1.1043e-10
  const b0 = 5.707e-6
  const b1 = -2.051e-8
  const c0 = 1.9898e-4
  const c1 = -2.376e-6
  const d = 1.83e-11
  const e = -0.765e-8

  return (
    1 -
    pOverT * (a0 + a1 * t + a2 * t * t + (b0 + b1 * t) * x + (c0 + c1 * t) * x * x) +
    pOverT * pOverT * (d + e * x * x)
  )
}

/** Masse molaire de l'air sec pour une teneur en CO₂ donnee, kg/mol. */
export function dryAirMolarMass(co2MoleFraction = DEFAULT_CO2_MOLE_FRACTION): number {
  const ppmAbove400 = (co2MoleFraction - MOLAR_MASS_REFERENCE_CO2) * 1e6
  return (28.9635 + 12.011e-6 * ppmAbove400) * 1e-3
}

/**
 * Masse volumique par l'equation d'etat du CIPM, kg/m³.
 *
 *     ρ = p·M_a/(Z·R·T)·[1 − x_w(1 − M_w/M_a)]
 *
 * Le crochet est ce qui rend l'air humide **moins** dense que l'air sec : la
 * molecule d'eau (18 g/mol) est plus legere que la molecule moyenne de l'air
 * (29 g/mol).
 */
export function cipmDensity(
  temperatureK: number,
  pressurePa: number,
  waterMoleFraction: number,
  co2MoleFraction = DEFAULT_CO2_MOLE_FRACTION,
): number {
  const ma = dryAirMolarMass(co2MoleFraction)
  const z = airCompressibility(temperatureK, pressurePa, waterMoleFraction)
  return (
    ((pressurePa * ma) / (z * CIDDOR_GAS_CONSTANT * temperatureK)) *
    (1 - waterMoleFraction * (1 - WATER_MOLAR_MASS / ma))
  )
}

/**
 * Pression de vapeur saturante selon Ciddor, en Pa.
 *
 *     svp = exp(A·T² + B·T + C + D/T)
 *
 * Le moteur porte par ailleurs la formule de **Buck (1981)** dans
 * `thermodynamics/waterVapour.ts`, qui est celle que suit la meteorologie. Les
 * deux sont des publications valides et s'accordent a 2·10⁻⁴ en relatif — la
 * validation le mesure.
 *
 * Celle-ci est employee **ici seulement**, parce qu'une formulation doit etre
 * utilisee avec les relations auxiliaires sur lesquelles ses coefficients ont
 * ete ajustes. Melanger les deux introduirait un desaccord sans le dire.
 */
export function ciddorSaturationVapourPressure(temperatureK: number): number {
  const a = 1.237_884_7e-5
  const b = -1.912_131_6e-2
  const c = 33.937_110_47
  const d = -6.343_164_5e3
  return Math.exp(a * temperatureK * temperatureK + b * temperatureK + c + d / temperatureK)
}

/**
 * Facteur d'accroissement selon Ciddor, sans dimension.
 *
 *     f = α + β·p + γ·t²
 *
 * Il corrige le fait que la vapeur ne sature pas dans le vide mais dans un gaz
 * reel sous pression. Il vaut **1,00403** a 20 °C au niveau de la mer, contre
 * **1,00421** pour la forme de Buck que porte `waterVapour.ts` : 1,8·10⁻⁴
 * d'ecart, mesure par la validation. Meme raison qu'au-dessus de garder les deux
 * separees.
 */
export function ciddorEnhancementFactor(temperatureK: number, pressurePa: number): number {
  const t = temperatureK - CELSIUS_ZERO
  return 1.000_62 + 3.14e-8 * pressurePa + 5.6e-7 * t * t
}

/** Fraction molaire de vapeur d'eau pour une humidite relative, sans dimension. */
export function ciddorWaterMoleFraction(
  temperatureK: number,
  pressurePa: number,
  relativeHumidity: number,
): number {
  if (!(pressurePa > 0)) return 0
  const h = Math.max(0, Math.min(1, relativeHumidity))
  const svp = ciddorSaturationVapourPressure(temperatureK)
  const f = ciddorEnhancementFactor(temperatureK, pressurePa)
  return Math.min(1, (h * f * svp) / pressurePa)
}

export interface AirConditions {
  temperatureK: number
  pressurePa: number
  /** Humidite relative de 0 a 1. Ignoree si `waterMoleFraction` est fournie. */
  relativeHumidity?: number
  /** Fraction molaire de vapeur d'eau — la grandeur qu'attend reellement Ciddor. */
  waterMoleFraction?: number
  co2MoleFraction?: number
}

/**
 * Indice de refraction de l'air aux conditions donnees.
 *
 * C'est l'entree de ce module. Tout le reste n'existe que pour elle.
 */
export function airRefractiveIndex(lambdaNm: number, conditions: AirConditions): number {
  const {
    temperatureK,
    pressurePa,
    relativeHumidity = 0,
    co2MoleFraction = DEFAULT_CO2_MOLE_FRACTION,
  } = conditions

  const xw =
    conditions.waterMoleFraction ??
    ciddorWaterMoleFraction(temperatureK, pressurePa, relativeHumidity)

  // --- Refractivites aux conditions ou elles ont ete mesurees ---------------
  // La dispersion de l'air sec est etablie a 450 ppm de CO₂ ; la corriger a la
  // teneur reelle est une simple mise a l'echelle (Ciddor, eq. 2).
  const naxs =
    standardDryAirRefractivity(lambdaNm) * (1 + 0.534e-6 * ((co2MoleFraction - DISPERSION_REFERENCE_CO2) * 1e6))
  const nws = standardVapourRefractivity(lambdaNm)

  // --- Masses volumiques de reference --------------------------------------
  const rhoAxs = cipmDensity(DRY_REFERENCE_TEMPERATURE_K, DRY_REFERENCE_PRESSURE_PA, 0, co2MoleFraction)
  const rhoWs = cipmDensity(VAPOUR_REFERENCE_TEMPERATURE_K, VAPOUR_REFERENCE_PRESSURE_PA, 1, co2MoleFraction)

  // --- Masses volumiques reelles, composante par composante ----------------
  // L'air reel est un melange : sa masse volumique totale se separe en une part
  // d'air sec et une part de vapeur, chacune ramenee a **sa** refractivite de
  // reference. C'est tout le principe de la methode.
  const z = airCompressibility(temperatureK, pressurePa, xw)
  const ma = dryAirMolarMass(co2MoleFraction)
  const common = pressurePa / (z * CIDDOR_GAS_CONSTANT * temperatureK)
  const rhoA = common * ma * (1 - xw)
  const rhoW = common * WATER_MOLAR_MASS * xw

  return 1 + (rhoA / rhoAxs) * naxs + (rhoW / rhoWs) * nws
}

/**
 * Indice de refraction dans l'atmosphere standard, a une altitude donnee.
 *
 * C'est la forme dont la phase 11 aura besoin : le profil vertical `n(z)`, dont
 * le **gradient** courbe les rayons. L'atmosphere standard etant seche par
 * definition, l'humidite est un parametre optionnel — et c'est precisement une
 * inversion locale de ce profil, au ras d'une surface chaude, qui produira les
 * mirages.
 */
export function standardAirIndexAt(
  altitudeM: number,
  lambdaNm: number,
  options: { relativeHumidity?: number; co2MoleFraction?: number } = {},
): number {
  const point = standardProfile(altitudeM)
  return airRefractiveIndex(lambdaNm, {
    temperatureK: point.temperatureK,
    pressurePa: point.pressurePa,
    relativeHumidity: options.relativeHumidity ?? 0,
    co2MoleFraction: options.co2MoleFraction,
  })
}

/**
 * Indice de refraction de l'air decrit par un point d'etat de l'atmosphere.
 *
 * C'est le pont que la phase 11 empruntera. Un point d'etat est **independant de
 * la longueur d'onde** — c'est une description d'air, pas d'optique — d'ou une
 * fonction qui prend les deux plutot qu'un champ de plus dans le point.
 *
 * Il lit la fraction molaire de vapeur deja calculee par l'etat, et non une
 * humidite relative : c'est la grandeur exacte qu'attend Ciddor, et la
 * reconvertir ferait passer deux fois par une pression saturante.
 *
 * L'interet, au-dela de la commodite : un etat peut porter une **inversion de
 * temperature** au ras du sol, la ou l'atmosphere standard n'en a jamais. C'est
 * cette inversion qui retournera le gradient d'indice, et c'est de la que
 * sortiront les mirages.
 */
export function sampleRefractiveIndex(
  sample: AtmosphericSample,
  lambdaNm: number,
  co2MoleFraction = DEFAULT_CO2_MOLE_FRACTION,
): number {
  return airRefractiveIndex(lambdaNm, {
    temperatureK: sample.temperatureK,
    pressurePa: sample.pressurePa,
    waterMoleFraction: sample.waterVapourMoleFraction,
    co2MoleFraction,
  })
}

/**
 * Refraction astronomique approchee, en radians, pour une distance zenithale.
 *
 *     R ≈ (n₀ − 1)·tan z
 *
 * Approximation de l'atmosphere plane, valable jusqu'a 70° environ. Elle diverge
 * a l'horizon, ou elle donnerait l'infini alors que la refraction reelle vaut
 * environ 35 minutes d'arc — c'est la courbure de la Terre qui borne le
 * resultat, et il faudra integrer le long du rayon pour l'obtenir.
 *
 * Elle n'est pas la pour le rendu, mais pour **confronter l'indice a une
 * grandeur astronomique publiee** : a 45°, elle doit tomber pres des 58
 * secondes d'arc des ephemerides. C'est le seul controle de ce module qui sorte
 * de la metrologie et rejoigne l'observation.
 */
export function planeParallelRefraction(zenithAngleDeg: number, refractiveIndex: number): number {
  return (refractiveIndex - 1) * Math.tan((zenithAngleDeg * Math.PI) / 180)
}
