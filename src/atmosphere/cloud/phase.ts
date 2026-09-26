/**
 * Fonctions de phase de l'eau condensee — gouttes et cristaux.
 *
 * Nuages et trainees sont faits de la meme matiere, de l'eau qui a quitte la
 * phase vapeur : ils partagent donc ce module. Ce qui les distingue est la
 * **forme** des particules, et c'est elle qui fixe la fonction de phase.
 *
 * ## Les gouttes : Mie, approche par Jendersie & d'Eon
 *
 * Une goutte est une sphere : la theorie de Mie la decrit exactement, et le
 * moteur en a un solveur (`mie/mie.ts`). Mais la phase de Mie d'une goutte de
 * nuage n'a pas d'expression simple — des centaines de termes, un pic avant
 * etroit, l'arc-en-ciel, la gloire — et ne se tabule pas bien dans un nuanceur.
 *
 * Jendersie & d'Eon (SIGGRAPH 2023, « An Approximate Mie Scattering Function
 * for Fog and Cloud Rendering ») la remplacent par un melange d'une
 * Henyey-Greenstein, qui porte le pic avant, et d'une Draine, qui porte le
 * reste ; quatre parametres, eux-memes ajustes sur le seul diametre des
 * gouttes. L'approximation reproduit la moitie avant de la phase, soit 95 % de
 * la lumiere diffusee ; elle perd l'arc-en-ciel et la gloire, rarement visibles.
 *
 * Les coefficients viennent de l'article et de son supplement (NVIDIA, code
 * de reference sous licence MIT). La validation les confronte a **notre**
 * solveur de Mie : deux chemins independants vers la meme grandeur.
 *
 * ## Les cristaux : pas de Mie
 *
 * Un cristal de glace n'est pas une sphere, et Mie ne s'y applique pas. Les
 * modeles de cristaux rugueux publies donnent un facteur d'asymetrie de
 * 0,75 a 0,8 dans le visible, sans l'arc-en-ciel des gouttes. On le rend par
 * deux Henyey-Greenstein : un lobe avant et un faible lobe arriere. Les halos
 * (22°, 46°) demanderaient des cristaux reguliers et orientes ; ils sont hors
 * de ce modele, et le seraient de la plupart des trainees reelles.
 */

const FOUR_PI = 4 * Math.PI

/**
 * Henyey-Greenstein, sr⁻¹ ; integrale sur la sphere egale a 1.
 * `mu` est le cosinus de l'angle de diffusion.
 */
export function henyeyGreenstein(g: number, mu: number): number {
  const g2 = g * g
  return (1 - g2) / (FOUR_PI * Math.pow(1 + g2 - 2 * g * mu, 1.5))
}

/**
 * Phase de Draine (2003), sr⁻¹ ; integrale sur la sphere egale a 1.
 *
 * Deux parametres : `g` la forme, `alpha` le renflement en `cos²`. Elle se
 * reduit a Henyey-Greenstein pour `alpha = 0`, a Rayleigh pour `g = 0` et
 * `alpha = 1`, a Cornette-Shanks pour `alpha = 1`.
 */
export function draine(g: number, alpha: number, mu: number): number {
  const g2 = g * g
  return (
    ((1 - g2) * (1 + alpha * mu * mu)) /
    (FOUR_PI * (1 + (alpha * (1 + 2 * g2)) / 3) * Math.pow(1 + g2 - 2 * g * mu, 1.5))
  )
}

/** Cosinus moyen d'une phase de Draine, forme close. */
export function draineMeanCosine(g: number, alpha: number): number {
  const g2 = g * g
  return (g * (1 + (alpha * (3 + 2 * g2)) / 5)) / (1 + (alpha * (1 + 2 * g2)) / 3)
}

export interface DropletPhaseParameters {
  /** Anisotropie du lobe Henyey-Greenstein — le pic avant. */
  gHG: number
  /** Anisotropie du lobe de Draine — le corps de la phase. */
  gD: number
  /** Parametre `alpha` du lobe de Draine. */
  alpha: number
  /** Poids du lobe de Draine dans le melange, entre 0 et 1. */
  wD: number
}

/** Domaine de l'ajustement retenu, µm. En deca, ce sont des aerosols. */
export const DROPLET_DIAMETER_MIN_UM = 1.5
export const DROPLET_DIAMETER_MAX_UM = 50

