/**
 * Diffraction par une ouverture — la limite ondulatoire de l'image.
 *
 * ## Ce que ce module ajoute au moteur
 *
 * La theorie de Mie de la phase 6 est deja de l'optique ondulatoire : elle
 * resout les equations de Maxwell autour d'une sphere, sans approximation. Ce
 * qui manquait, c'est l'autre bout de la chaine — **ce que devient un front
 * d'onde en entrant dans un instrument**, oeil compris.
 *
 * Une etoile est ponctuelle. Son image ne l'est jamais : une ouverture de
 * diametre fini impose une tache dont la largeur ne depend que de `λ/D`. C'est
 * une limite absolue, qu'aucune optique ne franchit.
 *
 * ## La tache d'Airy
 *
 *     I(θ) = [2·J₁(x)/x]²      avec  x = π·D·sin θ/λ
 *
 * `J₁` est la fonction de Bessel de premiere espece d'ordre 1. Le premier zero
 * tombe a `x = 3,8317`, soit
 *
 *     θ₁ = 1,220 · λ/D
 *
 * Le `1,220` n'est pas une constante choisie : c'est `3,8317/π`, et il sort du
 * premier zero de `J₁`. La validation le mesure plutot que de le supposer.
 *
 * ## La question que l'application pose reellement
 *
 * Le seeing vaut deux secondes d'arc (phase 15). Pourquoi les etoiles ne
 * paraissent-elles pas floues a l'oeil nu ?
 *
 * Parce que la pupille fait deux a sept millimetres, et que sa limite de
 * diffraction — plusieurs dizaines de secondes d'arc — **est bien plus grande
 * que le seeing**. L'oeil nu est limite par sa propre diffraction, pas par
 * l'atmosphere : il ne peut pas voir le flou atmospherique. Il voit en revanche
 * parfaitement la **scintillation**, qui est une variation d'intensite et non de
 * forme.
 *
 * Ce n'est pas ecrit : c'est la comparaison de deux grandeurs calculees
 * separement, et la suite de validation la mesure.
 *
 * Reference : Born, M. & Wolf, E. (1999), *Principles of Optics*, chapitre 8.
 */

/**
 * Fonction de Bessel `J₁`, par serie entiere puis developpement asymptotique.
 *
 * La serie converge vite pour un petit argument mais perd ses chiffres par
 * annulation au-dela de huit environ ; l'asymptotique prend alors le relais.
 * Le raccord se fait la ou les deux sont encore bonnes.
 */
export function besselJ1(x: number): number {
  const ax = Math.abs(x)
  if (ax < 8) {
    const y = x * x
    // Approximation rationnelle de Numerical Recipes, exacte a ~10⁻⁸ — bien
    // au-dela de ce qu'un profil d'intensite demande.
    const numerator =
      x *
      (72_362_614_232 +
        y * (-7_895_059_235 + y * (242_396_853.1 + y * (-2_972_611.439 + y * (15_704.4826 + y * -30.16036606)))))
    const denominator =
      144_725_228_442 +
      y * (2_300_535_178 + y * (18_583_304.74 + y * (99_447.43394 + y * (376.9991397 + y))))
    return numerator / denominator
  }
  const z = 8 / ax
  const y = z * z
  const xx = ax - 2.356194491
  const p =
    1 + y * (0.183105e-2 + y * (-0.3516396496e-4 + y * (0.2457520174e-5 + y * -0.240337019e-6)))
  const q =
    0.04687499995 + y * (-0.2002690873e-3 + y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)))
  const value = Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * p - z * Math.sin(xx) * q)
  return x < 0 ? -value : value
}

/** Premier zero de `J₁`, sans dimension — d'ou sort le fameux 1,22. */
export const FIRST_BESSEL_ZERO = 3.8317059702075123

/**
 * Intensite normalisee de la tache d'Airy, entre 0 et 1.
 *
 * `angleRad` est l'angle depuis l'axe, `apertureM` le diametre de l'ouverture.
 */
