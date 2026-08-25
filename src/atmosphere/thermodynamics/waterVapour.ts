/**
 * Vapeur d'eau : pression de vapeur saturante et humidite.
 *
 * ## Pourquoi ce module existe des la phase 1
 *
 * L'humidite n'a **aucun effet optique direct notable** dans le visible : la
 * vapeur d'eau ne diffuse pas de facon significative et ses bandes
 * d'absorption sont surtout dans le proche infrarouge. Elle est pourtant une
 * variable d'etat de premier plan, pour deux raisons :
 *
 * 1. **L'indice de refraction de l'air en depend** (phase 10). La vapeur d'eau
 *    est *moins* refringente que l'air sec a masse egale : de l'air humide est
 *    donc moins dense optiquement, ce qui deplace la refraction astronomique
 *    et la dispersion.
 * 2. **C'est elle qui condense.** Gouttelettes, brume, cristaux (phase 18)
 *    n'apparaissent pas par decret mais parce que la vapeur atteint la
 *    saturation. Sans pression de vapeur saturante, aucune microphysique ne
 *    peut emerger de causes physiques.
 *
 * ## Modele
 *
 * Buck, A. L. (1981), *New Equations for Computing Vapor Pressure and
 * Enhancement Factor*, Journal of Applied Meteorology 20, 1527–1532.
 * Equations `ew2` (au-dessus de l'eau liquide) et `ei2` (au-dessus de la
 * glace) :
 *
 *     e_w(T) = 6,1121 · exp[ (18,678 − T_c/234,5) · T_c/(257,14 + T_c) ]   hPa
 *     e_i(T) = 6,1115 · exp[ (23,036 − T_c/333,7) · T_c/(279,82 + T_c) ]   hPa
 *
 * Domaine annonce : −80 à +50 °C pour `ew2`, −80 à 0 °C pour `ei2`.
 *
 * ## Confiance et verification
 *
 * Les coefficients ci-dessus sont **verifies par trois ancres independantes de
 * la formule elle-meme** (voir `waterVapour.validation.ts`) :
 * e_w(0 °C) = 611,2 Pa, e_w(20 °C) = 2338,8 Pa, e_w(50 °C) ≈ 12 344 Pa. Si un
 * coefficient etait faux, ces controles echoueraient — c'est exactement leur
 * role, et c'est pourquoi ils ne comparent pas la formule a elle-meme.
 *
 * Le **facteur d'accroissement** est la partie la moins assuree de ce module :
 * sa forme `f = 1,0007 + 3,46·10⁻⁶ P` (Buck 1981, `f_w2`) apporte une
 * correction de +0,42 % au niveau de la mer. Un chiffre de coefficient errone
 * s'y verrait mal, faute d'ancre publiee commode. Il est donc isole dans sa
 * propre fonction, desactivable, et signale ici comme **a confronter a la
 * publication** avant que la phase 10 ne s'en serve.
 */
import { CELSIUS_ZERO, DRY_AIR_MOLAR_MASS, WATER_MOLAR_MASS } from '../core/constants'

/** Rapport des masses molaires eau / air sec — sans dimension, ≈ 0,622. */
export const MOLAR_MASS_RATIO = WATER_MOLAR_MASS / DRY_AIR_MOLAR_MASS

/**
 * Pression de vapeur saturante au-dessus de l'**eau liquide**, en Pa.
 *
 * `temperatureK` en kelvins. Reste defini sous 0 °C : l'eau surfondue existe,
 * et c'est meme le cas courant dans les nuages entre 0 et −20 °C.
 */
export function saturationVapourPressureOverWater(temperatureK: number): number {
  const tc = temperatureK - CELSIUS_ZERO
  // Le facteur 100 convertit les hectopascals de Buck en pascals.
  return 100 * 6.1121 * Math.exp((18.678 - tc / 234.5) * (tc / (257.14 + tc)))
}

/**
 * Pression de vapeur saturante au-dessus de la **glace**, en Pa.
 *
 * Toujours inferieure a celle au-dessus de l'eau liquide en dessous de 0 °C :
 * c'est cet ecart qui fait croitre les cristaux aux depens des gouttelettes
 * surfondues (effet Wegener-Bergeron-Findeisen), et donc ce qui peuplera plus
 * tard une couche de cirrus en cristaux plutot qu'en gouttes.
 */
export function saturationVapourPressureOverIce(temperatureK: number): number {
  const tc = temperatureK - CELSIUS_ZERO
  return 100 * 6.1115 * Math.exp((23.036 - tc / 333.7) * (tc / (279.82 + tc)))
}

/**
 * Facteur d'accroissement de Buck (1981), sans dimension.
 *
 * Il corrige le fait que la vapeur ne sature pas dans le vide mais dans un gaz
 * reel sous pression : l'air comprime « fait de la place » a un peu plus de
 * vapeur que la thermodynamique de la vapeur pure ne le prevoit. La correction
 * vaut +0,42 % au niveau de la mer et decroit avec la pression.
 *
 * **Coefficient a confronter a la publication avant la phase 10** — voir
 * l'en-tete du module.
 */
export function enhancementFactor(pressurePa: number): number {
  return 1.0007 + 3.46e-6 * (pressurePa / 100)
}

/**
 * Pression partielle de vapeur d'eau, en Pa, pour une humidite relative donnee.
 *
 * `relativeHumidity` va de 0 a 1. Au-dela de 0 °C la reference est l'eau
 * liquide, en dessous la glace — convention meteorologique usuelle, et celle
 * qui rend l'humidite relative comparable a ce que mesure un instrument.
 */
export function vapourPressure(
  temperatureK: number,
  pressurePa: number,
  relativeHumidity: number,
  options: { useEnhancementFactor?: boolean } = {},
): number {
  const saturation =
    temperatureK >= CELSIUS_ZERO
      ? saturationVapourPressureOverWater(temperatureK)
      : saturationVapourPressureOverIce(temperatureK)
  const f = options.useEnhancementFactor === false ? 1 : enhancementFactor(pressurePa)
  return Math.max(0, Math.min(1, relativeHumidity)) * f * saturation
}

/**
 * Fraction molaire de vapeur d'eau, sans dimension.
 *
 * C'est **la** grandeur qu'attend le modele d'indice de refraction de Ciddor
 * (phase 10) — pas l'humidite relative, pas l'humidite absolue. La nommer
 * explicitement evite la confusion la plus commune du domaine.
 */
export function waterVapourMoleFraction(vapourPressurePa: number, totalPressurePa: number): number {
  return totalPressurePa > 0 ? vapourPressurePa / totalPressurePa : 0
}

/**
 * Masse volumique de l'air **humide**, kg/m³.
 *
 * L'air humide est **moins** dense que l'air sec a meme temperature et meme
 * pression, la molecule d'eau (18 g/mol) etant plus legere que la molecule
 * moyenne de l'air (29 g/mol). C'est contre-intuitif et c'est pourtant
 * l'origine physique de plusieurs comportements que le moteur devra faire
 * emerger, a commencer par la flottabilite de l'air humide.
 */
export function moistAirDensity(
  temperatureK: number,
  pressurePa: number,
  vapourPressurePa: number,
  gasConstant: number,
): number {
  const dryPartial = pressurePa - vapourPressurePa
  return (dryPartial * DRY_AIR_MOLAR_MASS + vapourPressurePa * WATER_MOLAR_MASS) / (gasConstant * temperatureK)
}
