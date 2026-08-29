/**
 * Perspective atmospherique — ce que l'air fait a un objet **place a une
 * distance finie**.
 *
 * ## Ce que cette table remplace
 *
 * Depuis que le ciel est calcule par le solveur physique, les astres et les
 * avions etaient restes sur l'ancien noyau analytique `hazeColorAlong` : deux
 * coefficients de Rayleigh choisis a la main, une phase de Henyey-Greenstein, un
 * facteur d'exposition de calibrage. **Le ciel et le voile des objets suivaient
 * donc deux modeles differents**, et un astre bas ne se fondait plus dans le
 * ciel qui l'entourait.
 *
 * ## La table est le ciel, prolonge vers l'observateur
 *
 * Sa **derniere tranche est la table de ciel** : meme grille angulaire, meme
 * parametrisation, meme marche. Un astre est a l'infini, il tombe donc pile sur
 * cette tranche — et lit exactement ce que le fond de ciel lit a cote de lui.
 * Le raccord n'est pas ajuste, il est structurel.
 *
 * Le fond de ciel n'a d'ailleurs plus sa propre table : il consomme cette
 * tranche. Une seule marche alimente les deux.
 *
 * ## Les trois axes
 *
 * | Axe | Domaine | Parametrisation |
 * | --- | --- | --- |
 * | `u` | azimut relatif au Soleil, 0 a 180° | lineaire, repliee par symetrie |
 * | `v` | hauteur de visee, 0 a 90° | `v = √(h/90)`, resserree a l'horizon |
 * | `w` | distance | `t = trajet_total · w²`, donc `w = 1` = sortie |
 *
 * La normalisation de `w` par le trajet propre a chaque direction est ce qui
 * fait tomber l'infini exactement sur le dernier texel, quelle que soit la
 * visee. Le carre resserre les tranches pres de l'observateur, la ou vit la
 * densite — c'est le meme espacement que la marche elle-meme.
 *
 * Le trajet total a une forme close, que le nuanceur retrouve seul a partir des
 * deux rayons de la geometrie spherique.
 *
 * ## ⚠️ La transmittance spectrale reduite a trois nombres
 *
 * Le transport calcule `T(λ)` sur seize bandes ; le nuanceur ne peut en porter
 * que trois. Or reduire une transmittance a trois nombres n'est **exact que
 * pour un spectre d'objet donne** : `∫L(λ)T(λ)` ne se factorise pas en
 * `(∫L)(∫T)`.
 *
 * Le spectre de reference retenu est **celui du Soleil**, parce que les objets
 * qui traversent cette table — Lune, planetes, avions — sont eclaires par lui :
 *
 *     T_rgb = sRGB_lin( T(λ)·E_sol(λ) ) / sRGB_lin( E_sol(λ) )
 *
 * C'est exact pour un objet de spectre solaire et approche pour les autres.
 * Une etoile tres bleue ou tres rouge en souffrirait — mais les etoiles ne
 * passent pas par ici : elles ont leur propre extinction en magnitudes, dans
 * `astro/photometry.ts`, ou le spectre est traite par type spectral.
 *
 * **C'est une limite de la chaine RGB, pas du transport.** La lever demanderait
 * de porter le spectre jusqu'au nuanceur.
 */
import { aerialPerspective, type SingleScatteringOptions } from '../transport/singleScattering'
import type { SpectralGrid } from '../spectral/SpectralGrid'
import { spectralToLinearSrgb, type LinearRgb } from '../spectral/SpectralSensor'
import { solarIrradianceOn } from '../spectral/SolarSpectrum'
import { skyViewAltitudeDeg } from './skyViewLut'

/** Dimensions de la table. */
export const AERIAL_LUT_WIDTH = 64
export const AERIAL_LUT_HEIGHT = 32
/**
 * Tranches en distance.
 *
 * Seize : la mesure donne un ecart d'un niveau sur 255 contre une resolution
 * directe a distance finie. La premiere tranche est l'observateur lui-meme —
 * transmittance unite, rien de diffuse — et sert d'ancrage exact a `d = 0`.
 */
export const AERIAL_LUT_DEPTH = 16

