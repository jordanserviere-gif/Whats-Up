/**
 * Table de colonnes atmospheriques — la premiere LUT du moteur.
 *
 * ## Ce qu'elle remplace
 *
 * Le solveur de diffusion simple (phase 5) integre, pour **chaque pas** du
 * rayon primaire, un second rayon vers le Soleil. C'est ce rayon secondaire qui
 * coute : cent vingt-huit evaluations de profil par pas, soit six mille par
 * direction de visee. Cette table le remplace par un acces interpole.
 *
 * ## Un canal par espece
 *
 * Bruneton stocke une transmittance a trois composantes. Ce n'est pas ce qui
 * est fait ici, et la raison merite d'etre notee :
 *
 *     T(λ) = exp[−σ_air(λ)·C_air − σ_O₃(λ)·C_ozone]
 *
 * Les **colonnes** ne dependent pas de la longueur d'onde : elles ne comptent
 * que des molecules. Elles se factorisent donc hors du spectre, et les
 * exponentielles se font par bande a l'usage. Le nombre de bandes reste ainsi
 * libre, au lieu d'etre fige a trois par le format de la texture.
 *
 * Il faut en revanche **une colonne par espece**. La table n'en portait qu'une
 * tant que Rayleigh etait seul ; l'ozone a un autre profil vertical, donc un
 * autre rapport entre colonne oblique et colonne verticale.
 *
 * Mesure a visee rasante depuis le sol : l'air s'allonge d'un facteur 24,
 * l'ozone de 11 seulement. La geometrie l'explique — un rayon rasant traverse
 * l'air bas tangentiellement, mais quand il atteint les 25 km ou vit l'ozone il
 * a deja grimpe, et son angle zenithal local n'est plus que 85°. C'est
 * l'inverse de ce que l'intuition suggere, et c'est exactement pourquoi une
 * seule colonne ne peut plus servir les deux especes.
 *
 * > Les aerosols (phase 6) ajouteront un troisieme canal, dans le meme format.
 *
 * ## Parametrisation
 *
 * Celle de Bruneton (2008, revisee 2017), concue pour repartir les texels selon
 * la **geometrie** plutot que selon les angles. Un maillage uniforme en cosinus
 * zenithal gaspillerait ses lignes au zenith, ou la colonne est plate, et
 * manquerait l'horizon, ou elle varie de plusieurs ordres de grandeur en une
 * fraction de degre.
 *
 *     ρ = √(r² − R²)              distance a l'horizon depuis le rayon r
 *     H = √(r_top² − R²)          la meme, depuis le sol
 *     d = −rµ + √(r²µ² + r_top² − r²)     distance a la sortie de l'atmosphere
 *
 *     u = (d − d_min) / (d_max − d_min)        d_min = r_top − r, d_max = ρ + H
 *     v = ρ / H
 *
 * `u = 0` est la visee zenithale, `u = 1` la visee rasante. Toute la finesse
 * est donc concentree la ou elle sert.
 *
 * Au **sommet exact** de l'atmosphere, la parametrisation degenere : toute
 * visee montante y donne `d = 0` — le rayon est deja dehors — et tous les `µ`
 * positifs se projettent sur `u = 0`. La direction n'y est donc pas
 * recuperable, ce qui est sans consequence : il n'y a rien a traverser, et la
 * colonne vaut zero pour chacune d'elles.
 *
 * ## Ce qu'elle ne couvre pas
 *
 * Les rayons qui **rencontrent le sol**. Leur colonne est infinie et la table
 * n'en dit rien : le test d'intersection reste a la charge de l'appelant, comme
 * dans le solveur de reference. C'est ce test qui produit l'ombre de la Terre,
 * et il serait faux de le noyer dans une interpolation.
 *
 * Reference : Bruneton, E. & Neyret, F. (2008), *Precomputed Atmospheric
 * Scattering*, Computer Graphics Forum 27(4) ; parametrisation revisee dans
 * Bruneton (2017), *A Qualitative and Quantitative Evaluation of 8 Clear Sky
 * Models*.
 */
import { EARTH_MEAN_RADIUS_M } from '../core/units'
import { ATMOSPHERE_TOP_M, columnsToSpace, type SpeciesColumns } from '../transport/slantPath'
import { DEFAULT_OZONE_COLUMN_DU } from '../absorption/ozone'

