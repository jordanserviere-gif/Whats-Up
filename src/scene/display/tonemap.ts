/**
 * Transform d'affichage — l'unique endroit ou une radiance devient un pixel.
 *
 * ## Pourquoi ce module existe
 *
 * Le rendu appliquait sa courbe de tone mapping **a l'interieur de chaque
 * materiau**, et l'ecretait a [0,1] au passage. Aucune grandeur physique ne
 * survivait donc au-dela du fragment shader : il n'existait nulle part ou une
 * radiance spectrale puisse vivre entre le solveur et l'ecran.
 *
 * La chaine est desormais :
 *
 * ```
 * materiaux → radiance lineaire (non bornee) → tampon HDR → [bloom] → transform d'affichage → sRGB
 * ```
 *
 * Une seule courbe, appliquee une seule fois, tout a la fin.
 *
 * ## La courbe
 *
 * Approximation filmique ACES (Narkowicz 2015), suivie d'une re-saturation
 * autour de la luminance. Ce sont **exactement** les operations qui vivaient
 * dans `scene/atmosphere.ts` : la phase 0.5 les deplace, elle ne les change
 * pas. C'est ce qui permet de verifier le refactor par comparaison de pixels
 * plutot que par jugement.
 *
 * La re-saturation compense le fait que la courbe ACES desature fortement les
 * hautes lumieres. Elle preserve la luminance : `luma(sortie) = luma(entree)`,
 * propriete dont l'inverse ci-dessous tire parti.
 *
 * ## L'inverse, et a quoi il sert
 *
 * Tous les materiaux ne sont pas encore physiques. Un trait de grille, une
 * etoile, le sol : leurs couleurs sont des valeurs d'affichage heritees, pas
 * des radiances. Les laisser telles quelles dans un tampon lineaire les ferait
 * traverser la courbe une seconde fois, et les assombrirait.
 *
 * `radianceFromDisplay()` convertit une couleur d'affichage en la radiance qui
 * s'affichera **identiquement**. Ce n'est pas un reglage artistique : c'est une
 * cale calculee, exacte par construction, qui rend le refactor neutre pour les
 * couches pas encore portees.
 *
 * **Chaque phase supprime sa propre cale** en rendant le materiau concerne
 * physique : le Soleil en phase 4, le ciel en phase 5, le sol en phase 9, les
 * etoiles avec leur spectre de corps noir. Le jour ou plus aucun appelant
 * n'utilise `radianceFromDisplay`, la transition est terminee.
 */
import { Color } from 'three'

/**
 * Re-saturation post-courbe. Meme valeur que celle qui vivait dans
 * `scene/atmosphere.ts` sous le nom `ATMOSPHERE_SATURATION`.
 */
export const DISPLAY_SATURATION = 1.4

/** Coefficients de luminance sRGB — voir `atmosphere/spectral/SpectralSensor.ts`. */
const LUMA = [0.2126, 0.7152, 0.0722] as const

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** Courbe ACES (Narkowicz 2015) sur un canal. */
function acesChannel(x: number): number {
  return clamp01((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14))
}

/**
 * Inverse de la courbe ACES sur un canal.
 *
 * On resout `(2,51 − 2,43y)x² + (0,03 − 0,59y)x − 0,14y = 0` pour la racine
 * positive. La courbe sature vers 2,51/2,43 ≈ 1,033 : une entree de 1 exact
 * correspond a une radiance finie (7,24), et au-dela l'inverse n'existe plus —
 * d'ou le bornage de l'argument.
 */
function inverseAcesChannel(y: number): number {
  const v = clamp01(y)
  const a = 2.51 - 2.43 * v
  const b = 0.03 - 0.59 * v
  const c = -0.14 * v
  const discriminant = b * b - 4 * a * c
  if (!(discriminant >= 0) || a === 0) return 0
  return Math.max(0, (-b + Math.sqrt(discriminant)) / (2 * a))
}

