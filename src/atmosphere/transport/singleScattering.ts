/**
 * Diffusion simple : la lumiere du ciel.
 *
 * ## L'equation
 *
 * Le long de la ligne de visee `d`, chaque element de volume diffuse vers
 * l'observateur une part de la lumiere solaire qui l'atteint :
 *
 *     L(λ) = E₀(λ) · σ(λ) · p(θ, λ) · ∫ N(h(t)) · exp[−σ(λ)·(C_prim(t) + C_sec(t))] dt
 *
 * avec, pour chaque point `P(t)` du rayon :
 *
 * - `C_prim(t)` — la colonne moleculaire **de l'observateur au point** : ce que
 *   l'atmosphere retire a la lumiere diffusee sur son chemin de retour ;
 * - `C_sec(t)` — la colonne **du point vers le Soleil** : ce qu'elle a deja
 *   retire a la lumiere avant qu'elle n'arrive la ;
 * - `N(h)` — la densite de diffuseurs disponibles ;
 * - `p(θ)` — la fraction rediffusee dans la direction de l'observateur.
 *
 * L'angle `θ` entre la visee et le Soleil est **constant le long du rayon** :
 * les rayons solaires sont paralleles a l'echelle de l'atmosphere. La fonction
 * de phase sort donc de l'integrale, ce qui la rend calculable une fois par
 * direction plutot qu'une fois par pas.
 *
 * ## Rien n'est bleu ici
 *
 * Il n'y a dans ce fichier aucune couleur, aucun degrade, aucune constante
 * ajustee. Le ciel est bleu parce que `σ(λ)` varie en λ⁻⁴·¹ et que le zenith
 * traverse peu d'air ; il blanchit vers l'horizon parce que la colonne
 * s'allonge jusqu'a ce que l'auto-extinction rattrape le gain de diffuseurs.
 *
 * ## Le test d'ombre, et pourquoi il fait le crepuscule
 *
 * Un point haut dans l'atmosphere peut voir le Soleil alors que l'observateur
 * ne le voit plus. C'est **toute** la physique du crepuscule : la lumiere qui
 * eclaire encore le ciel apres le coucher vient de couches situees au-dessus de
 * l'ombre de la Terre. Le rendu actuel n'a rien de tel — il peint un socle
 * nocturne — et c'est pourquoi ses sondes rendent la meme couleur dans toutes
 * les directions a −6° de hauteur solaire.
 *
 * ## Ce qui manque encore
 *
 * **La diffusion multiple**, qui est loin d'etre negligeable : un photon bleu a
 * de bonnes chances d'etre diffuse plusieurs fois avant d'atteindre l'oeil.
 * Elle domine pres de l'horizon et au crepuscule, ou la profondeur optique
 * depasse l'unite. La diffusion simple sous-estime donc ces regimes, et l'ecart
 * mesure est le budget de la phase 8.
 *
 * **La reflexion du sol**, condition aux limites que `AtmosphereState` declare
 * deja (`groundAlbedo`) et que personne ne lit encore.
 *
 * **Les aerosols** (phase 6) et **l'ozone** (phase 7).
 */
import { rayleighCrossSection, rayleighPhaseFunction } from '../rayleigh/rayleigh'
import { sampleFunctionToGrid, type SpectralArray, type SpectralGrid } from '../spectral/SpectralGrid'
import { scaleToDistance, solarIrradianceOn } from '../spectral/SolarSpectrum'
import {
  chromaticity,
  luminance,
  spectralToLinearSrgb,
  spectralToXyz,
  type LinearRgb,
  type Xyz,
} from '../spectral/SpectralSensor'
import { standardProfile } from '../thermodynamics/standardAtmosphere'
import { EARTH_MEAN_RADIUS_M, degToRad, directionFromHorizontal } from '../core/units'
import { ATMOSPHERE_TOP_M, columnToSpace } from './slantPath'
import { sampleColumnLut, type ColumnLut } from '../lut/transmittanceLut'

export interface SingleScatteringOptions {
  observerElevationM?: number
  distanceAu?: number
  co2MoleFraction?: number
  /** Pas d'integration le long du rayon primaire. */
  primarySteps?: number
  /** Pas d'integration le long du rayon secondaire, vers le Soleil. */
  secondarySteps?: number
  /**
   * Table de colonne moleculaire — voir `lut/transmittanceLut.ts`.
   *
   * Fournie, elle remplace l'integration du rayon secondaire par un acces
   * interpole. C'est le poste dominant du solveur : cent vingt-huit evaluations
   * de profil **par pas** du rayon primaire. Omise, le calcul reste exact et
   * sert de reference a la table.
   */
  columnLut?: ColumnLut
}

