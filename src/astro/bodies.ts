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
import {
  apparentFromTable,
  isRefractionEnabled,
  isVisible,
  sharedRefractionTable,
} from '@/atmosphere/refraction/refractionTable'
import { skyLuminance } from './photometry'
import { hgMagnitude, J2000_JD, minorHelio, minorTable, moonOffset, type Vec3 } from './minorBodies'
import type { BodyId, BodyState, Equatorial, GeoLocation, RiseSetInfo } from './types'

/** Famille d'un corps, pour les listes et la recherche. */
export type BodyCategory = 'etoile' | 'planete' | 'satellite' | 'naine' | 'asteroide'

export interface BodyDefinition {
  id: BodyId
  name: string
  category: BodyCategory
  /**
   * Comment le corps se calcule :
   * - `engine` : astronomy-engine, directement ;
   * - `galilean` : `JupiterMoons` ;
   * - `moon` : elements planetocentriques ajustes sur Horizons — `minorBodies.ts` ;
   * - `minor` : table d'etats heliocentriques d'Horizons — `minorBodies.ts`.
   */
  model: 'engine' | 'galilean' | 'moon' | 'minor'
  /**
   * Corps d'astronomy-engine qui porte lever, coucher et culmination. Pour un
   * satellite, celui de sa planete ; pour un petit corps, aucun n'existe — voir
   * `computeRiseSet`.
   */
  body: A.Body
  /** Rayon equatorial en km, pour le diametre apparent. */
  radiusKm: number
  colorToken: string
  /** Ordre d'affichage dans les listes. */
  order: number
  /**
   * Planete autour de laquelle le corps tourne — les satellites galileens.
   *
   * ⚠️ `body` vaut alors celui de la planete : astronomy-engine ne connait pas
   * les satellites comme des corps, seulement leur position relative. Tout ce
   * qui passe par `body` — lever, coucher, culmination — rend donc ceux de
   * Jupiter, a dix minutes d'arc pres : a l'echelle d'un horaire, c'est la meme
   * chose. La position, la magnitude et l'eclipse sont, elles, calculees pour
   * le satellite.
   */
  parent?: BodyId
}

/** Un satellite calcule par ses elements : magnitude moyenne a l'opposition, rayon moyen. */
function moonDef(id: BodyId, name: string, parent: BodyId, body: A.Body, radiusKm: number, order: number, colorToken = '--app-body-satellite-minor'): BodyDefinition {
  return { id, name, category: 'satellite', model: 'moon', body, radiusKm, colorToken, order, parent }
}

function minorDef(id: BodyId, name: string, category: 'naine' | 'asteroide', radiusKm: number, order: number): BodyDefinition {
  return { id, name, category, model: 'minor', body: A.Body.Sun, radiusKm, colorToken: category === 'naine' ? '--app-body-dwarf' : '--app-body-asteroid', order }
}

