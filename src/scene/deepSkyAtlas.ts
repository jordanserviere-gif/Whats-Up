/**
 * Atlas de profils du ciel profond.
 *
 * Construit hors ligne par `npm run data:dso-atlas` a partir du service
 * hips2fits du CDS, et livre avec l'application comme les catalogues. Voir
 * l'en-tete de `scripts/build-dso-atlas.mjs` pour la fabrication.
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
 *
 * ## ⚠️ Ce qu'il ne porte pas
 *
 * **Aucune couleur.** Le releve interroge est le rouge du DSS2, une seule
 * bande : la teinte des objets vient d'ailleurs, de leur indice B−V de
 * catalogue. Une nebuleuse a emission est donc plus contrastee ici qu'a
 * l'oeil, sa raie Halpha tombant en plein dans ce filtre.
 */
import { useEffect, useState } from 'react'
import { ClampToEdgeWrapping, LinearFilter, NoColorSpace, Texture, TextureLoader } from 'three'
import atlasIndex from '@/data/dso-atlas.json'

interface RawAtlas {
  hips: string
  width: number
  height: number
  /** Marge du cadrage, en fraction du grand axe. */
  margin: number
  minMajorArcmin: number
  profileLoDex: number
  profileHiDex: number
  count: number
  /** Indices dans le catalogue du ciel profond. */
  catalogue: number[]
  /** Coin haut gauche de la tuile, en pixels de l'atlas. */
  x: number[]
  y: number[]
  /** Cote de la tuile, en pixels. Il suit la taille apparente de l'objet. */
  size: number[]
}

const RAW = atlasIndex as RawAtlas

export const DSO_ATLAS_URL = 'textures/dso-atlas.png'
export const DSO_ATLAS_WIDTH = RAW.width
export const DSO_ATLAS_HEIGHT = RAW.height
export const DSO_ATLAS_COUNT = RAW.count
export const DSO_ATLAS_MARGIN = RAW.margin
export const DSO_ATLAS_MIN_MAJOR_ARCMIN = RAW.minMajorArcmin
/** Bornes de l'encodage, en decades autour de la brillance moyenne. */
export const DSO_PROFILE_LO_DEX = RAW.profileLoDex
export const DSO_PROFILE_HI_DEX = RAW.profileHiDex

/**
 * Rectangle d'un objet dans l'atlas, en coordonnees de texture.
 *
 * `[u0, v0, du, dv]`, coin **bas gauche** et etendue — la convention de
 * three.js, dont l'axe vertical est retourne par rapport a l'image.
 */
export type AtlasRect = readonly [number, number, number, number]

const RECTS = (() => {
  const map = new Map<number, AtlasRect>()
  for (let k = 0; k < RAW.count; k++) {
    const size = RAW.size[k]
    // ⚠️ Un demi-texel de retrait : sans lui, le filtrage bilineaire irait
    // chercher la tuile voisine, qui n'a aucun rapport avec celle-ci.
    const inset = 0.5
    map.set(RAW.catalogue[k], [
      (RAW.x[k] + inset) / RAW.width,
      // Les rangees sont comptees depuis le haut de l'image, les coordonnees
      // de texture depuis le bas.
      (RAW.height - RAW.y[k] - size + inset) / RAW.height,
      (size - 2 * inset) / RAW.width,
      (size - 2 * inset) / RAW.height,
    ])
  }
  return map
})()

/** Rectangle d'un objet du catalogue, ou `null` s'il n'a pas d'image. */
export function atlasRectOf(catalogueIndex: number): AtlasRect | null {
  return RECTS.get(catalogueIndex) ?? null
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
 * premier rendu sur quelques megaoctets serait un mauvais echange.
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
