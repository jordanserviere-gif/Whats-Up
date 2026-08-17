import { useEffect, useRef } from 'react'
import { PerspectiveCamera, Vector3 } from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { horizontalToScene } from './sceneMath'
import type { Horizontal } from '@/astro/types'

const DEG = Math.PI / 180

export interface SceneLabel {
  id: string
  text: string
  horizontal: Horizontal
  color: string
  /** Style d'etiquette : influence la taille et l'opacite. */
  kind: 'body' | 'satellite' | 'cardinal' | 'constellation' | 'fixed' | 'aircraft'
  /**
   * Rayon apparent de l'objet, en degres.
   *
   * L'etiquette se pose au bord du disque, pas a une distance fixe du centre :
   * a champ resserre, Jupiter couvre plusieurs centaines de pixels et un decalage
   * constant deposerait son nom au milieu de la planete.
   */
  angularRadiusDeg?: number
  /**
   * Position recalculee a chaque image plutot que lue telle quelle.
   *
   * Sert aux objets qu'on veut voir glisser en continu — un avion, par
   * exemple, dont la mesure ADS-B n'arrive que toutes les vingt secondes —
   * sans attendre que la liste d'etiquettes elle-meme soit reconstruite.
   */
  resolve?: () => Horizontal
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
        // Le repere d'un avion est un glyphe Material Symbols, pas du texte :
        // meme convention que le composant `Icon` (nom du glyphe en contenu).
        node.className = `sky-label sky-label--${label.kind}${label.kind === 'aircraft' ? ' md-icon' : ''}`
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
    // Echelle de projection : un objet de rayon angulaire θ, vu pres de l'axe,
    // occupe (hauteur / 2) · tan θ / tan(champ / 2) pixels a l'ecran.
    const fov = (camera as PerspectiveCamera).fov ?? 60
    const pixelsPerTan = size.height / 2 / Math.tan((fov * DEG) / 2)

    for (const label of labels) {
      const node = nodes.current.get(label.id)
      if (!node) continue
      const [x, y, z] = horizontalToScene(label.resolve ? label.resolve() : label.horizontal)
      world.current.set(x, y, z).project(camera)

      // z > 1 : le point est derriere la camera.
      if (world.current.z > 1 || Math.abs(world.current.x) > 1.15 || Math.abs(world.current.y) > 1.15) {
        node.style.opacity = '0'
        continue
      }
      const sx = (world.current.x * 0.5 + 0.5) * size.width
      const sy = (-world.current.y * 0.5 + 0.5) * size.height

      // Le decalage suit le disque. Il est plafonne au quart de l'ecran : sur un
      // objet plus large que le champ, suivre le bord jetterait l'etiquette hors
      // cadre alors que l'objet, lui, est bien la.
      const radiusPx = label.angularRadiusDeg
        ? Math.min(size.height / 4, Math.tan(label.angularRadiusDeg * DEG) * pixelsPerTan)
        : 0
      const offset = Math.round(radiusPx * 0.72)

      node.style.transform = `translate3d(${Math.round(sx) + offset}px, ${Math.round(sy) + offset}px, 0)`
      node.style.opacity = '1'
    }
  })

  return null
}
