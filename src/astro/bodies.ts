/**
 * Ephemerides des corps majeurs du systeme solaire, via astronomy-engine
 * (VSOP87 tronque + ELP2000 pour la Lune) : precision de l'ordre de la seconde
 * d'arc pour les planetes, largement suffisante pour une vue du ciel.
 */
import * as A from 'astronomy-engine'
import {
  DEG,
  RAD,
  angularSeparation,
  equatorialToHorizontal,
  norm360,
  parallacticAngle,
  precessFromJ2000,
} from './coords'
import { skyLuminance } from './photometry'
import type { BodyId, BodyState, Equatorial, GeoLocation, RiseSetInfo } from './types'

export interface BodyDefinition {
  id: BodyId
  name: string
  body: A.Body
  /** Rayon equatorial en km, pour le diametre apparent. */
  radiusKm: number
  colorToken: string
  /** Ordre d'affichage dans les listes. */
  order: number
}

export const BODIES: readonly BodyDefinition[] = [
  { id: 'sun', name: 'Soleil', body: A.Body.Sun, radiusKm: 695700, colorToken: '--app-body-sun', order: 0 },
  { id: 'moon', name: 'Lune', body: A.Body.Moon, radiusKm: 1737.4, colorToken: '--app-body-moon', order: 1 },
  { id: 'mercury', name: 'Mercure', body: A.Body.Mercury, radiusKm: 2439.7, colorToken: '--app-body-mercury', order: 2 },
  { id: 'venus', name: 'Vénus', body: A.Body.Venus, radiusKm: 6051.8, colorToken: '--app-body-venus', order: 3 },
  { id: 'mars', name: 'Mars', body: A.Body.Mars, radiusKm: 3389.5, colorToken: '--app-body-mars', order: 4 },
  { id: 'jupiter', name: 'Jupiter', body: A.Body.Jupiter, radiusKm: 69911, colorToken: '--app-body-jupiter', order: 5 },
  { id: 'saturn', name: 'Saturne', body: A.Body.Saturn, radiusKm: 58232, colorToken: '--app-body-saturn', order: 6 },
  { id: 'uranus', name: 'Uranus', body: A.Body.Uranus, radiusKm: 25362, colorToken: '--app-body-uranus', order: 7 },
  { id: 'neptune', name: 'Neptune', body: A.Body.Neptune, radiusKm: 24622, colorToken: '--app-body-neptune', order: 8 },
  { id: 'pluto', name: 'Pluton', body: A.Body.Pluto, radiusKm: 1188.3, colorToken: '--app-body-pluto', order: 9 },
] as const

export const BODY_BY_ID = new Map(BODIES.map((b) => [b.id, b]))

const KM_PER_AU = A.KM_PER_AU

function observerOf(location: GeoLocation): A.Observer {
  return new A.Observer(location.latitude, location.longitude, location.elevation)
}

/**
 * Angle de position du limbe eclaire, ramene au zenith de l'observateur :
 * c'est l'orientation a l'ecran du croissant.
 */
function brightLimbAngle(target: Equatorial, sun: Equatorial, location: GeoLocation, date: Date): number {
  const dRa = (sun.ra - target.ra) * DEG
  const ds = sun.dec * DEG
  const dt = target.dec * DEG
  const chi =
    Math.atan2(Math.cos(ds) * Math.sin(dRa), Math.sin(ds) * Math.cos(dt) - Math.cos(ds) * Math.sin(dt) * Math.cos(dRa)) *
    RAD
  return norm360(chi - parallacticAngle(target, location, date))
}

/** Vecteur cartesien (km) a partir de coordonnees equatoriales et d'une distance. */
function toVector(raDeg: number, decDeg: number, distanceKm: number): [number, number, number] {
  const ra = raDeg * DEG
  const dec = decDeg * DEG
  const cd = Math.cos(dec)
  return [distanceKm * cd * Math.cos(ra), distanceKm * cd * Math.sin(ra), distanceKm * Math.sin(dec)]
}

