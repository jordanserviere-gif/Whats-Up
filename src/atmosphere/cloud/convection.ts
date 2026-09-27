/**
 * Cumulus sous-maille — base, sommet et eau liquide d'un panache entraînant.
 *
 * Un modele de 2 a 7 km de maille ne resout pas un cumulus de beau temps : il
 * le **parametre**. Sa couverture apparait dans celle de l'etage bas, mais la
 * fraction nuageuse de ses niveaux de pression reste nulle. La colonne ne dit
 * donc rien de l'epaisseur du nuage — il faut la recalculer, et la physique la
 * fixe sans ambiguite.
 *
 * ## La methode
 *
 * Une parcelle d'air part du sol avec la temperature et le point de rosee a
 * 2 m. Elle monte ; sous sa base elle est portee par la couche melangee et ne
 * se melange pas. Au-dessus, elle **entraîne** l'air ambiant a un taux
 * `ε = 1,5·10⁻³ m⁻¹` — la valeur des simulations des grands tourbillons de
 * cumulus de beau temps (Siebesma & Cuijpers 1995 ; de Rooy et al. 2013,
 * fourchette 1 a 2·10⁻³). On suit les deux grandeurs conservees d'une
 * ascension sans precipitation :
 *
 *     s_l = c_p·T + g·z − L_v·q_l     (energie statique de l'eau liquide)
 *     q_t = q_v + q_l                 (eau totale)
 *
 * melangees lineairement avec l'environnement, puis l'ajustement a saturation
 * en tire T, q_v et q_l. La **base** est le niveau ou l'eau condense (niveau de
 * condensation) ; le **sommet**, celui ou la parcelle, alourdie par son
 * melange avec l'air sec d'au-dessus, cesse d'etre plus legere que lui — a
 * temperature virtuelle egale. Sous une inversion, la parcelle n'est jamais
 * flottante : poussee par les thermiques de la couche melangee, elle monte
 * jusqu'a ce que l'air sec entraîne ait evapore son eau — c'est le sommet des
 * cumulus brides. L'**eau liquide** moyenne en decoule : c'est
 * elle qui donne l'epaisseur optique, au lieu d'une climatologie.
 *
 * Ce modele est celui des schemas de convection des modeles meteo eux-memes ;
 * il est plus fidele pour les cumulus de beau temps que pour les congestus,
 * dont le sommet depend aussi de la dynamique de la cellule.
 */
import { saturationVapourPressureOverWater } from '../thermodynamics/waterVapour'

const G = 9.80665
const CP = 1004.7
const LV = 2.501e6
const RD = 287.05
const RV = 461.5
const EPS = RD / RV

/** Taux d'entraînement, m⁻¹. */
export const ENTRAINMENT_PER_M = 1.5e-3
/** Pas d'ascension, m. */
const STEP_M = 20

/** Humidite specifique a saturation, kg/kg. */
export function saturationSpecificHumidity(temperatureK: number, pressurePa: number): number {
  const es = saturationVapourPressureOverWater(temperatureK)
  return (EPS * es) / Math.max(1, pressurePa - (1 - EPS) * es)
}

/**
 * Ajustement a saturation : T et q_l a partir de s_l, q_t, z et p. Newton sur
 * `T − T_l − (L_v/c_p)(q_t − q_sat(T)) = 0`, avec `T_l = (s_l − g z)/c_p`.
 */
export function saturationAdjust(sl: number, qt: number, z: number, p: number): { temperatureK: number; liquid: number } {
  const tl = (sl - G * z) / CP
  if (qt <= saturationSpecificHumidity(tl, p)) return { temperatureK: tl, liquid: 0 }
  let t = tl
  for (let i = 0; i < 8; i++) {
    const qs = saturationSpecificHumidity(t, p)
    const f = t - tl - (LV / CP) * (qt - qs)
    const df = 1 + ((LV / CP) * qs * LV) / (RV * t * t)
    t -= f / df
  }
  return { temperatureK: t, liquid: Math.max(0, qt - saturationSpecificHumidity(t, p)) }
}

/** Un niveau de l'environnement. */
export interface EnvironmentLevel {
  heightM: number
  pressurePa: number
  temperatureK: number
  /** Humidite relative par rapport a l'eau, [0, 1]. */
  relativeHumidity: number
}

export interface Surface {
  groundM: number
  pressurePa: number
  temperatureK: number
  dewPointK: number
}

export interface ConvectiveCloud {
  baseM: number
  topM: number
  /** Eau liquide moyenne dans le nuage, kg/m³. */
  liquidKgM3: number
  /** La parcelle monte-t-elle librement, ou est-elle bridee sous une inversion ? */
  free: boolean
}

