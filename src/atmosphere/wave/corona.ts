/**
 * Couronnes — les anneaux colores autour du Soleil et de la Lune.
 *
 * ## Rien n'est ecrit ici
 *
 * Ce module ne dessine aucun anneau et n'en connait aucun rayon. Il calcule la
 * fonction de phase de Mie — la meme que celle de la phase 6, sans un
 * coefficient de plus — pour des gouttelettes de nuage, et **cherche ou elle
 * presente des maxima**.
 *
 * Que ces maxima existent, et qu'ils tombent la ou la diffraction les predit,
 * est un resultat du calcul et non une entree.
 *
 * ## Pourquoi une gouttelette et pas un aerosol
 *
 * La phase 6 traite des aerosols de 0,05 µm : leur parametre de taille vaut
 * moins d'un, et leur fonction de phase est lisse. Une gouttelette de nuage fait
 * dix microns — cent fois plus — et son parametre de taille atteint la centaine.
 * La fonction de phase y devient **oscillante**, et ce sont ces oscillations,
 * vues autour d'une source ponctuelle, qui forment les anneaux.
 *
 * C'est le meme solveur. Seule la taille change.
 *
 * ## Ce que la diffraction predit
 *
 * Aux petits angles, une sphere opaque diffracte comme un disque de meme
 * diametre : la fonction de phase suit une tache d'Airy de parametre
 * `x = π·d·sin θ/λ`. Le premier anneau sombre tombe donc a
 *
 *     θ₁ ≈ 1,22 · λ/d
 *
 * Pour `d = 10 µm` et `λ = 550 nm` : 0,067 rad, soit **3,8°**. C'est la taille
 * d'une couronne ordinaire, et elle se lit a l'envers — **mesurer le rayon d'une
 * couronne donne la taille des gouttelettes**.
 *
 * ## Pourquoi elles sont colorees
 *
 * Le rayon varie en `λ` : le bleu forme un anneau plus serre que le rouge. La
 * couronne est donc bleue a l'interieur et rouge a l'exterieur — l'inverse d'un
 * arc-en-ciel, ou la dispersion et non la diffraction commande.
 *
 * ## ⚠️ Ce que ce module ne fait pas
 *
 * Il ne rend pas les couronnes a l'ecran. Le voile atmospherique du moteur
 * suppose une **atmosphere claire** : ni nuage, ni gouttelette. Poser une
 * couronne demanderait une couche de nuage dans le transport, qui n'existe pas.
 *
 * Le calcul est ici parce que la physique y est, mesurable et verifiable.
 *
 * Reference : Bohren & Huffman (1983), chapitre 4 ; van de Hulst (1957),
 * *Light Scattering by Small Particles*, chapitre 8.
 */
import { mieCoefficients, mieEfficiencies, miePhaseFunction, sizeParameter } from '../mie/mie'

/**
 * Indice de refraction de l'eau liquide dans le visible.
 *
 * `1,333` a 550 nm, et la dispersion est faible — de 1,343 dans le violet a
 * 1,331 dans le rouge. La partie imaginaire est negligeable : l'eau est
 * transparente dans le visible, ce qui est precisement pourquoi les nuages sont
 * blancs et non gris.
 *
 * ⚠️ Valeur d'usage. La reference serait Hale & Querry (1973), qui tabule
 * l'indice de l'eau de l'ultraviolet a l'infrarouge lointain.
 */
export const WATER_REFRACTIVE_INDEX = { re: 1.333, im: 0 }

export interface CoronaRing {
  /** Rayon angulaire du maximum, radians. */
  angleRad: number
  /** Intensite relative de la fonction de phase en ce point. */
  intensity: number
}

export interface CoronaProfile {
  /** Angles echantillonnes, radians. */
  readonly angleRad: Float64Array
  /** Fonction de phase de Mie, sr⁻¹. */
  readonly phase: Float64Array
  /** Maxima locaux trouves, hors pic avant. */
  readonly rings: CoronaRing[]
  /** Premier minimum, radians — la bordure de l'aureole. */
  readonly firstDarkRingRad: number | null
}

/**
 * Calcule la fonction de phase d'une gouttelette et y **cherche** les anneaux.
 *
 * `dropletRadiusM` est le rayon, non le diametre : une gouttelette de nuage
 * ordinaire fait 5 a 10 µm de rayon.
 */
