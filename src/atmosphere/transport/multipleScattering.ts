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
  /** Radiance isotrope Ψ_ms, tous ordres cumules — `data[(y * width + x) * bands + b]`. */
  readonly data: Float64Array
  /**
   * Ordre courant de la serie, entree de la passe suivante.
   *
   * L'iteration est de type Jacobi et non Gauss-Seidel : la table se remplit par
   * tranches etalees sur plusieurs images, et lire ce qu'on est en train
   * d'ecrire rendrait le resultat dependant de l'ordre de parcours.
   */
  readonly previous: Float64Array
  /** Ordre en cours de calcul, publie par `commitMultipleScatteringPass`. */
  readonly next: Float64Array
  /**
   * Fraction qui repart pour un tour de plus, par cellule.
   *
   * C'est l'ancien `f_ms`, conserve pour **fermer la queue** de la serie apres
   * les ordres explicites — voir `MS_EXPLICIT_ORDERS`.
   */
  readonly transfer: Float64Array
  /**
   * Passe en cours. Zero calcule la source solaire, les suivantes la
   * transportent.
   */
  pass: number
  /** Ordres transportes explicitement avant la fermeture locale de la queue. */
  readonly explicitOrders: number
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
  /** Ordres transportes explicitement — voir `MS_EXPLICIT_ORDERS`. */
  explicitOrders?: number
}

/** Altitude correspondant a une coordonnee verticale de [0,1]. */
export const msAltitude = (v: number): number => v * v * ATMOSPHERE_TOP_M

/**
 * Cosinus zenithal solaire porte par une coordonnee horizontale de [0,1].
 *
 * ## ⚠️ Elle etait lineaire, et c'etait le mauvais endroit pour l'etre
 *
 * `mu = 2u − 1` repartit les colonnes uniformement en cosinus. Avec
 * trente-deux colonnes, deux voisines sont separees de 0,065 en cosinus — soit
 * **3,7 degres d'angle zenithal au terminateur**, la ou toute la structure du
 * crepuscule se joue et ou la luminance change d'un facteur deux par degre.
 *
 * La table y etait donc plus grossiere que le phenomene, et la decroissance
 * crepusculaire mesuree s'en ressentait : erratique, oscillant entre x1,65 et
 * x9,5 par degre la ou une extinction physique est lisse.
 *
 * La loi est desormais **quadratique de part et d'autre du terminateur**, comme
 * la coordonnee de hauteur de la table de ciel et pour la meme raison : c'est la
 * que la grandeur varie le plus vite. La premiere colonne hors terminateur tombe
 * a 0,06 degre au lieu de 3,7.
 */
export const msCosSun = (u: number): number => {
  const t = 2 * Math.max(0, Math.min(1, u)) - 1
  return t * Math.abs(t)
}

/** Coordonnee horizontale portant un cosinus zenithal solaire donne. */
export const msCosSunCoord = (cosSunZenith: number): number => {
  const mu = Math.max(-1, Math.min(1, cosSunZenith))
  return (Math.sign(mu) * Math.sqrt(Math.abs(mu)) + 1) / 2
}

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
 * ## ⚠️ La resolution en angle solaire a du doubler
 *
 * Elle etait de 32 x 32, justifiee par une mesure d'eclairement **de jour** :
 * 3,115 klx a 16x16 contre 3,125 a 32x32 et 48x48, la table etant plate a 32.
 * C'etait vrai, et sans rapport avec le probleme.
 *
 * Au crepuscule, toute la structure se joue dans la bande ou le point voit
 * encore le Soleil que l'observateur ne voit plus — quelques dixiemes de cosinus
 * autour du terminateur. La table y etait plus grossiere que le phenomene, et la
 * decroissance mesuree en devenait **erratique** : x3,83 puis x1,65 puis x3,71
 * puis x9,51 par degre, la ou une extinction physique est lisse.
 *
 * Mesure de convergence, rapport a la courbe d'eclairement du projet :
 *
 * | grille | chute par degre | cout |
 * | --- | --- | --- |
 * | 32 x 32 | x1,54 a x3,59 — **erratique** | 1,3 s |
 * | 48 x 48 | x2,17 a x3,45 | 1,6 s |
 * | **64 x 32** | **x2,56 a x3,53 — lisse** | 1,6 s |
 * | 64 x 48 | identique a 64 x 32 | 2,3 s |
 * | 96 x 48 | 13 % plus sombre | 5,4 s |
 *
 * ⚠️ **C'est la largeur qui compte, pas la hauteur.** 64 x 32 et 64 x 48 rendent
 * les memes chiffres a la troisieme decimale, tandis que 48 x 48 laisse encore
 * un x2,17 au milieu d'une serie a x3. Ce qui manquait n'etait pas la resolution
 * en altitude mais celle en **angle solaire**, autour du terminateur — ce que la
 * loi quadratique et la largeur doublee corrigent ensemble.
 *
 * La largeur n'est convergee qu'a 13 % pres. On s'arrete la : la table se
 * reconstruit sur le fil principal, et 5,4 secondes contre 1,6 pour treize pour
 * cent ne se justifient pas tant que le modele lui-meme accuse un ecart plus
 * grand.
 */
