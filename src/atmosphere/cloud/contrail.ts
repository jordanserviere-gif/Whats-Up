/**
 * Trainee de condensation — un panache de glace qui vieillit dans l'air reel.
 *
 * ## Le modele
 *
 * Une trainee est decrite, en chaque point de son axe, par son **age** : le
 * temps ecoule depuis que l'avion y est passe. Tout en decoule, et rien n'est
 * regle a la main pour « faire joli » : l'etalement vient de la dispersion
 * turbulente dans un vent cisaille, la quantite de glace d'un bilan de masse
 * avec l'air qu'elle entraine.
 *
 * ### L'etalement : dispersion gaussienne dans un cisaillement
 *
 * Un panache passif dans une turbulence de diffusivites `D_h` (horizontale) et
 * `D_v` (verticale), transporte par un vent dont la composante horizontale
 * varie avec l'altitude au taux `s`, reste gaussien, d'ecarts-types
 *
 *     σ_z² = σ_z0² + 2 D_v t
 *     σ_y² = σ_y0² + 2 D_h t + s² σ_z0² t² + ⅔ s² D_v t³
 *
 * (Konopka 1995 ; Schumann, Konopka et al. 1995). Le terme en `t²` est
 * l'inclinaison de la section par le cisaillement, celui en `t³` la
 * dispersion verticale que le cisaillement convertit en largeur. C'est le
 * cisaillement qui fait, en une demi-heure, d'un trait de cent metres une
 * bande de plusieurs kilometres. La validation retrouve ces formules par une
 * simulation de particules independante.
 *
 * `σ_z0` n'est pas le rayon des jets : c'est la **profondeur du sillage**. Les
 * tourbillons de bout d'aile descendent de 100 a 200 m en une ou deux minutes
 * en entrainant une partie du panache ; la section se retrouve etiree
 * verticalement. On l'atteint par une rampe sur la phase de sillage.
 *
 * ### La glace : un bilan de masse
 *
 * En s'elargissant, le panache entraine de l'air ambiant. Si cet air est
 * **sursature** par rapport a la glace, son exces de vapeur se depose sur les
 * cristaux — la trainee s'epaissit et peut vivre des heures ; s'il est
 * **sous-sature**, les cristaux se subliment pour le saturer, et la trainee
 * meurt quand sa glace est epuisee. Le depot est rapide devant l'etalement (les
 * cristaux sont nombreux) : l'air entraine est ramene a saturation, d'ou
 *
 *     M(t) = M₀ + ρ_v,exces · (A(t) − A₀),     A = 2π σ_y σ_z
 *
 * `M` la masse de glace par metre de trainee, `ρ_v,exces = (e − e_sat,glace) /
 * (R_v T)`. Le **nombre** de cristaux est conserve : leur rayon suit
 * `r ∝ M^⅓`, et l'extinction `K = 2 · N π r²` suit `M^⅔`.
 *
 * ### L'etat initial
 *
 * `M₀` et `r₀` sont les deux seuls parametres d'etat initial. Le rayon des
 * cristaux d'une trainee jeune, de l'ordre du micrometre, est un resultat de
 * mesure ; la masse est calee pour que l'epaisseur optique d'une trainee de
 * quelques secondes soit de 0,3 a 0,5, la plage observee.
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
 * On y prend `σ = σ_y` : c'est la largeur vue du sol, et, pour une section
 * elliptique vue de dessous, l'integrale verticale donne exactement cette forme.
 */
import { ICE_DENSITY_KG_M3 } from './microphysics'
import { DEFAULT_LAYOUT, vortexSpacingM, type AircraftLayout } from '../../astro/aircraftTypes'

/** Etat de l'air ambiant au niveau de vol, tel que la trainee le rencontre. */
export interface ContrailEnvironment {
  /** Cisaillement vertical du vent horizontal, s⁻¹. */
  shearPerS: number
  /** Exces de vapeur sur la saturation glace, kg/m³ — negatif en air sous-sature. */
  excessVapourKgM3: number
}

/**
 * Environnement par defaut, faute de mesure : cisaillement typique de la haute
 * troposphere, air legerement sous-sature — une trainee courte.
 */
export const DEFAULT_ENVIRONMENT: ContrailEnvironment = { shearPerS: 0.004, excessVapourKgM3: -2e-6 }

