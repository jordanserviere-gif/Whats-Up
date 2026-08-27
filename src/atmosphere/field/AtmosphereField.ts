/**
 * Champ atmospherique tridimensionnel.
 *
 * ## L'hypothese que ce module leve
 *
 * Tout le moteur, jusqu'ici, suppose l'atmosphere **a symetrie spherique** :
 * l'indice, la densite et la temperature ne dependent que de l'altitude. Cette
 * hypothese n'est pas un detail d'implementation, c'est ce qui rend possible
 * l'invariant de Bouguer, une table de ciel a deux dimensions et un point
 * tangent unique.
 *
 * Elle interdit aussi, du meme coup, tout ce qui varie **horizontalement** : une
 * dalle de bitume surchauffee, un front qui approche, une couche d'inversion qui
 * ne couvre qu'un secteur. C'est-a-dire l'essentiel de ce qui fait un mirage
 * reel — lequel n'est presque jamais symetrique.
 *
 * ## Le repere
 *
 * **Geocentrique cartesien, observateur sur l'axe +Y.** C'est deja la convention
 * du transport (`transport/singleScattering.ts`) : l'observateur est en
 * `(0, R + h, 0)`, et `+Y` est sa verticale locale. Le champ s'exprime dans ce
 * repere, en metres.
 *
 * Ce choix evite une conversion a chaque pas de marche, qui serait le cout
 * dominant d'un traceur de rayons.
 *
 * ## La composition plutot que l'heritage
 *
 * Un champ est une **fonction**, et les perturbations sont des fonctions qui en
 * enveloppent une autre. L'atmosphere standard spherique est le champ de base ;
 * une inversion de surface, un gradient horizontal ou une dalle chauffee sont
 * des couches posees dessus.
 *
 * C'est ce qui permet de verifier la chose importante : **une perturbation nulle
 * doit rendre exactement le champ de base**, au bit pres. La suite de validation
 * le controle, parce qu'une perturbation qui deriverait de zero fausserait
 * silencieusement tout ce qui la traverse.
 */
import { EARTH_MEAN_RADIUS_M } from '../core/units'
import { standardAirIndexAt } from '../refraction/airIndex'

const RADIUS = EARTH_MEAN_RADIUS_M

/**
 * Indice de refraction en tout point, et son gradient.
 *
 * `gradientAt` est optionnel : sans lui, le traceur le prend par differences
 * finies, ce qui coute six evaluations au lieu d'une. Un champ qui connait sa
 * propre derivee a donc tout interet a la fournir.
 */
export interface AtmosphereField {
  refractiveIndexAt(x: number, y: number, z: number): number
  gradientAt?(x: number, y: number, z: number): [number, number, number]
}

/** Altitude au-dessus de la surface, pour un point du repere geocentrique. */
export const altitudeOf = (x: number, y: number, z: number): number =>
  Math.hypot(x, y, z) - RADIUS

/**
 * Champ spherique : l'atmosphere standard, telle que le reste du moteur la
 * connait.
 *
 * Son gradient est **analytique en direction** — il pointe le long du rayon
 * vecteur, par definition de la symetrie — ce qui n'en laisse qu'une seule
 * derivee a estimer au lieu de trois.
 */
export function sphericalField(
  lambdaNm = 550,
  profile: (altitudeM: number) => number = (h) => standardAirIndexAt(h, lambdaNm),
): AtmosphereField {
  const step = 1
  return {
    refractiveIndexAt: (x, y, z) => profile(altitudeOf(x, y, z)),
    gradientAt: (x, y, z) => {
      const radius = Math.hypot(x, y, z) || 1
      const altitude = radius - RADIUS
      const slope = (profile(altitude + step) - profile(altitude - step)) / (2 * step)
      // Symetrie spherique : `∇n = (dn/dh)·r̂`. Rien d'autre a calculer.
      return [(slope * x) / radius, (slope * y) / radius, (slope * z) / radius]
    },
  }
}

/**
 * Gradient par differences finies centrees, pour un champ qui n'en fournit pas.
 *
 * Le pas est en metres. Trop petit, il se perd dans les arrondis — la
 * refractivite vaut 2,8·10⁻⁴ et sa variation verticale 2,7·10⁻⁸ par metre ;
 * trop grand, il lisse precisement les structures fines qui font les mirages.
 */
export function numericGradient(
  field: AtmosphereField,
  x: number,
  y: number,
  z: number,
  step = 0.5,
): [number, number, number] {
  if (field.gradientAt) return field.gradientAt(x, y, z)
  const n = field.refractiveIndexAt.bind(field)
  return [
    (n(x + step, y, z) - n(x - step, y, z)) / (2 * step),
    (n(x, y + step, z) - n(x, y - step, z)) / (2 * step),
    (n(x, y, z + step) - n(x, y, z - step)) / (2 * step),
  ]
}

