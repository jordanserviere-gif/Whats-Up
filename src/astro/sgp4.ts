/**
 * Propagation SGP4 des elements OMM publies par CelesTrak.
 *
 * Le modele keplerien de `kepler.ts` decrit fidelement une orbite donnee par ses
 * elements osculateurs, mais les elements diffuses pour les satellites reels
 * sont des elements *moyens* SGP4 : ils n'ont de sens que passes dans le
 * propagateur qui les a produits. Les lire comme des elements keplerians
 * placerait la Station spatiale a plusieurs degres de sa position vraie en
 * quelques heures. On ne sort donc jamais de la chaine de satellite.js.
 *
 * Repere. SGP4 restitue une position dans le repere TEME (True Equator, Mean
 * Equinox), tandis que le reste de l'application travaille dans l'equatorial
 * vrai de la date. Les deux ne different que d'une rotation autour du pole egale
 * a l'equation des equinoxes, soit au plus dix-huit secondes d'arc. C'est deux
 * ordres de grandeur sous la precision d'un pointage a l'oeil, et trois sous le
 * deplacement du satellite pendant une image. On les confond donc sciemment,
 * plutot que d'introduire une chaine de conversion parallele : la section 9 de
 * `verify-astro.mjs` mesure l'ecart contre `ecfToLookAngles`, qui suit lui la
 * voie officielle, et le maintient sous le seuil declare.
 */
import { json2satrec, propagate as sgp4Propagate, type SatRec } from 'satellite.js'
import type { StateVectorKm } from './kepler'
import { EARTH_MU } from './coords'
import type { GpElements, OrbitalElements } from './types'

/**
 * Les `SatRec` sont couteux a construire et parfaitement immuables : on les
 * garde par identifiant NORAD et numero de jeu d'elements, de sorte qu'une mise
 * a jour du catalogue invalide naturellement l'entree.
 */
const satrecCache = new Map<string, SatRec | null>()

const cacheKey = (gp: GpElements) => `${gp.NORAD_CAT_ID}:${gp.ELEMENT_SET_NO}:${gp.EPOCH}`

/** Construit — ou retrouve — le `SatRec` correspondant a un enregistrement OMM. */
export function satrecFor(gp: GpElements): SatRec | null {
  const key = cacheKey(gp)
  const cached = satrecCache.get(key)
  if (cached !== undefined) return cached

  let rec: SatRec | null = null
  try {
    rec = json2satrec(gp as never)
    // `error` non nul signale un jeu d'elements que SGP4 refuse d'initialiser.
    if (rec && rec.error) rec = null
  } catch {
    rec = null
  }
  satrecCache.set(key, rec)
  return rec
}

/**
 * Position et vitesse geocentriques inertielles a l'instant demande.
 * Leve si les elements sont inexploitables : l'appelant traite ce cas comme il
 * traite deja des elements keplerians invalides.
 */
export function propagateGp(gp: GpElements, date: Date): StateVectorKm {
  const rec = satrecFor(gp)
  if (!rec) throw new Error('éléments SGP4 inexploitables')

  const pv = sgp4Propagate(rec, date)
  if (!pv || !pv.position || !pv.velocity) throw new Error('propagation SGP4 impossible à cette date')

  const { position, velocity } = pv
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
    throw new Error('propagation SGP4 divergente')
  }

  return {
    position: [position.x, position.y, position.z],
    velocity: [velocity.x, velocity.y, velocity.z],
  }
}

/** Demi-grand axe deduit du mouvement moyen OMM, en km. */
function semiMajorAxisFromOmm(revPerDay: number): number {
  const n = (revPerDay * 2 * Math.PI) / 86400
  return Math.cbrt(EARTH_MU / (n * n))
}

/**
 * Traduit un enregistrement OMM en `OrbitalElements`.
 *
 * Les champs keplerians sont renseignes a partir des elements moyens : ils ne
 * servent pas a la propagation — `gp` est present, donc SGP4 prend la main —
 * mais ils alimentent l'editeur, la periode affichee et les altitudes de perigee
 * et d'apogee. Les laisser vides afficherait des zeros la ou l'on attend des
 * ordres de grandeur justes.
 */
export function elementsFromGp(
  gp: GpElements,
  options: { id: string; color: string; epochAgeDays?: number },
): OrbitalElements {
  return {
    id: options.id,
    name: gp.OBJECT_NAME?.trim() || `NORAD ${gp.NORAD_CAT_ID}`,
    semiMajorAxisKm: semiMajorAxisFromOmm(gp.MEAN_MOTION),
    eccentricity: gp.ECCENTRICITY,
    inclination: gp.INCLINATION,
    raan: gp.RA_OF_ASC_NODE,
    argPerigee: gp.ARG_OF_PERICENTER,
    meanAnomaly: gp.MEAN_ANOMALY,
    epoch: gp.EPOCH.endsWith('Z') ? gp.EPOCH : `${gp.EPOCH}Z`,
    useJ2: true,
    color: options.color,
    source: 'celestrak',
    gp,
    noradId: gp.NORAD_CAT_ID,
    epochAgeDays: options.epochAgeDays,
  }
}
