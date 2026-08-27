/**
 * Validation du champ 3D et de son traceur de rayons.
 *
 * ## Le controle qui porte la phase
 *
 * Le traceur integre l'equation eikonale et **n'utilise jamais** l'invariant de
 * Bouguer. Dans un champ spherique, il doit pourtant :
 *
 * 1. **conserver cet invariant** — une loi que son schema numerique ignore ;
 * 2. **retomber sur la refraction de la phase 11**, obtenue par un tout autre
 *    chemin, l'integrale a une dimension le long de l'invariant.
 *
 * Deux algorithmes sans rien de commun, un seul resultat. C'est plus fort qu'une
 * comparaison a une table publiee, parce qu'il n'y a ici aucune reference
 * exterieure a laquelle s'ajuster.
 *
 * ## Le controle qui garde les perturbations honnetes
 *
 * Une perturbation d'amplitude nulle doit rendre le champ de base **au bit
 * pres**. Une couche qui deriverait de zero fausserait silencieusement tout ce
 * qui la traverse, et l'ecart serait attribue a la physique.
 *
 * ## Ce que la phase debloque
 *
 * Un rayon vise sous l'horizon **se retourne** au-dessus d'une surface
 * surchauffee, alors qu'il rencontre le sol dans l'atmosphere standard. C'est la
 * condition du mirage inferieur, et elle sort du champ — rien ne la peint.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { EARTH_MEAN_RADIUS_M } from '../core/units'
import { refractionForApparent } from '../refraction/rayBending'
import {
  altitudeOf,
  heatedPatch,
  horizontalGradient,
  numericGradient,
  sphericalField,
  type AtmosphereField,
} from './AtmosphereField'
import { bouguerInvariant, refractionByTracing, traceRay } from './rayTracer'

const RADIUS = EARTH_MEAN_RADIUS_M
const RAD_TO_ARCMIN = 60 * (180 / Math.PI)
const RAD_TO_ARCSEC = 3600 * (180 / Math.PI)

const field = sphericalField(550)

export function rayTracerSuite(): SuiteResult {
  return suite(
    'Champ 3D et traceur de rayons',
    { reference: 'equation eikonale ; invariant de Bouguer comme controle' },
    (t) => {
      // --- 1. Le traceur retombe sur l'integrale de la phase 11 ---------------
      // L'un integre `dr/ds = u`, `du/ds = (∇n − (u·∇n)u)/n` ; l'autre integre
      // `−∫ tan z ·(1/n)(dn/dr) dr` le long de l'invariant. Rien de commun.
      let worstAgreement = 0
      let worstAltitude = 0
      for (const apparentDeg of [0, 0.5, 2, 10, 45, 80]) {
        const oneDimensional = refractionForApparent(apparentDeg) * RAD_TO_ARCSEC
        const traced = refractionByTracing(field, apparentDeg).deflectionRad * RAD_TO_ARCSEC
        const gap = Math.abs(traced - oneDimensional)
        if (gap > worstAgreement) {
          worstAgreement = gap
          worstAltitude = apparentDeg
        }
      }
      t.checkTrue(
        'le traceur 3D retrouve la refraction de l’invariant',
        worstAgreement < 0.5,
        `ecart maximal ${worstAgreement.toFixed(3)}″ a ${worstAltitude}° — sur 1980″ de refraction ` +
          'horizontale, par deux algorithmes sans rien de commun',
      )

      // --- 2. L'invariant de Bouguer est conserve ------------------------------
      // Le traceur ne s'en sert pas : c'est ce qui fait de sa conservation un
      // controle et non une tautologie.
      const long = refractionByTracing(field, 0)

      let worstDrift = 0
      for (const apparentDeg of [0, 2, 30, 70]) {
        const altitude = (apparentDeg * Math.PI) / 180
        const start: [number, number, number] = [0, RADIUS, 0]
        const direction: [number, number, number] = [0, Math.sin(altitude), -Math.cos(altitude)]
        const before = bouguerInvariant(field, start, direction)
        const result = refractionByTracing(field, apparentDeg)
        const after = bouguerInvariant(field, result.position, result.direction)
        worstDrift = Math.max(worstDrift, Math.abs(after / before - 1))
      }
      // Le seuil est place a `10⁻⁶` : la derive mesuree vaut 1,6·10⁻⁷ apres
      // vingt-quatre mille pas de Runge-Kutta, soit un metre sur les six mille
      // trois cents kilometres du rayon vecteur. Elle vient de la
      // renormalisation de la direction, faite a chaque pas.
      t.checkTrue(
        'l’invariant de Bouguer se conserve le long du rayon',
        worstDrift < 1e-6,
        `derive relative maximale ${worstDrift.toExponential(2)} sur ${long.steps} pas — ` +
          'une loi que le schema numerique ignore',
      )

      // --- 3. Un champ spherique est isotrope en azimut ------------------------
      const byAzimuth = [0, 45, 90, 135, 180, 270].map(
        (azimuthDeg) =>
          refractionByTracing(field, 0, { azimuthRad: (azimuthDeg * Math.PI) / 180 }).deflectionRad,
      )
      const spread = (Math.max(...byAzimuth) - Math.min(...byAzimuth)) * RAD_TO_ARCSEC
      // Deux cent-milliardiemes de seconde d'arc : c'est du bruit de flottant,
      // les sinus et cosinus d'azimuts differents ne s'arrondissant pas de la
      // meme facon. Le seuil est place la ou une vraie anisotropie se verrait.
      t.check('la refraction d’un champ spherique ne depend pas de l’azimut', spread, 0, 1e-4, '″')

      // --- 4. La direction reste unitaire --------------------------------------
      // L'equation conserve la norme analytiquement ; le schema la laisse deriver
      // et le traceur la renormalise. Sans cela, vingt-quatre mille pas
      // suffiraient a la faire compter.
      t.check(
        'la direction reste unitaire apres la marche',
        Math.hypot(long.direction[0], long.direction[1], long.direction[2]),
        1,
        1e-12,
      )
      t.checkTrue(
        'et le rayon sort bien de l’atmosphere',
        long.escaped,
        `${long.steps} pas, ${(long.pathLengthM / 1000).toFixed(0)} km parcourus`,
      )

      // --- 5. Le gradient numerique vaut le gradient analytique ----------------
      // C'est ce qui rend les champs perturbes utilisables : aucun d'eux ne
      // connait sa propre derivee.
      const bare: AtmosphereField = { refractiveIndexAt: field.refractiveIndexAt }
      let worstGradient = 0
      for (const altitude of [0, 100, 2000, 20_000]) {
        const point: [number, number, number] = [0, RADIUS + altitude, 0]
        const analytic = field.gradientAt!(...point)
        const numeric = numericGradient(bare, ...point, 5)
        const reference = Math.hypot(...analytic) || 1
        worstGradient = Math.max(
          worstGradient,
          Math.hypot(numeric[0] - analytic[0], numeric[1] - analytic[1], numeric[2] - analytic[2]) / reference,
        )
      }
      t.checkTrue(
        'le gradient par differences finies vaut l’analytique',
        worstGradient < 1e-3,
        `ecart relatif maximal ${worstGradient.toExponential(2)}`,
      )

      // --- 6. Une perturbation nulle rend le champ de base, au bit pres --------
      const nullPatch = heatedPatch(field, {
        distanceM: 100,
        radiusM: 50,
        thicknessM: 1,
        excessK: 0,
      })
      const nullGradient = horizontalGradient(field, { gradientKPerKm: 0 })
      let identical = true
      for (const point of [
        [0, RADIUS, 0],
        [100, RADIUS + 3, -200],
        [5000, RADIUS + 2000, 1000],
      ] as Array<[number, number, number]>) {
        const reference = field.refractiveIndexAt(...point)
        if (nullPatch.refractiveIndexAt(...point) !== reference) identical = false
        if (nullGradient.refractiveIndexAt(...point) !== reference) identical = false
      }
      t.checkTrue(
        'une perturbation d’amplitude nulle rend exactement le champ de base',
        identical,
        'egalite stricte, pas une tolerance — une couche qui deriverait de zero ' +
          'fausserait silencieusement tout ce qui la traverse',
      )

      // --- 7. Un front brise la symetrie, dans le bon sens ---------------------
      // L'air chaud est moins dense, donc moins refringent : viser vers lui doit
      // **diminuer** la refraction, et viser vers l'air froid l'augmenter.
      const front = horizontalGradient(field, { bearingRad: 0, gradientKPerKm: 2, maxExcessK: 20 })
      const symmetric = refractionByTracing(field, 0).deflectionRad * RAD_TO_ARCMIN
      const towardWarm = refractionByTracing(front, 0, { azimuthRad: 0 }).deflectionRad * RAD_TO_ARCMIN
      const towardCold =
        refractionByTracing(front, 0, { azimuthRad: Math.PI }).deflectionRad * RAD_TO_ARCMIN
      const across =
        refractionByTracing(front, 0, { azimuthRad: Math.PI / 2 }).deflectionRad * RAD_TO_ARCMIN

      t.checkTrue(
        'viser vers l’air chaud diminue la refraction',
        towardWarm < symmetric,
        `${towardWarm.toFixed(3)}′ contre ${symmetric.toFixed(3)}′ en atmosphere symetrique, ` +
          `soit ${((towardWarm - symmetric) * 60).toFixed(1)}″`,
      )
      t.checkTrue(
        'viser vers l’air froid l’augmente',
        towardCold > symmetric,
        `${towardCold.toFixed(3)}′, soit ${((towardCold - symmetric) * 60).toFixed(1)}″`,
      )
      t.checkTrue(
        'et perpendiculairement au front elle ne bouge presque pas',
        Math.abs(across - symmetric) * 60 < 10,
        `${((across - symmetric) * 60).toFixed(2)}″ — le residu est celui du gradient numerique, ` +
          'le front n’ayant aucune composante le long de cette visee',
      )
      t.checkTrue(
        'l’asymetrie est du bon ordre de grandeur',
        Math.abs(towardCold - towardWarm) * 60 > 60,
        `${((towardCold - towardWarm) * 60).toFixed(0)}″ d’un bord a l’autre, pour 2 K/km satures a 20 K`,
      )

      // --- 8. La saturation borne le contraste ---------------------------------
      // Un gradient lineaire sans borne donnerait six cents kelvins sur les trois
      // cents kilometres d'un rayon rasant, et une temperature negative de
      // l'autre cote.
      const saturated = horizontalGradient(field, { gradientKPerKm: 5, maxExcessK: 10 })
      const farAway = saturated.refractiveIndexAt(0, RADIUS, -1_000_000)
      const reference = field.refractiveIndexAt(0, RADIUS, -1_000_000)
      const impliedExcess = 288.15 * ((reference - 1) / (farAway - 1) - 1)
      t.checkTrue(
        'le contraste horizontal reste borne',
        Math.abs(impliedExcess) <= 10.001,
        `${impliedExcess.toFixed(3)} K a mille kilometres, pour un plafond de 10 K`,
      )

      // --- 9. Ce que la phase debloque : le rayon se retourne ------------------
      // Au-dessus d'une surface surchauffee, un rayon vise sous l'horizon
      // remonte au lieu de rencontrer le sol. C'est la condition du mirage
      // inferieur, et rien ne la peint.
      const road = heatedPatch(field, {
        distanceM: 200,
        radiusM: 600,
        thicknessM: 0.8,
        excessK: 35,
        surfaceAltitudeM: 0,
      })
      const lowestAltitude = (target: AtmosphereField, altitudeDeg: number): number => {
        let lowest = 1.7
        const probe: AtmosphereField = {
          refractiveIndexAt: (x, y, z) => {
            const altitude = altitudeOf(x, y, z)
            if (altitude < lowest) lowest = altitude
            return target.refractiveIndexAt(x, y, z)
          },
        }
        const angle = (altitudeDeg * Math.PI) / 180
        traceRay(probe, [0, RADIUS + 1.7, 0], [0, Math.sin(angle), -Math.cos(angle)], {
          minStepM: 0.05,
          stepPerAltitude: 0.005,
          gradientStepM: 0.05,
        })
        return lowest
      }

      const overRoad = lowestAltitude(road, -0.2)
      const overStandard = lowestAltitude(field, -0.2)
      t.checkTrue(
        'au-dessus d’une surface surchauffee, le rayon se retourne',
        overRoad > 0.5,
        `il descend a ${overRoad.toFixed(3)} m puis remonte, la ou l’atmosphere standard ` +
          `le laisse rencontrer le sol (${overStandard.toFixed(3)} m)`,
      )
      t.checkTrue(
        'et l’atmosphere standard, elle, ne peut pas le retourner',
        overStandard <= 0,
        'son gradient d’indice est monotone : aucun mirage ne peut en sortir',
      )
    },
  )
}