export interface ContrailParameters {
  /** Ecart-type initial de la section, m — le sillage deja fusionne. */
  initialSigmaM: number
  /** Diffusivites turbulentes horizontale et verticale, m²/s. */
  horizontalDiffusivityM2S: number
  verticalDiffusivityM2S: number
  /** Profondeur du sillage, ecart-type vertical, m, et duree de la phase de sillage, s. */
  wakeSigmaZM: number
  wakePhaseS: number
  /** Masse de glace initiale, kg par metre de trainee. */
  initialIceKgPerM: number
  /** Rayon effectif initial des cristaux, m. */
  initialEffectiveRadiusM: number
  /** Duree de formation derriere les reacteurs, s. */
  formationS: number
}

/**
 * Valeurs de depart. Diffusivites : ordre de grandeur mesure pres de la
 * tropopause (Schumann et al. 1995 : D_h de l'ordre de 10 a 20 m²/s, D_v de
 * 0,1 a 0,6 m²/s). Profondeur de sillage : 70 m d'ecart-type, soit environ
 * 250 m de haut. Masse et rayon initiaux : voir l'en-tete.
 */
export const DEFAULT_CONTRAIL: ContrailParameters = {
  initialSigmaM: 15,
  horizontalDiffusivityM2S: 15,
  verticalDiffusivityM2S: 0.15,
  wakeSigmaZM: 70,
  wakePhaseS: 90,
  initialIceKgPerM: 0.018,
  initialEffectiveRadiusM: 1e-6,
  // Une trainee devient visible a une ou deux envergures derriere l'avion :
  // le temps que le panache se refroidisse et gele, environ 0,3 s a 230 m/s.
  formationS: 0.3,
}

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/** Ecart-type vertical, m. */
export function contrailSigmaZM(ageS: number, p: ContrailParameters = DEFAULT_CONTRAIL): number {
  const t = Math.max(0, ageS)
  const wake = p.initialSigmaM + (p.wakeSigmaZM - p.initialSigmaM) * smooth01(t / p.wakePhaseS)
  return Math.sqrt(wake * wake + 2 * p.verticalDiffusivityM2S * t)
}

/** Ecart-type horizontal — la largeur vue du sol —, m. */
export function contrailSigmaM(
  ageS: number,
  env: ContrailEnvironment = DEFAULT_ENVIRONMENT,
  p: ContrailParameters = DEFAULT_CONTRAIL,
): number {
  const t = Math.max(0, ageS)
  const s2 = env.shearPerS * env.shearPerS
  const zWake = p.initialSigmaM + (p.wakeSigmaZM - p.initialSigmaM) * smooth01(t / p.wakePhaseS)
  return Math.sqrt(
    p.initialSigmaM * p.initialSigmaM +
      2 * p.horizontalDiffusivityM2S * t +
      s2 * zWake * zWake * t * t +
      (2 / 3) * s2 * p.verticalDiffusivityM2S * t * t * t,
  )
}

/** Rampe de formation, de 0 a 1, lissee. */
export function contrailFormation(ageS: number, p: ContrailParameters = DEFAULT_CONTRAIL): number {
  return smooth01(ageS / p.formationS)
}

/** Masse de glace par metre, kg — le bilan de l'en-tete, jamais negative. */
export function contrailIceKgPerM(
  ageS: number,
  env: ContrailEnvironment = DEFAULT_ENVIRONMENT,
  p: ContrailParameters = DEFAULT_CONTRAIL,
): number {
  const area = 2 * Math.PI * contrailSigmaM(ageS, env, p) * contrailSigmaZM(ageS, p)
  const area0 = 2 * Math.PI * p.initialSigmaM * p.initialSigmaM
  return Math.max(0, p.initialIceKgPerM + env.excessVapourKgM3 * (area - area0))
}

/** Extinction lineique initiale, m²/m : `3M/(2ρr)`, comme toute population de glace. */
export const initialExtinctionPerLengthM = (p: ContrailParameters = DEFAULT_CONTRAIL): number =>
  (3 * p.initialIceKgPerM) / (2 * ICE_DENSITY_KG_M3 * p.initialEffectiveRadiusM)

/** Extinction lineique a l'age `t`, m²/m — nombre de cristaux conserve, `K ∝ M^⅔`. */
export function contrailExtinctionPerLengthM(
  ageS: number,
  env: ContrailEnvironment = DEFAULT_ENVIRONMENT,
  p: ContrailParameters = DEFAULT_CONTRAIL,
): number {
  if (ageS < 0) return 0
  const ratio = contrailIceKgPerM(ageS, env, p) / p.initialIceKgPerM
  return initialExtinctionPerLengthM(p) * contrailFormation(ageS, p) * Math.pow(ratio, 2 / 3)
}

