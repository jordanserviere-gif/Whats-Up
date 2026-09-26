/**
 * Scenarios meteo — des journees reelles figees dans le depot.
 *
 * Fabriques par `scripts/build-weather-scenario.mjs` a partir des sorties
 * archivees d'ICON, avec l'image satellite du meme jour a cote pour verifier.
 * En mode scenario, l'air en altitude ne vient plus de l'API en direct mais du
 * fichier : le rendu devient deterministe, hors ligne, et l'on sait que ce
 * qu'on regarde a existe.
 *
 * Deux grilles de 9 × 9 points : `far` (100 km, jusqu'a l'horizon) et `near`
 * (6 km, autour de l'observateur). Champs quantifies en entiers, stockes
 * `[champ][point][heure]` ; `quantization` donne le pas de chaque cle.
 */
import type { UpperAirForecast, UpperAirLevel } from './upperAir'

export interface WeatherScenarioEntry {
  id: string
  title: string
  date: string
  latitude: number
  longitude: number
}

export interface ScenarioGrid {
  n: number
  spacingKm: number
  /** [latitude, longitude, altitude du modele en m] par point, du nord-ouest au sud-est. */
  points: [number, number, number][]
  fields: Record<string, (number | null)[][]>
}

export interface WeatherScenario extends WeatherScenarioEntry {
  location: { latitude: number; longitude: number }
  source: string
  times: string[]
  levelsHPa: number[]
  quantization: Record<string, number>
  grids: { far: ScenarioGrid; near: ScenarioGrid }
  reference: { file: string; layer: string; bbox: string; note: string } | null
}

const BASE = `${import.meta.env.BASE_URL}scenarios/`

let index: Promise<WeatherScenarioEntry[]> | null = null
const scenarios = new Map<string, Promise<WeatherScenario>>()

export function fetchScenarioIndex(): Promise<WeatherScenarioEntry[]> {
  index ??= fetch(`${BASE}index.json`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
  return index
}

export function loadScenario(id: string): Promise<WeatherScenario> {
  let hit = scenarios.get(id)
  if (!hit) {
    hit = fetch(`${BASE}${id}.json`).then((r) => {
      if (!r.ok) throw new Error(`scenario ${id}: ${r.status}`)
      return r.json() as Promise<WeatherScenario>
    })
    scenarios.set(id, hit)
  }
  return hit
}

/** Point central d'une grille : l'observateur. */
export const centerIndex = (g: ScenarioGrid): number => (g.points.length - 1) / 2

/** Valeur physique d'un champ, ou `null` si le modele n'en donne pas. */
export function scenarioValue(s: WeatherScenario, grid: ScenarioGrid, key: string, point: number, hour: number): number | null {
  const raw = grid.fields[key]?.[point]?.[hour]
  // Les cles de niveau portent la pression (`t300`) ; celles de surface sont nues (`td2`).
  const step = s.quantization[key] ?? s.quantization[key.replace(/\d+$/, '')] ?? 1
  return raw == null ? null : raw * step
}

/**
 * Profil vertical au-dessus de l'observateur, heure par heure — au format de
 * l'air en altitude en direct, pour que les trainees le lisent sans le savoir.
 * Tous les niveaux archives, de 1000 a 150 hPa.
 */
export function scenarioUpperAir(s: WeatherScenario): UpperAirForecast {
  const g = s.grids.near
  const c = centerIndex(g)
  const profiles = s.times.map((iso, h) => {
    const levels: UpperAirLevel[] = []
    for (const p of s.levelsHPa) {
      const t = scenarioValue(s, g, `t${p}`, c, h)
      const rh = scenarioValue(s, g, `rh${p}`, c, h)
      const z = scenarioValue(s, g, `z${p}`, c, h)
      if (t == null || rh == null || z == null) continue
      // Vitesse en km/h, direction d'ou vient le vent : le vecteur pointe a l'oppose.
      const v = (scenarioValue(s, g, `ws${p}`, c, h) ?? 0) / 3.6
      const dir = ((scenarioValue(s, g, `wd${p}`, c, h) ?? 0) * Math.PI) / 180
      levels.push({
        pressurePa: p * 100,
        heightM: z,
        temperatureK: t + 273.15,
        relativeHumidityWater: rh / 100,
        windEastMS: -v * Math.sin(dir),
        windNorthMS: -v * Math.cos(dir),
      })
    }
    levels.sort((a, b) => a.heightM - b.heightM)
    return { timeMs: Date.parse(`${iso}Z`), levels }
  })
  return { profiles: profiles.filter((p) => p.levels.length >= 2) }
}