/** Radiance qui s'affiche exactement en blanc — utile pour seuiller le bloom. */
export const RADIANCE_AT_DISPLAY_WHITE = inverseAcesChannel(1)

/** Transform d'affichage complet : radiance lineaire → couleur d'affichage [0,1]. */
export function displayTransform(rgb: readonly [number, number, number]): [number, number, number] {
  const mapped: [number, number, number] = [acesChannel(rgb[0]), acesChannel(rgb[1]), acesChannel(rgb[2])]
  const luma = LUMA[0] * mapped[0] + LUMA[1] * mapped[1] + LUMA[2] * mapped[2]
  return [
    clamp01(luma + (mapped[0] - luma) * DISPLAY_SATURATION),
    clamp01(luma + (mapped[1] - luma) * DISPLAY_SATURATION),
    clamp01(luma + (mapped[2] - luma) * DISPLAY_SATURATION),
  ]
}

/**
 * Inverse du transform d'affichage : couleur d'affichage → radiance lineaire.
 *
 * La re-saturation preservant la luminance, son inverse est immediat :
 * `m = (c − (1 − S)·luma(c)) / S`.
 */
export function radianceFromDisplay(rgb: readonly [number, number, number]): [number, number, number] {
  const luma = LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2]
  const unsaturate = (v: number) => (v - (1 - DISPLAY_SATURATION) * luma) / DISPLAY_SATURATION
  return [
    inverseAcesChannel(unsaturate(rgb[0])),
    inverseAcesChannel(unsaturate(rgb[1])),
    inverseAcesChannel(unsaturate(rgb[2])),
  ]
}

/**
 * Convertit une couleur d'affichage en radiance, **sur place**.
 *
 * Les materiaux recoivent leurs couleurs sous forme de tokens CSS, que
 * three.js convertit deja en lumiere lineaire. Cette fonction les remonte
 * ensuite en radiance pre-courbe, de sorte que le transform d'affichage les
 * restitue a l'identique.
 */
export function toRadiance(color: Color): Color {
  const [r, g, b] = radianceFromDisplay([color.r, color.g, color.b])
  return color.setRGB(r, g, b)
}

/**
 * Fonctions GLSL du transform d'affichage.
 *
 * `radianceFromDisplay()` est fournie aux materiaux qui calculent leur couleur
 * dans le nuanceur et n'ont donc pas d'uniforme a convertir cote processeur.
 * Elle disparaitra avec les cales qu'elle sert.
 */
export const DISPLAY_TONEMAP_GLSL = /* glsl */ `
  vec3 acesTonemap(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  vec3 displayTransform(vec3 radiance) {
    vec3 mapped = acesTonemap(radiance);
    float luma = dot(mapped, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]}));
    return clamp(mix(vec3(luma), mapped, ${DISPLAY_SATURATION.toFixed(2)}), 0.0, 1.0);
  }

  /** Inverse de la courbe ACES, racine positive. */
  vec3 inverseAces(vec3 y) {
    vec3 v = clamp(y, 0.0, 1.0);
    vec3 a = 2.51 - 2.43 * v;
    vec3 b = 0.03 - 0.59 * v;
    vec3 c = -0.14 * v;
    vec3 d = max(b * b - 4.0 * a * c, vec3(0.0));
    return max(vec3(0.0), (-b + sqrt(d)) / (2.0 * a));
  }

  /**
   * Cale de transition : couleur d'affichage vers la radiance qui s'affichera
   * a l'identique. A supprimer materiau par materiau, a mesure qu'ils
   * deviennent physiques.
   */
  vec3 radianceFromDisplay(vec3 c) {
    float luma = dot(c, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]}));
    vec3 unsaturated = (c - (1.0 - ${DISPLAY_SATURATION.toFixed(2)}) * luma) / ${DISPLAY_SATURATION.toFixed(2)};
    return inverseAces(unsaturated);
  }
`
