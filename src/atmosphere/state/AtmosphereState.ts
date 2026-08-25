/**
 * Etat physique de l'atmosphere.
 *
 * C'est l'unique source de verite dont tous les solveurs derivent leurs
 * proprietes optiques. **Elle ne contient aucune grandeur de rendu** : pas de
 * couleur, pas d'exposition, pas de « trouble », pas d'intensite. Uniquement
 * des grandeurs mesurables, en SI.
 *
 * ## Ce qui est ici et ce qui ne l'est pas
 *
 * L'etat decrit **un champ**, pas une image. La chaine est :
 *
 *     AtmosphereState  →  proprietes optiques  →  transport  →  image
 *
 * Une propriete optique (coefficient de diffusion, fonction de phase, indice
 * de refraction) n'appartient donc pas a l'etat : elle s'en **deduit**. C'est
 * ce qui garantit qu'on ne puisse pas regler une couleur en douce en modifiant
 * un coefficient — il faudrait modifier une densite ou une composition, et
 * l'effet se propagerait partout de facon coherente.
 *
 * ## Champ 1D pour l'instant
 *
 * L'etat est stratifie verticalement : toute grandeur est fonction de la seule
 * altitude. C'est ce qui rend abordable tout ce qui suit — un champ 3D n'est
 * pas une extension du modele 1D, c'est un autre moteur (phase 13).
 *
 * La generalisation est cependant deja preparee, sans code mort : les profils
 * verticaux sont des **fonctions remplacables** plutot que des tables figees.
 * Une inversion thermique (phase 14) n'aura donc besoin d'aucun cas
 * particulier, seulement d'un autre `temperatureOffsetK`.
 *
 * ## Ce qui n'est pas encore la
 *
 * Aerosols, ozone et turbulence sont declares mais valent `null` : leurs
 * modeles arrivent aux phases 6, 7 et 15. Les declarer maintenant fixe la
 * frontiere du module sans creer de classe vide — ils sont typés `null` tant
 * qu'ils n'existent pas, et non « presents mais neutres », ce qui rendrait
 * indiscernable un aerosol absent d'un aerosol nul.
 */
import { DEFAULT_CO2_MOLE_FRACTION } from '../core/constants'
import {
  standardProfile,
  type AtmosphericPoint,
} from '../thermodynamics/standardAtmosphere'
import { vapourPressure, waterVapourMoleFraction } from '../thermodynamics/waterVapour'

/** Population d'aerosols — phase 6. */
export type AerosolState = null

/** Profil d'ozone — phase 7. */
export type OzoneState = null

/** Champ de turbulence — phase 15. */
export type TurbulenceState = null

export interface AtmosphereState {
  /** Altitude du sol au lieu d'observation, m. */
  groundElevationM: number

  /**
   * Ecart de temperature par rapport a l'atmosphere standard, K, en fonction de
   * l'altitude geometrique.
   *
   * C'est **le** degre de liberte thermique du moteur. Une journee chaude est un
   * offset constant ; une inversion nocturne est un offset positif confine aux
   * premieres dizaines de metres ; l'air surchauffe au-dessus d'une route est un
   * offset negatif tres serre au sol. Aucun de ces cas ne demandera de code
   * dedie — seulement une autre fonction ici.
   */
  temperatureOffsetK: (altitudeM: number) => number

  /**
   * Humidite relative, 0 a 1, en fonction de l'altitude geometrique.
   *
   * **Le profil par defaut n'est pas un modele physique** : il maintient
   * l'humidite de surface a toutes les altitudes. La vraie vapeur d'eau
   * decroit bien plus vite que l'air, et se raréfie brutalement au-dessus de la
   * tropopause. Ce raccourci est sans consequence aujourd'hui — l'humidite
   * n'intervient que dans l'indice de refraction, qui n'est pas encore branche
   * — et devra etre remplace par un profil reel a la phase 10.
   */
  relativeHumidity: (altitudeM: number) => number

