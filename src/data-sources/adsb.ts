/**
 * Client ADS-B — positions d'avions en direct, via l'agregateur communautaire
 * adsb.fi (miroir libre du reseau adsb.lol, memes contributeurs, meme format).
 *
 * Aucune de ces sources n'ouvre son CORS a un site tiers : voir `corsRelay.ts`
 * pour la raison et le choix assume d'un relais public plutot que de renoncer.
 */
import { fetchJson } from './fetchJson'
import { relayAttempts } from './corsRelay'
import type { Sourced } from './types'

const BASE = 'https://opendata.adsb.fi/api/v2/lat'

/**
 * Duree de validite de l'instantane en cache.
 *
 * Elle valait la periode d'interrogation elle-meme, ce qui figeait le ciel :
 * les trois relais partagent une meme cle, donc quand le premier expirait par
 * delai, le deuxieme relisait l'entree ecrite au tour precedent — encore
 * valide — et renvoyait exactement les memes positions. Un relais lent
 * suffisait alors a ce que plus aucun avion ne bouge.
 *
 * Pour un flux en direct, le cache ne doit pas servir de raccourci de lecture
 * mais uniquement de filet en cas de panne : `fetchJson` renvoie l'entree
 * perimee quand tout le reste a echoue. Deux secondes ne couvrent donc qu'une
 * rafale d'appels simultanes, jamais un cycle entier.
 */
const CACHE_TTL_MS = 2_000

/** Age maximal retenu pour une mesure : au-dela, l'horloge du client derive. */
const MAX_FIX_AGE_MS = 30_000

/** Enregistrement brut tel que renvoye par l'API — champs OMM-like du monde ADS-B. */
interface RawAircraft {
  hex: string
  flight?: string
  r?: string
  t?: string
  desc?: string
  category?: string
  alt_baro?: number | 'ground'
  alt_geom?: number
  gs?: number
  track?: number
  true_heading?: number
  mag_heading?: number
  baro_rate?: number
  geom_rate?: number
  squawk?: string
  lat?: number
  lon?: number
  dst?: number
  /** Age de la position, en secondes, a l'instant ou le serveur a repondu. */
  seen_pos?: number
}

export interface AdsbAircraft {
  hex: string
  /** Indicatif de vol, nettoye des espaces de bourrage. */
  flight: string | null
  registration: string | null
  typeCode: string | null
  description: string | null
  category: string | null
  /** Altitude barometrique, en pieds. `null` si l'avion est au sol. */
  altitudeFt: number | null
  onGround: boolean
  groundSpeedKt: number | null
  /** Route au sol, en degres vrais — c'est elle qui oriente le maillage. */
  trackDeg: number | null
  verticalRateFtMin: number | null
  squawk: string | null
  latitude: number
  longitude: number
  /**
   * Instant de la mesure, sur l'horloge du client.
   *
   * Ce n'est **pas** l'instant de reception : entre les deux s'intercalent
   * l'age de la position cote serveur et le transit par le relais, soit
   * couramment cinq a quinze secondes. Extrapoler depuis la reception ferait
   * repartir l'avion en arriere a chaque rafraichissement, du produit de ce
   * retard par sa vitesse — plusieurs kilometres.
   */
  measuredAtMs: number
}

function cleanFlight(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

/**
 * Instant de la mesure ramene a l'horloge locale.
 *
 * `now` est l'horodatage du serveur et `seen_pos` l'age de la position a cet
 * instant : leur difference date la mesure dans le repere du serveur, et
 * l'ecart au temps local absorbe du meme coup le transit par le relais.
 * L'age resultant est borne, faute de quoi une horloge client mal reglee
 * lancerait l'extrapolation a des minutes de distance.
 */
function measurementTime(raw: RawAircraft, serverNowMs: number, receivedAtMs: number): number {
  const fixedAtServerMs = serverNowMs - (raw.seen_pos ?? 0) * 1000
  const ageMs = Math.min(Math.max(receivedAtMs - fixedAtServerMs, 0), MAX_FIX_AGE_MS)
  return receivedAtMs - ageMs
}

function normalize(raw: RawAircraft, serverNowMs: number, receivedAtMs: number): AdsbAircraft | null {
  if (typeof raw.lat !== 'number' || typeof raw.lon !== 'number') return null
  const onGround = raw.alt_baro === 'ground'
  return {
    hex: raw.hex,
    flight: cleanFlight(raw.flight),
    registration: raw.r ?? null,
    typeCode: raw.t ?? null,
    description: raw.desc ?? null,
    category: raw.category ?? null,
    altitudeFt: onGround ? null : typeof raw.alt_baro === 'number' ? raw.alt_baro : (raw.alt_geom ?? null),
    onGround,
    groundSpeedKt: raw.gs ?? null,
    trackDeg: raw.track ?? raw.true_heading ?? raw.mag_heading ?? null,
    verticalRateFtMin: raw.baro_rate ?? raw.geom_rate ?? null,
    squawk: raw.squawk ?? null,
    latitude: raw.lat,
    longitude: raw.lon,
    measuredAtMs: measurementTime(raw, serverNowMs, receivedAtMs),
  }
}

/**
 * Avions dans un rayon autour d'un point.
 *
 * Chaque relais est essaye a son tour, une seule tentative rapide chacun : les
 * trois se rabattent sur la meme entree de cache, donc peu importe lequel a
 * fini par repondre. Si les trois echouent, `fetchJson` renvoie le dernier
 * instantane connu plutot qu'un ciel vide.
 */
export async function fetchNearbyAircraft(
  latitude: number,
  longitude: number,
  radiusKm: number,
): Promise<Sourced<AdsbAircraft[]> | null> {
  const radiusNm = Math.max(1, Math.round(radiusKm / 1.852))
  // Cle arrondie : un deplacement d'observateur de quelques metres ne doit pas
  // invalider un cache vieux de trois secondes.
  const key = `adsb:${latitude.toFixed(2)}:${longitude.toFixed(2)}:${radiusNm}`
  const target = `${BASE}/${latitude}/lon/${longitude}/dist/${radiusNm}`

  for (const attempt of relayAttempts(target)) {
    const result = await fetchJson<{ now?: number; aircraft?: RawAircraft[] }, AdsbAircraft[]>(
      attempt.url,
      { key, ttlMs: CACHE_TTL_MS, timeoutMs: attempt.timeoutMs, attempts: 1 },
      (raw) => {
        // L'interpretation vaut aussi bien pour une reponse fraiche que pour une
        // entree de cache relue apres panne : on date donc la mesure au moment
        // ou l'on interprete, jamais a une constante figee a l'ecriture.
        const receivedAtMs = Date.now()
        const serverNowMs = typeof raw.now === 'number' ? raw.now * 1000 : receivedAtMs
        return (raw.aircraft ?? [])
          .map((a) => normalize(a, serverNowMs, receivedAtMs))
          .filter((a): a is AdsbAircraft => a !== null)
      },
    )
    if (result) return result
  }
  return null
}
