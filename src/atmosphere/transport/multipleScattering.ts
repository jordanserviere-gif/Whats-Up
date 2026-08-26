/**
 * Diffusion multiple — la lumiere qui a rebondi plus d'une fois.
 *
 * ## Pourquoi elle manque cruellement
 *
 * La diffusion simple suppose qu'un photon est diffuse une fois puis atteint
 * l'oeil. C'est une bonne approximation quand la profondeur optique est petite,
 * et une mauvaise des qu'elle approche l'unite — pres de l'horizon, au
 * crepuscule, dans le bleu. Le modele accusait un deficit mesure de **32 % a 5°
 * de hauteur solaire**, et davantage sous l'horizon.
 *
 * ## La strategie, et pourquoi celle-la
 *
 * Le calcul exact demande de resoudre le champ de radiance ordre par ordre,
 * avec une table a quatre dimensions. C'est hors de portee d'une
 * reconstruction interactive.
 *
 * La methode de Hillaire (2020) repose sur une **approximation physiquement
 * fondee** : au-dela du second ordre, la lumiere diffusee a perdu la memoire de
 * sa direction d'origine, et peut etre traitee comme **isotrope**. Les ordres
 * suivants forment alors une serie geometrique, dont la somme est close :
 *
 *     L_f(x)  = ⟨ ∫ T(x,x')·σ_s(x')·p_u·S(x')·E_sol dt ⟩ sur 4π     p_u = 1/4π
 *     f_ms(x) = ⟨ ∫ T(x,x')·σ_s(x') dt ⟩ sur 4π
 *     Ψ_ms    = L_f / (1 − f_ms)
 *
 * Le `p_u` de `L_f` est la phase isotrope appliquee a la source solaire. Il
 * n'apparait pas dans `f_ms`, qui repond a une radiance deja isotrope : le
 * `1/4π` de la phase y est annule par l'integration sur les 4π steradians.
 *
 * `L_f` est ce qui arrive au point apres **une** diffusion, vu de toutes les
 * directions. `f_ms` est la reponse du milieu a une radiance isotrope unite —
 * c'est-a-dire la fraction qui repart pour un tour de plus. La serie
 * `1 + f + f² + …` converge tant que `f_ms < 1`, ce que la validation verifie.
 *
 * Ψ_ms entre ensuite dans la marche principale comme **terme source isotrope**,
 * sans fonction de phase : c'est precisement l'hypothese qui rend la methode
 * abordable.
 *
 * ## Ce n'est pas une LUT peinte
 *
 * Chaque entree sort du meme transport que le reste du moteur : meme profil de
 * densite, memes sections efficaces, meme geometrie spherique, meme test
 * d'ombre. La table ne fait qu'eviter de refaire ce calcul par pixel.
 *
 * ## Le sol entre enfin dans le calcul
 *
 * `AtmosphereState.groundAlbedo` etait declare depuis la phase 1 et n'etait lu
 * par personne. La lumiere renvoyee par le sol **est** une composante de la
 * diffusion multiple : un rayon qui rencontre la surface n'y disparait pas, il
 * en repart. C'est ici que l'albedo trouve son emploi, et c'est la raison pour
 * laquelle il avait ete declare.
 *
 * Reference : Hillaire, S. (2020), *A Scalable and Production Ready Sky and
 * Atmosphere Rendering Technique*, Computer Graphics Forum 39(4).
 */
import { EARTH_MEAN_RADIUS_M, degToRad } from '../core/units'
import { ozoneCrossSectionOn, ozoneNumberDensity } from '../absorption/ozone'
import { rayleighCrossSection } from '../rayleigh/rayleigh'
import { aerosolNumberDensity, type AerosolOptics } from '../mie/aerosol'
import { sampleFunctionToGrid, type SpectralArray, type SpectralGrid } from '../spectral/SpectralGrid'
import { solarIrradianceOn } from '../spectral/SolarSpectrum'
import { standardProfile } from '../thermodynamics/standardAtmosphere'
import { ATMOSPHERE_TOP_M } from './slantPath'
import { sampleColumnLut, type ColumnLut } from '../lut/transmittanceLut'

