/**
 * Atlas de profils du ciel profond.
 *
 * Construit hors ligne par `npm run data:dso-atlas` a partir du service hips2fits du
 * CDS, et livre avec l'application comme les catalogues. Voir l'en-tete de
 * `scripts/build-dso-atlas.mjs` pour la fabrication.
 *
 * ## Ce que porte l'octet
 *
 * ⚠️ **Pas une luminance.** Une plaque photographique n'est pas une carte de
 * radiance : la lire comme telle contredirait la photometrie du moteur, qui
 * deduit deja la brillance de surface de la magnitude et des dimensions du
 * catalogue — c'est le meme piege que l'orthophoto drapee sur le terrain.
 *
 * L'atlas ne porte donc que le **profil** : la maniere dont la lumiere se
 * repartit dans l'objet, ramenee a une moyenne de un sur l'ellipse. L'octet
 * stocke `log10` de ce profil, ce qui revient a un **ecart de magnitude** par
 * rapport a la brillance moyenne :
 *
 *     mu_locale = mu_moyenne − 2,5·log10(p)
 *
 * Dix magnitudes sur 255 niveaux, soit un pas de 0,039 magnitude, constant du
 * coeur au halo. C'est le niveau absolu du moteur qui decide ensuite de ce
 * qu'on voit.
 */
import { useEffect, useState } from 'react'
import { ClampToEdgeWrapping, LinearFilter, NoColorSpace, Texture, TextureLoader } from 'three'
import atlasIndex from '@/data/dso-atlas.json'

interface RawAtlas {
  hips: string
  tile: number
  grid: number
  minMajorArcmin: number
  profileLoDex: number
  profileHiDex: number
  count: number
  /** Indices dans le catalogue du ciel profond. */
  catalogue: number[]
  /** Emplacement dans la grille, compte en ligne depuis le coin haut gauche. */
  slot: number[]
}

const RAW = atlasIndex as RawAtlas

export const DSO_ATLAS_URL = 'textures/dso-atlas.png'
export const DSO_ATLAS_TILE = RAW.tile
export const DSO_ATLAS_GRID = RAW.grid
export const DSO_ATLAS_COUNT = RAW.count
export const DSO_ATLAS_MIN_MAJOR_ARCMIN = RAW.minMajorArcmin
/** Bornes de l'encodage, en decades autour de la brillance moyenne. */
export const DSO_PROFILE_LO_DEX = RAW.profileLoDex
export const DSO_PROFILE_HI_DEX = RAW.profileHiDex

/** Emplacement d'un objet du catalogue, ou −1 s'il n'a pas d'image. */
const SLOTS = (() => {
  const map = new Map<number, number>()
  for (let k = 0; k < RAW.count; k++) map.set(RAW.catalogue[k], RAW.slot[k])
  return map
})()

export function atlasSlotOf(catalogueIndex: number): number {
  return SLOTS.get(catalogueIndex) ?? -1
}

/**
 * Ecart de brillance porte par un octet de l'atlas, en magnitudes.
 *
 * Zero rend la brillance moyenne de l'objet ; positif, plus faible. C'est la
 * meme conversion que celle du nuanceur, ecrite ici pour pouvoir la valider.
 */
export function profileMagnitudeOffset(byte: number): number {
  const dex = DSO_PROFILE_LO_DEX + (byte / 255) * (DSO_PROFILE_HI_DEX - DSO_PROFILE_LO_DEX)
  return -2.5 * dex
}

let cached: Texture | null = null
let pending: Promise<Texture> | null = null

function load(): Promise<Texture> {
  if (cached) return Promise.resolve(cached)
  if (pending) return pending
  pending = new Promise<Texture>((resolve, reject) => {
    new TextureLoader().load(
      DSO_ATLAS_URL,
      (texture) => {
        // ⚠️ Aucun espace colorimetrique : l'octet est un ecart de magnitude,
        // pas une couleur. Le decoder en sRGB courberait le profil.
        texture.colorSpace = NoColorSpace
        // Pas de mipmaps : elles melangeraient les tuiles voisines, qui n'ont
        // aucun rapport entre elles.
        texture.generateMipmaps = false
        texture.minFilter = LinearFilter
        texture.magFilter = LinearFilter
        texture.wrapS = ClampToEdgeWrapping
        texture.wrapT = ClampToEdgeWrapping
        cached = texture
        resolve(texture)
      },
      undefined,
      (err) => {
        pending = null
        reject(err)
      },
    )
  })
  return pending
}

/**
 * Charge l'atlas en tache de fond.
 *
 * Meme parti pris que les cartes de surface : la scene s'affiche tout de suite,
 * avec le profil analytique, et se precise a l'arrivee des images. Bloquer le
 * premier rendu sur deux megaoctets et demi serait un mauvais echange.
 */
export function useDeepSkyAtlas(): Texture | null {
  const [texture, setTexture] = useState<Texture | null>(cached)
  useEffect(() => {
    let cancelled = false
    load().then(
      (t) => {
        if (!cancelled) setTexture(t)
      },
      () => {
        /* Sans atlas, le profil analytique reste. */
      },
    )
    return () => {
      cancelled = true
    }
  }, [])
  return texture
}
