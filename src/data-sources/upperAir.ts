/**
 * Air en altitude — temperature et humidite aux niveaux de vol, via Open-Meteo.
 *
 * C'est ce qui decide si un avion trace une trainee, et combien de temps elle
 * dure (voir `atmosphere/cloud/contrailFormation.ts`). Gratuit, sans cle, CORS
 * ouvert, comme la qualite de l'air.
 *
 * ## Le modele est ICON, et ce n'est pas un detail
 *
 * Les modeles ne definissent pas l'humidite relative de la meme facon. ICON la
 * donne **par rapport a l'eau liquide**, a toute temperature ; ECMWF la rapporte
 * a la glace sous −23 °C. Au meme instant, a 250 hPa au-dessus de Paris, ICON
 * annoncait 40 % et ECMWF 80 % : pas un desaccord, deux definitions — 40 % sur
 * eau font 64 % sur glace a −49 °C. La persistance se joue precisement sur
 * l'humidite par rapport a la glace ; on prend donc la source dont la
 * definition est sans ambiguite, et l'on convertit soi-meme.
 */
import { fetchJson } from './fetchJson'
import type { Sourced } from './types'

const BASE = 'https://api.open-meteo.com/v1/forecast'

/** Niveaux interroges, hPa : de 7 a 14 km, les altitudes de croisiere et d'approche haute. */
export const UPPER_AIR_LEVELS_HPA = [400, 350, 300, 250, 200, 150] as const

/** Les previsions sont republiees a l'heure. */
const CACHE_TTL_MS = 45 * 60_000

export interface UpperAirLevel {
  pressurePa: number
  /** Altitude geopotentielle du niveau, m — confondue avec l'altitude geometrique a ces hauteurs. */
  heightM: number
  temperatureK: number
  /** Humidite relative par rapport a l'eau liquide, fraction. */
  relativeHumidityWater: number
  /** Vent horizontal, composantes est et nord, m/s. */
  windEastMS: number
  windNorthMS: number
}

/** Profil a une heure donnee, du plus bas au plus haut. */
export interface UpperAirProfile {
  timeMs: number
  levels: UpperAirLevel[]
}

/** Profils horaires sur la fenetre de prevision. */
export interface UpperAirForecast {
  profiles: UpperAirProfile[]
}

type RawHourly = Record<string, (number | null)[] | string[]>

export async function fetchUpperAir(latitude: number, longitude: number): Promise<Sourced<UpperAirForecast> | null> {
  const lat = Math.round(latitude * 10) / 10
  const lon = Math.round(longitude * 10) / 10
  const fields = UPPER_AIR_LEVELS_HPA.flatMap((p) => [
    `temperature_${p}hPa`,
    `relative_humidity_${p}hPa`,
    `geopotential_height_${p}hPa`,
    `wind_speed_${p}hPa`,
    `wind_direction_${p}hPa`,
  ])
  const url =
    `${BASE}?latitude=${lat}&longitude=${lon}&hourly=${fields.join(',')}` +
    `&models=icon_seamless&past_days=1&forecast_days=2&timezone=UTC`

  const result = await fetchJson<{ hourly?: RawHourly }, UpperAirForecast | null>(
    url,
    { key: `upper-air:${lat.toFixed(1)}:${lon.toFixed(1)}`, ttlMs: CACHE_TTL_MS },
    (raw) => {
      const h = raw.hourly
      if (!h || !Array.isArray(h.time)) return null
      const times = h.time as string[]
      const profiles: UpperAirProfile[] = []
      times.forEach((iso, i) => {
        const levels: UpperAirLevel[] = []
        for (const p of UPPER_AIR_LEVELS_HPA) {
          const t = (h[`temperature_${p}hPa`] as (number | null)[] | undefined)?.[i]
          const rh = (h[`relative_humidity_${p}hPa`] as (number | null)[] | undefined)?.[i]
          const z = (h[`geopotential_height_${p}hPa`] as (number | null)[] | undefined)?.[i]
          const speed = (h[`wind_speed_${p}hPa`] as (number | null)[] | undefined)?.[i]
          const from = (h[`wind_direction_${p}hPa`] as (number | null)[] | undefined)?.[i]
          if (t == null || rh == null || z == null) continue
          // Vitesse en km/h, direction d'ou vient le vent : le vecteur pointe a l'oppose.
          const v = (speed ?? 0) / 3.6
          const dir = ((from ?? 0) * Math.PI) / 180
          levels.push({
            pressurePa: p * 100,
            heightM: z,
            temperatureK: t + 273.15,
            relativeHumidityWater: rh / 100,
            windEastMS: -v * Math.sin(dir),
            windNorthMS: -v * Math.cos(dir),
          })
        }
        if (levels.length >= 2) {
          levels.sort((a, b) => a.heightM - b.heightM)
          profiles.push({ timeMs: Date.parse(`${iso}Z`), levels })
        }
      })
      return profiles.length > 0 ? { profiles } : null
    },
  )
  if (!result || !result.value) return null
  return { value: result.value, status: result.status }
}

