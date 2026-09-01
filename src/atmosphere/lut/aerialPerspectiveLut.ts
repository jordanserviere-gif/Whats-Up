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
/**
 * Hauteur de visee portee par la coordonnee verticale, degres.
 *
 * ## Pourquoi la table descend sous l'horizon
 *
 * Elle ne le faisait pas, et le nuanceur **ecretait** donc toute visee
 * descendante a la ligne rasante. Sans consequence tant que rien n'existait sous
 * l'horizon ; faux des qu'une surface s'y trouve, parce que le rayon rasant de
 * la table ne rencontre **jamais** le sol et monte indefiniment, quand le vrai
 * s'y arrete.
 *
 * Mesure de l'ecart sur la colonne moleculaire, observateur a trente-cinq
 * metres :
 *
 * | visee | distance | colonne en trop |
 * | --- | --- | --- |
 * | −0,2° | 20 km | **23,5 %** |
 * | −0,5° | 5 km | **16,5 %** |
 * | −1,2° | 2 km | **15,8 %** |
 * | −4° | 500 m | 0,17 % |
 * | −30° | 60 m | 0,14 % |
 *
 * La repartition surprend et s'explique : sous forte depression le trajet est
 * court et l'air homogene, l'erreur est nulle. C'est pres de l'horizon qu'elle
 * eclate, parce que le vrai rayon **touche le sol** avant la distance visee.
 *
 * ## La forme
 *
 * Quadratique de part et d'autre, ce qui concentre les texels sur l'horizon des
 * deux cotes — la ou la colonne d'air varie le plus vite. `v = 1/2` designe
 * exactement l'horizon, et la table en porte un texel.
 */
export const aerialAltitudeDeg = (v: number): number => {
  const t = 2 * v - 1
  return 90 * t * Math.abs(t)
}

/** Coordonnee verticale portant une hauteur de visee donnee. */
export const aerialV = (altitudeDeg: number): number => {
  const a = Math.max(-90, Math.min(90, altitudeDeg))
  const t = Math.sign(a) * Math.sqrt(Math.abs(a) / 90)
  return (t + 1) / 2
}

/** Dimensions de la table. */
export const AERIAL_LUT_WIDTH = 64
/**
 * Lignes de visee, **des deux cotes de l'horizon**.
 *
 * Soixante-cinq et non soixante-quatre : il en faut un nombre **impair** pour
 * que l'horizon tombe exactement sur un texel, au milieu. C'est la ligne la plus
 * tendue de la table — celle ou la colonne d'air passe de quelques kilometres a
 * plusieurs centaines — et l'interpoler entre deux voisins serait la seule
 * erreur qu'on ne peut pas se permettre.
 *
 * Trente-deux lignes de chaque cote : la resolution **au-dessus** de l'horizon
 * est donc exactement celle d'avant, et la moitie inferieure est un ajout, non
 * un partage.
 */
export const AERIAL_LUT_HEIGHT = 65
/** Indice de la ligne d'horizon. */
export const AERIAL_HORIZON_ROW = (AERIAL_LUT_HEIGHT - 1) / 2
/**
 * Tranches en distance.
 *
 * Seize : la mesure donne un ecart d'un niveau sur 255 contre une resolution
 * directe a distance finie. La premiere tranche est l'observateur lui-meme —
 * transmittance unite, rien de diffuse — et sert d'ancrage exact a `d = 0`.
 */
export const AERIAL_LUT_DEPTH = 32

/**
 * Distance de la premiere tranche utile, m — le grain du champ proche.
 */
export const AERIAL_NEAR_M = 50

