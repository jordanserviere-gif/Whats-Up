/**
 * Photometrie du ciel : eclairement, extinction atmospherique, magnitude
 * limite, et rendu des sources ponctuelles.
 *
 * Tout part d'une seule grandeur physique — l'eclairement horizontal en lux —
 * a laquelle contribuent le Soleil, la Lune et le fond de ciel. Le jour, la
 * nuit, les crepuscules, le clair de lune et l'assombrissement d'une eclipse
 * ne sont alors plus des cas particuliers : ce sont des valeurs sur une meme
 * echelle continue.
 */
import * as A from 'astronomy-engine'
import { DEG, RAD, norm360 } from './coords'
import type { GeoLocation } from './types'

/** Eclairement du fond de ciel sans Soleil ni Lune (airglow + lumiere stellaire). */
export const AIRGLOW_LUX = 2e-4

/** Eclairement d'une pleine lune au zenith, en lux. */
const FULL_MOON_LUX = 0.267
/** Magnitude visuelle de la pleine lune, reference de l'echelle ci-dessus. */
const FULL_MOON_MAG = -12.74

/**
 * Eclairement horizontal du a un Soleil non occulte, en lux, selon sa hauteur.
 * Points d'ancrage classiques de la litterature sur les crepuscules ;
 * l'interpolation se fait en logarithme, l'echelle couvrant neuf ordres de grandeur.
 */
const SOLAR_ANCHORS: ReadonlyArray<[altitudeDeg: number, lux: number]> = [
  // Sous -18°, le Soleil ne contribue plus : le fond de ciel est alors porte
  // par `AIRGLOW_LUX`, ajoute separement. Faire tendre cette courbe vers zero
  // evite de compter deux fois la lumiere de fond.
  [-90, 1e-6],
  [-24, 5e-6],
  [-18, 1.2e-4],
  [-12, 0.008],
  [-6, 3.4],
  [-0.833, 400],
  [5, 8000],
  [20, 34000],
  [45, 82000],
  [90, 120000],
]

/** Magnitude limite a l'oeil nu selon l'eclairement ambiant. */
const LIMIT_MAG_ANCHORS: ReadonlyArray<[lux: number, magnitude: number]> = [
  [0.0002, 6.6],
  [0.005, 5.2],
  [0.05, 4.2],
  [3.4, 2.0],
  [400, -1.5],
  [120000, -4.2],
]

/** Interpolation lineaire par morceaux sur des points d'ancrage tries. */
function interpolate(anchors: ReadonlyArray<readonly [number, number]>, x: number, logY: boolean): number {
  if (x <= anchors[0][0]) return anchors[0][1]
  const last = anchors[anchors.length - 1]
  if (x >= last[0]) return last[1]
  for (let i = 0; i + 1 < anchors.length; i++) {
    const [x0, y0] = anchors[i]
    const [x1, y1] = anchors[i + 1]
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0)
      if (!logY) return y0 + (y1 - y0) * t
      return Math.pow(10, Math.log10(y0) + (Math.log10(y1) - Math.log10(y0)) * t)
    }
  }
  return last[1]
}

/** Idem, mais l'abscisse elle-meme est parcourue en logarithme. */
function interpolateLogX(anchors: ReadonlyArray<readonly [number, number]>, x: number): number {
  const lx = Math.log10(Math.max(1e-9, x))
  const mapped = anchors.map(([a, b]) => [Math.log10(a), b] as const)
  return interpolate(mapped, lx, false)
}

export const solarIlluminance = (altitudeDeg: number) => interpolate(SOLAR_ANCHORS, altitudeDeg, true)

/**
 * Fraction du disque solaire masquee par la Lune.
 * Aire d'intersection de deux disques, rapportee a celle du Soleil.
 */