/** Profil le plus proche d'un instant, ou `null` si la prevision ne le couvre pas a trois heures pres. */
export function profileAt(forecast: UpperAirForecast | null, timeMs: number): UpperAirProfile | null {
  if (!forecast) return null
  let best: UpperAirProfile | null = null
  for (const p of forecast.profiles) if (!best || Math.abs(p.timeMs - timeMs) < Math.abs(best.timeMs - timeMs)) best = p
  return best && Math.abs(best.timeMs - timeMs) <= 3 * 3600_000 ? best : null
}

/**
 * Air ambiant a une altitude, par interpolation entre niveaux : lineaire en
 * altitude pour la temperature et l'humidite, en logarithme pour la pression.
 * `null` hors du profil — sous 400 hPa, pas de trainee de toute facon.
 */
export function airAt(profile: UpperAirProfile, altitudeM: number): UpperAirLevel | null {
  const levels = profile.levels
  if (altitudeM < levels[0].heightM - 500 || altitudeM > levels[levels.length - 1].heightM + 1500) return null
  let i = 0
  while (i < levels.length - 2 && altitudeM > levels[i + 1].heightM) i++
  const a = levels[i]
  const b = levels[i + 1]
  const f = (altitudeM - a.heightM) / (b.heightM - a.heightM)
  return {
    heightM: altitudeM,
    windEastMS: a.windEastMS + (b.windEastMS - a.windEastMS) * f,
    windNorthMS: a.windNorthMS + (b.windNorthMS - a.windNorthMS) * f,
    temperatureK: a.temperatureK + (b.temperatureK - a.temperatureK) * f,
    relativeHumidityWater: Math.max(0, a.relativeHumidityWater + (b.relativeHumidityWater - a.relativeHumidityWater) * f),
    pressurePa: Math.exp(Math.log(a.pressurePa) + (Math.log(b.pressurePa) - Math.log(a.pressurePa)) * f),
  }
}

/**
 * Cisaillement vertical du vent horizontal a une altitude, s⁻¹ : la norme de
 * la difference des vecteurs vent entre les deux niveaux qui l'encadrent,
 * rapportee a leur ecart d'altitude. C'est lui qui etale les trainees.
 */
export function shearAt(profile: UpperAirProfile, altitudeM: number): number | null {
  const levels = profile.levels
  if (altitudeM < levels[0].heightM - 500 || altitudeM > levels[levels.length - 1].heightM + 1500) return null
  let i = 0
  while (i < levels.length - 2 && altitudeM > levels[i + 1].heightM) i++
  const a = levels[i]
  const b = levels[i + 1]
  const dz = b.heightM - a.heightM
  if (!(dz > 0)) return null
  return Math.hypot(b.windEastMS - a.windEastMS, b.windNorthMS - a.windNorthMS) / dz
}
