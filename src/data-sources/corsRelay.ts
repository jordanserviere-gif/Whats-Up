/**
 * Relais CORS public.
 *
 * Aucune source ADS-B gratuite testee (adsb.lol, adsb.fi, airplanes.live,
 * OpenSky) n'autorise l'appel direct depuis un navigateur : verifie non pas au
 * jugé mais avec un navigateur reel, comme le reste de ce projet le fait pour
 * juger du CORS — une requete Node ne prouve rien, cf. `probe-cors.mjs`. Toutes
 * omettent l'en-tete `Access-Control-Allow-Origin`, ou le restreignent a leur
 * propre domaine.
 *
 * Un relais public comble l'ecart, au prix d'une dependance dont on ne
 * controle ni la disponibilite ni le debit. On en essaie donc plusieurs dans
 * l'ordre, et le contrat de `fetchJson` — jamais d'exception, repli sur le
 * cache perime — absorbe une panne totale exactement comme il absorberait une
 * panne de la source elle-meme : l'ecran ne montre pas moins d'avions parce
 * qu'un relais est tombe, il en montre de legerement plus vieux.
 */

/**
 * Relais essayes, dans l'ordre, avec le delai propre a chacun.
 *
 * Mesure en conditions reelles (navigateur, pas `curl`) : allorigins.win est
 * le seul des trois a effectivement renvoyer la reponse, mais lentement —
 * jusqu'a seize secondes vu ici. corsproxy.io repond en un clin d'oeil, mais
 * refuse (403, quota gratuit epuise ou restreint). codetabs echoue net,
 * injoignable. Plutot que de choisir un seul relais fragile, on essaie
 * allorigins en premier avec une marge large, et les deux autres en repli
 * rapide si jamais il venait a manquer.
 */
const RELAYS: Array<{ build: (target: string) => string; timeoutMs: number }> = [
  { build: (t) => `https://api.allorigins.win/raw?url=${encodeURIComponent(t)}`, timeoutMs: 18_000 },
  { build: (t) => `https://corsproxy.io/?url=${encodeURIComponent(t)}`, timeoutMs: 5_000 },
  { build: (t) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(t)}`, timeoutMs: 5_000 },
]

export interface RelayAttempt {
  url: string
  timeoutMs: number
}

export function relayAttempts(target: string): RelayAttempt[] {
  return RELAYS.map((r) => ({ url: r.build(target), timeoutMs: r.timeoutMs }))
}