const RADIUS = EARTH_MEAN_RADIUS_M
const TOP_RADIUS = RADIUS + ATMOSPHERE_TOP_M

/** Sections efficaces tabulees par grille — propriete moleculaire, calculee une fois. */
const crossSectionCache = new Map<string, SpectralArray>()
function crossSectionsOn(grid: SpectralGrid, co2MoleFraction?: number): SpectralArray {
  const key = `${grid.count}:${grid.edgesNm[0]}:${grid.edgesNm[grid.count]}:${co2MoleFraction ?? 'std'}`
  const cached = crossSectionCache.get(key)
  if (cached) return cached
  const values = sampleFunctionToGrid(grid, (lambdaNm) => rayleighCrossSection(lambdaNm, co2MoleFraction))
  crossSectionCache.set(key, values)
  return values
}

/** Fonction de phase tabulee pour un angle de diffusion donne. */
function phaseOn(grid: SpectralGrid, cosTheta: number, co2MoleFraction?: number): SpectralArray {
  return sampleFunctionToGrid(grid, (lambdaNm) => rayleighPhaseFunction(cosTheta, lambdaNm, co2MoleFraction), 2)
}

export interface SkyRadianceResult {
  /** Radiance spectrale, W·m⁻²·sr⁻¹·nm⁻¹. */
  spectrum: SpectralArray
  xyz: Xyz
  linearSrgb: LinearRgb
  chromaticity: readonly [number, number]
  /** Luminance, cd/m². */
  luminanceCdPerM2: number
  /** Angle de diffusion entre la visee et le Soleil, degres. */
  scatteringAngleDeg: number
}

/**
 * Radiance du ciel dans une direction de visee.
 *
 * `viewAltitudeDeg` est la hauteur de la visee au-dessus de l'horizon,
 * `viewAzimuthFromSunDeg` son azimut **relatif au Soleil** — zero face au
 * Soleil, 180 a l'oppose. Seule cette difference compte : l'atmosphere est a
 * symetrie de revolution autour de la verticale.
 *
 * ## Distribution des pas
 *
 * Les pas du rayon primaire sont **quadratiques**, resserres pres de
 * l'observateur. Une visee rasante parcourt onze cents kilometres, mais
 * l'essentiel de la densite tient dans les premieres dizaines : un pas uniforme
 * y consacrerait la quasi-totalite de ses echantillons a du vide.
 */