/**
 * Parametres du melange pour un diametre de goutte, µm.
 *
 * Deux ajustements de l'article, raccordes a 5 µm : equations 4 a 7 du texte
 * principal au-dessus, equations 19 a 22 du supplement en dessous. Les
 * logarithmes sont neperiens. Hors du domaine, le diametre est borne.
 */
export function dropletPhaseParameters(diameterUm: number): DropletPhaseParameters {
  const d = Math.min(DROPLET_DIAMETER_MAX_UM, Math.max(DROPLET_DIAMETER_MIN_UM, diameterUm))
  if (d >= 5) {
    return {
      gHG: Math.exp(-0.0990567 / (d - 1.67154)),
      gD: Math.exp(-2.20679 / (d + 3.91029) - 0.428934),
      alpha: Math.exp(3.62489 - 8.29288 / (d + 5.52825)),
      wD: Math.exp(-0.599085 / (d - 0.641583) - 0.665888),
    }
  }
  const l = Math.log(d)
  const ll = Math.log(l)
  return {
    gHG: 0.0604931 * ll + 0.940256,
    gD: 0.500411 - 0.081287 / (-2 * l + Math.tan(l) + 1.27551),
    alpha: 7.30354 * l + 6.31675,
    wD: 0.026914 * (l - Math.cos(5.68947 * (ll - 0.0292149))) + 0.376475,
  }
}

/** Phase d'une population de gouttes, sr⁻¹ — equation 3 de l'article. */
export function dropletPhase(p: DropletPhaseParameters, mu: number): number {
  return (1 - p.wD) * henyeyGreenstein(p.gHG, mu) + p.wD * draine(p.gD, p.alpha, mu)
}

/** Cosinus moyen du melange : moyenne ponderee des deux lobes. */
export function dropletMeanCosine(p: DropletPhaseParameters): number {
  return (1 - p.wD) * p.gHG + p.wD * draineMeanCosine(p.gD, p.alpha)
}

/**
 * Phase des cristaux de glace rugueux : deux Henyey-Greenstein.
 *
 * Le lobe avant (g = 0,85) porte l'essentiel ; le lobe arriere (g = −0,2),
 * leger, rend la retrodiffusion des facettes. Facteur d'asymetrie resultant :
 * 0,776, dans la fourchette publiee pour les cristaux rugueux.
 */
export const ICE_PHASE = { gForward: 0.85, gBackward: -0.2, wBackward: 0.07 } as const

export function icePhase(mu: number): number {
  const { gForward, gBackward, wBackward } = ICE_PHASE
  return (1 - wBackward) * henyeyGreenstein(gForward, mu) + wBackward * henyeyGreenstein(gBackward, mu)
}

export const iceMeanCosine = (): number =>
  (1 - ICE_PHASE.wBackward) * ICE_PHASE.gForward + ICE_PHASE.wBackward * ICE_PHASE.gBackward

/**
 * Les memes fonctions pour le nuanceur. Aucune n'est dupliquee a la main
 * ailleurs : trainees et nuages incluent ce bloc.
 */
export const CLOUD_PHASE_GLSL = /* glsl */ `
  float cloudHenyeyGreenstein(float g, float mu) {
    float g2 = g * g;
    return (1.0 - g2) / (12.566370614 * pow(max(1e-6, 1.0 + g2 - 2.0 * g * mu), 1.5));
  }
  float cloudDraine(float g, float alpha, float mu) {
    float g2 = g * g;
    return ((1.0 - g2) * (1.0 + alpha * mu * mu)) /
      (12.566370614 * (1.0 + alpha * (1.0 + 2.0 * g2) / 3.0) * pow(max(1e-6, 1.0 + g2 - 2.0 * g * mu), 1.5));
  }
  float cloudIcePhase(float mu) {
    return ${(1 - ICE_PHASE.wBackward).toFixed(4)} * cloudHenyeyGreenstein(${ICE_PHASE.gForward.toFixed(4)}, mu)
      + ${ICE_PHASE.wBackward.toFixed(4)} * cloudHenyeyGreenstein(${ICE_PHASE.gBackward.toFixed(4)}, mu);
  }
  // p = (gHG, gD, alpha, wD) — voir dropletPhaseParameters.
  float cloudDropletPhase(vec4 p, float mu) {
    return (1.0 - p.w) * cloudHenyeyGreenstein(p.x, mu) + p.w * cloudDraine(p.y, p.z, mu);
  }
`
