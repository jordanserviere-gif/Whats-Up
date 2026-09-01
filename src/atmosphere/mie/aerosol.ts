/**
 * Aerosols — proprietes optiques d'une population de particules.
 *
 * ## La separation qu'impose le moteur
 *
 * ```
 * calcul scientifique des proprietes Mie   →  une fois, hors boucle
 * utilisation runtime                       →  lecture de tables
 * ```
 *
 * Une seule evaluation de Mie coute une centaine d'operations complexes, et il
 * en faut une par rayon **et** par longueur d'onde **et** par taille de
 * particule. La refaire par pixel serait absurde. Ce module fait le calcul une
 * fois pour une population donnee et rend des tables : sections efficaces par
 * bande, facteur d'asymetrie, fonction de phase echantillonnee.
 *
 * ## La distribution de tailles
 *
 * Un aerosol n'est jamais monodisperse. La loi log-normale est la description
 * usuelle :
 *
 *     n(r) ∝ (1/r) · exp[ −ln²(r/r_g) / (2 ln²σ_g) ]
 *
 * Elle a deux parametres : un rayon median `r_g` et une largeur `σ_g`. Moyenner
 * sur elle **lisse la fonction de phase** : les oscillations violentes du calcul
 * de Mie monodisperse — la structure d'interference d'une sphere parfaite — se
 * moyennent et disparaissent. C'est pourquoi le ciel reel ne montre pas ces
 * franges.
 *
 * ## Ce qui est une donnee, et ce qui est un parametre
 *
 * L'algorithme de Mie est **exact**. Ses entrees ne le sont pas :
 *
 * > ⚠️ **L'indice de refraction complexe et la distribution de tailles sont des
 * > parametres, pas des mesures.** Les valeurs par defaut decrivent un aerosol
 * > continental moyen et sont plausibles, mais elles n'ont pas ete tirees d'une
 * > base de donnees. La reference serait **OPAC** (Hess, Koepke & Schult, 1998),
 * > qui tabule indices et distributions par type d'aerosol — maritime, urbain,
 * > desertique, suie. Les brancher ne demanderait aucun changement de structure.
 *
 * ## Le pont avec le reglage existant
 *
 * L'application pilote deja un « trouble atmospherique » de 1 a 6, asservi a une
 * mesure de PM2,5 (voir `data-sources/airQuality.ts`). Ce module le traduit en
 * **epaisseur optique a 550 nm**, qui est la grandeur physique. La conversion
 * est lineaire et ancree sur l'air le plus pur.
 */
import type { SpectralArray, SpectralGrid } from '../spectral/SpectralGrid'
import {
  mieCoefficients,
  mieEfficiencies,
  miePhaseFunction,
  sizeParameter,
  type Complex,
} from './mie'

export interface AerosolModel {
  /** Indice de refraction complexe, partie imaginaire positive pour un absorbant. */
  refractiveIndex: (lambdaNm: number) => Complex
  /** Rayon median de la distribution log-normale, m. */
  geometricMeanRadiusM: number
  /** Largeur de la distribution, sans dimension. Vaut 1 pour une population monodisperse. */
  geometricStdDev: number
  /** Hauteur d'echelle du profil vertical, m. */
  scaleHeightM: number
  /** Epaisseur optique verticale a 550 nm — la grandeur qui fixe la quantite. */
  aod550: number
}

/**
 * Aerosol continental moyen.
 *
 * `n = 1,53` et `k = 0,008` decrivent un melange de particules solubles et de
 * poussieres.
 *
 * ## Le rayon median est cale sur une observable, pas choisi
 *
 * L'**exposant d'Angstrom** est la grandeur que la science atmospherique
 * utilise precisement pour contraindre la taille des aerosols : plus les
 * particules sont grosses, plus la diffusion devient achromatique et plus α
 * baisse. Les reseaux de photometres solaires (AERONET) le publient partout
 * dans le monde, et un aerosol continental y donne 1,2 a 1,5.
 *
 * `r_g = 0,05 µm` a donc ete choisi pour que le modele rende **α = 1,29**. Ce
 * n'est pas un ajustement esthetique : c'est la contrainte d'un parametre non
 * mesure par une grandeur mesuree.
 *
 * Ce qui rend le calage credible, c'est que les deux autres proprietes
 * observables **suivent sans etre touchees** :
 *
 * | Grandeur | Modele | Litterature |
 * | --- | --- | --- |
 * | α (440/870) | 1,29 | 1,2 – 1,5 |
 * | ω₀ (550 nm) | 0,954 | 0,92 – 0,96 |
 * | g (550 nm) | 0,646 | 0,6 – 0,7 |
 *
 * Un seul parametre cale, trois observables d'accord.
 *
 * La hauteur d'echelle de 1,2 km est celle de la couche limite : les aerosols
 * restent bas, contrairement aux molecules d'air (8,4 km) et a l'ozone (25 km).
 * C'est ce qui fait que la brume se voit surtout pres de l'horizon.
 */
