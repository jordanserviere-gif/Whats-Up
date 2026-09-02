/**
 * Table de perspective atmospherique, tenue a jour et exposee au rendu.
 *
 * ## Une seule table pour le ciel et pour ce qui s'y trouve
 *
 * Elle a remplace la table de ciel, dont elle est le prolongement : la
 * **derniere tranche** de l'axe des distances est litteralement le ciel entier,
 * et les tranches precedentes sont ce que l'air fait a un objet place plus
 * pres. Le fond de ciel lit donc la tranche lointaine ; un astre, qui est a
 * l'infini, lit la **meme** ; un avion lit la sienne.
 *
 * C'est ce qui fait qu'un astre bas se fond dans le ciel qui l'entoure sans
 * qu'aucun raccord n'ait ete ajuste. Avant, le ciel venait du solveur physique
 * et le voile des objets de l'ancien noyau analytique — deux modeles, deux
 * couleurs, une couture visible.
 *
 * ## Le rythme de reconstruction
 *
 * Inchange : la table depend du Soleil, donc de l'heure, et se refait quand la
 * hauteur solaire a bouge d'un quart de degre. Environ une minute de temps
 * reel, bien en dessous de ce que l'oeil distingue sur un degrade de ciel.
 *
 * ## La reconstruction est etalee
 *
 * Une ligne — une hauteur de visee, avec ses seize distances — coute 2,9 ms.
 * Deux lignes par image tiennent dans le budget, et les seize images passent
 * inapercues : la texture ne change qu'une fois la table complete, si bien que
 * le ciel affiche l'ancienne pendant la construction de la nouvelle. Pas de
 * dechirure, et le prix est un retard de quelques images sur la position du
 * Soleil — sans objet, personne ne juge la couleur d'un ciel qui defile.
 *
 * ## Format
 *
 * Deux textures `RGBA` flottantes de 64 x 512 : la diffusion et la
 * transmittance. Les seize tranches de distance sont **empilees
 * verticalement**, ce qui est deja la disposition memoire naturelle de la table
 * et evite d'imposer GLSL ES 3.00 aux materiaux consommateurs — voir
 * `atmosphere/lut/aerialPerspectiveLut.ts`.
 *
 * Le filtrage lineaire sur flottant simple demande `OES_texture_float_linear`,
 * presente sur la machine de reference. **Sur mobile, le demi-flottant serait
 * le format sur** — a prevoir avant tout deploiement iOS.
 */
import { useEffect, useMemo, useRef } from 'react'
import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  LinearFilter,
  RGBAFormat,
  Vector2,
  Vector3,
} from 'three'
import { useFrame } from '@react-three/fiber'
import { createColumnLut, fillColumnLutRows, type ColumnLut } from '@/atmosphere/lut/transmittanceLut'
import { fillSkyViewRows } from '@/atmosphere/lut/skyViewLut'
import {
  CONTINENTAL_AEROSOL,
  aerosolOptics,
  aodFromTurbidity,
  withAod,
  type AerosolOptics,
} from '@/atmosphere/mie/aerosol'
import {
  AERIAL_LUT_DEPTH,
  AERIAL_LUT_HEIGHT,
  AERIAL_LUT_WIDTH,
  createAerialLut,
  fillAerialRows,
  measureMeanSkyLuminance,
  measureSkyIrradiance,
  type AerialLut,
} from '@/atmosphere/lut/aerialPerspectiveLut'
import {
  MS_LUT_HEIGHT,
  MS_LUT_WIDTH,
  multipleScatteringPasses,
  commitMultipleScatteringPass,
  createMultipleScatteringLut,
  fillMultipleScatteringEntries,
  type MultipleScatteringLut,
} from '@/atmosphere/transport/multipleScattering'
import { ATMOSPHERE_TOP_M } from '@/atmosphere/transport/slantPath'
import { EARTH_MEAN_RADIUS_M } from '@/atmosphere/core/units'
import { uniformSpectralGrid } from '@/atmosphere/spectral/SpectralGrid'
import { adaptiveSkyExposure } from './display/adaptation'
import { SKY_DISPLAY_EXPOSURE } from './display/exposure'

/**
 * Grille spectrale du transport.
 *
 * Seize bandes : la couleur en demande peu — sa resolution utile est fixee par
 * la largeur des fonctions colorimetriques — et le cout de construction croit
 * lineairement avec le nombre de bandes.
 */
const GRID = uniformSpectralGrid(360, 830, 16)

