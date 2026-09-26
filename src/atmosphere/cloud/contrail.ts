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

/**
 * ## La structure fine
 *
 * Le tube analytique est lisse ; une trainee reelle ne l'est pas. Trois
 * phenomenes, tous fonction de l'age et de la position **dans la masse d'air**
 * — la distance parcourue par l'avion quand la glace a ete emise —, pour que
 * les irregularites restent en place pendant que l'avion avance :
 *
 * - **Deux panaches.** Chaque groupe de reacteurs emet le sien, ecartes d'une
 *   vingtaine de metres ; les tourbillons de bout d'aile les enroulent et les
 *   fusionnent en une vingtaine de secondes.
 * - **Des bords irreguliers.** La turbulence module la largeur et deplace
 *   l'axe, par un bruit a plusieurs octaves ; l'amplitude croit avec l'age.
 * - **L'instabilite de Crow.** Les deux tourbillons ondulent l'un vers l'autre
 *   a une longueur d'onde de 8,6 fois leur ecartement (Crow 1970) — environ
 *   240 m pour un long-courrier —, se reconnectent, et la trainee se pince en
 *   un chapelet de bouffees au bout d'une a deux minutes. La modulation est de
 *   **moyenne nulle** : elle deplace la glace le long de l'axe sans en creer.
 */
export const CONTRAIL_STRUCTURE = {
  /** Ecartement initial des deux panaches, m. */
  plumeSeparationM: 24,
  /**
   * Ecart-type initial de **chaque** panache, m. Un jet de reacteur fait
   * quelques metres a la sortie ; `initialSigmaM` decrit, lui, le sillage deja
   * fusionne. Sans cette distinction les deux panaches, plus larges que leur
   * ecartement, se confondaient des la formation.
   */
  plumeSigmaM: 5,
  /** Duree de leur fusion, s. */
  plumeMergeS: 20,
  /** Longueur d'onde de Crow, m. */
  crowWavelengthM: 240,
  /** Debut et fin du pincement, s ; profondeur maximale de la modulation. */
  crowOnsetS: 50,
  crowFullS: 150,
  crowDepth: 0.55,
  /** Echelle de la turbulence le long de l'axe, m, et amplitude relative. */
  turbulenceScaleM: 420,
  turbulenceWidth: 0.28,
  turbulenceOffset: 0.55,
} as const

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/** Ecartement des deux panaches a l'age `t`, m. */
export const plumeSeparationM = (ageS: number): number =>
  CONTRAIL_STRUCTURE.plumeSeparationM * (1 - smooth01(ageS / CONTRAIL_STRUCTURE.plumeMergeS))

/** Facteur de Crow sur l'extinction lineique, de moyenne 1 sur une longueur d'onde. */
export function crowModulation(ageS: number, alongM: number): number {
  const s = CONTRAIL_STRUCTURE
  const depth = s.crowDepth * smooth01((ageS - s.crowOnsetS) / (s.crowFullS - s.crowOnsetS))
  return 1 + depth * Math.cos((2 * Math.PI * alongM) / s.crowWavelengthM)
}

/**
 * Epaisseur optique d'une trainee a deux panaches : la somme de deux tubes de
 * moitie, ecartes de `plumeSeparationM`. Integree sur la section, elle rend la
 * meme extinction lineique que le tube unique — les panaches se partagent la
 * glace, ils ne la doublent pas.
 */
export function twinPlumeOpticalDepth(
  ageS: number,
  missDistanceM: number,
  sinAngle: number,
  p: ContrailParameters = DEFAULT_CONTRAIL,
): number {
  const half = plumeSeparationM(ageS) / 2
  const merged = smooth01(ageS / CONTRAIL_STRUCTURE.plumeMergeS)
  const plume = { ...p, initialSigmaM: CONTRAIL_STRUCTURE.plumeSigmaM + (p.initialSigmaM - CONTRAIL_STRUCTURE.plumeSigmaM) * merged }
  return 0.5 * (contrailOpticalDepth(ageS, missDistanceM - half, sinAngle, plume) + contrailOpticalDepth(ageS, missDistanceM + half, sinAngle, plume))
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
  float contrailStructuredDepth(float age, float miss, float sinAngle, vec4 params, float formation, float along, float footprint) {
    float sigma = contrailSigma(age, params);
    float grow = smoothstep(0.0, 90.0, age);
    vec2 q = vec2(along / ${CONTRAIL_STRUCTURE.turbulenceScaleM.toFixed(1)}, age / 240.0);
    // La turbulence elargit ou resserre la section, et deplace l'axe.
    // La turbulence aussi se filtre, plus doucement : ses octaves sont plus larges.
    grow *= 1.0 - smoothstep(${(CONTRAIL_STRUCTURE.turbulenceScaleM * 0.25).toFixed(1)}, ${(CONTRAIL_STRUCTURE.turbulenceScaleM).toFixed(1)}, footprint);
    float widthScale = 1.0 + ${CONTRAIL_STRUCTURE.turbulenceWidth.toFixed(3)} * grow * contrailFbm(q);
    float offset = ${CONTRAIL_STRUCTURE.turbulenceOffset.toFixed(3)} * grow * sigma * contrailFbm(q + vec2(9.2, 3.7));
    float wavelength = ${CONTRAIL_STRUCTURE.crowWavelengthM.toFixed(1)};
    float crow = smoothstep(${CONTRAIL_STRUCTURE.crowOnsetS.toFixed(1)}, ${CONTRAIL_STRUCTURE.crowFullS.toFixed(1)}, age) * ${CONTRAIL_STRUCTURE.crowDepth.toFixed(3)};
    // Filtrage : la moyenne d'un cosinus sur un pixel plus large qu'un quart
    // de longueur d'onde tend vers zero — c'est ce qu'on rend.
    // Le seuil est strict : sous une vingtaine de pixels par longueur d'onde,
    // des bouffees regulieres se lisent comme un pointille, pas comme un nuage.
    crow *= 1.0 - smoothstep(wavelength * 0.03, wavelength * 0.08, footprint);
    // Les tourbillons ne se reconnectent pas au metre pres : la phase derive
    // le long de l'axe, et les bouffees n'ont ni le meme espacement ni la
    // meme taille.
    float phase = 6.2831853 * along / wavelength + 5.0 * contrailNoise(vec2(along / (2.0 * wavelength), age / 300.0));
    crow *= 0.55 + 0.45 * contrailNoise(vec2(along / wavelength + 31.0, age / 200.0));
    float pinch = 1.0 + crow * cos(phase);
    // L'ondulation de Crow deplace aussi l'axe, en quadrature avec le pincement.
    offset += 0.35 * crow * sigma * sin(phase);
    float merged = smoothstep(0.0, ${CONTRAIL_STRUCTURE.plumeMergeS.toFixed(1)}, age);
    float sigma0 = mix(${CONTRAIL_STRUCTURE.plumeSigmaM.toFixed(1)}, params.x, merged);
    vec4 shaped = vec4(sigma0 * widthScale, params.y * widthScale * widthScale, params.z * pinch, params.w);
    float halfSep = ${CONTRAIL_STRUCTURE.plumeSeparationM.toFixed(1)} * (1.0 - merged) * 0.5;
    float b = miss - offset;
    return 0.5 * (contrailOpticalDepth(age, b - halfSep, sinAngle, shaped, formation)
                + contrailOpticalDepth(age, b + halfSep, sinAngle, shaped, formation));
  }
`
