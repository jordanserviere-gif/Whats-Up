/**
 * Recuperation resiliente d'une source externe.
 *
 * Contrat, volontairement strict :
 *
 * - delai d'expiration explicite — une source lente ne doit jamais retenir
 *   l'interface ;
 * - au succes, ecriture en cache avec un TTL ;
 * - a l'echec, **renvoi du cache meme perime**, en signalant sa fraicheur : une
 *   pression d'hier vaut mieux que l'atmosphere standard ;
 * - si rien en cache, `null` — jamais une exception qui remonte a l'interface.
 *
 * Aucune de ces fonctions ne doit etre appelee depuis `useFrame`.
 */
import { isExpired, readCache, writeCache } from './cache'
import { statusFrom, type Sourced } from './types'

export interface FetchOptions {
  /** Cle de cache. Doit englober tous les parametres de la requete. */
  key: string
  /** Duree de validite de la reponse. */
  ttlMs: number
  /** Delai au-dela duquel la requete est abandonnee. Defaut : 5 s. */
  timeoutMs?: number
  /** Nombre de tentatives reseau avant de se rabattre sur le cache. */
  attempts?: number
  /** En-tetes additionnels. Attention : ils peuvent declencher un prevol CORS. */
  headers?: Record<string, string>
}

/** Attente simple, pour l'attente croissante entre deux tentatives. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Recupere du JSON, avec cache et repli.
 *
 * `parse` transforme la reponse brute en donnee applicative. Elle s'applique
 * aussi bien a une reponse fraiche qu'a une entree de cache : ce qui est mis en
 * cache est la **charge brute**, pas le resultat interprete, afin qu'un
 * changement de code d'interpretation ne demande pas de purger le cache.
 */
export async function fetchJson<Raw, T = Raw>(
  url: string,
  options: FetchOptions,
  parse: (raw: Raw) => T = (raw) => raw as unknown as T,
): Promise<Sourced<T> | null> {
  const { key, ttlMs, timeoutMs = 5000, attempts = 2, headers } = options

  const cached = await readCache<Raw>(key)
  // Cache encore valide : on ne sollicite pas le reseau du tout.
  if (cached && !isExpired(cached)) {
    try {
      return { value: parse(cached.payload), status: statusFrom(cached.fetchedAt, true) }
    } catch {
      // Charge illisible : on la traite comme absente et on retente le reseau.
    }
  }

  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetch(url, { signal: controller.signal, headers, mode: 'cors' })
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const raw = (await response.json()) as Raw
      const value = parse(raw)
      // On n'ecrit qu'apres une interpretation reussie : inutile de conserver
      // une charge dont on sait deja qu'elle ne se lit pas.
      await writeCache(key, raw, ttlMs)
      return { value, status: statusFrom(Date.now(), true) }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt < attempts) await sleep(400 * attempt)
    }
  }

  // Reseau indisponible : le cache perime reste preferable au defaut.
  if (cached) {
    try {
      return {
        value: parse(cached.payload),
        status: statusFrom(cached.fetchedAt, false, `réseau indisponible (${lastError})`),
      }
    } catch {
      /* charge illisible : on retombe sur le defaut */
    }
  }
  return null
}

/**
 * Variante binaire, pour les charges qui ne sont ni du JSON ni du texte —
 * tuiles compressees, grilles de valeurs.
 *
 * Meme contrat que les deux precedentes, a un detail pres : ce qui est mis en
 * cache est un `ArrayBuffer`, qu'IndexedDB sait stocker tel quel. La charge
 * brute reste donc la charge brute, et `parse` peut evoluer sans invalider le
 * cache.
 */
export async function fetchBinary<T>(
  url: string,
  options: FetchOptions,
  parse: (raw: ArrayBuffer) => T,
): Promise<Sourced<T> | null> {
  const { key, ttlMs, timeoutMs = 5000, attempts = 2, headers } = options

  const cached = await readCache<ArrayBuffer>(key)
  if (cached && !isExpired(cached)) {
    try {
      return { value: parse(cached.payload), status: statusFrom(cached.fetchedAt, true) }
    } catch {
      /* on retente le reseau */
    }
  }

  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetch(url, { signal: controller.signal, headers, mode: 'cors' })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const raw = await response.arrayBuffer()
      const value = parse(raw)
      await writeCache(key, raw, ttlMs)
      return { value, status: statusFrom(Date.now(), true) }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt < attempts) await sleep(400 * attempt)
    }
  }

  if (cached) {
    try {
      return {
        value: parse(cached.payload),
        status: statusFrom(cached.fetchedAt, false, `reseau indisponible (${lastError})`),
      }
    } catch {
      /* defaut */
    }
  }
  return null
}

/**
 * Variante pour les reponses textuelles (CSV, TLE a trois lignes).
 * Meme contrat, seul le decodage change.
 */
export async function fetchText<T>(
  url: string,
  options: FetchOptions,
  parse: (raw: string) => T,
): Promise<Sourced<T> | null> {
  const { key, ttlMs, timeoutMs = 5000, attempts = 2, headers } = options

  const cached = await readCache<string>(key)
  if (cached && !isExpired(cached)) {
    try {
      return { value: parse(cached.payload), status: statusFrom(cached.fetchedAt, true) }
    } catch {
      /* on retente le reseau */
    }
  }

  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetch(url, { signal: controller.signal, headers, mode: 'cors' })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const raw = await response.text()
      const value = parse(raw)
      await writeCache(key, raw, ttlMs)
      return { value, status: statusFrom(Date.now(), true) }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt < attempts) await sleep(400 * attempt)
    }
  }

  if (cached) {
    try {
      return {
        value: parse(cached.payload),
        status: statusFrom(cached.fetchedAt, false, `réseau indisponible (${lastError})`),
      }
    } catch {
      /* defaut */
    }
  }
  return null
}