/**
 * Proprietes optiques des aerosols, calculees une fois.
 *
 * Le calcul de Mie coute une centaine de millisecondes — quarante tailles de
 * particules par bande spectrale. Il ne depend que de la **nature** des
 * particules, pas de leur nombre : changer le trouble ne le refait donc pas,
 * seule la densite est remise a l'echelle.
 */
const REFERENCE_AOD = aodFromTurbidity(1)
let baseOptics: AerosolOptics | null = null
const sharedAerosolOptics = (turbidity: number): AerosolOptics => {
  if (!baseOptics) baseOptics = aerosolOptics(GRID, { ...CONTINENTAL_AEROSOL, aod550: REFERENCE_AOD })
  return withAod(baseOptics, aodFromTurbidity(turbidity), REFERENCE_AOD)
}

/**
 * Table de colonne moleculaire, partagee par toutes les reconstructions.
 *
 * Elle ne depend ni de l'heure, ni du lieu, ni du Soleil : une seule
 * construction pour toute la duree de vie de l'application. Construite
 * paresseusement pour ne pas peser sur le premier affichage.
 */
let columnLut: ColumnLut | null = null
let columnRowsDone = 0

/**
 * Lignes de table de colonne construites par image.
 *
 * Mesure : la table entiere coute **124 ms dans le navigateur**, et elle etait
 * construite paresseusement au premier besoin, donc **dans une image**. C'etait
 * le plus gros blocage du moteur — tout le reste etait deja etale.
 *
 * Huit lignes sur soixante-quatre font 15 ms : huit images pour une table
 * complete, et plus aucun a-coup a l'ouverture. Rien de la physique ne change,
 * chaque entree etant independante des autres.
 */
const COLUMN_ROWS_PER_FRAME = 8

/** La table est-elle utilisable ? */
const columnLutReady = (): boolean => columnLut !== null && columnRowsDone >= columnLut.height

/** Avance la construction d'une tranche. */
const advanceColumnLut = (): void => {
  if (!columnLut) {
    columnLut = createColumnLut()
    columnRowsDone = 0
  }
  if (columnRowsDone >= columnLut.height) return
  const to = Math.min(columnLut.height, columnRowsDone + COLUMN_ROWS_PER_FRAME)
  fillColumnLutRows(columnLut, columnRowsDone, to, {
    aerosolScaleHeightM: CONTINENTAL_AEROSOL.scaleHeightM,
  })
  columnRowsDone = to
}

const sharedColumnLut = (): ColumnLut => {
  if (!columnLut) {
    columnLut = createColumnLut()
    columnRowsDone = 0
  }
  return columnLut
}

/**
 * Table de diffusion multiple, gardee entre deux reconstructions.
 *
 * Elle ne depend que de la **composition** de l'atmosphere : la hauteur du
 * Soleil est l'une de ses deux dimensions, pas un parametre. Un lever de Soleil
 * ne la refait donc jamais — seul un changement de trouble le fait.
 */
let multipleScattering: MultipleScatteringLut | null = null
let multipleScatteringTurbidity = Number.NaN

/**
 * Entrees de diffusion multiple construites par image.
 *
 * Une entree coute **0,38 ms a la premiere passe** — trente-deux directions de
 * marche, chacune avec sa colonne solaire — et **0,22 ms** aux suivantes, ou la
 * colonne solaire est remplacee par une lecture de table.
 *
 * Trente-deux entrees font donc 12,2 ms puis 7 ms. C'est plus qu'un
 * soixantieme de seconde a la premiere passe, et c'est assume : la valeur
 * precedente en coutait **20** pour une table quatre fois plus petite. La
 * cadence a pu monter parce que le cout par entree, lui, a baisse.
 *
 * Table complete — 2048 entrees, trois passes — en 192 images, un peu plus de
 * trois secondes. Pendant ce temps le ciel affiche la table precedente, et au
 * tout premier chargement il apparait des la premiere passe.
 */
const MS_ENTRIES_PER_FRAME = 32

/** Deplacement du Soleil au-dela duquel la table est refaite, degres. */
const SUN_MOVEMENT_THRESHOLD_DEG = 0.25

/**
 * Lignes de perspective atmospherique construites par image.
 *
 * Une ligne porte une hauteur de visee et ses **trente-deux** distances, pour
 * 6,3 ms — les distances sortent d'une seule marche, c'est ce qui rend la table
 * 3D a peine plus chere qu'une table 2D.
 *
 * Elle valait 2,9 ms avec seize distances placees en fractions du trajet propre
 * a chaque direction. Ce decoupage rendait la coordonnee de distance
 * discontinue a la rasance et posait une rupture visible par-dessus le relief ;
 * la grille globale qui l'a remplace demande deux fois plus de points de
 * controle pour tenir la meme resolution pres de l'observateur.
 *
 * Une seule ligne par image, donc : 4,8 ms tiennent dans le budget d'une image
 * a 60 Hz, deux non. La table entiere se pose en soixante-cinq images, un peu
 * plus d'une seconde — pendant lesquelles la precedente reste affichee.
 */