export interface AerialLut {
  readonly width: number
  readonly height: number
  readonly depth: number
  /** Radiance diffusee cumulee, sRGB lineaire, `RGBA` — l'alpha est inutilise. */
  readonly scattered: Float32Array
  /** Transmittance du rayon primaire, `RGBA` — l'alpha est inutilise. */
  readonly transmittance: Float32Array
  /**
   * Luminance moyenne du ciel, ponderee par le cosinus zenithal, cd/m².
   *
   * C'est `E_diffus/π` : la luminance a laquelle un observateur qui regarde le
   * ciel s'adapte. Elle est calculee **pendant** le remplissage de la tranche
   * lointaine, a partir des valeurs qu'on y ecrit deja — elle ne coute donc
   * rien, et elle est par construction celle du ciel reellement affiche.
   */
  meanSkyLuminanceCdPerM2: number
}

export interface AerialLutOptions extends SingleScatteringOptions {
  width?: number
  height?: number
  depth?: number
}

/** Alloue une table vide, a remplir par tranches de lignes. */
export function createAerialLut(options: AerialLutOptions = {}): AerialLut {
  const {
    width = AERIAL_LUT_WIDTH,
    height = AERIAL_LUT_HEIGHT,
    depth = AERIAL_LUT_DEPTH,
  } = options
  const size = width * height * depth * 4
  return {
    width,
    height,
    depth,
    scattered: new Float32Array(size),
    transmittance: new Float32Array(size),
    meanSkyLuminanceCdPerM2: 0,
  }
}

/**
 * Luminance moyenne du ciel portee par la tranche lointaine, cd/m².
 *
 * **Moyenne en angle solide, non ponderee par le cosinus.** La distinction n'est
 * pas academique :
 *
 * - `∫L·cos z dω` est l'**eclairement** sur une surface horizontale. Le zenith y
 *   pese le plus, l'horizon presque rien.
 * - `∫L dω` est la luminance moyenne **de ce qu'on voit**, et c'est a elle que
 *   l'oeil s'adapte.
 *
 * Au crepuscule les deux different enormement : le zenith est sombre, l'horizon
 * brille. Employer l'eclairement fait alors s'adapter l'oeil au zenith, et la
 * bande claire de l'horizon **sature** — le banc rendait un `254,246,194` blanc
 * au crepuscule nautique, ce qu'aucun observateur ne voit.
 *
 * La parametrisation etant `hauteur = (π/2)v²`, la mesure d'angle solide vaut
 * `dµ = cos(hauteur)·π·v·dv`.
 */
export function measureMeanSkyLuminance(lut: AerialLut): number {
  const { width, height, depth, scattered } = lut
  let total = 0
  let weightTotal = 0
  for (let y = 0; y < height; y++) {
    const v = height > 1 ? y / (height - 1) : 0
    const altitudeDeg = skyViewAltitudeDeg(v)
    const altitudeRad = (altitudeDeg * Math.PI) / 180
    // Jacobien de la parametrisation, et rien d'autre : c'est une moyenne en
    // angle solide. Le `cos(hauteur)` n'est pas un detail — l'oublier
    // surpondere le zenith, ou le parametrage s'etire.
    const weight = Math.cos(altitudeRad) * Math.max(1e-6, v)
    for (let x = 0; x < width; x++) {
      const i = (((depth - 1) * height + y) * width + x) * 4
      // La ligne Y de la matrice sRGB : la luminance vaut `683 × Y`.
      const y709 = 0.2126 * scattered[i] + 0.7152 * scattered[i + 1] + 0.0722 * scattered[i + 2]
      total += Math.max(0, y709) * weight
      weightTotal += weight
    }
  }
  return weightTotal > 0 ? (683 * total) / weightTotal : 0
}

const solarRgbCache = new Map<string, LinearRgb>()
function solarLinearSrgb(grid: SpectralGrid): LinearRgb {
  const key = `${grid.count}:${grid.edgesNm[0]}:${grid.edgesNm[grid.count]}`
  const cached = solarRgbCache.get(key)
  if (cached) return cached
  const rgb = spectralToLinearSrgb(grid, solarIrradianceOn(grid))
  solarRgbCache.set(key, rgb)
  return rgb
}