export function coronaProfile(
  dropletRadiusM: number,
  lambdaNm: number,
  maxAngleDeg = 20,
  samples = 1200,
  options: { sizeSpread?: number; sizeSamples?: number } = {},
): CoronaProfile {
  // --- Pourquoi une distribution de tailles, et non une seule gouttelette ---
  //
  // La fonction de phase d'une sphere **transparente** de parametre de taille
  // eleve porte une structure fine de resonances — les modes propres de la
  // gouttelette — superposee a l'enveloppe de diffraction. Sur une gouttelette
  // unique, le premier minimum peut donc etre une simple ondulation, et non
  // l'anneau.
  //
  // Un nuage reel n'est jamais monodisperse. La dispersion des tailles **lisse
  // ces resonances** tout en laissant l'enveloppe intacte : c'est precisement
  // pour cela que les couronnes observees ont des anneaux nets, et qu'une
  // couronne bien marquee signale un nuage a distribution etroite.
  //
  // Moyenner sur quelques pour cent de dispersion n'est donc pas un lissage de
  // confort : c'est ce qui manquait au modele.
  const { sizeSpread = 0.05, sizeSamples = 9 } = options

  const angleRad = new Float64Array(samples)
  const phase = new Float64Array(samples)
  const maxAngle = (maxAngleDeg * Math.PI) / 180
  for (let i = 0; i < samples; i++) angleRad[i] = (maxAngle * i) / (samples - 1)

  const count = sizeSpread > 0 ? Math.max(1, sizeSamples) : 1
  let weightTotal = 0
  for (let s = 0; s < count; s++) {
    // Gaussienne tronquee a deux ecarts-types, ponderee par sa densite.
    const offset = count > 1 ? (2 * (s / (count - 1)) - 1) * 2 : 0
    const weight = Math.exp(-0.5 * offset * offset)
    const radius = dropletRadiusM * (1 + sizeSpread * offset)
    if (!(radius > 0)) continue

    const x = sizeParameter(radius, lambdaNm)
    const coefficients = mieCoefficients(x, WATER_REFRACTIVE_INDEX)
    const { qSca } = mieEfficiencies(coefficients)
    for (let i = 0; i < samples; i++) {
      phase[i] += weight * miePhaseFunction(coefficients, Math.cos(angleRad[i]), qSca)
    }
    weightTotal += weight
  }
  if (weightTotal > 0) for (let i = 0; i < samples; i++) phase[i] /= weightTotal

  // --- Recherche des extrema ------------------------------------------------
  // Le pic avant, a angle nul, n'est pas un anneau : c'est l'aureole. Les
  // anneaux sont les maxima **suivants**, separes par des minima.
  let firstDarkRingRad: number | null = null
  const rings: CoronaRing[] = []
  for (let i = 1; i < samples - 1; i++) {
    const isMinimum = phase[i] < phase[i - 1] && phase[i] < phase[i + 1]
    const isMaximum = phase[i] > phase[i - 1] && phase[i] > phase[i + 1]
    if (isMinimum && firstDarkRingRad === null) firstDarkRingRad = angleRad[i]
    if (isMaximum && firstDarkRingRad !== null) {
      rings.push({ angleRad: angleRad[i], intensity: phase[i] })
    }
  }

  return { angleRad, phase, rings, firstDarkRingRad }
}

/**
 * Rayon du premier anneau sombre predit par la diffraction, radians.
 *
 *     θ₁ = 1,22 · λ/d        (d = diametre)
 *
 * C'est la **prediction**, a confronter a ce que le calcul de Mie donne
 * reellement. Les deux ne sont pas le meme calcul : l'un traite la gouttelette
 * comme un disque opaque, l'autre resout Maxwell autour d'une sphere
 * transparente.
 */
export const diffractionFirstDarkRingRad = (dropletRadiusM: number, lambdaNm: number): number =>
  (1.2196698912665045 * (lambdaNm * 1e-9)) / (2 * dropletRadiusM)

/**
 * Taille de gouttelette deduite d'un rayon de couronne observe, m.
 *
 * L'inverse de la relation precedente. C'est **l'usage historique** des
 * couronnes : avant les sondages, mesurer le rayon angulaire d'une couronne
 * lunaire etait un moyen d'estimer la taille des gouttelettes d'un nuage.
 */
export const dropletRadiusFromRing = (firstDarkRingRad: number, lambdaNm: number): number =>
  (1.2196698912665045 * (lambdaNm * 1e-9)) / (2 * firstDarkRingRad)
