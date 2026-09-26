/**
 * Nappes nuageuses — de la colonne d'un modele meteo a une couche optique.
 *
 * Un modele comme ICON donne, a chaque point de grille et chaque niveau de
 * pression, une **fraction nuageuse** ; et par etage (bas, moyen, haut) la
 * couverture totale, recouvrements compris. Il ne donne pas la forme des
 * nuages : a 7 km de maille, un cumulus est sous-maille. Ce module tire de la
 * colonne ce qu'elle contient reellement — ou, a quelle altitude, sur quelle
 * epaisseur, combien — et en fait une couche que le rendu sait eclairer.
 *
 * ## Les etages
 *
 * Ceux d'Open-Meteo, qui suivent la convention OMM en altitude : bas sous
 * 3 km, moyen de 3 a 8 km, haut au-dessus. La base et le sommet d'une nappe
 * sont les niveaux de l'etage ou la fraction nuageuse depasse la moitie de son
 * maximum, etendus d'un demi-intervalle vers les niveaux voisins : la
 * resolution verticale est celle des niveaux archives, pas mieux.
 *
 * ## L'epaisseur optique
 *
 * `τ = σ_ext · e`, avec `σ_ext = 3W/(2ρr_e)` (voir `microphysics.ts`). Le
 * contenu en eau `W` n'est pas archive par Open-Meteo : il est pris dans la
 * climatologie, et c'est la principale incertitude du module.
 *
 * - **Eau liquide** (etages bas et moyen, au-dessus de −20 °C) : 0,2 g/m³ et
 *   8 µm en bas — stratus et stratocumulus continentaux, dont les mesures en
 *   avion donnent 0,1 a 0,4 g/m³ ; 0,1 g/m³ et 10 µm pour l'etage moyen.
 *   Incertitude d'un facteur deux sur τ.
 * - **Glace** (sous −20 °C) : la parametrisation de Liou (1992),
 *   `ln W = −7,6 + 4·exp(−2,443·10⁻⁴ (|T| − 20)^2,455)`, W en g/m³, ajustee sur
 *   des mesures in situ de cirrus entre −20 et −60 °C, et 30 µm de rayon
 *   effectif.
 *
 * Un stratus de 300 m en sort a τ ≈ 11, un cirrus de 1,5 km a −40 °C a
 * τ ≈ 0,6 : dans les fourchettes que restituent les satellites.
 *
 * ## L'eclairage : Eddington, puis diffusion simple
 *
 * Une nappe epaisse de plusieurs libres parcours se traite en **deux flux**.
 * Pour une couche non absorbante d'epaisseur τ et de facteur d'asymetrie g,
 * eclairee sous l'angle `μ₀`, l'approximation d'Eddington donne la reflectance
 * (Joseph, Wiscombe & Weinman 1976 ; Lacis & Hansen 1974) :
 *
 *     R(μ₀) = [(1−g)τ + (2/3 − μ₀)(1 − e^(−τ/μ₀))] / [4/3 + (1−g)τ]
 *
 * et, par conservation, une transmission diffuse `1 − R − e^(−τ/μ₀)`. La
 * lumiere qui ressort est supposee lambertienne — c'est exact a quelques pour
 * cent pour τ > 5, la ou un stratus paraît uniformement gris.
 *
 * Pour un voile mince, c'est l'inverse : la lumiere a diffuse une fois, et la
 * **fonction de phase** fait tout — l'aureole blanche autour du Soleil derriere
 * un cirrus. Ce premier ordre est calcule exactement, avec la vraie phase ; il
 * est retire de la part diffuse pour ne pas etre compte deux fois.
 *
 * ## La structure sous-maille
 *
 * La couverture `C` d'une maille est une fraction : un champ aleatoire `n`
 * decide *ou* dans la maille, avec un seuil tel que la fraction couverte vaille
 * `C` en esperance. `n` est une somme d'octaves de bruit ; quand les plus fines
 * tombent sous le pixel, elles sont retirees, et leur variance est rendue sous
 * forme de flou : la couverture attendue d'un pixel reste `C`, que le pixel
 * resolve la structure ou non. C'est le meme principe que le filtrage des
 * bourrelets de trainee.
 */
import { extinctionCoefficient } from './microphysics'