/**
 * Remplit une **tranche de lignes** — une ligne est une hauteur de visee, et
 * porte d'un coup toutes ses distances.
 *
 * Le decoupage se fait a la ligne et non a l'entree, contrairement a la table de
 * diffusion multiple : ici une entree est une **direction**, et les seize
 * distances sortent de la meme marche. Les separer reviendrait a refaire seize
 * fois le meme travail.
 */
export function fillAerialRows(
  lut: AerialLut,
  grid: SpectralGrid,
  sunAltitudeDeg: number,
  fromRow: number,
  toRow: number,
  options: SingleScatteringOptions = {},
): void {
  const { width, height, depth, scattered, transmittance } = lut
  const solar = solarLinearSrgb(grid)
  const bands = grid.count
  const buffer = new Float64Array(bands)
  // Le spectre solaire sert de reference a la reduction de la transmittance :
  // hors de la boucle, il coute une lecture ; dedans, il en couterait un demi
  // million.
  const solarSpectrum = solarIrradianceOn(grid)

  // Le nombre de pas par tranche est choisi pour que la marche complete garde la
  // finesse validee du ciel : 15 intervalles x 4 pas = 60, contre 48 pour la
  // table de ciel d'origine. Plus fin, jamais moins.
  const stepsPerSlice = 4

  for (let y = Math.max(0, fromRow); y < Math.min(height, toRow); y++) {
    const altitudeDeg = skyViewAltitudeDeg(height > 1 ? y / (height - 1) : 0)
    for (let x = 0; x < width; x++) {
      const azimuthDeg = 180 * (width > 1 ? x / (width - 1) : 0)
      const aerial = aerialPerspective(grid, altitudeDeg, azimuthDeg, sunAltitudeDeg, {
        ...options,
        slices: depth,
        stepsPerSlice,
      })

      // Transmittance de la tranche precedente, pour imposer la decroissance —
      // voir le commentaire dans la boucle.
      let prevR = 1
      let prevG = 1
      let prevB = 1

      for (let z = 0; z < depth; z++) {
        // Ordre attendu par une texture 3D : x le plus rapide, puis y, puis z.
        const i = ((z * height + y) * width + x) * 4
        const base = z * bands

        for (let b = 0; b < bands; b++) buffer[b] = aerial.scattered[base + b]
        const rgb = spectralToLinearSrgb(grid, buffer)
        scattered[i] = rgb[0]
        scattered[i + 1] = rgb[1]
        scattered[i + 2] = rgb[2]

        // Reduction de la transmittance spectrale — voir l'avertissement en tete
        // de module. Le spectre de reference est celui du Soleil.
        for (let b = 0; b < bands; b++) {
          buffer[b] = aerial.transmittance[base + b] * solarSpectrum[b]
        }
        const tRgb = spectralToLinearSrgb(grid, buffer)
        // Ecretage de gamut, et non correction physique. Une transmittance tres
        // rougie — visee rasante, plusieurs dizaines de masses d'air — a une
        // chromaticite qui **sort du triangle sRGB** : sa projection sur la
        // primaire bleue devient alors legerement negative. Mesure sur la table
        // entiere : le minimum est −2,5·10⁻³, atteint la ou l'objet est de toute
        // facon eteint.
        //
        // Laisser passer ce signe inverserait le canal bleu de l'objet, et la
        // remontee du negatif vers zero brisait la decroissance de T avec la
        // distance — une violation par direction, exactement.
        //
        // Le minimum courant impose ensuite la **decroissance avec la
        // distance**, que la projection a poids signes ne garantit pas : une
        // moyenne ponderee par une primaire qui change de signe n'herite pas de
        // la monotonie de `T(λ)`, pourtant vraie bande par bande. Mesure sur la
        // table entiere : la remontee corrigee vaut au plus 8,55·10⁻⁴, sur des
        // valeurs de 2·10⁻³ — un objet deja eteint a 99,8 %.
        //
        // Reparation d'un artefact de reduction, donc, et non modele. La levee
        // de principe serait d'appliquer la transmittance en XYZ, ou les
        // fonctions colorimetriques sont positives ; elle couterait deux
        // changements de base dans chacun des trois materiaux, pour un ecart
        // inferieur au niveau d'affichage.
        const tr = solar[0] > 0 ? Math.min(prevR, Math.max(0, tRgb[0] / solar[0])) : 1
        const tg = solar[1] > 0 ? Math.min(prevG, Math.max(0, tRgb[1] / solar[1])) : 1
        const tb = solar[2] > 0 ? Math.min(prevB, Math.max(0, tRgb[2] / solar[2])) : 1
        transmittance[i] = tr
        transmittance[i + 1] = tg
        transmittance[i + 2] = tb
        prevR = tr
        prevG = tg
        prevB = tb
      }
    }
  }
}