const RADIUS = EARTH_MEAN_RADIUS_M
const TOP_RADIUS = RADIUS + ATMOSPHERE_TOP_M
/** Distance du sol a l'horizon du sommet de l'atmosphere. */
const H = Math.sqrt(TOP_RADIUS * TOP_RADIUS - RADIUS * RADIUS)

export interface ColumnLut {
  readonly width: number
  readonly height: number
  /** Colonne moleculaire de l'air, m⁻². Rangee par `y * width + x`. */
  readonly column: Float32Array
  /** Colonne d'ozone, m⁻². Meme rangement. */
  readonly ozone: Float32Array
  /** Colonne totale d'ozone pour laquelle la table a ete calculee, unites Dobson. */
  readonly ozoneColumnDobsonUnits: number
}

/**
 * Ramene une coordonnee de [0,1] au centre des texels.
 *
 * Sans cette correction, les bornes du domaine tombent au **bord** du premier
 * et du dernier texel, et l'interpolation bilineaire y extrapole. L'erreur se
 * concentre exactement la ou la table doit etre juste : a l'horizon.
 */
export const toTexelRange = (x: number, size: number): number => 0.5 / size + x * (1 - 1 / size)

/** Operation inverse : d'une coordonnee de texture vers [0,1]. */
export const fromTexelRange = (u: number, size: number): number => (u - 0.5 / size) / (1 - 1 / size)

/** Rayon r et cosinus zenithal µ vers coordonnees de texture. */
export function columnLutUv(altitudeM: number, cosZenith: number, width: number, height: number): [number, number] {
  const r = RADIUS + altitudeM
  const mu = Math.max(-1, Math.min(1, cosZenith))

  const rho = Math.sqrt(Math.max(0, r * r - RADIUS * RADIUS))
  const d = -r * mu + Math.sqrt(Math.max(0, r * r * mu * mu + TOP_RADIUS * TOP_RADIUS - r * r))
  const dMin = TOP_RADIUS - r
  const dMax = rho + H

  const x = dMax > dMin ? (d - dMin) / (dMax - dMin) : 0
  const y = H > 0 ? rho / H : 0

  return [toTexelRange(Math.max(0, Math.min(1, x)), width), toTexelRange(Math.max(0, Math.min(1, y)), height)]
}

/** Coordonnees de texture vers altitude et cosinus zenithal. */
export function columnLutParams(u: number, v: number, width: number, height: number): {
  altitudeM: number
  cosZenith: number
} {
  const x = Math.max(0, Math.min(1, fromTexelRange(u, width)))
  const y = Math.max(0, Math.min(1, fromTexelRange(v, height)))

  const rho = H * y
  const r = Math.sqrt(rho * rho + RADIUS * RADIUS)
  const dMin = TOP_RADIUS - r
  const dMax = rho + H
  const d = dMin + x * (dMax - dMin)

  // Inversion de d = −rµ + √(r²µ² + r_top² − r²), soit d² + 2drµ = H² − ρ².
  const mu = d === 0 ? 1 : Math.max(-1, Math.min(1, (H * H - rho * rho - d * d) / (2 * r * d)))

  return { altitudeM: r - RADIUS, cosZenith: mu }
}

export interface ColumnLutOptions {
  width?: number
  height?: number
  /** Colonne totale d'ozone, unites Dobson. */
  ozoneColumnDobsonUnits?: number
  /**
   * Pas d'integration par entree.
   *
   * Cent vingt-huit suffisent : **l'erreur est dominee par l'interpolation
   * bilineaire, pas par l'integration**. Mesure sur une grille 256x64, passer
   * de 128 a 512 pas laisse l'erreur maximale sur la transmittance a 0,086 % —
   * inchangee — pour trois fois le temps de construction. Doubler la resolution
   * de la table, en revanche, la divise par trois.
   */
  steps?: number
}

/**
 * Construit la table.
 *
 * **Elle est entierement statique** tant que le profil de densite ne change
 * pas : elle ne depend ni de l'heure, ni du lieu, ni de la position du Soleil.
 * C'est ce qui la rend si rentable — un calcul unique au demarrage contre une
 * integration a chaque pas de chaque rayon de chaque image.
 *
 * Elle deviendra dependante de l'etat le jour ou `AtmosphereState` fera varier
 * le profil (phases 13 et 14), et il faudra alors la reconstruire quand cet
 * etat change — pas a chaque image.
 */
