import { useEffect, useRef } from 'react'
import { Vector3 } from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { horizontalToScene } from './sceneMath'
import type { Horizontal } from '@/astro/types'

export interface SceneLabel {
  id: string
  text: string
  horizontal: Horizontal
  color: string
  /** Style d'etiquette : influence la taille et l'opacite. */
  kind: 'body' | 'satellite' | 'cardinal' | 'constellation'
}

/**
 * Etiquettes du ciel.
 *
 * Elles vivent dans le DOM (pour beneficier de la typographie et des tokens MD3)
 * mais sont positionnees par projection depuis la scene, sans passer par le
 * rendu React : le `useFrame` ecrit directement dans les styles.
 */
export function LabelLayer({ labels, host }: { labels: SceneLabel[]; host: React.RefObject<HTMLDivElement> }) {
  const { camera, size } = useThree()
  const nodes = useRef(new Map<string, HTMLElement>())
  const world = useRef(new Vector3())

  // Synchronise les elements DOM avec la liste d'etiquettes.
  useEffect(() => {
    const container = host.current
    if (!container) return
    const wanted = new Set(labels.map((l) => l.id))

    for (const [id, node] of nodes.current) {
      if (!wanted.has(id)) {
        node.remove()
        nodes.current.delete(id)
      }
    }

    for (const label of labels) {
      let node = nodes.current.get(label.id)
      if (!node) {
        node = document.createElement('span')
        node.className = `sky-label sky-label--${label.kind}`
        container.appendChild(node)
        nodes.current.set(label.id, node)
      }
      if (node.textContent !== label.text) node.textContent = label.text
      node.style.color = label.color
    }
  }, [labels, host])

  // Nettoyage au demontage.
  useEffect(() => {
    const map = nodes.current
    return () => {
      for (const node of map.values()) node.remove()
      map.clear()
    }
  }, [])

  useFrame(() => {
    for (const label of labels) {
      const node = nodes.current.get(label.id)
      if (!node) continue
      const [x, y, z] = horizontalToScene(label.horizontal)
      world.current.set(x, y, z).project(camera)

      // z > 1 : le point est derriere la camera.
      if (world.current.z > 1 || Math.abs(world.current.x) > 1.15 || Math.abs(world.current.y) > 1.15) {
        node.style.opacity = '0'
        continue
      }
      const sx = (world.current.x * 0.5 + 0.5) * size.width
      const sy = (-world.current.y * 0.5 + 0.5) * size.height
      node.style.transform = `translate3d(${Math.round(sx)}px, ${Math.round(sy)}px, 0)`
      node.style.opacity = '1'
    }
  })

  return null
}