/**
 * Coordonnee `w` d'une distance, pour une direction dont le trajet
 * atmospherique total est connu. `Infinity` rend exactement 1.
 */
export const aerialW = (distanceM: number, totalPathM: number): number => {
  if (!(totalPathM > 0)) return 1
  if (!Number.isFinite(distanceM)) return 1
  return Math.min(1, Math.sqrt(Math.max(0, distanceM) / totalPathM))
}

/**
 * Lit la table, dans les memes conventions qu'un echantillonneur GPU trilineaire
 * en `LinearFilter` et `ClampToEdgeWrapping`.
 */
export function sampleAerialLut(
  lut: AerialLut,
  viewAltitudeDeg: number,
  azimuthFromSunDeg: number,
  w: number,
): { scattered: [number, number, number]; transmittance: [number, number, number] } {
  const folded = Math.abs(((((azimuthFromSunDeg + 180) % 360) + 360) % 360) - 180)
  const u = folded / 180
  const v = Math.sqrt(Math.max(0, Math.min(90, viewAltitudeDeg)) / 90)

  const fx = Math.max(0, Math.min(lut.width - 1, u * (lut.width - 1)))
  const fy = Math.max(0, Math.min(lut.height - 1, v * (lut.height - 1)))
  const fz = Math.max(0, Math.min(lut.depth - 1, Math.max(0, Math.min(1, w)) * (lut.depth - 1)))

  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const z0 = Math.floor(fz)
  const x1 = Math.min(lut.width - 1, x0 + 1)
  const y1 = Math.min(lut.height - 1, y0 + 1)
  const z1 = Math.min(lut.depth - 1, z0 + 1)
  const tx = fx - x0
  const ty = fy - y0
  const tz = fz - z0

  const read = (source: Float32Array, channel: number): number => {
    const at = (x: number, y: number, z: number) => source[((z * lut.height + y) * lut.width + x) * 4 + channel]
    const c00 = at(x0, y0, z0) * (1 - tx) + at(x1, y0, z0) * tx
    const c10 = at(x0, y1, z0) * (1 - tx) + at(x1, y1, z0) * tx
    const c01 = at(x0, y0, z1) * (1 - tx) + at(x1, y0, z1) * tx
    const c11 = at(x0, y1, z1) * (1 - tx) + at(x1, y1, z1) * tx
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz
  }

  return {
    scattered: [read(lut.scattered, 0), read(lut.scattered, 1), read(lut.scattered, 2)],
    transmittance: [read(lut.transmittance, 0), read(lut.transmittance, 1), read(lut.transmittance, 2)],
  }
}

/**
 * Echantillonneur GPU.
 *
 * Il remplace `hazeColorTo` / `hazeColorAlong` de l'ancien noyau avec la meme
 * signature — ce que l'atmosphere ajoute en retour, ce qu'elle laisse passer en
 * parametre de sortie — de sorte que les materiaux ne changent que d'appel.
 *
 * ## Pourquoi une texture 2D pour une table a trois axes
 *
 * Les seize tranches de distance sont **empilees verticalement** dans une seule
 * texture de 64 x 512. C'est exactement la disposition memoire naturelle de la
 * table, `((z·H + y)·W + x)` : il n'y a rien a reorganiser.
 *
 * Une `sampler3D` serait plus directe, mais elle impose GLSL ES 3.00 a tout
 * nuanceur qui la touche — donc la reecriture des trois materiaux consommateurs
 * en `out vec4` et `in`/`out`. Deux lectures et un melange coutent moins, et ne
 * demandent rien a personne.
 */
