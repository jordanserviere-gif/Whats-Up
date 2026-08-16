import { useEffect, useState } from 'react'
import { SRGBColorSpace, Texture, TextureLoader } from 'three'
import type { BodyId } from '@/astro/types'

/**
 * Cartes de surface, Solar System Scope — CC BY 4.0.
 * Recuperees par `npm run textures`, servies depuis `public/`.
 *
 * Le Soleil n'en a pas : a l'oeil nu, ce n'est pas une surface texturee mais un
 * disque eblouissant. Pluton non plus, faute de carte dans le jeu source.
 */
const TEXTURE_URLS: Partial<Record<BodyId, string>> = {
  mercury: 'textures/mercury.jpg',
  venus: 'textures/venus.jpg',
  moon: 'textures/moon.jpg',
  mars: 'textures/mars.jpg',
  jupiter: 'textures/jupiter.jpg',
  saturn: 'textures/saturn.jpg',
  uranus: 'textures/uranus.jpg',
  neptune: 'textures/neptune.jpg',
}

export const SATURN_RING_TEXTURE = 'textures/saturn-ring.png'

/** Cache de module : les cartes ne sont chargees qu'une fois par session. */
const cache = new Map<string, Texture>()
const pending = new Map<string, Promise<Texture>>()

function load(url: string): Promise<Texture> {
  const hit = cache.get(url)
  if (hit) return Promise.resolve(hit)
  const inflight = pending.get(url)
  if (inflight) return inflight

  const promise = new Promise<Texture>((resolve, reject) => {
    new TextureLoader().load(
      url,
      (texture) => {
        // Cartes equirectangulaires : elles portent des couleurs, donc sRGB.
        texture.colorSpace = SRGBColorSpace
        texture.anisotropy = 8
        cache.set(url, texture)
        pending.delete(url)
        resolve(texture)
      },
      undefined,
      (err) => {
        pending.delete(url)
        reject(err)
      },
    )
  })
  pending.set(url, promise)
  return promise
}

/**
 * Charge les cartes de surface en tache de fond.
 *
 * Volontairement hors de `Suspense` : la scene doit s'afficher immediatement,
 * avec des corps unis, et se texturer a mesure. Bloquer le premier rendu sur
 * trois megaoctets de cartes serait un mauvais echange.
 */
export function useBodyTextures(): Map<string, Texture> {
  const [textures, setTextures] = useState<Map<string, Texture>>(() => new Map(cache))

  useEffect(() => {
    let cancelled = false
    const urls = [...Object.values(TEXTURE_URLS), SATURN_RING_TEXTURE]

    Promise.allSettled(urls.map(load)).then(() => {
      if (!cancelled) setTextures(new Map(cache))
    })

    return () => {
      cancelled = true
    }
  }, [])

  // Indexe par identifiant de corps plutot que par URL, pour l'appelant.
  const byBody = new Map<string, Texture>()
  for (const [id, url] of Object.entries(TEXTURE_URLS)) {
    const texture = textures.get(url)
    if (texture) byBody.set(id, texture)
  }
  const ring = textures.get(SATURN_RING_TEXTURE)
  if (ring) byBody.set('saturn-ring', ring)
  return byBody
}
