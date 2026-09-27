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
