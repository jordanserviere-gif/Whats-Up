/**
 * Ombre du relief — l'altitude a laquelle le Soleil se leve, en chaque point.
 *
 * ## Ce qu'elle repare
 *
 * La table de perspective atmospherique est construite pour une atmosphere **a
 * symetrie spherique**, donc sans relief : chaque point d'air y est eclaire par
 * un Soleil que rien ne masque. C'est exact tant que rien ne se dresse ; faux
 * des qu'une montagne se leve devant.
 *
 * Le symptome est net : Soleil levant derriere une chaine, l'air situe **entre
 * elle et l'observateur** est dans son ombre, mais le modele l'eclaire en plein.
 * Comme on regarde presque droit vers le Soleil, le pic de diffusion avant de
 * Mie y sature a blanc — et la montagne parait traversee par une lueur qui
 * n'existe pas.
 *
 * ## Ce que cette carte porte, et pourquoi ce n'est pas de la cuisson
 *
 * Pour un instant donne, la direction du Soleil est **fixe**. L'ensemble des
 * points ombres par le relief est alors delimite par une surface : au-dessus, on
 * voit le Soleil ; en dessous, non. Cette surface est une **fonction du relief
 * et de la direction solaire**, rien d'autre — et c'est elle qu'on calcule :
 *
 *     ombre(P) = max sur t>0 de [ h(P + t·L) − t·tan(a) − chute(t) ]
 *
 * ou `L` est la direction horizontale vers le Soleil, `a` sa hauteur, et
 * `chute` l'abaissement du a la courbure de la Terre. Aucune apparence n'est
 * stockee : seulement une **altitude**, qui se deduit de la geometrie. Deplacer
 * le Soleil d'un degre la change entierement, et c'est le signe qu'elle est une
 * consequence et non une decoration.
 *
 * ## Le balayage, et pourquoi il est lineaire
 *
 * Calculer le maximum ci-dessus point par point demanderait une marche par
 * texel. On l'evite par une **recurrence** : le voisin situe vers le Soleil
 * connait deja son propre maximum, et il suffit de l'abaisser d'un pas.
 *
 *     ombre(P) = max( h(P), ombre(P + δ·L) − δ·tan(a) − chute(δ) )
 *
 * En parcourant la grille dans l'ordre decroissant de `P·L`, le voisin est
 * toujours deja calcule. Le cout tombe de `O(N·K)` a `O(N)`, et la carte se
 * construit en une passe.
 *
 * ## ⚠️ Ce qu'elle ne fait pas
 *
 * **La penombre est ignoree.** Le Soleil a un demi-degre de diametre, et le bord
 * de son ombre est donc flou sur une largeur qui croit avec la distance a
 * l'occulteur — cinq metres a un kilometre, cinquante a dix. La carte rend une
 * frontiere nette. Ce serait le premier raffinement a apporter.
 *
 * **Sa portee s'arrete a soixante kilometres.** Au-dela, le relief n'ombre plus
 * rien et n'est plus ombre. Ce n'est pas un renoncement mais un constat : a
 * cette distance un pixel couvre trente-six metres, et le relief ne s'y lit plus
 * que comme une **silhouette sur le ciel** — son ombrage propre est sous le
 * pixel. Etendre la carte a la portee du maillage quadruplerait le balayage pour
 * un detail que personne ne verrait.
 *
 * La contrepartie est reelle et bornee : l'ombre tres longue d'un sommet au
 * lever du Soleil est tronquee a soixante kilometres.
 */
import { groundAltitudeM, terrainRevision } from './elevationField'

/** Demi-etendue de la carte, metres. */
export const SHADOW_HALF_SPAN_M = 60_000

/**
 * Cotes de la grille.
 *
 * Cinq cent douze sur cent vingt kilometres : **234 metres par texel**. C'est
 * six pixels a la portee maximale de la carte, ou l'ombre n'a plus a etre fine,
 * et bien mieux que ce qu'exige la penombre — qu'on neglige de toute facon.
 *
 * ⚠️ Ce grain reste **huit fois plus grossier que le relief lui-meme**, qui est
 * a trente metres. Le bord d'une ombre proche est donc plus lisse que la crete
 * qui la porte. C'est le compromis assume : le balayage est refait a chaque pas
 * du Soleil, et le quadrupler pour 1024 couterait une saccade visible.
 */
export const SHADOW_SIZE = 512

/** Metres par texel. */
export const SHADOW_STEP_M = (2 * SHADOW_HALF_SPAN_M) / (SHADOW_SIZE - 1)

/**
 * Altitude en dessous de laquelle un point est prive de Soleil, metres.
 *
 * Indexee `[iz * SHADOW_SIZE + ix]`, avec `ix` vers l'est et `iz` vers le nord.
 */
export interface SunShadowMap {
  readonly height: Float32Array
  /** Hauteur solaire pour laquelle la carte vaut, degres. */
  readonly sunAltitudeDeg: number
  /** Azimut solaire, degres. */
  readonly sunAzimuthDeg: number
}

const east = (ix: number) => ix * SHADOW_STEP_M - SHADOW_HALF_SPAN_M
const north = (iz: number) => iz * SHADOW_STEP_M - SHADOW_HALF_SPAN_M

/**
 * Lecture bilineaire de la carte en cours de construction.
 *
 * Le voisin vers le Soleil ne tombe pas sur un texel : la direction solaire n'a
 * aucune raison de suivre la grille.
 */