export const BODIES: readonly BodyDefinition[] = [
  { id: 'sun', name: 'Soleil', category: 'etoile', model: 'engine', body: A.Body.Sun, radiusKm: 695700, colorToken: '--app-body-sun', order: 0 },
  { id: 'moon', name: 'Lune', category: 'satellite', model: 'engine', body: A.Body.Moon, radiusKm: 1737.4, colorToken: '--app-body-moon', order: 1 },
  { id: 'mercury', name: 'Mercure', category: 'planete', model: 'engine', body: A.Body.Mercury, radiusKm: 2439.7, colorToken: '--app-body-mercury', order: 2 },
  { id: 'venus', name: 'Vénus', category: 'planete', model: 'engine', body: A.Body.Venus, radiusKm: 6051.8, colorToken: '--app-body-venus', order: 3 },
  { id: 'mars', name: 'Mars', category: 'planete', model: 'engine', body: A.Body.Mars, radiusKm: 3389.5, colorToken: '--app-body-mars', order: 4 },
  { id: 'jupiter', name: 'Jupiter', category: 'planete', model: 'engine', body: A.Body.Jupiter, radiusKm: 69911, colorToken: '--app-body-jupiter', order: 5 },
  { id: 'saturn', name: 'Saturne', category: 'planete', model: 'engine', body: A.Body.Saturn, radiusKm: 58232, colorToken: '--app-body-saturn', order: 6 },
  { id: 'uranus', name: 'Uranus', category: 'planete', model: 'engine', body: A.Body.Uranus, radiusKm: 25362, colorToken: '--app-body-uranus', order: 7 },
  { id: 'neptune', name: 'Neptune', category: 'planete', model: 'engine', body: A.Body.Neptune, radiusKm: 24622, colorToken: '--app-body-neptune', order: 8 },
  { id: 'pluto', name: 'Pluton', category: 'naine', model: 'engine', body: A.Body.Pluto, radiusKm: 1188.3, colorToken: '--app-body-pluto', order: 9 },
  // Rayons moyens, NASA Planetary Fact Sheet.
  { id: 'io', name: 'Io', category: 'satellite', model: 'galilean', body: A.Body.Jupiter, radiusKm: 1821.6, colorToken: '--app-body-io', order: 10, parent: 'jupiter' },
  { id: 'europa', name: 'Europe', category: 'satellite', model: 'galilean', body: A.Body.Jupiter, radiusKm: 1560.8, colorToken: '--app-body-europa', order: 11, parent: 'jupiter' },
  { id: 'ganymede', name: 'Ganymède', category: 'satellite', model: 'galilean', body: A.Body.Jupiter, radiusKm: 2634.1, colorToken: '--app-body-ganymede', order: 12, parent: 'jupiter' },
  { id: 'callisto', name: 'Callisto', category: 'satellite', model: 'galilean', body: A.Body.Jupiter, radiusKm: 2410.3, colorToken: '--app-body-callisto', order: 13, parent: 'jupiter' },
  // Satellites calcules par leurs elements — rayons moyens du JPL (« Planetary
  // Satellite Physical Parameters »).
  moonDef('phobos', 'Phobos', 'mars', A.Body.Mars, 11.08, 14),
  moonDef('deimos', 'Déimos', 'mars', A.Body.Mars, 6.2, 15),
  moonDef('amalthea', 'Amalthée', 'jupiter', A.Body.Jupiter, 83.5, 16),
  moonDef('thebe', 'Thébé', 'jupiter', A.Body.Jupiter, 49.3, 17),
  moonDef('himalia', 'Himalia', 'jupiter', A.Body.Jupiter, 85, 18),
  moonDef('elara', 'Élara', 'jupiter', A.Body.Jupiter, 43, 19),
  moonDef('mimas', 'Mimas', 'saturn', A.Body.Saturn, 198.2, 20),
  moonDef('enceladus', 'Encelade', 'saturn', A.Body.Saturn, 252.1, 21),
  moonDef('tethys', 'Téthys', 'saturn', A.Body.Saturn, 531.1, 22),
  moonDef('dione', 'Dioné', 'saturn', A.Body.Saturn, 561.4, 23),
  moonDef('rhea', 'Rhéa', 'saturn', A.Body.Saturn, 763.5, 24),
  moonDef('titan', 'Titan', 'saturn', A.Body.Saturn, 2574.76, 25, '--app-body-titan'),
  moonDef('hyperion', 'Hypérion', 'saturn', A.Body.Saturn, 135, 26),
  moonDef('iapetus', 'Japet', 'saturn', A.Body.Saturn, 734.3, 27),
  moonDef('phoebe', 'Phœbé', 'saturn', A.Body.Saturn, 106.5, 28),
  moonDef('miranda', 'Miranda', 'uranus', A.Body.Uranus, 235.8, 29),
  moonDef('ariel', 'Ariel', 'uranus', A.Body.Uranus, 578.9, 30),
  moonDef('umbriel', 'Umbriel', 'uranus', A.Body.Uranus, 584.7, 31),
  moonDef('titania', 'Titania', 'uranus', A.Body.Uranus, 788.9, 32),
  moonDef('oberon', 'Obéron', 'uranus', A.Body.Uranus, 761.4, 33),
  moonDef('triton', 'Triton', 'neptune', A.Body.Neptune, 1352.6, 34),
  moonDef('nereid', 'Néréide', 'neptune', A.Body.Neptune, 170, 35),
  moonDef('charon', 'Charon', 'pluto', A.Body.Pluto, 606, 36),
  // Planetes naines et gros asteroides — diametres SBDB, ou publies pour les
  // transneptuniens que la base ne renseigne pas.
  minorDef('ceres', 'Cérès', 'naine', 469.7, 37),
  minorDef('eris', 'Éris', 'naine', 1163, 38),
  minorDef('haumea', 'Hauméa', 'naine', 798, 39),
  minorDef('makemake', 'Makémaké', 'naine', 715, 40),
  minorDef('gonggong', 'Gonggong', 'naine', 615, 41),
  minorDef('quaoar', 'Quaoar', 'naine', 555, 42),
  minorDef('sedna', 'Sedna', 'naine', 498, 43),
  minorDef('orcus', 'Orcus', 'naine', 455, 44),
  minorDef('vesta', 'Vesta', 'asteroide', 261.4, 45),
  minorDef('pallas', 'Pallas', 'asteroide', 256.5, 46),
  minorDef('juno', 'Junon', 'asteroide', 123.3, 47),
  minorDef('hygiea', 'Hygie', 'asteroide', 203.6, 48),
]

