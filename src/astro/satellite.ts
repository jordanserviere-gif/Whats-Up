/**
 * Observation d'un satellite depuis le sol : position apparente, illumination,
 * trace dans le ciel et recherche de passages.
 */
import * as A from 'astronomy-engine'
import {
  DEG,
  EARTH_RADIUS_KM,
  RAD,
  eciToGeodetic,
  eciVectorToHorizontal,
  observerEci,
} from './coords'
import { orbitalPeriod, propagate, type StateVectorKm } from './kepler'
import { propagateGp } from './sgp4'
import type { GeoLocation, OrbitalElements, SatellitePass, SatelliteState, TrackPoint } from './types'

/**
 * Aiguillage entre les deux propagateurs.
 *
 * Un jeu d'elements sait comment il doit etre propage : les elements moyens
 * d'un catalogue passent par SGP4, les elements osculateurs saisis a la main
 * par le modele keplerien. Ce choix se fait ici, une seule fois, et tout ce qui
 * suit — etat instantane, trace, recherche de passages — l'ignore.
 */
function stateVector(el: OrbitalElements, date: Date): StateVectorKm {
  return el.gp ? propagateGp(el.gp, date) : propagate(el, date)
}

/** Direction geocentrique du Soleil dans le repere equatorial de la date, en km. */
function sunVectorEci(date: Date): [number, number, number] {
  const eqj = A.GeoVector(A.Body.Sun, date, false)
  const eqd = A.RotateVector(A.Rotation_EQJ_EQD(date), eqj)
  return [eqd.x * A.KM_PER_AU, eqd.y * A.KM_PER_AU, eqd.z * A.KM_PER_AU]
}

/**
 * Le satellite est-il hors de l'ombre de la Terre ?
 * Modele d'ombre cylindrique : suffisant a la precision d'un affichage visuel.
 */
function isSunlit(satEci: readonly [number, number, number], sunEci: readonly [number, number, number]): boolean {
  const sunNorm = Math.hypot(...sunEci)
  const u: [number, number, number] = [sunEci[0] / sunNorm, sunEci[1] / sunNorm, sunEci[2] / sunNorm]
  const projection = satEci[0] * u[0] + satEci[1] * u[1] + satEci[2] * u[2]
  if (projection > 0) return true // cote jour
  const perp = Math.hypot(
    satEci[0] - projection * u[0],
    satEci[1] - projection * u[1],
    satEci[2] - projection * u[2],
  )
  return perp > EARTH_RADIUS_KM
}

/**
 * Magnitude visuelle estimee d'un satellite, modele standard a magnitude
 * intrinseque et fonction de phase diffuse (Lambert spherique).
 */
function estimateMagnitude(rangeKm: number, phaseAngleDeg: number, intrinsicMag = -1.3): number {
  const phase = phaseAngleDeg * DEG
  const fraction = (1 + Math.cos(phase)) / 2
  const term = Math.max(1e-4, fraction)
  return intrinsicMag + 5 * Math.log10(rangeKm / 1000) - 2.5 * Math.log10(term)
}

/**
 * Grandeurs communes a tous les satellites observes au meme instant.
 *
 * Ni la direction du Soleil ni la position de l'observateur ne dependent du
 * satellite. Les recalculer objet par objet coutait une ephemeride solaire
 * complete par satellite et par rafraichissement : a un millier d'objets
 * propages dix fois par seconde, ce seul calcul aurait domine tout le reste.
 */
export interface ObservationContext {
  sunEci: [number, number, number]
  observerEci: [number, number, number]
}

export function observationContext(date: Date, location: GeoLocation): ObservationContext {
  return { sunEci: sunVectorEci(date), observerEci: observerEci(location, date) }
}