export function diskObscuration(separationDeg: number, sunRadiusDeg: number, moonRadiusDeg: number): number {
  const d = separationDeg
  const r1 = sunRadiusDeg
  const r2 = moonRadiusDeg
  if (d >= r1 + r2) return 0
  if (d <= Math.abs(r2 - r1)) return r2 >= r1 ? 1 : (r2 * r2) / (r1 * r1)

  const a1 = Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1))
  const a2 = Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2))
  const area =
    r1 * r1 * (a1 - Math.sin(2 * a1) / 2) + r2 * r2 * (a2 - Math.sin(2 * a2) / 2)
  return Math.min(1, area / (Math.PI * r1 * r1))
}

/** Masse d'air a l'horizon : plafond physique de la traversee atmospherique. */
export const AIRMASS_MAX = 40

/**
 * Masse d'air traversee a une hauteur donnee (formule de Pickering, 2002),
 * valable jusqu'a l'horizon contrairement a la simple secante.
 *
 * La hauteur est bornee a zero : sous l'horizon, l'argument du sinus s'annule
 * puis change de signe, et la formule renvoie l'infini puis des masses d'air
 * negatives. Une extinction negative rendrait les objets couches *plus*
 * brillants — ce qui, dans le nuanceur du champ d'etoiles, produisait un enorme
 * carre lumineux a la place d'une etoile rasante.
 */
export function airmass(altitudeDeg: number): number {
  const h = Math.max(altitudeDeg, 0)
  const am = 1 / Math.sin((h + 244 / (165 + 47 * Math.pow(h + 1e-3, 1.1))) * DEG)
  return Math.min(Math.max(am, 1), AIRMASS_MAX)
}

/** Coefficient d'extinction dans le visible, en magnitudes par masse d'air. */
export const EXTINCTION_COEFFICIENT = 0.28

/** Perte de magnitude due a la traversee de l'atmosphere. */
export const extinctionMagnitudes = (altitudeDeg: number) =>
  EXTINCTION_COEFFICIENT * Math.min(airmass(altitudeDeg), 12)

export interface SkyLuminance {
  /** Eclairement horizontal total, en lux. */
  illuminance: number
  /** Part due au Soleil, occultation comprise. */
  solarLux: number
  /** Part due a la Lune. */
  lunarLux: number
  sunAltitude: number
  sunAzimuth: number
  moonAltitude: number
  moonIllumination: number
  /** Fraction du Soleil masquee par la Lune : 1 pendant la totalite. */
  obscuration: number
  /** Magnitude la plus faible encore perceptible. */
  limitingMagnitude: number
  /** 0 = plein jour, 1 = nuit noire sans Lune. Pour piloter les fondus. */
  darkness: number
  twilight: TwilightPhase
}

export type TwilightPhase = 'jour' | 'crépuscule civil' | 'crépuscule nautique' | 'crépuscule astronomique' | 'nuit'

/** Magnitude visuelle de la Lune deduite de son angle de phase (Allen). */
function moonMagnitude(phaseAngleDeg: number): number {
  const phi = Math.min(170, Math.abs(phaseAngleDeg)) * DEG
  return FULL_MOON_MAG + 1.49 * phi + 0.043 * Math.pow(phi, 4)
}

/**
 * Bilan lumineux complet du ciel a un instant et un lieu.
 *
 * Une seule evaluation des ephemerides du Soleil et de la Lune suffit :
 * la fonction est appelee a chaque pas de la frise temporelle.
 */