export const BODY_BY_ID = new Map(BODIES.map((b) => [b.id, b]))

const KM_PER_AU = A.KM_PER_AU

/**
 * Magnitude absolue H : magnitude qu'aurait le corps a 1 UA du Soleil et de
 * l'observateur, a phase nulle (disque plein, faisant face au Soleil). C'est
 * la convention des corps qui ne font que reflechir la lumiere solaire — donc
 * tout ce qui suit, le Soleil excepte.
 *
 * Les valeurs sont le terme constant du modele photometrique d'astronomy-engine
 * (le coefficient d'ordre zero de son polynome de phase, qui est exactement H
 * par construction), a deux exceptions pres :
 *  - Saturne : globe seul, sans les anneaux. Leur eclat depend de leur
 *    inclinaison apparente, une geometrie d'observation et non une propriete
 *    intrinseque du corps — l'inclure aurait fait varier H avec la date.
 *  - Lune : son modele interne normalise la distance a la moyenne Terre-Lune,
 *    pas a l'unite astronomique reelle ; -12.717 y devient donc +0.23 une fois
 *    ramene a 1 UA, ce qui rejoint les valeurs publiees (+0,2 a +0,3).
 */
const ABSOLUTE_MAGNITUDE_H: Partial<Record<BodyId, number>> = {
  mercury: -0.6,
  venus: -4.47,
  mars: -1.52,
  jupiter: -9.4,
  saturn: -9.0,
  uranus: -7.19,
  neptune: -6.87,
  pluto: -1.0,
  moon: 0.23,
  // Satellites galileens, V(1,0) — magnitude a 1 UA du Soleil et de
  // l'observateur, phase nulle (Explanatory Supplement to the Astronomical
  // Almanac, 3e ed., tableau 10.6).
  io: -1.68,
  europa: -1.41,
  ganymede: -2.09,
  callisto: -1.05,
  ...satelliteH(),
}

/**
 * Magnitudes absolues des autres satellites, deduites de leur magnitude moyenne
 * a l'opposition (JPL, « Planetary Satellite Physical Parameters ») :
 * `H = V₀ − 5·log10[a·(a − 1)]`, `a` etant le demi-grand axe de la planete — sa
 * distance au Soleil, et a la Terre moins une unite, a l'opposition moyenne.
 *
 * Japet a deux faces, l'une sombre, l'autre claire : sa magnitude va de 10,2 a
 * 11,9 selon le cote qu'il presente. On garde la moyenne.
 */