export function airyIntensity(angleRad: number, apertureM: number, lambdaNm: number): number {
  const x = (Math.PI * apertureM * Math.sin(angleRad)) / (lambdaNm * 1e-9)
  if (Math.abs(x) < 1e-9) return 1
  const value = (2 * besselJ1(x)) / x
  return value * value
}

/**
 * Rayon angulaire du premier anneau sombre, radians.
 *
 *     θ₁ = (premier zero de J₁ / π) · λ/D = 1,220 · λ/D
 *
 * C'est le critere de Rayleigh : deux etoiles separees de moins que cela ne se
 * distinguent plus, quelle que soit la qualite de l'optique.
 */
export const airyFirstDarkRingRad = (apertureM: number, lambdaNm: number): number =>
  ((FIRST_BESSEL_ZERO / Math.PI) * (lambdaNm * 1e-9)) / apertureM

/**
 * Largeur a mi-hauteur de la tache d'Airy, radians.
 *
 * `≈ 1,029 λ/D`, a comparer au `0,98 λ/r₀` du seeing. Les deux expressions se
 * ressemblent parce qu'elles decrivent la meme chose — la largeur d'une tache
 * imposee par une longueur de coherence — l'une par l'ouverture, l'autre par
 * l'atmosphere.
 */
export const airyFwhmRad = (apertureM: number, lambdaNm: number): number =>
  (1.028_987 * (lambdaNm * 1e-9)) / apertureM

/**
 * Diametre de pupille de l'oeil, m.
 *
 * De deux millimetres en plein jour a sept dans le noir complet, et davantage
 * chez l'enfant. C'est cette variation qui fait passer la limite de diffraction
 * de l'oeil de soixante-dix a vingt secondes d'arc.
 *
 * ⚠️ **Valeurs d'usage, non mesurees ici.** La pupille depend de la luminance
 * ambiante, de l'age et de l'individu ; les bornes retenues sont celles que
 * cite la litterature physiologique.
 */
export const EYE_PUPIL_DAY_M = 0.002
export const EYE_PUPIL_NIGHT_M = 0.007

export interface ResolutionLimit {
  /** Limite de diffraction de l'ouverture, radians. */
  diffractionRad: number
  /** Largeur imposee par la turbulence, radians. */
  seeingRad: number
  /** Ce qui l'emporte reellement. */
  effectiveRad: number
  /** L'instrument est-il limite par sa propre diffraction ? */
  diffractionLimited: boolean
}

/**
 * Qui, de l'ouverture ou de l'atmosphere, limite l'image.
 *
 * La tache resultante est prise comme la somme quadratique des deux largeurs :
 * c'est l'approximation usuelle pour deux elargissements independants, et elle
 * est exacte pour des profils gaussiens.
 *
 * ⚠️ Ni la tache d'Airy ni la tache de seeing ne sont gaussiennes. La somme
 * quadratique est donc une **approximation de convolution**, correcte a
 * quelques pour cent pres au voisinage du croisement et exacte loin de lui, la
 * ou l'un des deux termes domine.
 */
export function resolutionLimit(
  apertureM: number,
  lambdaNm: number,
  atmosphericSeeingRad: number,
): ResolutionLimit {
  const diffraction = airyFwhmRad(apertureM, lambdaNm)
  const effective = Math.hypot(diffraction, atmosphericSeeingRad)
  return {
    diffractionRad: diffraction,
    seeingRad: atmosphericSeeingRad,
    effectiveRad: effective,
    diffractionLimited: diffraction > atmosphericSeeingRad,
  }
}

/**
 * Diametre d'ouverture au-dela duquel l'atmosphere l'emporte, m.
 *
 * En dessous, agrandir l'instrument ameliore la resolution ; au-dessus, cela
 * n'apporte plus que de la lumiere. Le seuil est de l'ordre de `r₀` — ce qui est
 * la definition meme du parametre de Fried, retrouvee ici par un autre chemin.
 */
export const seeingLimitedAperture = (lambdaNm: number, atmosphericSeeingRad: number): number =>
  (1.028_987 * (lambdaNm * 1e-9)) / atmosphericSeeingRad
