/**
 * Mirages — la fonction de transfert d'une couche d'inversion.
 *
 * ## Ce qu'est vraiment un mirage
 *
 * Ce n'est pas une image « reflechie » : rien ne reflechit. C'est le meme rayon
 * lumineux, courbe assez fort par un gradient d'indice inverse pour redescendre
 * vers l'observateur apres etre parti vers le bas — ou l'inverse. L'oeil, qui
 * suppose les rayons droits, attribue alors l'image a la direction d'ou elle
 * arrive.
 *
 * D'ou la grandeur qui decrit tout : **la fonction de transfert**, qui a une
 * direction de visee associe la direction d'ou vient effectivement la lumiere.
 *
 *     visee (ce que l'oeil croit regarder)  →  sortie (d'ou vient la lumiere)
 *
 * Dans une atmosphere standard, cette fonction est croissante et proche de
 * l'identite : viser plus haut, c'est voir plus haut. **Un mirage, c'est
 * exactement le moment ou elle cesse d'etre monotone** — deux visees differentes
 * ramenent alors la meme portion de ciel, et l'objet est vu deux fois, dont une
 * a l'envers.
 *
 * ## Pourquoi c'est calculable
 *
 * Une trace complete coute 22 ms : hors de question par pixel. Mais le mirage se
 * joue **dans les premieres dizaines de metres**, la ou le gradient est inverse.
 * Au-dessus, le rayon reprend une refraction ordinaire, deja tabulee depuis la
 * phase 11.
 *
 * On ne trace donc que la couche limite, puis on raccorde : la refraction totale
 * est celle de la couche, plus celle du reste de l'atmosphere lue dans la table.
 * Le cout tombe de trois ordres de grandeur.
 *
 * ## Ce que la table porte
 *
 * Elle est construite pour **un azimut**. Une dalle surchauffee n'est pas
 * symetrique — c'est meme sa raison d'etre — et regarder la route ou regarder le
 * champ a cote ne donne pas le meme mirage. Le rendu en demanderait une par
 * secteur ; la validation en construit une a la fois.
 */
import { EARTH_MEAN_RADIUS_M, radToDeg } from '../core/units'
import { sharedRefractionTable, trueFromTable } from '../refraction/refractionTable'
import { altitudeOf, type AtmosphereField } from './AtmosphereField'
import { traceRay, type RayTraceOptions } from './rayTracer'

const RADIUS = EARTH_MEAN_RADIUS_M

export interface MirageTransferOptions extends RayTraceOptions {
  observerElevationM?: number
  azimuthRad?: number
  /** Bornes de visee, degres — l'interessant est sous et juste au-dessus de zero. */
  minApparentDeg?: number
  maxApparentDeg?: number
  count?: number
  /**
   * Sommet de la couche etudiee, m.
   *
   * Au-dessus, le gradient a repris son signe normal et la refraction
   * redevient celle de la table. Le raccord se fait la.
   */
  layerTopM?: number
}

export interface MirageTransfer {
  /** Hauteurs de visee, degres — croissantes. */
  readonly apparentDeg: Float64Array
  /**
   * Hauteur de la direction d'ou vient la lumiere, degres.
   *
   * `NaN` quand le rayon rencontre le sol : il n'y a alors pas de ciel dans
   * cette direction, mais le sol lui-meme.
   */
  readonly sourceDeg: Float64Array
  /** Altitude minimale atteinte par le rayon, m — negative s'il touche le sol. */
  readonly lowestM: Float64Array
  readonly azimuthRad: number
  readonly observerElevationM: number
}

/**
 * Construit la fonction de transfert.
 *
 * Chaque visee est tracee jusqu'au sommet de la couche, puis prolongee par la
 * refraction ordinaire. Le resultat est la hauteur de la direction d'ou vient
 * reellement la lumiere.
 */