function satelliteH(): Partial<Record<BodyId, number>> {
  const planetA: Partial<Record<BodyId, number>> = { mars: 1.5237, jupiter: 5.2026, saturn: 9.5549, uranus: 19.2184, neptune: 30.1104, pluto: 39.48 }
  const v0: Array<[BodyId, BodyId, number]> = [
    ['phobos', 'mars', 11.4],
    ['deimos', 'mars', 12.5],
    ['amalthea', 'jupiter', 14.1],
    ['thebe', 'jupiter', 16.0],
    ['himalia', 'jupiter', 14.6],
    ['elara', 'jupiter', 16.3],
    ['mimas', 'saturn', 12.9],
    ['enceladus', 'saturn', 11.7],
    ['tethys', 'saturn', 10.2],
    ['dione', 'saturn', 10.4],
    ['rhea', 'saturn', 9.7],
    ['titan', 'saturn', 8.4],
    ['hyperion', 'saturn', 14.4],
    ['iapetus', 'saturn', 11.0],
    ['phoebe', 'saturn', 16.4],
    ['miranda', 'uranus', 15.8],
    ['ariel', 'uranus', 13.7],
    ['umbriel', 'uranus', 14.5],
    ['titania', 'uranus', 13.5],
    ['oberon', 'uranus', 13.7],
    ['triton', 'neptune', 13.5],
    ['nereid', 'neptune', 18.7],
    ['charon', 'pluto', 16.8],
  ]
  const out: Partial<Record<BodyId, number>> = {}
  for (const [id, parent, v] of v0) {
    const a = planetA[parent]!
    out[id] = v - 5 * Math.log10(a * (a - 1))
  }
  return out
}

/** Vitesse de la lumiere, UA par jour. */
const C_AU_PER_DAY = 173.144632674

/** Rayons equatoriaux des planetes, km — ce sont eux qui bordent l'ombre et le disque. */
const EQUATORIAL_RADIUS_KM: Partial<Record<BodyId, number>> = {
  mars: 3396.2,
  jupiter: 71492,
  saturn: 60268,
  uranus: 25559,
  neptune: 24764,
  pluto: 1188.3,
}

/**
 * Magnitude d'un satellite eclipse : assez faible pour qu'aucun calque ne le
 * dessine, finie pour ne pas empoisonner les calculs qui la lisent.
 */
const ECLIPSED_MAGNITUDE = 99

/**
 * Position et eclat d'un satellite.
 *
 * ## La position
 *
 * Le vecteur planetocentrique, repere J2000, vient de `JupiterMoons` pour les
 * galileens, des elements ajustes sur Horizons pour les autres. On le prend a
 * l'instant ou la lumiere **quitte** le systeme — une quarantaine de minutes
 * plus tot pour Jupiter, quatre heures pour Neptune : Io parcourt en ce temps
 * pres d'un degre de son orbite. Il est ensuite tourne dans le repere de la
 * date et ajoute a la position topocentrique apparente de la planete,
 * aberration comprise, que les deux partagent.
 *
 * ## L'eclat
 *
 * `H + 5·log10(r·Δ)`, avec les distances de la planete. L'effet de phase est
 * neglige : vu de la Terre, l'angle de phase ne depasse pas douze degres au-dela
 * de Mars.
 *
 * ## L'eclipse, l'occultation
 *
 * Dans l'ombre de la planete, un satellite ne recoit plus rien et disparait —
 * c'est ce qu'on observe, a quelques minutes pres, dans une petite lunette.
 * L'ombre est un cylindre du rayon equatorial : son cone ne retrecit que de
 * quelques pour cent a l'orbite des satellites. Derriere le disque de la
 * planete, vu de la Terre, il disparait aussi.
 */
