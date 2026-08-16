/** Types partages par toutes les integrations de sources externes. */

/**
 * Provenance d'une donnee, affichee dans le panneau Reglages.
 *
 * C'est ce qui rend la degradation lisible plutot que mysterieuse : l'utilisateur
 * voit si la refraction s'appuie sur une pression mesuree ce matin, sur une
 * valeur en cache d'avant-hier, ou sur l'atmosphere standard.
 */
export type DataOrigin = 'mesuré' | 'cache' | 'défaut'

export interface SourceStatus {
  origin: DataOrigin
  /** Instant de la recuperation reussie, nul si la donnee vient du defaut. */
  fetchedAt: Date | null
  /** Age de la donnee en millisecondes, nul si elle vient du defaut. */
  ageMs: number | null
  /** Message court a afficher en cas de probleme. */
  note?: string
}

/** Donnee accompagnee de sa provenance. */
export interface Sourced<T> {
  value: T
  status: SourceStatus
}

export const DEFAULT_STATUS: SourceStatus = { origin: 'défaut', fetchedAt: null, ageMs: null }

/** Construit un statut a partir d'un instant de recuperation. */
export function statusFrom(fetchedAt: number, fresh: boolean, note?: string): SourceStatus {
  return {
    origin: fresh ? 'mesuré' : 'cache',
    fetchedAt: new Date(fetchedAt),
    ageMs: Date.now() - fetchedAt,
    ...(note ? { note } : {}),
  }
}

/** Age lisible : « il y a 4 min », « il y a 2 h », « hier ». */
export function formatAge(ageMs: number | null): string {
  if (ageMs === null) return '—'
  const minutes = Math.round(ageMs / 60_000)
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  const days = Math.round(hours / 24)
  return days === 1 ? 'hier' : `il y a ${days} jours`
}
