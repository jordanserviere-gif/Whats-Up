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
 * Cadence de rafraichissement.
 *
 * adsb.fi republie ses positions toutes les cinq a dix secondes, mais le
 * relais qui rend l'appel possible (voir `corsRelay.ts`) peut a lui seul
 * prendre une quinzaine de secondes a repondre. Vingt secondes laissent le
 * temps a une interrogation lente de se terminer avant que la suivante ne
 * parte.
 */
export const ADSB_POLL_MS = 20_000

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
}

function cleanFlight(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

function normalize(raw: RawAircraft): AdsbAircraft | null {
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
    const result = await fetchJson<{ aircraft?: RawAircraft[] }, AdsbAircraft[]>(
      attempt.url,
      { key, ttlMs: ADSB_POLL_MS, timeoutMs: attempt.timeoutMs, attempts: 1 },
      (raw) => (raw.aircraft ?? []).map(normalize).filter((a): a is AdsbAircraft => a !== null),
    )
    if (result) return result
  }
  return null
}
