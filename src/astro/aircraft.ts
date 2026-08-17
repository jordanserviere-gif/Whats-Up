/**
 * Position apparente d'un avion et estimation de sa trainee de condensation.
 *
 * Contrairement aux satellites, un avion est deja donne en coordonnees
 * geodesiques (latitude, longitude, altitude) : il n'y a pas de propagation a
 * faire, seulement une conversion terrestre — geodesique vers ECEF, puis ECEF
 * vers le repere local est-nord-zenith de l'observateur. Aucune rotation
 * horaire n'intervient, a la difference des satellites en ECI : les deux
 * points, avion et observateur, vivent deja dans le meme repere tournant avec
 * la Terre.
 */
import { DEG, EARTH_FLATTENING, EARTH_RADIUS_KM, RAD } from './coords'
import type { AdsbAircraft } from '@/data-sources/adsb'
import type { GeoLocation, Horizontal } from './types'

const E2 = EARTH_FLATTENING * (2 - EARTH_FLATTENING)

/** Point geodesique vers ECEF (km), ellipsoide WGS84. */
function geodeticToEcef(latDeg: number, lonDeg: number, altKm: number): [number, number, number] {
  const lat = latDeg * DEG
  const lon = lonDeg * DEG
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const n = EARTH_RADIUS_KM / Math.sqrt(1 - E2 * sinLat * sinLat)
  return [
    (n + altKm) * cosLat * Math.cos(lon),
    (n + altKm) * cosLat * Math.sin(lon),
    (n * (1 - E2) + altKm) * sinLat,
  ]
}

/**
 * Position horizontale (azimut, hauteur) et distance en ligne de visee d'un
 * point geodesique vu depuis un lieu d'observation.
 */
export function geodeticToHorizontal(
  latDeg: number,
  lonDeg: number,
  altKm: number,
  observer: GeoLocation,
): { horizontal: Horizontal; rangeKm: number } {
  const [x, y, z] = geodeticToEcef(latDeg, lonDeg, altKm)
  const [ox, oy, oz] = geodeticToEcef(observer.latitude, observer.longitude, observer.elevation / 1000)
  const dx = x - ox
  const dy = y - oy
  const dz = z - oz

  const lat0 = observer.latitude * DEG
  const lon0 = observer.longitude * DEG
  const sinLat = Math.sin(lat0)
  const cosLat = Math.cos(lat0)
  const sinLon = Math.sin(lon0)
  const cosLon = Math.cos(lon0)

  const east = -sinLon * dx + cosLon * dy
  const north = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz
  const up = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz

  const range = Math.hypot(east, north, up)
  const azimuth = (Math.atan2(east, north) * RAD + 360) % 360
  const altitude = Math.asin(Math.max(-1, Math.min(1, up / (range || 1)))) * RAD

  return { horizontal: { azimuth, altitude }, rangeKm: range }
}

/** Interpolation lisse entre deux bornes — 0 en dessous, 1 au-dessus, transition en S entre les deux. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Probabilite qu'un avion tire une trainee de condensation a cette altitude.
 *
 * Sans donnees meteo reelles (temperature et humidite en altitude), on retient
 * la regle empirique qui domine l'essentiel des cas observes : les trainees
 * naissent quand la vapeur d'echappement gele au contact d'un air assez froid,
 * ce qui correspond en pratique a peu pres a l'altitude de croisiere des vols
 * commerciaux. En dessous de 7 km elles sont rarissimes, au-dessus de 9 km
 * quasi systematiques par temps froid ; la transition entre les deux est ici
 * une simple rampe, pas un calcul thermodynamique.
 */
export function contrailLikelihood(altitudeKm: number): number {
  return smoothstep(7, 9.5, altitudeKm)
}

export interface AircraftState extends AdsbAircraft {
  horizontal: Horizontal
  rangeKm: number
  /** Altitude au-dessus du niveau de la mer, en kilometres. */
  altitudeKm: number
  contrailLikelihood: number
  /** Instant de cette mesure — sert de point de depart a l'extrapolation. */
  fixedAtMs: number
}

/**
 * Etat observationnel d'un avion. `null` s'il est au sol ou sans altitude
 * connue : un aeronef qui roule sur un taxiway n'est pas un objet du ciel.
 */
export function computeAircraftState(aircraft: AdsbAircraft, observer: GeoLocation): AircraftState | null {
  if (aircraft.onGround || aircraft.altitudeFt === null) return null
  const altitudeKm = aircraft.altitudeFt * 0.0003048
  const { horizontal, rangeKm } = geodeticToHorizontal(aircraft.latitude, aircraft.longitude, altitudeKm, observer)
  return {
    ...aircraft,
    horizontal,
    rangeKm,
    altitudeKm,
    contrailLikelihood: contrailLikelihood(altitudeKm),
    fixedAtMs: Date.now(),
  }
}

/**
 * Position extrapolee entre deux mesures.
 *
 * ADS-B ne rafraichit qu'a chaque sondage — vingt secondes, voir
 * `aircraftFeed.ts` — alors qu'un avion parcourt facilement deux kilometres
 * dans cet intervalle. Plutot que de le laisser fige puis sauter, on avance sa
 * derniere position connue au rythme de sa vitesse sol et de sa route, exactement
 * ce que fait un tracker de vol classique. Passe une minute sans nouvelle
 * mesure, l'extrapolation est plafonnee : au-dela, deviner ne vaut plus mieux
 * que geler.
 */
export function extrapolatedGeodetic(
  state: AircraftState,
  nowMs: number,
): { latitude: number; longitude: number; altitudeKm: number } {
  const dt = Math.min(Math.max(0, (nowMs - state.fixedAtMs) / 1000), 60)
  if (dt === 0 || (!state.groundSpeedKt && !state.verticalRateFtMin)) {
    return { latitude: state.latitude, longitude: state.longitude, altitudeKm: state.altitudeKm }
  }

  const distanceKm = ((state.groundSpeedKt ?? 0) * 1.852) / 3600 * dt
  const bearing = (state.trackDeg ?? 0) * DEG
  const lat1 = state.latitude * DEG
  const lon1 = state.longitude * DEG
  const angular = distanceKm / EARTH_RADIUS_KM

  // Point de destination sur la sphere, a distance et cap donnes (formule
  // haversine standard) : suffisant a cette echelle, l'ellipticite de la Terre
  // n'y change rien de perceptible sur quelques kilometres.
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  )
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    )

  const altitudeKm = state.altitudeKm + (((state.verticalRateFtMin ?? 0) / 60) * dt) * 0.0003048

  return { latitude: lat2 * RAD, longitude: lon2 * RAD, altitudeKm }
}
