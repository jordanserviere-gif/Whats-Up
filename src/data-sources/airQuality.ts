/**
 * Trouble atmospherique mesure — concentration en particules fines (PM2,5),
 * via l'API air quality d'Open-Meteo. Gratuite, sans cle, CORS ouvert a toute
 * origine : contrairement a `adsb.ts`, aucun relais n'est necessaire ici.
 *
 * On demandait auparavant l'epaisseur optique totale (AOD). C'est le PM2,5 qui
 * decrit la couche limite, seule couche que le modele d'atmosphere sait
 * representer — voir `turbidityFromSurfaceAerosol` dans `scene/atmosphere.ts`
 * pour la conversion et la raison detaillee du changement.
 */
import { fetchJson } from './fetchJson'
import type { Sourced } from './types'

const BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality'

/**
 * Duree de validite en cache.
 *
 * Open-Meteo republie ses previsions a l'heure : inutile d'interroger plus
 * souvent. Le reglage reste manuel entre deux mesures, pas fige — c'est
 * `useAerosolAutoSync` qui redemande a intervalle regulier tant que le mode
 * automatique est actif.
 */
const CACHE_TTL_MS = 45 * 60_000

interface RawAirQuality {
  current?: { pm2_5?: number | null }
}

/**
 * Position arrondie au dixieme de degre pour la cle de cache — la charge en
 * particules est une grandeur d'agglomeration, pas une mesure locale au metre
 * pres : arrondir davantage ne perdrait rien de reel et eviterait de
 * multiplier les entrees pour un lieu qui bouge de quelques metres autour
 * d'une position geolocalisee.
 */
function cacheKey(lat: number, lon: number): string {
  return `air-quality:pm25:${lat.toFixed(1)}:${lon.toFixed(1)}`
}

/** Concentration en PM2,5 au lieu donne, en µg/m³, ou `null` si la mesure manque. */
export async function fetchSurfaceAerosol(latitude: number, longitude: number): Promise<Sourced<number> | null> {
  const lat = Math.round(latitude * 10) / 10
  const lon = Math.round(longitude * 10) / 10
  const url = `${BASE}?latitude=${lat}&longitude=${lon}&current=pm2_5&timezone=UTC`

  const result = await fetchJson<RawAirQuality, number | null>(
    url,
    { key: cacheKey(lat, lon), ttlMs: CACHE_TTL_MS },
    (raw) => raw.current?.pm2_5 ?? null,
  )

  if (!result || result.value === null || !Number.isFinite(result.value)) return null
  return { value: result.value, status: result.status }
}
