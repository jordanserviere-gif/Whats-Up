/**
 * Propagation d'une orbite keplerienne autour de la Terre, avec derives
 * seculaires dues a l'aplatissement (J2) sur le noeud ascendant, l'argument du
 * perigee et le mouvement moyen.
 *
 * Modele : « SGP-like » analytique du premier ordre. Il reproduit fidelement la
 * geometrie d'une orbite decrite par ses elements osculateurs, sans modeliser la
 * trainee atmospherique ni les termes courte periode — a la difference d'un
 * propagateur SGP4 alimente par des TLE.
 */
import { DEG, EARTH_J2, EARTH_MU, EARTH_RADIUS_KM, RAD, norm360 } from './coords'
import type { OrbitalElements } from './types'

export interface StateVectorKm {
  position: [number, number, number]
  velocity: [number, number, number]
}

/** Periode orbitale en secondes. */
export function orbitalPeriod(semiMajorAxisKm: number): number {
  return 2 * Math.PI * Math.sqrt(semiMajorAxisKm ** 3 / EARTH_MU)
}

/** Mouvement moyen en tours par jour. */
export function meanMotionRevPerDay(semiMajorAxisKm: number): number {
  return 86400 / orbitalPeriod(semiMajorAxisKm)
}

/** Demi-grand axe deduit d'un mouvement moyen en tours par jour. */
export function semiMajorAxisFromMeanMotion(revPerDay: number): number {
  const n = (revPerDay * 2 * Math.PI) / 86400
  return Math.cbrt(EARTH_MU / (n * n))
}

export const perigeeAltitude = (a: number, e: number) => a * (1 - e) - EARTH_RADIUS_KM
export const apogeeAltitude = (a: number, e: number) => a * (1 + e) - EARTH_RADIUS_KM

/**
 * Equation de Kepler M = E − e·sin E, resolue par Newton-Raphson.
 * Converge en 4-5 iterations jusqu'a e ≈ 0,95.
 */
export function solveKepler(meanAnomalyRad: number, e: number): number {
  const m = meanAnomalyRad
  let E = e < 0.8 ? m : Math.PI
  for (let i = 0; i < 40; i++) {
    const dE = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E))
    E -= dE
    if (Math.abs(dE) < 1e-12) break
  }
  return E
}

/** Derives seculaires J2, en rad/s. */
export function j2Rates(a: number, e: number, inclinationDeg: number) {
  const i = inclinationDeg * DEG
  const n0 = Math.sqrt(EARTH_MU / a ** 3)
  const p = a * (1 - e * e)
  const factor = 1.5 * EARTH_J2 * n0 * (EARTH_RADIUS_KM / p) ** 2

  return {
    /** Regression du noeud ascendant. */
    raanDot: -factor * Math.cos(i),
    /** Rotation de la ligne des apsides. */
    argPerigeeDot: factor * (2 - 2.5 * Math.sin(i) ** 2),
    /** Mouvement moyen corrige du terme seculaire J2. */
    meanAnomalyDot: n0 + factor * Math.sqrt(1 - e * e) * (1 - 1.5 * Math.sin(i) ** 2),
    n0,
  }
}

/**
 * Position et vitesse inertielles geocentriques (km, km/s) a l'instant `date`.
 * Le repere est l'equatorial vrai de la date, coherent avec `observerEci`.
 */
