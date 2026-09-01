/**
 * Marge sous l'horizon — ou le moteur cesse de calculer l'atmosphere.
 *
 * ## Le probleme qu'elle resout
 *
 * Plusieurs modules du moteur avaient leur domaine borne **exactement** a
 * l'horizon geometrique. Chacun y faisait un saut :
 *
 * - `columnsToSpace` rend une colonne **infinie** des que le rayon droit plonge
 *   sous le sol, donc une transmittance nulle : le disque solaire s'eteignait
 *   d'un coup a la hauteur zero ;
 * - `apparentFromTable` prolongeait la refraction a **pente un** sous l'horizon,
 *   donc une compression verticale qui repassait brutalement de 0,4 a 1 : le
 *   disque reprenait sa forme ronde au moment de se coucher ;
 * - le nuanceur du ciel mettait la diffusion a zero pour `dir.y < 0`.
 *
 * Aucun de ces trois seuils n'est un fait physique. Ce sont trois bornes de
 * domaine numerique qui se trouvaient toutes au meme endroit, et qui se
 * manifestaient ensemble.
 *
 * ## Pourquoi la coupure ne peut pas etre a zero
 *
 * L'horizon **visible** n'est pas a la hauteur zero, et il n'y est pour aucun
 * observateur reel :
 *
 * | terme | valeur |
 * | --- | --- |
 * | refraction a l'horizon | 0,57° — un astre de hauteur vraie −0,57° est encore vu |
 * | demi-diametre solaire | 0,27° — le limbe superieur survit au centre |
 * | abaissement d'horizon a 3 000 m | 1,76° — l'horizon descend avec l'altitude |
 *
 * Leur somme vaut 2,6°. En deca, un modele borne a zero coupe **a l'interieur**
 * de ce qu'un observateur voit encore.
 *
 * ## Ce que cette constante est, et ce qu'elle n'est pas
 *
 * ⚠️ **Ce n'est pas une grandeur physique.** C'est la profondeur sous l'horizon
 * jusqu'a laquelle le moteur continue de faire tourner ses modeles, arrondie
 * au-dessus de la somme ci-dessus. Sous cette profondeur, tout est occulte par
 * le sol de toute facon — la marge n'est jamais regardee directement, elle
 * existe pour que rien ne saute **pendant** la traversee visible.
 *
 * La rendre plus grande ne changerait rien a l'image ; la rendre plus petite
 * ferait reapparaitre les sauts. C'est le signe d'une borne de domaine, pas
 * d'un parametre a regler.
 */
export const HORIZON_MARGIN_DEG = 3

/**
 * Attenuation d'un modele atmospherique a l'approche de la marge.
 *
 * Rend 1 au-dessus de l'horizon, puis descend a 0 sur la marge par un
 * `smoothstep`. Elle ne represente aucun phenomene : c'est le garde-fou qui
 * empeche un modele de rester allume indefiniment sous le sol.
 *
 * `depthDeg` est la profondeur sous l'horizon, positive vers le bas.
 */
export function horizonMarginFade(depthDeg: number): number {
  const t = Math.max(0, Math.min(1, depthDeg / HORIZON_MARGIN_DEG))
  return 1 - t * t * (3 - 2 * t)
}