/**
 * Couche d'air surchauffee au-dessus d'une **surface limitee**.
 *
 * C'est la perturbation qui brise reellement la symetrie : une route, une piste,
 * un toit. L'air y est plus chaud, donc moins dense, donc **moins refringent** —
 * et le gradient vertical d'indice s'y retourne.
 *
 * La forme retenue est le produit de deux profils :
 *
 * - **vertical**, exponentiel, d'echelle `thicknessM` : c'est la couche limite
 *   thermique, et sa forme exacte importe moins que le signe de sa pente ;
 * - **horizontal**, en cloche de demi-largeur `radiusM` autour du point vise :
 *   c'est ce qui rend la perturbation locale, donc asymetrique.
 *
 * `excessK` est l'exces de temperature de l'air au contact de la surface. Une
 * route noire au soleil depasse couramment l'air ambiant de vingt a cinquante
 * kelvins sur le premier metre — c'est cette valeur, et non le mirage, qui est
 * le parametre physique.
 *
 * ⚠️ **La forme des deux profils est un choix de modelisation, pas une mesure.**
 * Une couche limite reelle suit une loi en puissance ajustee par la turbulence,
 * et sa description appartient a la micrometeorologie. Ce qui est physique ici,
 * c'est le lien exces de temperature → densite → indice, qui passe par
 * l'equation d'etat.
 */
export function heatedPatch(
  base: AtmosphereField,
  options: {
    /** Direction horizontale du centre de la dalle, dans le plan xOz, radians. */
    bearingRad?: number
    /** Distance du centre de la dalle a l'observateur, m. */
    distanceM: number
    /** Demi-largeur de la dalle, m. */
    radiusM: number
    /** Epaisseur de la couche chaude, m. */
    thicknessM: number
    /** Exces de temperature au contact, K. */
    excessK: number
    /**
     * Altitude du **sol** sous la dalle, m.
     *
     * C'est l'origine des hauteurs de la couche chaude. Y mettre l'altitude de
     * l'observateur — ce que faisait la premiere version — decale la couche vers
     * le haut et vide precisement le premier metre au-dessus du sol, la ou tout
     * se joue : un oeil a 1,7 m ne voyait alors plus aucun mirage, et le rayon
     * rencontrait le sol au lieu de se retourner.
     */
    surfaceAltitudeM?: number
    /** Temperature de reference de l'air, K. */
    ambientK?: number
  },
): AtmosphereField {
  const {
    bearingRad = 0,
    distanceM,
    radiusM,
    thicknessM,
    excessK,
    surfaceAltitudeM = 0,
    ambientK = 288.15,
  } = options

  // Centre de la dalle, dans le repere geocentrique : l'observateur est sur +Y,
  // et une direction horizontale se lit dans le plan xOz.
  const centreX = Math.sin(bearingRad) * distanceM
  const centreZ = -Math.cos(bearingRad) * distanceM
  const centreY = RADIUS + surfaceAltitudeM

  return {
    refractiveIndexAt: (x, y, z) => {
      const n = base.refractiveIndexAt(x, y, z)
      if (excessK === 0) return n

      const height = altitudeOf(x, y, z) - surfaceAltitudeM
      if (height < 0 || height > thicknessM * 10) return n

      // Distance horizontale au centre, mesuree dans le plan tangent : a
      // quelques centaines de metres, la courbure est negligeable devant la
      // taille de la dalle.
      const dx = x - centreX
      const dz = z - centreZ
      const dy = y - centreY
      const horizontal = Math.hypot(dx, dz, dy * 1e-6)
      const lateral = Math.exp(-((horizontal / radiusM) ** 2))
      if (lateral < 1e-6) return n

      const excess = excessK * Math.exp(-height / thicknessM) * lateral
      // A pression constante, `ρ ∝ 1/T`, et la refractivite suit la densite.
      return 1 + (n - 1) * (ambientK / (ambientK + excess))
    },
  }
}

/**
 * Gradient horizontal de temperature, uniforme en direction.
 *
 * Le cas d'un front : l'air est plus froid d'un cote et plus chaud de l'autre,
 * sur des dizaines de kilometres. La refraction cesse alors d'etre la meme dans
 * toutes les directions, et un astre bas ne se releve plus autant a l'est qu'a
 * l'ouest.
 *
 * `gradientKPerKm` est positif vers `bearingRad`.
 */
export function horizontalGradient(
  base: AtmosphereField,
  options: {
    bearingRad?: number
    gradientKPerKm: number
    ambientK?: number
    /**
     * Amplitude maximale du contraste, K.
     *
     * Un gradient lineaire sans borne est une fiction commode qui devient
     * absurde a l'echelle d'un rayon rasant : celui-ci parcourt trois cents
     * kilometres d'horizontale, ou 2 K/km donneraient six cents kelvins d'ecart
     * — et une temperature negative d'un cote. Un front reel a une amplitude
     * finie, et la saturation la porte.
     */
    maxExcessK?: number
  },
): AtmosphereField {
  const { bearingRad = 0, gradientKPerKm, ambientK = 288.15, maxExcessK = 20 } = options
  const ux = Math.sin(bearingRad)
  const uz = -Math.cos(bearingRad)

  return {
    refractiveIndexAt: (x, y, z) => {
      const n = base.refractiveIndexAt(x, y, z)
      if (gradientKPerKm === 0) return n
      // Projection sur la direction du gradient. L'observateur etant sur +Y,
      // les coordonnees `x` et `z` sont deja des distances horizontales.
      const along = (x * ux + z * uz) / 1000
      // Saturation douce : lineaire pres de l'observateur, bornee au loin.
      const excess = maxExcessK * Math.tanh((gradientKPerKm * along) / maxExcessK)
      const temperature = ambientK + excess
      if (!(temperature > 0)) return n
      return 1 + (n - 1) * (ambientK / temperature)
    },
  }
}
