import { DataTexture, DataUtils, HalfFloatType, LinearFilter, RGBAFormat, ClampToEdgeWrapping } from 'three'
import { CLOUD_STAGES, stageSlab, type CloudSlab, type CloudStage, type ColumnLevel } from '@/atmosphere/cloud/cloudLayer'
import { convectiveCloud, type EnvironmentLevel } from '@/atmosphere/cloud/convection'
import { centerIndex, scenarioValue, type ScenarioGrid, type WeatherScenario } from '@/data-sources/weatherScenario'

/**
 * Champ de nappes d'un scenario, a un instant — ce que le nuanceur lit.
 *
 * Pour chaque grille (lointaine, proche) une texture de `n × 3n` texels : les
 * trois etages empiles, du bas au haut, chacun dans l'ordre de la grille (nord
 * en haut, ouest a gauche). Canaux : couverture, base (m), sommet (m),
 * epaisseur optique — negative pour la glace, ce qui evite un quatrieme canal.
 *
 * Demi-flottants : filtrables lineairement partout, et precis a 8 m pres a
 * 13 km d'altitude, bien sous la resolution verticale des niveaux archives.
 *
 * Le temps est interpole entre les deux heures qui l'encadrent : le modele est
 * horaire, le ciel ne doit pas sauter d'une heure a l'autre.
 *
 * Tout ce calcul — dont un panache convectif par point et par heure — tourne
 * dans \`cloudWorker.ts\` : le fil principal ne fait que televerser le resultat.
 */

function column(s: WeatherScenario, g: ScenarioGrid, point: number, hour: number): ColumnLevel[] {
  const levels: ColumnLevel[] = []
  for (const p of s.levelsHPa) {
    const z = scenarioValue(s, g, `z${p}`, point, hour)
    const cc = scenarioValue(s, g, `cc${p}`, point, hour)
    const t = scenarioValue(s, g, `t${p}`, point, hour)
    if (z == null || cc == null || t == null) continue
    levels.push({ heightM: z, cloudFraction: cc / 100, temperatureC: t })
  }
  return levels
}

/** Table du Soleil vu d'un etage : hauteur locale de −10 a 90°, resserree pres de l'horizon. */
export const SUN_TABLE_WIDTH = 64
export const sunTableAltitude = (u: number) => -10 + 100 * u * u

const COVER_KEY = { bas: 'ccl', moyen: 'ccm', haut: 'cch' } as const

/** Le cumulus que produit la surface de ce point, a cette heure — voir \`convection.ts\`. */
function convectionAt(s: WeatherScenario, g: ScenarioGrid, point: number, hour: number) {
  const t2 = scenarioValue(s, g, 't2', point, hour)
  const td2 = scenarioValue(s, g, 'td2', point, hour)
  const ps = scenarioValue(s, g, 'ps', point, hour)
  if (t2 == null || td2 == null || ps == null) return null
  const env: EnvironmentLevel[] = []
  for (const p of s.levelsHPa) {
    const z = scenarioValue(s, g, `z${p}`, point, hour)
    const t = scenarioValue(s, g, `t${p}`, point, hour)
    const rh = scenarioValue(s, g, `rh${p}`, point, hour)
    if (z == null || t == null || rh == null) continue
    env.push({ heightM: z, pressurePa: p * 100, temperatureK: t + 273.15, relativeHumidity: rh / 100 })
  }
  return convectiveCloud(
    { groundM: g.points[point][2], pressurePa: ps * 100, temperatureK: t2 + 273.15, dewPointK: td2 + 273.15 },
    env,
  )
}