/** Etat observationnel complet d'un satellite a un instant donne. */
export function computeSatelliteState(
  el: OrbitalElements,
  date: Date,
  location: GeoLocation,
  context?: ObservationContext,
): SatelliteState {
  const ctx = context ?? observationContext(date, location)
  const { position, velocity } = stateVector(el, date)
  const obs = ctx.observerEci
  const rho: [number, number, number] = [position[0] - obs[0], position[1] - obs[1], position[2] - obs[2]]
  const rangeKm = Math.hypot(...rho)

  const horizontal = eciVectorToHorizontal(rho, location, date)
  const geo = eciToGeodetic(position, date)

  const sun = ctx.sunEci
  const sunlit = isSunlit(position, sun)

  // Angle de phase observateur-satellite-Soleil.
  const satToSun: [number, number, number] = [sun[0] - position[0], sun[1] - position[1], sun[2] - position[2]]
  const satToObs: [number, number, number] = [-rho[0], -rho[1], -rho[2]]
  const dot = satToSun[0] * satToObs[0] + satToSun[1] * satToObs[1] + satToSun[2] * satToObs[2]
  const phaseAngle =
    Math.acos(Math.min(1, Math.max(-1, dot / (Math.hypot(...satToSun) * Math.hypot(...satToObs))))) * RAD

  // Vitesse radiale : projection de la vitesse relative sur la ligne de visee.
  const rangeRateKm =
    (velocity[0] * rho[0] + velocity[1] * rho[1] + velocity[2] * rho[2]) / (rangeKm || 1)

  return {
    positionEci: position,
    velocityEci: velocity,
    horizontal,
    rangeKm,
    rangeRateKm,
    altitudeKm: geo.altitudeKm,
    latitude: geo.latitude,
    longitude: geo.longitude,
    sunlit,
    magnitude: sunlit && horizontal.altitude > 0 ? estimateMagnitude(rangeKm, phaseAngle) : null,
    time: date,
  }
}

/**
 * Etats d'un lot de satellites au meme instant.
 *
 * Un jeu d'elements corrompu ne fait pas echouer le lot : il est simplement
 * absent du resultat. Sur un catalogue de plusieurs centaines d'objets, un seul
 * enregistrement bancal viderait sinon tout le ciel.
 */
export function computeSatelliteStates(
  elements: readonly OrbitalElements[],
  date: Date,
  location: GeoLocation,
): Map<string, SatelliteState> {
  const ctx = observationContext(date, location)
  const out = new Map<string, SatelliteState>()
  for (const el of elements) {
    try {
      out.set(el.id, computeSatelliteState(el, date, location, ctx))
    } catch {
      /* elements inexploitables : le satellite est ignore */
    }
  }
  return out
}

/**
 * Trace apparente dans le ciel sur une fenetre centree autour de `center`.
 * Le pas est adapte a la periode orbitale pour rester lisible sur toutes les orbites.
 */
export function sampleSkyTrack(
  el: OrbitalElements,
  location: GeoLocation,
  center: Date,
  windowMinutes: number,
  steps = 360,
): TrackPoint[] {
  const half = (windowMinutes * 60 * 1000) / 2
  const out: TrackPoint[] = []
  for (let i = 0; i <= steps; i++) {
    const t = new Date(center.getTime() - half + (2 * half * i) / steps)
    const s = computeSatelliteState(el, t, location)
    out.push({
      time: t,
      azimuth: s.horizontal.azimuth,
      altitude: s.horizontal.altitude,
      sunlit: s.sunlit,
      rangeKm: s.rangeKm,
    })
  }
  return out
}

/** Trace au sol (latitude/longitude) sur une ou plusieurs revolutions. */
export function sampleGroundTrack(
  el: OrbitalElements,
  start: Date,
  revolutions = 1,
  steps = 240,
): Array<{ time: Date; latitude: number; longitude: number; altitudeKm: number }> {
  const periodMs = orbitalPeriod(el.semiMajorAxisKm) * 1000 * revolutions
  const out = []
  for (let i = 0; i <= steps; i++) {
    const t = new Date(start.getTime() + (periodMs * i) / steps)
    const geo = eciToGeodetic(stateVector(el, t).position, t)
    out.push({ time: t, ...geo })
  }
  return out
}

