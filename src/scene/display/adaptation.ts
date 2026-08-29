/**
 * Adaptation visuelle — l'exposition cesse d'etre une constante.
 *
 * ## Le probleme, chiffre
 *
 * Le ciel couvre **huit decades et demie** de luminance entre le zenith de midi
 * (~1,4·10³ cd/m²) et un ciel sans Lune (~4·10⁻⁵ cd/m²). Un ecran en couvre
 * deux ou trois.
 *
 * Une exposition **fixe** doit donc choisir : soit le jour est correct et la
 * nuit est noire, soit l'inverse. Le moteur avait choisi le jour, et c'est
 * pourquoi le socle nocturne etait **peint** — l'airglow reel vaut `4·10⁻¹⁰` du
 * blanc d'affichage, rigoureusement invisible.
 *
 * ## Ce que fait l'oeil, et ce qu'il ne fait pas
 *
 * Il **adapte** : sa sensibilite suit la luminance ambiante sur une dizaine de
 * decades. Mais il n'adapte pas **completement** — sans quoi une nuit paraitrait
 * aussi claire qu'un jour, ce qui n'est evidemment pas le cas.
 *
 * C'est ce reste d'inadaptation qui porte toute la sensation de jour et de nuit,
 * et c'est lui qu'il faut modeliser.
 *
 * ## L'exposant n'est pas choisi, il se deduit
 *
 *     L_blanc = A · L_adaptation^p
 *
 * Si `p = 1`, l'adaptation est totale : toutes les scenes rendent pareil, il n'y
 * a plus ni jour ni nuit. Si `p = 0`, on retrouve l'exposition fixe. Entre les
 * deux, la dynamique restituee vaut `decades_scene × (1 − p)`.
 *
 * On veut que cette dynamique restituee soit celle que l'ecran peut montrer.
 * D'ou, directement :
 *
 *     p = 1 − decades_ecran / decades_scene
 *
 * **Aucun des deux nombres n'est esthetique** : le premier est une propriete de
 * l'ecran, le second une mesure du moteur. L'exposant en sort.
 *
 * ## Ce qui reste un choix, et il est unique
 *
 * `DISPLAY_DECADES` — combien de la dynamique de l'ecran consacrer a l'ecart du
 * jour a la nuit, plutot qu'au contraste **a l'interieur** d'une meme image.
 * C'est une decision de presentation, la seule, et elle est enoncee en termes de
 * ce qu'un ecran peut faire plutot qu'en candelas arbitraires.
 *
 * ## ⚠️ Ce que ce module ne fait pas
 *
 * **L'adaptation est instantanee.** L'oeil met des secondes a des minutes a
 * s'adapter, et l'eblouissement en sortant d'un tunnel en est la trace. Ici, le
 * changement suit la scene sans retard — ce qui est le bon choix pour une
 * application ou l'on fait defiler le temps, mais qui n'est pas ce que vit un
 * observateur.
 *
 * **La vision scotopique n'est pas modelisee.** Sous 0,01 cd/m² les batonnets
 * prennent le relais : la couleur disparait, la sensibilite se decale vers le
 * bleu — 507 nm contre 555 — et l'acuite s'effondre. Le rendre demanderait la
 * courbe `V'(λ)`, que le moteur n'embarque pas. C'est pourquoi le ciel nocturne
 * garde ici ses couleurs photopiques, ce qu'aucun observateur ne verrait.
 *
 * Reference de methode : Ferwerda, J. A. et al. (1996), *A Model of Visual
 * Adaptation for Realistic Image Synthesis*, SIGGRAPH.
 */
import { RADIANCE_AT_DISPLAY_WHITE } from './tonemap'
import { DISPLAY_WHITE_LUMINANCE } from './exposure'

/** Efficacite lumineuse maximale, lm/W — exacte par definition. */
const LUMINOUS_EFFICACY = 683

/**
 * Luminance moyenne du ciel a laquelle l'exposition est ancree, cd/m².
 *
 * Mesuree par le solveur : c'est la luminance moyenne **en angle solide** du
 * ciel avec le Soleil a soixante degres, un midi ordinaire.
 *
 * En angle solide, et non ponderee par le cosinus : l'oeil s'adapte a ce qu'il
 * **voit**, non a ce qui eclaire le sol. Au crepuscule les deux different d'un
 * facteur deux, et employer l'eclairement faisait saturer la bande claire de
 * l'horizon. A cette valeur, l'exposition
 * adaptative rend **exactement** ce que rendait l'exposition fixe — meme
 * demarche qu'en phase 0.5, on ne melange pas un changement de modele a un
 * changement d'apparence.
 */
export const REFERENCE_SKY_LUMINANCE = 3863

/**
 * Plancher d'adaptation, cd/m².
 *
 * La luminance de l'airglow au zenith. En dessous, il n'y a plus rien a voir :
 * l'oeil ne s'adapte pas a une obscurite plus profonde que le ciel lui-meme.
 */
export const ADAPTATION_FLOOR = 3.71e-5