const ROWS_PER_FRAME = 1

/** Rayon de l'observateur et sommet de l'atmosphere, metres — pour le nuanceur. */
export const AERIAL_TOP_RADIUS_M = EARTH_MEAN_RADIUS_M + ATMOSPHERE_TOP_M

export interface AerialTextures {
  scattered: DataTexture | null
  /**
   * Meme table, source solaire retiree.
   *
   * Elle n'a de sens que pour un objet qui **occulte le Soleil sans occulter le
   * ciel** : un relief, un nuage. Le fond de ciel n'a rien devant lui et ne la
   * lit jamais.
   */
  ambient: DataTexture | null
  transmittance: DataTexture | null
  /** `(largeur, hauteur d'une tranche, nombre de tranches)`. */
  size: Vector3
  /** Distance du centre de la Terre a l'observateur, metres. */
  observerRadiusM: number
  /**
   * Luminance moyenne du ciel, cd/m² — ce a quoi l'oeil s'adapte.
   *
   * Mesuree sur la table elle-meme, donc sur le ciel reellement affiche. C'est
   * elle qui pilote l'exposition, et non une table d'ancres exterieure.
   */
  meanSkyLuminanceCdPerM2: number
  /**
   * Eclairement diffus du ciel sur un plan horizontal, sRGB lineaire par canal.
   *
   * Ce que le ciel entier **depose** sur une surface, par opposition a ce qu'il
   * **rayonne** dans une direction. C'est la moitie de l'eclairement d'un
   * paysage, et la totalite a l'ombre.
   *
   * Mesure sur la meme table, au meme instant, avec le meme operateur
   * colorimetrique : une surface eclairee par cette valeur et le ciel qui
   * l'entoure sont donc sur la meme echelle radiometrique, sans raccord.
   */
  skyIrradiance: [number, number, number]
}

/**
 * Textures partagees, lues par les materiaux qui ne sont pas dans l'arbre du
 * fond de ciel — corps du systeme solaire, avions, trainees.
 *
 * Meme raison que pour les tables de colonne et de diffusion multiple
 * ci-dessus : ces objets sont des freres du fond de ciel dans la scene, et
 * faire descendre deux textures par les proprietes traverserait une demi-
 * douzaine de composants qui n'en ont que faire. L'objet est stable, seules ses
 * references changent.
 */
/** Largeur de la table de ciel lunaire — azimut relatif a la Lune. */
export const MOON_SKY_WIDTH = 64
/** Hauteur de la table de ciel lunaire — hauteur de visee, en racine. */
export const MOON_SKY_HEIGHT = 32
/** Lignes construites par image. La table est la derniere servie. */
const MOON_ROWS_PER_FRAME = 2

/**
 * Le ciel eclaire par la Lune — **calcule, et non peint**.
 *
 * ## Pourquoi une seconde table, et pourquoi elle est presque gratuite
 *
 * La diffusion est **lineaire en l'eclairement de la source**. Le ciel de clair
 * de lune est donc, terme a terme, le ciel de jour avec le Soleil place ou est
 * la Lune, multiplie par `moonToSunIrradianceRatio` — deux millioniemes a la
 * pleine Lune. Rien de nouveau n'est modelise : c'est le meme solveur, la meme
 * diffusion multiple, la meme colonne de transmittance.
 *
 * Elle est **bidimensionnelle** — direction de visee seule — la ou la table de
 * perspective atmospherique porte en plus la distance. Soixante-quatre par
 * trente-deux contre trente-deux tranches de la meme surface : elle coute donc
 * un trentieme, et se construit deux lignes par image apres tout le reste.
 *
 * ## ⚠️ Ce qu'elle remplace
 *
 * Un halo peint : `uMoonGlow × uMoonFactor × (0,25 + 0,75·cos⁶)`. Une couleur
 * d'interface et un cosinus a la puissance six, qui portaient **3 a 25 %** de la
 * luminance du ciel une heure et demie apres le coucher au Ventoux. Il ne
 * connaissait ni l'extinction, ni la diffusion de Mie vers l'avant, ni le fait
 * que le ciel bleuit loin de la source.
 */
