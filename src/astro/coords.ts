/** Geometrie spherique : conversions de reperes et formatage des angles. */
import { lstDegrees } from './time'
import type { Equatorial, GeoLocation, Horizontal } from './types'

export const DEG = Math.PI / 180
export const RAD = 180 / Math.PI

export const norm360 = (d: number) => ((d % 360) + 360) % 360

/** Rayon equatorial terrestre (WGS84), km. */
export const EARTH_RADIUS_KM = 6378.137
/** Aplatissement WGS84. */
export const EARTH_FLATTENING = 1 / 298.257223563
/** Parametre gravitationnel standard de la Terre, km^3/s^2. */
export const EARTH_MU = 398600.4418
/** Coefficient d'aplatissement zonal J2. */
export const EARTH_J2 = 1.08262668e-3

/**
 * Equatorial (de la date) vers horizontal, sans refraction.
 * `ra` en degres.
 */
export function equatorialToHorizontal(eq: Equatorial, location: GeoLocation, date: Date): Horizontal {
  const lst = lstDegrees(date, location.longitude)
  const ha = (norm360(lst - eq.ra) * DEG)
  const dec = eq.dec * DEG
  const lat = location.latitude * DEG

  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha)
  const altitude = Math.asin(Math.min(1, Math.max(-1, sinAlt)))
  // Azimut compte depuis le nord vers l'est.
  const azimuth = Math.atan2(
    -Math.sin(ha) * Math.cos(dec),
    Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(ha),
  )
  return { azimuth: norm360(azimuth * RAD), altitude: altitude * RAD }
}

/**
 * Angle parallactique : rotation entre « nord celeste » et « zenith » vue depuis
 * l'observateur. Sert a orienter la phase lunaire a l'ecran.
 */
export function parallacticAngle(eq: Equatorial, location: GeoLocation, date: Date): number {
  const lst = lstDegrees(date, location.longitude)
  const ha = norm360(lst - eq.ra) * DEG
  const dec = eq.dec * DEG
  const lat = location.latitude * DEG
  return Math.atan2(Math.sin(ha), Math.tan(lat) * Math.cos(dec) - Math.sin(dec) * Math.cos(ha)) * RAD
}

/** Separation angulaire entre deux directions equatoriales, en degres. */
export function angularSeparation(a: Equatorial, b: Equatorial): number {
  const d1 = a.dec * DEG
  const d2 = b.dec * DEG
  const dra = (a.ra - b.ra) * DEG
  const cosSep = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(dra)
  return Math.acos(Math.min(1, Math.max(-1, cosSep))) * RAD
}

/**
 * Precession approchee J2000 → date (rigoureuse a ~1″ sur un siecle).
 * Le catalogue d'etoiles est en J2000 ; la scene travaille en repere de la date.
 */
export function precessFromJ2000(eq: Equatorial, date: Date): Equatorial {
  const t = (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) / 3600
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) / 3600
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) / 3600

  const ra0 = eq.ra * DEG
  const dec0 = eq.dec * DEG
  const zr = zeta * DEG
  const zzr = z * DEG
  const th = theta * DEG

  const a = Math.cos(dec0) * Math.sin(ra0 + zr)
  const b = Math.cos(th) * Math.cos(dec0) * Math.cos(ra0 + zr) - Math.sin(th) * Math.sin(dec0)
  const c = Math.sin(th) * Math.cos(dec0) * Math.cos(ra0 + zr) + Math.cos(th) * Math.sin(dec0)

  return {
    ra: norm360((Math.atan2(a, b) + zzr) * RAD),
    dec: Math.asin(Math.min(1, Math.max(-1, c))) * RAD,
  }
}

/**
 * Position de l'observateur dans le repere inertiel geocentrique (ECI de la date),
 * en km. Tient compte de l'aplatissement WGS84.
 */
export function observerEci(location: GeoLocation, date: Date): [number, number, number] {
  const lat = location.latitude * DEG
  const alt = location.elevation / 1000
  const lst = lstDegrees(date, location.longitude) * DEG
  const f = EARTH_FLATTENING
  const c = 1 / Math.sqrt(1 - (2 * f - f * f) * Math.sin(lat) ** 2)
  const s = c * (1 - f) ** 2
  const rx = (EARTH_RADIUS_KM * c + alt) * Math.cos(lat)
  const rz = (EARTH_RADIUS_KM * s + alt) * Math.sin(lat)
  return [rx * Math.cos(lst), rx * Math.sin(lst), rz]
}

/**
 * Reperes trigonometriques du site a un instant donne.
 *
 * Ni la latitude ni le temps sideral ne dependent de l'objet observe. Sur un
 * catalogue de plusieurs milliers de satellites, recalculer ces quatre sinus
 * une fois par objet coutait davantage que la conversion elle-meme : ils sont
 * donc etablis une fois par instant, et les conversions les recoivent.
 */
export interface SiteFrame {
  sinLat: number
  cosLat: number
  /** Sinus et cosinus du temps sideral local. */
  sinLst: number
  cosLst: number
  /** Temps sideral de Greenwich, en radians — sert a la trace au sol. */
  gmst: number
}