export const MS_LUT_WIDTH = 64
export const MS_LUT_HEIGHT = 32

export function createMultipleScatteringLut(
  grid: SpectralGrid,
  options: MultipleScatteringOptions = {},
): MultipleScatteringLut {
  const {
    width = MS_LUT_WIDTH,
    height = MS_LUT_HEIGHT,
    explicitOrders = MS_EXPLICIT_ORDERS,
  } = options
  const size = width * height * grid.count
  return {
    width,
    height,
    bands: grid.count,
    data: new Float64Array(size),
    previous: new Float64Array(size),
    next: new Float64Array(size),
    transfer: new Float64Array(size),
    pass: 0,
    explicitOrders,
    maxTransferFactor: 0,
  }
}

/**
 * Ordres de diffusion calcules **explicitement**, au-dela du premier.
 *
 * ## ⚠️ Pourquoi la fermeture locale ne suffisait pas
 *
 * La serie etait close d'un coup, cellule par cellule : `Ψ = L_f / (1 − f_ms)`.
 * C'est exact **si le champ est uniforme** — la somme geometrique suppose que ce
 * qui repart pour un tour de plus retombe au meme endroit du plan
 * (altitude, angle solaire).
 *
 * De jour c'est acceptable : l'atmosphere est eclairee partout et le champ varie
 * lentement. Au crepuscule profond c'est faux de bout en bout. La diffusion
 * simple y est **rigoureusement nulle** — toute l'atmosphere accessible est dans
 * l'ombre de la Terre — et la lumiere qui eclaire un point d'ombre a vingt
 * kilometres vient d'air ensoleille situe a des centaines de kilometres, donc a
 * une tout autre altitude et un tout autre angle solaire. Une fermeture locale
 * ne peut pas transporter cela.
 *
 * Mesure du defaut : l'eclairement du ciel tombait a x0,26 de la courbe
 * classique a −10° de hauteur solaire, x0,15 a −14°, x0,11 a −16°, avec une
 * decroissance **erratique** — x3,83 puis x1,65 puis x3,71 puis x9,51 par degre
 * la ou une extinction physique est lisse.
 *
 * ## Ce qui remplace la fermeture
 *
 * Une iteration qui transporte reellement :
 *
 *     Ψ⁰ = L_f
 *     Ψ^{n+1}(x) = ⟨ ∫ T(x,x') σ_s(x') Ψ^n(x') dt ⟩ sur 4π
 *     Ψ_ms = Σ Ψ^n
 *
 * La difference tient dans un seul mot : `Ψ^n(x')` est lu **au point
 * d'echantillonnage**, avec sa propre altitude et son propre angle solaire, et
 * non au point qu'on calcule. Si le champ etait uniforme, on retrouverait
 * exactement `f_ms · Ψ` et donc la serie geometrique : le modele precedent en
 * est le cas particulier.
 *
 * ## Pourquoi quatre, et pas la convergence complete
 *
 * Le facteur de transfert plafonne vers 0,7 : atteindre le pour cent
 * demanderait treize ordres. Mais la non-localite ne compte que pour les
 * **premiers** transferts — ceux qui font entrer la lumiere de l'air ensoleille
 * vers l'ombre. Au-dela, le champ est diffus et la fermeture locale redevient
 * une bonne approximation.
 *
 * Mesure de ce que chaque ordre apporte, en rapport a la courbe d'eclairement du
 * projet a −10° de hauteur solaire :
 *
 * | ordres explicites | rapport | cout |
 * | --- | --- | --- |
 * | 1 | x0,62 | 1,8 s |
 * | **2** | **x0,64** | **2,4 s** |
 * | 3 | x0,65 | 2,7 s |
 * | 4 | x0,65 | 3,3 s |
 * | 6 | x0,65 | 4,5 s |
 *
 * **Deux suffisent.** La non-localite ne compte que pour les tout premiers
 * transferts — ceux qui font entrer la lumiere de l'air ensoleille vers l'ombre.
 * Au-dela, le champ est diffus et la fermeture locale redevient une bonne
 * approximation : le troisieme ordre ne deplace plus que 1,5 %.
 *
 * Deux ordres explicites, donc, puis la queue fermee par `f/(1−f)` sur le
 * dernier ordre calcule.
 */
export const MS_EXPLICIT_ORDERS = 2

/** Nombre total de passes d'une table, la premiere calculant la source solaire. */
export const multipleScatteringPasses = (lut: MultipleScatteringLut): number =>
  lut.explicitOrders + 1