export function propagate(el: OrbitalElements, date: Date): StateVectorKm {
  const a = el.semiMajorAxisKm
  const e = el.eccentricity
  const dt = (date.getTime() - new Date(el.epoch).getTime()) / 1000 // secondes

  const rates = j2Rates(a, e, el.inclination)
  const useJ2 = el.useJ2

  const raan = norm360(el.raan + (useJ2 ? rates.raanDot * dt * RAD : 0)) * DEG
  const argp = norm360(el.argPerigee + (useJ2 ? rates.argPerigeeDot * dt * RAD : 0)) * DEG
  const n = useJ2 ? rates.meanAnomalyDot : rates.n0
  const M = norm360(el.meanAnomaly + n * dt * RAD) * DEG

  const E = solveKepler(M, e)
  const cosE = Math.cos(E)
  const sinE = Math.sin(E)

  // Repere perifocal (x vers le perigee).
  const xP = a * (cosE - e)
  const yP = a * Math.sqrt(1 - e * e) * sinE
  const eDot = Math.sqrt(EARTH_MU / a ** 3) / (1 - e * cosE)
  const vxP = -a * sinE * eDot
  const vyP = a * Math.sqrt(1 - e * e) * cosE * eDot

  // Rotation perifocal → inertiel : R3(−Ω) · R1(−i) · R3(−ω).
  const i = el.inclination * DEG
  const cO = Math.cos(raan)
  const sO = Math.sin(raan)
  const cw = Math.cos(argp)
  const sw = Math.sin(argp)
  const ci = Math.cos(i)
  const si = Math.sin(i)

  const m11 = cO * cw - sO * sw * ci
  const m12 = -cO * sw - sO * cw * ci
  const m21 = sO * cw + cO * sw * ci
  const m22 = -sO * sw + cO * cw * ci
  const m31 = sw * si
  const m32 = cw * si

  return {
    position: [m11 * xP + m12 * yP, m21 * xP + m22 * yP, m31 * xP + m32 * yP],
    velocity: [m11 * vxP + m12 * vyP, m21 * vxP + m22 * vyP, m31 * vxP + m32 * vyP],
  }
}

/** Elements par defaut pour une nouvelle orbite : ISS approximative. */
export function defaultElements(id: string): OrbitalElements {
  return {
    id,
    name: 'Nouvelle orbite',
    semiMajorAxisKm: 6786,
    eccentricity: 0.0004,
    inclination: 51.64,
    raan: 120,
    argPerigee: 90,
    meanAnomaly: 0,
    epoch: new Date().toISOString(),
    useJ2: true,
    color: '#7fd6ff',
  }
}

/**
 * Presets d'orbites de reference. Les elements sont des valeurs typiques
 * (pas des ephemerides operationnelles) : ils illustrent chaque famille d'orbite.
 */
export interface OrbitPreset extends Omit<OrbitalElements, 'id' | 'epoch'> {
  description: string
}

export const ORBIT_PRESETS: readonly OrbitPreset[] = [
  {
    name: 'Station spatiale (type ISS)',
    description: 'Orbite basse inclinée à 51,6°, période ≈ 92 min',
    semiMajorAxisKm: 6786,
    eccentricity: 0.0004,
    inclination: 51.64,
    raan: 120,
    argPerigee: 90,
    meanAnomaly: 0,
    useJ2: true,
    color: '#7fd6ff',
  },
  {
    name: 'Héliosynchrone (type Sentinel)',
    description: 'LEO polaire rétrograde, passe à heure solaire fixe',
    semiMajorAxisKm: 7071,
    eccentricity: 0.001,
    inclination: 98.2,
    raan: 30,
    argPerigee: 90,
    meanAnomaly: 0,
    useJ2: true,
    color: '#9ef0a8',
  },
  {
    name: 'Géostationnaire',
    description: 'Immobile dans le ciel, 35 786 km d’altitude',
    semiMajorAxisKm: 42164,
    eccentricity: 0.0002,
    inclination: 0.05,
    raan: 0,
    argPerigee: 0,
    meanAnomaly: 200,
    useJ2: true,
    color: '#ffd24a',
  },
  {
    name: 'Molniya',
    description: 'Très excentrique, apogée survolée 8 h par révolution',
    semiMajorAxisKm: 26554,
    eccentricity: 0.74,
    inclination: 63.4,
    raan: 45,
    argPerigee: 270,
    meanAnomaly: 0,
    useJ2: true,
    color: '#ff9d5c',
  },
  {
    name: 'Navigation (type GPS)',
    description: 'Orbite moyenne, période 12 h sidérales',
    semiMajorAxisKm: 26560,
    eccentricity: 0.008,
    inclination: 55,
    raan: 200,
    argPerigee: 45,
    meanAnomaly: 130,
    useJ2: true,
    color: '#d5bcf4',
  },
  {
    name: 'Transfert géostationnaire',
    description: 'Ellipse LEO → GEO, forte variation de distance',
    semiMajorAxisKm: 24400,
    eccentricity: 0.73,
    inclination: 6,
    raan: 80,
    argPerigee: 178,
    meanAnomaly: 20,
    useJ2: true,
    color: '#ff7a9c',
  },
] as const