function environmentAt(levels: readonly EnvironmentLevel[], z: number) {
  let i = 0
  while (i < levels.length - 2 && z > levels[i + 1].heightM) i++
  const a = levels[i]
  const b = levels[i + 1]
  const f = Math.min(1.5, Math.max(-0.5, (z - a.heightM) / (b.heightM - a.heightM)))
  const t = a.temperatureK + (b.temperatureK - a.temperatureK) * f
  const p = Math.exp(Math.log(a.pressurePa) + (Math.log(b.pressurePa) - Math.log(a.pressurePa)) * f)
  const rh = Math.min(1, Math.max(0, a.relativeHumidity + (b.relativeHumidity - a.relativeHumidity) * f))
  return { t, p, q: rh * saturationSpecificHumidity(t, p) }
}

/** Au-dessus de ce gradient, K/m, l'air n'est plus une inversion : la couche bridante s'arrete. */
const CAP_END_LAPSE = 4.5e-3
/** Hauteur au-dessus de la base ou une parcelle doit etre devenue flottante pour etre libre, m. */
const FREE_WITHIN_M = 300

/**
 * Le cumulus que produit la surface, ou `null` si l'air de surface ne
 * condense pas sous `ceilingM`.
 *
 * - **Base** : niveau de condensation de la parcelle de surface, qui monte
 *   sans se melanger dans la couche melangee.
 * - **Cumulus libre** : si la parcelle devient flottante dans les 300 m qui
 *   suivent, elle monte en entraînant l'air ambiant jusqu'a ne plus l'etre,
 *   ou jusqu'a ce que son eau soit evaporee.
 * - **Cumulus bride** : sinon, les thermiques la poussent dans l'inversion
 *   sans qu'elle flotte jamais ; le nuage occupe la couche d'inversion, dont
 *   le sommet est au milieu de l'intervalle de niveaux ou le gradient
 *   redevient superieur a 4,5 K/km. C'est le cumulus humilis des apres-midi sous une subsidence.
 */
export function convectiveCloud(
  surface: Surface,
  column: readonly EnvironmentLevel[],
  ceilingM = 12_000,
  entrainment = ENTRAINMENT_PER_M,
): ConvectiveCloud | null {
  const levels = [...column].filter((l) => l.heightM > surface.groundM - 200).sort((a, b) => a.heightM - b.heightM)
  if (levels.length < 2) return null

  // --- Base : ascension sans melange jusqu'a condensation.
  let z = surface.groundM + 2
  const qt0 = saturationSpecificHumidity(surface.dewPointK, surface.pressurePa)
  const sl0 = CP * surface.temperatureK + G * z
  let base: number | null = null
  while (z < ceilingM) {
    z += STEP_M
    if (saturationAdjust(sl0, qt0, z, environmentAt(levels, z).p).liquid > 0) {
      base = z
      break
    }
  }
  if (base == null) return null

  // --- Au-dessus : panache entraînant.
  let sl = sl0
  let qt = qt0
  let liquidSum = 0
  let steps = 0
  let buoyant = false
  let free: number | null = null
  z = base
  while (z < ceilingM) {
    const env = environmentAt(levels, z)
    const slEnv = CP * env.t + G * z
    sl -= entrainment * STEP_M * (sl - slEnv)
    qt -= entrainment * STEP_M * (qt - env.q)
    const { temperatureK, liquid } = saturationAdjust(sl, qt, z, env.p)
    const tvParcel = temperatureK * (1 + 0.608 * (qt - liquid) - liquid)
    const tvEnv = env.t * (1 + 0.608 * env.q)
    if (tvParcel >= tvEnv) buoyant = true
    if (!buoyant && z - base > FREE_WITHIN_M) break
    // L'eau d'une parcelle a peine condensee s'evapore au premier melange : le
    // critere d'evaporation ne vaut qu'au-dessus de la base, dans le coeur sature.
    if (buoyant && (tvParcel < tvEnv || (liquid <= 0 && z - base > 100))) {
      free = z
      break
    }
    liquidSum += liquid * (env.p / (RD * env.t))
    steps++
    z += STEP_M
  }
  if (free != null && free - base >= 60) {
    return { baseM: base, topM: free, liquidKgM3: steps > 0 ? liquidSum / steps : 0, free: true }
  }

  // --- Bride : le nuage remplit l'inversion ; eau adiabatique, sans melange.
  let top = base + 150
  for (let i = 0; i < levels.length - 1; i++) {
    const a = levels[i]
    const b = levels[i + 1]
    if (b.heightM <= base) continue
    const lapse = (a.temperatureK - b.temperatureK) / (b.heightM - a.heightM)
    if (lapse > CAP_END_LAPSE) {
      // L'inversion finit quelque part entre ces deux niveaux archives : le
      // milieu de l'intervalle est l'estimation sans biais.
      top = Math.max(top, (a.heightM + b.heightM) / 2)
      break
    }
    top = Math.max(top, b.heightM)
  }
  top = Math.min(top, base + 1500)
  const mid = (base + top) / 2
  const env = environmentAt(levels, mid)
  const liquid = saturationAdjust(sl0, qt0, mid, env.p).liquid
  return { baseM: base, topM: top, liquidKgM3: liquid * (env.p / (RD * env.t)), free: false }
}
