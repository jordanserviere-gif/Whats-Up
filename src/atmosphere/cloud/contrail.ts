/**
 * Trainee de condensation — un tube de glace qui vieillit.
 *
 * ## Le modele
 *
 * Une trainee est decrite, en chaque point de son axe, par son **age** : le
 * temps ecoule depuis que l'avion y est passe. Tout en decoule.
 *
 * - **La section** est gaussienne, d'ecart-type `σ(t) = √(σ₀² + 2Dt)` : la
 *   diffusion turbulente l'elargit comme la racine du temps. `σ₀` rend le
 *   sillage des tourbillons de bout d'aile, quelques dizaines de metres ;
 *   `D` la dispersion par la turbulence et le cisaillement.
 * - **L'extinction lineique** `K(t)`, m²/m — l'extinction integree sur une
 *   section — dit combien de glace porte un metre de trainee. Elle s'eteint
 *   comme `e^(−t/τ)` : quelques dizaines de secondes dans l'air sec, ou la
 *   glace se sublime, des heures dans l'air sursature. `τ` viendra de
 *   l'humidite au niveau de vol ; il est ici un parametre.
 * - **La formation** n'est pas instantanee : il faut une seconde environ au
 *   panache chaud des reacteurs pour se refroidir et geler. D'ou l'intervalle
 *   vide derriere l'avion.
 *
 * ## L'epaisseur optique, sans marche de rayon
 *
 * La densite d'extinction d'un tube gaussien vaut
 * `β(r) = K / (2πσ²) · exp(−r²/2σ²)`. Un rayon qui passe a la distance `b` de
 * l'axe, sous l'angle `ψ` avec lui, la traverse sur une longueur allongee de
 * `1/sin ψ`, et l'integrale est close :
 *
 *     τ(b) = K / (√(2π) σ sin ψ) · exp(−b²/2σ²)
 *
 * C'est ce qui rend la trainee quasiment gratuite a dessiner : un ruban, une
 * formule par pixel. Les nuages, eux, demanderont une vraie marche — mais la
 * microphysique, la phase et l'eclairage sont les memes.
 */

export interface ContrailParameters {
  /** Ecart-type initial de la section, m. */
  initialSigmaM: number
  /** Diffusivite effective, m²/s. */
  diffusivityM2S: number
  /** Extinction lineique a la formation, m²/m. */
  initialExtinctionPerLengthM: number
  /** Duree de vie de la glace, s — e-folding de l'extinction lineique. */
  lifetimeS: number
  /** Duree de formation derriere les reacteurs, s. */
  formationS: number
}

/**
 * Valeurs de depart. Elles donnent une trainee jeune d'epaisseur optique 0,4
 * au centre et large d'une centaine de metres a une minute, puis de 800 m a
 * trente minutes — l'ordre de grandeur observe. La duree de vie par defaut est
 * celle d'une trainee peu persistante ; l'humidite la reglera.
 */
export const DEFAULT_CONTRAIL: ContrailParameters = {
  initialSigmaM: 15,
  diffusivityM2S: 32,
  initialExtinctionPerLengthM: 30,
  lifetimeS: 120,
  formationS: 1,
}

/** Ecart-type de la section a l'age `t`, m. */
export function contrailSigmaM(ageS: number, p: ContrailParameters = DEFAULT_CONTRAIL): number {
  return Math.sqrt(p.initialSigmaM * p.initialSigmaM + 2 * p.diffusivityM2S * Math.max(0, ageS))
}

/** Rampe de formation, de 0 a 1, lissee. */
export function contrailFormation(ageS: number, p: ContrailParameters = DEFAULT_CONTRAIL): number {
  const x = Math.min(1, Math.max(0, ageS / p.formationS))
  return x * x * (3 - 2 * x)
}

/** Extinction lineique a l'age `t`, m²/m. */
export function contrailExtinctionPerLengthM(ageS: number, p: ContrailParameters = DEFAULT_CONTRAIL): number {
  if (ageS < 0) return 0
  return p.initialExtinctionPerLengthM * contrailFormation(ageS, p) * Math.exp(-ageS / p.lifetimeS)
}

/**
 * Epaisseur optique d'un rayon qui croise la trainee a `b` metres de l'axe,
 * sous l'angle `ψ` (sinus donne) entre le rayon et l'axe.
 *
 * Le sinus est borne : un rayon parallele a l'axe traverserait un tube infini
 * sur une longueur infinie, ce que la trainee reelle, finie, ne fait pas.
 */
export function contrailOpticalDepth(
  ageS: number,
  missDistanceM: number,
  sinAngle: number,
  p: ContrailParameters = DEFAULT_CONTRAIL,
): number {
  const sigma = contrailSigmaM(ageS, p)
  const k = contrailExtinctionPerLengthM(ageS, p)
  const s = Math.max(0.05, Math.abs(sinAngle))
  return (k / (Math.sqrt(2 * Math.PI) * sigma * s)) * Math.exp(-(missDistanceM * missDistanceM) / (2 * sigma * sigma))
}

/** Densite d'extinction au point situe a `r` metres de l'axe, m⁻¹. */
export function contrailExtinctionAt(ageS: number, radiusM: number, p: ContrailParameters = DEFAULT_CONTRAIL): number {
  const sigma = contrailSigmaM(ageS, p)
  return (contrailExtinctionPerLengthM(ageS, p) / (2 * Math.PI * sigma * sigma)) * Math.exp(-(radiusM * radiusM) / (2 * sigma * sigma))
}

/** Le meme modele pour le nuanceur. */
export const CONTRAIL_GLSL = /* glsl */ `
  // params = (sigma0 m, D m²/s, K0 m²/m, lifetime s) ; formation en secondes.
  float contrailSigma(float age, vec4 params) {
    return sqrt(params.x * params.x + 2.0 * params.y * max(0.0, age));
  }
  float contrailExtinctionPerLength(float age, vec4 params, float formation) {
    float x = clamp(age / formation, 0.0, 1.0);
    return params.z * x * x * (3.0 - 2.0 * x) * exp(-max(0.0, age) / params.w);
  }
  float contrailOpticalDepth(float age, float miss, float sinAngle, vec4 params, float formation) {
    float sigma = contrailSigma(age, params);
    float k = contrailExtinctionPerLength(age, params, formation);
    return k / (2.5066282746 * sigma * max(0.05, abs(sinAngle))) * exp(-(miss * miss) / (2.0 * sigma * sigma));
  }
`
