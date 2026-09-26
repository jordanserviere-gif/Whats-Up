/**
 * Formation et persistance des trainees — le critere de Schmidt-Appleman.
 *
 * ## Se forme-t-elle ?
 *
 * Les gaz d'echappement sont chauds et humides ; en se melangeant a l'air
 * ambiant, le panache suit dans le plan (temperature, pression de vapeur) une
 * **droite de melange** qui part de l'air ambiant, de pente
 *
 *     G = EI_H₂O · c_p · p / (ε · Q · (1 − η))            [Pa/K]
 *
 * (Schumann 1996) : indice d'emission de vapeur d'eau du kerosene, capacite
 * thermique de l'air, pression, rapport des masses molaires, pouvoir
 * calorifique, rendement de propulsion. Une trainee se forme si cette droite
 * **franchit la saturation liquide** : les gouttelettes apparaissent, puis
 * gelent aussitot. Comme la courbe de saturation est convexe, l'ecart entre
 * la droite et la courbe est maximal au point ou leurs pentes sont egales,
 * `T_LM`. Le critere s'ecrit donc exactement :
 *
 *     T < T_LM   et   e + G·(T_LM − T) ≥ e_sat,eau(T_LM)
 *
 * ## Persiste-t-elle ?
 *
 * Une fois formee, la glace survit si l'air est **sursature par rapport a la
 * glace** (RH_glace ≥ 100 %) : elle grossit alors en puisant la vapeur
 * ambiante, et la trainee s'etale pendant des heures. Sous-saturee, elle se
 * sublime. Combien de temps elle dure n'est pas decide ici : c'est le bilan de
 * masse de `contrail.ts` qui le dit, a partir de l'exces de vapeur rendu ici.
 */
import {
  saturationVapourPressureOverIce,
  saturationVapourPressureOverWater,
} from '../thermodynamics/waterVapour'

/** Indice d'emission de vapeur d'eau du kerosene, kg d'eau par kg de carburant. */
export const EI_H2O = 1.25
/** Pouvoir calorifique du kerosene, J/kg. */
export const KEROSENE_HEAT_J_KG = 43.2e6
/** Capacite thermique massique de l'air a pression constante, J/(kg·K). */
export const CP_AIR = 1004
/** Rapport des masses molaires eau / air sec. */
export const EPSILON = 0.622
/** Rendement de propulsion global d'un turbofan moderne. */
export const DEFAULT_PROPULSION_EFFICIENCY = 0.3

/** Pente de la droite de melange, Pa/K. */
export function mixingLineSlope(pressurePa: number, efficiency = DEFAULT_PROPULSION_EFFICIENCY): number {
  return (EI_H2O * CP_AIR * pressurePa) / (EPSILON * KEROSENE_HEAT_J_KG * (1 - efficiency))
}

/** Derivee de la pression saturante liquide, Pa/K, par difference centree. */
function saturationSlope(temperatureK: number): number {
  const h = 0.01
  return (saturationVapourPressureOverWater(temperatureK + h) - saturationVapourPressureOverWater(temperatureK - h)) / (2 * h)
}

/**
 * Temperature de tangence `T_LM`, K : la ou la pente de la saturation liquide
 * egale celle de la droite de melange. Par dichotomie, la pente etant
 * croissante avec la temperature.
 */
export function tangentTemperatureK(slopePaPerK: number): number {
  let lo = 173.15
  let hi = 273.15
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (saturationSlope(mid) < slopePaPerK) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * Approximation publiee de `T_LM` (Schumann 1996, eq. 31), °C, `G` en Pa/K.
 * Presente pour la validation : notre resolution exacte doit la retrouver.
 */
export const schumannTangentTemperatureC = (slopePaPerK: number): number => {
  const l = Math.log(slopePaPerK - 0.053)
  return -46.46 + 9.43 * l + 0.72 * l * l
}

export interface ContrailConditions {
  /**
   * Marge du critere de formation, Pa : positive, la droite de melange franchit
   * la saturation liquide ; negative, elle reste en dessous.
   */
  formationMarginPa: number
  /** La trainee se forme-t-elle ? */
  forms: boolean
  /** Humidite relative par rapport a la glace, fraction. */
  iceSaturation: number
  /**
   * Exces de vapeur sur la saturation glace, kg/m³ : ce que l'air entraine
   * apporte a la glace (positif) ou lui prend (negatif).
   */
  excessVapourKgM3: number
}

/** Constante specifique de la vapeur d'eau, J/(kg·K). */
export const WATER_VAPOUR_GAS_CONSTANT = 461.5

/**
 * Conditions de trainee pour un air ambiant donne.
 *
 * `relativeHumidityWater` est l'humidite relative **par rapport a l'eau
 * liquide**, fraction — la convention des sorties ICON.
 */
export function contrailConditions(
  temperatureK: number,
  relativeHumidityWater: number,
  pressurePa: number,
  efficiency = DEFAULT_PROPULSION_EFFICIENCY,
): ContrailConditions {
  const g = mixingLineSlope(pressurePa, efficiency)
  const tangent = tangentTemperatureK(g)
  const vapour = Math.max(0, relativeHumidityWater) * saturationVapourPressureOverWater(temperatureK)
  const margin =
    temperatureK < tangent
      ? vapour + g * (tangent - temperatureK) - saturationVapourPressureOverWater(tangent)
      : -Number.POSITIVE_INFINITY
  const iceSaturation = vapour / saturationVapourPressureOverIce(temperatureK)
  return {
    formationMarginPa: margin,
    forms: margin >= 0,
    iceSaturation,
    excessVapourKgM3: (vapour - saturationVapourPressureOverIce(temperatureK)) / (WATER_VAPOUR_GAS_CONSTANT * temperatureK),
  }
}
