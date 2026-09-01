/**
 * Ozone — l'absorbeur qui fait le bleu du crepuscule.
 *
 * ## Pourquoi lui, et pourquoi maintenant
 *
 * La phase 5 a laisse deux ecarts, mesures et de signe oppose :
 *
 * - le ciel de journee **depasse** les paliers publies de 5 a 35 %, d'autant
 *   plus que le trajet est long ;
 * - le crepuscule est **deux a trois fois trop clair**, et son zenith ressort
 *   quasi blanc la ou le ciel reel est franchement bleu.
 *
 * Les deux pointent vers une absorption manquante, et c'est l'ozone. Son role
 * dans la couleur du crepuscule est un resultat classique : Hulburt (1953) a
 * montre que **le bleu du ciel crepusculaire ne vient pas de Rayleigh** mais de
 * la bande de Chappuis. La lumiere qui eclaire le ciel apres le coucher a
 * traverse une colonne horizontale enorme ; elle en ressort rougie, et diffuse
 * ensuite en Rayleigh — rouge diffuse en bleu donne du neutre. C'est l'ozone,
 * en retirant l'orange, qui rend le bleu.
 *
 * ## Ce que l'ozone change dans l'equation
 *
 * Jusqu'ici, **extinction et diffusion etaient la meme chose** : Rayleigh est
 * conservatif, tout ce qu'il retire au faisceau part ailleurs. L'ozone absorbe :
 * ce qu'il retire disparait.
 *
 *     extinction   τ(λ) = σ_R(λ)·C_air + σ_O₃(λ)·C_ozone     attenue les trajets
 *     diffusion    β(λ) = σ_R(λ)·N(h)                        seule source diffusee
 *
 * Confondre les deux ferait briller le ciel de la lumiere que l'ozone a
 * absorbee.
 *
 * ## La bande de Chappuis
 *
 * Large, modeste, culminant a 5,0·10⁻²⁵ m² vers 600 nm — donc **dans l'orange**.
 * Elle retire au ciel precisement ce que Rayleigh lui laisse. Son epaisseur
 * optique verticale n'est que de 0,04 : negligeable au zenith, decisive au
 * crepuscule, ou la geometrie rasante multiplie le trajet par plusieurs
 * dizaines.
 *
 * ## Donnees et modele
 *
 * Sections efficaces : IUP Bremen, *o3spectra2011* a 233 K — la temperature de
 * la stratosphere, ou vit l'ozone. Voir `scripts/build-spectral.mjs`.
 *
 * Profil vertical : une **tente** — nulle sous 10 km, maximale a 25 km, nulle
 * a 40 km. C'est une approximation grossiere d'un profil reel plus arrondi,
 * mais elle est standard dans cette litterature et son integrale, 15 km, permet
 * de la normaliser exactement sur une colonne totale mesurable.
 *
 * > **Le profil est le maillon faible de ce module.** Un profil tabule — celui
 * > de l'US Standard Atmosphere 1976, par exemple — serait plus rigoureux. La
 * > tente suffit tant que seule compte la colonne totale et son altitude
 * > moyenne ; elle cessera de suffire si la structure fine de l'absorption
 * > devait entrer en jeu.
 */
import data from '@/data/ozone-cross-section.json'
import {
  integratePiecewiseLinear,
  sampleFunctionToGrid,
  type SpectralArray,
  type SpectralGrid,
} from '../spectral/SpectralGrid'

/**
 * Unite Dobson, molecules/m².
 *
 * Une unite Dobson est l'epaisseur qu'aurait la colonne d'ozone si elle etait
 * ramenee au sol dans les conditions normales : 0,01 mm. C'est l'unite dans
 * laquelle les mesures satellitaires sont publiees.
 */
export const DOBSON_UNIT = 2.687e20

/** Colonne d'ozone typique des latitudes moyennes, en unites Dobson. */
export const DEFAULT_OZONE_COLUMN_DU = 300

/** Altitudes de la tente, m. */
export const OZONE_BOTTOM_M = 10_000
export const OZONE_PEAK_M = 25_000
export const OZONE_TOP_M = 40_000

/**
 * Integrale du profil normalise, m.
 *
 * Une tente de base 30 km et de hauteur 1 : `½ × 30 km = 15 km`. C'est par elle
 * qu'on convertit une colonne totale en densite maximale.
 */
export const OZONE_PROFILE_INTEGRAL_M = (OZONE_TOP_M - OZONE_BOTTOM_M) / 2

/** Profil vertical normalise, sans dimension, maximal a 1. */
export function ozoneProfileShape(altitudeM: number): number {
  if (altitudeM <= OZONE_BOTTOM_M || altitudeM >= OZONE_TOP_M) return 0
  return altitudeM < OZONE_PEAK_M
    ? (altitudeM - OZONE_BOTTOM_M) / (OZONE_PEAK_M - OZONE_BOTTOM_M)
    : (OZONE_TOP_M - altitudeM) / (OZONE_TOP_M - OZONE_PEAK_M)
}

/** Densite numerique d'ozone a une altitude, m⁻³, pour une colonne donnee. */
export function ozoneNumberDensity(altitudeM: number, columnDobsonUnits = DEFAULT_OZONE_COLUMN_DU): number {
  const peak = (columnDobsonUnits * DOBSON_UNIT) / OZONE_PROFILE_INTEGRAL_M
  return peak * ozoneProfileShape(altitudeM)
}

/** Section efficace d'absorption de l'ozone, m², a une longueur d'onde donnee. */
export function ozoneCrossSection(lambdaNm: number): number {
  // Interpolation lineaire dans la table ; hors du domaine tabule, zero — on
  // n'extrapole pas une donnee experimentale.
  const l = data.lambdaNm
  if (lambdaNm <= l[0] || lambdaNm >= l[l.length - 1]) return 0
  let i = 1
  while (i < l.length && l[i] < lambdaNm) i++
  const t = (lambdaNm - l[i - 1]) / (l[i] - l[i - 1])
  return data.crossSection[i - 1] + (data.crossSection[i] - data.crossSection[i - 1]) * t
}

/** Sections efficaces echantillonnees sur une grille spectrale, m². */
export function ozoneCrossSectionOn(grid: SpectralGrid): SpectralArray {
  return sampleFunctionToGrid(grid, ozoneCrossSection, 4)
}

/** Table brute, pour la validation. */
export function rawOzoneCrossSection(): { lambdaNm: readonly number[]; crossSection: readonly number[] } {
  return { lambdaNm: data.lambdaNm, crossSection: data.crossSection }
}

/** Provenance de la table. */
export const OZONE_SOURCE = data.source

/**
 * Epaisseur optique **verticale** de l'ozone a une longueur d'onde, sans
 * dimension.
 *
 * Elle ne depend que de la colonne totale, pas de la forme du profil : c'est
 * une absorption, et l'ordre dans lequel on rencontre les molecules n'y change
 * rien.
 */
export function ozoneVerticalOpticalDepth(lambdaNm: number, columnDobsonUnits = DEFAULT_OZONE_COLUMN_DU): number {
  return ozoneCrossSection(lambdaNm) * columnDobsonUnits * DOBSON_UNIT
}

/** Integrale de la table sur le visible — controle de coherence. */
export function integratedCrossSection(fromNm = 400, toNm = 700): number {
  return integratePiecewiseLinear(data.lambdaNm, data.crossSection, fromNm, toNm)
}