export const AERIAL_LUT_GLSL = /* glsl */ `
  uniform sampler2D uAerialScattered;
  uniform sampler2D uAerialTransmittance;
  /** Largeur, hauteur d'une tranche, nombre de tranches. */
  uniform vec3 uAerialSize;
  uniform vec3 uAerialSunDir;
  uniform float uAerialExposure;
  uniform float uAerialObserverRadius;
  uniform float uAerialTopRadius;

  /**
   * Longueur du trajet de l'observateur a la sortie de l'atmosphere, forme
   * close de l'intersection rayon-sphere. C'est elle qui normalise la
   * coordonnee de distance, et elle est recalculee ici plutot que tabulee :
   * une racine carree coute moins qu'une lecture de texture.
   */
  float aerialTotalPath(vec3 dir) {
    float r0 = uAerialObserverRadius;
    float mu = clamp(dir.y, -1.0, 1.0);
    float rt = uAerialTopRadius;
    return -r0 * mu + sqrt(max(0.0, r0 * r0 * mu * mu + rt * rt - r0 * r0));
  }

  /**
   * Une tranche de la table, lue en coordonnees de texel.
   *
   * Les tranches sont empilees verticalement dans une seule texture. \`vTexel\`
   * est **borne aux centres des texels de la tranche**, ce qui garantit que le
   * filtrage bilineaire n'aille jamais chercher un pixel de la tranche voisine :
   * sans cela, l'horizon d'une tranche baverait sur le zenith de la suivante.
   */
  vec3 aerialSlice(sampler2D tex, float uTexel, float vTexel, float slice) {
    float rows = uAerialSize.y * uAerialSize.z;
    return texture2D(tex, vec2(uTexel / uAerialSize.x, (slice * uAerialSize.y + vTexel) / rows)).rgb;
  }

  /**
   * Radiance ajoutee par l'air devant un objet a \`distanceM\`, et transmittance
   * de l'objet jusqu'a l'observateur.
   *
   * Une distance infinie — un astre — donne \`w = 1\`, c'est-a-dire exactement la
   * tranche que lit le fond de ciel. Le raccord est structurel, pas ajuste.
   */
  vec3 aerialPerspective(vec3 dir, float distanceM, out vec3 transmittance) {
    vec3 d = normalize(dir);

    // Azimut relatif : angle entre les projections horizontales des deux
    // directions, replie sur [0, 180°] par la symetrie du plan solaire.
    vec2 flatDir = normalize(vec2(d.x, d.z) + vec2(1e-9));
    vec2 flatSun = normalize(vec2(uAerialSunDir.x, uAerialSunDir.z) + vec2(1e-9));
    float u = acos(clamp(dot(flatDir, flatSun), -1.0, 1.0)) / 3.14159265;
    float v = sqrt(clamp(degrees(asin(clamp(d.y, 0.0, 1.0))), 0.0, 90.0) / 90.0);

    float total = aerialTotalPath(d);
    float w = total > 0.0 ? clamp(sqrt(max(0.0, distanceM) / total), 0.0, 1.0) : 1.0;

    // Recentrage sur les texels, comme partout dans le moteur : sans lui,
    // l'interpolation extrapole a l'horizon et au zenith, la ou la table est
    // justement la plus tendue.
    float uTexel = 0.5 + u * (uAerialSize.x - 1.0);
    float vTexel = 0.5 + v * (uAerialSize.y - 1.0);

    float sliceF = w * (uAerialSize.z - 1.0);
    float s0 = floor(sliceF);
    float s1 = min(uAerialSize.z - 1.0, s0 + 1.0);
    float tz = sliceF - s0;

    transmittance = mix(
      aerialSlice(uAerialTransmittance, uTexel, vTexel, s0),
      aerialSlice(uAerialTransmittance, uTexel, vTexel, s1),
      tz
    );
    vec3 scattered = mix(
      aerialSlice(uAerialScattered, uTexel, vTexel, s0),
      aerialSlice(uAerialScattered, uTexel, vTexel, s1),
      tz
    );
    return scattered * uAerialExposure;
  }

  /** Objet a l'infini : un astre, hors de l'atmosphere. */
  vec3 aerialPerspectiveToSpace(vec3 dir, out vec3 transmittance) {
    return aerialPerspective(dir, 3.4e38, transmittance);
  }
`
