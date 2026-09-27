/**
 * Surface de l'eau — reflexion, pentes, vagues.
 *
 * La methode est celle de Bruneton, Neyret & Holzschuch (2010), « Real-time
 * Realistic Ocean Lighting using Seamless Transitions from Geometry to BRDF » :
 * l'ocean est une somme de trains de vagues tires d'un spectre, et chaque
 * train, selon sa longueur d'onde rapportee au pixel, est rendu soit en
 * normales (resolu), soit en dispersion statistique des pentes (non resolu).
 * La **variance totale des pentes est conservee** d'une representation a
 * l'autre : ce qu'on retire des normales passe dans la statistique. D'ou
 * l'absence de rupture entre l'eau vue de pres et l'eau vue de tres loin, en
 * visee rasante.
 *
 * - **Fresnel** : dielectrique exact, non polarise, eau a n = 1,333.
 * - **Statistique des pentes** : Cox & Munk (1954), mesures photographiques du
 *   reflet solaire au large d'Hawai'i. Variance totale de la pente d'une mer
 *   propre : σ² = 0,003 + 5,12·10⁻³ U, U vent a 12,5 m en m/s.
 * - **Spectre** : JONSWAP (Hasselmann et al. 1973) dans la forme de Goda, qui le
 *   cale directement sur la hauteur significative Hs et la periode de pic Tp —
 *   les grandeurs qu'une prevision de vagues fournit.
 * - **Dispersion** en eau profonde : ω² = g k.
 */

const G = 9.80665

/** Indice de refraction de l'eau dans le visible. */
export const WATER_IOR = 1.333

/** Reflectance de Fresnel non polarisee d'un dielectrique, `cosI` cosinus d'incidence. */
export function fresnelDielectric(cosI: number, n = WATER_IOR): number {
  const c = Math.min(1, Math.max(0, cosI))
  const s2 = 1 - c * c
  const t2 = s2 / (n * n)
  if (t2 >= 1) return 1
  const ct = Math.sqrt(1 - t2)
  const rs = (c - n * ct) / (c + n * ct)
  const rp = (n * c - ct) / (n * c + ct)
  return 0.5 * (rs * rs + rp * rp)
}

/** Variance totale des pentes d'une mer propre, Cox & Munk (1954). */
export const coxMunkSlopeVariance = (windMS: number): number => 0.003 + 5.12e-3 * Math.max(0, windMS)

/**
 * Densite spectrale JONSWAP de Goda, m²/Hz, a la frequence `f` (Hz), pour une
 * hauteur significative `hs` (m) et une periode de pic `tp` (s).
 */
export function jonswap(f: number, hs: number, tp: number, gamma = 3.3): number {
  if (f <= 0 || hs <= 0 || tp <= 0) return 0
  // Forme sans dimension en x = f·Tp, normalisee **exactement** : la constante
  // approchee de Goda surestime l'energie de 7 %, et Hs est une definition —
  // 4 fois l'ecart-type de l'elevation — qu'on ne doit pas trahir.
  return ((hs * hs) / 16) * tp * (jonswapShape(f * tp, gamma) / jonswapNorm(gamma))
}

function jonswapShape(x: number, gamma: number): number {
  if (x <= 0) return 0
  const sigma = x <= 1 ? 0.07 : 0.09
  const r = Math.exp(-((x - 1) ** 2) / (2 * sigma * sigma))
  return x ** -5 * Math.exp(-1.25 * x ** -4) * gamma ** r
}

const norms = new Map<number, number>()
function jonswapNorm(gamma: number): number {
  let n = norms.get(gamma)
  if (n === undefined) {
    n = 0
    const steps = 20000
    for (let i = 0; i < steps; i++) {
      const x = 0.2 + ((i + 0.5) / steps) * 11.8
      n += jonswapShape(x, gamma) * (11.8 / steps)
    }
    norms.set(gamma, n)
  }
  return n
}

/**
 * Mer du vent pleinement levee (Pierson & Moskowitz 1964), quand aucune
 * prevision de vagues n'est disponible : Hs ≈ 0,21 U²/g, Tp = 2π U / (0,877 g).
 */
export function fullyDevelopedSea(windMS: number): { hs: number; tp: number } {
  const u = Math.max(0.5, windMS)
  return { hs: (0.21 * u * u) / G, tp: (2 * Math.PI * u) / (0.877 * G) }
}

/**
 * Mer du vent limitee par le fetch (JONSWAP, relations de Hasselmann 1973) :
 * sur un lac, le vent n'a que la largeur du plan d'eau pour lever les vagues.
 */
