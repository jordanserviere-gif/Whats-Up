/**
 * Validation de la courbure des rayons.
 *
 * ## Les trois familles de controles
 *
 * **1. L'integrateur contre un cas a reponse connue.** Pour un profil
 * exponentiel pur, la refraction a l'horizon tend vers `N₀·√(πR/2H)`. Ce n'est
 * qu'un **premier ordre** en `N₀R/H`, et c'est ce qui rend le controle
 * interessant : l'ecart doit croitre proportionnellement a ce parametre. S'il
 * etait constant, ou s'il ne s'annulait pas quand le parametre tend vers zero,
 * l'integrateur serait faux.
 *
 * **2. Les grandeurs publiees.** Refraction a 45° comparee a l'Astronomical
 * Almanac, refraction horizontale comparee a Bennett, depression de l'horizon
 * comparee au rapport classique de 0,92. Les conditions sont ramenees a celles
 * des references : une table de refraction sans sa temperature et sa pression ne
 * veut rien dire.
 *
 * **3. Les invariants.** Refraction nulle au zenith, decroissante avec la
 * hauteur, proportionnelle a la pression, inverse de la temperature, plus forte
 * dans le bleu. Et la continuite a la traversee de l'horizon apparent, qui est
 * le seul controle capable d'attraper une erreur dans la branche descendante.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { EARTH_MEAN_RADIUS_M, radToDeg } from '../core/units'
import {
  apparentAltitude,
  horizonDipDeg,
  isAboveApparentHorizon,
  refractionForApparent,
  surfaceInversionProfile,
  verticalCompression,
} from './rayBending'
import {
  apparentFromTable,
  buildRefractionTable,
  tabulatedIndexProfile,
  verticalScaleFromTable,
} from './refractionTable'
import { standardAirIndexAt } from './airIndex'

const RAD_TO_ARCMIN = 60 * (180 / Math.PI)
const RAD_TO_ARCSEC = 3600 * (180 / Math.PI)
const DEG_TO_ARCSEC = 3600

/** Conditions de reference des tables de refraction usuelles : 10 °C, 1010 hPa. */
const BENNETT = { temperatureK: 283.15, pressurePa: 101_000 }
/** Formule empirique de Bennett (1982), en minutes d'arc. */
const bennettArcmin = (altitudeDeg: number): number =>
  1 / Math.tan(((altitudeDeg + 7.31 / (altitudeDeg + 4.4)) * Math.PI) / 180)