export type CloudStage = 'bas' | 'moyen' | 'haut'
export const CLOUD_STAGES: readonly CloudStage[] = ['bas', 'moyen', 'haut']

/** Bornes des etages, m au-dessus du niveau de la mer — convention Open-Meteo. */
export const STAGE_ALTITUDE_M: Record<CloudStage, [number, number]> = {
  bas: [-Infinity, 3000],
  moyen: [3000, 8000],
  haut: [8000, Infinity],
}

/** Contenu en eau liquide climatologique, kg/m³, et rayon effectif, m. */
const LIQUID: Record<CloudStage, { contentKgM3: number; radiusM: number }> = {
  bas: { contentKgM3: 0.2e-3, radiusM: 8e-6 },
  moyen: { contentKgM3: 0.1e-3, radiusM: 10e-6 },
  haut: { contentKgM3: 0.1e-3, radiusM: 10e-6 },
}
/** Rayon effectif des cristaux de cirrus, m. */
const ICE_RADIUS_M = 30e-6
/** En deca, la glace l'emporte : le seuil de −20 °C de Liou. */
const ICE_BELOW_C = -20

/** Facteurs d'asymetrie : gouttes (Mie, ~10 µm, visible) et cristaux rugueux. */
export const WATER_ASYMMETRY = 0.86
export const ICE_ASYMMETRY = 0.776

/**
 * Contenu en glace d'un cirrus a la temperature `temperatureC`, kg/m³ — Liou
 * (1992). Borne a son domaine d'ajustement, −60 a −20 °C.
 */
export function liouIceContentKgM3(temperatureC: number): number {
  const t = Math.min(60, Math.max(20, Math.abs(Math.min(temperatureC, -20))))
  const gM3 = Math.exp(-7.6 + 4 * Math.exp(-2.443e-4 * Math.pow(t - 20, 2.455)))
  return gM3 * 1e-3
}

/** Un niveau de la colonne du modele. */
export interface ColumnLevel {
  /** Altitude geopotentielle, m. */
  heightM: number
  /** Fraction nuageuse du niveau, [0, 1]. */
  cloudFraction: number
  temperatureC: number
}

/** Une nappe, telle que le rendu la consomme. */
export interface CloudSlab {
  /** Couverture de l'etage, [0, 1]. */
  coverage: number
  baseM: number
  topM: number
  /** Epaisseur optique verticale dans le nuage (pas moyennee sur la maille). */
  opticalDepth: number
  /** Glace plutot qu'eau : pilote la phase et l'asymetrie. */
  ice: boolean
}

/**
 * La nappe d'un etage dans une colonne. `coverage` vient du modele (couverture
 * de l'etage, recouvrements compris) ; la colonne donne la geometrie.
 * `groundM` borne la base : un brouillard touche le sol, il ne passe pas dessous.
 */
export function stageSlab(stage: CloudStage, coverage: number, column: readonly ColumnLevel[], groundM: number): CloudSlab {
  const [lo, hi] = STAGE_ALTITUDE_M[stage]
  const levels = [...column].sort((a, b) => a.heightM - b.heightM)
  const inStage = levels.map((l, i) => ({ l, i })).filter(({ l }) => l.heightM >= lo && l.heightM < hi && l.heightM > groundM)
  const peak = inStage.reduce((m, { l }) => Math.max(m, l.cloudFraction), 0)

  let baseM: number
  let topM: number
  let temperatureC: number
  if (inStage.length === 0) {
    // Etage absent de la colonne (sous le relief) : une nappe symbolique.
    baseM = Math.max(groundM, Number.isFinite(lo) ? lo : groundM)
    topM = baseM + 300
    temperatureC = 0
  } else if (peak < 0.05) {
    // Couverture sans niveau nuageux : nuage plus mince que l'espacement des
    // niveaux. On le centre sur le niveau le plus humide de l'etage, 300 m d'epaisseur.
    const mid = inStage[Math.floor(inStage.length / 2)].l
    baseM = mid.heightM - 150
    topM = mid.heightM + 150
    temperatureC = mid.temperatureC
  } else {
    const cloudy = inStage.filter(({ l }) => l.cloudFraction >= 0.5 * peak)
    const first = cloudy[0].i
    const last = cloudy[cloudy.length - 1].i
    const below = first > 0 ? levels[first - 1].heightM : groundM
    const above = last < levels.length - 1 ? levels[last + 1].heightM : levels[last].heightM + 500
    baseM = (levels[first].heightM + Math.max(groundM, below)) / 2
    topM = (levels[last].heightM + above) / 2
    // Temperature ponderee par la fraction nuageuse : celle ou est le nuage.
    let w = 0
    let tSum = 0
    for (const { l } of cloudy) {
      w += l.cloudFraction
      tSum += l.cloudFraction * l.temperatureC
    }
    temperatureC = tSum / w
  }
  baseM = Math.max(groundM, baseM)
  topM = Math.max(baseM + 50, topM)

  const ice = temperatureC < ICE_BELOW_C
  const extinction = ice
    ? extinctionCoefficient(liouIceContentKgM3(temperatureC), ICE_RADIUS_M, 'glace')
    : extinctionCoefficient(LIQUID[stage].contentKgM3, LIQUID[stage].radiusM, 'liquide')
  return { coverage: Math.min(1, Math.max(0, coverage)), baseM, topM, opticalDepth: extinction * (topM - baseM), ice }
}

