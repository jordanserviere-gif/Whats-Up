/** Conversions temporelles et formatage. */

export const MS_PER_HOUR = 3_600_000
export const MS_PER_DAY = 86_400_000

/** Jour julien a partir d'une date UTC. */
export function julianDay(date: Date): number {
  return date.getTime() / MS_PER_DAY + 2440587.5
}

/** Siecles julians depuis J2000.0. */
export function julianCenturies(date: Date): number {
  return (julianDay(date) - 2451545.0) / 36525
}

/**
 * Temps sidereal moyen de Greenwich, en degres [0, 360).
 * Formule IAU 1982, precision de l'ordre de la seconde d'arc sur le siecle.
 */
export function gmstDegrees(date: Date): number {
  const jd = julianDay(date)
  const t = julianCenturies(date)
  const gmst =
    280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - (t * t * t) / 38710000
  return ((gmst % 360) + 360) % 360
}

/** Temps sidereal local en degres, pour une longitude est positive. */
export function lstDegrees(date: Date, longitude: number): number {
  return (((gmstDegrees(date) + longitude) % 360) + 360) % 360
}

/** Formatage horaire local, HH:MM. */
export function formatTime(date: Date, withSeconds = false): string {
  return date.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  })
}

/** Formatage de date long, ex. « sam. 16 août 2026 ». */
export function formatDate(date: Date): string {
  return date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

/** Duree en secondes vers « 4 min 32 s » ou « 1 h 05 ». */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

/** Valeur d'un `<input type="datetime-local">` a partir d'une Date (heure locale). */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Nom du fuseau horaire courant, ex. « Europe/Paris ». */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