export function buildMirageTransfer(
  field: AtmosphereField,
  options: MirageTransferOptions = {},
): MirageTransfer {
  const {
    observerElevationM = 1.7,
    azimuthRad = 0,
    minApparentDeg = -0.6,
    maxApparentDeg = 0.6,
    count = 241,
    layerTopM = 60,
    minStepM = 0.05,
    stepPerAltitude = 0.01,
    gradientStepM = 0.05,
    maxSteps = 400_000,
  } = options

  const table = sharedRefractionTable(Math.round(layerTopM))
  const apparentDeg = new Float64Array(count)
  const sourceDeg = new Float64Array(count)
  const lowestM = new Float64Array(count)

  for (let i = 0; i < count; i++) {
    const apparent = minApparentDeg + ((maxApparentDeg - minApparentDeg) * i) / (count - 1)
    apparentDeg[i] = apparent

    let lowest = observerElevationM
    const probe: AtmosphereField = {
      refractiveIndexAt: (x, y, z) => {
        const altitude = altitudeOf(x, y, z)
        if (altitude < lowest) lowest = altitude
        return field.refractiveIndexAt(x, y, z)
      },
    }

    const angle = (apparent * Math.PI) / 180
    const cos = Math.cos(angle)
    const result = traceRay(
      probe,
      [0, RADIUS + observerElevationM, 0],
      [cos * Math.sin(azimuthRad), Math.sin(angle), -cos * Math.cos(azimuthRad)],
      { minStepM, stepPerAltitude, gradientStepM, maxSteps, topAltitudeM: layerTopM },
    )

    lowestM[i] = lowest

    if (!result.escaped) {
      // Le rayon a rencontre le sol : ce n'est pas du ciel qu'on voit dans
      // cette direction, c'est la surface.
      sourceDeg[i] = Number.NaN
      continue
    }

    // Hauteur de la direction en sortant de la couche, puis prolongement par la
    // refraction ordinaire du reste de l'atmosphere.
    // --- Le raccord, et le terme qu'il ne faut pas oublier ------------------
    //
    // Deux repere differents. `trueFromTable` travaille dans le repere du point
    // ou elle est evaluee ; l'angle de sortie doit donc etre mesure sur la
    // **verticale locale** du point de sortie, et non sur l'axe Y global.
    //
    // Mais cela ne suffit pas : entre l'observateur et la sortie, le rayon a
    // parcouru des kilometres a l'horizontale, et **la verticale locale a
    // tourne** de l'angle geocentrique correspondant. Une meme direction du ciel
    // n'a donc pas la meme hauteur dans les deux reperes — elle est plus haute
    // au point de sortie, exactement de cet angle.
    //
    // L'oublier fait deriver le raccord en `√(sommet de couche)`, puisque la
    // distance horizontale pour monter a une hauteur `h` vaut `√(2Rh)` : 350,
    // 575 et 1001 secondes d'arc pour des sommets de 8, 20 et 60 metres, la ou
    // le decoupage devrait etre indifferent.
    const radius = Math.hypot(result.position[0], result.position[1], result.position[2]) || 1
    const norm = Math.hypot(result.direction[0], result.direction[1], result.direction[2]) || 1
    const alongVertical =
      (result.position[0] * result.direction[0] +
        result.position[1] * result.direction[1] +
        result.position[2] * result.direction[2]) /
      (radius * norm)
    const leaving = radToDeg(Math.asin(Math.max(-1, Math.min(1, alongVertical))))

    // Rotation de la verticale entre l'observateur et le point de sortie.
    const startRadius = RADIUS + observerElevationM
    const cosTravel =
      (result.position[1] * startRadius) / (radius * startRadius) // observateur sur +Y
    const travelDeg = radToDeg(Math.acos(Math.max(-1, Math.min(1, cosTravel))))
    // `leaving` est une direction de **visee** vue du sommet de la couche : la
    // lumiere vient donc de plus **bas**, et c'est `trueFromTable` qu'il faut,
    // non `apparentFromTable`. Prendre l'un pour l'autre ajoute la refraction la
    // ou il faut la retrancher — la premiere version le faisait, et le resultat
    // derivait de soixante-quinze secondes d'arc selon le sommet choisi, ce que
    // le raccord aurait du rendre indifferent.
    sourceDeg[i] = trueFromTable(table, leaving) - travelDeg
  }

  return { apparentDeg, sourceDeg, lowestM, azimuthRad, observerElevationM }
}