function sample(height: Float32Array, eastM: number, northM: number): number {
  const fx = (eastM + SHADOW_HALF_SPAN_M) / SHADOW_STEP_M
  const fz = (northM + SHADOW_HALF_SPAN_M) / SHADOW_STEP_M
  if (fx < 0 || fz < 0 || fx > SHADOW_SIZE - 1 || fz > SHADOW_SIZE - 1) return -Infinity
  const ix = Math.min(SHADOW_SIZE - 2, Math.floor(fx))
  const iz = Math.min(SHADOW_SIZE - 2, Math.floor(fz))
  const tx = fx - ix
  const tz = fz - iz
  const a = height[iz * SHADOW_SIZE + ix]
  const b = height[iz * SHADOW_SIZE + ix + 1]
  const c = height[(iz + 1) * SHADOW_SIZE + ix]
  const d = height[(iz + 1) * SHADOW_SIZE + ix + 1]
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz
}

/**
 * Le relief echantillonne sur la grille — calcule **une fois**.
 *
 * Il ne depend ni de l'heure ni du Soleil. Le separer evite de reevaluer un
 * million et demi d'octaves de bruit a chaque pas du Soleil : seul le balayage,
 * qui ne fait que des additions, est refait.
 */
let terrainCache: Float32Array | null = null
let terrainCacheRevision = ''
function terrainHeights(): Float32Array {
  // La revision distingue le banc du relief reel, et compte les niveaux de
  // pyramide deja charges : un relief echantillonne avant l'arrivee des tuiles
  // decrit une mer plate, et resterait tel quel sans cette cle.
  const revision = terrainRevision()
  if (terrainCache && terrainCacheRevision === revision) return terrainCache
  const h = new Float32Array(SHADOW_SIZE * SHADOW_SIZE)
  for (let iz = 0; iz < SHADOW_SIZE; iz++) {
    for (let ix = 0; ix < SHADOW_SIZE; ix++) {
      h[iz * SHADOW_SIZE + ix] = groundAltitudeM(east(ix), north(iz))
    }
  }
  terrainCache = h
  terrainCacheRevision = revision
  return h
}

/**
 * Construit la carte pour une position du Soleil.
 *
 * `effectiveRadiusM` est le rayon terrestre sous refraction, le meme que celui
 * qui place les sommets : l'ombre d'une montagne lointaine suit la courbure
 * comme la montagne elle-meme.
 */
export function buildSunShadowMap(
  sunAltitudeDeg: number,
  sunAzimuthDeg: number,
  effectiveRadiusM: number,
): SunShadowMap {
  // Un point est toujours ombre par lui-meme : la recurrence part du relief.
  const height = Float32Array.from(terrainHeights())

  // Soleil sous l'horizon : plus rien ne recoit le rayon direct, et la
  // recurrence n'aurait pas de sens — avec une tangente negative l'ombre
  // monterait indefiniment en s'eloignant.
  //
  // Declarer tout le domaine prive de Soleil est alors **exact**, et non un
  // pis-aller : c'est la Terre elle-meme qui fait l'ombre. Ce qui rendait
  // autrefois ce raccourci ruineux, c'est que le nuanceur en deduisait
  // l'absence de toute diffusion, et la chaine se decoupait en noir absolu sur
  // un ciel encore clair. Depuis que chaque segment ombre retombe sur sa part
  // ambiante, la consequence est la bonne : plus de Soleil, mais toujours le
  // ciel.
  if (sunAltitudeDeg <= 0) {
    height.fill(Number.POSITIVE_INFINITY)
    return { height, sunAltitudeDeg, sunAzimuthDeg }
  }

  // Direction **horizontale** vers le Soleil, dans le plan local.
  const az = (sunAzimuthDeg * Math.PI) / 180
  const lEast = Math.sin(az)
  const lNorth = Math.cos(az)
  const tanAlt = Math.tan((sunAltitudeDeg * Math.PI) / 180)

  // Un pas de la recurrence : la longueur d'un texel projetee sur la direction
  // dominante, pour que le voisin interpole reste voisin.
  const step = SHADOW_STEP_M / Math.max(Math.abs(lEast), Math.abs(lNorth))
  // Ce que l'ombre perd en montant d'un pas vers le Soleil, courbure comprise.
  const drop = step * tanAlt + (step * step) / (2 * effectiveRadiusM)

  // Ordre de parcours : on remonte **vers** le Soleil, pour que le voisin
  // interroge soit toujours deja resolu.
  const xFrom = lEast > 0 ? SHADOW_SIZE - 1 : 0
  const xTo = lEast > 0 ? -1 : SHADOW_SIZE
  const xStep = lEast > 0 ? -1 : 1
  const zFrom = lNorth > 0 ? SHADOW_SIZE - 1 : 0
  const zTo = lNorth > 0 ? -1 : SHADOW_SIZE
  const zStep = lNorth > 0 ? -1 : 1

  for (let iz = zFrom; iz !== zTo; iz += zStep) {
    for (let ix = xFrom; ix !== xTo; ix += xStep) {
      const upstream = sample(height, east(ix) + lEast * step, north(iz) + lNorth * step)
      if (upstream === -Infinity) continue
      const cast = upstream - drop
      const i = iz * SHADOW_SIZE + ix
      if (cast > height[i]) height[i] = cast
    }
  }

  return { height, sunAltitudeDeg, sunAzimuthDeg }
}

/** Le point voit-il le Soleil ? */
export function isSunlit(map: SunShadowMap, eastM: number, northM: number, altitudeM: number): boolean {
  return altitudeM > sample(map.height, eastM, northM)
}
