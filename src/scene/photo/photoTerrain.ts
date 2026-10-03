/**
 * Le maillage du mode photo, tel que le terrain l'affiche.
 *
 * Un simple porteur : le controleur du mode photo y depose la geometrie que le
 * worker a construite, et `Terrain` l'affiche a la place de son maillage
 * courant le temps du rendu haute definition. Hors de ce moment, il est vide.
 */
import { BufferAttribute, BufferGeometry } from 'three'
import type { PhotoWorkerMessage } from './photoWorker'

type Done = Extract<PhotoWorkerMessage, { type: 'done' }>

let current: BufferGeometry | null = null
const listeners = new Set<() => void>()

export const photoGeometry = (): BufferGeometry | null => current

export function subscribePhotoGeometry(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Geometrie three a partir du resultat du worker — memes attributs que le maillage courant. */
export function geometryFromResult(result: Done): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(result.positions, 3))
  g.setAttribute('normal', new BufferAttribute(result.normals, 3))
  g.setAttribute('range', new BufferAttribute(result.ranges, 1))
  g.setAttribute('altitude', new BufferAttribute(result.altitudes, 1))
  // La visibilite du Soleil, calculee par un rayon par sommet : elle remplace
  // la carte d'ombre a 234 m pour la surface. Voir `sunVisibility`.
  g.setAttribute('sunVisibility', new BufferAttribute(result.sunVisibility, 1))
  g.setIndex(new BufferAttribute(result.index, 1))
  return g
}

export function setPhotoGeometry(next: BufferGeometry | null): void {
  if (current && current !== next) current.dispose()
  current = next
  listeners.forEach((fn) => fn())
}
