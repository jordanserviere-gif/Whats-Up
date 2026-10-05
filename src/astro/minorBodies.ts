/**
 * Satellites et petits corps — propagation des donnees du JPL.
 *
 * Les donnees viennent de `scripts/build-minor-bodies.mjs` : voir son en-tete
 * pour la facon dont elles sont ajustees. Ce module ne fait que les relire.
 *
 * - **Satellites** : une orbite planetocentrique par annee, de 1990 a 2060,
 *   ajustee pour passer par la position vraie a ses deux bouts. Rend un vecteur
 *   planetocentrique, repere ICRF (J2000), en unites astronomiques. Hors de ces
 *   annees, l'orbite la plus proche est prolongee.
 * - **Petits corps** : table d'etats heliocentriques echelonnes de 1990 a 2070 ;
 *   entre deux etats, un mouvement keplerien de cent jours au plus.
 */
import DATA from './data/minorBodies.json'

/** Vecteur cartesien, repere ICRF. */
export type Vec3 = [number, number, number]

const KM_PER_AU = 149_597_870.7
const DEG = Math.PI / 180
/** k², GM du Soleil en ua³/jour². */
const GM_SUN = 2.9591220828559115e-4
/** Jour julien de J2000.0. */
export const J2000_JD = 2451545.0

/** Satellite irregulier : table d'etats planetocentriques (km, km/jour), comme les asteroides. */
interface MoonTable {
  id: string
  parent: string
  /** GM de la planete, km³/jour². */
  gm: number
  step: number
  states: number[][]
}

interface MoonElements {
  id: string
  parent: string
  /** Rotation des apsides, degres par jour. */
  omegaDot: number
  /** Debut de la premiere annee, JD TDB, et duree d'une annee, jours. */
  start: number
  step: number
  /** Par annee : a (km), e, p (3), q (3), anomalie moyenne au debut (deg), mouvement moyen (deg/jour). */
  epochs: number[][]
}

interface MinorTable {
  id: string
  name: string
  H: number
  G: number
  diameterKm: number | null
  step: number
  /** JD, x, y, z (ua), vx, vy, vz (ua/jour). */
  states: number[][]
}

const MOONS = new Map(
  (DATA.moons as Array<MoonElements | MoonTable>).filter((m): m is MoonElements => 'epochs' in m).map((m) => [m.id, m]),
)
const MOON_TABLES = new Map(
  (DATA.moons as Array<MoonElements | MoonTable>).filter((m): m is MoonTable => 'states' in m).map((m) => [m.id, m]),
)
const MINOR = new Map((DATA.minor as MinorTable[]).map((m) => [m.id, m]))

export const hasMoonElements = (id: string): boolean => MOONS.has(id) || MOON_TABLES.has(id)
export const minorTable = (id: string): MinorTable | undefined => MINOR.get(id)

/** Equation de Kepler, Newton. */
function eccentricAnomaly(M: number, e: number): number {
  let E = e < 0.8 ? M : Math.PI
  for (let i = 0; i < 50; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
    E -= d
    if (Math.abs(d) < 1e-13) break
  }
  return E
}

/**
 * Position planetocentrique d'un satellite, ua, repere ICRF.
 *
 * `jd` est l'instant **d'emission** — la lumiere met plus d'une heure a venir
 * de Saturne : c'est a l'appelant d'en tenir compte.
 */
export function moonOffset(id: string, jd: number): Vec3 {
  const table = MOON_TABLES.get(id)
  if (table) {
    const p = stateAt(table.states, table.step, jd, table.gm)
    return [p[0] / KM_PER_AU, p[1] / KM_PER_AU, p[2] / KM_PER_AU]
  }
  const m = MOONS.get(id)
  if (!m) return [0, 0, 0]
  const k = Math.max(0, Math.min(m.epochs.length - 1, Math.floor((jd - m.start) / m.step)))
  const [a, e, px, py, pz, qx, qy, qz, M0, n] = m.epochs[k]
  const dt = jd - (m.start + k * m.step)
  const w = m.omegaDot * dt * DEG
  const M = (M0 + (n - m.omegaDot) * dt) * DEG
  const E = eccentricAnomaly(M - 2 * Math.PI * Math.floor(M / (2 * Math.PI)), e)
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2))
  const r = (a * (1 - e * Math.cos(E))) / KM_PER_AU
  const c = Math.cos(nu + w)
  const s = Math.sin(nu + w)
  return [r * (c * px + s * qx), r * (c * py + s * qy), r * (c * pz + s * qz)]
}