const RADIUS = EARTH_MEAN_RADIUS_M
const TOP_RADIUS = RADIUS + ATMOSPHERE_TOP_M

export interface MultipleScatteringLut {
  /** Nombre d'entrees en cosinus zenithal solaire. */
  readonly width: number
  /** Nombre d'entrees en altitude. */
  readonly height: number
  readonly bands: number
  /** Radiance isotrope Ψ_ms — `data[(y * width + x) * bands + b]`. */
  readonly data: Float64Array
  /**
   * Valeur maximale de `f_ms` rencontree : la serie diverge si elle atteint 1.
   *
   * Mutable, parce que la table se remplit par tranches de lignes — la valeur
   * n'est definitive qu'une fois la derniere tranche posee.
   */
  maxTransferFactor: number
}

export interface MultipleScatteringOptions {
  width?: number
  height?: number
  /** Directions echantillonnees sur la sphere, par entree. */
  directions?: number
  /** Pas de marche par direction. */
  steps?: number
  ozoneColumnDobsonUnits?: number
  aerosols?: AerosolOptics
  /** Albedo du sol — voir l'en-tete du module. */
  groundAlbedo?: number
  columnLut?: ColumnLut
}

/** Altitude correspondant a une coordonnee verticale de [0,1]. */
export const msAltitude = (v: number): number => v * v * ATMOSPHERE_TOP_M
/** Cosinus zenithal solaire correspondant a une coordonnee horizontale de [0,1]. */
export const msCosSun = (u: number): number => 2 * u - 1

/**
 * Directions uniformement reparties sur la sphere, par spirale de Fibonacci.
 *
 * Preferee a un maillage regulier en (θ, φ) : celui-ci concentre ses points aux
 * poles et laisse l'equateur clairsemé, ce qui biaiserait une moyenne
 * directionnelle. La spirale repartit uniformement en surface.
 */
function sphereDirections(count: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const z = 1 - (2 * (i + 0.5)) / count
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    const phi = golden * i
    out.push([r * Math.cos(phi), z, r * Math.sin(phi)])
  }
  return out
}

const rayleighCache = new Map<string, SpectralArray>()
function rayleighOn(grid: SpectralGrid): SpectralArray {
  const key = `${grid.count}:${grid.edgesNm[0]}:${grid.edgesNm[grid.count]}`
  const cached = rayleighCache.get(key)
  if (cached) return cached
  const values = sampleFunctionToGrid(grid, (lambdaNm) => rayleighCrossSection(lambdaNm))
  rayleighCache.set(key, values)
  return values
}

/**
 * Alloue une table vide, a remplir par `fillMultipleScatteringRows`.
 *
 * Resolution par defaut : 32 x 32. La mesure de convergence donne 3,115 klx a
 * 16x16 contre 3,125 a 32x32 et 48x48 — la table est plate a 32.
 */
export function createMultipleScatteringLut(
  grid: SpectralGrid,
  options: MultipleScatteringOptions = {},
): MultipleScatteringLut {
  const { width = 32, height = 32 } = options
  return {
    width,
    height,
    bands: grid.count,
    data: new Float64Array(width * height * grid.count),
    maxTransferFactor: 0,
  }
}

/**
 * Remplit une **tranche d'entrees** de la table.
 *
 * Meme raison qu'a la table de ciel : la construction complete coute environ
 * 275 ms, ce qui figerait l'image a chaque cran du curseur de trouble. Etalee
 * sur plusieurs images, elle disparait du budget sans rien retirer a la
 * physique.
 *
 * Le decoupage se fait a l'**entree** et non a la ligne, contrairement a la
 * table de ciel. Une ligne vaut ici 32 entrees a 0,27 ms, soit 8,6 ms — plus de
 * la moitie d'une image a 60 Hz, et donc un grain trop gros pour choisir
 * librement la charge par image. Chaque entree etant independante des autres,
 * rien n'obligeait a s'arreter en bout de ligne.
 *
 * La table depend de la **composition** de l'atmosphere — donc du trouble —
 * mais ni de l'heure ni de la direction de visee : la position du Soleil est
 * l'une de ses deux dimensions, pas un parametre de construction. Un lever de
 * Soleil ne la reconstruit donc jamais.
 */