/** Etat complet d'un corps pour un instant et un lieu. */
export function computeBodyState(def: BodyDefinition, date: Date, location: GeoLocation): BodyState {
  const observer = observerOf(location)
  const eqOfDate = A.Equator(def.body, date, observer, true, true)
  const equatorial: Equatorial = { ra: norm360(eqOfDate.ra * 15), dec: eqOfDate.dec }
  // Coordonnees horizontales **sans refraction**, pour coller exactement a la
  // geometrie de la scene : celle-ci place les corps depuis leur direction
  // equatorielle, qui ne connait pas l'atmosphere. Melanger les deux introduit
  // un ecart d'environ deux minutes d'arc a 25° de hauteur — invisible au champ
  // large, mais suffisant pour faire sortir une planete du cadre a fort
  // grossissement, et pour decaler les etiquettes de leurs objets.
  // La refraction sera introduite de facon coherente pour toutes les couches
  // — etoiles comprises — a l'etape 2 de la mission.
  //
  // La chaine vide est la facon documentee de la desactiver : `Horizon` teste
  // la veracite de son argument, et toute valeur non vide autre que « normal »
  // ou « jplhor » leve une erreur.
  const hor = A.Horizon(date, observer, eqOfDate.ra, eqOfDate.dec, '')

  const sunEq = A.Equator(A.Body.Sun, date, observer, true, true)
  const sunEquatorial: Equatorial = { ra: norm360(sunEq.ra * 15), dec: sunEq.dec }

  let magnitude = -26.74
  let illumination = 1
  if (def.id !== 'sun') {
    const illum = A.Illumination(def.body, date)
    magnitude = illum.mag
    illumination = illum.phase_fraction
  }

  const distanceAu = eqOfDate.dist
  const distanceKm = distanceAu * KM_PER_AU
  // Diametre apparent vu depuis l'observateur, rayon physique compris.
  const angularDiameter = 2 * Math.asin(Math.min(1, def.radiusKm / distanceKm)) * RAD
  const elongation = def.id === 'sun' ? 0 : angularSeparation(equatorial, sunEquatorial)

  // Geometrie 3D reelle : positions topocentriques, puis direction corps → Soleil.
  const positionEq = toVector(equatorial.ra, equatorial.dec, distanceKm)
  const sunPositionEq = toVector(sunEquatorial.ra, sunEquatorial.dec, sunEq.dist * KM_PER_AU)
  const dx = sunPositionEq[0] - positionEq[0]
  const dy = sunPositionEq[1] - positionEq[1]
  const dz = sunPositionEq[2] - positionEq[2]
  const dn = Math.hypot(dx, dy, dz) || 1

  return {
    id: def.id,
    name: def.name,
    equatorial,
    horizontal: { azimuth: hor.azimuth, altitude: hor.altitude },
    positionEq,
    sunDirectionEq: def.id === 'sun' ? [0, 0, 0] : [dx / dn, dy / dn, dz / dn],
    radiusKm: def.radiusKm,
    magnitude,
    distanceAu,
    distanceKm,
    angularDiameter,
    illumination,
    elongation,
    brightLimbAngle: def.id === 'sun' ? 0 : brightLimbAngle(equatorial, sunEquatorial, location, date),
    visible: hor.altitude > 0,
  }
}

/** Etats de tous les corps demandes. */
export function computeAllBodies(date: Date, location: GeoLocation, ids?: ReadonlySet<BodyId>): BodyState[] {
  return BODIES.filter((b) => !ids || ids.has(b.id)).map((b) => computeBodyState(b, date, location))
}

/** Lever, passage au meridien et coucher autour d'une date de reference. */
export function computeRiseSet(def: BodyDefinition, date: Date, location: GeoLocation): RiseSetInfo {
  const observer = observerOf(location)
  // On demarre 12 h avant pour encadrer l'instant courant.
  const start = new Date(date.getTime() - 12 * 3600 * 1000)
  const rise = A.SearchRiseSet(def.body, observer, +1, start, 2)
  const set = A.SearchRiseSet(def.body, observer, -1, start, 2)

  let transit: A.HourAngleEvent | null = null
  try {
    transit = A.SearchHourAngle(def.body, observer, 0, start)
  } catch {
    transit = null
  }

  // Sans lever ni coucher sur 48 h, le corps est soit circumpolaire soit toujours sous l'horizon.
  const neverCrosses = !rise && !set
  const eqNow = A.Equator(def.body, date, observer, true, true)
  const altNow = neverCrosses ? A.Horizon(date, observer, eqNow.ra, eqNow.dec, 'normal').altitude : 0

  return {
    rise: rise ? rise.date : null,
    set: set ? set.date : null,
    transit: transit ? transit.time.date : null,
    transitAltitude: transit ? transit.hor.altitude : null,
    circumpolar: neverCrosses && altNow > 0,
    alwaysBelow: neverCrosses && altNow <= 0,
  }
}

