/**
 * Orientation des corps dans l'espace : axe de rotation et meridien origine.
 *
 * Sans cela, une carte de surface serait plaquee au hasard. Avec, la Lune
 * presente bien sa face visible, Mars montre la bonne hemisphere et la Grande
 * Tache rouge de Jupiter tourne au bon rythme.
 */
import * as A from 'astronomy-engine'
import { DEG } from './coords'

export interface BodyOrientation {
  /** Pole nord du corps, vecteur unitaire dans le repere equatorial de la date. */
  north: [number, number, number]
  /** Direction du meridien origine, meme repere. */
  primeMeridian: [number, number, number]
}

const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

function normalize(v: readonly number[]): [number, number, number] {
  const n = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / n, v[1] / n, v[2] / n]
}

/**
 * Axe de rotation et meridien origine d'un corps a un instant donne.
 *
 * `RotationAxis` fournit le pole nord et l'angle W du meridien origine, tous
 * deux en J2000. On construit le meridien selon la convention UAI — a partir du
 * noeud ascendant de l'equateur du corps sur l'equateur celeste — puis on amene
 * le tout dans le repere de la date, celui qu'utilise la scene.
 */
export function bodyOrientation(body: A.Body, date: Date): BodyOrientation {
  const axis = A.RotationAxis(body, date)
  const northEqj = normalize([axis.north.x, axis.north.y, axis.north.z])

  // Noeud ascendant : intersection de l'equateur du corps et de l'equateur celeste.
  const node = normalize(cross([0, 0, 1], northEqj))
  const w = axis.spin * DEG
  const perpendicular = cross(northEqj, node)
  const meridianEqj = normalize([
    node[0] * Math.cos(w) + perpendicular[0] * Math.sin(w),
    node[1] * Math.cos(w) + perpendicular[1] * Math.sin(w),
    node[2] * Math.cos(w) + perpendicular[2] * Math.sin(w),
  ])

  // J2000 → equateur de la date : la scene travaille en coordonnees de la date.
  const rotation = A.Rotation_EQJ_EQD(date)
  const toEqd = (v: [number, number, number]): [number, number, number] => {
    const out = A.RotateVector(rotation, new A.Vector(v[0], v[1], v[2], A.MakeTime(date)))
    return [out.x, out.y, out.z]
  }

  return { north: toEqd(northEqj), primeMeridian: toEqd(meridianEqj) }
}
