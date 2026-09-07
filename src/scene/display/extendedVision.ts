/**
 * Détecter un objet étendu.
 *
 * ## Le problème
 *
 * Une étoile se voit quand son flux dépasse un seuil, et la magnitude limite le
 * dit. Un objet étendu n'a pas de magnitude utile : M31 pèse 3,4 alors qu'elle
 * est bien plus difficile à voir qu'une étoile de magnitude 5. Sa lumière est
 * étalée sur trois degrés.
 *
 * Ce que l'œil compare au seuil, c'est le flux tombant dans l'aire sur laquelle
 * il **somme** — au-delà, chaque portion est jugée séparément, et l'objet ne
 * gagne plus rien à être grand :
 *
 *     m_élément = mu − 2,5·log10(Omega_eff)
 *
 * Cette magnitude se compare alors à la magnitude limite exactement comme celle
 * d'une étoile. Une seule loi pour les deux.
 *
 * ## ⚠️ Le plafond n'est pas une commodité, il est obligatoire
 *
 *     Omega_eff = min(Omega_sommation, Omega_objet)
 *
 * On ne peut pas collecter plus de lumière que l'objet n'en émet. Sans ce
 * plafond, une petite galaxie recevrait le bénéfice d'une aire qu'elle
 * n'occupe pas, et rendrait une magnitude **plus brillante que sa magnitude
 * intégrée** — ce qui n'a pas de sens.
 *
 * Avec lui, un objet plus petit que l'aire de sommation retombe exactement sur
 * sa magnitude intégrée : la loi des sources ponctuelles n'est plus un cas
 * particulier à traiter, c'est la limite de celle-ci.
 *
 * ## ⚠️ L'aire de sommation n'est pas choisie, elle est déduite
 *
 * La littérature sur la sommation spatiale de l'œil adapté à l'obscurité va de
 * dix minutes d'arc à un degré selon la luminance, l'excentricité rétinienne et
 * le protocole. Choisir dans cet intervalle serait choisir le résultat — c'est
 * la même situation que pour la tache de diffusion, et on la traite pareil.
 *
 * **L'ancrage observationnel** : M33 est l'objet limite du ciel à l'œil nu. Les
 * observateurs s'accordent — elle demande un ciel vraiment noir, et sert de
 * test. On pose donc qu'elle est **exactement au seuil** sous le ciel le plus
 * noir que le moteur connaisse, celui d'un site vierge.
 *
 * Ni sa brillance ni ce seuil ne sont introduits ici : la première vient du
 * catalogue, le second des paliers de magnitude limite.
 *
 * ## La vérification, sur des objets qui n'ont pas servi à la déduire
 *
 * | objet | brillance | m_élément | plafonné | verdict du modèle | observé |
 * | --- | --- | --- | --- | --- | --- |
 * | M42 | 21,96 | 5,75 | non | le plus facile | oui |
 * | M31 | 22,30 | 6,09 | non | demande un ciel correct | oui |
 * | M33 | 22,81 | 6,60 | non | à la limite | ancrage |
 * | M13 | 20,52 | 5,80 | oui | source ponctuelle de magnitude 5,8 | oui |
 * | M81 | 21,51 | 6,92 | oui | hors de portée | oui |
 * | M101 | 23,39 | 7,90 | oui | hors de portée | oui |
 *
 * M81 est le contrôle qui compte : sa brillance de surface est **celle de
 * M42**, et pourtant elle n'est pas un objet à l'œil nu. C'est le plafond qui
 * l'écarte — trop petite pour profiter de la sommation, elle retombe sur sa
 * magnitude intégrée. Rien n'a été réglé pour obtenir ce résultat.
 *
 * M13 dit la même chose autrement : plafonnée, elle rend exactement 5,80, sa
 * magnitude de catalogue. Un amas compact se comporte comme une étoile de même
 * éclat, ce qui est bien ce qu'on observe.
 *
 * L'aire déduite vaut **32,9 minutes d'arc** de diamètre, ce qui tombe dans
 * l'intervalle publié sans y avoir été pris. C'est une vérification, pas une
 * justification.
 *
 * ## ⚠️ Ce que le modèle ne fait pas
 *
 * **Le profil n'est pas lissé à l'échelle de sommation.** L'œil intègre sur
 * trente-trois minutes d'arc ; on applique pourtant la loi à la brillance
 * **locale**, telle que l'atlas la donne. Un cœur plus petit que l'aire de
 * sommation reçoit donc un bénéfice qu'il ne devrait pas avoir, et se voit un
 * peu trop tôt sous un ciel de ville.
 */
import { findDeepSkyObject } from '@/astro/deepsky'
import { ARCSEC2_STERADIAN } from './adaptation'

/**
 * Objet servant d'ancrage, et magnitude limite sous laquelle il est au seuil.
 *
 * 6,6 est la magnitude limite d'un site vierge dans les paliers du moteur —
 * voir `LIMIT_MAG_ANCHORS` dans `astro/photometry`. Ce n'est pas un nombre
 * introduit ici.
 */
const THRESHOLD_OBJECT = 'M33'
const PRISTINE_LIMITING_MAGNITUDE = 6.6

/** Brillance de surface moyenne de l'objet d'ancrage, mag/arcsec². */
const THRESHOLD_SURFACE_BRIGHTNESS = findDeepSkyObject(THRESHOLD_OBJECT)?.surfaceBrightness ?? 22.81

/**
 * Aire sur laquelle l'œil somme la lumière d'un objet étendu, steradians.
 *
 * Déduite de l'ancrage : c'est l'aire pour laquelle l'objet limite tombe
 * exactement sur la magnitude limite d'un ciel vierge.
 */
export const EYE_SUMMATION_SR =
  ARCSEC2_STERADIAN *
  Math.pow(10, (THRESHOLD_SURFACE_BRIGHTNESS - PRISTINE_LIMITING_MAGNITUDE) / 2.5)

/** Diamètre équivalent de cette aire, minutes d'arc — pour la lire. */
export const EYE_SUMMATION_ARCMIN =
  (2 * Math.sqrt(EYE_SUMMATION_SR / ARCSEC2_STERADIAN / Math.PI)) / 60

/**
 * Aire effective de sommation pour un objet d'angle solide donné, steradians.
 *
 * Le plafond par l'objet lui-même est ce qui fait retomber les petits objets
 * sur leur magnitude intégrée.
 */
export function effectiveSummationSr(objectSolidAngleSr: number): number {
  return Math.min(EYE_SUMMATION_SR, Math.max(1e-18, objectSolidAngleSr))
}

/**
 * Magnitude du flux tombant dans l'aire de sommation.
 *
 * C'est la grandeur à comparer à la magnitude limite, pour un objet étendu
 * comme pour une étoile.
 */
export function elementMagnitude(
  surfaceBrightnessMagPerArcsec2: number,
  objectSolidAngleSr: number,
): number {
  const omega = effectiveSummationSr(objectSolidAngleSr) / ARCSEC2_STERADIAN
  return surfaceBrightnessMagPerArcsec2 - 2.5 * Math.log10(omega)
}
