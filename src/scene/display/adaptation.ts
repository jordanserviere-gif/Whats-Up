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
 *
 * ## ⚠️ Deux ne suffisaient pas, et la mesure le dit
 *
 * La valeur etait de **deux**, avec ce raisonnement : en consacrer deux a
 * l'ecart du jour a la nuit laisse le reste au contraste a l'interieur de chaque
 * image. Le raisonnement tenait ; sa consequence, non.
 *
 * Valeur affichee du ciel a un degre au-dessus de l'horizon, dans la direction
 * du Soleil, pour le **meme ciel physique** :
 *
 * | Soleil | 2 decades | 3 decades |
 * | --- | --- | --- |
 * | −6° | 161 | 93 |
 * | −9° | 156 | 66 |
 * | −12° | **145** | 43 |
 * | −15° | **106** | 17 |
 * | −18° | 3 | 0 |
 *
 * **A deux decades, la lueur crepusculaire ne s'eteint pas.** Le ciel perd un
 * facteur mille entre −6° et −15° de hauteur solaire ; l'ecran passe de 161 a
 * 106. L'ecart jour-nuit n'etait donc pas represente du tout dans la plage ou il
 * se joue, et une heure et demie apres le coucher il restait un halo blanc franc
 * la ou l'oeil ne voit qu'une lueur.
 *
 * A trois, la decroissance existe. Et le jour ne bouge pas : 250 contre 249 a
 * quinze degres de hauteur solaire, l'ancrage etant a midi.
 *
 * Le prix est reel et assume : la nuit profonde tombe a zero au lieu de rendre
 * l'airglow a quatre niveaux sur 255. Le fond de ciel naturel n'est plus
 * discernable — c'est le contraste **a l'interieur** de l'image nocturne qu'on
 * a paye, exactement comme le raisonnement d'origine l'annoncait.
 */
export const DISPLAY_DECADES = 3

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
/**
 * Eclairement produit a l'oeil par une source ponctuelle de magnitude zero, lux.
 *
 * Valeur standard de la photometrie stellaire dans la bande V. C'est ce qui
 * convertit une magnitude en une grandeur physique.
 */
export const ZERO_MAGNITUDE_LUX = 2.54e-6

/**
 * Une seconde d'arc carree, en steradians.
 *
 * Purement geometrique : `(π/180/3600)²`. Elle sert a passer d'une brillance de
 * surface, exprimee en magnitudes par seconde d'arc carree, a une luminance.
 */
export const ARCSEC2_STERADIAN = (Math.PI / 180 / 3600) ** 2

/**
 * Luminance correspondant a une brillance de surface, cd/m².
 *
 * ## Pourquoi cette conversion existe
 *
 * Les astronomes comptent en **magnitudes par seconde d'arc carree**, la vision
 * en **candelas par metre carre**. Le passage n'est pas une convention : une
 * brillance de surface `mu` vaut, par seconde d'arc, l'eclairement d'une source
 * de magnitude `mu` ; le diviser par l'angle solide d'une seconde d'arc carree
 * rend une luminance.
 *
 *     L = E_mag0 · 10^(−0,4·mu) / arcsec²
 *
 * ⚠️ Aucune constante nouvelle : `ZERO_MAGNITUDE_LUX` sert deja aux etoiles, et
 * le reste est de la geometrie. Le recoupement est net — 22 mag/arcsec² rend
 * **1,71·10⁻⁴ cd/m²** contre 1,7·10⁻⁴ publie pour un ciel tres noir.
 *
 * Elle dit aussi quelque chose de fort sur le ciel profond : a 20 mag/arcsec²,
 * une galaxie brille a 10⁻³ cd/m², soit **dix fois sous le plafond scotopique**.
 * Elle est donc grise a l'oeil, et seul le coeur de M42 — 13 mag/arcsec², 0,68
 * cd/m² — entre dans le domaine mesopique. C'est precisement le seul objet dont
 * les observateurs rapportent une teinte.
 */
export const surfaceBrightnessLuminance = (magPerArcsec2: number): number =>
  (ZERO_MAGNITUDE_LUX * 10 ** (-0.4 * magPerArcsec2)) / ARCSEC2_STERADIAN

/**
 * Magnitude apparente au-dela de laquelle la couleur d'une source ponctuelle
 * cesse d'etre percue.
 *
 * ⚠️ **C'est l'ancrage observationnel de tout ce qui suit, et il est
 * qualitatif.** Les observateurs s'accordent sur le fait : Sirius, Betelgeuse,
 * Antares, Vega montrent une teinte, et tout ce qui passe sous la premiere ou
 * la deuxieme magnitude parait blanc. Le seuil exact varie d'un oeil a l'autre.
 */
const POINT_COLOUR_THRESHOLD_MAG = 1

/**
 * Angle solide sur lequel l'oeil etale une source ponctuelle, steradians.
 *
 * ## Pourquoi cette grandeur est necessaire
 *
 * Une etoile n'a pas de luminance : c'est un point, et son image n'a de taille
 * que celle que l'optique lui donne. Or la bascule cones/batonnets se joue sur
 * l'eclairement **retinien**, donc sur une luminance. Il faut donc savoir sur
 * quelle surface de retine l'etoile se depose.
 *
 * ## ⚠️ Elle n'est pas choisie, elle est deduite — parce qu'on ne la connait pas
 *
 * La fonction d'etalement de l'oeil **nu et adapte a l'obscurite** est une
 * grandeur mal definie : la litterature va d'une minute d'arc, pour une pupille
 * de jour, a une dizaine pour une pupille de sept millimetres ou les
 * aberrations dominent. Choisir dans cet intervalle serait choisir le resultat.
 *
 * On la **deduit** donc de l'ancrage observationnel ci-dessus : la tache est
 * celle qui place une source de magnitude 1 exactement au plancher photopique,
 * la ou les cones cessent d'etre seuls.
 *
 *     Ω = E(mag 1) / PHOTOPIC_FLOOR
 *
 * Le resultat vaut **2,3 minutes d'arc de diametre**, ce qui tombe dans
 * l'intervalle publie sans avoir ete pris dedans. C'est une verification, pas
 * une justification.
 *
 * ## Ce que ca donne
 *
 * | magnitude | luminance retinienne | part des batonnets |
 * | --- | --- | --- |
 * | −1,4 (Sirius) | 27,4 cd/m² | 0 % |
 * | 0 | 7,5 cd/m² | 0 % |
 * | 2 | 1,19 cd/m² | 7 % |
 * | 3 | 0,47 cd/m² | 23 % |
 * | 4 | 0,19 cd/m² | 48 % |
 * | 6 | 0,03 cd/m² | 90 % |
 *
 * Les brillantes gardent leur teinte, le champ profond devient blanc. Le
 * domaine mesopique est celui du ciel, non un second reglage.
 */
export const EYE_POINT_SPREAD_SR =
  (ZERO_MAGNITUDE_LUX * Math.pow(10, -0.4 * POINT_COLOUR_THRESHOLD_MAG)) / PHOTOPIC_FLOOR

/**
 * Luminance retinienne d'une source ponctuelle de magnitude donnee, cd/m².
 *
 * C'est la grandeur a passer a `scotopicWeight` pour une etoile : elle dit si
 * l'oeil en voit la couleur ou seulement l'eclat.
 */
export const pointSourceRetinalLuminance = (apparentMagnitude: number): number =>
  (ZERO_MAGNITUDE_LUX * Math.pow(10, -0.4 * apparentMagnitude)) / EYE_POINT_SPREAD_SR

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