function satelliteGeometry(def: BodyDefinition, date: Date, observer: A.Observer) {
  const parent = BODY_BY_ID.get(def.parent!)!
  const par = A.Equator(parent.body, date, observer, true, true)
  const lightTimeDays = par.dist / C_AU_PER_DAY
  const emitted = new Date(date.getTime() - lightTimeDays * 86_400_000)
  let sv: Vec3
  if (def.model === 'galilean') {
    const m = A.JupiterMoons(emitted)[def.id as 'io' | 'europa' | 'ganymede' | 'callisto']
    sv = [m.x, m.y, m.z]
  } else {
    sv = moonOffset(def.id, A.MakeTime(emitted).tt + J2000_JD)
  }
  const ofDate = A.RotateVector(A.Rotation_EQJ_EQD(date), new A.Vector(sv[0], sv[1], sv[2], A.MakeTime(date)))

  const ra = par.ra * 15 * DEG
  const dec = par.dec * DEG
  const px0 = par.dist * Math.cos(dec) * Math.cos(ra)
  const py0 = par.dist * Math.cos(dec) * Math.sin(ra)
  const pz0 = par.dist * Math.sin(dec)
  const x = px0 + ofDate.x
  const y = py0 + ofDate.y
  const z = pz0 + ofDate.z
  const dist = Math.hypot(x, y, z)
  const equatorial: Equatorial = { ra: norm360(Math.atan2(y, x) * RAD), dec: Math.asin(z / dist) * RAD }
  const radiusKm = EQUATORIAL_RADIUS_KM[parent.id] ?? parent.radiusKm

  // Ombre : direction Soleil → planete, dans le repere J2000 ou le vecteur du
  // satellite est donne.
  const helio = A.HelioVector(parent.body, emitted)
  const hn = Math.hypot(helio.x, helio.y, helio.z)
  const ux = helio.x / hn
  const uy = helio.y / hn
  const uz = helio.z / hn
  const along = sv[0] * ux + sv[1] * uy + sv[2] * uz
  const qx = sv[0] - along * ux
  const qy = sv[1] - along * uy
  const qz = sv[2] - along * uz
  const eclipsed = along > 0 && Math.hypot(qx, qy, qz) * KM_PER_AU < radiusKm

  // Occultation : plus loin que la planete, et dans son disque apparent.
  const cosSep = (x * px0 + y * py0 + z * pz0) / (dist * par.dist)
  const parentRadiusRad = Math.asin(Math.min(1, radiusKm / (par.dist * KM_PER_AU)))
  const occulted = dist > par.dist && Math.acos(Math.min(1, cosSep)) < parentRadiusRad

  const h = ABSOLUTE_MAGNITUDE_H[def.id] ?? 15
  const hidden = eclipsed || occulted
  const magnitude = hidden ? ECLIPSED_MAGNITUDE : h + 5 * Math.log10(hn * dist)
  return { equatorial, distanceAu: dist, magnitude, eclipsed: hidden, parentBody: parent.body }
}

/**
 * Position et eclat d'une planete naine ou d'un asteroide.
 *
 * La position heliocentrique vient de la table d'Horizons ; la position
 * geocentrique s'en deduit, temps de lumiere itere et observateur compris —
 * a un milliard de kilometres, la parallaxe ne compte plus, mais Vesta passe
 * parfois a moins de deux cents millions. Repere J2000 tourne dans celui de la
 * date, aberration annuelle comprise.
 *
 * L'eclat suit le systeme H-G de l'UAI : il remonte pres de l'opposition.
 */