/**
 * Portee de la coordonnee de distance, m.
 *
 * ## ⚠️ Elle valait 800 km, et c'etait une troncature grave
 *
 * Le raisonnement d'origine : « ce n'est pas la longueur du rayon, c'est la
 * distance au-dela de laquelle l'integrale n'accumule plus rien. Une visee
 * rasante parcourt onze cents kilometres, mais a huit cents elle est deja a
 * quarante-six kilometres d'altitude, ou il ne reste rien a diffuser. »
 *
 * **C'est vrai de jour et faux au crepuscule**, et le crepuscule est le seul
 * moment ou cela compte. Le Soleil couche, l'air proche est dans l'ombre de la
 * Terre et ne diffuse rien : toute la lumiere du ciel vient de l'air **lointain
 * et haut**, le seul encore eclaire. La tronquer, c'est jeter exactement ce
 * qu'on cherchait a calculer.
 *
 * Mesure, observateur a 1910 m, Soleil a −15,25°, part de la radiance collectee
 * au-dela de huit cents kilometres :
 *
 * | hauteur de visee | part au-dela de 800 km |
 * | --- | --- |
 * | 0,09° | **93 %** |
 * | 0,80° | **91 %** |
 * | 2,20° | 59 % |
 * | 4,31° | 0 % |
 *
 * La table rendait donc 7 a 12 % de la vraie valeur sous un degre et demi, et
 * retrouvait l'exactitude au-dela de quatre. Entre les deux, le raccord formait
 * une **bande brillante etroite** vers deux degres : le halo blanc signale apres
 * le crepuscule.
 *
 * ## La valeur, deduite plutot que choisie
 *
 * La borne n'est plus une estimation de « la ou il ne se passe plus rien » mais
 * la **longueur reelle du plus long trajet possible** : celui d'une visee
 * horizontale depuis le sol jusqu'au sommet de l'atmosphere,
 *
 *     sqrt((R + h_top)² − R²) = 1133 km
 *
 * arrondie au-dessus. Un observateur en altitude a un trajet plus court, jamais
 * plus long. Au-dela, la marche est bornee par sa propre fin et les tranches
 * repetent la derniere valeur — `w = 1` designe donc toujours le ciel.
 */
export const AERIAL_FAR_M = 1_200_000

/** Constante de la loi logarithmique, telle que `w = 1` donne `AERIAL_FAR_M`. */
const AERIAL_K = Math.log1p(AERIAL_FAR_M / AERIAL_NEAR_M)

