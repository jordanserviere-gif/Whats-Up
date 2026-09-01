/**
 * Atmosphere standard — profil vertical de temperature, pression et densite.
 *
 * Modele : **U.S. Standard Atmosphere 1976**, couches 0 a 7 (jusqu'a
 * 84,852 km d'altitude geopotentielle). C'est le modele normatif de reference,
 * identique a l'ISA de l'OACI jusqu'a 32 km.
 *
 * ## Les equations
 *
 * Equilibre hydrostatique et gaz parfait :
 *
 *     dP/dh = −ρ g          ρ = P M / (R* T)          N = P / (k_B T)
 *
 * dont l'integration sur une couche a gradient thermique constant `L` donne
 * une loi de puissance, et sur une couche isotherme une exponentielle :
 *
 *     L ≠ 0 :  P(H) = P_b · [ T_b / (T_b + L·(H − H_b)) ] ^ ( g₀ M / (R* L) )
 *     L = 0 :  P(H) = P_b · exp[ −g₀ M (H − H_b) / (R* T_b) ]
 *
 * ## Pourquoi l'altitude geopotentielle
 *
 * Les equations ci-dessus supposent `g` constante. Elle ne l'est pas : la
 * pesanteur decroit en 1/r². Plutot que de trainer `g(h)` dans chaque
 * integrale, l'US1976 change de variable — l'**altitude geopotentielle** H
 * absorbe toute la variation de `g` dans la geometrie :
 *
 *     H = r₀ z / (r₀ + z)
 *
 * Dans ce systeme, `g₀` est constante *par construction*. L'ecart reste petit
 * mais n'est pas negligeable : 11 km geopotentiels valent 11,019 km
 * geometriques, et l'ecart atteint 250 m a 80 km.
 *
 * **Toute l'API publique de ce module prend une altitude geometrique en
 * metres**, parce que c'est ce qu'un marcheur de rayons connait. La conversion
 * est interne.
 *
 * ## Pressions de base : derivees, pas tabulees
 *
 * Les pressions aux bases de couches sont **calculees par recurrence** depuis
 * les seules valeurs definissantes du modele (le niveau de la mer et la table
 * des gradients), et non recopiees des tables publiees. Les tables servent
 * alors de **verification independante** — voir
 * `standardAtmosphere.validation.ts`. Recopier les pressions aurait rendu ce
 * controle circulaire et sans valeur.
 *
 * ## Domaine de validite
 *
 * Le modele s'arrete a 84,852 km geopotentiels. Au-dela, l'US1976 change de
 * formulation (temperature d'echelle moleculaire, masse molaire variable au
 * passage de la turbopause). Ce module **extrapole** de facon isotherme
 * au-dela — voir `EXTRAPOLATED_ABOVE_M`. L'extrapolation est signalee, jamais
 * silencieuse : elle porte moins de 4·10⁻⁶ de la colonne, donc elle est sans
 * effet optique, mais elle n'est pas l'US1976.
 *
 * Reference : NOAA / NASA / USAF, *U.S. Standard Atmosphere, 1976*,
 * NOAA-S/T 76-1562, tableaux 4 et 5.
 */
import {
  BOLTZMANN,
  DRY_AIR_MOLAR_MASS,
  STANDARD_GRAVITY,
  US1976_EARTH_RADIUS,
  US1976_GAS_CONSTANT,
} from '../core/constants'

/** Une couche du modele, definie par sa base et son gradient thermique. */
export interface StandardLayer {
  /** Altitude geopotentielle de la base, m. */
  readonly baseGeopotentialM: number
  /** Temperature a la base, K. */
  readonly baseTemperatureK: number
  /** Gradient thermique dans la couche, K/m. Zero pour une couche isotherme. */
  readonly lapseRateKPerM: number
  /** Pression a la base, Pa — **derivee**, voir l'en-tete du module. */
  readonly basePressurePa: number
}

/**
 * Table definissante de l'US1976 : altitude geopotentielle de base et gradient.
 *
 * Ce sont les **seules** valeurs saisies a la main de tout le modele. Les
 * temperatures de base au-dela de la premiere, comme toutes les pressions, en
 * decoulent par continuite.
 */
const LAYER_DEFINITION: ReadonlyArray<{ baseGeopotentialM: number; lapseRateKPerM: number }> = [
  { baseGeopotentialM: 0, lapseRateKPerM: -0.0065 },
  { baseGeopotentialM: 11_000, lapseRateKPerM: 0 },
  { baseGeopotentialM: 20_000, lapseRateKPerM: 0.001 },
  { baseGeopotentialM: 32_000, lapseRateKPerM: 0.0028 },
  { baseGeopotentialM: 47_000, lapseRateKPerM: 0 },
  { baseGeopotentialM: 51_000, lapseRateKPerM: -0.0028 },
  { baseGeopotentialM: 71_000, lapseRateKPerM: -0.002 },
]