export function siteFrame(location: GeoLocation, date: Date): SiteFrame {
  const lat = location.latitude * DEG
  const lst = lstDegrees(date, location.longitude) * DEG
  return {
    sinLat: Math.sin(lat),
    cosLat: Math.cos(lat),
    sinLst: Math.sin(lst),
    cosLst: Math.cos(lst),
    gmst: lstDegrees(date, 0) * DEG,
  }
}

/**
 * Vecteur topocentrique (ECI) vers coordonnees horizontales, via le repere SEZ.
 *
 * `frame` n'est qu'une optimisation : omis, il est etabli a la volee a partir du
 * lieu et de l'instant, et le resultat est le meme au bit pres.
 */
export function eciVectorToHorizontal(
  rho: [number, number, number],
  location: GeoLocation,
  date: Date,
  frame: SiteFrame = siteFrame(location, date),
): Horizontal {
  const [x, y, z] = rho
  const { sinLat, cosLat, sinLst, cosLst } = frame

  // Repere SEZ : sud, est, zenith.
  const south = sinLat * cosLst * x + sinLat * sinLst * y - cosLat * z
  const east = -sinLst * x + cosLst * y
  const zenith = cosLat * cosLst * x + cosLat * sinLst * y + sinLat * z

  const range = Math.hypot(south, east, zenith) || 1
  return {
    altitude: Math.asin(zenith / range) * RAD,
    azimuth: norm360(Math.atan2(east, -south) * RAD),
  }
}

/** Point sous-satellite (latitude geodesique, longitude est) et altitude, en km. */
export function eciToGeodetic(
  r: [number, number, number],
  date: Date,
  gmst: number = lstDegrees(date, 0) * DEG,
): { latitude: number; longitude: number; altitudeKm: number } {
  const [x, y, z] = r
  const lon = norm360((Math.atan2(y, x) - gmst) * RAD)
  const rxy = Math.hypot(x, y)
  const f = EARTH_FLATTENING
  const e2 = 2 * f - f * f

  // Iteration de Bowring. Elle part de la latitude geocentrique, a 0,19° au
  // plus de la geodesique, et chaque tour divise l'ecart par e² : trois tours
  // suffisent a descendre sous le centimetre. Mesure sur dix mille positions du
  // catalogue, l'ecart avec six tours plafonne a 7e-5 seconde d'arc.
  let lat = Math.atan2(z, rxy)
  let c = 1
  for (let i = 0; i < 3; i++) {
    const sinLat = Math.sin(lat)
    c = 1 / Math.sqrt(1 - e2 * sinLat * sinLat)
    lat = Math.atan2(z + EARTH_RADIUS_KM * c * e2 * sinLat, rxy)
  }
  const altitudeKm = rxy / Math.cos(lat) - EARTH_RADIUS_KM * c

  return { latitude: lat * RAD, longitude: lon > 180 ? lon - 360 : lon, altitudeKm }
}

/** Points cardinaux en francais. */
export const CARDINALS = [
  { azimuth: 0, short: 'N', label: 'Nord' },
  { azimuth: 45, short: 'NE', label: 'Nord-Est' },
  { azimuth: 90, short: 'E', label: 'Est' },
  { azimuth: 135, short: 'SE', label: 'Sud-Est' },
  { azimuth: 180, short: 'S', label: 'Sud' },
  { azimuth: 225, short: 'SO', label: 'Sud-Ouest' },
  { azimuth: 270, short: 'O', label: 'Ouest' },
  { azimuth: 315, short: 'NO', label: 'Nord-Ouest' },
] as const

/** Azimut vers point cardinal a 16 branches. */
export function azimuthToCardinal(azimuth: number): string {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO']
  return names[Math.round(norm360(azimuth) / 22.5) % 16]
}

/** Degres decimaux vers « 12° 34′ 56″ ». */
export function formatDms(deg: number, decimals = 0): string {
  const sign = deg < 0 ? '−' : ''
  const a = Math.abs(deg)
  const d = Math.floor(a)
  const mFull = (a - d) * 60
  const m = Math.floor(mFull)
  const s = (mFull - m) * 60
  return `${sign}${d}° ${String(m).padStart(2, '0')}′ ${s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0')}″`
}

/** Ascension droite en degres vers « 12h 34m 56s ». */
export function formatRa(raDeg: number): string {
  const hours = norm360(raDeg) / 15
  const h = Math.floor(hours)
  const mFull = (hours - h) * 60
  const m = Math.floor(mFull)
  const s = (mFull - m) * 60
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${s.toFixed(1).padStart(4, '0')}s`
}

/** Angle signe compact, ex. « +38,4° ». */
export function formatDeg(deg: number, decimals = 1): string {
  const sign = deg > 0 ? '+' : deg < 0 ? '−' : ''
  return `${sign}${Math.abs(deg).toFixed(decimals).replace('.', ',')}°`
}
