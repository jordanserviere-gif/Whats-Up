/**
 * Courbure des rayons — la refraction atmospherique.
 *
 * ## Ce qui change, et pourquoi c'est structurel
 *
 * Jusqu'ici, tous les rayons du moteur etaient **droits**. C'est ce qui
 * interdisait a une classe entiere de phenomenes d'exister : le Soleil visible
 * alors qu'il est geometriquement couche, son disque aplati, le rayon vert, les
 * mirages. Aucun d'eux n'est un effet a peindre — ce sont tous des consequences
 * du fait qu'un rayon lumineux ne va pas droit dans un milieu dont l'indice
 * varie.
 *
 * ## L'invariant
 *
 * Dans une atmosphere a stratification spherique, la loi de Snell prend la forme
 * d'une constante le long du rayon (invariant de Bouguer) :
 *
 *     n(r) · r · sin z = L
 *
 * `z` etant l'angle entre le rayon et la verticale locale. Tout decoule de la :
 * connaissant `L` a l'observateur, on connait la direction du rayon a toute
 * altitude, sans avoir a integrer une equation differentielle vectorielle.
 *
 * La refraction totale est alors
 *
 *     R = −∫ tan z · (1/n)·(dn/dr) dr
 *
 * `dn/dr` etant negatif — l'air se rarefie en montant — la refraction est
 * positive : un astre parait **plus haut** qu'il n'est.
 *
 * ## La difficulte numerique, et son traitement
 *
 * A l'horizon, `z → 90°` et `tan z → ∞`. L'integrale reste finie — c'est une
 * singularite en racine carree, integrable — mais l'evaluer naivement diverge :
 * le premier pas de la marche rend l'infini.
 *
 * Le changement de variable `r = r₀ + w²` la **supprime exactement**. Pres de
 * l'observateur, `cos z ∝ w` : la tangente diverge en `1/w`, et le `2w dw` du
 * jacobien l'annule terme a terme. L'integrande devient regulier, et le meme
 * code traite l'horizon et le zenith sans cas particulier.
 *
 * Ce n'est pas une astuce numerique commode : c'est la seule facon d'obtenir la
 * refraction a l'horizon, qui est precisement la ou tous les phenomenes
 * interessants se produisent.
 *
 * ## Le profil d'indice est injectable
 *
 * `indexAt` est un parametre, pas une constante du module. L'atmosphere standard
 * en est le cas par defaut, et elle decroit toujours de facon monotone — elle ne
 * peut donc produire aucun mirage. Une **inversion de temperature** au ras d'une
 * surface chaude retourne localement le gradient, et c'est de la que sortiront
 * les mirages inferieurs. Le crochet est ici.
 *
 * Reference de methode : Auer, L. & Standish, E. M. (2000), *Astronomical
 * Refraction: Computational Method for All Zenith Angles*, Astron. J. 119, 2472.
 */
import { EARTH_MEAN_RADIUS_M, degToRad, radToDeg } from '../core/units'
import { ATMOSPHERE_TOP_M } from '../transport/slantPath'
import { airRefractiveIndex, standardAirIndexAt } from './airIndex'

const RADIUS = EARTH_MEAN_RADIUS_M

export interface RayBendingOptions {
  /** Altitude de l'observateur, m. */
  observerElevationM?: number
  /** Longueur d'onde, nm — la refraction est chromatique. */
  lambdaNm?: number
  /**
   * Profil d'indice `n(altitude)`. Par defaut l'atmosphere standard seche.
   *
   * C'est **le** point d'extension du module : un profil non monotone produit
   * des mirages, un profil mesure produit la refraction du jour.
   */
  indexAt?: (altitudeM: number) => number
  /**
   * Conditions au sol, si elles different de l'atmosphere standard.
   *
   * La refraction reelle en depend fortement : c'est la raison pour laquelle les
   * tables de refraction sont toutes publiees avec une temperature et une
   * pression de reference. Un air froid est plus dense, donc plus refringent.
   *
   * L'approximation retenue est celle des tables : **tout le profil est mis a
   * l'echelle** par le rapport des refractivites au sol. Elle suppose que la
   * structure verticale ne change pas, ce qui est faux dans le detail — mais la
   * refraction est dominee par les basses couches, et c'est la que la correction
   * porte.
   */
  surface?: { temperatureK: number; pressurePa: number; relativeHumidity?: number }
  /** Pas d'integration. */
  steps?: number
  /** Altitude au-dela de laquelle il n'y a plus rien a devier, m. */
  topAltitudeM?: number
}

