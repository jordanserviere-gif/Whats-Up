/** Concatene des classes en ignorant les valeurs vides. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** Identifiants stables pour lier label / champ / message d'aide. */
let uid = 0
export function nextId(prefix: string): string {
  uid += 1
  return `${prefix}-${uid}`
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
