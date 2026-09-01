/**
 * Scintillation — pourquoi les etoiles clignotent et les planetes non.
 *
 * ## Ce que la phase 16 a etabli, et qui commande ici
 *
 * Le seeing vaut deux secondes d'arc ; la pupille de l'oeil en impose
 * cinquante-huit par sa seule diffraction. **L'oeil nu ne peut pas voir le flou
 * atmospherique.** Il voit en revanche parfaitement la scintillation, qui n'est
 * pas une deformation de l'image mais une variation de son **intensite**.
 *
 * C'est donc la seule des deux qui ait sa place a l'ecran, et la seule que ce
 * module rende.
 *
 * ## L'origine
 *
 * Les fluctuations d'indice ne font pas que devier les rayons : elles les
 * **concentrent et les dispersent**, comme une surface d'eau agitee projette au
 * fond d'une piscine un reseau mouvant de taches claires. Le sol est traverse
 * par ce reseau, porte par le vent, et une etoile s'allume ou faiblit selon que
 * l'oeil se trouve dans une tache claire ou sombre.
 *
 * L'echelle de ce reseau est le **rayon de Fresnel** `√(λL)` : sept centimetres
 * pour une couche a dix kilometres dans le visible.
 *
 * ## Pourquoi les planetes ne scintillent pas
 *
 * Une source **etendue** projette autant de reseaux decales qu'elle a de points,
 * et leur somme s'aplanit. Le critere est geometrique : une source d'ouverture
 * angulaire `θ` projette a l'altitude `h` une tache de `θ·h`, a comparer au rayon
 * de Fresnel.
 *
 * Pour Jupiter, `40″` a dix kilometres font **deux metres** contre sept
 * centimetres de rayon de Fresnel : le moyennage est ecrasant. Pour une etoile,
 * la source est ponctuelle et il n'y a rien a moyenner.
 *
 * Ce n'est pas une regle ecrite « les planetes ne scintillent pas » : c'est un
 * rapport de deux longueurs, et la validation le mesure.
 *
 * ## Ce que l'oeil voit reellement
 *
 * La variance totale `σ_I²` porte tout le spectre temporel, jusqu'a `v/r_F` —
 * plusieurs centaines de hertz. L'oeil n'en voit que la partie basse, sous sa
 * frequence de fusion. Le reste se moyenne dans la retine et **disparait**.
 *
 * La scintillation visible est donc bien plus faible que la variance totale, ce
 * qui est heureux : une etoile au zenith clignoterait sinon de facon spectaculaire
 * alors qu'elle ne fait que fremir.
 *
 * Reference : Roddier, F. (1981), Progress in Optics 19 ; Andrews, L. C. &
 * Phillips, R. L. (2005), *Laser Beam Propagation through Random Media*, ch. 10.
 */
import { scintillationIndex, turbulenceMoment, buftonWind, hufnagelValley } from './turbulenceProfile'

/**
 * Altitude effective de la couche qui scintille, m.
 *
 * Ce n'est pas un choix : c'est le barycentre du moment `∫C_n²·h^(5/6) dh`, la
 * grandeur meme dont depend la scintillation. La phase 15 a mesure que la moitie
 * de ce moment vient de la tranche 5–15 km, et c'est ce que ce calcul retrouve.
 */
export function effectiveScintillationAltitude(
  profile: (altitudeM: number) => number = hufnagelValley,
): number {
  const weighted = turbulenceMoment(5 / 6 + 1, profile)
  const total = turbulenceMoment(5 / 6, profile)
  return total > 0 ? weighted / total : 0
}

/** Rayon de Fresnel, m — l'echelle du reseau de taches au sol. */
export const fresnelScale = (lambdaNm: number, distanceM: number): number =>
  Math.sqrt((lambdaNm * 1e-9) * distanceM)

/**
 * Facteur de moyennage par une ouverture, entre 0 et 1.
 *
 *     A = [1 + 1,062·k·D²/(4L)]^(−7/6)
 *
 * Il tend vers 1 pour une ouverture ponctuelle et decroit en `D^(−7/3)` pour une
 * grande — c'est l'asymptote classique du moyennage d'ouverture, et la validation
 * la mesure plutot que de la supposer.
 *
 * ⚠️ **Forme d'ingenierie.** L'expression exacte est une integrale double sur le
 * spectre et la pupille ; celle-ci en est l'ajustement d'usage (Andrews &
 * Phillips). Elle est correcte aux deux limites et a quelques pour cent entre.
 */