export function fetchLimitedSea(windMS: number, fetchM: number): { hs: number; tp: number } {
  const u = Math.max(0.5, windMS)
  const x = (G * fetchM) / (u * u)
  const developed = fullyDevelopedSea(u)
  return {
    hs: Math.min(developed.hs, (0.0016 * u * u * Math.sqrt(x)) / G),
    // Frequence de pic sans dimension : f_p U / g = 3,5 (g F / U²)^−0,33.
    tp: Math.min(developed.tp, (u * x ** 0.33) / (3.5 * G)),
  }
}

/** Un train de vagues : direction de propagation (est, nord), nombre d'onde, amplitude, pulsation, phase. */
export interface Wave {
  dirEast: number
  dirNorth: number
  k: number
  amplitude: number
  omega: number
  phase: number
}

/** Generateur pseudo-aleatoire deterministe (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SeaComponent {
  hs: number
  tp: number
  /** Direction de propagation, degres (vers ou vont les vagues), depuis le nord. */
  towardDeg: number
  /** Etalement angulaire : cos^(2s) autour de la direction moyenne. */
  spreading: number
  gamma?: number
}

/**
 * Trains de vagues tires d'un spectre directionnel. Les frequences sont
 * reparties en logarithme de 0,7 a 8 fois la frequence de pic ; chaque bande
 * recoit l'energie `S(f) Δf` du spectre, et une direction tiree selon
 * l'etalement. L'amplitude vaut `√(2 S(f) Δf)`, ce qui conserve la variance
 * de l'elevation, Hs²/16.
 */
export function waveTrains(component: SeaComponent, count: number, seed: number): Wave[] {
  const rand = random(seed)
  const fp = 1 / component.tp
  const f0 = 0.7 * fp
  const f1 = 8 * fp
  const waves: Wave[] = []
  for (let i = 0; i < count; i++) {
    const a = Math.log(f0) + ((i + 0.5) / count) * (Math.log(f1) - Math.log(f0))
    const f = Math.exp(a)
    const df = f * ((Math.log(f1) - Math.log(f0)) / count)
    const amplitude = Math.sqrt(2 * jonswap(f, component.hs, component.tp, component.gamma) * df)
    // Direction : tirage par rejet dans cos^(2s), sur ±90°.
    let theta = 0
    for (let tries = 0; tries < 32; tries++) {
      const t = (rand() - 0.5) * Math.PI
      if (rand() <= Math.cos(t) ** (2 * component.spreading)) {
        theta = t
        break
      }
    }
    const dir = (component.towardDeg * Math.PI) / 180 + theta
    const omega = 2 * Math.PI * f
    waves.push({ dirEast: Math.sin(dir), dirNorth: Math.cos(dir), k: (omega * omega) / G, amplitude, omega, phase: rand() * 2 * Math.PI })
  }
  return waves
}

/** Variance des pentes portee par des trains de vagues : Σ a² k² / 2. */
export const slopeVarianceOf = (waves: readonly Wave[]): number => waves.reduce((s, w) => s + (w.amplitude * w.amplitude * w.k * w.k) / 2, 0)

/** Nombre de trains par surface d'eau — voir `WATER_GLSL`. */
export const OCEAN_WAVES = 24
export const LAKE_WAVES = 12
/** Fetch retenu pour un lac, m : l'ordre de grandeur des lacs gardes par le masque. */
export const LAKE_FETCH_M = 5_000

/** Reflectance de teledetection de l'eau, sr⁻¹, RGB lineaire — la lumiere qui ressort de l'eau. */
export const OCEAN_RRS: [number, number, number] = [0.0004, 0.0022, 0.0060]
export const LAKE_RRS: [number, number, number] = [0.0020, 0.0055, 0.0040]

// --- Spectre en nombre d'onde, pour la transformee de Fourier -----------------

/** Taille des grilles de Fourier. */
export const FFT_SIZE = 256

/**
 * Cascades : trois domaines emboites pour la mer (500, 50 et 5 m), deux pour
 * un lac. Chacune ne porte que sa bande de nombres d'onde — de sa plus grande
 * longueur d'onde a celle ou commence la suivante — pour qu'aucune vague ne
 * soit comptee deux fois ; ensemble, elles couvrent de la houle a quatre
 * centimetres. Plusieurs domaines de tailles premieres entre elles, c'est aussi
 * ce qui empeche de voir la texture se repeter.
 */
export interface Cascade {
  sizeM: number
  kMin: number
  kMax: number
}
function cascadesFor(sizes: number[]): Cascade[] {
  return sizes.map((sizeM, i) => ({
    sizeM,
    kMin: i === 0 ? (2 * Math.PI) / sizeM : (Math.PI * FFT_SIZE) / sizes[i - 1],
    kMax: (Math.PI * FFT_SIZE) / sizeM,
  }))
}
export const OCEAN_CASCADES = cascadesFor([497, 53, 5.3])
export const LAKE_CASCADES = cascadesFor([53, 5.3])

