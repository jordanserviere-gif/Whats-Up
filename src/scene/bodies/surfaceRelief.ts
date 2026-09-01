/**
 * Le relief simule d'un corps, et la borne qui l'empeche d'inventer de la
 * lumiere.
 *
 * ## ⚠️ Ce que le relief est vraiment
 *
 * La carte d'albedo sert de carte de hauteur : un cratere accroche la lumiere
 * rasante **parce que son albedo varie**, non parce que le sol y monte. C'est
 * une approximation assumee, et elle suffit a rendre ce que l'oeil attend pres
 * du terminateur.
 *
 * ## Ce qu'elle faisait de trop
 *
 * Sans borne, la perturbation atteignait **quarante-deux degres** d'inclinaison.
 * Une normale ainsi couchee va chercher le Soleil bien au-dela de ce qu'une
 * pente peut faire, et la face nuit s'allumait.
 *
 * Le defaut croissait avec le zoom, et c'est ce qui l'a fait remarquer : la
 * difference finie entre texels voisins est lissee par le filtrage de texture
 * quand le disque est petit, et pleine quand il est grand.
 *
 * Mesure sur un croissant de jour, face nuit en niveaux au-dessus du ciel :
 *
 * | champ | avant | apres |
 * | --- | --- | --- |
 * | 2° a 0,3° | 0 | 0 |
 * | 0,15° | **+48** | 0 |
 * | 0,08° | +36 | 0 |
 *
 * ## La borne
 *
 * Elle ne pretend pas decrire la Lune — elle empeche l'approximation de produire
 * de la lumiere la ou il ne peut pas y en avoir. Sa valeur est la pente qu'une
 * surface lunaire presente a l'echelle d'un texel de la carte : 10 921 km de
 * circonference pour 2048 texels, soit **5,3 km de base**. A cette echelle les
 * pentes lunaires restent de quelques degres, une quinzaine dans les hautes
 * terres les plus rudes.
 */

/** Pente maximale que le relief simule peut donner a une normale, degres. */
export const RELIEF_MAX_TILT_DEG = 15

/**
 * Le plus grand cosinus d'incidence qu'une bosse puisse atteindre.
 *
 * Une normale perturbee reste a moins de `tilt` de la normale vraie. Le maximum
 * de `n'·s` sur ce cone vaut donc, pour `λ = n·s` :
 *
 *     λ·cos(tilt) + √(1 − λ²)·sin(tilt)
 *
 * C'est cette expression qui garantit la propriete recherchee : sous
 * `λ = −sin(tilt)`, elle est negative, et **aucune** pente ne peut capter le
 * Soleil.
 */
export function maxLambertUnderTilt(baseLambert: number, tiltDeg = RELIEF_MAX_TILT_DEG): number {
  const lambda = Math.max(-1, Math.min(1, baseLambert))
  const tilt = (tiltDeg * Math.PI) / 180
  return lambda * Math.cos(tilt) + Math.sqrt(Math.max(0, 1 - lambda * lambda)) * Math.sin(tilt)
}
