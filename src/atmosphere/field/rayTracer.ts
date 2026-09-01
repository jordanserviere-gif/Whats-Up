/**
 * Traceur de rayons dans un champ d'indice quelconque.
 *
 * ## Pourquoi abandonner l'invariant
 *
 * La phase 11 integre la refraction par l'invariant de Bouguer,
 * `n·r·sin z = L`. C'est exact, rapide, et **strictement reserve a une
 * atmosphere a symetrie spherique** : l'invariant n'existe que parce que le
 * champ ne depend que du rayon.
 *
 * Des que l'indice varie horizontalement, il n'y a plus de constante du
 * mouvement a exploiter, et il faut integrer l'equation du rayon elle-meme.
 *
 * ## L'equation eikonale
 *
 *     dr/ds = u          du/ds = (∇n − (u·∇n)·u) / n
 *
 * `s` etant l'abscisse curviligne et `u` la direction unitaire. Le second terme
 * du numerateur retire la composante longitudinale du gradient : seule la partie
 * **transverse** courbe le rayon, la partie longitudinale ne fait que changer sa
 * vitesse de phase. C'est ce qui garde `u` unitaire.
 *
 * ## Le controle qui valide tout le reste
 *
 * Dans un champ spherique, ce traceur **n'utilise pas** l'invariant de
 * Bouguer — mais il doit le conserver. `n·r·sin z` le long du rayon est donc une
 * quantite calculee par un chemin totalement independant de celui qui la rend
 * constante.
 *
 * C'est le meilleur controle disponible pour un integrateur : il ne compare pas
 * a une reference exterieure, il verifie une loi de conservation que le schema
 * numerique ignore.
 *
 * ## Le pas
 *
 * Il croit avec l'altitude. Pres du sol, l'indice varie sur quelques metres et
 * un pas grossier lisserait precisement les structures qui font les mirages ;
 * a cinquante kilometres il ne reste presque rien a devier, et un pas fin n'y
 * gagnerait que du temps de calcul.
 */
import { EARTH_MEAN_RADIUS_M } from '../core/units'
import { ATMOSPHERE_TOP_M } from '../transport/slantPath'
import { altitudeOf, numericGradient, type AtmosphereField } from './AtmosphereField'

const RADIUS = EARTH_MEAN_RADIUS_M

export interface RayTraceOptions {
  /** Pas minimal, au ras du sol, m. */
  minStepM?: number
  /** Fraction de l'altitude servant de pas au-dessus. */
  stepPerAltitude?: number
  /** Pas maximal, m. */
  maxStepM?: number
  /** Altitude de sortie, m. */
  topAltitudeM?: number
  /** Nombre de pas maximal, garde-fou. */
  maxSteps?: number
  /** Pas des differences finies du gradient, m. */
  gradientStepM?: number
}

export interface RayTraceResult {
  /** Position finale, repere geocentrique, m. */
  position: [number, number, number]
  /** Direction finale, unitaire. */
  direction: [number, number, number]
  /** Longueur parcourue, m. */
  pathLengthM: number
  /** `true` si le rayon a quitte l'atmosphere, `false` s'il a rencontre le sol. */
  escaped: boolean
  /** Nombre de pas effectues. */
  steps: number
  /**
   * Deviation totale entre la direction de depart et celle d'arrivee, radians.
   *
   * C'est la refraction, mesuree sans hypothese de symetrie.
   */
  deflectionRad: number
}

const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * Suit un rayon depuis `origin` dans la direction `direction`.
 *
 * La direction est celle du **depart**, c'est-a-dire celle dans laquelle
 * l'observateur regarde. Le rayon est suivi vers l'exterieur, ce qui est
 * l'inverse du sens de propagation de la lumiere — les deux sont equivalents,
 * l'equation etant reversible.
 */
