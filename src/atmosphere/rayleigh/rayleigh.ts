/**
 * Diffusion Rayleigh — la diffusion par les molecules de l'air.
 *
 * C'est le premier phenomene optique reel du moteur, et celui d'ou sort la
 * couleur du ciel. Rien ici ne mentionne le bleu : la section efficace decroit
 * en λ⁻⁴ parce que c'est ce que donne le calcul, et le ciel est bleu en
 * consequence.
 *
 * ## Equation
 *
 * Section efficace de diffusion d'une molecule d'air (Bodhaine et al. 1999,
 * eq. 2) :
 *
 *     σ(λ) = 24π³ (n² − 1)² / (λ⁴ N_s² (n² + 2)²) × F(air, λ)
 *
 * ou `n` et `N_s` sont l'indice et la densite numerique aux **memes**
 * conditions de reference, et `F` le facteur de King.
 *
 * ## Pourquoi λ⁻⁴, et pourquoi pas exactement
 *
 * Le facteur `1/λ⁴` domine, mais il n'est pas seul : `n` depend lui-meme de la
 * longueur d'onde, et `F` aussi. L'exposant effectif mesure sur le visible vaut
 * donc environ **4,09**, pas 4. L'architecture ne suppose nulle part une loi de
 * puissance : elle evalue la formule complete, et l'exposant est une grandeur
 * *mesuree* dans la suite de validation, pas une entree.
 *
 * ## Section efficace et coefficient de diffusion
 *
 * `σ` est une propriete **moleculaire** : elle ne depend ni de l'altitude, ni de
 * la pression, ni de la temperature. Toute la dependance au lieu passe par la
 * densite numerique, dans
 *
 *     β(λ, z) = σ(λ) · N(z)          [m⁻¹]
 *
 * C'est ce decoupage qui rend le precalcul possible : `σ(λ)` se tabule une fois
 * pour toutes, `N(z)` vient de l'atmosphere standard (phase 1), et leur produit
 * se recalcule pour rien.
 *
 * Le rendu actuel, lui, code trois constantes RGB fixes — `[5,5 · 13,0 ·
 * 22,4]·10⁻⁶ m⁻¹` — sans dependance a l'etat de l'atmosphere ni a l'altitude de
 * l'observateur.
 *
 * ## Reference
 *
 * Bodhaine, B. A., Wood, N. B., Dutton, E. G. & Slusser, J. R. (1999),
 * *On Rayleigh Optical Depth Calculations*, J. Atmos. Oceanic Technol. 16,
 * 1854–1861.
 */
import { sampleFunctionToGrid, type SpectralArray, type SpectralGrid } from '../spectral/SpectralGrid'
import { standardProfile } from '../thermodynamics/standardAtmosphere'
import {
  STANDARD_AIR_NUMBER_DENSITY,
  depolarizationRatio,
  kingFactor,
  standardAirRefractiveIndex,
} from './standardAir'

/**
 * Section efficace de diffusion Rayleigh d'une molecule d'air, en **m²**.
 *
 * Independante de l'altitude, de la pression et de la temperature — voir
 * l'en-tete du module. Seule la composition (CO₂) la fait varier, et
 * marginalement.
 */
export function rayleighCrossSection(lambdaNm: number, co2MoleFraction?: number): number {
  const n = standardAirRefractiveIndex(lambdaNm, co2MoleFraction)
  const n2 = n * n
  const lambdaM = lambdaNm * 1e-9
  const ns = STANDARD_AIR_NUMBER_DENSITY

  const numerator = 24 * Math.PI ** 3 * (n2 - 1) ** 2
  const denominator = lambdaM ** 4 * ns * ns * (n2 + 2) ** 2

  return (numerator / denominator) * kingFactor(lambdaNm, co2MoleFraction)
}

/**
 * Coefficient de diffusion Rayleigh, en **m⁻¹**, pour une densite numerique
 * donnee.
 *
 * `β = σ·N`. C'est la grandeur qu'attend le transfert radiatif : l'inverse
 * d'une longueur, la fraction de lumiere diffusee hors du faisceau par metre
 * parcouru.
 */
export function rayleighScatteringCoefficient(
  lambdaNm: number,
  numberDensityPerM3: number,
  co2MoleFraction?: number,
): number {
  return rayleighCrossSection(lambdaNm, co2MoleFraction) * numberDensityPerM3
}

/**
 * Coefficient de diffusion a une altitude geometrique, dans l'atmosphere
 * standard.
 *
 * Raccourci de commodite qui compose la phase 1 et la phase 3. Les marcheurs de
 * rayons echantillonneront une table plutot que d'appeler cette fonction.
 */
