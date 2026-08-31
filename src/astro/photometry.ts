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
import { columnsToSpace } from '@/atmosphere/transport/slantPath'

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

/**
 * Pollution lumineuse — echelle de Bortle.
 *
 * Chaque classe est ancree sur la brillance du fond de ciel au zenith qu'elle
 * decrit, en magnitudes par seconde d'arc carree : c'est la grandeur qu'un
 * photometre de ciel mesure reellement, et elle se convertit directement en
 * eclairement par la meme relation que `skySurfaceBrightness`, en sens
 * inverse. La pollution n'est donc pas un effet visuel plaque par-dessus le
 * rendu : elle entre dans le bilan lumineux comme une source de plus, au meme
 * titre que le Soleil ou la Lune. Elle fait donc reculer la magnitude limite,
 * pâlir les objets etendus et eclaircir le ciel d'elle-meme.
 */
export const BORTLE_CLASSES: ReadonlyArray<{ readonly rank: number; readonly sqm: number; readonly label: string }> = [
  { rank: 1, sqm: 21.9, label: 'ciel noir' },
  { rank: 2, sqm: 21.8, label: 'site vierge' },
  { rank: 3, sqm: 21.5, label: 'ciel rural' },
  { rank: 4, sqm: 21.0, label: 'transition rurale' },
  { rank: 5, sqm: 20.4, label: 'périphérie' },
  { rank: 6, sqm: 19.3, label: 'banlieue lumineuse' },
  { rank: 7, sqm: 18.4, label: 'abords de ville' },
  { rank: 8, sqm: 17.5, label: 'ville' },
  { rank: 9, sqm: 16.8, label: 'centre-ville' },
]

/** Brillance du fond de ciel pour une classe de Bortle, interpolee entre les paliers. */
export function bortleSkyBrightness(rank: number): number {
  const first = BORTLE_CLASSES[0]
  const last = BORTLE_CLASSES[BORTLE_CLASSES.length - 1]
  if (rank <= first.rank) return first.sqm
  if (rank >= last.rank) return last.sqm
  const i = Math.min(BORTLE_CLASSES.length - 2, Math.floor(rank) - 1)
  const a = BORTLE_CLASSES[i]
  const b = BORTLE_CLASSES[i + 1]
  return a.sqm + (b.sqm - a.sqm) * ((rank - a.rank) / (b.rank - a.rank))
}

/**
 * Classe de Bortle correspondant a une brillance de fond mesuree — l'inverse
 * de `bortleSkyBrightness`.
 *
 * Le rang rendu est fractionnaire : une mesure reelle ne tombe pas sur un
 * palier rond, et l'arrondir perdrait de la precision pour rien puisque
 * `lightPollutionLux` interpole de toute facon. C'est ce qui permet d'asservir
 * le reglage a une mesure d'atlas — voir `data-sources/lightPollution.ts` —
 * sans passer par une echelle plus grossiere que la donnee.
 */
export function bortleFromSkyBrightness(sqm: number): number {
  const first = BORTLE_CLASSES[0]
  const last = BORTLE_CLASSES[BORTLE_CLASSES.length - 1]
  // La table decroit en brillance quand le rang monte : un ciel plus clair que
  // le premier palier reste classe 1, plus sombre que le dernier reste classe 9.
  if (sqm >= first.sqm) return first.rank
  if (sqm <= last.sqm) return last.rank
  for (let i = 0; i + 1 < BORTLE_CLASSES.length; i++) {
    const a = BORTLE_CLASSES[i]
    const b = BORTLE_CLASSES[i + 1]
    if (sqm >= b.sqm) return a.rank + (b.rank - a.rank) * ((a.sqm - sqm) / (a.sqm - b.sqm))
  }
  return last.rank
}

/** Libelle de la classe de Bortle la plus proche. */
export const bortleLabel = (rank: number) =>
  BORTLE_CLASSES[Math.min(BORTLE_CLASSES.length - 1, Math.max(0, Math.round(rank) - 1))].label

/**
 * Eclairement **ajoute** par la pollution lumineuse, en lux.
 *
 * L'airglow naturel est deja compte par `AIRGLOW_LUX` : on le retranche, de
 * sorte qu'un ciel de classe 1 ou 2 n'ajoute rien du tout et laisse le rendu
 * strictement identique a ce qu'il etait sans ce reglage.
 */
export function lightPollutionLux(rank: number): number {
  const excess = AIRGLOW_LUX * Math.pow(10, (21.8 - bortleSkyBrightness(rank)) / 2.5) - AIRGLOW_LUX
  return Math.max(0, excess)
}