export const moonSkyTextures = {
  texture: null as DataTexture | null,
  size: new Vector2(MOON_SKY_WIDTH, MOON_SKY_HEIGHT),
  /**
   * Rapport d'eclairement lunaire sur solaire, zero quand la Lune est couchee.
   *
   * Il porte **toute** la dependance a la phase et a la distance : la table,
   * elle, ne connait que la geometrie.
   */
  scale: 0,
  /**
   * Luminance moyenne de la table **non mise a l'echelle**, cd/m².
   *
   * ⚠️ Elle existe pour que l'exposition voie la Lune. Sans elle, l'adaptation
   * ne lisait que le ciel solaire — nul la nuit — et l'oeil restait regle sur
   * une nuit sans Lune : le clair de lune saturait alors le ciel en gris et
   * **effacait toutes les etoiles**, ce qu'aucune pleine Lune ne fait.
   */
  meanLuminanceCdPerM2: 0,
}

/**
 * Luminance moyenne d'une table de ciel, ponderee par l'angle solide.
 *
 * Meme grandeur que `measureMeanSkyLuminance`, sur l'autre parametrisation :
 * ici `v = sqrt(hauteur/90)`, donc `dhauteur/dv ∝ v`, et le poids vaut
 * `cos(hauteur)·v`. Le `cos` n'est pas un detail — l'omettre surpondere le
 * zenith, ou le parametrage s'etire.
 */
function measureMoonSkyLuminance(data: Float32Array): number {
  let total = 0
  let weightTotal = 0
  for (let y = 0; y < MOON_SKY_HEIGHT; y++) {
    const v = MOON_SKY_HEIGHT > 1 ? y / (MOON_SKY_HEIGHT - 1) : 0
    const altitudeRad = ((90 * v * v) * Math.PI) / 180
    const weight = Math.cos(altitudeRad) * v
    for (let x = 0; x < MOON_SKY_WIDTH; x++) {
      const i = (y * MOON_SKY_WIDTH + x) * 4
      const y709 = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
      total += Math.max(0, y709) * weight
      weightTotal += weight
    }
  }
  // La ligne Y de la matrice sRGB : la luminance vaut `683 × Y`.
  return weightTotal > 0 ? (683 * total) / weightTotal : 0
}

/**
 * Luminance a laquelle l'oeil s'adapte, cd/m² — **la somme des deux ciels**.
 *
 * Une seule expression, pour la meme raison que la radiance du ciel n'en a
 * qu'une : deux exposants calcules a deux endroits finissent par diverger. Ici,
 * l'ecart s'etait manifeste d'un coup — la Lune n'entrant pas dans le calcul,
 * son ciel arrivait dans un oeil regle sur le noir.
 */
export const adaptationSkyLuminance = (): number =>
  aerialTextures.meanSkyLuminanceCdPerM2 +
  moonSkyTextures.meanLuminanceCdPerM2 * moonSkyTextures.scale

export const aerialTextures: AerialTextures = {
  scattered: null,
  ambient: null,
  transmittance: null,
  size: new Vector3(AERIAL_LUT_WIDTH, AERIAL_LUT_HEIGHT, AERIAL_LUT_DEPTH),
  observerRadiusM: EARTH_MEAN_RADIUS_M,
  meanSkyLuminanceCdPerM2: 0,
  skyIrradiance: [0, 0, 0],
}

/**
 * Bloc d'uniformes attendu par `AERIAL_LUT_GLSL`.
 *
 * Il vit dans la couche « scene » et non dans la couche « atmosphere » : celle-ci
 * ne connait pas three.js, et c'est ce qui lui permet d'etre validee hors de
 * tout contexte de rendu. Elle n'exporte que du GLSL, jamais un `Vector3`.
 */
export function aerialUniforms() {
  return {
    uAerialScattered: { value: null as DataTexture | null },
    uAerialAmbient: { value: null as DataTexture | null },
    uAerialTransmittance: { value: null as DataTexture | null },
    uAerialSize: { value: new Vector3(AERIAL_LUT_WIDTH, AERIAL_LUT_HEIGHT, AERIAL_LUT_DEPTH) },
    uAerialSunDir: { value: new Vector3(0, 1, 0) },
    uAerialExposure: { value: 0 },
    uAerialObserverRadius: { value: EARTH_MEAN_RADIUS_M },
    uAerialTopRadius: { value: AERIAL_TOP_RADIUS_M },
    /** Rayon du sol : il borne le trajet d une visee descendante. */
    uAerialGroundRadius: { value: EARTH_MEAN_RADIUS_M },
  }
}

