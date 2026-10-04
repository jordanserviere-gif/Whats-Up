/**
 * Mode photo — le cadrage, et l'ombre par rayon.
 *
 * Le rendu au pixel vit dans `photoRaster.ts`, les tuiles dans `photoTiles.ts`.
 * Ce module garde ce qu'ils partagent : la description du cadre et le rayon
 * d'ombre, penombre du disque solaire comprise.
 *
 * Pur : ni DOM, ni three.js.
 */

const DEG = Math.PI / 180

/** Ce que voit la photo : le cadrage et sa definition. */
export interface PhotoView {
  /** Azimut du centre de l'image, degres depuis le nord vers l'est. */
  azimuthDeg: number
  /** Hauteur du centre de l'image, degres. */
  altitudeDeg: number
  /** Champ **vertical**, degres. */
  fovDeg: number
  /** Largeur sur hauteur. */
  aspect: number
  /** Definition de la photo, pixels. */
  widthPx: number
  heightPx: number
}

/** Angle d'un pixel de la photo, radians. */
export const photoPixelAngleRad = (view: PhotoView): number => (view.fovDeg * DEG) / Math.max(1, view.heightPx)

/** Altitude du relief en un point du plan local (est, nord), metres. */
export type Sampler = (eastM: number, northM: number) => number

// --- Ombres --------------------------------------------------------------------

/**
 * Demi-diametre apparent du Soleil, degres.
 *
 * C'est lui qui fait la penombre : un point voit une fraction du disque, pas
 * tout ou rien. La carte d'ombre courante l'ignore et dessine une frontiere
 * nette ; la photo, qui suit un rayon par sommet, peut la rendre.
 */
export const SUN_SEMI_DIAMETER_DEG = 0.2666

/**
 * Raison de la progression des pas d'un rayon d'ombre.
 *
 * ⚠️ Elle valait 1,045, et la validation l'a recalee : un pas de 4,5 % de la
 * distance peut enjamber le haut d'une crete proche, et l'horizon lu tombe
 * alors jusqu'a un degre trop bas — l'ombre glisse, et la penombre, large d'un
 * demi-degre, disparait. A 2,5 % l'erreur reste sous le demi-diametre solaire.
 */
const SHADOW_STEP_RATIO = 1.025

/** Portee des rayons d'ombre, metres — celle de la carte courante. */
export const SHADOW_REACH_M = 60_000

/**
 * Part du disque solaire visible depuis un point, de 0 a 1.
 *
 * On remonte la direction du Soleil depuis le point et l'on garde l'angle le
 * plus haut sous lequel le relief se dresse, courbure de la Terre comprise :
 *
 *     horizon = max sur t de atan[(h(P + t·L) − t²/2R − h(P)) / t]
 *
 * La visibilite est alors la part du disque au-dessus de cet horizon,
 * interpolee lineairement sur son diametre — une corde de disque serait plus
 * juste de quelques pour cent, et ne se verrait pas.
 *
 * Le pas croit geometriquement : un metre au pied du point, trois kilometres a
 * soixante. Le relief qui ombre de loin est grand, et c'est pres du point que
 * la crete fine compte.
 *
 * La marche s'arrete des que meme le plus haut sommet connu ne pourrait plus
 * remonter l'horizon au-dessus du bas du disque : par Soleil haut, quelques pas
 * suffisent.
 */
export function sunVisibility(
  sample: Sampler,
  eastM: number,
  northM: number,
  altitudeM: number,
  sunAltitudeDeg: number,
  sunAzimuthDeg: number,
  effectiveRadiusM: number,
  peakM: number,
  startM: number,
  /** Echantillonneur pour le loin du rayon — le relief courant, bien plus rapide. */
  far: Sampler = sample,
  /** Distance a partir de laquelle `far` prend le relais, metres. */
  farFromM = Infinity,
): number {
  const lx = Math.sin(sunAzimuthDeg * DEG)
  const ly = Math.cos(sunAzimuthDeg * DEG)
  const low = Math.tan((sunAltitudeDeg - SUN_SEMI_DIAMETER_DEG) * DEG)
  const high = Math.tan((sunAltitudeDeg + SUN_SEMI_DIAMETER_DEG) * DEG)
  let maxTan = -Infinity
  let t = Math.max(1, startM)
  while (t < SHADOW_REACH_M) {
    const drop = (t * t) / (2 * effectiveRadiusM)
    const h = (t < farFromM ? sample : far)(eastM + t * lx, northM + t * ly) - drop
    const tanH = (h - altitudeM) / t
    if (tanH > maxTan) {
      maxTan = tanH
      // Le disque est deja cache tout entier : rien plus loin n'y changera rien.
      if (maxTan >= high) return 0
    }
    // Plus loin, meme le plus haut sommet ne depasserait ni l'horizon deja
    // trouve, ni le bas du disque : la reponse ne peut plus changer.
    // ⚠️ Il fallait les **deux** jusqu'ici — un rayon deja assez masque, ou deja
    // assez libre, courait pour rien jusqu'a soixante kilometres.
    const bound = (peakM - drop - altitudeM) / t
    if (bound < Math.max(low, maxTan)) break
    // Au-dela de deux kilometres, le pas s'allonge : une crete qui ombre de
    // loin est grande, et un pas de 5 % ne la manque plus.
    t = t * (t < 2000 ? SHADOW_STEP_RATIO : 1.05) + 0.5
  }
  const horizonDeg = Math.atan(maxTan) / DEG
  const v = (sunAltitudeDeg - horizonDeg) / (2 * SUN_SEMI_DIAMETER_DEG) + 0.5
  return v <= 0 ? 0 : v >= 1 ? 1 : v
}