export interface AerialLut {
  readonly width: number
  readonly height: number
  readonly depth: number
  /** Radiance diffusee cumulee, sRGB lineaire, `RGBA` — l'alpha est inutilise. */
  readonly scattered: Float32Array
  /**
   * Part de `scattered` qui ne vient pas du rayon solaire direct, meme format.
   *
   * C'est ce que l'air renvoie encore lorsqu'un obstacle lui cache le Soleil
   * sans lui cacher le ciel. Un relief interpose ne **multiplie** donc pas le
   * voile par un facteur : il lui **substitue** cette table.
   */
  readonly ambient: Float32Array
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
    ambient: new Float32Array(size),
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
  // ⚠️ **A partir de la ligne d'horizon seulement.** Depuis que la table
  // descend sous l'horizon, sa moitie inferieure decrit des surfaces au sol et
  // non du ciel : l'y inclure ferait s'adapter l'oeil a un paysage plutot qu'a
  // la voute, et l'exposition entiere avec lui.
  for (let y = Math.ceil(AERIAL_HORIZON_ROW); y < height; y++) {
    const v = height > 1 ? y / (height - 1) : 0
    const altitudeDeg = aerialAltitudeDeg(v)
    const altitudeRad = (altitudeDeg * Math.PI) / 180
    // Jacobien de la parametrisation, et rien d'autre : c'est une moyenne en
    // angle solide. Le `cos(hauteur)` n'est pas un detail — l'oublier
    // surpondere le zenith, ou le parametrage s'etire.
    const weight = Math.cos(altitudeRad) * Math.max(1e-6, 2 * v - 1)
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

/**
 * Eclairement diffus du ciel sur une surface horizontale, par canal.
 *
 * ## A quoi il sert
 *
 * A eclairer une surface. Le moteur savait deja ce que le Soleil **direct**
 * apporte a une surface (`directSolar`), et ce que le ciel **rayonne** dans une
 * direction (la table). Il ne savait pas ce que le ciel entier **depose** sur un
 * plan, qui est la seconde moitie de l'eclairement d'un paysage — et la
 * premiere a l'ombre, ou sous un ciel couvert.
 *
 *     E = ∫ L(ω)·cosθ_z·dω        sur l'hemisphere
 *
 * ## La ponderation, et pourquoi elle differe de la luminance moyenne
 *
 * `measureMeanSkyLuminance` moyenne en **angle solide** : c'est ce a quoi l'oeil
 * s'adapte, et le `cosθ_z` y serait une erreur — elle a d'ailleurs ete commise
 * puis corrigee. Ici c'est l'inverse : un plan horizontal recoit d'autant moins
 * qu'une direction est rasante, et le cosinus **est** le modele.
 *
 * Les deux quantites coexistent donc, et repondent a deux questions distinctes.
 *
 * ## L'unite
 *
 * La table porte des radiances en sRGB lineaire ; cette integrale rend donc un
 * eclairement dans **la meme echelle**, multipliee par des steradians. C'est
 * exactement ce qu'attend `L = albedo/π · E`, et c'est ce qui garantit qu'une
 * surface eclairee par ce ciel-la et le ciel lui-meme traversent la meme
 * exposition sans facteur de raccord.
 *
 * Controle : un ciel de radiance uniforme `L` doit rendre `π·L`.
 */
export function measureSkyIrradiance(lut: AerialLut): [number, number, number] {
  const { width, height, depth, scattered } = lut
  const total = [0, 0, 0]
  let weightTotal = 0
  // Meme restriction que la luminance moyenne : le ciel commence a l'horizon.
  for (let y = Math.ceil(AERIAL_HORIZON_ROW); y < height; y++) {
    const v = height > 1 ? y / (height - 1) : 0
    const altitudeRad = (aerialAltitudeDeg(v) * Math.PI) / 180
    // Meme jacobien d'angle solide que la luminance moyenne...
    const solidAngle = Math.cos(altitudeRad) * Math.max(1e-6, 2 * v - 1)
    // ...puis le cosinus zenithal, qui est ici le modele et non une erreur.
    const weight = solidAngle * Math.sin(altitudeRad)
    for (let x = 0; x < width; x++) {
      const i = (((depth - 1) * height + y) * width + x) * 4
      for (let c = 0; c < 3; c++) total[c] += Math.max(0, scattered[i + c]) * weight
    }
    weightTotal += solidAngle * width
  }
  if (!(weightTotal > 0)) return [0, 0, 0]
  // L'hemisphere vaut 2π steradians ; la somme des poids d'angle solide le
  // represente, et le cosinus est deja porte par `weight`.
  const scale = (2 * Math.PI) / weightTotal
  return [total[0] * scale, total[1] * scale, total[2] * scale]
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
  const { width, height, depth, scattered, ambient, transmittance } = lut
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
  // ## Huit pas par tranche, et c'est le crepuscule qui l'impose
  //
  // Mesure de jour, contre une marche seize fois plus fine :
  //
  //     2 pas -> 0,199 %     4 pas -> 0,050 %     8 pas -> 0,012 %
  //
  // Quatre suffisaient donc, et c'est ce qu'on avait retenu. ⚠️ **Mais la mesure
  // n'avait ete faite que de jour.** Le Soleil couche, l'integrande acquiert une
  // **arete franche** : le point ou le rayon sort de l'ombre de la Terre. Une
  // quadrature grossiere l'integre mal, et l'ecart a la marche fine explose.
  //
  // Mesure au crepuscule, configuration complete, contre le solveur direct :
  //
  // | Soleil | 4 pas | 8 pas |
  // | --- | --- | --- |
  // | −6° | 0,3 % | 0,0 % |
  // | −10° | 0,4 % | 0,2 % |
  // | **−15°** | **8,5 %** | **1,0 %** |
  //
  // Le surcout est de **1,2 ms par ligne** — 4,8 a 6,3 ms — et non du double,
  // une part du cout d'une ligne ne dependant pas du nombre de pas.
  const stepsPerSlice = 8
  const sliceDistancesM = aerialSliceDistancesM(depth)

  for (let y = Math.max(0, fromRow); y < Math.min(height, toRow); y++) {
    const altitudeDeg = aerialAltitudeDeg(height > 1 ? y / (height - 1) : 0)
    for (let x = 0; x < width; x++) {
      const azimuthDeg = 180 * (width > 1 ? x / (width - 1) : 0)
      const aerial = aerialPerspective(grid, altitudeDeg, azimuthDeg, sunAltitudeDeg, {
        ...options,
        slices: depth,
        stepsPerSlice,
        sliceDistancesM,
        // Sous l'horizon, le trajet se termine au sol. C'est ce qui distingue
        // une surface — qui s'y trouve — du ciel, qui n'y est pas.
        stopAtGround: altitudeDeg < 0,
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

        // La meme integrale privee de sa source solaire — voir `ambient`. Elle
        // traverse le meme operateur colorimetrique que le total, sans quoi les
        // deux ne seraient pas sur la meme echelle et une ombre changerait la
        // teinte du voile au lieu de seulement l'assombrir.
        for (let b = 0; b < bands; b++) buffer[b] = aerial.ambient[base + b]
        const ambientRgb = spectralToLinearSrgb(grid, buffer)
        ambient[i] = ambientRgb[0]
        ambient[i + 1] = ambientRgb[1]
        ambient[i + 2] = ambientRgb[2]

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
 * Distance, en metres, d'une coordonnee `w`.
 *
 * ## ⚠️ Pourquoi cette loi ne depend plus de la direction
 *
 * La coordonnee valait autrefois `sqrt(distance / trajet_total)`, ou
 * `trajet_total` etait la longueur du rayon **dans sa propre direction** : la
 * sortie de l'atmosphere pour une visee montante, la rencontre du sol pour une
 * visee descendante.
 *
 * Cette longueur est **discontinue**. De part et d'autre de la rasance — la
 * direction ou le rayon effleure la sphere — elle passe du trajet vers l'espace
 * a la distance du sol. Mesure a trente-cinq metres d'altitude, pour quatre
 * milliemes de degre d'ecart : **1154 km d'un cote, 18,3 km de l'autre**, un
 * facteur soixante-trois.
 *
 * Trois consequences, toutes visibles :
 *
 * - deux lignes voisines de la table echantillonnaient des distances sans
 *   rapport, et les melanger n'avait aucun sens ;
 * - le nuanceur calculait sa propre longueur par pixel, qui sautait au meme
 *   endroit : un point de relief a quinze kilometres passait de la tranche
 *   **1,71 a 13,59** d'un pixel a l'autre ;
 * - la rupture se posait a une hauteur apparente fixe, celle de la rasance du
 *   globe, **par-dessus le relief** — puisque cette longueur ignore
 *   completement ce qui se trouve devant.
 *
 * La loi est donc devenue **globale** : la meme pour toutes les directions,
 * logarithmique pour rester fine au premier plan sans renoncer au lointain.
 *
 *     d(w) = D0 · (exp(w · K) − 1)      K = ln(1 + D_max / D0)
 *
 * Toutes les lignes echantillonnent desormais les memes distances, leur melange
 * redevient legitime, et la coordonnee est continue en direction. Le nuanceur
 * n'a plus aucune geometrie a resoudre.
 *
 * Le prix est que chaque rayon ne remplit plus toutes ses tranches : celles qui
 * depassent sa propre fin repetent la derniere valeur. C'est exactement ce qu'il
 * faut — au-dela du sol, rien ne s'ajoute.
 */
export const aerialDistanceM = (w: number): number =>
  AERIAL_NEAR_M * Math.expm1(Math.max(0, Math.min(1, w)) * AERIAL_K)

/** Coordonnee `w` d'une distance. `Infinity` rend exactement 1. */
export const aerialW = (distanceM: number): number => {
  if (!Number.isFinite(distanceM)) return 1
  return Math.max(0, Math.min(1, Math.log1p(Math.max(0, distanceM) / AERIAL_NEAR_M) / AERIAL_K))
}

/** Distances des tranches, en metres — le meme decoupage pour toute la table. */
export function aerialSliceDistancesM(depth = AERIAL_LUT_DEPTH): Float64Array {
  const out = new Float64Array(depth)
  for (let k = 0; k < depth; k++) out[k] = aerialDistanceM(depth > 1 ? k / (depth - 1) : 1)
  return out
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
  const v = aerialV(viewAltitudeDeg)

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
  uniform sampler2D uAerialAmbient;
  uniform sampler2D uAerialTransmittance;
  /** Largeur, hauteur d'une tranche, nombre de tranches. */
  uniform vec3 uAerialSize;
  uniform vec3 uAerialSunDir;
  uniform float uAerialExposure;

  /**
   * Longueur du trajet de l'observateur a la sortie de l'atmosphere, forme
   * close de l'intersection rayon-sphere. C'est elle qui normalise la
   * coordonnee de distance, et elle est recalculee ici plutot que tabulee :
   * une racine carree coute moins qu'une lecture de texture.
   */
  /**
   * Distance portee par la coordonnee \`w\`, metres.
   *
   * La meme loi pour toutes les directions — voir \`aerialDistanceM\` du cote
   * TypeScript pour la mesure du defaut qui l'a imposee. Le nuanceur n'a plus
   * aucune intersection a resoudre : il ne connait plus la sphere, donc il ne
   * peut plus prendre la rasance du globe pour une limite.
   */
  float aerialW(float distanceM) {
    return clamp(log(1.0 + max(0.0, distanceM) / ${AERIAL_NEAR_M}.0) / ${AERIAL_K.toFixed(9)}, 0.0, 1.0);
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
  /**
   * Coordonnees de lecture d'une direction et d'une distance.
   *
   * Extraites pour que le voile total et sa part ambiante soient lus **au meme
   * endroit** de la table : deux calculs separes divergeraient d'un demi-texel
   * et l'ombre laisserait un lisere.
   */
  void aerialCoords(vec3 dir, float distanceM, out float uTexel, out float vTexel, out float sliceF) {
    vec3 d = normalize(dir);

    // Azimut relatif : angle entre les projections horizontales des deux
    // directions, replie sur [0, 180°] par la symetrie du plan solaire.
    vec2 flatDir = normalize(vec2(d.x, d.z) + vec2(1e-9));
    vec2 flatSun = normalize(vec2(uAerialSunDir.x, uAerialSunDir.z) + vec2(1e-9));
    float u = acos(clamp(dot(flatDir, flatSun), -1.0, 1.0)) / 3.14159265;
    // La table couvre desormais les deux hemispheres : plus de bornage a
    // l'horizon. La valeur 0,5 designe l'horizon exactement, et la
    // parametrisation est quadratique de part et d'autre.
    float elevDeg = degrees(asin(clamp(d.y, -1.0, 1.0)));
    float tv = sign(elevDeg) * sqrt(clamp(abs(elevDeg) / 90.0, 0.0, 1.0));
    float v = (tv + 1.0) * 0.5;

    float w = aerialW(distanceM);

    // Recentrage sur les texels, comme partout dans le moteur : sans lui,
    // l'interpolation extrapole a l'horizon et au zenith, la ou la table est
    // justement la plus tendue.
    uTexel = 0.5 + u * (uAerialSize.x - 1.0);
    vTexel = 0.5 + v * (uAerialSize.y - 1.0);
    sliceF = w * (uAerialSize.z - 1.0);
  }

  /** Lecture d'une des tables, tranches interpolees. */
  vec3 aerialLookup(sampler2D tex, float uTexel, float vTexel, float sliceF) {
    float s0 = floor(sliceF);
    float s1 = min(uAerialSize.z - 1.0, s0 + 1.0);
    return mix(
      aerialSlice(tex, uTexel, vTexel, s0),
      aerialSlice(tex, uTexel, vTexel, s1),
      sliceF - s0
    );
  }

  vec3 aerialPerspective(vec3 dir, float distanceM, out vec3 transmittance) {
    float uTexel, vTexel, sliceF;
    aerialCoords(dir, distanceM, uTexel, vTexel, sliceF);
    transmittance = aerialLookup(uAerialTransmittance, uTexel, vTexel, sliceF);
    return aerialLookup(uAerialScattered, uTexel, vTexel, sliceF) * uAerialExposure;
  }

  /**
   * Ce que l'air renvoie encore quand un obstacle lui cache le Soleil sans lui
   * cacher le ciel — meme integrale, source solaire retiree.
   *
   * Une ombre portee dans l'air n'est donc pas un facteur applique au voile :
   * c'est cette table-ci qui remplace l'autre sur le segment concerne.
   */
  vec3 aerialAmbient(vec3 dir, float distanceM) {
    float uTexel, vTexel, sliceF;
    aerialCoords(dir, distanceM, uTexel, vTexel, sliceF);
    return aerialLookup(uAerialAmbient, uTexel, vTexel, sliceF) * uAerialExposure;
  }

  /** Objet a l'infini : un astre, hors de l'atmosphere. */
  vec3 aerialPerspectiveToSpace(vec3 dir, out vec3 transmittance) {
    return aerialPerspective(dir, 3.4e38, transmittance);
  }
`