/**
 * Recopie les textures partagees et l'etat courant dans un materiau.
 *
 * `exposure` est **l'exposition du ciel**, pas l'ancienne constante de
 * calibrage de 0,3 : la table porte les memes radiances que le fond de ciel, et
 * les deux doivent donc traverser la meme echelle. C'est ce qui fait qu'un
 * astre et le ciel qui l'entoure s'eteignent au meme rythme pendant une eclipse
 * sans que rien ne les y force.
 */
export function applyAerialUniforms(
  uniforms: ReturnType<typeof aerialUniforms>,
  sunDirection: readonly [number, number, number],
  exposure: number,
): void {
  uniforms.uAerialScattered.value = aerialTextures.scattered
  uniforms.uAerialAmbient.value = aerialTextures.ambient
  uniforms.uAerialTransmittance.value = aerialTextures.transmittance
  uniforms.uAerialSunDir.value.set(sunDirection[0], sunDirection[1], sunDirection[2])

  // --- L'adaptation entre ici, et une seule fois --------------------------
  //
  // `exposure` porte ce que l'appelant sait et que ce module ignore :
  // l'attenuation d'eclipse, et l'extinction du calque atmosphere. Rapportee a
  // l'exposition fixe, elle en devient un simple facteur multiplicatif.
  //
  // L'adaptation, elle, se calcule a partir de la luminance moyenne du ciel
  // **mesuree sur la table qui va s'afficher**. Aucune table d'ancres exterieure
  // n'intervient : le ciel decide de sa propre exposition.
  //
  // La centraliser ici garantit que le fond de ciel, les corps du systeme
  // solaire et les avions s'adaptent ensemble. Les laisser calculer chacun la
  // leur les ferait deriver.
  const dimming = exposure / SKY_DISPLAY_EXPOSURE
  // ⚠️ **Les deux ciels, pas seulement le solaire.** L'adaptation doit se faire
  // sur ce que l'oeil recoit reellement ; la nuit, c'est la Lune qui le remplit.
  uniforms.uAerialExposure.value = adaptiveSkyExposure(adaptationSkyLuminance()) * dimming
  uniforms.uAerialObserverRadius.value = aerialTextures.observerRadiusM
}

/**
 * Textures de perspective atmospherique, reconstruites quand le Soleil bouge.
 *
 * `enabled` a faux laisse les textures a zero pour la diffusion et a un pour la
 * transmittance : c'est la vue depuis l'espace, sans atmosphere — rien
 * d'ajoute, rien de retire.
 */