/** Rayon effectif des cristaux a l'age `t`, m. */
export const contrailEffectiveRadiusM = (
  ageS: number,
  env: ContrailEnvironment = DEFAULT_ENVIRONMENT,
  p: ContrailParameters = DEFAULT_CONTRAIL,
): number => p.initialEffectiveRadiusM * Math.cbrt(contrailIceKgPerM(ageS, env, p) / p.initialIceKgPerM)

/**
 * Age auquel la glace s'epuise, s, ou `Infinity` en air sature ou sursature.
 * Par dichotomie : la surface entrainee croit avec l'age.
 */
export function contrailDeathAgeS(env: ContrailEnvironment = DEFAULT_ENVIRONMENT, p: ContrailParameters = DEFAULT_CONTRAIL): number {
  if (env.excessVapourKgM3 >= 0) return Number.POSITIVE_INFINITY
  let lo = 0
  let hi = 1
  while (contrailIceKgPerM(hi, env, p) > 0 && hi < 86_400) hi *= 2
  if (hi >= 86_400) return Number.POSITIVE_INFINITY
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (contrailIceKgPerM(mid, env, p) > 0) lo = mid
    else hi = mid
  }
  return hi
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
  env: ContrailEnvironment = DEFAULT_ENVIRONMENT,
  p: ContrailParameters = DEFAULT_CONTRAIL,
): number {
  const sigma = contrailSigmaM(ageS, env, p)
  const k = contrailExtinctionPerLengthM(ageS, env, p)
  const s = Math.max(0.05, Math.abs(sinAngle))
  return (k / (Math.sqrt(2 * Math.PI) * sigma * s)) * Math.exp(-(missDistanceM * missDistanceM) / (2 * sigma * sigma))
}

/** Densite d'extinction au point situe a `r` metres de l'axe, m⁻¹ (section ronde de rayon σ_y). */
export function contrailExtinctionAt(
  ageS: number,
  radiusM: number,
  env: ContrailEnvironment = DEFAULT_ENVIRONMENT,
  p: ContrailParameters = DEFAULT_CONTRAIL,
): number {
  const sigma = contrailSigmaM(ageS, env, p)
  return (contrailExtinctionPerLengthM(ageS, env, p) / (2 * Math.PI * sigma * sigma)) * Math.exp(-(radiusM * radiusM) / (2 * sigma * sigma))
}

/**
 * ## La structure fine
 *
 * Le tube analytique est lisse ; une trainee reelle ne l'est pas. Trois
 * phenomenes, tous fonction de l'age et de la position **dans la masse d'air**
 * — la distance parcourue par l'avion quand la glace a ete emise —, pour que
 * les irregularites restent en place pendant que l'avion avance :
 *
 * - **Un panache par reacteur.** Chaque reacteur emet le sien ; les
 *   tourbillons de bout d'aile les enroulent, un par cote, puis fusionnent. Un
 *   quadrireacteur trace quatre trainees, puis deux, puis une ; un biréacteur
 *   garde souvent sa double trainee une a deux minutes.
 * - **Des bords irreguliers.** Les tourbillons qui dispersent un panache sont
 *   de sa taille : plus petits, ils ne font que l'elargir, ce que la
 *   diffusivite decrit deja ; beaucoup plus grands, ils le deplacent d'un bloc.
 *   L'echelle du bruit suit donc la largeur de la trainee, a tout age. Ses
 *   amplitudes — ±35 % de largeur, un axe qui serpente d'un demi-ecart-type —
 *   sont un **choix** : la litterature n'en donne pas de valeur a reprendre.
 * - **L'instabilite de Crow.** Les deux tourbillons ondulent l'un vers l'autre
 *   a une longueur d'onde de 8,6 fois leur ecartement (Crow 1970) — environ
 *   230 m pour un monocouloir, 540 m pour un A380 —, se reconnectent, et la trainee se pince en
 *   un chapelet de bouffees au bout d'une a deux minutes. La modulation est de
 *   **moyenne nulle** : elle deplace la glace le long de l'axe sans en creer.
 */
