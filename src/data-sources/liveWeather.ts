/**
 * Meteo en direct pour les nuages — la prevision ICON, au format d'un scenario.
 *
 * Le rendu ne sait pas d'ou vient sa donnee : un scenario archive
 * (`weatherScenario.ts`) et la prevision du jour ont la meme forme, deux
 * grilles centrees sur le lieu. On ne fabrique donc ici qu'un scenario de plus,
 * dont l'identifiant commence par `live:`.
 *
 * ## Economie d'appels
 *
 * Open-Meteo compte ses appels par lieu et par tranche de dix variables, avec
 * un plafond a la minute et a la journee. Trois regles :
 *
 * - **Rien tant que les nuages sont eteints.** Ce module n'est appele que par
 *   le calque des nuages.
 * - **Une requete donne 72 heures** (la veille, aujourd'hui, demain) : le
 *   curseur du temps les parcourt sans nouvel appel. Les modeles tournent
 *   toutes les trois heures ; au-dela, la donnee est rafraichie en silence,
 *   l'ancienne restant affichee.
 * - **Tout est garde dans le navigateur** (IndexedDB) : relancer l'appli dans
 *   les trois heures ne coute aucun appel.
 *
 * La grille proche (6 km) porte les quinze niveaux ; la lointaine (100 km),
 * qui ne sert qu'aux nappes jusqu'a l'horizon, neuf. Le vent n'est lu qu'a
 * l'aplomb, seul endroit ou il sert (la derive des structures). Les deux
 * grilles partent a une minute d'intervalle, pour tenir sous le plafond a la
 * minute : les nuages proches arrivent les premiers.
 */
import type { ScenarioGrid, WeatherScenario } from './weatherScenario'

const API = 'https://api.open-meteo.com/v1/forecast'
export const LIVE_PREFIX = 'live:'
/** Age au-dela duquel la prevision est rafraichie, ms. */
export const LIVE_MAX_AGE_MS = 3 * 3_600_000

const LEVELS_NEAR = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150]
const LEVELS_FAR = [1000, 925, 850, 700, 600, 500, 400, 300, 200]
/** Champ Open-Meteo → [cle compacte, facteur de quantification] — ceux des scenarios. */
const LEVEL_FIELDS: Record<string, [string, number]> = {
  temperature: ['t', 10],
  relative_humidity: ['rh', 1],
  cloud_cover: ['cc', 1],
  geopotential_height: ['z', 1],
}
const WIND_FIELDS: Record<string, [string, number]> = {
  wind_speed: ['ws', 10],
  wind_direction: ['wd', 1],
}
const SURFACE_FIELDS: Record<string, [string, number]> = {
  cloud_cover: ['cct', 1],
  cloud_cover_low: ['ccl', 1],
  cloud_cover_mid: ['ccm', 1],
  cloud_cover_high: ['cch', 1],
  temperature_2m: ['t2', 10],
  dew_point_2m: ['td2', 10],
  surface_pressure: ['ps', 10],
  cape: ['cape', 1],
  precipitation: ['rr', 10],
  weather_code: ['ww', 1],
}

const KM_PER_DEG_LAT = 111.195
const N = 9

function gridPoints(lat: number, lon: number, spacingKm: number): { lat: number; lon: number }[] {
  const out: { lat: number; lon: number }[] = []
  const half = (N - 1) / 2
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const la = lat + ((half - j) * spacingKm) / KM_PER_DEG_LAT
      const lo = lon + ((i - half) * spacingKm) / (KM_PER_DEG_LAT * Math.cos((la * Math.PI) / 180))
      out.push({ lat: Math.round(la * 1e4) / 1e4, lon: Math.round(lo * 1e4) / 1e4 })
    }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Hourly {
  time: string[]
  [key: string]: (number | null)[] | string[]
}

async function fetchPoints(points: { lat: number; lon: number }[], hourly: string[]): Promise<{ elevation: number; hourly: Hourly }[]> {
  const url =
    `${API}?latitude=${points.map((p) => p.lat).join(',')}&longitude=${points.map((p) => p.lon).join(',')}` +
    `&hourly=${hourly.join(',')}&models=icon_seamless&past_days=1&forecast_days=2&timezone=UTC`
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url)
    if (res.ok) {
      const body = await res.json()
      return Array.isArray(body) ? body : [body]
    }
    // Plafond a la minute : on patiente, sans rien bloquer.
    if (res.status === 429 && attempt < 3) {
      await sleep(65_000)
      continue
    }
    throw new Error(`Open-Meteo ${res.status}`)
  }
}

function fieldsFor(levels: number[], withWind: boolean): string[] {
  const perLevel = { ...LEVEL_FIELDS, ...(withWind ? WIND_FIELDS : {}) }
  return [...levels.flatMap((p) => Object.keys(perLevel).map((f) => `${f}_${p}hPa`)), ...Object.keys(SURFACE_FIELDS)]
}

