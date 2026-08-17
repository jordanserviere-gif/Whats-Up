/**
 * Client CelesTrak — elements orbitaux reels au format GP JSON.
 *
 * CelesTrak demande explicitement que ses reponses soient mises en cache : le
 * TTL de six heures repond a cette obligation, et les elements ne bougent de
 * toute facon pas plus vite. Un groupe entier est recupere d'un coup — c'est ce
 * que le service attend, et cela evite une requete par satellite.
 *
 * Le format GP JSON se donne directement a `json2satrec` de satellite.js : on
 * ne passe jamais par les chaines TLE a deux lignes, dont le decoupage se fait
 * a la colonne pres.
 */
import { fetchJson } from './fetchJson'
import type { GpElements } from '@/astro/types'
import type { Sourced } from './types'

const BASE = 'https://celestrak.org/NORAD/elements/gp.php'
/** Six heures : les elements ne se renouvellent pas plus vite. */
const TTL_MS = 6 * 3600 * 1000
/** Au-dela, un jeu d'elements SGP4 derive suffisamment pour induire en erreur. */
export const STALE_EPOCH_DAYS = 3

/** Groupes utiles. `active` compte plusieurs milliers d'objets : a manier avec soin. */
export const CELESTRAK_GROUPS = [
  { id: 'stations', label: 'Stations spatiales' },
  { id: 'visual', label: 'Les plus brillants' },
  { id: 'gps-ops', label: 'GPS opérationnels' },
  { id: 'galileo', label: 'Galileo' },
  { id: 'geo', label: 'Géostationnaires' },
  { id: 'weather', label: 'Météorologiques' },
  { id: 'science', label: 'Scientifiques' },
  { id: 'starlink', label: 'Starlink' },
] as const

export type CelestrakGroup = (typeof CELESTRAK_GROUPS)[number]['id']

/**
 * Enregistrement GP tel que CelesTrak le renvoie.
 *
 * Les noms de champs suivent la norme OMM du CCSDS ; ils sont repris tels quels
 * parce que `json2satrec` les attend sous cette forme exacte.
 */
export type GpRecord = GpElements

export interface SatelliteRecord {
  /** Identifiant NORAD, stable dans le temps — sert de cle. */
  noradId: number
  name: string
  /** Enregistrement brut, transmis tel quel a `json2satrec`. */
  gp: GpRecord
  epoch: Date
  /** Age des elements a l'instant de la lecture, en jours. */
  epochAgeDays: number
  /** Vrai si les elements sont trop vieux pour une propagation fiable. */
  stale: boolean
}

/** Vérifie qu'un objet possède bien les champs indispensables à SGP4. */
function isUsable(record: unknown): record is GpRecord {
  const r = record as Partial<GpRecord> | null
  return (
    !!r &&
    typeof r.NORAD_CAT_ID === 'number' &&
    typeof r.EPOCH === 'string' &&
    typeof r.MEAN_MOTION === 'number' &&
    typeof r.ECCENTRICITY === 'number' &&
    typeof r.INCLINATION === 'number'
  )
}

function toRecord(gp: GpRecord): SatelliteRecord {
  const epoch = new Date(gp.EPOCH.endsWith('Z') ? gp.EPOCH : `${gp.EPOCH}Z`)
  const epochAgeDays = (Date.now() - epoch.getTime()) / 86_400_000
  return {
    noradId: gp.NORAD_CAT_ID,
    name: gp.OBJECT_NAME?.trim() || `NORAD ${gp.NORAD_CAT_ID}`,
    gp,
    epoch,
    epochAgeDays,
    stale: Math.abs(epochAgeDays) > STALE_EPOCH_DAYS,
  }
}

/**
 * Recupere un groupe d'objets.
 *
 * Renvoie `null` — jamais une exception — si le reseau echoue et qu'aucun cache
 * n'est disponible. L'appelant retombe alors sur les elements saisis a la main.
 */
export function fetchGroup(group: CelestrakGroup): Promise<Sourced<SatelliteRecord[]> | null> {
  const url = `${BASE}?GROUP=${encodeURIComponent(group)}&FORMAT=json`
  return fetchJson<unknown[], SatelliteRecord[]>(
    url,
    { key: `celestrak:${group}`, ttlMs: TTL_MS, timeoutMs: 8000 },
    (raw) => {
      if (!Array.isArray(raw)) throw new Error('réponse inattendue : tableau attendu')
      // Un enregistrement incomplet est ecarte plutot que de faire echouer le
      // groupe entier : mieux vaut vingt satellites que zero.
      const records = raw.filter(isUsable).map(toRecord)
      if (records.length === 0) throw new Error('aucun élément exploitable')
      return records.sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    },
  )
}

/** Recherche un objet par identifiant NORAD dans un groupe deja recupere. */
export const findByNorad = (records: SatelliteRecord[], noradId: number): SatelliteRecord | null =>
  records.find((r) => r.noradId === noradId) ?? null

/** Identifiant NORAD de la Station spatiale internationale. */
export const ISS_NORAD_ID = 25544