/**
 * Magnitude limite a l'oeil nu deduite de la brillance du fond de ciel
 * (relation de Schaefer, 1990) — et non de l'eclairement horizontal.
 *
 * Les deux ne sont pas interchangeables, et c'est la tout le probleme. Sous la
 * Lune, l'essentiel de l'eclairement arrive **directement** de l'astre : une
 * pleine lune donne 0,27 lux au sol pour un fond de ciel autour de
 * 18 mag/arcsec². Une pollution lumineuse qui produirait le meme eclairement
 * l'obtiendrait presque entierement par le ciel lui-meme, donc avec un fond
 * bien plus clair et une magnitude limite bien plus basse. Les paliers en lux
 * de `LIMIT_MAG_ANCHORS` sont cales sur le premier regime ; ils surestimaient
 * de pres de deux magnitudes ce qu'on voit reellement depuis un centre-ville.
 */
export function limitingMagnitudeFromSkyBrightness(sqm: number): number {
  return 7.93 - 5 * Math.log10(Math.pow(10, 4.316 - sqm / 5) + 1)
}

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

/**
 * Plafond de la masse d'air.
 *
 * ⚠️ **Quarante etait la valeur rasante d'un observateur au niveau de la mer**,
 * et donc un plafond deguise en fait physique. Un observateur en hauteur voit
 * bien au-dela : depuis dix kilometres, une visee a moins trois degres — encore
 * au-dessus de son horizon, qui est a −3,01° — traverse **219** masses d'air.
 *
 * Le plafond ne sert plus qu'a empecher une divergence numerique quand le rayon
 * rase le sol, la ou la colonne tend vers l'infini. Trois cents couvre tout ce
 * qu'un observateur atmospherique peut rencontrer, et l'extinction y vaut deja
 * quatre-vingts magnitudes : rien n'y survit, ce qui est le resultat attendu.
 */
export const AIRMASS_MAX = 300

/**
 * Masse d'air traversee a une hauteur donnee, rapportee au zenith.
 *
 * ## Elle n'est plus une formule ajustee, mais la colonne que le moteur integre
 *
 * Pickering (2002) tenait jusqu'a l'horizon, et pas au-dela : sa hauteur etait
 * **bornee a zero**, faute de quoi l'argument du sinus change de signe et la
 * masse d'air devient negative — une extinction negative rendrait les objets
 * couches *plus* brillants.
 *
 * ⚠️ **Ce bornage supposait l'observateur au niveau de la mer.** Des qu'il
 * prend de la hauteur, son horizon descend — trois degres a dix kilometres — et
 * toute la bande entre l'horizontale et cet horizon reste parfaitement visible.
 * La formule y rendait une valeur figee, et l'ecart est considerable :
 *
 * | vue depuis 10 km | Pickering borne | colonne reelle |
 * | --- | --- | --- |
 * | 0° | 38,75 | 39,4 |
 * | −1° | **38,75** | **63,5** |
 * | −2° | **38,75** | **112,6** |
 * | −3° | **38,75** | **218,8** |
 *
 * La colonne du moteur, elle, connait la geometrie spherique et l'altitude de
 * l'observateur : elle rend l'infini quand le rayon rencontre le sol, et le
 * plafond s'en charge.
 *
 * ## Ce que le changement coute au niveau de la mer
 *
 * Rien de visible. Les deux modeles s'accordent a **0,3 %** jusqu'a dix degres,
 * et divergent ensuite jusqu'a 10 % a l'horizon — mais `extinctionMagnitudes`
 * plafonne deja a douze masses d'air, atteintes des quatre degres. Sous ce
 * plafond l'ecart maximal vaut 1,3 %, soit 0,04 magnitude.
 */
const airmassCache = new Map<number, Float64Array>()
const AIRMASS_SAMPLES = 512
const AIRMASS_FLOOR_DEG = -12

function airmassTable(observerElevationM: number): Float64Array {
  const key = Math.round(observerElevationM)
  const cached = airmassCache.get(key)
  if (cached) return cached
  const zenith = columnsToSpace(key, 1, 256).air
  const table = new Float64Array(AIRMASS_SAMPLES)
  for (let i = 0; i < AIRMASS_SAMPLES; i++) {
    const alt = AIRMASS_FLOOR_DEG + ((90 - AIRMASS_FLOOR_DEG) * i) / (AIRMASS_SAMPLES - 1)
    const column = columnsToSpace(key, Math.sin(alt * DEG), 256).air
    table[i] = zenith > 0 ? Math.min(Math.max(column / zenith, 1), AIRMASS_MAX) : 1
  }
  airmassCache.set(key, table)
  return table
}