export const CONTINENTAL_AEROSOL: Omit<AerosolModel, 'aod550'> = {
  refractiveIndex: () => ({ re: 1.53, im: 0.008 }),
  geometricMeanRadiusM: 0.05e-6,
  geometricStdDev: 2.0,
  scaleHeightM: 1200,
}

/**
 * Epaisseur optique a 550 nm d'un air tres pur, pour un trouble de 1.
 *
 * Cerro Paranal ou un sommet par vent portant tournent autour de 0,03 : c'est
 * le plancher de l'air ambiant, et donc ce que doit valoir le reglage minimal.
 */
export const AOD_PER_TURBIDITY = 0.03

/** Traduit le « trouble » de l'interface en epaisseur optique physique. */
export const aodFromTurbidity = (turbidity: number): number => Math.max(0, turbidity) * AOD_PER_TURBIDITY

/** Nombre d'angles tabules pour la fonction de phase. */
export const PHASE_ANGLE_COUNT = 256

export interface AerosolOptics {
  /** Section efficace de diffusion moyenne par particule, m². */
  scattering: SpectralArray
  /** Section efficace d'absorption moyenne par particule, m². */
  absorption: SpectralArray
  /** Section efficace d'extinction moyenne par particule, m². */
  extinction: SpectralArray
  /** Facteur d'asymetrie par bande. */
  asymmetry: SpectralArray
  /**
   * Fonction de phase tabulee, sr⁻¹ — `phase[bande * PHASE_ANGLE_COUNT + i]`,
   * ou `i` parcourt `cos θ` de −1 a +1.
   */
  phase: Float64Array
  /** Densite numerique de particules au sol, m⁻³, calee sur l'epaisseur optique voulue. */
  groundNumberDensity: number
  /** Hauteur d'echelle du profil, m. */
  scaleHeightM: number
}

/** Poids de la distribution log-normale sur un echantillonnage logarithmique du rayon. */
function sizeDistribution(model: AerosolModel, samples: number): { radii: number[]; weights: number[] } {
  const lnSigma = Math.log(Math.max(1.0001, model.geometricStdDev))
  // Quatre ecarts-types de part et d'autre : au-dela, le poids est negligeable.
  const lnMin = Math.log(model.geometricMeanRadiusM) - 4 * lnSigma
  const lnMax = Math.log(model.geometricMeanRadiusM) + 4 * lnSigma

  const radii: number[] = []
  const weights: number[] = []
  let total = 0

  for (let i = 0; i < samples; i++) {
    const ln = lnMin + ((i + 0.5) * (lnMax - lnMin)) / samples
    const r = Math.exp(ln)
    // En variable logarithmique, la log-normale devient une gaussienne : le
    // facteur 1/r de la densite est absorbe par `d(ln r) = dr/r`.
    const z = (ln - Math.log(model.geometricMeanRadiusM)) / lnSigma
    const w = Math.exp(-0.5 * z * z)
    radii.push(r)
    weights.push(w)
    total += w
  }

  for (let i = 0; i < samples; i++) weights[i] /= total
  return { radii, weights }
}

/**
 * Proprietes optiques d'une population d'aerosols, calculees une fois.
 *
 * `sizeSamples` fixe la finesse de l'integration sur la distribution. Quarante
 * echantillons suffisent : au-dela, seules bougent les oscillations de la
 * fonction de phase, que la moyenne est precisement chargee d'effacer.
 */
export function aerosolOptics(grid: SpectralGrid, model: AerosolModel, sizeSamples = 40): AerosolOptics {
  const { radii, weights } = sizeDistribution(model, sizeSamples)

  const scattering = new Float64Array(grid.count)
  const absorption = new Float64Array(grid.count)
  const extinction = new Float64Array(grid.count)
  const asymmetry = new Float64Array(grid.count)
  const phase = new Float64Array(grid.count * PHASE_ANGLE_COUNT)

  for (let b = 0; b < grid.count; b++) {
    const lambdaNm = grid.lambdaNm[b]
    const m = model.refractiveIndex(lambdaNm)

    let sca = 0
    let abs = 0
    let gWeighted = 0

    for (let s = 0; s < radii.length; s++) {
      const r = radii[s]
      const w = weights[s]
      const geometric = Math.PI * r * r
      const x = sizeParameter(r, lambdaNm)
      const coefficients = mieCoefficients(x, m)
      const q = mieEfficiencies(coefficients)

      const cSca = q.qSca * geometric
      sca += w * cSca
      abs += w * q.qAbs * geometric
      // L'asymetrie se moyenne **ponderee par la diffusion** : une particule qui
      // ne diffuse pas ne doit pas peser sur la direction moyenne.
      gWeighted += w * cSca * q.asymmetry

      // Fonction de phase, ponderee par la section efficace de diffusion pour la
      // meme raison.
      if (q.qSca > 0) {
        for (let i = 0; i < PHASE_ANGLE_COUNT; i++) {
          const mu = -1 + (2 * (i + 0.5)) / PHASE_ANGLE_COUNT
          phase[b * PHASE_ANGLE_COUNT + i] += w * cSca * miePhaseFunction(coefficients, mu, q.qSca)
        }
      }
    }

    scattering[b] = sca
    absorption[b] = abs
    extinction[b] = sca + abs
    asymmetry[b] = sca > 0 ? gWeighted / sca : 0
    if (sca > 0) {
      for (let i = 0; i < PHASE_ANGLE_COUNT; i++) phase[b * PHASE_ANGLE_COUNT + i] /= sca
    }
  }

  // Calage sur l'epaisseur optique voulue a 550 nm.
  //
  // Pour un profil exponentiel, `∫exp(−z/H) dz = H` : la colonne verticale vaut
  // donc `N_sol × C_ext × H`, et la densite au sol s'en deduit directement.
  const reference = referenceExtinction(grid, extinction)
  const groundNumberDensity =
    reference > 0 ? model.aod550 / (reference * model.scaleHeightM) : 0

  return {
    scattering,
    absorption,
    extinction,
    asymmetry,
    phase,
    groundNumberDensity,
    scaleHeightM: model.scaleHeightM,
  }
}

