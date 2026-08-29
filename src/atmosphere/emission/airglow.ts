/**
 * Airglow — la lueur propre de la haute atmosphere.
 *
 * ## Ce que ce module remplace
 *
 * Le socle nocturne du moteur etait **peint** : une couleur choisie, un degrade
 * `mix(nuit × 1,6, nuit, …)` plus clair pres de l'horizon parce que c'est ce
 * qu'on observe. Le degrade avait la bonne forme pour la mauvaise raison.
 *
 * L'airglow est une **source d'emission reelle**, et sa place est dans
 * l'equation du transfert, pas par-dessus.
 *
 * ## D'ou vient la lumiere
 *
 * Le jour, le rayonnement ultraviolet dissocie l'oxygene et l'ozone de la haute
 * atmosphere. La nuit, les atomes se recombinent et rendent cette energie sous
 * forme de raies — c'est de la **chimiluminescence**, non de la diffusion. Le
 * ciel nocturne n'est donc jamais noir, meme sans Lune, sans etoiles et sans
 * ville.
 *
 * L'emission se concentre dans une couche mince autour de **90 kilometres**.
 *
 * ## L'effet van Rhijn, et pourquoi l'horizon s'eclaire
 *
 * Une couche mince vue obliquement est traversee sur une plus grande longueur.
 * Pour une coquille spherique a l'altitude `h` :
 *
 *     V(z) = 1 / √(1 − [R/(R+h)]²·sin²z)
 *
 * A l'horizon, `V` atteint **6** : la ligne de visee rase la couche et en
 * traverse six fois l'epaisseur.
 *
 * Mais cette lumiere doit ensuite traverser toute l'atmosphere, et une visee
 * rasante y perd presque tout. **Le produit des deux** — geometrie qui amplifie,
 * extinction qui eteint — donne un maximum vers dix a vingt degres de hauteur,
 * puis un effondrement au ras de l'horizon.
 *
 * C'est exactement ce qu'on observe, et le degrade peint essayait de l'imiter
 * sans le calculer. Ici, il **sort** du produit de deux fonctions dont aucune ne
 * decrit un degrade.
 *
 * ## ⚠️ Le spectre est le point faible
 *
 * L'airglow est fait de raies discretes, et les principales sont connues :
 * l'oxygene atomique a **557,7 nm** — la raie verte, la plus visible —, le
 * doublet du sodium a **589 nm**, l'oxygene rouge a **630 nm**, et les bandes de
 * Meinel de OH, tres fortes mais surtout au-dela de 700 nm.
 *
 * **Leurs intensites relatives, en revanche, varient enormement** — avec
 * l'activite solaire, la saison, la latitude, l'heure de la nuit. Les poids
 * retenus ci-dessous donnent la teinte verdatre caracteristique, mais ils ne
 * viennent d'aucune mesure particuliere.
 *
 * ## ⚠️ Pourquoi les bandes de OH n'y sont pas
 *
 * Elles portent **l'essentiel de l'energie** de l'airglow, et une premiere
 * version les incluait avec des largeurs de soixante a quatre-vingts
 * nanometres. Le resultat etait une chromaticite orangee — `x = 0,55` — la ou
 * l'airglow parait verdatre.
 *
 * Deux raisons de les retirer plutot que d'ajuster leur poids :
 *
 * - elles sont centrees **au-dela de 700 nm**, hors de ce que la grille du
 *   moteur decrit utilement et hors de ce qu'un ecran peut montrer ;
 * - a `4·10⁻⁵ cd/m²`, l'oeil est en vision **scotopique**, dont la sensibilite
 *   s'effondre au-dela de 650 nm. Une chromaticite calculee sur les fonctions
 *   photopiques n'y decrit pas ce qu'un observateur percoit.
 *
 * Les retirer est donc plus honnete que de leur donner un poids invente pour
 * corriger un artefact colorimetrique. Le modele decrit **la part visible** de
 * l'airglow, et le dit.
 *
 * ## ⚠️ Trois raies etroites sur seize bandes
 *
 * La chromaticite depend legerement de la resolution spectrale, les bords de
 * bande ne tombant pas au meme endroit relativement aux raies. C'est une limite
 * de la representation d'un spectre de raies sur une grille large, non une
 * erreur : la validation mesure cette variation.
 *
 * La reference serait un spectre observe — les atlas de **Hanuschik (2003)** ou
 * de l'ESO/UVES pour le ciel nocturne — que rien n'empeche de brancher a la
 * place.
 */
import { AIRGLOW_LUX } from '@/astro/photometry'
import { EARTH_MEAN_RADIUS_M } from '../core/units'
import { sampleFunctionToGrid, type SpectralArray, type SpectralGrid } from '../spectral/SpectralGrid'
import { luminance } from '../spectral/SpectralSensor'

/** Altitude de la couche emissive, m. */
export const AIRGLOW_LAYER_ALTITUDE_M = 90_000

/**
 * Raies principales de l'airglow nocturne.
 *
 * ⚠️ Les longueurs d'onde sont celles des transitions, et elles sont exactes.
 * **Les poids ne le sont pas** : voir l'en-tete du module.
 */