export function skyLuminance(date: Date, location: GeoLocation): SkyLuminance {
  const observer = new A.Observer(location.latitude, location.longitude, location.elevation)

  const sunEq = A.Equator(A.Body.Sun, date, observer, true, true)
  const sunHor = A.Horizon(date, observer, sunEq.ra, sunEq.dec, 'normal')
  const moonEq = A.Equator(A.Body.Moon, date, observer, true, true)
  const moonHor = A.Horizon(date, observer, moonEq.ra, moonEq.dec, 'normal')

  // Rayons apparents topocentriques : ce sont eux qui decident d'une eclipse
  // totale ou annulaire.
  const sunRadiusDeg = Math.asin(696000 / (sunEq.dist * A.KM_PER_AU)) * RAD
  const moonRadiusDeg = Math.asin(1737.4 / (moonEq.dist * A.KM_PER_AU)) * RAD

  const separation = angularSeparationDeg(sunEq.ra * 15, sunEq.dec, moonEq.ra * 15, moonEq.dec)
  const obscuration = diskObscuration(separation, sunRadiusDeg, moonRadiusDeg)

  // Pendant la totalite, le ciel n'est pas noir : l'atmosphere hors de l'ombre
  // continue de diffuser. Le plancher de 8·10⁻⁴ ramene le plein jour au niveau
  // d'un crepuscule civil, ce qu'on observe reellement.
  const solarLux = solarIlluminance(sunHor.altitude) * (1 - obscuration + 8e-4 * obscuration)

  // Angle de phase lunaire : 0 = pleine lune vue de la Terre.
  const phaseAngle = 180 - separation
  const moonIllumination = (1 + Math.cos(phaseAngle * DEG)) / 2
  const lunarLux =
    moonHor.altitude > 0
      ? FULL_MOON_LUX *
        Math.pow(10, -0.4 * (moonMagnitude(phaseAngle) - FULL_MOON_MAG)) *
        Math.pow(Math.sin(moonHor.altitude * DEG), 0.8)
      : 0

  const illuminance = solarLux + lunarLux + AIRGLOW_LUX
  const h = sunHor.altitude
  const twilight: TwilightPhase =
    h > -0.833 ? 'jour' : h > -6 ? 'crépuscule civil' : h > -12 ? 'crépuscule nautique' : h > -18 ? 'crépuscule astronomique' : 'nuit'

  // L'obscurite ressentie suit le logarithme de l'eclairement : c'est ainsi que
  // l'oeil percoit les variations de luminosite.
  const darkness = Math.min(
    1,
    Math.max(0, (Math.log10(2e4) - Math.log10(illuminance)) / (Math.log10(2e4) - Math.log10(AIRGLOW_LUX))),
  )

  return {
    illuminance,
    solarLux,
    lunarLux,
    sunAltitude: sunHor.altitude,
    sunAzimuth: sunHor.azimuth,
    moonAltitude: moonHor.altitude,
    moonIllumination,
    obscuration,
    limitingMagnitude: interpolateLogX(LIMIT_MAG_ANCHORS, illuminance),
    darkness,
    twilight,
  }
}

/** Separation angulaire entre deux directions equatoriales, en degres. */
function angularSeparationDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d1 = dec1 * DEG
  const d2 = dec2 * DEG
  const dra = norm360(ra1 - ra2) * DEG
  return Math.acos(Math.min(1, Math.max(-1, Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(dra)))) * RAD
}

/** Diametre de rendu, en pixels, d'une source ponctuelle de magnitude donnee. */
export const POINT_BASE_SIZE_PX = 2.3

export function pointSizePixels(magnitude: number, limitingMagnitude: number): number {
  const rel = Math.pow(10, -0.4 * (magnitude - limitingMagnitude))
  if (rel <= 0.02) return 0
  return POINT_BASE_SIZE_PX * (0.7 + 0.55 * Math.log(1 + rel))
}

/** Opacite de rendu d'une source ponctuelle : elle s'eteint sous la limite. */
export function pointIntensity(magnitude: number, limitingMagnitude: number): number {
  const rel = Math.pow(10, -0.4 * (magnitude - limitingMagnitude))
  return Math.min(1, Math.max(0, 0.28 * Math.log(1 + rel)))
}

/**
 * Rougissement du a l'extinction : les objets bas sur l'horizon virent a l'orange.
 * Facteur multiplicatif par canal, normalise sur le vert.
 */
export function extinctionTint(altitudeDeg: number): [number, number, number] {
  const x = Math.min(airmass(altitudeDeg), 12) - 1
  return [1, Math.exp(-0.035 * x), Math.exp(-0.085 * x)]
}
