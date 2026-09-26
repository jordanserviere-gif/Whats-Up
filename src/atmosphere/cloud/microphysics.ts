/**
 * Microphysique de l'eau condensee → proprietes optiques.
 *
 * Un nuage se decrit par ce qu'il contient : une masse d'eau par unite de
 * volume et une taille de particule. L'optique en decoule, et c'est ce passage
 * qui rend nuages et trainees comparables — une trainee n'est qu'un nuage de
 * glace etroit.
 *
 * ## L'extinction
 *
 * Des particules grandes devant la longueur d'onde interceptent deux fois leur
 * section geometrique (`Q_ext → 2`, le paradoxe de l'extinction, verifie par
 * le solveur de Mie). Pour une population de rayon effectif `r_e` — le rapport
 * du troisieme au deuxieme moment de la distribution —, cela donne :
 *
 *     σ_ext = 3 W / (2 ρ r_e)
 *
 * avec `W` le contenu en eau (kg/m³) et `ρ` la masse volumique de la phase
 * condensee. C'est la relation qu'utilisent les restitutions satellitaires
 * d'epaisseur optique ; elle ne depend pas de la forme exacte de la
 * distribution des tailles, seulement de `r_e`.
 *
 * Nuages et trainees sont blancs parce que cette extinction est **grise** :
 * aucune dependance a λ tant que la particule reste grande devant elle.
 */

/** Masse volumique de l'eau liquide, kg/m³. */
export const WATER_DENSITY_KG_M3 = 1000
/** Masse volumique de la glace, kg/m³. */
export const ICE_DENSITY_KG_M3 = 917

export type CondensedPhase = 'liquide' | 'glace'

export const condensedDensity = (phase: CondensedPhase): number =>
  phase === 'liquide' ? WATER_DENSITY_KG_M3 : ICE_DENSITY_KG_M3

/**
 * Coefficient d'extinction, m⁻¹, d'une population de rayon effectif `r_e`.
 *
 * Absorption negligee : l'albedo de diffusion simple de l'eau et de la glace
 * depasse 0,9999 dans le visible.
 */
export function extinctionCoefficient(contentKgM3: number, effectiveRadiusM: number, phase: CondensedPhase): number {
  if (!(contentKgM3 > 0) || !(effectiveRadiusM > 0)) return 0
  return (3 * contentKgM3) / (2 * condensedDensity(phase) * effectiveRadiusM)
}

/** Reperes de rayon effectif, m, pour documenter et borner les usages. */
export const TYPICAL_EFFECTIVE_RADIUS_M = {
  /** Stratocumulus et cumulus de beau temps. */
  cumulus: 10e-6,
  /** Cristaux d'une trainee jeune, a peine formes. */
  contrailYoung: 2e-6,
  /** Cristaux d'une trainee persistante, qui a grossi dans l'air sursature. */
  contrailAged: 10e-6,
  /** Cirrus naturels. */
  cirrus: 30e-6,
} as const