function minorGeometry(def: BodyDefinition, date: Date, observer: A.Observer) {
  const time = A.MakeTime(date)
  const earth = A.HelioVector(A.Body.Earth, date)
  const obs = A.ObserverVector(date, observer, false)
  const ox = earth.x + obs.x
  const oy = earth.y + obs.y
  const oz = earth.z + obs.z
  let tau = 0
  let helio: Vec3 = [0, 0, 0]
  let geo: Vec3 = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    helio = minorHelio(def.id, time.tt + J2000_JD - tau)
    geo = [helio[0] - ox, helio[1] - oy, helio[2] - oz]
    tau = Math.hypot(...geo) / C_AU_PER_DAY
  }
  const dist = Math.hypot(...geo)
  const r = Math.hypot(...helio)
  const j2000: Equatorial = { ra: norm360(Math.atan2(geo[1], geo[0]) * RAD), dec: Math.asin(geo[2] / dist) * RAD }
  // Aberration annuelle : la direction vue se penche de v/c dans le sens du
  // mouvement de la Terre — vingt secondes d'arc, comme pour les planetes.
  const earthState = A.HelioState(A.Body.Earth, date)
  const ax = geo[0] / dist + earthState.vx / C_AU_PER_DAY
  const ay = geo[1] / dist + earthState.vy / C_AU_PER_DAY
  const az = geo[2] / dist + earthState.vz / C_AU_PER_DAY
  const ofDate = A.RotateVector(A.Rotation_EQJ_EQD(date), new A.Vector(ax, ay, az, time))
  const an = Math.hypot(ofDate.x, ofDate.y, ofDate.z)
  const equatorial: Equatorial = { ra: norm360(Math.atan2(ofDate.y, ofDate.x) * RAD), dec: Math.asin(ofDate.z / an) * RAD }
  const cosPhase = (helio[0] * geo[0] + helio[1] * geo[1] + helio[2] * geo[2]) / (r * dist)
  const phase = Math.acos(Math.max(-1, Math.min(1, cosPhase)))
  const table = minorTable(def.id)
  const magnitude = table ? hgMagnitude(table.H, table.G, r, dist, phase) : 20
  return { equatorial, j2000, distanceAu: dist, magnitude, illumination: (1 + Math.cos(phase)) / 2, absolute: table?.H ?? null }
}

/** Position J2000 apparente d'un petit corps — pour son lever et son coucher. */
export function minorEquatorialJ2000(def: BodyDefinition, date: Date, location: GeoLocation): Equatorial {
  return minorGeometry(def, date, observerOf(location)).j2000
}

/**
 * Magnitude absolue du Soleil, convention stellaire (a 10 parsecs) — la meme
 * que celle des etoiles du catalogue, puisque le Soleil en est une. Valeur
 * nominale adoptee par l'UAI (resolution B2, 2015).
 */
const SUN_ABSOLUTE_MAGNITUDE = 4.83

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
  const satellite = def.model === 'galilean' || def.model === 'moon' ? satelliteGeometry(def, date, observer) : null
  const minor = def.model === 'minor' ? minorGeometry(def, date, observer) : null
  const derived = satellite ?? minor
  const planet = derived ? null : A.Equator(def.body, date, observer, true, true)
  const eqOfDate = derived
    ? { ra: derived.equatorial.ra / 15, dec: derived.equatorial.dec, dist: derived.distanceAu }
    : planet!
  const equatorial: Equatorial = { ra: norm360(eqOfDate.ra * 15), dec: eqOfDate.dec }
  // --- Coordonnees horizontales, refractees par le moteur ------------------
  //
  // `A.Horizon` est appele **sans refraction** — la chaine vide est la facon
  // documentee de la desactiver — puis la refraction du moteur est appliquee.
  // Ce n'est pas un detour : la formule interne de la bibliotheque est un
  // ajustement empirique, la notre sort de l'integrale le long du rayon dans un
  // profil d'indice de Ciddor. Les faire cohabiter donnerait deux refractions
  // differentes dans la meme image.
  //
  // La meme table sert au placement des astres, des etoiles, du ciel profond et
  // des constellations — voir `scene/refractionTexture.ts`. C'est cette unicite
  // qui evite qu'une planete se detache de son champ d'etoiles pres de
  // l'horizon.
  const rawHorizon = A.Horizon(date, observer, eqOfDate.ra, eqOfDate.dec, '')
  const refraction = sharedRefractionTable(location.elevation)
  const hor = {
    azimuth: rawHorizon.azimuth,
    // L'azimut est inchange : la refraction ne depend que de la hauteur dans une
    // atmosphere a stratification spherique.
    altitude: isRefractionEnabled()
      ? apparentFromTable(refraction, rawHorizon.altitude)
      : rawHorizon.altitude,
  }

  const sunEq = A.Equator(A.Body.Sun, date, observer, true, true)
  const sunEquatorial: Equatorial = { ra: norm360(sunEq.ra * 15), dec: sunEq.dec }

  let magnitude = -26.74
  let illumination = 1
  let ringTiltDeg: number | null = null
  if (satellite) {
    magnitude = satellite.magnitude
    // Vus de la Terre, les satellites ont la phase de leur planete.
    illumination = A.Illumination(satellite.parentBody, date).phase_fraction
  } else if (minor) {
    magnitude = minor.magnitude
    illumination = minor.illumination
  } else if (def.id !== 'sun') {
    const illum = A.Illumination(def.body, date)
    magnitude = illum.mag
    illumination = illum.phase_fraction
    if (illum.ring_tilt !== undefined) ringTiltDeg = illum.ring_tilt
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
    trueAltitude: rawHorizon.altitude,
    positionEq,
    sunDirectionEq: def.id === 'sun' ? [0, 0, 0] : [dx / dn, dy / dn, dz / dn],
    radiusKm: def.radiusKm,
    magnitude,
    absoluteMagnitude: def.id === 'sun' ? SUN_ABSOLUTE_MAGNITUDE : (minor?.absolute ?? ABSOLUTE_MAGNITUDE_H[def.id] ?? magnitude),
    distanceAu,
    distanceKm,
    angularDiameter,
    illumination,
    elongation,
    brightLimbAngle: def.id === 'sun' ? 0 : brightLimbAngle(equatorial, sunEquatorial, location, date),
    ringTiltDeg,
    // Un astre est visible des que sa hauteur **vraie** depasse −33 minutes
    // d'arc : c'est ce qui fait lever le Soleil avant qu'il ne soit leve.
    visible: isRefractionEnabled() ? isVisible(refraction, rawHorizon.altitude) : rawHorizon.altitude > 0,
  }
}