export function skyRadiance(
  grid: SpectralGrid,
  viewAltitudeDeg: number,
  viewAzimuthFromSunDeg: number,
  sunAltitudeDeg: number,
  options: SingleScatteringOptions = {},
): SkyRadianceResult {
  const {
    observerElevationM = 0,
    distanceAu = 1,
    co2MoleFraction,
    primarySteps = 48,
    secondarySteps = 128,
    columnLut,
  } = options

  const sun = directionFromHorizontal(0, degToRad(sunAltitudeDeg))
  const view = directionFromHorizontal(degToRad(viewAzimuthFromSunDeg), degToRad(viewAltitudeDeg))
  const cosTheta = Math.max(-1, Math.min(1, sun[0] * view[0] + sun[1] * view[1] + sun[2] * view[2]))

  const sigma = crossSectionsOn(grid, co2MoleFraction)
  const phase = phaseOn(grid, cosTheta, co2MoleFraction)
  const incident = distanceAu === 1 ? solarIrradianceOn(grid) : scaleToDistance(solarIrradianceOn(grid), distanceAu)

  // Observateur sur l'axe zenithal, comme partout dans ce module.
  const r0 = RADIUS + observerElevationM
  const oy = r0

  // Longueur du trajet primaire jusqu'a la sortie de l'atmosphere. La visee
  // peut plonger sous l'horizon : le rayon rencontre alors le sol, et il n'y a
  // pas de ciel a integrer.
  const muView = view[1] // cos de l'angle zenithal de la visee, observateur sur +Y
  if (muView < 0 && r0 * Math.sqrt(1 - muView * muView) < RADIUS) {
    const empty = new Float64Array(grid.count)
    return {
      spectrum: empty,
      xyz: [0, 0, 0],
      linearSrgb: [0, 0, 0],
      chromaticity: [0, 0],
      luminanceCdPerM2: 0,
      scatteringAngleDeg: (Math.acos(cosTheta) * 180) / Math.PI,
    }
  }
  const discriminant = r0 * r0 * muView * muView + (TOP_RADIUS * TOP_RADIUS - r0 * r0)
  const totalPath = -r0 * muView + Math.sqrt(Math.max(0, discriminant))

  const spectrum = new Float64Array(grid.count)
  // Colonne accumulee sur le rayon primaire, depuis l'observateur.
  let primaryColumn = 0

  let previousT = 0
  for (let i = 0; i < primarySteps; i++) {
    // Pas quadratiques : resserres pres de l'observateur, ou vit la densite.
    const tEnd = totalPath * ((i + 1) / primarySteps) ** 2
    const tMid = (previousT + tEnd) / 2
    const ds = tEnd - previousT
    previousT = tEnd
    if (!(ds > 0)) continue

    const px = view[0] * tMid
    const py = oy + view[1] * tMid
    const pz = view[2] * tMid
    const radius = Math.hypot(px, py, pz)
    const altitude = radius - RADIUS
    const density = standardProfile(altitude).numberDensityPerM3

    // Colonne accumulee de l'observateur jusqu'au milieu du pas.
    const columnHere = primaryColumn + density * (ds / 2)
    primaryColumn += density * ds

    // Cosinus zenithal du Soleil **au point**, pas a l'observateur.
    const cosSunAtPoint = (px * sun[0] + py * sun[1] + pz * sun[2]) / radius
    const secondary = columnLut
      ? sampleColumnLut(columnLut, altitude, cosSunAtPoint)
      : columnToSpace(altitude, cosSunAtPoint, secondarySteps)
    if (!Number.isFinite(secondary)) continue // le point est dans l'ombre de la Terre

    for (let b = 0; b < grid.count; b++) {
      const tau = sigma[b] * (columnHere + secondary)
      spectrum[b] += incident[b] * sigma[b] * phase[b] * density * Math.exp(-tau) * ds
    }
  }

  const xyz = spectralToXyz(grid, spectrum)
  return {
    spectrum,
    xyz,
    linearSrgb: spectralToLinearSrgb(grid, spectrum),
    chromaticity: chromaticity(xyz),
    luminanceCdPerM2: luminance(grid, spectrum),
    scatteringAngleDeg: (Math.acos(cosTheta) * 180) / Math.PI,
  }
}

export interface DiffuseIlluminanceOptions extends SingleScatteringOptions {
  /** Nombre de subdivisions en cosinus zenithal. */
  zenithSamples?: number
  /** Nombre de subdivisions en azimut. */
  azimuthSamples?: number
}

/**
 * Eclairement horizontal du au **ciel seul**, lux.
 *
 *     E = ∫ L(ω)·cos θ dω     sur l'hemisphere superieur
 *
 * Le changement de variable `µ = cos θ` absorbe le facteur cosinus dans la
 * mesure : `dω·cos θ = µ dµ dφ`. L'echantillonnage uniforme en `µ` place donc
 * naturellement plus de points la ou ils pesent le plus, et evite d'accumuler
 * du bruit pres de l'horizon, ou la radiance varie vite mais ne compte presque
 * pas.
 *
 * C'est la grandeur qui se compare aux paliers de `astro/photometry.ts`, une
 * fois ajoutee a l'eclairement direct de la phase 4.
 */
export function diffuseHorizontalIlluminance(
  grid: SpectralGrid,
  sunAltitudeDeg: number,
  options: DiffuseIlluminanceOptions = {},
): number {
  const { zenithSamples = 24, azimuthSamples = 48, ...rest } = options

  let total = 0
  for (let i = 0; i < zenithSamples; i++) {
    const mu = (i + 0.5) / zenithSamples
    const altitudeDeg = (Math.asin(mu) * 180) / Math.PI
    for (let j = 0; j < azimuthSamples; j++) {
      const azimuthDeg = (360 * (j + 0.5)) / azimuthSamples
      const sky = skyRadiance(grid, altitudeDeg, azimuthDeg, sunAltitudeDeg, rest)
      total += sky.luminanceCdPerM2 * mu
    }
  }

  // `Σ µ ΔµΔφ` avec Δµ = 1/n_µ et Δφ = 2π/n_φ.
  return (total * (1 / zenithSamples) * ((2 * Math.PI) / azimuthSamples))
}