/**
 * Reflectance et transmissions d'une couche non absorbante — Eddington.
 * `mu0` : cosinus de l'angle zenithal d'incidence, > 0.
 */
export function eddingtonSlab(opticalDepth: number, asymmetry: number, mu0: number) {
  const tau = Math.max(0, opticalDepth)
  const mu = Math.max(1e-3, mu0)
  const direct = Math.exp(-tau / mu)
  const scaled = (1 - asymmetry) * tau
  const reflectance = Math.max(0, (scaled + (2 / 3 - mu) * (1 - direct)) / (4 / 3 + scaled))
  const diffuseTransmittance = Math.max(0, 1 - reflectance - direct)
  return { reflectance, diffuseTransmittance, directTransmittance: direct }
}

// --- Bruit de structure ------------------------------------------------------

/** Nombre d'octaves du champ de structure. */
export const STRUCTURE_OCTAVES = 5
/** Poids des octaves : spectre en 1/f, comme les champs nuageux mesures a ces echelles. */
export const octaveWeight = (k: number): number => Math.pow(0.5, k)

/** Hachage d'un noeud du reseau, [0, 1) — le meme que le nuanceur, a la precision pres. */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return s - Math.floor(s)
}

/** Bruit de valeur, interpolation quintique, [0, 1]. */
export function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const a = hash2(ix, iy)
  const b = hash2(ix + 1, iy)
  const c = hash2(ix, iy + 1)
  const d = hash2(ix + 1, iy + 1)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

/** Champ de structure centre, somme des octaves (sans filtrage). */
export function structureField(x: number, y: number): number {
  let sum = 0
  let fx = x
  let fy = y
  for (let k = 0; k < STRUCTURE_OCTAVES; k++) {
    sum += octaveWeight(k) * (valueNoise(fx, fy) - 0.5)
    // Rotation d'environ 37° et facteur 2 : pas d'alignement entre octaves.
    const nx = 1.6 * fx - 1.2 * fy + 17.3
    const ny = 1.2 * fx + 1.6 * fy - 9.1
    fx = nx
    fy = ny
  }
  return sum
}

/**
 * Variance d'une octave de bruit de valeur. Un hachage uniforme sur [0, 1) a
 * une variance de 1/12 aux noeuds ; l'interpolation la reduit entre eux. La
 * valeur est mesuree par `cloudLayerSuite`, qui verifie cette constante.
 */
export const VALUE_NOISE_VARIANCE = 0.051

/** Ecart-type du champ complet. */
export const structureSigma = (): number => {
  let v = 0
  for (let k = 0; k < STRUCTURE_OCTAVES; k++) v += octaveWeight(k) ** 2
  return Math.sqrt(v * VALUE_NOISE_VARIANCE)
}

/** Fonction de repartition de la loi normale (Abramowitz & Stegun 7.1.26), erreur < 1,5·10⁻⁷. */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * z)
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z)
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

