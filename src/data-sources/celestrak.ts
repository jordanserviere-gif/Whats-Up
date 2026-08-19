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

/**
 * Groupes suivis, **par ordre de priorite**.
 *
 * L'ordre n'est pas decoratif : quand la reunion des groupes demandes depasse
 * le plafond de propagation, c'est la fin de cette liste qui est ecartee. Elle
 * va donc du plus identifiable au plus nombreux — une station spatiale ou un
 * objet du groupe « les plus brillants » vaut d'etre suivi nommement, le
 * dix-millieme Starlink beaucoup moins.
 */
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

/** Tous les groupes, dans l'ordre de priorite ci-dessus. */
export const ALL_CELESTRAK_GROUPS: CelestrakGroup[] = CELESTRAK_GROUPS.map((g) => g.id)

const GROUP_LABELS = new Map<string, string>(CELESTRAK_GROUPS.map((g) => [g.id, g.label]))

/** Libelle d'un groupe, ou son identifiant brut s'il n'est plus au catalogue. */
export const groupLabel = (id: string): string => GROUP_LABELS.get(id) ?? id

/** Vrai si l'identifiant designe encore un groupe connu. */
export const isCelestrakGroup = (id: unknown): id is CelestrakGroup =>
  typeof id === 'string' && GROUP_LABELS.has(id)

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
  /**
   * Groupe qui a fourni l'objet. Un satellite peut appartenir a plusieurs
   * groupes — l'ISS est a la fois une station et un objet brillant : c'est
   * alors le plus prioritaire qui est retenu.
   */
  group: CelestrakGroup
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

function toRecord(gp: GpRecord, group: CelestrakGroup): SatelliteRecord {
  const epoch = new Date(gp.EPOCH.endsWith('Z') ? gp.EPOCH : `${gp.EPOCH}Z`)
  const epochAgeDays = (Date.now() - epoch.getTime()) / 86_400_000
  return {
    noradId: gp.NORAD_CAT_ID,
    name: gp.OBJECT_NAME?.trim() || `NORAD ${gp.NORAD_CAT_ID}`,
    group,
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
      const records = raw.filter(isUsable).map((gp) => toRecord(gp, group))
      if (records.length === 0) throw new Error('aucun élément exploitable')
      return records.sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    },
  )
}

/** Du plus fiable au moins fiable — sert a resumer plusieurs statuts en un. */
const ORIGIN_RANK: Record<string, number> = { 'mesuré': 0, cache: 1, 'défaut': 2 }

/**
 * Reunion de plusieurs groupes.
 *
 * Chaque groupe garde sa propre requete et sa propre entree de cache : demander
 * la reunion ne coute donc rien de plus a la seconde visite, et un groupe qui
 * echoue ne prive pas des autres. Les doublons sont ecartes par identifiant
 * NORAD, en conservant la premiere occurrence — donc celle du groupe le plus
 * prioritaire.
 *
 * Le statut renvoye est le moins bon des statuts obtenus : dire « mesuré »
 * quand un groupe sur huit vient d'un cache de la veille serait trompeur.
 */
export async function fetchGroups(
  groups: readonly CelestrakGroup[],
): Promise<Sourced<SatelliteRecord[]> | null> {
  // L'ordre de priorite prime sur celui de la demande : c'est lui qui decide
  // du groupe retenu en cas de doublon, et de ce qui saute sous le plafond.
  const ordered = ALL_CELESTRAK_GROUPS.filter((g) => groups.includes(g))
  if (ordered.length === 0) return null
  if (ordered.length === 1) return fetchGroup(ordered[0])

  const results = await Promise.all(ordered.map((g) => fetchGroup(g)))
  const ok = results.filter((r): r is Sourced<SatelliteRecord[]> => r !== null)
  if (ok.length === 0) return null

  const byNorad = new Map<number, SatelliteRecord>()
  for (const result of ok) {
    for (const record of result.value) {
      if (!byNorad.has(record.noradId)) byNorad.set(record.noradId, record)
    }
  }

  const worst = ok.reduce((a, b) => (ORIGIN_RANK[b.status.origin] > ORIGIN_RANK[a.status.origin] ? b : a))
  const failed = ordered.length - ok.length
  return {
    value: [...byNorad.values()],
    status: {
      ...worst.status,
      ...(failed > 0
        ? { note: `${failed} groupe${failed > 1 ? 's' : ''} sur ${ordered.length} indisponible${failed > 1 ? 's' : ''}` }
        : {}),
    },
  }
}
