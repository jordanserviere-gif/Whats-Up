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
 * Ecart entre la position affichee et celle que donne la mesure qui arrive,
 * resorbe progressivement plutot que d'un coup.
 *
 * Meme datee correctement, une prediction a vitesse constante s'ecarte
 * toujours du vol reel : vent, virage, changement d'allure, et surtout
 * incertitude sur l'age de la donnee. Cet ecart est donc permanent, jamais
 * nul. L'appliquer tel quel fait sauter l'avion a chaque rafraichissement —
 * c'est exactement le « rollback » observe. On le fait fondre en une seconde
 * et demie, ce qui le rend imperceptible.
 */
const CORRECTION_FADE_MS = 1500

/**
 * Vitesse maximale a laquelle une correction est resorbee, en km/s.
 *
 * Une duree fixe ne suffit pas : une grosse correction resorbee en une seconde
 * et demie deplace l'avion plus vite qu'il ne vole, et le recul redevient
 * visible — surtout quand il s'eloigne en ligne de visee, ou sa progression
 * apparente est presque nulle. On etale donc les grands ecarts sur plus
 * longtemps, de facon que le glissement reste toujours lent devant le vol.
 */
const MAX_CORRECTION_KM_PER_SEC = 0.04
/** Plafond de duree : au-dela, la correction trainerait plus que la mesure ne dure. */
const MAX_CORRECTION_FADE_MS = 8000

/**
 * Au-dela de cet ecart, ce n'est plus une correction mais un objet different :
 * avion reapparu apres une longue absence, ou identifiant reattribue. On saute
 * alors franchement plutot que de faire glisser l'appareil sur des kilometres.
 */
const MAX_SMOOTHED_KM = 8

/**
 * Vitesse de virage retenue au maximum, en degres par seconde.
 *
 * Un virage standard vaut trois degres par seconde, et un avion de ligne en
 * croisiere reste bien en deca. Borner protege d'un cap aberrant sur une seule
 * mesure, qui ferait partir la prediction en vrille.
 */
const MAX_TURN_RATE_DEG_S = 3

/** Pas d'integration du virage : au-dela, l'arc ne gagne plus en fidelite. */
const TURN_STEPS = 8

interface Track {
  measuredAtMs: number
  /** Cap de la mesure precedente, pour en deduire la vitesse de virage. */
  previousTrackDeg: number | null
  previousMeasuredAtMs: number
  turnRateDegPerSec: number
  /** Dernier point reellement affiche — c'est a lui qu'il faut se raccorder. */
  shown: GeodeticPoint
  offset: { dLat: number; dLon: number; dAltKm: number }
  offsetAtMs: number
  /** Duree de resorption, proportionnee a l ecart constate. */
  fadeMs: number
}

const ZERO_OFFSET = { dLat: 0, dLon: 0, dAltKm: 0 }
const tracks = new Map<string, Track>()

/** Ecart de cap le plus court entre deux azimuts, dans [−180, 180]. */
const bearingDelta = (from: number, to: number) => ((to - from + 540) % 360) - 180

/**
 * Position atteinte apres `seconds`, en suivant le virage en cours.
 *
 * Une extrapolation en ligne droite suffit tant que l'avion vole droit, mais
 * s'ecarte vite des qu'il tourne : la prediction part a l'exterieur du virage,
 * et la mesure suivante la ramene en arriere — c'est une des sources du recul.
 * On integre donc l'arc par petits pas, le cap evoluant a la vitesse de virage
 * constatee entre les deux dernieres mesures.
 */