/** Profil d'indice par defaut, memoise par longueur d'onde. */
const standardProfiles = new Map<number, (altitudeM: number) => number>()
export function standardIndexProfile(lambdaNm: number): (altitudeM: number) => number {
  const cached = standardProfiles.get(lambdaNm)
  if (cached) return cached
  const fn = (altitudeM: number) => standardAirIndexAt(altitudeM, lambdaNm)
  standardProfiles.set(lambdaNm, fn)
  return fn
}

/**
 * Profil standard remis a l'echelle des conditions du sol.
 *
 * La refractivite suit la densite : la mettre a l'echelle par le rapport des
 * refractivites au sol revient a corriger tout le profil du rapport `P/T`, et
 * l'humidite entre par le meme chemin.
 */
export function scaledIndexProfile(
  lambdaNm: number,
  surface: { temperatureK: number; pressurePa: number; relativeHumidity?: number },
): (altitudeM: number) => number {
  const base = standardIndexProfile(lambdaNm)
  const reference = base(0) - 1
  const actual =
    airRefractiveIndex(lambdaNm, {
      temperatureK: surface.temperatureK,
      pressurePa: surface.pressurePa,
      relativeHumidity: surface.relativeHumidity ?? 0,
    }) - 1
  const ratio = reference > 0 ? actual / reference : 1
  return (altitudeM: number) => 1 + (base(altitudeM) - 1) * ratio
}

/**
 * Refraction, en radians, pour une hauteur **apparente** donnee.
 *
 * C'est le sens naturel du calcul : l'invariant se fixe a partir de la direction
 * dans laquelle l'observateur regarde, et l'integrale suit le rayon vers le
 * haut. `apparentAltitudeDeg` est donc la hauteur a laquelle l'astre est **vu**,
 * et le resultat est ce qu'il faut lui retrancher pour retrouver sa hauteur
 * geometrique.
 */
export function refractionForApparent(
  apparentAltitudeDeg: number,
  options: RayBendingOptions = {},
): number {
  const {
    observerElevationM = 0,
    lambdaNm = 550,
    surface,
    indexAt = surface ? scaledIndexProfile(lambdaNm, surface) : standardIndexProfile(lambdaNm),
    steps = 512,
    topAltitudeM = ATMOSPHERE_TOP_M,
  } = options

  const r0 = RADIUS + observerElevationM
  const n0 = indexAt(observerElevationM)
  const invariant = n0 * r0 * Math.sin(degToRad(90 - apparentAltitudeDeg))

  if (apparentAltitudeDeg >= 0) {
    // Branche montante : le rayon s'eleve depuis l'observateur jusqu'a l'espace.
    return ascendingLeg(invariant, observerElevationM, topAltitudeM, indexAt, steps)
  }

  // --- Branche descendante -------------------------------------------------
  // Une visee sous l'horizon apparent n'est possible que depuis une certaine
  // hauteur. Le rayon **descend** d'abord, atteint un point tangent ou il est
  // horizontal, puis remonte vers l'espace. La refraction totale est donc la
  // somme de deux montees depuis ce point : celle qui rejoint l'espace, et celle
  // qui rejoint l'observateur.
  const tangent = tangentAltitude(invariant, observerElevationM, indexAt)
  if (tangent === null) return Number.NaN // le rayon rencontre le sol
  return (
    ascendingLeg(invariant, tangent, topAltitudeM, indexAt, steps) +
    ascendingLeg(invariant, tangent, observerElevationM, indexAt, steps)
  )
}