export function fillMultipleScatteringEntries(
  lut: MultipleScatteringLut,
  grid: SpectralGrid,
  fromEntry: number,
  toEntry: number,
  options: MultipleScatteringOptions = {},
): void {
  const {
    directions = 32,
    steps = 20,
    ozoneColumnDobsonUnits,
    aerosols,
    groundAlbedo = 0.1,
    columnLut,
  } = options

  const { width, height, bands, data } = lut
  const sigmaR = rayleighOn(grid)
  const sigmaO3 = ozoneCrossSectionOn(grid)
  const incident = solarIrradianceOn(grid)
  const rays = sphereDirections(directions)

  // Tampons reutilises : une allocation par entree couterait plus cher que le
  // calcul lui-meme sur une table de mille entrees.
  const lf = new Float64Array(bands)
  const fms = new Float64Array(bands)
  const tau = new Float64Array(bands)

  const first = Math.max(0, fromEntry)
  const last = Math.min(width * height, toEntry)

  for (let entry = first; entry < last; entry++) {
    const y = Math.floor(entry / width)
    const x = entry - y * width
    const altitude = msAltitude(height > 1 ? y / (height - 1) : 0)
    const r0 = RADIUS + altitude

    {
      const muSun = msCosSun(width > 1 ? x / (width - 1) : 0.5)
      // Le Soleil est place dans le plan xOy, sans perte de generalite : seule
      // sa hauteur compte pour une grandeur isotrope.
      const sun: [number, number, number] = [Math.sqrt(Math.max(0, 1 - muSun * muSun)), muSun, 0]

      lf.fill(0)
      fms.fill(0)

      for (const dir of rays) {
        // Longueur du trajet : jusqu'au sol s'il est rencontre, sinon jusqu'au
        // sommet de l'atmosphere.
        const b = r0 * dir[1]
        const discriminantGround = b * b - (r0 * r0 - RADIUS * RADIUS)
        const hitsGround = dir[1] < 0 && discriminantGround > 0
        const distanceToGround = hitsGround ? -b - Math.sqrt(discriminantGround) : Infinity
        const distanceToTop = -b + Math.sqrt(Math.max(0, b * b + TOP_RADIUS * TOP_RADIUS - r0 * r0))
        const total = Math.min(distanceToGround, distanceToTop)
        if (!(total > 0)) continue

        const ds = total / steps
        tau.fill(0)

        for (let i = 0; i < steps; i++) {
          const t = (i + 0.5) * ds
          const px = dir[0] * t
          const py = r0 + dir[1] * t
          const pz = dir[2] * t
          const radius = Math.hypot(px, py, pz)
          const h = radius - RADIUS

          const nAir = standardProfile(h).numberDensityPerM3
          const nO3 = ozoneNumberDensity(h, ozoneColumnDobsonUnits)
          const nAer = aerosols ? aerosolNumberDensity(aerosols, h) : 0

          // Transmittance du point vers l'echantillon : accumulee sur la marche.
          const cosSunHere = (px * sun[0] + py * sun[1] + pz * sun[2]) / radius
          const secondary = columnLut ? sampleColumnLut(columnLut, h, cosSunHere) : null
          const sunlit = secondary !== null && Number.isFinite(secondary.air)

          for (let k = 0; k < bands; k++) {
            const scattering = sigmaR[k] * nAir + (aerosols ? aerosols.scattering[k] * nAer : 0)
            const extinction =
              sigmaR[k] * nAir + sigmaO3[k] * nO3 + (aerosols ? aerosols.extinction[k] * nAer : 0)

            // Transmittance integree sur la longueur du pas, comme ailleurs
            // dans le moteur : evaluer au point milieu suffirait mal quand le
            // pas est optiquement epais.
            const transmittance = Math.exp(-tau[k])
            const contribution = transmittance * scattering * ds

            fms[k] += contribution

            if (sunlit && secondary) {
              // Le facteur `1/4π` est celui de la **phase isotrope** appliquee
              // a la source solaire : `σ_s · E · T_sol · p_u`. Il n'apparait pas
              // dans `f_ms`, qui repond a une radiance deja isotrope — la ou le
              // `1/4π` de la phase s'annule avec l'integration sur 4π.
              //
              // L'oublier surestime Ψ_ms d'un facteur 4π ≈ 12,6, et le ciel
              // devient trois a six fois trop lumineux. Rien d'autre ne le
              // signale : les profils restent plausibles.
              const sunTau =
                sigmaR[k] * secondary.air +
                sigmaO3[k] * secondary.ozone +
                (aerosols ? aerosols.extinction[k] * secondary.aerosolShape * aerosols.groundNumberDensity : 0)
              lf[k] += (contribution * Math.exp(-sunTau) * incident[k]) / (4 * Math.PI)
            }

            tau[k] += extinction * ds
          }
        }

        // Le sol renvoie ce qu'il recoit : c'est la seconde source de la
        // diffusion multiple, et la raison pour laquelle `groundAlbedo` existe
        // dans l'etat depuis la phase 1.
        if (hitsGround && groundAlbedo > 0 && columnLut) {
          const groundSun = sampleColumnLut(columnLut, 0, muSun)
          if (Number.isFinite(groundSun.air) && muSun > 0) {
            for (let k = 0; k < bands; k++) {
              const sunTau =
                sigmaR[k] * groundSun.air +
                sigmaO3[k] * groundSun.ozone +
                (aerosols ? aerosols.extinction[k] * groundSun.aerosolShape * aerosols.groundNumberDensity : 0)
              // Surface lambertienne : `E·albedo/π` repart dans chaque direction.
              const reflected = (incident[k] * Math.exp(-sunTau) * muSun * groundAlbedo) / Math.PI
              lf[k] += Math.exp(-tau[k]) * reflected
            }
          }
        }
      }

      const base = (y * width + x) * bands
      for (let k = 0; k < bands; k++) {
        // `⟨·⟩ sur 4π` avec la phase isotrope `1/4π` : les deux facteurs se
        // simplifient, il ne reste qu'une moyenne sur les directions.
        const transfer = fms[k] / rays.length
        lut.maxTransferFactor = Math.max(lut.maxTransferFactor, transfer)
        data[base + k] = lf[k] / rays.length / Math.max(1e-6, 1 - transfer)
      }
    }
  }
}