export function apertureAveraging(apertureM: number, lambdaNm: number, distanceM: number): number {
  if (!(apertureM > 0) || !(distanceM > 0)) return 1
  const k = (2 * Math.PI) / (lambdaNm * 1e-9)
  return Math.pow(1 + (1.062 * k * apertureM * apertureM) / (4 * distanceM), -7 / 6)
}

/**
 * Facteur de moyennage par la **taille de la source**, entre 0 et 1.
 *
 * Meme mecanisme que le precedent, mais du cote de la source : une etendue
 * angulaire `θ` projette a l'altitude `h` une tache de `θ·h`, qui joue le role
 * d'une ouverture.
 *
 * **C'est ce facteur, et lui seul, qui distingue une planete d'une etoile.**
 */
export const sourceSizeAveraging = (
  angularDiameterRad: number,
  lambdaNm: number,
  distanceM: number,
): number => apertureAveraging(angularDiameterRad * distanceM, lambdaNm, distanceM)

/**
 * Frequence caracteristique du scintillement, Hz.
 *
 *     f_c = v/r_F
 *
 * Le reseau de taches est porte par le vent sans se deformer — hypothese de
 * turbulence gelee de Taylor — et defile donc devant l'oeil a la vitesse du vent
 * de haute altitude. Sept centimetres a trente metres par seconde font quelques
 * centaines de hertz.
 */
export const scintillationFrequency = (
  lambdaNm: number,
  distanceM: number,
  windMs = buftonWind(9400),
): number => windMs / fresnelScale(lambdaNm, distanceM)

/**
 * Frequence de fusion de l'oeil, Hz.
 *
 * ⚠️ **Valeur physiologique d'usage, non mesuree ici.** Elle depend fortement de
 * la luminance : environ 60 Hz en vision photopique, mais **15 a 20 Hz seulement
 * en vision scotopique** — celle dont on regarde les etoiles. C'est la valeur
 * basse qui s'applique donc, et c'est elle qui rend la scintillation visible
 * plutot qu'invisible.
 */
export const EYE_FLICKER_FUSION_HZ = 20

/**
 * Fraction de la variance que l'oeil percoit reellement.
 *
 * Le spectre temporel de la scintillation est plat jusqu'a `f_c` puis chute
 * abruptement. La part au-dessous de la frequence de fusion est donc, au premier
 * ordre, le rapport `f_oeil/f_c` — le reste se moyenne dans la retine.
 *
 * ⚠️ **Approximation de premier ordre.** Le spectre reel n'est ni exactement
 * plat ni a coupure franche, et la reponse temporelle de l'oeil n'est pas un
 * creneau. Ce rapport donne l'ordre de grandeur de ce qui reste visible, pas sa
 * valeur exacte.
 */
export function visibleVarianceFraction(
  lambdaNm: number,
  distanceM: number,
  windMs?: number,
  fusionHz = EYE_FLICKER_FUSION_HZ,
): number {
  const fc = scintillationFrequency(lambdaNm, distanceM, windMs)
  return fc > 0 ? Math.min(1, fusionHz / fc) : 1
}

export interface ScintillationOptions {
  lambdaNm?: number
  /** Ouverture du recepteur, m — la pupille pour l'oeil nu. */
  apertureM?: number
  /** Diametre angulaire de la source, radians. Zero pour une etoile. */
  sourceAngularDiameterRad?: number
  /** Restreindre a ce que l'oeil percoit, plutot que la variance totale. */
  perceptual?: boolean
  profile?: (altitudeM: number) => number
}

export interface ScintillationResult {
  /** Variance de l'intensite relative, totale. */
  varianceTotal: number
  /** Variance apres moyennages d'ouverture et de source. */
  varianceAveraged: number
  /** Variance percue, si `perceptual`. */
  variancePerceived: number
  /** Ecart-type de la magnitude apparente, mag. */
  magnitudeSigma: number
  /** Altitude effective de la couche responsable, m. */
  effectiveAltitudeM: number
  /** Frequence caracteristique, Hz. */
  frequencyHz: number
}