  /**
   * Albedo du sol, sans dimension.
   *
   * **Condition aux limites du transfert radiatif**, pas un parametre
   * d'ambiance : la lumiere renvoyee par le sol reeclaire l'atmosphere par le
   * dessous, et c'est une part non negligeable de la luminance du ciel pres de
   * l'horizon. Le rendu actuel l'ignore totalement ; la diffusion multiple
   * (phase 8) ne peut pas s'en passer.
   */
  groundAlbedo: number

  /** Fraction molaire de CO₂ — influe sur l'indice de refraction (phase 10). */
  co2MoleFraction: number

  aerosols: AerosolState
  ozone: OzoneState
  turbulence: TurbulenceState
}

/**
 * Etat par defaut : atmosphere standard seche, sol sombre.
 *
 * `groundAlbedo` a 0,1 correspond a un sol continental sombre (foret, sol nu
 * humide). Ce n'est pas une valeur neutre — il n'y en a pas — mais une valeur
 * plausible et explicitement modifiable ; la neige a 0,8 changerait
 * considerablement la luminance du ciel bas.
 */
export function defaultAtmosphereState(overrides: Partial<AtmosphereState> = {}): AtmosphereState {
  return {
    groundElevationM: 0,
    temperatureOffsetK: () => 0,
    relativeHumidity: () => 0,
    groundAlbedo: 0.1,
    co2MoleFraction: DEFAULT_CO2_MOLE_FRACTION,
    aerosols: null,
    ozone: null,
    turbulence: null,
    ...overrides,
  }
}

/** Etat local complet, a une altitude geometrique donnee. */
export interface AtmosphericSample extends AtmosphericPoint {
  /** Altitude geometrique de l'echantillon, m. */
  altitudeM: number
  /** Pression partielle de vapeur d'eau, Pa. */
  vapourPressurePa: number
  /** Fraction molaire de vapeur d'eau, sans dimension. */
  waterVapourMoleFraction: number
  /** Humidite relative retenue a cette altitude, 0 a 1. */
  relativeHumidity: number
}

/**
 * Echantillonne l'etat a une altitude geometrique, en metres.
 *
 * L'ecart de temperature est applique **a temperature, pression inchangee**.
 * Ce n'est pas rigoureux — une couche rechauffee se dilate et modifie la
 * colonne au-dessus d'elle — mais l'ecart reste du second ordre pour les
 * offsets qui nous interessent (quelques kelvins sur quelques dizaines de
 * metres), alors qu'une reintegration hydrostatique complete a chaque
 * echantillon couterait tout. La densite, elle, **suit** la temperature
 * corrigee : c'est elle qui porte l'effet optique, et c'est donc la que la
 * coherence compte.
 *
 * Ce compromis est a revoir a la phase 14, ou les gradients deviennent
 * violents et ou l'approximation cesse d'etre du second ordre.
 */
export function sampleAtmosphere(state: AtmosphereState, altitudeM: number): AtmosphericSample {
  const base = standardProfile(altitudeM)
  const offset = state.temperatureOffsetK(altitudeM)
  const temperatureK = base.temperatureK + offset

  // Densite et densite numerique recalculees a la temperature corrigee : a
  // pression fixee, `ρ ∝ 1/T` et `N ∝ 1/T`.
  const ratio = offset === 0 ? 1 : base.temperatureK / temperatureK

  const relativeHumidity = state.relativeHumidity(altitudeM)
  const e = vapourPressure(temperatureK, base.pressurePa, relativeHumidity)

  return {
    altitudeM,
    temperatureK,
    pressurePa: base.pressurePa,
    densityKgPerM3: base.densityKgPerM3 * ratio,
    numberDensityPerM3: base.numberDensityPerM3 * ratio,
    extrapolated: base.extrapolated,
    vapourPressurePa: e,
    waterVapourMoleFraction: waterVapourMoleFraction(e, base.pressurePa),
    relativeHumidity,
  }
}