export function useAerialLut(
  sunAltitudeDeg: number,
  observerElevationM: number,
  aerosolTurbidity: number,
  enabled: boolean,
  /**
   * Distance Terre-Soleil, en unites astronomiques.
   *
   * Elle varie de 0,983 au perihelie (debut janvier) a 1,017 a l'aphelie (debut
   * juillet) : l'eclairement, en `1/d²`, varie donc de **6,9 %** sur l'annee.
   * Ce n'est pas ce qui fait les saisons — l'inclinaison de l'axe s'en charge,
   * et dans l'autre sens pour l'hemisphere nord — mais c'est mesurable, et le
   * transport savait deja le prendre en compte sans que personne ne le lui
   * donne.
   */
  sunDistanceAu = 1,
  /**
   * Colonne d'ozone, en unites Dobson.
   *
   * L'ozone est ce qui rend le crepuscule bleu. Le moteur employait 300 DU —
   * la moyenne globale — partout et en toute saison ; voir
   * `absorption/ozoneClimatology.ts`.
   */
  ozoneColumnDobsonUnits = 300,
  /**
   * Ce que la Lune apporte au ciel.
   *
   * ⚠️ **Un objet, et non deux nombres de plus.** La signature en portait deja
   * cinq a la suite, tous `number` : inserer deux parametres au milieu a laisse
   * `sunDistanceAu` et la colonne d'ozone glisser dans leurs places sans que le
   * compilateur ne bronche. Un type distinct rend la faute impossible.
   */
  moon: {
    /** Hauteur de la Lune, degres. Negative, son ciel ne se calcule pas. */
    readonly altitudeDeg: number
    /** Rapport d'eclairement lunaire sur solaire — voir `moonToSunIrradianceRatio`. */
    readonly irradianceRatio: number
  } = { altitudeDeg: -90, irradianceRatio: 0 },
): AerialTextures {
  const rows = AERIAL_LUT_HEIGHT * AERIAL_LUT_DEPTH

  // Les tampons sont gardes a part : le type de `DataTexture.image.data` est
  // l'union de tous les tableaux typees possibles, et le retrouver a chaque
  // image demanderait une assertion que rien ne garantit.
  const scatteredData = useMemo(() => new Float32Array(AERIAL_LUT_WIDTH * rows * 4), [rows])
  const ambientData = useMemo(() => new Float32Array(AERIAL_LUT_WIDTH * rows * 4), [rows])
  const transmittanceData = useMemo(() => new Float32Array(AERIAL_LUT_WIDTH * rows * 4), [rows])

  const makeTexture = (data: Float32Array<ArrayBuffer>): DataTexture => {
    const map = new DataTexture(data, AERIAL_LUT_WIDTH, rows, RGBAFormat, FloatType)
    map.minFilter = LinearFilter
    map.magFilter = LinearFilter
    map.wrapS = ClampToEdgeWrapping
    map.wrapT = ClampToEdgeWrapping
    map.generateMipmaps = false
    map.needsUpdate = true
    return map
  }

  const scattered = useMemo(() => makeTexture(scatteredData), [scatteredData])
  const ambient = useMemo(() => makeTexture(ambientData), [ambientData])
  const transmittance = useMemo(() => makeTexture(transmittanceData), [transmittanceData])

  /** Tampon de construction : les textures ne recoivent qu'une table complete. */
  const pending = useMemo<AerialLut>(() => createAerialLut(), [])

  // --- La table de ciel lunaire ------------------------------------------
  const moonData = useMemo(() => new Float32Array(MOON_SKY_WIDTH * MOON_SKY_HEIGHT * 4), [])
  const moonPending = useMemo(() => new Float32Array(MOON_SKY_WIDTH * MOON_SKY_HEIGHT * 4), [])
  const moonSky = useMemo(() => {
    const texture = new DataTexture(moonData, MOON_SKY_WIDTH, MOON_SKY_HEIGHT, RGBAFormat, FloatType)
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.wrapS = ClampToEdgeWrapping
    texture.wrapT = ClampToEdgeWrapping
    texture.generateMipmaps = false
    texture.needsUpdate = true
    return texture
  }, [moonData])
  const moonState = useRef({
    altitude: Number.NaN,
    elevation: Number.NaN,
    turbidity: Number.NaN,
    /** Ligne suivante a construire, ou −1 si aucune construction n'est en cours. */
    row: -1,
    pendingAltitude: 0,
  })
  useEffect(() => () => moonSky.dispose(), [moonSky])

  const state = useRef({
    altitude: Number.NaN,
    elevation: Number.NaN,
    turbidity: Number.NaN,
    cleared: false,
    /** Ligne suivante a construire, ou −1 si aucune construction n'est en cours. */
    pendingRow: -1,
    pendingAltitude: 0,
    pendingElevation: 0,
    pendingTurbidity: 1,
    pendingDistanceAu: 1,
    pendingOzoneDu: 300,
    /** Entree suivante de diffusion multiple, ou −1 si cette table est a jour. */
    pendingMsEntry: -1,
  })

  useEffect(
    () => () => {
      scattered.dispose()
      ambient.dispose()
      transmittance.dispose()
    },
    [scattered, ambient, transmittance],
  )

  // Les materiaux exterieurs a l'arbre du fond de ciel lisent cet objet.
  aerialTextures.scattered = scattered
  aerialTextures.ambient = ambient
  aerialTextures.transmittance = transmittance
  aerialTextures.observerRadiusM = EARTH_MEAN_RADIUS_M + observerElevationM

  useFrame(() => {
    const current = state.current

    // --- La table de colonne, avant tout le reste ---------------------------
    // La perspective atmospherique et la diffusion multiple la lisent toutes
    // deux : rien ne peut demarrer avant qu'elle soit complete. Elle est donc
    // construite en premier, et par tranches, pour ne pas bloquer une image.
    if (enabled && !columnLutReady()) {
      advanceColumnLut()
      return
    }

    if (!enabled) {
      // Une table neutre plutot qu'un drapeau dans le nuanceur : la vue depuis
      // l'espace est un cas du modele, pas une exception a traiter a part.
      // Rien de diffuse, et une transmittance unite — l'objet est vu tel quel.
      if (!current.cleared) {
        scatteredData.fill(0)
        ambientData.fill(0)
        transmittanceData.fill(1)
        scattered.needsUpdate = true
        ambient.needsUpdate = true
        transmittance.needsUpdate = true
        current.cleared = true
        current.altitude = Number.NaN
        current.turbidity = Number.NaN
        current.pendingRow = -1
        current.pendingMsEntry = -1
      }
      return
    }

    // --- La table de diffusion multiple d'abord ----------------------------
    // Elle est en amont : la perspective atmospherique la lit. La reconstruire
    // pendant qu'une table s'appuie dessus donnerait un degrade mi-ancien
    // mi-nouveau, visible comme une bande horizontale.
    //
    // Une construction en cours n'est **jamais interrompue**, meme si le trouble
    // rebouge. Un glissement de curseur change la valeur a chaque image :
    // relancer a chaque fois signifierait ne jamais finir, et le ciel resterait
    // fige sur la table initiale.
    //
    // ## ⚠️ Pourquoi la premiere passe est traitee a part
    //
    // La table calcule un **ordre de diffusion par passe**, et il en faut trois.
    // Les attendre toutes avant de construire le ciel repoussait son apparition
    // a douze secondes apres le chargement — six pour la table, une pour le
    // ciel, le reste pour la page.
    //
    // Or la premiere passe suffit a rendre la table **utilisable** : c'est le
    // premier ordre de diffusion, un ciel un peu trop sombre mais juste dans sa
    // forme. On la construit donc en priorite, on laisse le ciel se batir
    // dessus, et les passes suivantes reprennent ensuite — le ciel se
    // reconstruisant une derniere fois quand la table est complete.
    //
    // Le sequencement garantit qu'une construction de ciel ne chevauche
    // **jamais** une passe : c'est ce qui evite la bande horizontale ci-dessus,
    // sans avoir a figer une copie de la table.
    const msIncomplete = current.pendingMsEntry >= 0 && multipleScattering !== null
    const msUnusable = msIncomplete && multipleScattering !== null && multipleScattering.pass === 0
    const skyBusy = current.pendingRow >= 0

    if (multipleScattering && msIncomplete && (msUnusable || !skyBusy)) {
      const total = multipleScattering.width * multipleScattering.height
      const to = Math.min(total, current.pendingMsEntry + MS_ENTRIES_PER_FRAME)
      fillMultipleScatteringEntries(multipleScattering, GRID, current.pendingMsEntry, to, {
        columnLut: sharedColumnLut(),
        aerosols: sharedAerosolOptics(multipleScatteringTurbidity),
      })
      if (to < total) {
        current.pendingMsEntry = to
        return
      }
      // ⚠️ **Une passe achevee doit etre publiee.** La table ne se construit plus
      // d'un coup : elle calcule un ordre de diffusion a la fois, dans un tampon
      // separe, et `commit` l'ajoute au total avant d'ouvrir le suivant.
      // L'oublier laisse `Ψ_ms` a zero — plus de diffusion multiple du tout, et
      // l'ombre de la Terre devient un mur noir au crepuscule.
      commitMultipleScatteringPass(multipleScattering)
      if (multipleScattering.pass < multipleScatteringPasses(multipleScattering)) {
        current.pendingMsEntry = 0
      } else {
        // Table complete : le ciel bati sur les ordres partiels doit etre refait.
        current.pendingMsEntry = -1
        current.altitude = Number.NaN
      }
      return
    }

    // --- Une construction est-elle en cours ? ------------------------------
    if (current.pendingRow >= 0) {
      const to = Math.min(AERIAL_LUT_HEIGHT, current.pendingRow + ROWS_PER_FRAME)
      fillAerialRows(pending, GRID, current.pendingAltitude, current.pendingRow, to, {
        observerElevationM: current.pendingElevation,
        distanceAu: current.pendingDistanceAu,
        ozoneColumnDobsonUnits: current.pendingOzoneDu,
        columnLut: sharedColumnLut(),
        aerosols: sharedAerosolOptics(current.pendingTurbidity),
        multipleScattering: multipleScattering ?? undefined,
      })
      current.pendingRow = to

      if (to >= AERIAL_LUT_HEIGHT) {
        // La table n'est publiee qu'entiere : pendant la construction, le ciel
        // continue d'afficher la precedente.
        scatteredData.set(pending.scattered)
        ambientData.set(pending.ambient)
        transmittanceData.set(pending.transmittance)
        // La luminance moyenne est relevee **au moment de la publication**, sur
        // la table complete : elle decrit donc exactement le ciel qui va
        // s'afficher, pas celui d'avant ni un a moitie construit.
        aerialTextures.meanSkyLuminanceCdPerM2 = measureMeanSkyLuminance(pending)
        aerialTextures.skyIrradiance = measureSkyIrradiance(pending)
        scattered.needsUpdate = true
        ambient.needsUpdate = true
        transmittance.needsUpdate = true
        current.altitude = current.pendingAltitude
        current.elevation = current.pendingElevation
        current.turbidity = current.pendingTurbidity
        current.cleared = false
        current.pendingRow = -1
      }
      return
    }

    // --- Faut-il en lancer une ? -------------------------------------------
    const moved = Math.abs(sunAltitudeDeg - current.altitude)
    const sameSite = observerElevationM === current.elevation
    const sameAir = aerosolTurbidity === current.turbidity
    if (!current.cleared && sameSite && sameAir && moved < SUN_MOVEMENT_THRESHOLD_DEG) return

    // Le trouble a bouge : la diffusion multiple doit etre refaite avant la
    // perspective atmospherique qui s'en sert.
    if (aerosolTurbidity !== multipleScatteringTurbidity) {
      multipleScattering = createMultipleScatteringLut(GRID, {
        width: MS_LUT_WIDTH,
        height: MS_LUT_HEIGHT,
      })
      multipleScatteringTurbidity = aerosolTurbidity
      current.pendingMsEntry = 0
      return
    }

    current.pendingAltitude = sunAltitudeDeg
    current.pendingElevation = observerElevationM
    current.pendingTurbidity = aerosolTurbidity
    // Ces deux-la n'ont pas besoin de declencher une reconstruction : la
    // distance solaire varie de 7 % sur une **annee**, la colonne d'ozone sur
    // une **saison**, quand le Soleil franchit le quart de degre en une minute.
    // Ils sont simplement pris a leur valeur du moment.
    current.pendingDistanceAu = sunDistanceAu
    current.pendingOzoneDu = ozoneColumnDobsonUnits
    current.pendingRow = 0
  })

  /**
   * Le ciel lunaire, servi **en dernier**.
   *
   * Sa propre boucle plutot qu'une branche de la precedente : celle-ci sort tot
   * dans le cas courant — Soleil immobile, rien a refaire — et la table lunaire
   * n'y serait jamais atteinte. Les priorites restent celles-ci : la colonne,
   * puis la diffusion multiple, puis le ciel solaire, puis la Lune.
   */
  useFrame(() => {
    const m = moonState.current

    // Lune couchee, atmosphere coupee, ou colonne pas encore prete : rien a
    // ajouter. Le facteur tombe a zero et le nuanceur n'echantillonne plus.
    if (!enabled || moon.altitudeDeg <= 0 || moon.irradianceRatio <= 0 || !columnLutReady()) {
      moonSkyTextures.scale = 0
      m.altitude = Number.NaN
      m.row = -1
      return
    }

    // Le facteur suit la phase **sans attendre** la table : il ne depend que de
    // la photometrie, quand la table ne porte que la geometrie.
    moonSkyTextures.scale = moon.irradianceRatio

    if (m.row >= 0) {
      const to = Math.min(MOON_SKY_HEIGHT, m.row + MOON_ROWS_PER_FRAME)
      fillSkyViewRows(moonPending, GRID, m.pendingAltitude, MOON_SKY_WIDTH, MOON_SKY_HEIGHT, m.row, to, {
        observerElevationM,
        ozoneColumnDobsonUnits,
        columnLut: sharedColumnLut(),
        aerosols: sharedAerosolOptics(aerosolTurbidity),
        multipleScattering: multipleScattering ?? undefined,
      })
      m.row = to
      if (to >= MOON_SKY_HEIGHT) {
        // Publiee entiere, comme les autres : pendant la construction, c'est la
        // precedente qui reste affichee.
        moonData.set(moonPending)
        moonSky.needsUpdate = true
        moonSkyTextures.texture = moonSky
        // Relevee **au moment de la publication**, sur la table complete : elle
        // decrit donc exactement le ciel qui va s'afficher.
        moonSkyTextures.meanLuminanceCdPerM2 = measureMoonSkyLuminance(moonData)
        m.altitude = m.pendingAltitude
        m.elevation = observerElevationM
        m.turbidity = aerosolTurbidity
        m.row = -1
      }
      return
    }

    const moved = Math.abs(moon.altitudeDeg - m.altitude)
    const same = observerElevationM === m.elevation && aerosolTurbidity === m.turbidity
    if (same && moved < SUN_MOVEMENT_THRESHOLD_DEG) return

    m.pendingAltitude = moon.altitudeDeg
    m.row = 0
  })

  return aerialTextures
}
