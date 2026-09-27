/**
 * Couleur des objets du ciel profond, depuis leur indice B−V.
 *
 * A part du composant pour que la suite de validation puisse l'importer sans
 * tirer three.js : c'est la couleur reellement donnee au nuanceur qui se
 * verifie, pas une copie.
 */
import { BLUEST_COLOUR_INDEX, bvToRgb } from '@/astro/catalog'
import { DEEP_SKY_INDEX } from '@/astro/deepsky'

/**
 * Indice de couleur median du catalogue, pour les objets qui n'en ont pas.
 *
 * ⚠️ Treize pour cent des objets de l'atlas n'ont pas de magnitude B. Leur
 * donner la mediane de ceux qui en ont vaut mieux que d'inventer une teinte :
 * c'est la couleur d'un objet quelconque du lot, et rien de plus.
 */
/**
 * Indice de couleur mesure d'un objet, ou `null` s'il n'est pas exploitable.
 *
 * ⚠️ **Vingt-six objets du catalogue sont plus bleus qu'une etoile O** — jusqu'a
 * −3,3 pour M15, un amas globulaire dont l'indice reel avoisine 0,6, et −0,8
 * pour NGC 4565, une galaxie. Une lumiere integree ne peut pas etre plus bleue
 * que les plus chaudes des etoiles qui la composent : ce sont des erreurs de
 * saisie, pas des couleurs. Elles comptent donc comme absentes.
 *
 * Ce n'etait pas qu'une teinte fausse : sous −0,674 la conversion B−V rendait
 * NaN, que le bloom etalait a tout l'ecran — voir `bvToRgb`.
 */
function measuredColourIndex(o: (typeof DEEP_SKY_INDEX)[number] | undefined): number | null {
  if (!o || o.blueMagnitude === null || !Number.isFinite(o.magnitude)) return null
  const bv = o.blueMagnitude - o.magnitude
  return Number.isFinite(bv) && bv >= BLUEST_COLOUR_INDEX ? bv : null
}

const MEDIAN_COLOUR_INDEX = (() => {
  const bv: number[] = []
  for (const o of DEEP_SKY_INDEX) {
    const index = measuredColourIndex(o)
    if (index !== null) bv.push(index)
  }
  bv.sort((x, y) => x - y)
  return bv.length ? bv[bv.length >> 1] : 0.56
})()

/**
 * Couleur d'un objet, depuis son indice de couleur B−V.
 *
 * ⚠️ **Elle venait d'un jeton d'interface** — un par type d'objet, si bien que
 * toutes les galaxies partageaient une teinte decidee dans une feuille de
 * style. Le catalogue porte pourtant des magnitudes B **calibrees** pour 87 %
 * des objets de l'atlas : B−V donne une vraie couleur, par la meme conversion
 * que les etoiles.
 *
 * ⚠️ Ce que cette conversion suppose : que l'objet rayonne comme un corps noir.
 * C'est defendable pour une galaxie, dont la lumiere est la somme de celle de
 * ses etoiles ; c'est **faux** pour une nebuleuse a emission, qui rayonne en
 * raies. Le sens de la teinte reste bon — Halpha rougit, et B−V le voit — mais
 * pas sa saturation.
 */
export function colourFor(catalogueIndex: number): [number, number, number] {
  return bvToRgb(measuredColourIndex(DEEP_SKY_INDEX[catalogueIndex]) ?? MEDIAN_COLOUR_INDEX)
}
