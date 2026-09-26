/**
 * Flux ADS-B partage, hors du cycle de vie React.
 *
 * Le meme probleme que CelesTrak se posait a l'identique : la barre haute, la
 * scene et la fiche de detail ont chacune besoin des memes avions au meme
 * instant. Un etat local par composant aurait signifie trois interrogations
 * paralleles du meme relais toutes les douze secondes. Ici, un seul minuteur
 * interroge la source ; les consommateurs s'abonnent au resultat.
 *
 * L'historique de position sert a deux choses qui n'ont l'air de rien en
 * commun mais partagent la meme donnee : la trainee de condensation dans la
 * scene, et la « trace passee » de la fiche de detail. Aucune API gratuite ne
 * fournit un historique de vol anterieur a l'ouverture de l'application — donc
 * on construit le seul historique honnete possible, celui qu'on observe depuis
 * qu'on regarde.
 */
import { fetchNearbyAircraft, type AdsbAircraft } from '@/data-sources/adsb'
import { simulatedAircraft } from '@/data-sources/simulatedAircraft'
import type { SourceStatus } from '@/data-sources/types'

export const AIRCRAFT_RADIUS_KM = 75
/** Cadence d'interrogation du relais. */
const POLL_MS = 12_000
/**
 * Cadence de la flotte simulee. Rien a menager : une mise a jour par seconde
 * garde l'extrapolation tres courte, donc exacte.
 */
const SIMULATED_POLL_MS = 1_000
/** Fenetre conservee pour la trainee et la trace : au-dela, un point n'apprend plus rien. */
const HISTORY_WINDOW_MS = 8 * 60_000

export interface AircraftHistoryPoint {
  time: number
  latitude: number
  longitude: number
  altitudeKm: number
}

interface AdsbFeedSnapshot {
  raw: AdsbAircraft[]
  status: SourceStatus | null
  loading: boolean
}

let feed: AdsbFeedSnapshot = { raw: [], status: null, loading: false }
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let targetKey: string | null = null
const history = new Map<string, AircraftHistoryPoint[]>()

function publish(next: Partial<AdsbFeedSnapshot>) {
  feed = { ...feed, ...next }
  for (const listener of listeners) listener()
}

function recordHistory(raw: readonly AdsbAircraft[]) {
  const now = Date.now()
  for (const a of raw) {
    if (a.onGround || a.altitudeFt === null) continue
    const list = history.get(a.hex) ?? []
    list.push({ time: now, latitude: a.latitude, longitude: a.longitude, altitudeKm: a.altitudeFt * 0.0003048 })
    while (list.length > 0 && now - list[0].time > HISTORY_WINDOW_MS) list.shift()
    history.set(a.hex, list)
  }
  // Un avion sorti du rayon depuis longtemps n'a plus de raison de garder sa trainee.
  for (const [hex, list] of history) {
    const last = list[list.length - 1]
    if (!last || now - last.time > HISTORY_WINDOW_MS) history.delete(hex)
  }
}

/** Vrai tant qu'une interrogation est en cours — le relais public est lent. */
let inFlight = false

async function pollOnce(latitude: number, longitude: number, key: string) {
  // Le relais peut a lui seul prendre pres de vingt secondes : sans cette
  // garde, un tick lent et le suivant se chevaucheraient, doublant la charge
  // sur un service qu'on ne controle pas.
  if (inFlight) return
  inFlight = true
  try {
    const result = await fetchNearbyAircraft(latitude, longitude, AIRCRAFT_RADIUS_KM)
    // La cible a pu changer pendant la requete : un resultat perime ne doit pas s'afficher.
    if (targetKey !== key) return
    if (!result) {
      publish({ loading: false })
      return
    }
    recordHistory(result.value)
    publish({ raw: result.value, status: result.status, loading: false })
  } finally {
    inFlight = false
  }
}

/** Publie la flotte simulee, sans passer par le reseau. */
function simulateOnce(latitude: number, longitude: number) {
  const raw = simulatedAircraft(latitude, longitude)
  recordHistory(raw)
  publish({ raw, status: { origin: 'simulé', fetchedAt: new Date(), ageMs: 0 }, loading: false })
}

/**
 * Demarre — ou laisse filer — l'interrogation pour ce lieu. Sans effet si deja
 * en cours. `simulated` remplace le relais ADS-B par la flotte simulee.
 */
export function ensureAircraftPolling(latitude: number, longitude: number, simulated = false) {
  const key = `${simulated ? 'sim' : 'adsb'}:${latitude.toFixed(2)}:${longitude.toFixed(2)}`
  if (targetKey === key) return
  targetKey = key
  if (timer) clearInterval(timer)
  // Les deux sources n'ont rien en commun : garder l'historique de l'une
  // tracerait des trainees vers des avions qui n'existent plus.
  history.clear()
  publish({ raw: [], loading: true })
  const tick = simulated ? () => simulateOnce(latitude, longitude) : () => pollOnce(latitude, longitude, key)
  tick()
  timer = setInterval(tick, simulated ? SIMULATED_POLL_MS : POLL_MS)
}

export function stopAircraftPolling() {
  targetKey = null
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  publish({ raw: [], status: null, loading: false })
}

export const subscribeAircraftFeed = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const getAircraftFeedSnapshot = (): AdsbFeedSnapshot => feed

/** Historique recent d'un avion, en coordonnees geodesiques — jamais projete a l'avance. */
export const getAircraftHistory = (hex: string): readonly AircraftHistoryPoint[] => history.get(hex) ?? EMPTY_HISTORY

const EMPTY_HISTORY: AircraftHistoryPoint[] = []
