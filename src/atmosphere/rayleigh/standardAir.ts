/**
 * Proprietes optiques de l'air standard entrant dans la diffusion Rayleigh.
 *
 * Deux grandeurs, toutes deux fonctions de la longueur d'onde :
 *
 * - **l'indice de refraction** de l'air, dont depend la polarisabilite des
 *   molecules, donc l'intensite de la diffusion ;
 * - **le facteur de King**, qui corrige le fait que les molecules de l'air ne
 *   sont pas spheriques : N₂ et O₂ sont des haltères, leur polarisabilite
 *   depend de leur orientation, et la lumiere diffusee n'est donc pas
 *   totalement polarisee. Ignorer cette correction sous-estime la diffusion
 *   d'environ 5 %.
 *
 * ## Un indice « standard », pas un indice local
 *
 * L'indice calcule ici est celui de l'air sec a **15 °C et 101 325 Pa**. Ce
 * n'est pas une approximation : la section efficace de Rayleigh est une
 * propriete **moleculaire**, et la combinaison `(n²−1)/N` qui y intervient est
 * quasi independante de la densite (relation de Lorentz-Lorenz). Evaluer `n` et
 * `N` aux memes conditions de reference donne donc la bonne section efficace
 * partout dans l'atmosphere ; c'est ensuite `β = σ·N(z)` qui porte toute la
 * dependance en altitude.
 *
 * L'indice **local** — celui qui courbe les rayons, qui depend de la pression,
 * de la temperature et de l'humidite — est un autre objet, et il arrive a la
 * phase 10 (modele de Ciddor). Les confondre serait une erreur de nature, pas
 * de precision.
 *
 * ## References
 *
 * - Peck, E. R. & Reeder, K. (1972), *Dispersion of Air*, J. Opt. Soc. Am. 62,
 *   958–962 — formule de dispersion de l'air sec standard.
 * - Bodhaine, B. A. et al. (1999), *On Rayleigh Optical Depth Calculations*,
 *   J. Atmos. Oceanic Technol. 16, 1854–1861 — facteur de King par
 *   composition, et correction de l'indice a la teneur en CO₂.
 */
import { BOLTZMANN } from '../core/constants'

/** Temperature de reference de l'air standard optique, K (15 °C). */
export const STANDARD_AIR_TEMPERATURE_K = 288.15
/** Pression de reference de l'air standard optique, Pa. */
export const STANDARD_AIR_PRESSURE_PA = 101_325

/**
 * Densite numerique de l'air aux conditions standard, m⁻³.
 *
 * `N_s = P/(k_B T)`. C'est la densite a laquelle l'indice de Peck & Reeder est
 * mesure, et c'est donc **imperativement** celle qui doit apparaitre au
 * denominateur de la section efficace : le rapport `(n²−1)/N` n'a de sens que
 * si ses deux termes decrivent le meme gaz.
 */
export const STANDARD_AIR_NUMBER_DENSITY = STANDARD_AIR_PRESSURE_PA / (BOLTZMANN * STANDARD_AIR_TEMPERATURE_K)

/** Teneur en CO₂ pour laquelle la formule de Peck & Reeder est etablie, en fraction molaire. */
const PECK_REEDER_CO2 = 300e-6

/**
 * Indice de refraction de l'air sec standard (15 °C, 101 325 Pa).
 *
 * Formule de dispersion de Peck & Reeder (1972), avec `σ = 1/λ` en µm⁻¹ :
 *
 *     (n − 1)·10⁸ = 8060,51 + 2480990/(132,274 − σ²) + 17455,7/(39,32957 − σ²)
 *
 * Les deux termes en fraction sont des resonances : l'air absorbe dans
 * l'ultraviolet lointain, et c'est la queue de ces absorptions qui produit
 * toute la dispersion visible. C'est aussi pour cela que l'indice **croit**
 * quand la longueur d'onde diminue — le bleu est plus devie que le rouge, ce
 * dont la phase 11 tirera la dispersion chromatique de la refraction.
 *
 * `co2MoleFraction` corrige la teneur en CO₂ : l'anhydride carbonique est plus
 * refringent que l'air moyen, et sa concentration a augmente de 300 ppm
 * (l'epoque de la formule) a plus de 420 ppm.
 */
export function standardAirRefractiveIndex(lambdaNm: number, co2MoleFraction = PECK_REEDER_CO2): number {
  const sigma2 = (1000 / lambdaNm) ** 2 // (1/λ en µm⁻¹)²
  const n300 = (8060.51 + 2480990 / (132.274 - sigma2) + 17455.7 / (39.32957 - sigma2)) * 1e-8
  // Bodhaine (1999), eq. 19 : correction lineaire a la teneur en CO₂.
  return 1 + n300 * (1 + 0.54 * (co2MoleFraction - PECK_REEDER_CO2))
}

/**
 * Facteur de King de l'air, sans dimension.
 *
 * `F = (6 + 3ρ)/(6 − 7ρ)`, ou `ρ` est le taux de depolarisation. Il vaudrait
 * exactement 1 pour un gaz de molecules parfaitement spheriques ; l'air etant
 * majoritairement diatomique, il vaut ~1,048 dans le visible — **la diffusion
 * Rayleigh reelle est donc pres de 5 % plus forte** que ce que donnerait le
 * modele idealise.
 *
 * Le facteur de chaque espece est pondere par son abondance, la teneur en CO₂
 * etant le seul terme variable. Bodhaine (1999), eq. 5.
 */
export function kingFactor(lambdaNm: number, co2MoleFraction = PECK_REEDER_CO2): number {
  const sigma2 = (1000 / lambdaNm) ** 2
  const sigma4 = sigma2 * sigma2

  const fN2 = 1.034 + 3.17e-4 * sigma2
  const fO2 = 1.096 + 1.385e-3 * sigma2 + 1.448e-4 * sigma4
  const fAr = 1.0
  const fCo2 = 1.15

  // Abondances en pourcentage volumique de l'air sec.
  const co2Percent = co2MoleFraction * 100
  const numerator = 78.084 * fN2 + 20.946 * fO2 + 0.934 * fAr + co2Percent * fCo2
  const denominator = 78.084 + 20.946 + 0.934 + co2Percent
  return numerator / denominator
}

/**
 * Taux de depolarisation de l'air, sans dimension — l'inverse du facteur de King.
 *
 * `ρ = 6(F − 1)/(3 + 7F)`. Il vaut ~0,028 dans le visible et c'est lui, et non
 * `F`, qui entre dans la fonction de phase : la lumiere diffusee a 90° n'est
 * pas totalement polarisee, et le minimum de la fonction de phase n'atteint
 * donc jamais zero.
 */
export function depolarizationRatio(lambdaNm: number, co2MoleFraction = PECK_REEDER_CO2): number {
  const f = kingFactor(lambdaNm, co2MoleFraction)
  return (6 * (f - 1)) / (3 + 7 * f)
}