/**
 * Corps dont l'opposition (superieur) ou la conjonction inferieure (inferieur)
 * a un sens : ni le Soleil, qui n'orbite personne depuis la Terre, ni la Lune,
 * dont le cycle correspondant est deja la phase.
 */
const RELATIVE_LONGITUDE_BODIES = new Set<BodyId>([
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
])

const INFERIOR_BODIES = new Set<BodyId>(['mercury', 'venus'])

export interface RelativeLongitudeEvent {
  date: Date
  /** Superieur : le corps se leve au coucher du Soleil, visible toute la nuit.
   *  Inferieur : le corps passe entre la Terre et le Soleil, invisible. */
  kind: 'opposition' | 'conjonction inférieure'
}

/**
 * Prochaine opposition (planete superieure) ou conjonction inferieure (Mercure,
 * Venus) suivant la date donnee. `null` pour le Soleil et la Lune.
 *
 * Un seul appel a `SearchRelativeLongitude(body, 0, date)` couvre les deux cas :
 * c'est la definition meme de l'angle relatif nul, cote oppose du Soleil pour
 * une superieure, meme cote pour une inferieure.
 */
export function nextRelativeLongitudeEvent(id: BodyId, date: Date): RelativeLongitudeEvent | null {
  if (!RELATIVE_LONGITUDE_BODIES.has(id)) return null
  const def = BODY_BY_ID.get(id)
  if (!def) return null
  const found = A.SearchRelativeLongitude(def.body, 0, date)
  return { date: found.date, kind: INFERIOR_BODIES.has(id) ? 'conjonction inférieure' : 'opposition' }
}

/** Etats de tous les corps demandes. */
export function computeAllBodies(date: Date, location: GeoLocation, ids?: ReadonlySet<BodyId>): BodyState[] {
  return BODIES.filter((b) => !ids || ids.has(b.id)).map((b) => computeBodyState(b, date, location))
}

/** Lever, passage au meridien et coucher autour d'une date de reference. */
export function computeRiseSet(def: BodyDefinition, date: Date, location: GeoLocation): RiseSetInfo {
  // Un petit corps n'a pas de place dans astronomy-engine : on le fige le temps
  // de la recherche. En deux jours, Vesta ne se deplace que d'un demi-degre.
  if (def.model === 'minor') return computeFixedRiseSet(minorEquatorialJ2000(def, date, location), date, location)
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