/**
 * Lever, culmination et coucher d'un objet fixe — etoile ou objet du ciel profond.
 *
 * `astronomy-engine` reserve huit emplacements d'astres definis par
 * l'utilisateur : on en occupe un le temps du calcul, ce qui donne acces aux
 * memes recherches d'evenements que pour les planetes, refraction et parallaxe
 * comprises. La distance declaree est arbitrairement lointaine : a mille
 * annees-lumiere, la parallaxe annuelle est nulle a la precision de l'affichage.
 */
export function computeFixedRiseSet(eqJ2000: Equatorial, date: Date, location: GeoLocation): RiseSetInfo {
  const observer = observerOf(location)
  const slot = A.Body.Star1
  // `DefineStar` attend l'ascension droite en heures sidérales, epoque J2000.
  A.DefineStar(slot, eqJ2000.ra / 15, eqJ2000.dec, 1000)

  const start = new Date(date.getTime() - 12 * 3600 * 1000)
  const rise = A.SearchRiseSet(slot, observer, +1, start, 2)
  const set = A.SearchRiseSet(slot, observer, -1, start, 2)

  let transit: A.HourAngleEvent | null = null
  try {
    transit = A.SearchHourAngle(slot, observer, 0, start)
  } catch {
    transit = null
  }

  const neverCrosses = !rise && !set
  const hor = equatorialToHorizontal(precessFromJ2000(eqJ2000, date), location, date)

  return {
    rise: rise ? rise.date : null,
    set: set ? set.date : null,
    transit: transit ? transit.time.date : null,
    transitAltitude: transit ? transit.hor.altitude : null,
    circumpolar: neverCrosses && hor.altitude > 0,
    alwaysBelow: neverCrosses && hor.altitude <= 0,
  }
}

export type MoonPhaseName =
  | 'Nouvelle lune'
  | 'Premier croissant'
  | 'Premier quartier'
  | 'Gibbeuse croissante'
  | 'Pleine lune'
  | 'Gibbeuse décroissante'
  | 'Dernier quartier'
  | 'Dernier croissant'

export interface MoonInfo {
  /** Angle de phase 0-360° (0 = nouvelle lune, 180 = pleine lune). */
  phaseAngle: number
  phaseName: MoonPhaseName
  illumination: number
  /** Age en jours depuis la derniere nouvelle lune. */
  ageDays: number
  /** Libration en longitude et latitude, degres. */
  librationLon: number
  librationLat: number
  distanceKm: number
  angularDiameter: number
  nextNewMoon: Date
  nextFullMoon: Date
}

const SYNODIC_MONTH = 29.530588853

export function phaseName(angle: number): MoonPhaseName {
  const a = norm360(angle)
  if (a < 11.25 || a >= 348.75) return 'Nouvelle lune'
  if (a < 78.75) return 'Premier croissant'
  if (a < 101.25) return 'Premier quartier'
  if (a < 168.75) return 'Gibbeuse croissante'
  if (a < 191.25) return 'Pleine lune'
  if (a < 258.75) return 'Gibbeuse décroissante'
  if (a < 281.25) return 'Dernier quartier'
  return 'Dernier croissant'
}

/** Donnees lunaires detaillees : phase, libration, prochaines syzygies. */
export function computeMoonInfo(date: Date): MoonInfo {
  const phaseAngle = A.MoonPhase(date)
  const illum = A.Illumination(A.Body.Moon, date)
  const lib = A.Libration(date)
  const newMoon = A.SearchMoonPhase(0, date, 40)
  const fullMoon = A.SearchMoonPhase(180, date, 40)

  return {
    phaseAngle,
    phaseName: phaseName(phaseAngle),
    illumination: illum.phase_fraction,
    ageDays: (phaseAngle / 360) * SYNODIC_MONTH,
    librationLon: lib.elon,
    librationLat: lib.elat,
    distanceKm: lib.dist_km,
    angularDiameter: lib.diam_deg,
    nextNewMoon: newMoon ? newMoon.date : date,
    nextFullMoon: fullMoon ? fullMoon.date : date,
  }
}

/**
 * Conditions d'observation. Le bilan lumineux est desormais entierement porte
 * par `skyLuminance` : hauteur du Soleil, clair de lune et occultation
 * eventuelle du disque solaire y sont traites d'un seul tenant.
 */
export const computeSkyConditions = skyLuminance
export type { SkyLuminance as SkyConditions, TwilightPhase } from './photometry'
