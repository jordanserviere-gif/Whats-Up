/**
 * Cache persistant des reponses des sources externes.
 *
 * IndexedDB plutot que `localStorage` : les catalogues d'elements orbitaux se
 * comptent en centaines de kilo-octets, au-dela de ce que `localStorage`
 * accepte confortablement, et son acces synchrone bloquerait le fil principal
 * — donc le rendu.
 *
 * Ecrit sans dependance : l'API brute tient en quelques dizaines de lignes, et
 * une bibliotheque de plus pour trois operations ne se justifie pas.
 */

const DB_NAME = 'ciel.sources'
const DB_VERSION = 1
const STORE = 'reponses'

export interface CacheEntry<T = unknown> {
  key: string
  payload: T
  /** Instant de la recuperation. */
  fetchedAt: number
  /** Instant au-dela duquel la donnee est consideree perimee. */
  expiresAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDatabase(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve) => {
    // Navigation privee, quota refuse, IndexedDB desactive : dans tous ces cas
    // on continue sans cache plutot que d'echouer.
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })

  return dbPromise
}

function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return openDatabase().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null)
          return
        }
        try {
          const tx = db.transaction(STORE, mode)
          const request = run(tx.objectStore(STORE))
          request.onsuccess = () => resolve(request.result as T)
          request.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

/** Lit une entree, perimee ou non — c'est l'appelant qui juge de sa fraicheur. */
export function readCache<T>(key: string): Promise<CacheEntry<T> | null> {
  return transact<CacheEntry<T>>('readonly', (store) => store.get(key)).then((entry) => entry ?? null)
}

export function writeCache<T>(key: string, payload: T, ttlMs: number): Promise<void> {
  const now = Date.now()
  const entry: CacheEntry<T> = { key, payload, fetchedAt: now, expiresAt: now + ttlMs }
  return transact('readwrite', (store) => store.put(entry)).then(() => undefined)
}

export const isExpired = (entry: CacheEntry): boolean => Date.now() > entry.expiresAt