/** Temperature au niveau de la mer, K — valeur definissante de l'US1976. */
export const SEA_LEVEL_TEMPERATURE_K = 288.15
/** Pression au niveau de la mer, Pa — valeur definissante de l'US1976. */
export const SEA_LEVEL_PRESSURE_PA = 101_325

/** Sommet du domaine de validite du modele, en altitude geopotentielle, m. */
export const US1976_TOP_GEOPOTENTIAL_M = 84_852

/**
 * Altitude **geometrique** au-dela de laquelle ce module extrapole au lieu
 * d'appliquer l'US1976. Environ 86 km.
 */
export const EXTRAPOLATED_ABOVE_M = geometricFromGeopotential(US1976_TOP_GEOPOTENTIAL_M)

/** `g₀ M / R*`, K/m — regroupement qui revient dans les deux formes de l'integrale. */
const GMR = (STANDARD_GRAVITY * DRY_AIR_MOLAR_MASS) / US1976_GAS_CONSTANT

/** Temperature en haut d'une couche a gradient constant. */
const topTemperature = (base: number, lapse: number, thickness: number) => base + lapse * thickness

/**
 * Pression en haut d'une couche, par integration analytique de l'equilibre
 * hydrostatique. C'est le coeur du modele, et le seul endroit ou les deux
 * formes de l'integrale apparaissent.
 */
function pressureAcrossLayer(
  basePressure: number,
  baseTemperature: number,
  lapse: number,
  thickness: number,
): number {
  if (lapse === 0) return basePressure * Math.exp((-GMR * thickness) / baseTemperature)
  const top = baseTemperature + lapse * thickness
  return basePressure * Math.pow(baseTemperature / top, GMR / lapse)
}

/**
 * Couches completes, avec temperatures et pressions de base derivees par
 * recurrence depuis le niveau de la mer.
 */
export const US1976_LAYERS: readonly StandardLayer[] = (() => {
  const layers: StandardLayer[] = []
  let temperature = SEA_LEVEL_TEMPERATURE_K
  let pressure = SEA_LEVEL_PRESSURE_PA

  for (let i = 0; i < LAYER_DEFINITION.length; i++) {
    const def = LAYER_DEFINITION[i]
    layers.push({
      baseGeopotentialM: def.baseGeopotentialM,
      baseTemperatureK: temperature,
      lapseRateKPerM: def.lapseRateKPerM,
      basePressurePa: pressure,
    })

    const nextBase = LAYER_DEFINITION[i + 1]?.baseGeopotentialM ?? US1976_TOP_GEOPOTENTIAL_M
    const thickness = nextBase - def.baseGeopotentialM
    pressure = pressureAcrossLayer(pressure, temperature, def.lapseRateKPerM, thickness)
    temperature = topTemperature(temperature, def.lapseRateKPerM, thickness)
  }

  return layers
})()

/** Temperature au sommet du domaine US1976, K. Sert de base a l'extrapolation. */
const TOP_TEMPERATURE_K = (() => {
  const last = US1976_LAYERS[US1976_LAYERS.length - 1]
  return topTemperature(
    last.baseTemperatureK,
    last.lapseRateKPerM,
    US1976_TOP_GEOPOTENTIAL_M - last.baseGeopotentialM,
  )
})()

/** Pression au sommet du domaine US1976, Pa. */
const TOP_PRESSURE_PA = (() => {
  const last = US1976_LAYERS[US1976_LAYERS.length - 1]
  return pressureAcrossLayer(
    last.basePressurePa,
    last.baseTemperatureK,
    last.lapseRateKPerM,
    US1976_TOP_GEOPOTENTIAL_M - last.baseGeopotentialM,
  )
})()

// ---------------------------------------------------------------------------
// Conversion geometrique ↔ geopotentielle
// ---------------------------------------------------------------------------

/** Altitude geometrique (m) vers altitude geopotentielle (m). */
export function geopotentialFromGeometric(altitudeM: number): number {
  return (US1976_EARTH_RADIUS * altitudeM) / (US1976_EARTH_RADIUS + altitudeM)
}

/** Altitude geopotentielle (m) vers altitude geometrique (m). */
export function geometricFromGeopotential(geopotentialM: number): number {
  return (US1976_EARTH_RADIUS * geopotentialM) / (US1976_EARTH_RADIUS - geopotentialM)
}

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