function predictAlongTurn(state: AircraftState, seconds: number, turnRateDegPerSec: number): GeodeticPoint {
  let point: GeodeticPoint = {
    latitude: state.latitude,
    longitude: state.longitude,
    altitudeKm: state.altitudeKm,
  }
  const climbKmPerSec = ((state.verticalRateFtMin ?? 0) / 60) * 0.0003048
  const steps = Math.abs(turnRateDegPerSec) < 0.01 ? 1 : TURN_STEPS
  const dtStep = seconds / steps

  for (let i = 0; i < steps; i++) {
    // Cap au milieu du pas : c'est le point milieu qui rend l'integration juste
    // au premier ordre plutot que systematiquement en retard.
    const bearing = (state.trackDeg ?? 0) + turnRateDegPerSec * dtStep * (i + 0.5)
    point = advance(point, groundDistanceKm(state, dtStep), bearing, climbKmPerSec * dtStep)
  }
  return point
}

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

  let track = tracks.get(state.hex)

  // La vitesse de virage se met a jour a l'arrivee d'une mesure, avant de
  // servir a la prediction : elle vient de l'ecart de cap entre les deux
  // dernieres, rapporte au temps qui les separe.
  if (track && track.measuredAtMs !== state.measuredAtMs) {
    const span = (state.measuredAtMs - track.previousMeasuredAtMs) / 1000
    if (track.previousTrackDeg !== null && state.trackDeg !== null && span > 0.5) {
      const rate = bearingDelta(track.previousTrackDeg, state.trackDeg) / span
      track.turnRateDegPerSec = Math.max(-MAX_TURN_RATE_DEG_S, Math.min(MAX_TURN_RATE_DEG_S, rate))
    }
    track.previousTrackDeg = state.trackDeg
    track.previousMeasuredAtMs = state.measuredAtMs
  }

  const predicted =
    dt === 0 || (!state.groundSpeedKt && !state.verticalRateFtMin)
      ? raw
      : predictAlongTurn(state, dt, track?.turnRateDegPerSec ?? 0)

  if (!track) {
    track = {
      measuredAtMs: state.measuredAtMs,
      previousTrackDeg: state.trackDeg,
      previousMeasuredAtMs: state.measuredAtMs,
      turnRateDegPerSec: 0,
      shown: predicted,
      offset: ZERO_OFFSET,
      offsetAtMs: nowMs,
      fadeMs: CORRECTION_FADE_MS,
    }
    tracks.set(state.hex, track)
  } else if (track.measuredAtMs !== state.measuredAtMs) {
    // Une mesure vient d'arriver. L'ecart entre ce qui etait affiche a l'image
    // precedente et ce que la nouvelle mesure predit devient une correction a
    // resorber. C'est le point cle : sans memoire du **dernier point affiche**,
    // il n'y a rien a quoi se raccorder, et le saut est inevitable.
    const dLat = track.shown.latitude - predicted.latitude
    const dLon = track.shown.longitude - predicted.longitude
    const gapKm = Math.hypot(dLat, dLon * Math.cos(predicted.latitude * DEG)) * (Math.PI / 180) * EARTH_RADIUS_KM

    track.offset =
      gapKm > MAX_SMOOTHED_KM
        ? ZERO_OFFSET
        : { dLat, dLon, dAltKm: track.shown.altitudeKm - predicted.altitudeKm }
    // Duree proportionnee a l'ecart : c'est la *vitesse* du rattrapage qu'il
    // faut garder lente, pas sa duree.
    track.fadeMs = Math.min(
      MAX_CORRECTION_FADE_MS,
      Math.max(CORRECTION_FADE_MS, (gapKm / MAX_CORRECTION_KM_PER_SEC) * 1000),
    )
    track.offsetAtMs = nowMs
    track.measuredAtMs = state.measuredAtMs
  }

  const k = Math.max(0, 1 - (nowMs - track.offsetAtMs) / track.fadeMs)
  const shown: GeodeticPoint = {
    latitude: predicted.latitude + track.offset.dLat * k,
    longitude: predicted.longitude + track.offset.dLon * k,
    altitudeKm: predicted.altitudeKm + track.offset.dAltKm * k,
  }
  // Memorise pour le prochain raccord. Plusieurs couches appellent cette
  // fonction par image — maillage, icone, trainee, pointage — mais toutes avec
  // le meme instant, donc elles y ecrivent la meme valeur.
  track.shown = shown
  return shown
}

/** Oublie les avions disparus du flux, pour que la table ne croisse pas sans fin. */
export function forgetAircraftTracks(liveHexes: ReadonlySet<string>) {
  for (const hex of tracks.keys()) if (!liveHexes.has(hex)) tracks.delete(hex)
}
