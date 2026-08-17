/** Concatene des classes en ignorant les valeurs vides. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