export function traceRay(
  field: AtmosphereField,
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  options: RayTraceOptions = {},
): RayTraceResult {
  const {
    minStepM = 5,
    stepPerAltitude = 0.02,
    maxStepM = 2000,
    topAltitudeM = ATMOSPHERE_TOP_M,
    maxSteps = 200_000,
    gradientStepM = 0.5,
  } = options

  const position: [number, number, number] = [origin[0], origin[1], origin[2]]
  const norm = Math.hypot(direction[0], direction[1], direction[2]) || 1
  const heading: [number, number, number] = [
    direction[0] / norm,
    direction[1] / norm,
    direction[2] / norm,
  ]
  const start: [number, number, number] = [heading[0], heading[1], heading[2]]

  let pathLength = 0
  let steps = 0
  let escaped = false

  /** `du/ds` au point et a la direction donnes. */
  const derivative = (
    p: readonly [number, number, number],
    u: readonly [number, number, number],
  ): [number, number, number] => {
    const n = field.refractiveIndexAt(p[0], p[1], p[2])
    const g = numericGradient(field, p[0], p[1], p[2], gradientStepM)
    const along = dot(u, g)
    // Seule la composante **transverse** du gradient courbe le rayon. Retirer la
    // composante longitudinale est ce qui garde `u` unitaire : sans cela, la
    // norme derive et la trajectoire avec elle.
    return [(g[0] - along * u[0]) / n, (g[1] - along * u[1]) / n, (g[2] - along * u[2]) / n]
  }

  while (steps < maxSteps) {
    const altitude = altitudeOf(position[0], position[1], position[2])
    if (altitude >= topAltitudeM) {
      escaped = true
      break
    }
    if (altitude < 0) break // le rayon a rencontre le sol

    const ds = Math.min(maxStepM, Math.max(minStepM, altitude * stepPerAltitude))

    // Runge-Kutta d'ordre 4 sur le couple (position, direction).
    const k1p = heading
    const k1u = derivative(position, heading)

    const p2: [number, number, number] = [
      position[0] + (ds / 2) * k1p[0],
      position[1] + (ds / 2) * k1p[1],
      position[2] + (ds / 2) * k1p[2],
    ]
    const u2: [number, number, number] = [
      heading[0] + (ds / 2) * k1u[0],
      heading[1] + (ds / 2) * k1u[1],
      heading[2] + (ds / 2) * k1u[2],
    ]
    const k2p = u2
    const k2u = derivative(p2, u2)

    const p3: [number, number, number] = [
      position[0] + (ds / 2) * k2p[0],
      position[1] + (ds / 2) * k2p[1],
      position[2] + (ds / 2) * k2p[2],
    ]
    const u3: [number, number, number] = [
      heading[0] + (ds / 2) * k2u[0],
      heading[1] + (ds / 2) * k2u[1],
      heading[2] + (ds / 2) * k2u[2],
    ]
    const k3p = u3
    const k3u = derivative(p3, u3)

    const p4: [number, number, number] = [
      position[0] + ds * k3p[0],
      position[1] + ds * k3p[1],
      position[2] + ds * k3p[2],
    ]
    const u4: [number, number, number] = [
      heading[0] + ds * k3u[0],
      heading[1] + ds * k3u[1],
      heading[2] + ds * k3u[2],
    ]
    const k4p = u4
    const k4u = derivative(p4, u4)

    for (let i = 0; i < 3; i++) {
      position[i] += (ds / 6) * (k1p[i] + 2 * k2p[i] + 2 * k3p[i] + k4p[i])
      heading[i] += (ds / 6) * (k1u[i] + 2 * k2u[i] + 2 * k3u[i] + k4u[i])
    }

    // Renormalisation : l'equation conserve la norme analytiquement, le schema
    // numerique la laisse deriver de quelques 10⁻¹⁶ par pas. Sur cent mille pas,
    // cela finirait par compter.
    const length = Math.hypot(heading[0], heading[1], heading[2]) || 1
    heading[0] /= length
    heading[1] /= length
    heading[2] /= length

    pathLength += ds
    steps++
  }

  const cos = Math.max(-1, Math.min(1, dot(start, heading)))
  return {
    position,
    direction: [heading[0], heading[1], heading[2]],
    pathLengthM: pathLength,
    escaped,
    steps,
    deflectionRad: Math.acos(cos),
  }
}

/**
 * Invariant de Bouguer le long d'un rayon, `n·r·sin z`.
 *
 * Il n'est **pas** utilise par le traceur : c'est precisement pour cela qu'il
 * sert de controle. Dans un champ spherique il doit rester constant ; dans un
 * champ qui ne l'est pas, sa derive **mesure** la brisure de symetrie.
 */
export function bouguerInvariant(
  field: AtmosphereField,
  position: readonly [number, number, number],
  direction: readonly [number, number, number],
): number {
  const radius = Math.hypot(position[0], position[1], position[2])
  const n = field.refractiveIndexAt(position[0], position[1], position[2])
  const norm = Math.hypot(direction[0], direction[1], direction[2]) || 1
  const cosZenith = dot(position, direction) / (radius * norm)
  const sinZenith = Math.sqrt(Math.max(0, 1 - cosZenith * cosZenith))
  return n * radius * sinZenith
}

/**
 * Refraction d'une visee, sans hypothese de symetrie.
 *
 * Meme grandeur que `refractionForApparent` de la phase 11, obtenue par un
 * chemin entierement different : integration de l'equation du rayon au lieu de
 * l'invariant. Leur accord est le controle central de cette phase.
 *
 * `azimuthRad` compte depuis le nord (−Z) vers l'est (+X), comme le reste de la
 * scene.
 */
export function refractionByTracing(
  field: AtmosphereField,
  apparentAltitudeDeg: number,
  options: { observerElevationM?: number; azimuthRad?: number } & RayTraceOptions = {},
): RayTraceResult {
  const { observerElevationM = 0, azimuthRad = 0, ...trace } = options
  const altitude = (apparentAltitudeDeg * Math.PI) / 180
  const cos = Math.cos(altitude)
  return traceRay(
    field,
    [0, RADIUS + observerElevationM, 0],
    [cos * Math.sin(azimuthRad), Math.sin(altitude), -cos * Math.cos(azimuthRad)],
    trace,
  )
}
