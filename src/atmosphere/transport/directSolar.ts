/**
 * Transport direct : le Soleil vu a travers l'atmosphere.
 *
 * ## L'equation, et rien d'autre
 *
 *     L_direct(λ) = L₀(λ) · exp(−τ(λ, z))
 *
 * Loi de Beer-Lambert. `L₀` est le spectre solaire hors atmosphere (phase 2),
 * `τ` la profondeur optique le long du trajet oblique (phases 1 et 3). Il n'y a
 * pas d'autre ingredient, et surtout pas de couleur.
 *
 * ## Ce qui en sort tout seul
 *
 * Le Soleil rougit en descendant. Pas parce qu'une fonction le decide, mais
 * parce que le trajet s'allonge — d'un facteur trente-huit entre le zenith et
 * l'horizon — et que la section efficace de Rayleigh varie en λ⁻⁴·¹. Le bleu
 * est retire bien avant le rouge, et ce qui reste est orange.
 *
 * Il n'existe dans ce fichier ni `sunsetColor`, ni condition sur la hauteur du
 * Soleil, ni palier. La hauteur n'entre que dans la longueur du trajet.
 *
 * ## Ce qui manque encore, et se voit dans les chiffres
 *
 * L'extinction compte desormais la diffusion moleculaire **et** l'absorption par
 * l'ozone. Il manque encore les aerosols (phase 6), qui retirent surtout aux
 * faibles hauteurs, ainsi que les bandes de O₂ et H₂O — etroites, situees dans
 * le proche infrarouge, et sans effet notable sur la couleur.
 *
 * Le ciel diffus n'est pas la non plus : ce module ne rend que le **rayonnement
 * direct**, pas l'eclairement global. La difference est negligeable Soleil
 * haut, et dominante Soleil bas.
 */
import { rayleighCrossSection } from '../rayleigh/rayleigh'
import {
  integrateOverGrid,
  sampleFunctionToGrid,
  type SpectralArray,
  type SpectralGrid,
} from '../spectral/SpectralGrid'
import { scaleToDistance, solarIrradianceOn } from '../spectral/SolarSpectrum'
import {
  chromaticity,
  luminance,
  spectralToLinearSrgb,
  spectralToXyz,
  type LinearRgb,
  type Xyz,
} from '../spectral/SpectralSensor'
import { columnsToSpace } from './slantPath'
import { ozoneCrossSectionOn } from '../absorption/ozone'

export interface DirectSolarResult {
  /** Irradiance spectrale transmise, W/m²/nm, **normale au faisceau**. */
  spectrum: SpectralArray
  /** Transmittance spectrale, sans dimension. */
  transmittance: SpectralArray
  /** Tristimulus CIE du faisceau transmis. */
  xyz: Xyz
  /** sRGB lineaire, non borne. */
  linearSrgb: LinearRgb
  /** Chromaticite `(x, y)`. */
  chromaticity: readonly [number, number]
  /** Eclairement **normal au faisceau**, lux. */
  normalIlluminanceLux: number
  /**
   * Eclairement **horizontal**, lux — projete par `sin(hauteur)`.
   *
   * C'est la grandeur que tabule `astro/photometry.ts`, et donc celle qui se
   * compare a ses paliers.
   */
  horizontalIlluminanceLux: number
  /** Irradiance totale transmise sur la grille, W/m². */
  irradianceWPerM2: number
  /** Colonne moleculaire traversee, m⁻². */
  columnPerM2: number
}

/**
 * Cache de la profondeur optique spectrale.
 *
 * `σ(λ)` ne depend ni de l'heure ni du lieu : c'est une propriete moleculaire.
 * On la tabule une fois par grille, et la profondeur optique n'est plus qu'une
 * multiplication par la colonne. C'est exactement la separation annoncee en
 * phase 3 entre ce qui se met en cache et ce qui doit etre recalcule.
 */
const crossSectionCache = new Map<string, SpectralArray>()

function crossSectionsOn(grid: SpectralGrid, co2MoleFraction?: number): SpectralArray {
  const key = `${grid.count}:${grid.edgesNm[0]}:${grid.edgesNm[grid.count]}:${co2MoleFraction ?? 'std'}`
  const cached = crossSectionCache.get(key)
  if (cached) return cached
  const values = sampleFunctionToGrid(grid, (lambdaNm) => rayleighCrossSection(lambdaNm, co2MoleFraction))
  crossSectionCache.set(key, values)
  return values
}

export interface DirectSolarOptions {
  /** Altitude de l'observateur, m. */
  observerElevationM?: number
  /** Distance Terre-Soleil, UA. L'orbite etant excentrique, l'ecart annuel atteint 6,9 %. */
  distanceAu?: number
  co2MoleFraction?: number
  /** Colonne totale d'ozone, unites Dobson. */
  ozoneColumnDobsonUnits?: number
}