/**
 * Une montee, du bas vers le haut, avec la singularite du point de depart
 * regularisee par `r = r_bas + w²`.
 *
 * C'est le seul endroit ou l'integrale est reellement evaluee ; les deux
 * branches du rayon s'y ramenent, ce qui evite d'ecrire deux fois la meme
 * quadrature delicate.
 */
function ascendingLeg(
  invariant: number,
  fromAltitudeM: number,
  toAltitudeM: number,
  indexAt: (altitudeM: number) => number,
  steps: number,
): number {
  const span = toAltitudeM - fromAltitudeM
  if (!(span > 0)) return 0
  const wMax = Math.sqrt(span)
  const dw = wMax / steps

  // Pas de derivation du profil. Un metre est assez fin devant la hauteur
  // d'echelle de huit kilometres, et assez large pour que la difference ne se
  // perde pas dans les arrondis : `n−1` vaut 2,8·10⁻⁴, et sa variation sur un
  // metre 2,7·10⁻⁸ — encore douze chiffres significatifs au-dessus du flottant
  // double.
  const dh = 1

  let refraction = 0
  for (let i = 0; i < steps; i++) {
    // Point milieu : evite `w = 0`, ou la tangente est infinie et le jacobien
    // nul. Leur produit y est fini, mais leur evaluation separee ne l'est pas.
    const w = (i + 0.5) * dw
    const altitude = fromAltitudeM + w * w
    const r = RADIUS + altitude
    const n = indexAt(altitude)

    const sinZ = invariant / (n * r)
    // Au-dela de 1, le rayon a passe son point tangent — l'arrondi peut y mener
    // au depart exact d'une branche.
    if (!(sinZ < 1)) continue
    const tanZ = sinZ / Math.sqrt(1 - sinZ * sinZ)

    const dndr = (indexAt(altitude + dh) - indexAt(altitude - dh)) / (2 * dh)

    // `dr = 2w·dw` : c'est ce facteur qui annule la divergence de `tan z`.
    refraction += -tanZ * (dndr / n) * 2 * w * dw
  }

  return refraction
}

/**
 * Altitude du point tangent d'un rayon descendant, ou `null` s'il touche le sol.
 *
 * Le point tangent est la ou `n(r)·r = L` : le rayon y est horizontal. La
 * fonction `n(r)·r` croit normalement avec `r` — sa derivee vaut `n + r·dn/dr`,
 * soit `1 − 0,17` au niveau de la mer — ce qui rend la racine unique et la
 * dichotomie legitime.
 *
 * ⚠️ **Cette monotonie peut etre rompue.** Il faudrait `dn/dr < −1/r`, soit
 * −1,57·10⁻⁷ par metre contre −2,7·10⁻⁸ en temps normal : six fois le gradient
 * standard. Une inversion de surface forte l'atteint, et la racine cesse alors
 * d'etre unique — **c'est exactement la condition d'un mirage**, ou le meme
 * astre est vu par deux chemins. La dichotomie n'en trouve alors qu'une, et le
 * module ne rend qu'une des images.
 */
function tangentAltitude(
  invariant: number,
  observerElevationM: number,
  indexAt: (altitudeM: number) => number,
): number | null {
  const product = (altitudeM: number) => indexAt(altitudeM) * (RADIUS + altitudeM)
  if (product(0) > invariant) return null // le rayon rencontre le sol avant

  let low = 0
  let high = observerElevationM
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2
    if (product(mid) < invariant) low = mid
    else high = mid
  }
  return (low + high) / 2
}

/**
 * Depression de l'horizon, en degres, pour un observateur en hauteur.
 *
 * L'horizon **geometrique** est a `acos(R/(R+h))` sous l'horizontale : 0,19° a
 * 35 m, 3,1° a 10 km. La refraction le releve, parce qu'un rayon rasant se
 * courbe vers le bas et permet de voir un peu plus loin — d'ou une depression
 * apparente plus faible que la geometrique, et un horizon marin sensiblement
 * plus eloigne que la geometrie ne le voudrait.
 *
 * C'est la premiere grandeur du moteur qui exige la **branche descendante** du
 * rayon.
 */