/** Une grille au format des scenarios, a partir des reponses. */
function toGrid(spacingKm: number, points: { lat: number; lon: number }[], rows: { elevation: number; hourly: Hourly }[], levels: number[]): ScenarioGrid {
  const fields: Record<string, (number | null)[][]> = {}
  const put = (key: string, scale: number, values: (number | null)[] | undefined) => {
    fields[key] ??= []
    fields[key].push((values ?? []).map((v) => (v == null ? null : Math.round(v * scale))))
  }
  for (const r of rows) {
    for (const p of levels)
      for (const [f, [key, scale]] of Object.entries(LEVEL_FIELDS)) put(`${key}${p}`, scale, r.hourly[`${f}_${p}hPa`] as (number | null)[])
    for (const [f, [key, scale]] of Object.entries(SURFACE_FIELDS)) put(key, scale, r.hourly[f] as (number | null)[])
  }
  return {
    n: N,
    spacingKm,
    points: points.map((p, i) => [p.lat, p.lon, Math.round(rows[i]?.elevation ?? 0)]),
    fields,
  }
}

const QUANTIZATION = Object.fromEntries(
  [...Object.values(LEVEL_FIELDS), ...Object.values(WIND_FIELDS), ...Object.values(SURFACE_FIELDS)].map(([k, s]) => [k, 1 / s]),
)

// --- Stockage local -----------------------------------------------------------

const DB = 'whatsup-weather'
const STORE = 'live'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function dbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as T) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function dbPut(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // Stockage indisponible (navigation privee…) : on fonctionne sans cache.
  }
}

/** Cle d'un lieu : a 0,05° pres, la grille proche ne bouge pas visiblement. */
export const liveKey = (lat: number, lon: number) => `${LIVE_PREFIX}${lat.toFixed(2)}:${lon.toFixed(2)}`

export interface LiveRecord {
  scenario: WeatherScenario
  /** Instant du dernier telechargement, ms. */
  fetchedAt: number
  /** La grille lointaine est-elle deja la ? */
  complete: boolean
}

/** La prevision gardee pour ce lieu, ou `null`. Lisible depuis le worker. */
export function readLive(key: string): Promise<LiveRecord | null> {
  return dbGet<LiveRecord>(key)
}

/**
 * Telecharge la prevision du lieu et la garde. `onUpdate` est appele deux
 * fois : grille proche seule, puis les deux.
 */
export async function fetchLive(lat: number, lon: number, onUpdate: (record: LiveRecord) => void): Promise<void> {
  const key = liveKey(lat, lon)
  const near = gridPoints(lat, lon, 6)
  const far = gridPoints(lat, lon, 100)
  const center = near[(near.length - 1) / 2]

  const nearRows = await fetchPoints(near, fieldsFor(LEVELS_NEAR, false))
  const [centerRow] = await fetchPoints([center], LEVELS_NEAR.flatMap((p) => Object.keys(WIND_FIELDS).map((f) => `${f}_${p}hPa`)))
  const nearGrid = toGrid(6, near, nearRows, LEVELS_NEAR)
  // Vent : a l'aplomb seulement ; les autres points restent vides.
  const c = (N * N - 1) / 2
  for (const p of LEVELS_NEAR)
    for (const [f, [k, scale]] of Object.entries(WIND_FIELDS)) {
      const series = (centerRow.hourly[`${f}_${p}hPa`] as (number | null)[] | undefined) ?? []
      nearGrid.fields[`${k}${p}`] = Array.from({ length: N * N }, (_, i) =>
        i === c ? series.map((v) => (v == null ? null : Math.round(v * scale))) : [],
      )
    }
  const times = nearRows[0].hourly.time as string[]
  const scenario: WeatherScenario = {
    id: `${key}:${Date.now()}`,
    title: 'Météo en direct',
    date: times[0].slice(0, 10),
    latitude: lat,
    longitude: lon,
    location: { latitude: lat, longitude: lon },
    source: 'Open-Meteo, prevision ICON (icon_seamless)',
    times,
    levelsHPa: LEVELS_NEAR,
    quantization: QUANTIZATION,
    // En attendant la grille lointaine : la proche, reprise, qui s'etend au
    // bord et laisse les nappes lointaines vides plutot que fausses.
    grids: { far: { ...nearGrid, spacingKm: 100, fields: {} }, near: nearGrid },
    reference: null,
  }
  let record: LiveRecord = { scenario, fetchedAt: Date.now(), complete: false }
  await dbPut(key, record)
  onUpdate(record)

  // Plafond a la minute : la grille lointaine attend son tour.
  await sleep(61_000)
  const farRows = await fetchPoints(far, fieldsFor(LEVELS_FAR, false))
  const farGrid = toGrid(100, far, farRows, LEVELS_FAR)
  record = {
    scenario: { ...scenario, id: `${key}:${Date.now()}`, grids: { far: farGrid, near: nearGrid } },
    fetchedAt: record.fetchedAt,
    complete: true,
  }
  await dbPut(key, record)
  onUpdate(record)
}