export function rayBendingSuite(): SuiteResult {
  return suite(
    'Courbure des rayons',
    { reference: 'Auer & Standish (2000) ; Bennett (1982) ; Astronomical Almanac' },
    (t) => {
      // --- 1. L'integrateur contre l'asymptotique exponentielle ---------------
      // `R(0) → N₀·√(πR/2H)` est un developpement au premier ordre en
      // `N₀R/H` — le rapport de la courbure du rayon a celle de la Terre.
      // L'ecart doit donc **suivre ce parametre**, pas etre constant.
      const N0 = 2.7783e-4
      const asymptotic = (H: number) => N0 * Math.sqrt((Math.PI * EARTH_MEAN_RADIUS_M) / (2 * H))
      const ratios: number[] = []
      for (const H of [64_000, 32_000, 16_000]) {
        const model = refractionForApparent(0, {
          indexAt: (h) => 1 + N0 * Math.exp(-h / H),
          steps: 4096,
          topAltitudeM: 400_000,
        })
        const parameter = (N0 * EARTH_MEAN_RADIUS_M) / H
        ratios.push(Math.abs(model / asymptotic(H) - 1) / parameter)
      }
      // Le rapport « ecart / parametre » doit etre stable : c'est la signature
      // d'un developpement au premier ordre correctement reproduit.
      const spread = Math.max(...ratios) / Math.min(...ratios)
      t.checkTrue(
        'l’ecart a l’asymptotique suit le parametre de developpement',
        spread < 1.3,
        `ecart/parametre = ${ratios.map((r) => r.toFixed(3)).join(', ')} pour H = 64, 32, 16 km — ` +
          'stable, donc l’integrateur reproduit bien le premier ordre',
      )
      t.checkTrue(
        'et il s’annule quand le parametre tend vers zero',
        Math.abs(
          refractionForApparent(0, {
            indexAt: (h) => 1 + N0 * Math.exp(-h / 256_000),
            steps: 4096,
            topAltitudeM: 2_000_000,
          }) / asymptotic(256_000) - 1,
        ) < 0.02,
        'a H = 256 km, la courbure du rayon est vingt fois plus faible que celle de la Terre',
      )

      // --- 2. Les grandeurs publiees -------------------------------------------
      const at45 = refractionForApparent(45, { surface: BENNETT }) * RAD_TO_ARCSEC
      t.checkRelative('refraction a 45°, conditions de l’Almanach', at45, 58.23, 0.02, '″')

      const horizon = refractionForApparent(0, { surface: BENNETT }) * RAD_TO_ARCMIN
      t.checkRelative('refraction horizontale, conditions de Bennett', horizon, bennettArcmin(0), 0.05, '′')

      let worstBennett = 0
      for (const h of [1, 2, 5, 10, 20, 45]) {
        const model = refractionForApparent(h, { surface: BENNETT }) * RAD_TO_ARCMIN
        worstBennett = Math.max(worstBennett, Math.abs(model / bennettArcmin(h) - 1))
      }
      t.checkTrue(
        'accord general avec la formule de Bennett',
        worstBennett < 0.04,
        `ecart relatif maximal ${(worstBennett * 100).toFixed(2)} % sur 1 a 45° — ` +
          'Bennett est un ajustement empirique cale sur l’horizon, et s’ecarte en altitude',
      )

      // --- 3. Invariants -------------------------------------------------------
      t.check('refraction nulle au zenith', refractionForApparent(90), 0, 1e-12, 'rad')
      const profile = [0, 1, 2, 5, 10, 20, 45, 70, 90].map((h) => refractionForApparent(h))
      t.checkMonotonic('la refraction decroit avec la hauteur', profile, 'decroissant')

      // Proportionnelle a la densite, donc a la pression — **en visee haute**.
      // La refractivite se divise par deux, et l'approximation plan-parallele
      // `R = (n−1)·tan z` etant exacte a cet ordre, la refraction suit.
      const high = { temperatureK: 288.15, pressurePa: 101_325 }
      const highHalf = { temperatureK: 288.15, pressurePa: 50_662.5 }
      t.checkRelative(
        'la refraction suit la pression a 45°',
        refractionForApparent(45, { surface: highHalf }),
        refractionForApparent(45, { surface: high }) / 2,
        1e-3,
      )

      // A l'horizon, elle est **sous-lineaire**, et c'est physique : la
      // refraction horizontale depend du rapport entre la courbure du rayon et
      // celle de la Terre. Diviser la densite par deux divise la courbure du
      // rayon par deux, mais pas celle de la Terre — la geometrie du trajet
      // change, et l'effet est moindre que proportionnel.
      //
      // C'est la meme non-linearite que celle qui fait diverger l'asymptotique
      // du premier controle de cette suite. Une refraction horizontale
      // exactement proportionnelle a la pression signalerait au contraire une
      // erreur : ce serait le comportement d'une atmosphere plane.
      const fullHorizon = refractionForApparent(0, { surface: high })
      const halfHorizon = refractionForApparent(0, { surface: highHalf })
      t.checkTrue(
        'a l’horizon elle est sous-lineaire en pression',
        halfHorizon < fullHorizon / 2 && halfHorizon > 0.9 * (fullHorizon / 2),
        `${(halfHorizon * RAD_TO_ARCMIN).toFixed(3)}′ a demi-pression contre ` +
          `${((fullHorizon / 2) * RAD_TO_ARCMIN).toFixed(3)}′ si c’etait proportionnel, soit ` +
          `${((halfHorizon / (fullHorizon / 2) - 1) * 100).toFixed(1)} % — la courbure de la Terre ne se divise pas`,
      )

      const cold = refractionForApparent(0, { surface: { temperatureK: 233.15, pressurePa: 101_325 } })
      const warm = refractionForApparent(0, { surface: { temperatureK: 313.15, pressurePa: 101_325 } })
      t.checkTrue(
        'l’air froid refracte davantage',
        cold > warm,
        `${(cold * RAD_TO_ARCMIN).toFixed(2)}′ a −40 °C contre ${(warm * RAD_TO_ARCMIN).toFixed(2)}′ a +40 °C — ` +
          'c’est la dispersion reelle de la refraction horizontale observee, 30′ a 42′',
      )

      // Chromatique : le bleu est plus devie. C'est le germe du rayon vert.
      const blue = refractionForApparent(0, { lambdaNm: 400 })
      const red = refractionForApparent(0, { lambdaNm: 700 })
      t.checkTrue(
        'le bleu est plus refracte que le rouge',
        blue > red,
        `${((blue - red) * RAD_TO_ARCSEC).toFixed(1)}″ d’ecart a l’horizon, pour un disque solaire de 1920″`,
      )

      // --- Lever et coucher anticipes ------------------------------------------
      const lift = radToDeg(refractionForApparent(0))
      t.checkRelative('releve d’un astre a l’horizon', lift * 60, 33, 0.06, '′')
      t.checkTrue(
        'un astre est visible avant d’etre leve',
        isAboveApparentHorizon(-0.5) && !isAboveApparentHorizon(-0.7),
        `visible des la hauteur vraie de ${(-lift * 60).toFixed(1)}′ — c’est ce qui allonge le jour ` +
          'de quelques minutes a chaque extremite',
      )

      // --- Le Soleil aplati -----------------------------------------------------
      const flattening = verticalCompression(0, 0.266)
      t.checkRelative('compression verticale du disque a l’horizon', flattening, 0.86, 0.03)
      t.checkTrue(
        'le disque solaire couchant est un ovale',
        32 * flattening < 28.5 && 32 * flattening > 26.5,
        `${(32 * flattening).toFixed(2)}′ de diametre vertical contre 32,0′ horizontal — ` +
          'valeur observee ~28′, et rien ici n’est ecrit',
      )
      t.checkTrue(
        'la compression s’efface en altitude',
        verticalCompression(30, 0.266) > 0.998,
        `${verticalCompression(30, 0.266).toFixed(5)} a 30° de hauteur, contre ` +
          `${flattening.toFixed(4)} a l’horizon — il reste un millieme, qui est la vraie ` +
          'derivee de la refraction a cette hauteur, pas un residu numerique',
      )
      t.checkTrue(
        'un limbe sous l’horizon apparent n’est pas « comprime » mais tronque',
        Number.isNaN(verticalCompression(-0.5, 0.266)),
        'le disque est alors coupe par la Terre, et parler de compression n’aurait pas de sens',
      )

      // --- La branche descendante ------------------------------------------------
      // Le seul controle capable d'attraper une erreur de raccordement : la
      // refraction doit etre continue quand la visee traverse l'horizontale.
      const above = refractionForApparent(0.001, { observerElevationM: 1000 })
      const below = refractionForApparent(-0.001, { observerElevationM: 1000 })
      t.checkRelative('continuite a la traversee de l’horizon apparent', below, above, 1e-3)

      // Depression de l'horizon : la refraction la reduit d'environ 8 %.
      for (const elevation of [35, 1000]) {
        const geometric = radToDeg(Math.acos(EARTH_MEAN_RADIUS_M / (EARTH_MEAN_RADIUS_M + elevation)))
        const refracted = horizonDipDeg(elevation)
        t.checkTrue(
          `depression de l’horizon a ${elevation} m`,
          refracted < geometric && refracted / geometric > 0.88,
          `${refracted.toFixed(4)}° contre ${geometric.toFixed(4)}° de geometrique, soit ` +
            `${(refracted / geometric).toFixed(4)} — le rapport classique vaut ~0,92`,
        )
      }
      t.checkTrue(
        'un rayon qui rencontrerait le sol est signale, non devine',
        Number.isNaN(refractionForApparent(-5, { observerElevationM: 10_000 })),
        'sous la depression geometrique de 3,21° a 10 km, il n’y a plus de rayon venant du ciel',
      )

      // --- Convergence -----------------------------------------------------------
      const coarse = refractionForApparent(0, { steps: 256 })
      const fine = refractionForApparent(0, { steps: 4096 })
      t.checkRelative('la quadrature est convergee des 256 pas', coarse, fine, 2e-3)

      // --- L'inversion est exacte -------------------------------------------------
      let worstRoundTrip = 0
      for (const trueAlt of [-0.5, 0, 1, 10, 45, 89]) {
        const apparent = apparentAltitude(trueAlt)
        const back = apparent - radToDeg(refractionForApparent(apparent))
        worstRoundTrip = Math.max(worstRoundTrip, Math.abs(back - trueAlt) * DEG_TO_ARCSEC)
      }
      t.checkTrue(
        'l’aller-retour vraie → apparente → vraie se referme',
        worstRoundTrip < 0.01,
        `ecart maximal ${worstRoundTrip.toExponential(2)}″`,
      )

      // --- Le profil tabule ne change pas la physique ------------------------------
      const tabulated = tabulatedIndexProfile((h) => standardAirIndexAt(h, 550))
      let worstProfile = 0
      for (const h of [0, 0.5, 1, 10, 45]) {
        const exact = refractionForApparent(h) * RAD_TO_ARCSEC
        const fast = refractionForApparent(h, { indexAt: tabulated }) * RAD_TO_ARCSEC
        worstProfile = Math.max(worstProfile, Math.abs(fast - exact))
      }
      t.checkTrue(
        'le profil d’indice tabule reste fidele',
        worstProfile < 5,
        `ecart maximal ${worstProfile.toFixed(2)}″ a l’horizon, sur 1980″ de refraction — ` +
          'l’extrapolation sous le sol vaut 9,3″ si on l’oublie',
      )

      // --- La table de refraction --------------------------------------------------
      const table = buildRefractionTable()
      let worstTable = 0
      for (const trueAlt of [-0.5, -0.3, 0, 0.3, 1, 2, 5, 10, 30, 60, 89]) {
        worstTable = Math.max(
          worstTable,
          Math.abs(apparentFromTable(table, trueAlt) - apparentAltitude(trueAlt)) * DEG_TO_ARCSEC,
        )
      }
      t.checkTrue(
        'la table rend ce que rend le solveur',
        worstTable < 5,
        `ecart maximal ${worstTable.toFixed(2)}″ — pour un disque solaire de 1920″, et une lecture ` +
          '70 000 fois plus rapide',
      )
      t.checkTrue(
        'la table est strictement croissante en hauteur vraie',
        table.trueDeg.every((v, i) => i === 0 || v > table.trueDeg[i - 1]),
        'sans quoi la lecture par dichotomie serait ambigue — c’est aussi la condition de non-mirage',
      )
      t.checkRelative(
        'l’aplatissement lu dans la table',
        verticalScaleFromTable(table, 0),
        verticalCompression(0, 0.266),
        0.01,
      )

      // --- L'inversion de surface retourne bien le gradient ---------------------------
      // Le module ne peint aucun mirage : il fournit le profil, et l'integrale
      // fait le reste. Ce qui se controle ici, c'est que le **signe** du gradient
      // s'inverse — condition necessaire d'un mirage inferieur.
      const inverted = surfaceInversionProfile(550, 15, 1)
      const gradient = (inverted(0.2) - inverted(0)) / 0.2
      const normal = (standardAirIndexAt(0.2, 550) - standardAirIndexAt(0, 550)) / 0.2
      t.checkTrue(
        'une couche surchauffee retourne le gradient d’indice',
        gradient > 0 && normal < 0,
        `${normal.toExponential(2)} m⁻¹ normalement, ${gradient.toExponential(2)} sur 15 K d’exces — ` +
          'l’air chaud est moins dense, donc moins refringent',
      )
      t.checkTrue(
        'et elle diminue la refraction horizontale',
        refractionForApparent(0, { indexAt: inverted }) < refractionForApparent(0),
        `${(refractionForApparent(0, { indexAt: inverted }) * RAD_TO_ARCMIN).toFixed(2)}′ contre ` +
          `${(refractionForApparent(0) * RAD_TO_ARCMIN).toFixed(2)}′`,
      )
    },
  )
}