export function airmass(altitudeDeg: number, observerElevationM = 0): number {
  const table = airmassTable(observerElevationM)
  const u = ((altitudeDeg - AIRMASS_FLOOR_DEG) / (90 - AIRMASS_FLOOR_DEG)) * (AIRMASS_SAMPLES - 1)
  if (!(u > 0)) return AIRMASS_MAX
  if (u >= AIRMASS_SAMPLES - 1) return table[AIRMASS_SAMPLES - 1]
  const i = Math.floor(u)
  const f = u - i
  return table[i] * (1 - f) + table[i + 1] * f
}

/**
 * Part moleculaire de l'extinction : diffusion Rayleigh et absorption par
 * l'ozone. Elle ne depend que de la quantite d'air traversee, donc de la
 * hauteur — jamais de la pollution.
 */
const MOLECULAR_EXTINCTION = 0.16
/** Part due aux aerosols, pour un site standard (trouble x1). */
const AEROSOL_EXTINCTION = 0.12

/** Coefficient d'extinction dans le visible, en magnitudes par masse d'air — air standard (trouble x1). */
export const EXTINCTION_COEFFICIENT = MOLECULAR_EXTINCTION + AEROSOL_EXTINCTION

/**
 * Perte de magnitude due a la traversee de l'atmosphere.
 *
 * `turbidity` est le meme trouble atmospherique (charge en aerosols) que celui
 * qui pilote la diffusion de Mie du ciel -- voir `mie/aerosol.ts` et
 * `scene/atmosphere.ts`. Un ciel charge en aerosols n'eclaircit pas que
 * l'horizon : il eteint aussi davantage les etoiles et les halos qui le
 * traversent, par le meme phenomene physique.
 *
 * Seule la part aerosol suit le trouble. Multiplier tout le coefficient par
 * lui, comme on le faisait, revenait a faire croitre la diffusion Rayleigh et
 * l'absorption de l'ozone avec la pollution : a trouble x3, le zenith perdait
 * 0,84 magnitude au lieu de 0,52. L'exces s'appliquait a toutes les hauteurs,
 * ce qui eteignait le ciel entier la ou seule la basse couche devait souffrir.
 */
/**
 * Perte de magnitude due a la traversee de l'atmosphere.
 *
 * ⚠️ **Le plafond de douze masses d'air a saute.** Il figeait l'extinction des
 * quatre degres de hauteur — 3,36 magnitudes, quelle que soit la suite — et
 * rendait donc **identiques** un astre a quatre degres et un astre au ras, ou
 * meme sous l'horizontale pour un observateur en altitude. C'etait le plus
 * restrictif de tous les bornages du moteur, et il annulait le reste.
 *
 * Sans lui, l'extinction suit la colonne jusqu'au bout : 9,8 magnitudes a
 * l'horizon d'un observateur au sol, ce qui eteint les etoiles avant qu'elles ne
 * l'atteignent — exactement ce qu'on observe. Le Soleil, lui, y survit
 * largement.
 */
export const extinctionMagnitudes = (altitudeDeg: number, turbidity = 1, observerElevationM = 0) =>
  (MOLECULAR_EXTINCTION + AEROSOL_EXTINCTION * turbidity) * airmass(altitudeDeg, observerElevationM)