/** Indice de la couche contenant une altitude geopotentielle donnee. */
function layerIndexFor(geopotentialM: number): number {
  let index = 0
  for (let i = 1; i < US1976_LAYERS.length; i++) {
    if (geopotentialM >= US1976_LAYERS[i].baseGeopotentialM) index = i
    else break
  }
  return index
}

export interface AtmosphericPoint {
  /** Temperature cinetique, K. */
  temperatureK: number
  /** Pression, Pa. */
  pressurePa: number
  /** Masse volumique, kg/m³. */
  densityKgPerM3: number
  /** Densite numerique de molecules, m⁻³. */
  numberDensityPerM3: number
  /** Le point est-il au-dela du domaine de validite de l'US1976 ? */
  extrapolated: boolean
}

/**
 * Profil complet a une altitude **geometrique** donnee, en metres.
 *
 * Alloue un objet par appel : c'est un calcul de precomputation (generation de
 * LUT, validation), pas une fonction de boucle interne. Les marcheurs de rayons
 * echantillonneront une table, pas cette fonction.
 *
 * Sous le niveau de la mer, le profil est prolonge par la meme loi (gradient de
 * −6,5 K/km) : une vallee sous le niveau de la mer ou une reflexion ne doivent
 * pas produire de discontinuite.
 */
export function standardProfile(altitudeM: number): AtmosphericPoint {
  const geopotential = geopotentialFromGeometric(altitudeM)

  let temperatureK: number
  let pressurePa: number
  let extrapolated = false

  if (geopotential <= US1976_TOP_GEOPOTENTIAL_M) {
    const layer = US1976_LAYERS[layerIndexFor(geopotential)]
    const thickness = geopotential - layer.baseGeopotentialM
    temperatureK = topTemperature(layer.baseTemperatureK, layer.lapseRateKPerM, thickness)
    pressurePa = pressureAcrossLayer(layer.basePressurePa, layer.baseTemperatureK, layer.lapseRateKPerM, thickness)
  } else {
    // Extrapolation isotherme au-dela du domaine US1976 — voir l'en-tete.
    extrapolated = true
    temperatureK = TOP_TEMPERATURE_K
    pressurePa =
      TOP_PRESSURE_PA * Math.exp((-GMR * (geopotential - US1976_TOP_GEOPOTENTIAL_M)) / TOP_TEMPERATURE_K)
  }

  return {
    temperatureK,
    pressurePa,
    densityKgPerM3: (pressurePa * DRY_AIR_MOLAR_MASS) / (US1976_GAS_CONSTANT * temperatureK),
    numberDensityPerM3: pressurePa / (BOLTZMANN * temperatureK),
    extrapolated,
  }
}

/** Temperature seule, a une altitude geometrique en metres. */
export const standardTemperature = (altitudeM: number): number => standardProfile(altitudeM).temperatureK

/** Pression seule, a une altitude geometrique en metres. */
export const standardPressure = (altitudeM: number): number => standardProfile(altitudeM).pressurePa

/** Masse volumique seule, a une altitude geometrique en metres. */
export const standardDensity = (altitudeM: number): number => standardProfile(altitudeM).densityKgPerM3

/**
 * Densite numerique seule, a une altitude geometrique en metres.
 *
 * C'est la grandeur dont la diffusion Rayleigh depend directement (phase 3) :
 * le coefficient de diffusion est proportionnel a `N`, pas a la masse
 * volumique. Les deux ne sont proportionnelles que tant que la masse molaire
 * est constante — ce qui est vrai sous 86 km, et cesse de l'etre au-dessus.
 */
export const standardNumberDensity = (altitudeM: number): number => standardProfile(altitudeM).numberDensityPerM3

/**
 * Hauteur d'echelle locale, m : `H = R* T / (M g₀)`.
 *
 * C'est la distance sur laquelle la pression decroit d'un facteur `e` dans une
 * atmosphere isotherme locale. Au niveau de la mer elle vaut ~8,4 km, ce qui
 * justifie a posteriori la constante de 8 000 m du modele de rendu actuel — a
 * ceci pres que celle-ci est *fixe*, alors que la vraie hauteur d'echelle suit
 * la temperature et tombe a ~6,3 km a la tropopause.
 */
export function scaleHeight(altitudeM: number): number {
  return (US1976_GAS_CONSTANT * standardTemperature(altitudeM)) / (DRY_AIR_MOLAR_MASS * STANDARD_GRAVITY)
}
