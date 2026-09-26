import type { AdsbAircraft } from './adsb'
import { advanceGeodetic, type GeodeticPoint } from '@/astro/aircraft'

/**
 * Flotte simulee — des avions qui ne dependent d'aucune reception ADS-B.
 *
 * Elle sert a travailler le rendu des avions et de leurs trainees sans relais,
 * sans reseau, a toute heure et en tout lieu : l'acquisition reelle est lente,
 * lacunaire, et ne dit rien de l'avion qu'on voudrait regarder au couchant.
 *
 * Chaque appareil suit une droite qui passe a une distance donnee de
 * l'observateur, et la parcourt en boucle. Tout est **fonction du temps** : a un
 * instant donne, la flotte est toujours la meme, ce qui rend les captures
 * reproductibles. Le temps est celui de l'horloge murale, pas l'instant simule :
 * les avions bougent comme de vrais avions pendant qu'on fait defiler le ciel.
 *
 * Le melange est choisi pour couvrir les cas qui comptent : croisiere haute
 * (trainee), montee et descente (seuil de condensation franchi), basse altitude
 * (pas de trainee), un passage au zenith, un autre pres de l'horizon.
 */

interface SimulatedFlight {
  flight: string
  typeCode: string
  description: string
  /** Route, degres vrais. */
  trackDeg: number
  /** Distance la plus courte a l'observateur, km ; positive a droite de la route. */
  offsetKm: number
  altitudeFt: number
  verticalRateFtMin: number
  speedKt: number
  /** Position de depart sur la boucle, fraction. */
  phase: number
}

const FLEET: readonly SimulatedFlight[] = [
  { flight: 'SIM101', typeCode: 'A320', description: 'Airbus A320', trackDeg: 62, offsetKm: 4, altitudeFt: 37000, verticalRateFtMin: 0, speedKt: 450, phase: 0.42 },
  { flight: 'SIM202', typeCode: 'B77W', description: 'Boeing 777-300ER', trackDeg: 245, offsetKm: -18, altitudeFt: 39000, verticalRateFtMin: 0, speedKt: 490, phase: 0.55 },
  { flight: 'SIM303', typeCode: 'A359', description: 'Airbus A350-900', trackDeg: 150, offsetKm: 30, altitudeFt: 35000, verticalRateFtMin: 0, speedKt: 470, phase: 0.3 },
  { flight: 'SIM404', typeCode: 'B738', description: 'Boeing 737-800', trackDeg: 320, offsetKm: -8, altitudeFt: 33000, verticalRateFtMin: 0, speedKt: 440, phase: 0.62 },
  { flight: 'SIM505', typeCode: 'A21N', description: 'Airbus A321neo', trackDeg: 20, offsetKm: 55, altitudeFt: 36000, verticalRateFtMin: 0, speedKt: 455, phase: 0.48 },
  { flight: 'SIM606', typeCode: 'B789', description: 'Boeing 787-9', trackDeg: 95, offsetKm: -1, altitudeFt: 41000, verticalRateFtMin: 0, speedKt: 500, phase: 0.5 },
  { flight: 'SIM707', typeCode: 'A320', description: 'Airbus A320', trackDeg: 200, offsetKm: 12, altitudeFt: 24000, verticalRateFtMin: 2200, speedKt: 380, phase: 0.35 },
  { flight: 'SIM808', typeCode: 'E190', description: 'Embraer 190', trackDeg: 110, offsetKm: -25, altitudeFt: 27000, verticalRateFtMin: -1800, speedKt: 400, phase: 0.6 },
  { flight: 'SIM909', typeCode: 'AT76', description: 'ATR 72-600', trackDeg: 275, offsetKm: 6, altitudeFt: 7000, verticalRateFtMin: 0, speedKt: 260, phase: 0.45 },
  { flight: 'SIM010', typeCode: 'C172', description: 'Cessna 172', trackDeg: 30, offsetKm: -3, altitudeFt: 3500, verticalRateFtMin: 0, speedKt: 110, phase: 0.52 },
]

/** Demi-longueur de la boucle, km : l'avion entre et sort du rayon suivi. */
const HALF_LOOP_KM = 70
const KT_TO_KM_S = 1.852 / 3600
const FT_TO_KM = 0.0003048

/** Position d'un vol simule a l'instant `nowMs`. */
function place(f: SimulatedFlight, observer: GeodeticPoint, nowMs: number): GeodeticPoint & { altitudeFt: number } {
  const loopKm = 2 * HALF_LOOP_KM
  const travelled = (((nowMs / 1000) * f.speedKt * KT_TO_KM_S + f.phase * loopKm) % loopKm + loopKm) % loopKm
  const closest = advanceGeodetic(observer, Math.abs(f.offsetKm), (f.trackDeg + (f.offsetKm >= 0 ? 90 : 270)) % 360)
  const start = advanceGeodetic(closest, HALF_LOOP_KM, (f.trackDeg + 180) % 360)
  // Une montee ou une descente se rejoue a chaque tour, centree sur le point
  // le plus proche : l'avion franchit le seuil de condensation sous nos yeux.
  const climbFt = f.verticalRateFtMin * ((travelled - HALF_LOOP_KM) / (f.speedKt * KT_TO_KM_S) / 60)
  const altitudeFt = Math.max(1000, f.altitudeFt + climbFt)
  const at = advanceGeodetic(start, travelled, f.trackDeg)
  return { ...at, altitudeKm: altitudeFt * FT_TO_KM, altitudeFt }
}

export function simulatedAircraft(latitude: number, longitude: number, nowMs = Date.now()): AdsbAircraft[] {
  const observer: GeodeticPoint = { latitude, longitude, altitudeKm: 0 }
  return FLEET.map((f, i) => {
    const p = place(f, observer, nowMs)
    return {
      hex: `5100${i.toString(16).padStart(2, '0')}`,
      flight: f.flight,
      registration: `F-SIM${i}`,
      typeCode: f.typeCode,
      description: f.description,
      category: f.typeCode === 'C172' ? 'A1' : 'A3',
      altitudeFt: Math.round(p.altitudeFt),
      altitudeGeomFt: Math.round(p.altitudeFt + 350),
      onGround: false,
      groundSpeedKt: f.speedKt,
      indicatedSpeedKt: null,
      trueSpeedKt: f.speedKt,
      mach: null,
      windDirDeg: null,
      windSpeedKt: null,
      outsideAirTempC: null,
      trackDeg: f.trackDeg,
      verticalRateFtMin: f.verticalRateFtMin,
      squawk: null,
      emergency: 'none',
      latitude: p.latitude,
      longitude: p.longitude,
      measuredAtMs: nowMs,
    }
  })
}