/** Etalement directionnel de Longuet-Higgins, cos^(2s)(Δθ/2), normalise sur le cercle. */
function spreading(dTheta: number, s: number): number {
  const norm = spreadNorm(s)
  return Math.abs(Math.cos(dTheta / 2)) ** (2 * s) / norm
}
const spreadNorms = new Map<number, number>()
function spreadNorm(s: number): number {
  let n = spreadNorms.get(s)
  if (n === undefined) {
    n = 0
    const steps = 2000
    for (let i = 0; i < steps; i++) n += Math.abs(Math.cos((-Math.PI + ((i + 0.5) / steps) * 2 * Math.PI) / 2)) ** (2 * s) * ((2 * Math.PI) / steps)
    spreadNorms.set(s, n)
  }
  return n
}

/**
 * Densite spectrale directionnelle en nombre d'onde, m⁴, d'une composante
 * (mer du vent ou houle) : S(k, θ) = S(f) · df/dk / k · D(θ), avec la
 * dispersion en eau profonde f = √(g k) / 2π.
 */
export function directionalSpectrumK(kx: number, ky: number, c: SeaComponent): number {
  const k = Math.hypot(kx, ky)
  if (k <= 0) return 0
  const f = Math.sqrt(G * k) / (2 * Math.PI)
  const dfdk = Math.sqrt(G / k) / (4 * Math.PI)
  // Direction de propagation du vecteur d'onde, depuis le nord vers l'est.
  const theta = Math.atan2(kx, ky)
  const toward = (c.towardDeg * Math.PI) / 180
  const d = theta - toward
  return (jonswap(f, c.hs, c.tp, c.gamma) * dfdk * spreading(Math.atan2(Math.sin(d), Math.cos(d)), c.spreading)) / k
}

/** Tirage gaussien deterministe (Box-Muller). */
function gaussian(rand: () => number): [number, number] {
  const u = Math.max(1e-12, rand())
  const v = rand()
  const r = Math.sqrt(-2 * Math.log(u))
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)]
}

/**
 * Amplitudes initiales de Tessendorf pour une cascade : par texel (indice
 * d'onde ramene en [0, N)), h0(k) et conj(h0(−k)), RGBA flottants. Variance
 * par onde : E|h0|² = S(k) Δk² / 2, de sorte que la variance de l'elevation
 * reconstituee vaille l'integrale du spectre sur la bande.
 *
 * Rend aussi la variance de l'elevation et celle des pentes portees par la
 * cascade : c'est elle qu'on retranche de Cox & Munk pour la part que les
 * cascades ne portent pas.
 */
export function cascadeSpectrum(
  cascade: Cascade,
  components: SeaComponent[],
  seed: number,
): { h0: Float32Array; heightVariance: number; slopeVariance: number } {
  const N = FFT_SIZE
  const dk = (2 * Math.PI) / cascade.sizeM
  const rand = random(seed)
  const amp = new Float32Array(N * N * 2)
  let heightVariance = 0
  let slopeVariance = 0
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const n = i < N / 2 ? i : i - N
      const m = j < N / 2 ? j : j - N
      const kx = n * dk
      const ky = m * dk
      const k = Math.hypot(kx, ky)
      const [g1, g2] = gaussian(rand)
      if (k < cascade.kMin || k >= cascade.kMax) continue
      let s = 0
      for (const c of components) s += directionalSpectrumK(kx, ky, c)
      const a = Math.sqrt((s * dk * dk) / 2)
      // (g1 + i g2)/√2 a pour variance 1 : E|h0|² = a² = S Δk² / 2.
      amp[(j * N + i) * 2] = (g1 / Math.SQRT2) * a
      amp[(j * N + i) * 2 + 1] = (g2 / Math.SQRT2) * a
      heightVariance += s * dk * dk
      slopeVariance += s * dk * dk * k * k
    }
  // h0(k) et conj(h0(−k)) cote a cote : le nuanceur n'a qu'une lecture a faire.
  const h0 = new Float32Array(N * N * 4)
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const o = (j * N + i) * 4
      const mi = (N - i) % N
      const mj = (N - j) % N
      h0[o] = amp[(j * N + i) * 2]
      h0[o + 1] = amp[(j * N + i) * 2 + 1]
      h0[o + 2] = amp[(mj * N + mi) * 2]
      h0[o + 3] = -amp[(mj * N + mi) * 2 + 1]
    }
  return { h0, heightVariance, slopeVariance }
}
