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
 * ## Diffusion simple ou complete, au choix de l'appelant
 *
 * Ce module calcule le **premier ordre** de diffusion. Les ordres suivants
 * arrivent par `multipleScattering`, sous forme d'un terme source isotrope lu
 * dans une table — voir `multipleScattering.ts`. Omettre cette option laisse
 * une diffusion simple pure, ce qui sert de reference pour mesurer l'apport des
 * ordres superieurs.
 *
 *
 * ## Extinction et diffusion ne sont plus la meme chose
 *
 * Tant que Rayleigh etait seul, tout ce qui quittait le faisceau reapparaissait
 * ailleurs : le coefficient d'extinction **etait** le coefficient de diffusion.
 * L'ozone absorbe, et ce qu'il retire disparait. Les deux grandeurs se separent
 * donc :
 *
 *     extinction   τ(λ) = σ_R(λ)·C_air + σ_O₃(λ)·C_ozone     attenue les trajets
 *     diffusion    β(λ) = σ_R(λ)·N(h)                        seule source diffusee
 *
 * Les confondre ferait briller le ciel de la lumiere que l'ozone a absorbee.
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
import { ozoneCrossSectionOn, ozoneNumberDensity } from '../absorption/ozone'
import { aerosolNumberDensity, aerosolPhase, type AerosolOptics } from '../mie/aerosol'
import { sampleMultipleScattering, type MultipleScatteringLut } from './multipleScattering'
import { EARTH_MEAN_RADIUS_M, degToRad, directionFromHorizontal } from '../core/units'
import { ATMOSPHERE_TOP_M, columnsToSpace } from './slantPath'
import { sampleColumnLut, type ColumnLut } from '../lut/transmittanceLut'

