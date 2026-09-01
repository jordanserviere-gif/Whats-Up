/**
 * Exposition d'affichage — le pont entre une luminance et un pixel.
 *
 * ## Le probleme
 *
 * Le moteur produit desormais des **luminances reelles** : le ciel de midi
 * avoisine mille cd/m², le disque solaire depasse le milliard. Un ecran en rend
 * quelques centaines. Il faut donc decider quelle luminance s'affiche en blanc,
 * et cette decision n'est pas de la physique — c'est de la photographie.
 *
 * ## Ce que ce module n'est pas
 *
 * Ce n'est **pas** un modele d'adaptation. L'oeil qui regarde un coucher de
 * Soleil est adapte a une scene sombre et voit un disque orange ; le meme oeil
 * a midi est adapte au plein jour. Reproduire cela demande une boucle
 * d'adaptation temporelle sur la luminance de la scene, qui viendra avec le
 * capteur. Ici, l'exposition est **fixe**.
 *
 * ## Deux ancrages possibles, et celui qui est retenu
 *
 * **L'ancrage photographique** poserait qu'une surface lambertienne blanche
 * (albedo 0,9) sous un plein soleil de 120 klx s'affiche en blanc, soit
 * `0,9 × 120000 / π ≈ 34 400 cd/m²`. C'est la convention usuelle, et c'est
 * probablement celle que le moteur adoptera.
 *
 * **L'ancrage de continuite** est celui retenu ici : l'exposition est calculee
 * pour que le zenith de midi s'affiche **exactement comme avant** le passage au
 * ciel physique. Elle equivaut a un blanc a 86 300 cd/m², c'est-a-dire un rendu
 * 2,5 fois plus sombre que la convention photographique.
 *
 * Le choix est deliberé : cette etape change le **modele** du ciel, et melanger
 * a ce changement une modification de l'exposition rendrait les deux
 * impossibles a juger separement. On mesure d'abord la physique a apparence
 * constante ; on discutera de l'apparence ensuite.
 *
 * C'est la meme demarche qu'en phase 0.5, ou le sur-eclat du Soleil avait ete
 * **traduit** dans le nouvel espace plutot que redevine.
 */
import { RADIANCE_AT_DISPLAY_WHITE } from './tonemap'

/** Efficacite lumineuse maximale, lm/W — exacte par definition (voir `atmosphere/spectral`). */
const LUMINOUS_EFFICACY = 683

/**
 * Luminance qui s'affiche en blanc, cd/m².
 *
 * **Constante de transition, calculee et non choisie.** Sa valeur est celle qui
 * reproduit la sonde de midi au zenith — `67,106,137` — a partir de la
 * luminance que le solveur physique calcule au meme instant, 1 237 cd/m².
 *
 * Elle sera remplacee par un modele d'adaptation, ou a defaut par l'ancrage
 * photographique de 34 400 cd/m². Le jour ou elle disparait, la transition vers
 * un rendu radiometrique complet est terminee.
 */
export const DISPLAY_WHITE_LUMINANCE = 86_302

/**
 * Ancrage photographique, cd/m² — conserve pour reference et comparaison.
 *
 * Luminance d'une surface lambertienne d'albedo 0,9 sous un eclairement de
 * 120 klx, soit un plein soleil au zenith.
 */
export const PHOTOGRAPHIC_WHITE_LUMINANCE = (0.9 * 120_000) / Math.PI

/**
 * Facteur a appliquer a une couleur sRGB lineaire **radiometrique** pour la
 * porter dans l'espace du transform d'affichage.
 *
 * La deuxieme ligne de la matrice sRGB etant la ligne Y de CIE XYZ, la luma
 * d'un sRGB lineaire **est** le Y du tristimulus, et la luminance vaut
 * `683 × Y`. Le facteur est donc celui qui envoie `Y = L_blanc / 683` sur la
 * radiance qui s'affiche en blanc.
 */
export const skyDisplayExposure = (whiteLuminanceCdPerM2 = DISPLAY_WHITE_LUMINANCE): number =>
  (RADIANCE_AT_DISPLAY_WHITE * LUMINOUS_EFFICACY) / whiteLuminanceCdPerM2

/** Exposition retenue par defaut. */
export const SKY_DISPLAY_EXPOSURE = skyDisplayExposure()