/**
 * Mouvement keplerien d'un etat sur `dt` jours, autour d'un corps de parametre
 * `GM_SUN` (ua, ua/jour, ua³/jour²) ou d'un autre, dans ses propres unites.
 *
 * Par les elements : l'orbite est toujours elliptique ici, et cent jours au plus
 * separent l'etat de l'instant voulu.
 */
function keplerStep(r0: Vec3, v0: Vec3, dt: number, GM_SUN: number): Vec3 {
  const rn = Math.hypot(...r0)
  const v2 = v0[0] ** 2 + v0[1] ** 2 + v0[2] ** 2
  const a = 1 / (2 / rn - v2 / GM_SUN)
  const h: Vec3 = [r0[1] * v0[2] - r0[2] * v0[1], r0[2] * v0[0] - r0[0] * v0[2], r0[0] * v0[1] - r0[1] * v0[0]]
  const rv = r0[0] * v0[0] + r0[1] * v0[1] + r0[2] * v0[2]
  // Vecteur excentricite.
  const ev: Vec3 = [
    (v0[1] * h[2] - v0[2] * h[1]) / GM_SUN - r0[0] / rn,
    (v0[2] * h[0] - v0[0] * h[2]) / GM_SUN - r0[1] / rn,
    (v0[0] * h[1] - v0[1] * h[0]) / GM_SUN - r0[2] / rn,
  ]
  const e = Math.hypot(...ev)
  const n = Math.sqrt(GM_SUN / a ** 3)
  const E0 = Math.atan2(rv / Math.sqrt(GM_SUN * a), 1 - rn / a)
  const M = E0 - e * Math.sin(E0) + n * dt
  const turns = Math.floor(M / (2 * Math.PI))
  const E = eccentricAnomaly(M - 2 * Math.PI * turns, e) + 2 * Math.PI * turns
  // Fonctions de Lagrange f et g, a partir de la variation d'anomalie excentrique.
  const dE = E - E0
  const f = 1 - (a / rn) * (1 - Math.cos(dE))
  const g = dt - (Math.sqrt(a ** 3 / GM_SUN) * (dE - Math.sin(dE)))
  return [f * r0[0] + g * v0[0], f * r0[1] + g * v0[1], f * r0[2] + g * v0[2]]
}

/** Position heliocentrique d'un petit corps, ua, repere ICRF. */
export function minorHelio(id: string, jd: number): Vec3 {
  const t = MINOR.get(id)
  if (!t) return [0, 0, 0]
  return stateAt(t.states, t.step, jd, GM_SUN)
}

/** L'etat de table le plus proche, prolonge en mouvement keplerien. */
function stateAt(states: number[][], step: number, jd: number, gm: number): Vec3 {
  const k = Math.max(0, Math.min(states.length - 1, Math.round((jd - states[0][0]) / step)))
  const s = states[k]
  return keplerStep([s[1], s[2], s[3]], [s[4], s[5], s[6]], jd - s[0], gm)
}

/**
 * Magnitude d'un asteroide dans le systeme H-G de l'UAI (1985) : la pente de
 * phase `G` rend la remontee d'eclat pres de l'opposition.
 */
export function hgMagnitude(H: number, G: number, r: number, delta: number, phaseRad: number): number {
  const t = Math.tan(phaseRad / 2)
  const phi1 = Math.exp(-3.33 * t ** 0.63)
  const phi2 = Math.exp(-1.87 * t ** 1.22)
  return H + 5 * Math.log10(r * delta) - 2.5 * Math.log10(Math.max(1e-6, (1 - G) * phi1 + G * phi2))
}