export interface SkyLuminance {
  /** Eclairement horizontal total, en lux. */
  illuminance: number
  /** Part due au Soleil, occultation comprise. */
  solarLux: number
  /** Part due a la Lune. */
  lunarLux: number
  /** Part due a la pollution lumineuse, au-dela de l'airglow naturel. */
  pollutionLux: number
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
export function skyLuminance(date: Date, location: GeoLocation, pollutionLux = 0): SkyLuminance {
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

  // La pollution lumineuse est une source de plus dans le bilan, pas une
  // retouche du rendu : elle repousse donc la magnitude limite et efface les
  // objets etendus par le meme chemin que le clair de lune.
  const illuminance = solarLux + lunarLux + AIRGLOW_LUX + Math.max(0, pollutionLux)
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
    pollutionLux: Math.max(0, pollutionLux),
    sunAltitude: sunHor.altitude,
    sunAzimuth: sunHor.azimuth,
    moonAltitude: moonHor.altitude,
    moonIllumination,
    obscuration,
    // Deux regimes, chacun avec sa loi, et c'est le plus contraignant qui
    // decide : l'eclairement direct (Soleil, Lune) passe par les paliers en
    // lux, la pollution lumineuse par la brillance de fond qu'elle impose. Un
    // site vierge n'active pas le second — sa classe donne 6,6, soit deja plus
    // que ce que le premier autorise.
    limitingMagnitude:
      pollutionLux > 0
        ? Math.min(
            interpolateLogX(LIMIT_MAG_ANCHORS, illuminance),
            limitingMagnitudeFromSkyBrightness(skySurfaceBrightness(AIRGLOW_LUX + pollutionLux)),
          )
        : interpolateLogX(LIMIT_MAG_ANCHORS, illuminance),
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

/**
 * Brillance de surface d'un objet etendu, en magnitudes par seconde d'arc carree.
 *
 * Une galaxie de magnitude 3,4 etalee sur trois degres n'a rien de commun avec
 * une etoile de magnitude 3,4 : c'est la brillance de surface, et non la
 * magnitude integree, qui decide de ce qu'on percoit. M31 tourne autour de
 * 22 mag/arcsec², soit a peine sous le fond de ciel d'un site noir — d'ou le
 * fait qu'on n'en voie que le noyau a l'oeil nu.
 *
 * `majorArcmin` et `minorArcmin` sont les axes complets, pas les demi-axes.
 */
export function surfaceBrightness(magnitude: number, majorArcmin: number, minorArcmin: number): number | null {
  if (!(majorArcmin > 0)) return null
  const minor = minorArcmin > 0 ? minorArcmin : majorArcmin
  // Aire de l'ellipse, en secondes d'arc carrees.
  const area = Math.PI * (majorArcmin * 30) * (minor * 30)
  return magnitude + 2.5 * Math.log10(area)
}

/**
 * Brillance de surface du fond de ciel, deduite de l'eclairement.
 *
 * Ancree sur 21,8 mag/arcsec² pour un ciel naturel sans Lune, valeur de
 * reference d'un site noir, et prolongee en logarithme : cinq magnitudes par
 * facteur cent d'eclairement.
 */
export function skySurfaceBrightness(illuminance: number): number {
  return 21.8 - 2.5 * Math.log10(Math.max(1e-6, illuminance) / AIRGLOW_LUX)
}

/** Diametre de rendu, en pixels, d'une source ponctuelle de magnitude donnee. */
export const POINT_BASE_SIZE_PX = 2.3

export function pointSizePixels(magnitude: number, limitingMagnitude: number): number {
  const rel = Math.pow(10, -0.4 * (magnitude - limitingMagnitude))
  if (rel <= 0.02) return 0
  return POINT_BASE_SIZE_PX * (0.7 + 0.55 * Math.log(1 + rel))
}

/** Echelle de la dynamique d'eclat des sources ponctuelles. */
export const POINT_BRIGHTNESS_SCALE = 0.28
/**
 * Seuil de perception, en magnitudes relatives a la limite.
 *
 * La magnitude limite n'est pas une valeur ou l'etoile brille encore : c'est
 * par definition celle ou elle cesse d'etre percue. La seule courbe
 * logarithmique laissait pourtant une etoile quatre magnitudes plus faible
 * encore dessinee a un demi pour cent d'opacite — invisible seule, mais
 * multipliee par les milliers d'entrees d'un catalogue, elle constellait
 * d'etoiles un ciel de centre-ville qui aurait du n'en montrer qu'une
 * poignee.
 *
 * D'ou ce seuil, applique **par-dessus** la courbe logarithmique plutot qu'a
 * sa place : le logarithme garde la dynamique entre une etoile de premiere
 * grandeur et une de quatrieme, le seuil se charge d'eteindre franchement ce
 * qui passe sous la limite. Une magnitude au-dessus d'elle l'etoile est encore
 * pleine, a la limite elle n'est plus qu'un soupcon, une demi-magnitude en
 * dessous elle n'est plus la du tout.
 */
export const POINT_VISIBILITY_FADE_START = -1
export const POINT_VISIBILITY_FADE_END = 0.5

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Opacite de rendu d'une source ponctuelle : elle s'eteint sous la limite.
 *
 * Le champ d'etoiles et le ciel profond refont ce calcul dans leurs nuanceurs,
 * pour l'appliquer par point sans repasser par le processeur — les constantes
 * ci-dessus y sont injectees telles quelles, de sorte que les courbes ne
 * puissent pas diverger.
 */
export function pointIntensity(magnitude: number, limitingMagnitude: number): number {
  const delta = magnitude - limitingMagnitude
  const rel = Math.pow(10, -0.4 * delta)
  const gate = 1 - smoothstep(POINT_VISIBILITY_FADE_START, POINT_VISIBILITY_FADE_END, delta)
  return Math.min(1, Math.max(0, POINT_BRIGHTNESS_SCALE * Math.log(1 + rel) * gate))
}

/**
 * Rougissement du a l'extinction : les objets bas sur l'horizon virent a l'orange.
 * Facteur multiplicatif par canal, normalise sur le vert.
 */
export function extinctionTint(altitudeDeg: number, observerElevationM = 0): [number, number, number] {
  // Meme raison qu'au-dessus : le plafond de douze figeait la teinte des quatre
  // degres, alors que le rougissement continue de croitre jusqu'a l'horizon.
  const x = airmass(altitudeDeg, observerElevationM) - 1
  return [1, Math.exp(-0.035 * x), Math.exp(-0.085 * x)]
}