export interface SingleScatteringOptions {
  observerElevationM?: number
  distanceAu?: number
  co2MoleFraction?: number
  /** Pas d'integration le long du rayon primaire. */
  primarySteps?: number
  /** Pas d'integration le long du rayon secondaire, vers le Soleil. */
  secondarySteps?: number
  /** Colonne totale d'ozone, unites Dobson. */
  ozoneColumnDobsonUnits?: number
  /**
   * Table de diffusion multiple — voir `multipleScattering.ts`.
   *
   * Fournie, elle ajoute un terme source **isotrope** representant tous les
   * ordres de diffusion au-dela du premier. Omise, le calcul reste une
   * diffusion simple pure, et sert de reference pour mesurer ce que la
   * diffusion multiple apporte.
   */
  multipleScattering?: MultipleScatteringLut
  /**
   * Proprietes optiques des aerosols — voir `mie/aerosol.ts`.
   *
   * Omises, l'atmosphere est parfaitement claire. C'est utile pour isoler ce
   * que les aerosols apportent, et c'est le chemin qu'emprunte la validation.
   */
  aerosols?: AerosolOptics
  /**
   * Table de colonnes atmospheriques — voir `lut/transmittanceLut.ts`.
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

/** Sections efficaces d'absorption de l'ozone, tabulees par grille. */
const ozoneCache = new Map<string, SpectralArray>()
function ozoneOn(grid: SpectralGrid): SpectralArray {
  const key = `${grid.count}:${grid.edgesNm[0]}:${grid.edgesNm[grid.count]}`
  const cached = ozoneCache.get(key)
  if (cached) return cached
  const values = ozoneCrossSectionOn(grid)
  ozoneCache.set(key, values)
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
export interface AerialPerspectiveOptions extends SingleScatteringOptions {
  /**
   * Nombre de points de controle en distance, le premier a l'observateur et le
   * dernier a la sortie de l'atmosphere.
   */
  slices?: number
  /** Pas de marche entre deux points de controle consecutifs. */
  stepsPerSlice?: number
}

export interface AerialPerspectiveResult {
  slices: number
  bands: number
  /**
   * Radiance diffusee **cumulee** depuis l'observateur, par tranche :
   * `scattered[slice * bands + band]`.
   */
  scattered: Float64Array
  /**
   * Transmittance du **rayon primaire** seul, de l'observateur au point de
   * controle : `transmittance[slice * bands + band]`.
   */
  transmittance: Float64Array
  /** Longueur du trajet jusqu'a la sortie de l'atmosphere, m. */
  totalPathM: number
  /** Angle de diffusion entre la visee et le Soleil, degres. */
  scatteringAngleDeg: number
}

/**
 * Perspective atmospherique : les deux moities de l'equation du transfert, a
 * **toutes les distances** le long d'une visee, en une seule marche.
 *
 *     L_vu(d) = L_objet · T(0→d)  +  L_diffusee(0→d)
 *
 * ## Pourquoi une seule marche
 *
 * La transmittance a la distance `d` et la radiance diffusee jusqu'a `d` sont
 * des **prefixes** des memes integrales que le ciel entier. Les recalculer par
 * distance serait redondant : la marche accumule deja les colonnes depuis
 * l'observateur, il suffit de relever leur valeur en chemin.
 *
 * C'est ce qui rend la table 3D des objets aussi peu couteuse que la table 2D
 * du ciel : meme nombre de rayons, simplement plus d'ecritures.
 *
 * ## La parametrisation en distance
 *
 * Les points de controle sont equirepartis en `w`, avec `t = trajet_total · w²`.
 * Deux consequences, toutes deux voulues :
 *
 * - `w = 1` designe **exactement** la sortie de l'atmosphere, quelle que soit
 *   la direction. Un astre, qui est a l'infini, tombe donc pile sur le dernier
 *   point de controle — et non entre deux, ou l'interpolation le decalerait du
 *   ciel qui l'entoure.
 * - Le carre resserre les points pres de l'observateur, la ou vit la densite.
 *   C'est le meme espacement que celui deja valide pour le ciel.
 *
 * Le trajet total a une forme close, que le nuanceur retrouve seul.
 */
export function aerialPerspective(
  grid: SpectralGrid,
  viewAltitudeDeg: number,
  viewAzimuthFromSunDeg: number,
  sunAltitudeDeg: number,
  options: AerialPerspectiveOptions = {},
): AerialPerspectiveResult {
  const {
    observerElevationM = 0,
    distanceAu = 1,
    co2MoleFraction,
    slices = 2,
    stepsPerSlice = 48,
    secondarySteps = 128,
    ozoneColumnDobsonUnits,
    aerosols,
    multipleScattering,
    columnLut,
  } = options

  const bands = grid.count
  const sliceCount = Math.max(2, slices)
  const scattered = new Float64Array(sliceCount * bands)
  const transmittance = new Float64Array(sliceCount * bands)
  // Point de controle zero : l'observateur. Rien de diffuse, rien d'eteint.
  for (let b = 0; b < bands; b++) transmittance[b] = 1

  const sun = directionFromHorizontal(0, degToRad(sunAltitudeDeg))
  const view = directionFromHorizontal(degToRad(viewAzimuthFromSunDeg), degToRad(viewAltitudeDeg))
  const cosTheta = Math.max(-1, Math.min(1, sun[0] * view[0] + sun[1] * view[1] + sun[2] * view[2]))
  const scatteringAngleDeg = (Math.acos(cosTheta) * 180) / Math.PI

  const sigma = crossSectionsOn(grid, co2MoleFraction)
  const sigmaOzone = ozoneOn(grid)
  const phase = phaseOn(grid, cosTheta, co2MoleFraction)

  // Tampon de lecture de la table de diffusion multiple, alloue une fois par
  // direction plutot qu'a chaque pas de la marche.
  const msBuffer = multipleScattering ? new Float64Array(bands) : null

  // Fonction de phase des aerosols, tabulee une fois par direction. Elle est
  // tres differente de celle de Rayleigh : fortement dirigee vers l'avant, avec
  // un rapport de cent entre 0° et 90°.
  const aerosolPhaseByBand = aerosols ? new Float64Array(bands) : null
  if (aerosols && aerosolPhaseByBand) {
    for (let b = 0; b < bands; b++) aerosolPhaseByBand[b] = aerosolPhase(aerosols, b, cosTheta)
  }
  const incident = distanceAu === 1 ? solarIrradianceOn(grid) : scaleToDistance(solarIrradianceOn(grid), distanceAu)

  // Observateur sur l'axe zenithal, comme partout dans ce module.
  const r0 = RADIUS + observerElevationM
  const oy = r0

  // Longueur du trajet primaire jusqu'a la sortie de l'atmosphere. La visee
  // peut plonger sous l'horizon : le rayon rencontre alors le sol, et il n'y a
  // pas de ciel a integrer — la transmittance reste a 1 sur toutes les
  // tranches, l'objet est vu sans voile parce qu'il n'y a pas de trajet.
  const muView = view[1] // cos de l'angle zenithal de la visee, observateur sur +Y
  if (muView < 0 && r0 * Math.sqrt(1 - muView * muView) < RADIUS) {
    for (let k = 1; k < sliceCount; k++) {
      for (let b = 0; b < bands; b++) transmittance[k * bands + b] = 1
    }
    return { slices: sliceCount, bands, scattered, transmittance, totalPathM: 0, scatteringAngleDeg }
  }
  const discriminant = r0 * r0 * muView * muView + (TOP_RADIUS * TOP_RADIUS - r0 * r0)
  const totalPath = -r0 * muView + Math.sqrt(Math.max(0, discriminant))

  const spectrum = new Float64Array(bands)
  // Colonnes accumulees sur le rayon primaire, depuis l'observateur.
  let primaryAir = 0
  let primaryOzone = 0
  let primaryAerosol = 0

  const totalSteps = (sliceCount - 1) * stepsPerSlice
  let previousT = 0
  for (let i = 0; i < totalSteps; i++) {
    // Pas quadratiques : resserres pres de l'observateur, ou vit la densite.
    const tEnd = totalPath * ((i + 1) / totalSteps) ** 2
    const tMid = (previousT + tEnd) / 2
    const ds = tEnd - previousT
    previousT = tEnd

    if (ds > 0) {
      const px = view[0] * tMid
      const py = oy + view[1] * tMid
      const pz = view[2] * tMid
      const radius = Math.hypot(px, py, pz)
      const altitude = radius - RADIUS
      const density = standardProfile(altitude).numberDensityPerM3
      const ozoneDensity = ozoneNumberDensity(altitude, ozoneColumnDobsonUnits)
      const aerosolDensity = aerosols ? aerosolNumberDensity(aerosols, altitude) : 0

      // Colonnes accumulees de l'observateur jusqu'au milieu du pas.
      const airHere = primaryAir + density * (ds / 2)
      const ozoneHere = primaryOzone + ozoneDensity * (ds / 2)
      const aerosolHere = primaryAerosol + aerosolDensity * (ds / 2)
      primaryAir += density * ds
      primaryOzone += ozoneDensity * ds
      primaryAerosol += aerosolDensity * ds

      // Cosinus zenithal du Soleil **au point**, pas a l'observateur.
      const cosSunAtPoint = (px * sun[0] + py * sun[1] + pz * sun[2]) / radius
      const secondary = columnLut
        ? sampleColumnLut(columnLut, altitude, cosSunAtPoint)
        : columnsToSpace(
            altitude,
            cosSunAtPoint,
            secondarySteps,
            ozoneColumnDobsonUnits,
            aerosols?.scaleHeightM,
          )

      // Le point dans l'ombre de la Terre ne diffuse rien, mais il eteint :
      // ses colonnes primaires ont deja ete comptees ci-dessus.
      if (Number.isFinite(secondary.air)) {
        // Colonne d'aerosols du point vers le Soleil : la table ne porte que la
        // forme geometrique, la densite la multiplie.
        const secondaryAerosol = aerosols ? secondary.aerosolShape * aerosols.groundNumberDensity : 0

        // Radiance isotrope de tous les ordres au-dela du premier, lue au point.
        if (multipleScattering && msBuffer) {
          sampleMultipleScattering(multipleScattering, altitude, cosSunAtPoint, msBuffer)
        }

        for (let b = 0; b < bands; b++) {
          // --- Extinction : les trois especes, sur les deux trajets -----------
          let tau = sigma[b] * (airHere + secondary.air) + sigmaOzone[b] * (ozoneHere + secondary.ozone)
          if (aerosols) tau += aerosols.extinction[b] * (aerosolHere + secondaryAerosol)

          // --- Diffusion : deux sources, deux fonctions de phase --------------
          // Chaque espece diffusante apporte son propre terme, avec sa section
          // efficace de **diffusion** — pas d'extinction — et sa propre fonction
          // de phase. Les melanger sous une phase moyenne effacerait precisement
          // ce qui distingue un ciel clair d'un ciel voile : le halo serre
          // autour du Soleil.
          //
          // L'ozone n'apparait pas ici : il absorbe, il ne redirige rien.
          let source = sigma[b] * phase[b] * density
          if (aerosols && aerosolPhaseByBand) {
            source += aerosols.scattering[b] * aerosolPhaseByBand[b] * aerosolDensity
          }

          let radiance = incident[b] * source

          // --- Diffusion multiple : une source isotrope de plus ---------------
          // Elle ne porte **pas** de fonction de phase : c'est l'hypothese meme
          // de l'approximation, la lumiere ayant perdu la memoire de sa
          // direction d'origine apres le second ordre. Elle est en revanche
          // proportionnelle au coefficient de **diffusion** local, comme toute
          // source diffusee.
          if (multipleScattering && msBuffer) {
            const scattering = sigma[b] * density + (aerosols ? aerosols.scattering[b] * aerosolDensity : 0)
            radiance += scattering * msBuffer[b]
          }

          spectrum[b] += radiance * Math.exp(-tau) * ds
        }
      }
    }

    // --- Point de controle atteint ? ---------------------------------------
    // Les tranches tombent sur des indices de pas exacts, par construction :
    // `totalSteps = (tranches − 1) × pas_par_tranche`. Rien n'est interpole ici.
    if ((i + 1) % stepsPerSlice === 0) {
      const slice = (i + 1) / stepsPerSlice
      const base = slice * bands
      for (let b = 0; b < bands; b++) {
        scattered[base + b] = spectrum[b]
        let tauView = sigma[b] * primaryAir + sigmaOzone[b] * primaryOzone
        if (aerosols) tauView += aerosols.extinction[b] * primaryAerosol
        transmittance[base + b] = Math.exp(-tauView)
      }
    }
  }

  return { slices: sliceCount, bands, scattered, transmittance, totalPathM: totalPath, scatteringAngleDeg }
}

/**
 * Radiance du ciel dans une direction — la perspective atmospherique poussee
 * jusqu'a la sortie de l'atmosphere, sans objet devant.
 *
 * C'est litteralement `aerialPerspective` avec un seul intervalle : meme
 * marche, meme espacement quadratique, meme physique. Il n'y a qu'une
 * implementation du transport, donc aucune derive possible entre ce que voit le
 * fond de ciel et ce que voit un astre pose devant.
 */
export function skyRadiance(
  grid: SpectralGrid,
  viewAltitudeDeg: number,
  viewAzimuthFromSunDeg: number,
  sunAltitudeDeg: number,
  options: SingleScatteringOptions = {},
): SkyRadianceResult {
  const { primarySteps = 48, ...rest } = options
  const aerial = aerialPerspective(grid, viewAltitudeDeg, viewAzimuthFromSunDeg, sunAltitudeDeg, {
    ...rest,
    slices: 2,
    stepsPerSlice: primarySteps,
  })

  const spectrum = aerial.scattered.slice(aerial.bands, 2 * aerial.bands)
  const xyz = spectralToXyz(grid, spectrum)
  return {
    spectrum,
    xyz,
    linearSrgb: spectralToLinearSrgb(grid, spectrum),
    chromaticity: chromaticity(xyz),
    luminanceCdPerM2: luminance(grid, spectrum),
    scatteringAngleDeg: aerial.scatteringAngleDeg,
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