export const CONTRAIL_STRUCTURE = {
  /**
   * Chaque panache de reacteur, pendant la phase de jet : ecart-type initial,
   * m, et diffusivite de melange du jet, m²/s. Le panache est alors pris dans
   * le systeme tourbillonnaire de l'avion ; il s'elargit par le melange du jet,
   * pas par la turbulence ambiante de 15 m²/s, qui confondait des la premiere
   * seconde deux jets ecartes de onze metres. Tant que les tourbillons
   * existent, la glace reste concentree autour de leurs coeurs — le sillage
   * primaire ; elle ne s'etale a la largeur du sillage qu'a leur rupture,
   * c'est-a-dire a leur fusion.
   */
  jetSigmaM: 2,
  jetDiffusivityM2S: 1.5,
  /**
   * Duree d'enroulement des panaches par les tourbillons de bout d'aile, s :
   * pendant la phase de jet, chaque panache est aspire par le tourbillon de
   * son cote. Un quadrireacteur passe ainsi de quatre trainees a deux.
   */
  rollupS: 15,
  /**
   * Fusion des deux tourbillons, en fractions de la phase de sillage : ils
   * descendent ensemble puis se reconnectent (Crow), et les deux trainees n'en
   * font plus qu'une. C'est ce qui garde souvent un biréacteur en double
   * trainee pendant une a deux minutes.
   */
  vortexMergeFrom: 0.7,
  vortexMergeTo: 1.5,
  /** Rapport longueur d'onde de Crow / ecartement des tourbillons (Crow 1970). */
  crowWavelengthPerSpacing: 8.6,
  /** Debut et fin du pincement, s ; profondeur maximale de la modulation. */
  crowOnsetS: 50,
  crowFullS: 150,
  crowDepth: 0.55,
  /** Echelle de la turbulence, en ecarts-types de la section, et amplitudes. */
  turbulenceScaleSigmas: 5,
  turbulenceWidth: 0.35,
  turbulenceOffset: 0.5,
} as const

/** Nombre maximal de panaches que le nuanceur sait porter. */
export const MAX_PLUMES = 4

/** Fraction de la fusion des tourbillons a l'age `t`, de 0 a 1. */
export function vortexMerge(ageS: number, p: ContrailParameters = DEFAULT_CONTRAIL): number {
  const s = CONTRAIL_STRUCTURE
  return smooth01((ageS - s.vortexMergeFrom * p.wakePhaseS) / ((s.vortexMergeTo - s.vortexMergeFrom) * p.wakePhaseS))
}

/**
 * Position laterale de chaque panache a l'age `t`, m.
 *
 * Trois temps : le panache part de son reacteur ; il est enroule par le
 * tourbillon de son cote, a `±b₀/2` ; les deux tourbillons fusionnent sur
 * l'axe. Un reacteur central (trireacteur) reste sur l'axe.
 */
export function plumePositionsM(
  ageS: number,
  layout: AircraftLayout,
  p: ContrailParameters = DEFAULT_CONTRAIL,
): number[] {
  const rolled = smooth01(ageS / CONTRAIL_STRUCTURE.rollupS)
  const merged = vortexMerge(ageS, p)
  const halfB0 = vortexSpacingM(layout) / 2
  return layout.enginesYM.map((y) => {
    const vortex = Math.sign(y) * halfB0
    return (y + (vortex - y) * rolled) * (1 - merged)
  })
}

/** Longueur d'onde de Crow de cet appareil, m. */
export const crowWavelengthM = (layout: AircraftLayout): number =>
  CONTRAIL_STRUCTURE.crowWavelengthPerSpacing * vortexSpacingM(layout)

/** Facteur de Crow sur l'extinction lineique, de moyenne 1 sur une longueur d'onde. */
export function crowModulation(ageS: number, alongM: number, layout: AircraftLayout = DEFAULT_LAYOUT): number {
  const s = CONTRAIL_STRUCTURE
  const depth = s.crowDepth * smooth01((ageS - s.crowOnsetS) / (s.crowFullS - s.crowOnsetS))
  return 1 + depth * Math.cos((2 * Math.PI * alongM) / crowWavelengthM(layout))
}

/** Ecart-type de chaque panache, m : celui du jet, puis, a la rupture des tourbillons, celui du sillage. */
export function plumeSigmaM(
  ageS: number,
  env: ContrailEnvironment = DEFAULT_ENVIRONMENT,
  p: ContrailParameters = DEFAULT_CONTRAIL,
): number {
  const s = CONTRAIL_STRUCTURE
  const t = Math.max(0, ageS)
  const jet = Math.sqrt(s.jetSigmaM * s.jetSigmaM + 2 * s.jetDiffusivityM2S * t)
  return jet + (contrailSigmaM(t, env, p) - jet) * vortexMerge(t, p)
}

