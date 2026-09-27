/**
 * Etat de la mer — vent a 10 m, mer du vent et houle, heure par heure.
 *
 * Sources : l'API Marine d'Open-Meteo (vagues) et son API de prevision (vent a
 * 10 m). **Un seul appel par lieu**, et seulement si le masque d'eau a trouve
 * de l'eau : la reponse couvre 72 heures (la veille, aujourd'hui, demain) et
 * elle est gardee dans le navigateur. Rien ne l'interroge en boucle — le
 * curseur du temps parcourt ces 72 heures, et la donnee n'est redemandee que
 * pour un autre lieu, ou si elle a plus de douze heures.
 *
 * Pour une journee archivee, la meme requete porte sur cette date.
 */
import { useSkyStore } from '@/state/store'
import { DEFAULT_SEA_STATE, type SeaState } from '@/scene/terrain/waterShading'

const MARINE = 'https://marine-api.open-meteo.com/v1/marine'
const FORECAST = 'https://api.open-meteo.com/v1/forecast'
const MAX_AGE_MS = 12 * 3_600_000
const DB = 'whatsup-sea'
const STORE = 'sea'

interface SeaRecord {
  fetchedAt: number
  times: number[]
  states: SeaState[]
}

let record: SeaRecord | null = null
let recordKey = ''
let inflight = ''

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function dbGet(key: string): Promise<SeaRecord | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as SeaRecord) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}
async function dbPut(key: string, value: SeaRecord): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // Stockage indisponible : l'etat de mer par defaut s'applique.
  }
}

type Hourly = Record<string, (number | null)[] | string[]>

async function fetchHourly(base: string, params: string): Promise<Hourly | null> {
  try {
    const res = await fetch(`${base}?${params}`)
    if (!res.ok) return null
    return ((await res.json()) as { hourly?: Hourly }).hourly ?? null
  } catch {
    return null
  }
}

/**
 * Charge l'etat de mer du lieu : cache du navigateur d'abord, un appel sinon.
 * Sans effet si la donnee du lieu est deja la.
 */
export async function loadSeaState(latitudeDeg: number, longitudeDeg: number): Promise<void> {
  const archived = useSkyStore.getState().weatherScenario
  const dates = archived ? `&start_date=${archived.date}&end_date=${archived.date}` : '&past_days=1&forecast_days=2'
  const key = `${latitudeDeg.toFixed(1)}:${longitudeDeg.toFixed(1)}:${archived?.date ?? 'direct'}`
  if (key === recordKey || key === inflight) return
  const cached = await dbGet(key)
  if (cached && (archived || Date.now() - cached.fetchedAt < MAX_AGE_MS)) {
    record = cached
    recordKey = key
    return
  }
  inflight = key
  try {
    const where = `latitude=${latitudeDeg.toFixed(3)}&longitude=${longitudeDeg.toFixed(3)}&timezone=UTC${dates}`
    const [marine, wind] = await Promise.all([
      fetchHourly(
        MARINE,
        `${where}&hourly=wind_wave_height,wind_wave_direction,wind_wave_period,swell_wave_height,swell_wave_direction,swell_wave_period`,
      ),
      fetchHourly(FORECAST, `${where}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`),
    ])
    if (!wind) return
    const times = (wind.time as string[]).map((t) => Date.parse(`${t}Z`))
    const num = (h: Hourly | null, k: string, i: number) => {
      const v = (h?.[k] as (number | null)[] | undefined)?.[i]
      return typeof v === 'number' ? v : null
    }
    const states: SeaState[] = times.map((_, i) => {
      const state: SeaState = {
        windMS: num(wind, 'wind_speed_10m', i) ?? DEFAULT_SEA_STATE.windMS,
        windFromDeg: num(wind, 'wind_direction_10m', i) ?? DEFAULT_SEA_STATE.windFromDeg,
      }
      const wh = num(marine, 'wind_wave_height', i)
      const wp = num(marine, 'wind_wave_period', i)
      const wd = num(marine, 'wind_wave_direction', i)
      if (wh && wp && wd != null) state.windSea = { hs: wh, tp: wp, fromDeg: wd }
      const sh = num(marine, 'swell_wave_height', i)
      const sp = num(marine, 'swell_wave_period', i)
      const sd = num(marine, 'swell_wave_direction', i)
      if (sh && sp && sd != null && sh > 0.05) state.swell = { hs: sh, tp: sp, fromDeg: sd }
      return state
    })
    record = { fetchedAt: Date.now(), times, states }
    recordKey = key
    await dbPut(key, record)
  } finally {
    if (inflight === key) inflight = ''
  }
}

/**
 * Etat de mer a l'instant affiche, au plus proche de l'heure. Le meme objet
 * est rendu tant que l'heure ne change pas : le relief ne recalcule ses
 * vagues qu'a ce moment-la.
 */
export function currentSeaState(): SeaState {
  if (!record || record.times.length === 0) return DEFAULT_SEA_STATE
  const t = useSkyStore.getState().time
  let best = 0
  for (let i = 1; i < record.times.length; i++) if (Math.abs(record.times[i] - t) < Math.abs(record.times[best] - t)) best = i
  return Math.abs(record.times[best] - t) <= 3 * 3_600_000 ? record.states[best] : DEFAULT_SEA_STATE
}