export const AIRGLOW_LINES: ReadonlyArray<{ lambdaNm: number; widthNm: number; weight: number; name: string }> = [
  { lambdaNm: 557.7, widthNm: 3, weight: 1.0, name: 'OI vert' },
  { lambdaNm: 589.3, widthNm: 3, weight: 0.35, name: 'Na D' },
  { lambdaNm: 630.0, widthNm: 3, weight: 0.2, name: 'OI rouge' },
]

/**
 * Sous-echantillons par bande pour l'integration de la forme spectrale.
 *
 * ⚠️ **Une raie de trois nanometres dans une bande de vingt-neuf.** Le defaut de
 * huit subdivisions de `sampleFunctionToGrid` echantillonne la bande tous les
 * 3,7 nm : une raie etroite y est **manquee ou surponderee au hasard**, et la
 * teinte de l'airglow en dependait — elle sortait orangee alors que la raie
 * verte domine trois fois le signal photopique.
 *
 * Sur une grille aussi grossiere, ce n'est pas la forme de la raie qui compte
 * mais son **integrale** ; il faut donc subdiviser assez finement pour la
 * capturer. Soixante-quatre subdivisions donnent un pas de 0,46 nm, six fois
 * plus fin que la raie la plus etroite.
 */
const LINE_SUBDIVISIONS = 64

/** Forme spectrale, sans unite — la normalisation vient ensuite. */
function airglowShape(lambdaNm: number): number {
  let total = 0
  for (const line of AIRGLOW_LINES) {
    const x = (lambdaNm - line.lambdaNm) / line.widthNm
    total += line.weight * Math.exp(-0.5 * x * x)
  }
  return total
}

/**
 * Facteur van Rhijn, sans dimension.
 *
 * Rapport de la longueur traversee dans la couche a celle traversee au zenith.
 * Il vaut 1 au zenith et diverge a l'horizon geometrique — la couche y est vue
 * exactement par la tranche.
 */
export function vanRhijn(zenithAngleDeg: number, layerAltitudeM = AIRGLOW_LAYER_ALTITUDE_M): number {
  const ratio = EARTH_MEAN_RADIUS_M / (EARTH_MEAN_RADIUS_M + layerAltitudeM)
  const sinZ = Math.sin((zenithAngleDeg * Math.PI) / 180)
  const inside = 1 - ratio * ratio * sinZ * sinZ
  return inside > 0 ? 1 / Math.sqrt(inside) : Number.POSITIVE_INFINITY
}

/**
 * Radiance spectrale de l'airglow au zenith, W·m⁻²·sr⁻¹·nm⁻¹.
 *
 * **Normalisee sur une ancre que le moteur portait deja** : `AIRGLOW_LUX`, soit
 * 2·10⁻⁴ lux d'eclairement horizontal, employe depuis longtemps par le calcul de
 * magnitude limite. La forme spectrale est libre, son amplitude ne l'est pas.
 *
 * L'eclairement d'une source de radiance `L(z)` sur un plan horizontal vaut
 * `∫L·cos z dω`. Avec la dependance van Rhijn, cette integrale se calcule une
 * fois et fixe l'echelle.
 */
const zenithCache = new Map<string, SpectralArray>()
export function airglowZenithRadiance(grid: SpectralGrid): SpectralArray {
  const key = `${grid.count}:${grid.edgesNm[0]}:${grid.edgesNm[grid.count]}`
  const cached = zenithCache.get(key)
  if (cached) return cached

  const shape = sampleFunctionToGrid(grid, airglowShape, LINE_SUBDIVISIONS)

  // Eclairement horizontal produit par une radiance zenithale unite, avec la
  // dependance van Rhijn. `dω·cos z = µ dµ dφ`, donc `E = 2π ∫₀¹ V(µ)·µ dµ`.
  const steps = 512
  let geometry = 0
  for (let i = 0; i < steps; i++) {
    const mu = (i + 0.5) / steps
    const zenithDeg = (Math.acos(mu) * 180) / Math.PI
    geometry += vanRhijn(zenithDeg) * mu * (1 / steps)
  }
  geometry *= 2 * Math.PI

  // `luminance` rend des cd/m² ; l'eclairement vaut `geometry × luminance`.
  const shapeLuminance = luminance(grid, shape)
  const scale = shapeLuminance > 0 ? AIRGLOW_LUX / (geometry * shapeLuminance) : 0

  const values = new Float64Array(grid.count)
  for (let b = 0; b < grid.count; b++) values[b] = shape[b] * scale
  zenithCache.set(key, values)
  return values
}

/**
 * Radiance de l'airglow dans une direction, avant extinction.
 *
 * L'extinction n'est **pas** appliquee ici : elle appartient au transport, et le
 * moteur la porte deja dans la table de perspective atmospherique. C'est leur
 * produit qui donne le maximum vers dix a vingt degres et l'effondrement a
 * l'horizon.
 */
export function airglowRadiance(
  grid: SpectralGrid,
  viewAltitudeDeg: number,
  target?: Float64Array,
): Float64Array {
  const zenith = airglowZenithRadiance(grid)
  const factor = vanRhijn(90 - Math.max(0, viewAltitudeDeg))
  const out = target ?? new Float64Array(grid.count)
  for (let b = 0; b < grid.count; b++) out[b] = zenith[b] * factor
  return out
}
