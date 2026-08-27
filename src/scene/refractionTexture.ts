/**
 * Texture de refraction, partagee par toutes les couches du ciel.
 *
 * ## Pourquoi une texture, et pourquoi partagee
 *
 * Le ciel est peuple par cinq mecanismes de placement differents : les corps du
 * systeme solaire sont positionnes sur le processeur, les etoiles et le ciel
 * profond par rotation d'une direction equatoriale dans un nuanceur, les
 * constellations par une matrice appliquee a un objet entier, les etiquettes par
 * leurs coordonnees horizontales.
 *
 * La refraction doit entrer dans **tous** a la fois. Une planete relevee d'un
 * demi-degre au-dessus de constellations qui ne l'auraient pas ete se
 * detacherait de son champ d'etoiles de plus d'un diametre lunaire — un defaut
 * bien pire que l'absence de refraction, et c'est la raison pour laquelle la
 * phase 11 avait ete livree sans cablage.
 *
 * D'ou une **seule** table, lue par les deux cotes : `refractSceneDirection` sur
 * le processeur, `REFRACTION_LUT_GLSL` sur le GPU, tous deux nourris par la meme
 * `RefractionTable`.
 *
 * ## Elle ne se reconstruit presque jamais
 *
 * La refraction ne depend ni de l'heure, ni de la direction, ni du Soleil : elle
 * ne depend que de l'atmosphere et de l'altitude de l'observateur. La table est
 * donc memoisee par site, et sa construction — seize millisecondes — n'arrive
 * qu'au changement de lieu.
 *
 * ## Format
 *
 * `RGBA` flottant de 512 x 1. Le canal rouge porte **la refraction en degres**,
 * pas la hauteur apparente : l'ecart est petit et lisse, de zero au zenith a un
 * demi-degre a l'horizon, la ou la hauteur apparente couvrirait quatre-vingt-dix
 * degres. L'erreur d'interpolation porte ainsi sur la petite quantite.
 *
 * Mesure : la texture reproduit la table a **2,0 secondes d'arc**, pour un
 * disque solaire qui en fait 1920.
 */
import { ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, RGBAFormat } from 'three'
import {
  REFRACTION_LUT_WIDTH,
  isRefractionEnabled,
  fillRefractionLut,
  sharedRefractionTable,
  type RefractionTable,
} from '@/atmosphere/refraction/refractionTable'

interface Entry {
  texture: DataTexture
  table: RefractionTable
}

const entries = new Map<number, Entry>()

/**
 * Table et texture pour un site donne, construites a la premiere demande.
 *
 * Les deux vont ensemble : le processeur lit la table, le GPU lit la texture, et
 * elles portent les memes valeurs par construction.
 */
export function refractionFor(observerElevationM: number): Entry {
  const key = Math.round(observerElevationM)
  const cached = entries.get(key)
  if (cached) return cached

  const table = sharedRefractionTable(key)
  const data = new Float32Array(REFRACTION_LUT_WIDTH * 4)
  fillRefractionLut(data, table)

  const texture = new DataTexture(data, REFRACTION_LUT_WIDTH, 1, RGBAFormat, FloatType)
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true

  const entry = { texture, table }
  entries.set(key, entry)
  return entry
}

/**
 * Site courant, publie par le fond de ciel et lu par toutes les couches.
 *
 * Meme raison que pour les textures de perspective atmospherique : les couches
 * du ciel sont des freres dans la scene, et faire descendre l'altitude de
 * l'observateur par les proprietes traverserait une demi-douzaine de composants
 * qui n'en ont que faire.
 */
export const refractionSite = { observerElevationM: 0 }

/** Bloc d'uniformes attendu par `REFRACTION_LUT_GLSL`. */
export function refractionUniforms() {
  return {
    uRefractionLut: { value: null as DataTexture | null },
    uRefractionWidth: { value: REFRACTION_LUT_WIDTH },
    /**
     * Zero desactive la refraction.
     *
     * C'est la vue depuis l'espace : sans atmosphere, les rayons redeviennent
     * droits. Un cas du modele, et non une exception a traiter a part.
     */
    uRefractionActive: { value: 0 },
  }
}

/** Recopie la texture et l'etat courant dans un materiau. */
export function applyRefractionUniforms(uniforms: ReturnType<typeof refractionUniforms>): void {
  uniforms.uRefractionLut.value = refractionFor(refractionSite.observerElevationM).texture
  uniforms.uRefractionWidth.value = REFRACTION_LUT_WIDTH
  uniforms.uRefractionActive.value = isRefractionEnabled() ? 1 : 0
}