function slabsAt(s: WeatherScenario, g: ScenarioGrid, point: number, hour: number): CloudSlab[] {
  const levels = column(s, g, point, hour)
  const ground = g.points[point][2]
  const cover = (stage: CloudStage) => (scenarioValue(s, g, COVER_KEY[stage], point, hour) ?? 0) / 100
  const convective = cover('bas') > 0 ? convectionAt(s, g, point, hour) : null
  return CLOUD_STAGES.map((stage) => stageSlab(stage, cover(stage), levels, ground, stage === 'bas' ? convective : null))
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f

/** Nappes interpolees entre deux heures. La phase suit l'heure la plus proche. */
function slabsBetween(s: WeatherScenario, g: ScenarioGrid, point: number, h0: number, h1: number, f: number): CloudSlab[] {
  const a = slabsAt(s, g, point, h0)
  const b = slabsAt(s, g, point, h1)
  return a.map((x, k) => {
    const y = b[k]
    return {
      coverage: lerp(x.coverage, y.coverage, f),
      baseM: lerp(x.baseM, y.baseM, f),
      topM: lerp(x.topM, y.topM, f),
      opticalDepth: lerp(x.opticalDepth, y.opticalDepth, f),
      ice: f < 0.5 ? x.ice : y.ice,
    }
  })
}

/** Champ d'une grille, en demi-flottants — calcule hors du fil principal. */
function packField(s: WeatherScenario, g: ScenarioGrid, h0: number, h1: number, f: number): Uint16Array {
  const n = g.n
  const data = new Uint16Array(n * n * 3 * 4)
  for (let point = 0; point < n * n; point++) {
    const slabs = slabsBetween(s, g, point, h0, h1, f)
    const i = point % n
    const j = Math.floor(point / n)
    slabs.forEach((slab, k) => {
      // Ligne 0 de la texture = bas de l'image : le nord de chaque etage en haut de son bloc.
      const row = k * n + (n - 1 - j)
      const o = (row * n + i) * 4
      data[o] = DataUtils.toHalfFloat(slab.coverage)
      data[o + 1] = DataUtils.toHalfFloat(slab.baseM)
      data[o + 2] = DataUtils.toHalfFloat(slab.topM)
      data[o + 3] = DataUtils.toHalfFloat(slab.ice ? -slab.opticalDepth : slab.opticalDepth)
    })
  }
  return data
}

/** Texture d'une grille, reutilisee si elle existe deja. Fil principal uniquement. */
export function uploadField(texture: DataTexture | null, data: Uint16Array, n: number): DataTexture {
  if (texture) {
    ;(texture.image.data as unknown as Uint16Array).set(data)
    texture.needsUpdate = true
    return texture
  }
  const t = new DataTexture(data.slice(), n, n * 3, RGBAFormat, HalfFloatType)
  t.magFilter = LinearFilter
  t.minFilter = LinearFilter
  t.wrapS = ClampToEdgeWrapping
  t.wrapT = ClampToEdgeWrapping
  t.needsUpdate = true
  return t
}

/** Vent a l'altitude `heightM` a l'aplomb, m/s (est, nord). */
function windAt(s: WeatherScenario, hour: number, heightM: number): [number, number] {
  const g = s.grids.near
  const c = centerIndex(g)
  let best: number | null = null
  let bestGap = Infinity
  for (const p of s.levelsHPa) {
    const z = scenarioValue(s, g, `z${p}`, c, hour)
    if (z != null && Math.abs(z - heightM) < bestGap) {
      bestGap = Math.abs(z - heightM)
      best = p
    }
  }
  if (best == null) return [0, 0]
  const v = (scenarioValue(s, g, `ws${best}`, c, hour) ?? 0) / 3.6
  const dir = ((scenarioValue(s, g, `wd${best}`, c, hour) ?? 0) * Math.PI) / 180
  return [-v * Math.sin(dir), -v * Math.cos(dir)]
}

/** Heure fractionnaire du scenario a l'instant `timeMs`, bornee a la journee archivee. */
export function scenarioHour(s: WeatherScenario, timeMs: number): number {
  const start = Date.parse(`${s.times[0]}Z`)
  return Math.min(s.times.length - 1, Math.max(0, (timeMs - start) / 3_600_000))
}

/** Ce que le worker renvoie : les deux grilles et ce que l'eclairage doit connaitre. */
export interface CloudFieldData {
  timeMs: number
  n: number
  far: Uint16Array
  near: Uint16Array
  overhead: CloudSlab[]
  windMS: [number, number][]
}

export function computeCloudField(s: WeatherScenario, timeMs: number): CloudFieldData {
  const hour = scenarioHour(s, timeMs)
  const h0 = Math.floor(hour)
  const h1 = Math.min(s.times.length - 1, h0 + 1)
  const f = hour - h0
  const overhead = slabsBetween(s, s.grids.near, centerIndex(s.grids.near), h0, h1, f)
  return {
    timeMs,
    n: s.grids.far.n,
    far: packField(s, s.grids.far, h0, h1, f),
    near: packField(s, s.grids.near, h0, h1, f),
    overhead,
    windMS: overhead.map((slab) => windAt(s, Math.round(hour), (slab.baseM + slab.topM) / 2)),
  }
}