/**
 * Dynamique de la scene, en decades.
 *
 * Du ciel de midi au ciel sans Lune. Ce ne sont pas des estimations : les deux
 * bornes sont mesurees par le moteur, l'une par le solveur de diffusion, l'autre
 * par le module d'airglow.
 */
export const SCENE_DECADES = Math.log10(REFERENCE_SKY_LUMINANCE / ADAPTATION_FLOOR)

/**
 * Dynamique consacree a l'ecart jour/nuit, en decades.
 *
 * ⚠️ **Le seul choix de presentation de ce module.**
 *
 * Un ecran sRGB dans une piece eclairee montre utilement deux a trois decades.
 * En consacrer **deux** a l'ecart du jour a la nuit laisse le reste au contraste
 * a l'interieur de chaque image — le disque solaire contre le ciel, une etoile
 * contre le fond.
 *
 * Consequence directe : une nuit rend cent fois plus sombre qu'un midi. C'est
 * peu au regard des huit decades reelles, et c'est precisement ce qu'un ecran
 * peut faire.
 */
export const DISPLAY_DECADES = 2

/**
 * Exposant d'adaptation, sans dimension.
 *
 * **Il n'est pas choisi** : `1 − decades_ecran/decades_scene`, le rapport de ce
 * que l'ecran peut montrer a ce que la scene contient. Il vaut environ 0,75 —
 * une adaptation a 75 %, les 25 % restants portant toute la sensation de jour et
 * de nuit.
 */
export const ADAPTATION_EXPONENT = 1 - DISPLAY_DECADES / SCENE_DECADES

/**
 * Luminance qui s'affiche en blanc, cd/m², pour un ciel donne.
 *
 *     L_blanc = L_ref · (L_ciel/L_ref)^p
 */
export function adaptiveWhiteLuminance(meanSkyLuminanceCdPerM2: number): number {
  const ratio = Math.max(ADAPTATION_FLOOR, meanSkyLuminanceCdPerM2) / REFERENCE_SKY_LUMINANCE
  return DISPLAY_WHITE_LUMINANCE * Math.pow(Math.max(1e-12, ratio), ADAPTATION_EXPONENT)
}

/**
 * Luminance sous laquelle la vision est entierement assuree par les batonnets.
 *
 * Les valeurs 0,01 et 3 cd/m² bornent le domaine **mesopique**, ou cones et
 * batonnets fonctionnent ensemble. Ce sont des bornes d'usage en photometrie, et
 * elles sont solides — bien plus que les details de la transition entre elles.
 */
export const SCOTOPIC_CEILING = 0.01
export const PHOTOPIC_FLOOR = 3

/**
 * Part de la vision assuree par les batonnets, de 0 a 1.
 *
 * **Les batonnets sont monochromatiques.** Ce n'est pas une approximation : ils
 * ne portent qu'un seul pigment, et aucune comparaison entre types de recepteurs
 * n'est possible. Sous 0,01 cd/m², l'oeil ne distingue donc **aucune couleur** —
 * un fait que chacun verifie en regardant un paysage au clair de lune.
 *
 * C'est ce qui interdit d'afficher un ciel nocturne colore. L'airglow est
 * physiquement verdatre — sa raie a 557,7 nm domine — mais personne ne voit ce
 * vert : a ces luminances, il n'y a plus de vision des couleurs du tout.
 *
 * ⚠️ **La desaturation est le seul effet scotopique modelise.** Le decalage de
 * Purkinje — la sensibilite qui glisse vers le bleu, 507 nm au lieu de 555 —
 * demanderait la courbe `V'(λ)`, que le moteur n'embarque pas. Le ciel nocturne
 * est donc rendu **gris** la ou un observateur le percoit legerement bleute.
 *
 * La transition est interpolee en logarithme de la luminance, l'oeil travaillant
 * en decades ; sa forme exacte n'est pas mesuree, ses bornes le sont.
 */
export function scotopicWeight(luminanceCdPerM2: number): number {
  const l = Math.max(1e-12, luminanceCdPerM2)
  if (l <= SCOTOPIC_CEILING) return 1
  if (l >= PHOTOPIC_FLOOR) return 0
  const t = Math.log10(l / SCOTOPIC_CEILING) / Math.log10(PHOTOPIC_FLOOR / SCOTOPIC_CEILING)
  // Lissage cubique : une rampe lineaire laisserait un coude visible au passage.
  return 1 - t * t * (3 - 2 * t)
}

/**
 * Facteur a appliquer a une radiance sRGB lineaire pour l'afficher.
 *
 * Meme relation qu'a exposition fixe — `683·R/L_blanc` — mais avec un blanc qui
 * suit le ciel. Tout ce qui traverse cette exposition suit donc l'adaptation :
 * le ciel, les astres, le voile atmospherique.
 */
export const adaptiveSkyExposure = (meanSkyLuminanceCdPerM2: number): number =>
  (RADIANCE_AT_DISPLAY_WHITE * LUMINOUS_EFFICACY) / adaptiveWhiteLuminance(meanSkyLuminanceCdPerM2)