/**
 * Epaisseur optique d'une trainee a plusieurs panaches : la somme de N tubes,
 * chacun portant `1/N` de la glace. Integree sur la section, elle rend la meme
 * extinction lineique que le tube unique — les panaches se partagent la
 * glace, ils ne la multiplient pas.
 *
 * Chaque panache part de la largeur d'un jet et rejoint celle du sillage a
 * la fin de la phase de sillage — voir `plumeSigmaM`.
 */
export function enginePlumeOpticalDepth(
  ageS: number,
  missDistanceM: number,
  sinAngle: number,
  layout: AircraftLayout = DEFAULT_LAYOUT,
  env: ContrailEnvironment = DEFAULT_ENVIRONMENT,
  p: ContrailParameters = DEFAULT_CONTRAIL,
): number {
  // La glace est celle du sillage : la largeur des jets ne change pas sa masse.
  const k = contrailExtinctionPerLengthM(ageS, env, p)
  const sigma = plumeSigmaM(ageS, env, p)
  const norm = k / (Math.sqrt(2 * Math.PI) * sigma * Math.max(0.05, Math.abs(sinAngle)))
  const positions = plumePositionsM(ageS, layout, p)
  let sum = 0
  for (const y of positions) sum += Math.exp(-((missDistanceM - y) ** 2) / (2 * sigma * sigma))
  return (norm * sum) / positions.length
}

/**
 * Le meme modele pour le nuanceur.
 *
 * `params`  = (σ₀ m, D_h m²/s, D_v m²/s, K₀ m²/m) ;
 * `wake`    = (σ_z sillage m, phase de sillage s, M₀ kg/m, formation s) ;
 * `env`     = (cisaillement s⁻¹, exces de vapeur kg/m³) ;
 * `engines` = positions laterales des reacteurs, m, jusqu'a quatre ;
 * `plumes`  = (nombre de reacteurs, demi-ecartement des tourbillons m) ; `layout` est un mot reserve en GLSL.
 */
