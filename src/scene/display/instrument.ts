/**
 * L'instrument que le champ implique.
 *
 * ## Pourquoi ce module existe
 *
 * Le moteur rendait le ciel tel qu'un **œil nu** le voit, quel que soit le
 * champ. C'est cohérent, mais ça condamne le ciel profond au gris : le cœur de
 * M31 vaut 0,013 cd/m², deux cent trente fois sous le seuil où les cônes
 * répondent. Zoomer ne change rien à cela — la brillance de surface d'un objet
 * étendu ne peut pas augmenter par grossissement, c'est ce qui fait qu'une
 * galaxie reste grise même dans un gros télescope.
 *
 * Pour voir la couleur d'une nébuleuse, il faut assumer que le rendu n'est plus
 * un œil mais un **capteur**. Ce module dit lequel.
 *
 * ## ⚠️ L'instrument n'est pas choisi, il est déduit
 *
 * Un seuil de champ au-delà duquel « on passe en mode télescope » serait un
 * réglage arbitraire, et le projet s'interdit ce genre de constante. On pose
 * donc la seule question qui ait une réponse : **quelle est la plus petite
 * ouverture capable de résoudre ce que l'écran affiche ?**
 *
 * Le critère de Rayleigh la donne, pour un pixel couvrant un angle θ :
 *
 *     D = 1,22 · λ / θ
 *
 * λ est le pic photopique, 555 nm, que le moteur normalise déjà dans sa chaîne
 * spectrale ; ce n'est pas un nombre introduit ici.
 *
 * ## Le gain, et le seuil qui en tombe
 *
 * Une ouverture collecte en `D²`. Rapportée à la pupille adaptée à l'obscurité,
 * elle décale la magnitude limite de la quantité classique :
 *
 *     Δm = 5·log10(D / D_œil)
 *
 * L'instrument ne peut pas être **pire** que l'œil : le gain est donc borné à
 * zéro par le bas, et la bascule se produit exactement là où l'ouverture requise
 * dépasse la pupille. Pour une fenêtre de 900 pixels de haut, ça tombe vers
 * **cinq degrés de champ** — un seuil qui n'a été ni cherché ni réglé, il sort
 * de la pupille et de la diffraction.
 *
 * | champ (900 px) | pixel | ouverture | gain |
 * | --- | --- | --- | --- |
 * | 60° | 4,0′ | 0,6 mm | 0 (l'œil) |
 * | 5° | 20″ | 7 mm | 0 (l'œil) |
 * | 2° | 8″ | 17 mm | 1,9 mag |
 * | 0,5° | 2″ | 69 mm | 5,0 mag |
 * | 0,05° | 0,2″ | 690 mm | 10,0 mag |
 *
 * ## ⚠️ Ce que ce modèle assume
 *
 * **Le capteur voit les couleurs que l'œil verrait au même flux.** On réutilise
 * la loi mésopique en lui donnant le flux collecté par l'instrument plutôt que
 * par la pupille. C'est une commodité : la réponse chromatique d'un capteur
 * n'est pas celle de la rétine, et rien ici ne la mesure.
 *
 * **Aucun temps de pose.** Le gain ne porte que l'ouverture. Une vraie pose
 * longue ajouterait une intégration temporelle, qui n'est pas modélisée.
 *
 * **Diffraction seule.** Ni turbulence, ni qualité optique, ni bruit de lecture.
 * L'ouverture déduite est donc la plus petite possible, jamais la plus réaliste.
 */

/**
 * Diamètre de la pupille adaptée à l'obscurité, mètres.
 *
 * Valeur d'usage en observation visuelle. Elle décroît avec l'âge — sept
 * millimètres est la pupille d'un observateur jeune — mais c'est la référence
 * sur laquelle les magnitudes limites instrumentales sont tabulées.
 */
export const DARK_ADAPTED_PUPIL_M = 7e-3

/**
 * Longueur d'onde de référence, mètres.
 *
 * Le pic de la fonction photopique, celui-là même que la chaîne spectrale du
 * moteur normalise à un. Voir `atmosphere/spectral`.
 */
export const PHOTOPIC_PEAK_M = 555e-9

/** Facteur de Rayleigh — premier zéro de la tache d'Airy. */
const RAYLEIGH = 1.22

/** Plus petite ouverture qui résout un pixel d'angle donné, mètres. */
export function resolvedApertureM(pixelAngleRad: number): number {
  return (RAYLEIGH * PHOTOPIC_PEAK_M) / Math.max(1e-12, pixelAngleRad)
}

/**
 * Décalage de magnitude limite apporté par l'instrument, magnitudes.
 *
 * Nul tant que l'œil suffit à résoudre le pixel affiché : le rendu est alors
 * exactement celui d'avant ce module.
 */
export function instrumentGainMag(pixelAngleRad: number): number {
  const ratio = resolvedApertureM(pixelAngleRad) / DARK_ADAPTED_PUPIL_M
  return Math.max(0, 5 * Math.log10(Math.max(1e-12, ratio)))
}

/**
 * Champ, en degrés, en dessous duquel l'instrument prend le relais de l'œil.
 *
 * Déduit, pas posé : c'est le champ pour lequel l'ouverture requise vaut
 * exactement la pupille.
 */
export function instrumentOnsetFovDeg(heightPx: number): number {
  const pixelAngle = (RAYLEIGH * PHOTOPIC_PEAK_M) / DARK_ADAPTED_PUPIL_M
  return ((pixelAngle * heightPx) / Math.PI) * 180
}