export function horizonDipDeg(observerElevationM: number, options: RayBendingOptions = {}): number {
  if (!(observerElevationM > 0)) return 0
  const geometric = radToDeg(Math.acos(RADIUS / (RADIUS + observerElevationM)))

  // La visee qui rase le sol est celle dont le point tangent est a l'altitude
  // zero : son invariant vaut `n(0)·R`.
  const { lambdaNm = 550, surface } = options
  const indexAt =
    options.indexAt ?? (surface ? scaledIndexProfile(lambdaNm, surface) : standardIndexProfile(lambdaNm))
  const grazing = indexAt(0) * RADIUS
  const r0 = RADIUS + observerElevationM
  const sinZ = grazing / (indexAt(observerElevationM) * r0)
  if (!(sinZ < 1)) return geometric

  // La visee etant descendante, `z₀ > 90°` : la depression sous l'horizontale
  // vaut donc `z₀ − 90° = 90° − asin(sin z₀)`.
  //
  // Avec `n ≡ 1` partout, `sin z₀ = R/r₀` et le resultat redonne exactement
  // `acos(R/r₀)`, la depression geometrique. Un indice qui decroit avec
  // l'altitude augmente `sin z₀`, donc **abaisse** la depression : la refraction
  // repousse l'horizon.
  return 90 - radToDeg(Math.asin(sinZ))
}

/**
 * Hauteur apparente d'un astre dont on connait la hauteur **geometrique**.
 *
 * C'est le sens dont le rendu a besoin : l'ephemeride donne la position vraie,
 * l'oeil voit la position apparente. L'integrale, elle, part de l'apparente — il
 * faut donc inverser, ce que fait une recherche de racine.
 *
 * La fonction `a_vraie(a_apparente) = a_apparente − R(a_apparente)` est
 * strictement croissante tant que `dR/da > −1`, ce qui est le cas partout dans
 * l'atmosphere standard : la racine est donc unique. Un profil a forte inversion
 * peut violer cette condition — et c'est exactement ce qui produit une image
 * multiple, c'est-a-dire un mirage.
 */
export function apparentAltitude(trueAltitudeDeg: number, options: RayBendingOptions = {}): number {
  // Depart : la refraction evaluee a l'horizon, qui majore celle qui s'applique.
  // Partir de la hauteur vraie echouerait pour un astre sous l'horizon
  // geometrique, ou l'integrale n'est pas definie — et c'est precisement le cas
  // interessant, celui du Soleil visible alors qu'il est couche.
  let apparent = Math.max(0, trueAltitudeDeg + radToDeg(refractionForApparent(0, options)))

  // Newton sur `f(a) = a − R(a) − a_vraie`, borne au domaine de validite.
  // `dR/da` vaut au plus 0,17 : la pente reste franchement positive et la
  // convergence est rapide.
  for (let i = 0; i < 8; i++) {
    const r = radToDeg(refractionForApparent(apparent, options))
    if (!Number.isFinite(r)) break
    const residual = apparent - r - trueAltitudeDeg
    if (Math.abs(residual) < 1e-9) break
    const eps = 1e-3
    const rPlus = radToDeg(refractionForApparent(apparent + eps, options))
    const slope = 1 - (rPlus - r) / eps
    apparent = Math.max(0, apparent - residual / (Math.abs(slope) > 1e-6 ? slope : 1))
  }
  return apparent
}

/**
 * L'astre est-il au-dessus de l'horizon apparent ?
 *
 * Un astre est visible des que sa hauteur **vraie** depasse `−R(0)`, soit
 * environ −33 minutes d'arc dans l'atmosphere standard. C'est ce qui fait que le
 * Soleil se leve avant d'etre leve et se couche apres s'etre couche — d'ou
 * quelques minutes de jour en plus a chaque extremite.
 */
export function isAboveApparentHorizon(trueAltitudeDeg: number, options: RayBendingOptions = {}): boolean {
  return trueAltitudeDeg > -radToDeg(refractionForApparent(0, options))
}

/**
 * Taux de dilatation vertical local, `da_apparente/da_vraie`.
 *
 * Toujours defini tant que la visee est au-dessus de l'horizon apparent, la ou
 * la version limbe a limbe ne l'est pas des que le limbe inferieur passe
 * dessous. C'est cette forme que le rendu utilise.
 */