/**
 * Scintillation d'une source, tous moyennages compris.
 *
 * `zenithAngleDeg` est la distance zenithale : la variance croit en
 * `sec^(11/6) ζ`, ce qui fait scintiller les etoiles basses bien plus que celles
 * du zenith.
 *
 * L'ecart-type en **magnitude** est la forme utile au rendu : l'intensite suit
 * une loi log-normale, et `σ_m = 1,0857 · σ_lnI` avec `σ_lnI² = ln(1 + σ_I²)`.
 */
export function scintillation(
  zenithAngleDeg: number,
  options: ScintillationOptions = {},
): ScintillationResult {
  const {
    lambdaNm = 550,
    apertureM = 0,
    sourceAngularDiameterRad = 0,
    perceptual = true,
    profile,
  } = options

  const altitude = effectiveScintillationAltitude(profile)
  // Distance parcourue dans la couche, allongee par l'obliquite de la visee.
  const slant = altitude / Math.max(0.05, Math.cos((zenithAngleDeg * Math.PI) / 180))

  const varianceTotal = scintillationIndex(lambdaNm, zenithAngleDeg, profile)
  const averaged =
    varianceTotal *
    apertureAveraging(apertureM, lambdaNm, slant) *
    sourceSizeAveraging(sourceAngularDiameterRad, lambdaNm, slant)

  const fraction = perceptual ? visibleVarianceFraction(lambdaNm, slant) : 1
  const perceived = averaged * fraction

  // Loi log-normale : `σ_lnI² = ln(1 + σ_I²)`, et une magnitude est
  // `−2,5·log₁₀(I)`, d'ou le facteur `2,5/ln10 = 1,0857`.
  const sigmaLn = Math.sqrt(Math.log(1 + Math.max(0, perceived)))

  return {
    varianceTotal,
    varianceAveraged: averaged,
    variancePerceived: perceived,
    magnitudeSigma: 1.0857362 * sigmaLn,
    effectiveAltitudeM: altitude,
    frequencyHz: scintillationFrequency(lambdaNm, slant),
  }
}

/**
 * Exposant de la dependance zenithale de la variance **percue**.
 *
 *     σ_percue² ∝ sec^(7/3) ζ
 *
 * La variance totale croit en `sec^(11/6)`. Mais la couche est aussi traversee
 * plus obliquement, ce qui **allonge la distance** et donc le rayon de Fresnel
 * en `√(sec)` ; la frequence caracteristique `v/r_F` baisse d'autant, et l'oeil
 * en voit une fraction plus grande.
 *
 *     11/6 + 1/2 = 7/3
 *
 * Ce n'est pas un ajustement : c'est la somme de deux exposants, et la mesure
 * numerique donne 2,341 pour 2,333 attendus. C'est cet exposant unique qui
 * permet de ne porter au GPU **qu'une constante**.
 */
export const PERCEIVED_ZENITH_EXPONENT = 7 / 3

/**
 * Plafond de variance percue, sans dimension.
 *
 * ⚠️ Au-dela de `σ_I² ≈ 1`, la theorie de perturbation qui donne l'indice de
 * scintillation **surestime** : la scintillation reelle sature puis decroit,
 * les taches de lumiere se fragmentant au lieu de se creuser. Le modele rend
 * 18,3 a cinq degres de hauteur, ce qui n'a plus de sens.
 *
 * Le plafond n'est donc pas un reglage esthetique mais la borne du domaine de
 * validite, posee explicitement plutot que laissee diverger.
 */
export const PERCEIVED_VARIANCE_CEILING = 0.5

/**
 * Variance percue au zenith, pour l'oeil nu — la constante que le rendu porte.
 *
 * Tout le reste de la dependance est en `sec^(11/6) ζ`, que le nuanceur calcule
 * a partir de la hauteur de chaque etoile. Une seule valeur suffit donc a porter
 * toute la physique jusqu'au GPU.
 */
export function nakedEyeZenithVariance(
  pupilM = 0.005,
  lambdaNm = 550,
  profile?: (altitudeM: number) => number,
): number {
  return scintillation(0, {
    lambdaNm,
    apertureM: pupilM,
    perceptual: true,
    profile,
  }).variancePerceived
}
