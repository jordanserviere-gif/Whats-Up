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

/**
 * Sources essayees dans l'ordre : le relais du serveur de l'appli vers adsb.fi,
 * puis vers adsb.lol (meme reseau de contributeurs, meme format), et seulement
 * en dernier recours les relais publics.
 */
const LOCAL_SOURCES = [
  { base: '/relay/adsbfi/api/v2/lat', timeoutMs: 6_000 },
  { base: '/relay/adsblol/v2/lat', timeoutMs: 6_000 },
]
const PUBLIC_BASE = 'https://opendata.adsb.fi/api/v2/lat'

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

/**
 * Age au-dela duquel une position n'est plus montree : mieux vaut un avion
 * absent qu'un avion fige a une place qu'il a quittee depuis des kilometres.
 */
export const MAX_FIX_AGE_MS = 90_000

/**
 * Decalage entre l'horloge locale et celle du serveur, transit compris, ms.
 * Mesure sur les reponses fraiches seulement : une reponse relue du cache,
 * vieille de minutes, le fausserait.
 */
let clockSkewMs = 0

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
  ias?: number
  tas?: number
  mach?: number
  /** Direction et vitesse du vent, deduites de l'ecart tas/gs. */
  wd?: number
  ws?: number
  /** Temperature exterieure, degres Celsius. */
  oat?: number
  track?: number
  true_heading?: number
  mag_heading?: number
  baro_rate?: number
  geom_rate?: number
  squawk?: string
  emergency?: string
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
  /** Code de categorie ADS-B (« A3 » = avion moyen-courrier...), brut. */
  category: string | null
  /** Altitude barometrique, en pieds. `null` si l'avion est au sol. */
  altitudeFt: number | null
  /**
   * Altitude GPS/GNSS, en pieds. Distincte de `altitudeFt` (barometrique,
   * calee sur la pression standard) : les deux divergent de plusieurs
   * centaines de pieds hors de l'atmosphere standard.
   */
  altitudeGeomFt: number | null
  onGround: boolean
  groundSpeedKt: number | null
  /** Vitesse indiquee (IAS) et vraie (TAS), en noeuds ; nombre de Mach. */
  indicatedSpeedKt: number | null
  trueSpeedKt: number | null
  mach: number | null
  /** Vent estime par ecart entre vitesse sol et vitesse vraie. */
  windDirDeg: number | null
  windSpeedKt: number | null
  outsideAirTempC: number | null
  /** Route au sol, en degres vrais — c'est elle qui oriente le maillage. */
  trackDeg: number | null
  verticalRateFtMin: number | null
  squawk: string | null
  /** « none » la plupart du temps ; toute autre valeur signale une urgence. */
  emergency: string | null
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
 * instant : leur difference date la mesure **sur l'horloge du serveur**, qu'on
 * ramene a la locale par le decalage mesure sur les reponses fraiches.
 *
 * ⚠️ La version precedente datait la mesure par rapport a l'instant ou l'on
 * interpretait la reponse, age plafonne a 30 s. Or une reponse relue du cache
 * apres une panne des relais est reinterpretee a chaque tour : un avion vu il
 * y a trois minutes repartait alors de sa vieille position, avance de 30 s
 * seulement — fige, ou en recul. La date vient maintenant du serveur, et une
 * mesure trop vieille n'est plus affichee du tout.
 */
function measurementTime(raw: RawAircraft, serverNowMs: number): number {
  const fixedAtServerMs = serverNowMs - (raw.seen_pos ?? 0) * 1000
  return fixedAtServerMs + clockSkewMs
}

function normalize(raw: RawAircraft, serverNowMs: number): AdsbAircraft | null {
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
    altitudeGeomFt: raw.alt_geom ?? null,
    onGround,
    groundSpeedKt: raw.gs ?? null,
    indicatedSpeedKt: raw.ias ?? null,
    trueSpeedKt: raw.tas ?? null,
    mach: raw.mach ?? null,
    windDirDeg: raw.wd ?? null,
    windSpeedKt: raw.ws ?? null,
    outsideAirTempC: raw.oat ?? null,
    trackDeg: raw.track ?? raw.true_heading ?? raw.mag_heading ?? null,
    verticalRateFtMin: raw.baro_rate ?? raw.geom_rate ?? null,
    squawk: raw.squawk ?? null,
    emergency: raw.emergency ?? null,
    latitude: raw.lat,
    longitude: raw.lon,
    measuredAtMs: measurementTime(raw, serverNowMs),
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
  const path = `/${latitude}/lon/${longitude}/dist/${radiusNm}`
  const attempts = [
    ...LOCAL_SOURCES.map((s) => ({ url: `${s.base}${path}`, timeoutMs: s.timeoutMs })),
    ...relayAttempts(`${PUBLIC_BASE}${path}`),
  ]

  for (const attempt of attempts) {
    const result = await fetchJson<{ now?: number; aircraft?: RawAircraft[] }, AdsbAircraft[]>(
      attempt.url,
      { key, ttlMs: CACHE_TTL_MS, timeoutMs: attempt.timeoutMs, attempts: 1 },
      (raw) => {
        // L'interpretation vaut aussi bien pour une reponse fraiche que pour une
        // entree de cache relue apres panne : on date donc la mesure au moment
        // ou l'on interprete, jamais a une constante figee a l'ecriture.
        const receivedAtMs = Date.now()
        // adsb.fi donne \`now\` en secondes, adsb.lol en millisecondes.
        const serverNowMs = typeof raw.now === 'number' ? (raw.now > 1e11 ? raw.now : raw.now * 1000) : receivedAtMs
        // Reponse fraiche (moins de 20 s d'ecart) : elle recale l'horloge. Une
        // reponse relue du cache, plus vieille, ne touche pas au decalage.
        const gap = receivedAtMs - serverNowMs
        if (Math.abs(gap) < 20_000) clockSkewMs = 0.7 * clockSkewMs + 0.3 * gap
        // adsb.lol nomme la liste \`ac\`, adsb.fi \`aircraft\`.
        const list = raw.aircraft ?? (raw as { ac?: RawAircraft[] }).ac ?? []
        return list
          .map((a) => normalize(a, serverNowMs))
          .filter((a): a is AdsbAircraft => a !== null && receivedAtMs - a.measuredAtMs <= MAX_FIX_AGE_MS)
      },
    )
    if (result) return result
  }
  return null
}