/** Quantile de la loi normale — approximation d'Acklam, erreur relative < 1,2·10⁻⁹ au centre. */
export function normalQuantile(p: number): number {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p))
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const low = 0.02425
  if (q < low) {
    const r = Math.sqrt(-2 * Math.log(q))
    return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1)
  }
  if (q > 1 - low) return -normalQuantile(1 - q)
  const r = q - 0.5
  const s = r * r
  return ((((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r) / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1)
}

/**
 * Couverture attendue d'un point : le nuage est la ou `n < θ`, avec
 * `θ = σ·Φ⁻¹(C)`. `resolved` est la part resolue du champ, `residualSigma`
 * l'ecart-type de ce qui ne l'est pas ; l'esperance vaut `Φ((θ − n)/σ_r)`.
 */
export function expectedCover(coverage: number, resolved: number, residualSigma: number): number {
  if (coverage <= 0) return 0
  if (coverage >= 1) return 1
  const theta = structureSigma() * normalQuantile(coverage)
  const s = Math.max(1e-4, residualSigma)
  return normalCdf((theta - resolved) / s)
}

/**
 * Le meme calcul pour le nuanceur. `cloudStructure` renvoie le champ resolu
 * et l'ecart-type residuel pour un pas de `footprint` unites de bruit par
 * pixel ; une octave dont la periode tombe sous deux pixels est retiree.
 */
export const CLOUD_LAYER_GLSL = /* glsl */ `
  float cloudHash(vec2 p) {
    return fract(sin(p.x * 127.1 + p.y * 311.7) * 43758.5453123);
  }
  float cloudValueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = p - i;
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = cloudHash(i);
    float b = cloudHash(i + vec2(1.0, 0.0));
    float c = cloudHash(i + vec2(0.0, 1.0));
    float d = cloudHash(i + vec2(1.0, 1.0));
    return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
  }
  /** x : champ resolu ; y : ecart-type residuel. */
  vec2 cloudStructure(vec2 p, float footprint) {
    float sum = 0.0;
    float residual = 0.0;
    float scale = 1.0;
    for (int k = 0; k < ${STRUCTURE_OCTAVES}; k++) {
      float w = pow(0.5, float(k));
      // Periode de l'octave en pixels : 1 / (footprint · scale).
      float keep = clamp(2.0 - 2.0 * footprint * scale, 0.0, 1.0);
      sum += keep * w * (cloudValueNoise(p) - 0.5);
      residual += (1.0 - keep * keep) * w * w;
      p = vec2(1.6 * p.x - 1.2 * p.y + 17.3, 1.2 * p.x + 1.6 * p.y - 9.1);
      scale *= 2.0;
    }
    return vec2(sum, sqrt(residual * ${VALUE_NOISE_VARIANCE.toFixed(5)}));
  }
  float cloudNormalCdf(float x) {
    float z = abs(x) * 0.70710678;
    float t = 1.0 / (1.0 + 0.3275911 * z);
    float erf = 1.0 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-z * z);
    return x >= 0.0 ? 0.5 * (1.0 + erf) : 0.5 * (1.0 - erf);
  }
  /** Quantile de la loi normale, approximation de Shore (1982), ±0,01 — sous la resolution de C. */
  float cloudNormalQuantile(float p) {
    float q = clamp(p, 1e-4, 1.0 - 1e-4);
    float a = max(q, 1.0 - q);
    float v = 5.5556 * (1.0 - pow((1.0 - a) / a, 0.1186));
    return q < 0.5 ? -v : v;
  }
  float cloudExpectedCover(float coverage, vec2 structure) {
    if (coverage <= 0.001) return 0.0;
    if (coverage >= 0.999) return 1.0;
    float theta = ${structureSigma().toFixed(5)} * cloudNormalQuantile(coverage);
    // Bord de nuage physiquement flou : jamais plus net qu'un vingtieme de l'ecart-type.
    float s = max(structure.y, ${(structureSigma() * 0.05).toFixed(5)});
    return cloudNormalCdf((theta - structure.x) / s);
  }
  /** Eddington, couche non absorbante : x reflectance, y transmission diffuse, z directe. */
  vec3 cloudEddington(float tau, float g, float mu0) {
    float mu = max(1e-3, mu0);
    float direct = exp(-tau / mu);
    float scaled = (1.0 - g) * tau;
    float r = max(0.0, (scaled + (0.6666667 - mu) * (1.0 - direct)) / (1.3333333 + scaled));
    return vec3(r, max(0.0, 1.0 - r - direct), direct);
  }
`