/**
 * Rayonnement solaire direct parvenant a l'observateur.
 *
 * `altitudeDeg` est la hauteur **geometrique** du Soleil au-dessus de
 * l'horizon, sans refraction — coherente avec la geometrie de la scene.
 */
export function directSolar(
  grid: SpectralGrid,
  altitudeDeg: number,
  options: DirectSolarOptions = {},
): DirectSolarResult {
  const { observerElevationM = 0, distanceAu = 1, co2MoleFraction, ozoneColumnDobsonUnits } = options

  // La visee du Soleil part de l'observateur : son cosinus zenithal est le
  // sinus de la hauteur solaire.
  const columns = columnsToSpace(
    observerElevationM,
    Math.sin((altitudeDeg * Math.PI) / 180),
    1024,
    ozoneColumnDobsonUnits,
  )
  const sigma = crossSectionsOn(grid, co2MoleFraction)
  const sigmaOzone = ozoneCrossSectionOn(grid)
  const incident = distanceAu === 1 ? solarIrradianceOn(grid) : scaleToDistance(solarIrradianceOn(grid), distanceAu)

  const transmittance = new Float64Array(grid.count)
  const spectrum = new Float64Array(grid.count)
  for (let i = 0; i < grid.count; i++) {
    // Colonne infinie sous l'horizon geometrique : `exp(−∞)` vaut zero, et
    // `Math.exp` le rend correctement sans cas particulier.
    transmittance[i] = Math.exp(-sigma[i] * columns.air - sigmaOzone[i] * columns.ozone)
    spectrum[i] = incident[i] * transmittance[i]
  }

  const xyz = spectralToXyz(grid, spectrum)
  const normalIlluminanceLux = luminance(grid, spectrum)
  const sinAltitude = Math.max(0, Math.sin((altitudeDeg * Math.PI) / 180))

  return {
    spectrum,
    transmittance,
    xyz,
    linearSrgb: spectralToLinearSrgb(grid, spectrum),
    chromaticity: chromaticity(xyz),
    normalIlluminanceLux,
    horizontalIlluminanceLux: normalIlluminanceLux * sinAltitude,
    irradianceWPerM2: integrateOverGrid(grid, spectrum),
    columnPerM2: columns.air,
  }
}

/**
 * Couleur du disque solaire, **normalisee sur sa valeur au zenith**.
 *
 * Le rendu a besoin de deux choses distinctes : une teinte et un eclat. Les
 * deux sortent de la meme grandeur physique, et cette fonction les rend
 * ensemble sous forme d'un triplet sRGB lineaire dont la luminance vaut 1
 * lorsque le Soleil est au zenith.
 *
 * Normaliser plutot que rendre la radiance absolue est un choix **de
 * transition**, pas de modele : le ciel n'est pas encore sur la meme echelle
 * radiometrique que le Soleil (phase 5), et les mettre en rapport avant qu'ils
 * ne partagent une echelle produirait un Soleil correct sur un ciel faux. La
 * grandeur absolue existe deja — `normalIlluminanceLux` — et prendra le relais
 * des que le ciel saura la lire.
 *
 * Ce qui est **deja physique** : le rapport entre les canaux, et la facon dont
 * l'ensemble faiblit quand le Soleil descend. Le disque rougit et s'eteint
 * parce que la colonne d'air s'allonge, sans qu'aucune couleur soit ecrite.
 */
export function sunDiscTint(
  grid: SpectralGrid,
  altitudeDeg: number,
  options: DirectSolarOptions = {},
): [number, number, number] {
  // Normalisation par le **Y du tristimulus**, pas par `luminance()`.
  //
  // Les deux decrivent la meme grandeur mais pas dans la meme unite :
  // `luminance()` rend des cd/m², soit 683 fois le Y de CIE XYZ. Or la
  // deuxieme ligne de la matrice sRGB **est** la ligne Y : diviser un sRGB
  // lineaire par une luminance photometrique laisserait donc un facteur 683
  // parasite. La suite de validation le verifie en exigeant une luma unite.
  // La reference est **toujours** le zenith au niveau de la mer, quelle que
  // soit l'altitude de l'observateur. Normaliser sur son propre zenith
  // effacerait un effet reel : depuis le Pic du Midi, le Soleil est
  // effectivement plus brillant qu'au bord de la mer, parce qu'un quart de la
  // colonne est deja sous les pieds de l'observateur.
  const zenithY = directSolar(grid, 90, { ...options, observerElevationM: 0 }).xyz[1]
  if (!(zenithY > 0)) return [0, 0, 0]

  const rgb = directSolar(grid, altitudeDeg, options).linearSrgb
  return [rgb[0] / zenithY, rgb[1] / zenithY, rgb[2] / zenithY]
}