/** Section efficace d'extinction interpolee a 550 nm — l'ancrage de l'epaisseur optique. */
function referenceExtinction(grid: SpectralGrid, extinction: SpectralArray): number {
  if (grid.count === 1) return extinction[0]
  for (let b = 1; b < grid.count; b++) {
    if (grid.lambdaNm[b] >= 550) {
      const t = (550 - grid.lambdaNm[b - 1]) / (grid.lambdaNm[b] - grid.lambdaNm[b - 1])
      return extinction[b - 1] + (extinction[b] - extinction[b - 1]) * Math.max(0, Math.min(1, t))
    }
  }
  return extinction[grid.count - 1]
}

/**
 * Meme population, autre quantite.
 *
 * Les sections efficaces et la fonction de phase ne dependent que de la
 * **nature** des particules — indice, taille — pas de leur nombre. Changer
 * l'epaisseur optique ne demande donc pas de refaire le calcul de Mie, qui
 * coute une centaine de millisecondes : il suffit de recalculer la densite.
 *
 * C'est ce qui permet au reglage de trouble d'etre continu sans peser sur le
 * rendu.
 */
export function withAod(optics: AerosolOptics, aod550: number, referenceAod: number): AerosolOptics {
  if (!(referenceAod > 0)) return optics
  return { ...optics, groundNumberDensity: (optics.groundNumberDensity * aod550) / referenceAod }
}

/** Densite numerique d'aerosols a une altitude, m⁻³. */
export function aerosolNumberDensity(optics: AerosolOptics, altitudeM: number): number {
  return optics.groundNumberDensity * Math.exp(-Math.max(0, altitudeM) / optics.scaleHeightM)
}

/**
 * Fonction de phase interpolee, sr⁻¹.
 *
 * Interpolation lineaire dans la table d'angles. Le pic avant de Mie est etroit
 * mais pas singulier a ces tailles : deux cent cinquante-six angles le
 * resolvent, et la suite de validation le verifie en controlant que
 * l'integrale reste unitaire apres tabulation.
 */
export function aerosolPhase(optics: AerosolOptics, band: number, cosTheta: number): number {
  const mu = Math.max(-1, Math.min(1, cosTheta))
  const f = Math.max(0, Math.min(PHASE_ANGLE_COUNT - 1, ((mu + 1) / 2) * PHASE_ANGLE_COUNT - 0.5))
  const i0 = Math.floor(f)
  const i1 = Math.min(PHASE_ANGLE_COUNT - 1, i0 + 1)
  const t = f - i0
  const base = band * PHASE_ANGLE_COUNT
  return optics.phase[base + i0] * (1 - t) + optics.phase[base + i1] * t
}

/**
 * Exposant d'Angstrom mesure entre deux longueurs d'onde.
 *
 *     α = −ln(τ₁/τ₂) / ln(λ₁/λ₂)
 *
 * Il vaut ~4 pour Rayleigh et tombe vers 1 a 1,5 pour un aerosol continental —
 * c'est la mesure la plus directe du fait que la diffusion de Mie est **bien
 * moins selective en longueur d'onde**, donc que la brume blanchit au lieu de
 * bleuir.
 */
export function angstromExponent(grid: SpectralGrid, optics: AerosolOptics, lambda1 = 440, lambda2 = 870): number {
  const at = (target: number) => {
    let best = 0
    let bestGap = Infinity
    for (let b = 0; b < grid.count; b++) {
      const gap = Math.abs(grid.lambdaNm[b] - target)
      if (gap < bestGap) {
        bestGap = gap
        best = b
      }
    }
    return { lambda: grid.lambdaNm[best], value: optics.extinction[best] }
  }
  const a = at(lambda1)
  const b = at(lambda2)
  return -Math.log(a.value / b.value) / Math.log(a.lambda / b.lambda)
}