export function verticalScale(trueAltitudeDeg: number, options: RayBendingOptions = {}): number {
  const eps = 0.01
  const up = apparentAltitude(trueAltitudeDeg + eps, options)
  const down = apparentAltitude(Math.max(-0.5, trueAltitudeDeg - eps), options)
  const span = trueAltitudeDeg + eps - Math.max(-0.5, trueAltitudeDeg - eps)
  return span > 0 ? (up - down) / span : 1
}

/**
 * Facteur de compression verticale d'un disque, sans dimension.
 *
 *     f = da_apparente / da_vraie
 *
 * **C'est le Soleil aplati**, et il n'est ecrit nulle part. La refraction
 * decroit quand la hauteur augmente : le limbe inferieur d'un disque est donc
 * releve davantage que le limbe superieur, et le disque s'ecrase. Le facteur
 * sort de la derivee de la meme fonction que la refraction elle-meme — il n'y a
 * ni parametre, ni courbe d'ajustement.
 *
 * Le diametre **horizontal** n'est pas touche : la refraction ne depend que de
 * la hauteur. C'est pourquoi le Soleil couchant est un ovale et non un disque
 * plus petit.
 */
export function verticalCompression(
  trueAltitudeDeg: number,
  angularRadiusDeg: number,
  options: RayBendingOptions = {},
): number {
  const upper = apparentAltitude(trueAltitudeDeg + angularRadiusDeg, options)
  const lower = apparentAltitude(trueAltitudeDeg - angularRadiusDeg, options)
  // Limbe inferieur sous l'horizon apparent : le disque est alors **tronque**
  // par la Terre, pas comprime. Parler de compression n'aurait plus de sens.
  if (!(lower > 0)) return Number.NaN
  return (upper - lower) / (2 * angularRadiusDeg)
}

/**
 * Profil d'indice avec inversion de temperature au ras du sol.
 *
 * Une couche d'air surchauffee par une surface — bitume, sable, capot de
 * voiture — est **moins dense** que l'air au-dessus, donc **moins refringente**.
 * Le gradient d'indice s'y retourne, et un rayon qui plonge vers le sol peut y
 * etre redresse au lieu d'y etre absorbe : c'est le **mirage inferieur**, qui
 * fait paraitre une flaque d'eau sur une route seche — en realite l'image du
 * ciel, ramenee vers l'oeil.
 *
 * Le module ne peint aucun mirage. Il fournit le profil, et l'integrale fait le
 * reste : si le gradient retourne suffit, `da_vraie/da_apparente` change de
 * signe et l'image se dedouble.
 *
 * `excessK` est l'exces de temperature de la surface sur l'air ambiant, et
 * `thicknessM` l'epaisseur sur laquelle il se dissipe.
 */
export function surfaceInversionProfile(
  lambdaNm: number,
  excessK: number,
  thicknessM: number,
  /**
   * Altitude du **sol**, m — et non celle de l'observateur.
   *
   * La couche chaude repose sur la surface. Y mettre la hauteur de l'oeil la
   * decalerait vers le haut et viderait le premier metre au-dessus du sol,
   * c'est-a-dire l'endroit ou l'inversion existe.
   */
  surfaceAltitudeM = 0,
): (altitudeM: number) => number {
  const base = standardIndexProfile(lambdaNm)
  return (altitudeM: number) => {
    const n = base(altitudeM)
    const height = altitudeM - surfaceAltitudeM
    if (height < 0 || height > thicknessM * 8) return n
    // L'exces decroit exponentiellement : c'est le profil d'une couche limite
    // thermique, et la forme exacte importe moins que le signe du gradient.
    const excess = excessK * Math.exp(-height / thicknessM)
    // A pression constante, `ρ ∝ 1/T`, et la refractivite suit la densite.
    // Un air plus chaud est donc moins refringent.
    const point = 288.15 // temperature de reference du profil standard au sol
    return 1 + (n - 1) * (point / (point + excess))
  }
}