export interface PassSearchOptions {
  /** Duree de recherche en heures. */
  hours: number
  /** Hauteur minimale au pic pour retenir le passage, en degres. */
  minPeakAltitude: number
  /** Ne garder que les passages observables a l'oeil (satellite eclaire, ciel sombre). */
  visibleOnly: boolean
}

/**
 * Recherche des passages au-dessus de l'horizon.
 * Balayage grossier a 30 s puis raffinement dichotomique des instants de
 * franchissement, ce qui donne les bornes a la seconde pres.
 */
export function findPasses(
  el: OrbitalElements,
  location: GeoLocation,
  start: Date,
  options: PassSearchOptions,
): SatellitePass[] {
  const { hours, minPeakAltitude, visibleOnly } = options
  const endMs = start.getTime() + hours * 3600 * 1000
  const coarseStepMs = 30_000

  const altitudeAt = (ms: number) => computeSatelliteState(el, new Date(ms), location).horizontal.altitude

  /**
   * Instant du franchissement de l'horizon entre deux bornes encadrantes.
   * `ascending` indique le sens du franchissement (lever ou coucher).
   */
  const refine = (lowMs: number, highMs: number, ascending: boolean) => {
    let lo = lowMs
    let hi = highMs
    for (let i = 0; i < 24 && hi - lo > 500; i++) {
      const mid = (lo + hi) / 2
      const below = altitudeAt(mid) <= 0
      if (below === ascending) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }

  const passes: SatellitePass[] = []
  let previousAlt = altitudeAt(start.getTime())
  let riseMs: number | null = previousAlt > 0 ? start.getTime() : null

  for (let ms = start.getTime() + coarseStepMs; ms <= endMs; ms += coarseStepMs) {
    const alt = altitudeAt(ms)

    if (previousAlt <= 0 && alt > 0) {
      riseMs = refine(ms - coarseStepMs, ms, true)
    } else if (previousAlt > 0 && alt <= 0 && riseMs !== null) {
      const setMs = refine(ms - coarseStepMs, ms, false)
      const pass = buildPass(el, location, riseMs, setMs)
      if (pass.peakAltitude >= minPeakAltitude && (!visibleOnly || pass.visible)) passes.push(pass)
      riseMs = null
    }
    previousAlt = alt
  }

  return passes
}

function buildPass(el: OrbitalElements, location: GeoLocation, riseMs: number, setMs: number): SatellitePass {
  const samples = 60
  let peakAlt = -90
  let peakMs = riseMs
  let visible = false
  let maxMag: number | null = null

  const observer = new A.Observer(location.latitude, location.longitude, location.elevation)

  for (let i = 0; i <= samples; i++) {
    const ms = riseMs + ((setMs - riseMs) * i) / samples
    const t = new Date(ms)
    const s = computeSatelliteState(el, t, location)
    if (s.horizontal.altitude > peakAlt) {
      peakAlt = s.horizontal.altitude
      peakMs = ms
    }
    if (s.sunlit && s.horizontal.altitude > 0) {
      const sunEq = A.Equator(A.Body.Sun, t, observer, true, true)
      const sunAlt = A.Horizon(t, observer, sunEq.ra, sunEq.dec, 'normal').altitude
      // Ciel suffisamment sombre : Soleil sous l'horizon civil.
      if (sunAlt < -6) {
        visible = true
        if (s.magnitude !== null && (maxMag === null || s.magnitude < maxMag)) maxMag = s.magnitude
      }
    }
  }

  return {
    start: new Date(riseMs),
    peak: new Date(peakMs),
    end: new Date(setMs),
    peakAltitude: peakAlt,
    startAzimuth: computeSatelliteState(el, new Date(riseMs), location).horizontal.azimuth,
    endAzimuth: computeSatelliteState(el, new Date(setMs), location).horizontal.azimuth,
    visible,
    maxMagnitude: maxMag,
  }
}