/** Table complete, d'un seul tenant — pour la validation et les mesures. */
export function buildMultipleScatteringLut(
  grid: SpectralGrid,
  options: MultipleScatteringOptions = {},
): MultipleScatteringLut {
  const lut = createMultipleScatteringLut(grid, options)
  fillMultipleScatteringEntries(lut, grid, 0, lut.width * lut.height, options)
  return lut
}

/**
 * Lit la table par interpolation bilineaire.
 *
 * `target` recoit le resultat, pour eviter une allocation par pas de marche.
 */
export function sampleMultipleScattering(
  lut: MultipleScatteringLut,
  altitudeM: number,
  cosSunZenith: number,
  target: Float64Array,
): Float64Array {
  const v = Math.sqrt(Math.max(0, Math.min(1, altitudeM / ATMOSPHERE_TOP_M)))
  const u = Math.max(0, Math.min(1, (cosSunZenith + 1) / 2))

  const fx = Math.max(0, Math.min(lut.width - 1, u * (lut.width - 1)))
  const fy = Math.max(0, Math.min(lut.height - 1, v * (lut.height - 1)))
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(lut.width - 1, x0 + 1)
  const y1 = Math.min(lut.height - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0

  const b = lut.bands
  const i00 = (y0 * lut.width + x0) * b
  const i10 = (y0 * lut.width + x1) * b
  const i01 = (y1 * lut.width + x0) * b
  const i11 = (y1 * lut.width + x1) * b

  for (let k = 0; k < b; k++) {
    target[k] =
      (lut.data[i00 + k] * (1 - tx) + lut.data[i10 + k] * tx) * (1 - ty) +
      (lut.data[i01 + k] * (1 - tx) + lut.data[i11 + k] * tx) * ty
  }
  return target
}

/** Hauteur solaire en degres vers cosinus zenithal — commodite d'appel. */
export const cosSunFromAltitude = (altitudeDeg: number): number => Math.sin(degToRad(altitudeDeg))
