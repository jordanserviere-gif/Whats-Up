/**
 * Rayonnement du corps noir — loi de Planck.
 *
 * ## A quoi ca sert ici
 *
 * Deux usages, tous deux reels :
 *
 * 1. **Les etoiles.** Le catalogue HYG porte l'indice de couleur B−V de chaque
 *    etoile, dont `astro/catalog.ts` tire deja une temperature de couleur
 *    (Ballesteros) pour en faire un RGB. Avec Planck, cette meme temperature
 *    devient une **distribution spectrale d'energie** : une etoile rouge
 *    s'eteindra alors davantage a l'horizon qu'une bleue parce que son spectre
 *    est different, non parce qu'on l'aura decide.
 *
 * 2. **Un juge sans donnee externe.** Un spectre de Planck a temperature T,
 *    passe dans toute la chaine colorimetrique, doit ressortir a une
 *    temperature de couleur correlee egale a T. Ce bouclage teste d'un coup le
 *    chargement des fonctions colorimetriques, l'integration par bande, la
 *    conversion XYZ et le calcul de temperature de couleur — **sans dependre
 *    d'aucune table exterieure**.
 *
 * Toutes les constantes utilisees ici sont exactes par definition depuis la
 * revision du SI de 2019.
 */
import { BOLTZMANN, PLANCK, SPEED_OF_LIGHT } from '../core/constants'

/**
 * Constante de deplacement de Wien, m·K.
 *
 * `b = hc / (k_B x)` ou `x ≈ 4,965114231744276` est la solution de
 * `x = 5(1 − e⁻ˣ)`. Elle est donc **derivee**, pas saisie : la valeur publiee
 * (2,897771955·10⁻³ m·K) sert de controle dans la suite de validation.
 */
export const WIEN_DISPLACEMENT = (() => {
  // Point fixe de x = 5(1 − e⁻ˣ), converge en une poignee d'iterations.
  let x = 5
  for (let i = 0; i < 64; i++) x = 5 * (1 - Math.exp(-x))
  return (PLANCK * SPEED_OF_LIGHT) / (BOLTZMANN * x)
})()

/**
 * Radiance spectrale d'un corps noir, en **W·m⁻²·sr⁻¹·nm⁻¹**.
 *
 *     B_λ(λ, T) = (2hc²/λ⁵) / (exp(hc/(λ k_B T)) − 1)
 *
 * La forme canonique rend des W·m⁻²·sr⁻¹·m⁻¹ (par metre de longueur d'onde) ;
 * on divise par 10⁹ pour passer « par nanometre », qui est l'unite de toutes
 * les interfaces spectrales du moteur.
 */
export function planckRadiance(lambdaNm: number, temperatureK: number): number {
  if (!(lambdaNm > 0) || !(temperatureK > 0)) return 0
  const lambda = lambdaNm * 1e-9
  const c1 = 2 * PLANCK * SPEED_OF_LIGHT * SPEED_OF_LIGHT
  const c2 = (PLANCK * SPEED_OF_LIGHT) / (BOLTZMANN * temperatureK * lambda)
  // `expm1` evite la perte de precision quand l'exposant est petit — le cas
  // dans l'infrarouge lointain, ou `exp(x) − 1` annulerait ses chiffres
  // significatifs.
  return c1 / (Math.pow(lambda, 5) * Math.expm1(c2)) / 1e9
}

/** Longueur d'onde du maximum de `planckRadiance`, nm — loi de Wien. */
export function wienPeakNm(temperatureK: number): number {
  return (WIEN_DISPLACEMENT / temperatureK) * 1e9
}

/**
 * Temperature de couleur d'une etoile a partir de son indice de couleur B−V.
 *
 * Approximation de Ballesteros (2012), **la meme que celle deja utilisee par
 * `astro/catalog.ts`** pour produire les couleurs du champ d'etoiles. La
 * reprendre ici plutot que d'en choisir une autre garantit qu'une etoile ne
 * pourra pas avoir deux temperatures selon le module qui la regarde ; la suite
 * de validation verifie que les deux coincident.
 */
export function colourTemperatureFromBv(bv: number): number {
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62))
}
