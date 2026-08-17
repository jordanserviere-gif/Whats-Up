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
}

/**
 * Etat observationnel d'un avion. `null` s'il est au sol ou sans altitude
 * connue : un aeronef qui roule sur un taxiway n'est pas un objet du ciel.
 */
export function computeAircraftState(aircraft: AdsbAircraft, observer: GeoLocation): AircraftState | null {
  if (aircraft.onGround || aircraft.altitudeFt === null) return null
  const altitudeKm = aircraft.altitudeFt * 0.0003048
  const { horizontal, rangeKm } = geodeticToHorizontal(aircraft.latitude, aircraft.longitude, altitudeKm, observer)
  return { ...aircraft, horizontal, rangeKm, altitudeKm, contrailLikelihood: contrailLikelihood(altitudeKm) }
}

export interface GeodeticPoint {
  latitude: number
  longitude: number
  altitudeKm: number
}

/** Avance un point geodesique d'une distance donnee suivant un cap. */
function advance(from: GeodeticPoint, distanceKm: number, bearingDeg: number, climbKm: number): GeodeticPoint {
  const bearing = bearingDeg * DEG
  const lat1 = from.latitude * DEG
  const lon1 = from.longitude * DEG
  const angular = distanceKm / EARTH_RADIUS_KM

  // Point de destination sur la sphere, a distance et cap donnes (formule
  // haversine standard) : suffisant a cette echelle, l'ellipticite de la Terre
  // n'y change rien de perceptible sur quelques kilometres.
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing))
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    )
  return { latitude: lat2 * RAD, longitude: lon2 * RAD, altitudeKm: from.altitudeKm + climbKm }
}

/** Distance parcourue au sol, en kilometres, pendant `seconds`. */
export const groundDistanceKm = (state: AircraftState, seconds: number) =>
  (((state.groundSpeedKt ?? 0) * 1.852) / 3600) * seconds

/**
 * Deplace un point geodesique d'une distance suivant un cap, sans changer
 * d'altitude sauf indication. Exportee pour construire la trainee, qui recule
 * le long de la route de l'avion.
 */
export const advanceGeodetic = (from: GeodeticPoint, distanceKm: number, bearingDeg: number, climbKm = 0) =>
  advance(from, distanceKm, bearingDeg, climbKm)

/**
 * Ecart residuel entre la position affichee et la mesure qui vient d'arriver,
 * resorbe progressivement plutot que d'un coup.
 *
 * Meme datee correctement, une prediction a vitesse constante s'ecarte du vol
 * reel — virage, changement d'allure. Appliquer la correction telle quelle
 * ferait sursauter l'avion a chaque rafraichissement ; on la fait donc fondre
 * en une seconde et demie, ce qui la rend imperceptible.
 */
const CORRECTION_FADE_MS = 1500

interface Correction {
  measuredAtMs: number
  dLat: number
  dLon: number
  dAltKm: number
  appliedAtMs: number
}

const corrections = new Map<string, Correction>()

/**
 * Position extrapolee entre deux mesures.
 *
 * ADS-B ne rafraichit qu'a chaque sondage — vingt secondes, voir
 * `aircraftFeed.ts` — alors qu'un avion parcourt facilement cinq kilometres
 * dans cet intervalle. On avance donc sa derniere position connue au rythme de
 * sa vitesse sol et de sa route, comme le fait tout suivi de vol.
 *
 * Le depart est l'instant de la **mesure**, pas celui de sa reception : c'est
 * ce qui evite que l'avion recule du produit de la latence par sa vitesse a
 * chaque nouvelle donnee. Passe une minute sans mesure, l'extrapolation est
 * plafonnee : au-dela, deviner ne vaut plus mieux que geler.
 */
export function extrapolatedGeodetic(state: AircraftState, nowMs: number): GeodeticPoint {
  const dt = Math.min(Math.max(0, (nowMs - state.measuredAtMs) / 1000), 60)
  const raw: GeodeticPoint = { latitude: state.latitude, longitude: state.longitude, altitudeKm: state.altitudeKm }

  const predicted =
    dt === 0 || (!state.groundSpeedKt && !state.verticalRateFtMin)
      ? raw
      : advance(
          raw,
          groundDistanceKm(state, dt),
          state.trackDeg ?? 0,
          ((state.verticalRateFtMin ?? 0) / 60) * dt * 0.0003048,
        )

  // Nouvelle mesure : on retient l'ecart avec ce qui etait affiche juste avant,
  // pour le resorber au lieu de le faire subir d'un seul coup.
  const previous = corrections.get(state.hex)
  if (!previous || previous.measuredAtMs !== state.measuredAtMs) {
    const carried = previous ? residual(previous, nowMs) : { dLat: 0, dLon: 0, dAltKm: 0 }
    const before = previous
      ? {
          latitude: predicted.latitude + carried.dLat,
          longitude: predicted.longitude + carried.dLon,
          altitudeKm: predicted.altitudeKm + carried.dAltKm,
        }
      : predicted
    corrections.set(state.hex, {
      measuredAtMs: state.measuredAtMs,
      dLat: before.latitude - predicted.latitude,
      dLon: before.longitude - predicted.longitude,
      dAltKm: before.altitudeKm - predicted.altitudeKm,
      appliedAtMs: nowMs,
    })
  }

  const offset = residual(corrections.get(state.hex)!, nowMs)
  return {
    latitude: predicted.latitude + offset.dLat,
    longitude: predicted.longitude + offset.dLon,
    altitudeKm: predicted.altitudeKm + offset.dAltKm,
  }
}

/** Part de la correction encore a appliquer, decroissante jusqu'a zero. */
function residual(c: Correction, nowMs: number) {
  const k = Math.max(0, 1 - (nowMs - c.appliedAtMs) / CORRECTION_FADE_MS)
  return { dLat: c.dLat * k, dLon: c.dLon * k, dAltKm: c.dAltKm * k }
}

/** Oublie les avions disparus du flux, pour que la table ne croisse pas sans fin. */
export function forgetAircraftCorrections(liveHexes: ReadonlySet<string>) {
  for (const hex of corrections.keys()) if (!liveHexes.has(hex)) corrections.delete(hex)
}