export function rayleighCoefficientAtAltitude(
  lambdaNm: number,
  altitudeM: number,
  co2MoleFraction?: number,
): number {
  return rayleighScatteringCoefficient(lambdaNm, standardProfile(altitudeM).numberDensityPerM3, co2MoleFraction)
}

/**
 * Fonction de phase de Rayleigh, sr⁻¹, **avec depolarisation**.
 *
 *     p(θ) = 3 / (16π(1 + 2γ)) · [(1 + 3γ) + (1 − γ)cos²θ]     γ = ρ/(2 − ρ)
 *
 * La forme idealisee `3/(16π)(1 + cos²θ)` suppose des molecules spheriques.
 * L'air n'en a pas : son taux de depolarisation `ρ ≈ 0,028` **remonte le
 * minimum** a 90°, qui ne descend jamais a zero. C'est mesurable — la lumiere du
 * ciel a 90° du Soleil n'est jamais totalement polarisee, elle plafonne autour
 * de 94 % — et c'est une des rares occasions ou une correction de quelques
 * pour cent change une propriete qualitative plutot qu'une intensite.
 *
 * Normalisee : son integrale sur la sphere vaut 1.
 */
export function rayleighPhaseFunction(cosTheta: number, lambdaNm: number, co2MoleFraction?: number): number {
  const rho = depolarizationRatio(lambdaNm, co2MoleFraction)
  const gamma = rho / (2 - rho)
  return (3 / (16 * Math.PI * (1 + 2 * gamma))) * (1 + 3 * gamma + (1 - gamma) * cosTheta * cosTheta)
}

/**
 * Fonction de phase de Rayleigh idealisee, sr⁻¹ — molecules spheriques.
 *
 * Presente pour la validation et la comparaison seulement. Le moteur utilise
 * la forme depolarisee.
 */
export function idealRayleighPhaseFunction(cosTheta: number): number {
  return (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta)
}

/**
 * Colonne de molecules au-dessus d'une altitude, en **m⁻²**, dans l'atmosphere
 * standard.
 *
 * Integree numeriquement sur le profil de la phase 1. Le resultat doit egaler
 * `P(z)/(m_air · g₀)` — c'est l'equilibre hydrostatique, et le confronter est
 * un recoupement direct entre les phases 1 et 3.
 */
export function molecularColumnAbove(altitudeM: number, topM = 100_000, stepM = 25): number {
  let column = 0
  for (let z = altitudeM; z < topM; z += stepM) {
    // Point milieu : l'exponentielle est convexe, l'evaluer au bord biaiserait
    // systematiquement la somme.
    column += standardProfile(z + stepM / 2).numberDensityPerM3 * stepM
  }
  return column
}

/**
 * Epaisseur optique Rayleigh **zenithale** au-dessus d'une altitude, sans
 * dimension.
 *
 * `τ(λ) = σ(λ) · ∫N dz`. La colonne ne dependant pas de la longueur d'onde, une
 * seule integration suffit pour tout le spectre — c'est la premiere occasion
 * concrete du moteur de separer ce qui se precalcule de ce qui se recalcule.
 */
export function rayleighOpticalDepth(
  lambdaNm: number,
  observerAltitudeM = 0,
  co2MoleFraction?: number,
  column = molecularColumnAbove(observerAltitudeM),
): number {
  return rayleighCrossSection(lambdaNm, co2MoleFraction) * column
}

/**
 * Transmittance zenithale due au seul Rayleigh, sur une grille spectrale.
 *
 * `T(λ) = exp(−τ(λ))`. C'est la loi de Beer-Lambert, et c'est **tout** ce qu'il
 * faut pour que le Soleil rougisse en descendant : plus le trajet est long,
 * plus `τ` croit, et plus il croit vite dans le bleu que dans le rouge. Aucune
 * couleur n'apparait dans ce calcul.
 */
export function rayleighTransmittanceOn(
  grid: SpectralGrid,
  observerAltitudeM = 0,
  co2MoleFraction?: number,
  airmass = 1,
): SpectralArray {
  const column = molecularColumnAbove(observerAltitudeM)
  return sampleFunctionToGrid(grid, (lambdaNm) =>
    Math.exp(-rayleighOpticalDepth(lambdaNm, observerAltitudeM, co2MoleFraction, column) * airmass),
  )
}

/** Section efficace echantillonnee sur une grille spectrale, m². */
export function rayleighCrossSectionOn(grid: SpectralGrid, co2MoleFraction?: number): SpectralArray {
  return sampleFunctionToGrid(grid, (lambdaNm) => rayleighCrossSection(lambdaNm, co2MoleFraction))
}