export const CONTRAIL_GLSL = /* glsl */ `
  float contrailSmooth(float x) {
    float t = clamp(x, 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  }
  float contrailWakeZ(float age, float sigma0, vec4 wake) {
    return sigma0 + (wake.x - sigma0) * contrailSmooth(age / wake.y);
  }
  float contrailSigmaZ(float age, float sigma0, vec4 params, vec4 wake) {
    float z = contrailWakeZ(age, sigma0, wake);
    return sqrt(z * z + 2.0 * params.z * max(0.0, age));
  }
  float contrailSigmaY(float age, float sigma0, vec4 params, vec4 wake, vec2 env) {
    float t = max(0.0, age);
    float s2 = env.x * env.x;
    float z = contrailWakeZ(t, sigma0, wake);
    return sqrt(sigma0 * sigma0 + 2.0 * params.y * t + s2 * z * z * t * t + 0.6666667 * s2 * params.z * t * t * t);
  }
  float contrailExtinctionPerLength(float age, vec4 params, vec4 wake, vec2 env) {
    float area = 6.2831853 * contrailSigmaY(age, params.x, params, wake, env) * contrailSigmaZ(age, params.x, params, wake);
    float area0 = 6.2831853 * params.x * params.x;
    float ice = max(0.0, wake.z + env.y * (area - area0));
    return params.w * contrailSmooth(age / wake.w) * pow(ice / wake.z, 0.6666667);
  }
  // --- Structure fine : voir CONTRAIL_STRUCTURE -------------------------------
  float contrailHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float contrailNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(contrailHash(i), contrailHash(i + vec2(1.0, 0.0)), u.x),
               mix(contrailHash(i + vec2(0.0, 1.0)), contrailHash(i + vec2(1.0, 1.0)), u.x), u.y) * 2.0 - 1.0;
  }
  // Trois octaves ; la seconde coordonnee fait lentement evoluer le motif avec l'age.
  float contrailFbm(vec2 p) {
    return 0.55 * contrailNoise(p) + 0.3 * contrailNoise(p * 2.03 + 17.0) + 0.15 * contrailNoise(p * 4.1 + 41.0);
  }
  // along : position dans la masse d'air, m ; footprint : ce qu'en couvre un
  // pixel, m. Un motif plus fin que le pixel est filtre plutot que dessine :
  // echantillonne, il donnait un pointille.
  float contrailStructuredDepth(float age, float miss, float sinAngle, vec4 params, vec4 wake, vec2 env,
                                vec4 engines, vec2 plumes, float along, float footprint) {
    float k = contrailExtinctionPerLength(age, params, wake, env);
    float sigma = contrailSigmaY(age, params.x, params, wake, env);

    // Turbulence : des tourbillons de la taille du panache. Le motif est donc
    // exprime en largeurs de trainee, et se filtre quand un pixel en couvre une.
    float scale = ${CONTRAIL_STRUCTURE.turbulenceScaleSigmas.toFixed(1)} * sigma;
    float grow = smoothstep(0.0, 60.0, age) * (1.0 - smoothstep(0.25 * scale, scale, footprint));
    vec2 q = vec2(along / scale, age / 240.0);
    float widthScale = 1.0 + ${CONTRAIL_STRUCTURE.turbulenceWidth.toFixed(3)} * grow * contrailFbm(q);
    float offset = ${CONTRAIL_STRUCTURE.turbulenceOffset.toFixed(3)} * grow * sigma * contrailFbm(q + vec2(9.2, 3.7));

    // Crow : longueur d'onde proportionnelle a l'ecartement des tourbillons.
    float wavelength = ${CONTRAIL_STRUCTURE.crowWavelengthPerSpacing.toFixed(2)} * 2.0 * plumes.y;
    float crow = smoothstep(${CONTRAIL_STRUCTURE.crowOnsetS.toFixed(1)}, ${CONTRAIL_STRUCTURE.crowFullS.toFixed(1)}, age) * ${CONTRAIL_STRUCTURE.crowDepth.toFixed(3)};
    // Sous une vingtaine de pixels par longueur d'onde, des bouffees se lisent
    // comme un pointille : la moyenne d'un cosinus sur le pixel tend vers zero,
    // et c'est elle qu'on rend.
    crow *= 1.0 - smoothstep(wavelength * 0.03, wavelength * 0.08, footprint);
    // La reconnexion ne se fait pas au metre pres : phase et profondeur derivent.
    float phase = 6.2831853 * along / wavelength + 5.0 * contrailNoise(vec2(along / (2.0 * wavelength), age / 300.0));
    crow *= 0.55 + 0.45 * contrailNoise(vec2(along / wavelength + 31.0, age / 200.0));
    // L'ondulation de Crow deplace aussi l'axe, en quadrature avec le pincement.
    offset += 0.35 * crow * sigma * sin(phase);
    k *= 1.0 + crow * cos(phase);

    // Un panache par reacteur, enroule par le tourbillon de son cote, puis
    // fusionne avec l'autre sur l'axe — voir plumePositionsM.
    float merged = contrailSmooth((age - ${CONTRAIL_STRUCTURE.vortexMergeFrom.toFixed(2)} * wake.y) /
                                  (${(CONTRAIL_STRUCTURE.vortexMergeTo - CONTRAIL_STRUCTURE.vortexMergeFrom).toFixed(2)} * wake.y));
    float rolled = contrailSmooth(age / ${CONTRAIL_STRUCTURE.rollupS.toFixed(1)});
    // Largeur de chaque panache : celle du jet, puis celle du sillage.
    float jet = sqrt(${(CONTRAIL_STRUCTURE.jetSigmaM ** 2).toFixed(2)} + ${(2 * CONTRAIL_STRUCTURE.jetDiffusivityM2S).toFixed(2)} * max(0.0, age));
    float plumeSigma = mix(jet, sigma, merged) * widthScale;
    float b = miss - offset;
    float inv = 1.0 / (2.0 * plumeSigma * plumeSigma);
    float sum = 0.0;
    for (int i = 0; i < ${MAX_PLUMES}; i++) {
      if (float(i) >= plumes.x) break;
      float y = engines[i];
      float vortex = sign(y) * plumes.y;
      float at = mix(y, vortex, rolled) * (1.0 - merged);
      sum += exp(-(b - at) * (b - at) * inv);
    }
    float norm = k / (2.5066282746 * plumeSigma * max(0.05, abs(sinAngle)));
    return norm * sum / max(1.0, plumes.x);
  }
`