export function buildColumnLut(options: ColumnLutOptions = {}): ColumnLut {
  const { width = 256, height = 64, steps = 128, ozoneColumnDobsonUnits = DEFAULT_OZONE_COLUMN_DU } = options
  const column = new Float32Array(width * height)
  const ozone = new Float32Array(width * height)

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width
      const { altitudeM, cosZenith } = columnLutParams(u, v, width, height)
      const columns = columnsToSpace(altitudeM, cosZenith, steps, ozoneColumnDobsonUnits)
      column[y * width + x] = columns.air
      ozone[y * width + x] = columns.ozone
    }
  }

  return { width, height, column, ozone, ozoneColumnDobsonUnits }
}

/**
 * Lit la table par interpolation bilineaire, dans les memes conventions qu'un
 * echantillonneur GPU en mode `LinearFilter` et `ClampToEdgeWrapping`.
 *
 * Rend `Infinity` si le rayon rencontre la Terre : le test est fait ici, pas
 * dans la table. Voir l'en-tete du module.
 */
export function sampleColumnLut(lut: ColumnLut, altitudeM: number, cosZenith: number): SpeciesColumns {
  const r = RADIUS + altitudeM
  const mu = Math.max(-1, Math.min(1, cosZenith))
  if (mu < 0 && r * Math.sqrt(1 - mu * mu) < RADIUS) {
    return { air: Number.POSITIVE_INFINITY, ozone: Number.POSITIVE_INFINITY }
  }

  const [u, v] = columnLutUv(altitudeM, mu, lut.width, lut.height)

  const fx = Math.max(0, Math.min(lut.width - 1, u * lut.width - 0.5))
  const fy = Math.max(0, Math.min(lut.height - 1, v * lut.height - 0.5))
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(lut.width - 1, x0 + 1)
  const y1 = Math.min(lut.height - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0

  const bilinear = (source: Float32Array) =>
    (source[y0 * lut.width + x0] * (1 - tx) + source[y0 * lut.width + x1] * tx) * (1 - ty) +
    (source[y1 * lut.width + x0] * (1 - tx) + source[y1 * lut.width + x1] * tx) * ty

  return { air: bilinear(lut.column), ozone: bilinear(lut.ozone) }
}

/**
 * Fonctions GLSL d'acces a la table.
 *
 * Volontairement identiques a leurs equivalents TypeScript ci-dessus. La suite
 * de validation compare les deux chemins sur un echantillonnage fin : c'est ce
 * qui transforme cette duplication en invariant teste plutot qu'en dette.
 */
export const COLUMN_LUT_GLSL = /* glsl */ `
  /**
   * Colonne moleculaire d'un point vers l'espace, m⁻².
   *
   * \`uColumnLut\` porte la table, \`uColumnLutSize\` ses dimensions. Le test
   * d'intersection avec le sol reste a la charge de l'appelant : c'est lui qui
   * produit l'ombre de la Terre, et il ne doit pas etre interpole.
   */
  float columnToSpaceLut(sampler2D lut, vec2 lutSize, float altitude, float mu, float planetRadius, float topRadius) {
    float r = planetRadius + altitude;
    float horizonDistance = sqrt(max(0.0, topRadius * topRadius - planetRadius * planetRadius));
    float rho = sqrt(max(0.0, r * r - planetRadius * planetRadius));

    float d = -r * mu + sqrt(max(0.0, r * r * mu * mu + topRadius * topRadius - r * r));
    float dMin = topRadius - r;
    float dMax = rho + horizonDistance;

    float x = dMax > dMin ? clamp((d - dMin) / (dMax - dMin), 0.0, 1.0) : 0.0;
    float y = horizonDistance > 0.0 ? clamp(rho / horizonDistance, 0.0, 1.0) : 0.0;

    // Recentrage sur les texels : sans lui, l'interpolation extrapole aux bords
    // du domaine, c'est-a-dire exactement a l'horizon.
    vec2 uv = vec2(0.5 / lutSize.x + x * (1.0 - 1.0 / lutSize.x),
                   0.5 / lutSize.y + y * (1.0 - 1.0 / lutSize.y));
    return texture2D(lut, uv).r;
  }

  /** Le rayon rencontre-t-il la planete ? */
  bool hitsPlanet(float altitude, float mu, float planetRadius) {
    float r = planetRadius + altitude;
    return mu < 0.0 && r * sqrt(max(0.0, 1.0 - mu * mu)) < planetRadius;
  }
`
