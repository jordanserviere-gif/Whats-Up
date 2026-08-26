/**
 * Table de ciel physique, tenue a jour et exposee au rendu comme texture.
 *
 * ## Ce qui arrive a l'ecran
 *
 * Toute la chaine des phases 1 a 5 — atmosphere standard, spectre solaire,
 * sections efficaces de Rayleigh, transport oblique, diffusion simple — est
 * evaluee ici, sur le processeur, pour deux mille directions. Le nuanceur du
 * fond de ciel n'integre plus rien : il echantillonne.
 *
 * ## Le rythme de reconstruction
 *
 * La table depend du Soleil, donc de l'heure. Elle est reconstruite quand la
 * hauteur solaire a bouge d'un quart de degre — environ une minute de temps
 * reel, bien en dessous de ce que l'oeil distingue sur un degrade de ciel.
 *
 * ## La reconstruction est etalee
 *
 * Construire les deux mille directions d'un coup coute une quarantaine de
 * millisecondes. Imperceptible une fois par minute en temps reel, mais en
 * avance rapide le Soleil franchit le seuil plusieurs fois par seconde, et la
 * mesure montrait alors un 95ᵉ centile de 50 ms — un hoquet net.
 *
 * Le travail est donc **etale sur plusieurs images**, quelques lignes a la
 * fois, dans un tampon separe. La texture ne change qu'une fois la table
 * complete : pas de dechirure, et le ciel affiche l'ancienne table pendant la
 * construction de la nouvelle.
 *
 * Le prix est un retard de quelques images sur la position du Soleil. Il est
 * invisible, et de toute facon sans objet : personne ne juge la couleur d'un
 * ciel qui defile en accelere.
 *
 * ## Format
 *
 * `RGBA` en flottant simple. La quatrieme composante est inutilisee : WebGL2
 * ne garantit pas les textures flottantes a trois canaux, et payer un canal
 * mort coute moins cher qu'un chemin de repli.
 *
 * Le filtrage lineaire sur flottant simple demande `OES_texture_float_linear`,
 * presente sur la machine de reference. **Sur mobile, le demi-flottant serait
 * le format sur** — a prevoir avant tout deploiement iOS.
 */
import { useEffect, useMemo, useRef } from 'react'
import { ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, RGBAFormat, Vector2 } from 'three'
import { useFrame } from '@react-three/fiber'
import { buildColumnLut, type ColumnLut } from '@/atmosphere/lut/transmittanceLut'
import {
  CONTINENTAL_AEROSOL,
  aerosolOptics,
  aodFromTurbidity,
  withAod,
  type AerosolOptics,
} from '@/atmosphere/mie/aerosol'
import { fillSkyViewRows } from '@/atmosphere/lut/skyViewLut'
import { uniformSpectralGrid } from '@/atmosphere/spectral/SpectralGrid'

/** Dimensions de la table. Mesure : 1 a 3 niveaux d'ecart avec le solveur direct. */
export const SKY_LUT_WIDTH = 64
export const SKY_LUT_HEIGHT = 32

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

/** Deplacement du Soleil au-dela duquel la table est refaite, degres. */
const SUN_MOVEMENT_THRESHOLD_DEG = 0.25

/**
 * Lignes construites par image.
 *
 * Quatre lignes sur trente-deux : huit images pour une table complete, environ
 * cinq millisecondes chacune. Assez peu pour tenir dans le budget d'une image a
 * 60 Hz, assez pour que le ciel suive un lever de Soleil sans trainer.
 */
const ROWS_PER_FRAME = 4

/**
 * Table de colonne moleculaire, partagee par toutes les reconstructions.
 *
 * Elle ne depend ni de l'heure, ni du lieu, ni du Soleil : une seule
 * construction pour toute la duree de vie de l'application. Construite
 * paresseusement pour ne pas peser sur le premier affichage.
 */
let columnLut: ColumnLut | null = null
const sharedColumnLut = (): ColumnLut => {
  if (!columnLut) columnLut = buildColumnLut({ aerosolScaleHeightM: CONTINENTAL_AEROSOL.scaleHeightM })
  return columnLut
}

export interface SkyViewTexture {
  texture: DataTexture
  size: Vector2
}

/**
 * Texture de ciel, reconstruite quand le Soleil bouge.
 *
 * `enabled` a faux laisse la texture a zero : c'est la vue depuis l'espace,
 * sans atmosphere.
 */
export function useSkyViewLut(
  sunAltitudeDeg: number,
  observerElevationM: number,
  aerosolTurbidity: number,
  enabled: boolean,
): SkyViewTexture {
  // Le tampon est garde a part : le type de `DataTexture.image.data` est
  // l'union de tous les tableaux typees possibles, et le retrouver a chaque
  // image demanderait une assertion que rien ne garantit.
  const data = useMemo(() => new Float32Array(SKY_LUT_WIDTH * SKY_LUT_HEIGHT * 4), [])

  const texture = useMemo(() => {
    const map = new DataTexture(data, SKY_LUT_WIDTH, SKY_LUT_HEIGHT, RGBAFormat, FloatType)
    map.minFilter = LinearFilter
    map.magFilter = LinearFilter
    map.wrapS = ClampToEdgeWrapping
    map.wrapT = ClampToEdgeWrapping
    map.generateMipmaps = false
    map.needsUpdate = true
    return map
  }, [data])

  const size = useMemo(() => new Vector2(SKY_LUT_WIDTH, SKY_LUT_HEIGHT), [])

  /** Tampon de construction : la texture ne recoit qu'une table complete. */
  const pending = useMemo(() => new Float32Array(SKY_LUT_WIDTH * SKY_LUT_HEIGHT * 4), [])

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
  })

  useEffect(() => () => texture.dispose(), [texture])

  useFrame(() => {
    if (!enabled) {
      // Une table nulle plutot qu'un drapeau dans le nuanceur : la vue depuis
      // l'espace est un cas du modele, pas une exception a traiter a part.
      if (!state.current.cleared) {
        data.fill(0)
        texture.needsUpdate = true
        state.current.cleared = true
        state.current.altitude = Number.NaN
        state.current.turbidity = Number.NaN
        state.current.pendingRow = -1
      }
      return
    }

    const current = state.current

    // --- Une construction est-elle en cours ? ------------------------------
    if (current.pendingRow >= 0) {
      const to = Math.min(SKY_LUT_HEIGHT, current.pendingRow + ROWS_PER_FRAME)
      fillSkyViewRows(
        pending,
        GRID,
        current.pendingAltitude,
        SKY_LUT_WIDTH,
        SKY_LUT_HEIGHT,
        current.pendingRow,
        to,
        {
          observerElevationM: current.pendingElevation,
          columnLut: sharedColumnLut(),
          aerosols: sharedAerosolOptics(current.pendingTurbidity),
        },
      )
      current.pendingRow = to

      if (to >= SKY_LUT_HEIGHT) {
        // La table n'est publiee qu'entiere : pendant la construction, le ciel
        // continue d'afficher la precedente.
        data.set(pending)
        texture.needsUpdate = true
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

    current.pendingAltitude = sunAltitudeDeg
    current.pendingElevation = observerElevationM
    current.pendingTurbidity = aerosolTurbidity
    current.pendingRow = 0
  })

  return { texture, size }
}