export interface MirageAnalysis {
  /** La fonction de transfert cesse-t-elle d'etre croissante ? */
  readonly multivalued: boolean
  /** Bornes de visee ou le rayon se retourne au lieu de toucher le sol, degres. */
  readonly turningBandDeg: [number, number] | null
  /** Amplitude de la portion decroissante, degres — l'epaisseur de l'image inversee. */
  readonly invertedSpanDeg: number
  /** Nombre d'images distinctes vues au maximum. */
  readonly maxImages: number
}

/**
 * Ce que la fonction de transfert raconte.
 *
 * Trois signatures, dans l'ordre ou elles apparaissent quand l'inversion se
 * renforce :
 *
 * 1. **La bande de retournement** : des visees sous l'horizon qui rendent du
 *    ciel au lieu du sol. C'est deja la « flaque d'eau » sur une route seche —
 *    en realite l'image du ciel, ramenee vers l'oeil.
 * 2. **La perte de monotonie** : la fonction redescend. Deux visees voisines
 *    ramenent alors la meme portion de ciel, et l'image est doublee.
 * 3. **L'image inversee** : la portion decroissante, dont l'epaisseur donne la
 *    hauteur apparente du reflet.
 */
export function analyseMirage(transfer: MirageTransfer): MirageAnalysis {
  const { apparentDeg, sourceDeg, lowestM } = transfer
  const count = apparentDeg.length

  // --- Bande de retournement ---------------------------------------------
  let bandStart = Number.NaN
  let bandEnd = Number.NaN
  for (let i = 0; i < count; i++) {
    // Un rayon qui descend sous l'oeil, remonte, et sort : il s'est retourne.
    const turned = Number.isFinite(sourceDeg[i]) && lowestM[i] < transfer.observerElevationM - 1e-6
    if (turned && apparentDeg[i] < 0) {
      if (Number.isNaN(bandStart)) bandStart = apparentDeg[i]
      bandEnd = apparentDeg[i]
    }
  }
  const turningBandDeg: [number, number] | null = Number.isNaN(bandStart) ? null : [bandStart, bandEnd]

  // --- Monotonie ------------------------------------------------------------
  let invertedSpan = 0
  let multivalued = false
  let previousIndex = -1
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(sourceDeg[i])) continue
    if (previousIndex >= 0 && sourceDeg[i] < sourceDeg[previousIndex] - 1e-9) {
      multivalued = true
      invertedSpan += apparentDeg[i] - apparentDeg[previousIndex]
    }
    previousIndex = i
  }

  // --- Nombre d'images ------------------------------------------------------
  // Une cible est vue autant de fois que la fonction de transfert prend sa
  // valeur. On compte les traversees d'un niveau, sur un echantillon de cibles.
  let maxImages = 1
  const finite = Array.from(sourceDeg).filter((v) => Number.isFinite(v))
  if (finite.length > 2) {
    const low = Math.min(...finite)
    const high = Math.max(...finite)
    for (let s = 0; s <= 64; s++) {
      const target = low + ((high - low) * s) / 64
      let crossings = 0
      let previous = Number.NaN
      for (let i = 0; i < count; i++) {
        const value = sourceDeg[i]
        if (!Number.isFinite(value)) {
          previous = Number.NaN
          continue
        }
        if (Number.isFinite(previous) && (previous - target) * (value - target) < 0) crossings++
        previous = value
      }
      maxImages = Math.max(maxImages, crossings)
    }
  }

  return { multivalued, turningBandDeg, invertedSpanDeg: invertedSpan, maxImages }
}