/** Lecture bilineaire d'un tampon quelconque de la table. */
function sampleBuffer(
  lut: MultipleScatteringLut,
  buffer: Float64Array,
  altitudeM: number,
  cosSunZenith: number,
  target: Float64Array,
): Float64Array {
  const v = Math.sqrt(Math.max(0, Math.min(1, altitudeM / ATMOSPHERE_TOP_M)))
  const u = msCosSunCoord(cosSunZenith)
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
      (buffer[i00 + k] * (1 - tx) + buffer[i10 + k] * tx) * (1 - ty) +
      (buffer[i01 + k] * (1 - tx) + buffer[i11 + k] * tx) * ty
  }
  return target
}

/**
 * Publie l'ordre qui vient d'etre calcule et passe au suivant.
 *
 * A appeler quand toutes les entrees d'une passe ont ete remplies. La derniere
 * passe ferme en plus la queue de la serie.
 */
export function commitMultipleScatteringPass(lut: MultipleScatteringLut): void {
  const { data, previous, next, transfer } = lut
  const last = lut.pass >= lut.explicitOrders
  for (let i = 0; i < data.length; i++) {
    if (lut.pass === 0) {
      // La passe zero **est** le premier ordre : elle initialise plutot que
      // d'ajouter.
      data[i] = next[i]
    } else {
      data[i] += next[i]
    }
    previous[i] = next[i]
    next[i] = 0
  }
  if (last) {
    // Queue de la serie, fermee localement — voir `MS_EXPLICIT_ORDERS`.
    for (let i = 0; i < data.length; i++) {
      const f = Math.min(0.98, Math.max(0, transfer[i]))
      data[i] += previous[i] * (f / (1 - f))
    }
  }
  lut.pass++
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

  const { width, height, bands } = lut
  const sigmaR = rayleighOn(grid)
  const sigmaO3 = ozoneCrossSectionOn(grid)
  const incident = solarIrradianceOn(grid)
  const rays = sphereDirections(directions)

  // Tampons reutilises : une allocation par entree couterait plus cher que le
  // calcul lui-meme sur une table de mille entrees.
  const lf = new Float64Array(bands)
  const fms = new Float64Array(bands)
  const tau = new Float64Array(bands)
  // Ordre precedent, lu au point d'echantillonnage — c'est lui qui porte la
  // non-localite.
  const psi = new Float64Array(bands)
  // Accumulateur de l'ordre en cours, par entree.
  const next = new Float64Array(bands)

  // Passe zero : la source solaire. Passes suivantes : son transport.
  const sourcePass = lut.pass === 0

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
      next.fill(0)

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
          const secondary =
            sourcePass && columnLut ? sampleColumnLut(columnLut, h, cosSunHere) : null
          const sunlit = secondary !== null && Number.isFinite(secondary.air)
          if (!sourcePass) sampleBuffer(lut, lut.previous, h, cosSunHere, psi)

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

            // ⚠️ **Le mot qui change tout est `psi[k]`.** Il est lu au point
            // d'echantillonnage, avec son altitude et son angle solaire, et non
            // au point qu'on calcule. C'est la seule difference avec la
            // fermeture locale d'avant, et c'est toute la non-localite du
            // crepuscule.
            if (!sourcePass) next[k] += contribution * psi[k]

            if (sourcePass && sunlit && secondary) {
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
        if (hitsGround && groundAlbedo > 0 && !sourcePass) {
          // Sous un champ **isotrope** de radiance Ψ, l'eclairement d'une
          // surface vaut `π·Ψ` et une surface lambertienne en renvoie
          // `albedo·π·Ψ/π = albedo·Ψ`. Le sol participe donc aussi aux ordres
          // superieurs, et l'oublier sous-estimerait le ciel au-dessus d'une
          // surface claire.
          sampleBuffer(lut, lut.previous, 0, muSun, psi)
          for (let k = 0; k < bands; k++) {
            next[k] += Math.exp(-tau[k]) * groundAlbedo * psi[k]
          }
        }

        if (hitsGround && groundAlbedo > 0 && sourcePass && columnLut) {
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
        if (sourcePass) {
          const transfer = fms[k] / rays.length
          lut.maxTransferFactor = Math.max(lut.maxTransferFactor, transfer)
          lut.transfer[base + k] = transfer
          lut.next[base + k] = lf[k] / rays.length
        } else {
          lut.next[base + k] = next[k] / rays.length
        }
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
  for (let pass = 0; pass < multipleScatteringPasses(lut); pass++) {
    fillMultipleScatteringEntries(lut, grid, 0, lut.width * lut.height, options)
    commitMultipleScatteringPass(lut)
  }
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
  const u = msCosSunCoord(cosSunZenith)

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
