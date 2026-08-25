/**
 * Validation de la frontiere physique ↔ rendu — phase 0.
 *
 * Cette suite ne teste aucune physique. Elle teste le **contrat** sur lequel
 * toute la physique va s'appuyer, et dont la rupture serait silencieuse :
 *
 * - les directions du solveur et celles de la scene designent le meme ciel ;
 * - les conversions d'unites sont exactement reversibles ;
 * - la compression de profondeur de la scene preserve l'ordre — donc les
 *   occultations — et le diametre apparent ;
 * - une profondeur de scene ne peut pas etre prise pour une distance.
 *
 * L'audit a identifie cette derniere confusion comme le piege principal de
 * l'integration : `sceneDepth()` est logarithmique, et un moteur qui
 * l'interpreterait en metres calculerait des profondeurs optiques absurdes sans
 * qu'aucun test de physique ne s'en apercoive.
 */
import { DEG } from '@/astro/coords'
import { sceneDepth, sceneRadiusForBody, viewDirection } from '@/scene/sceneMath'
import { suite, type SuiteResult } from '../validation/harness'
import {
  EARTH_MEAN_RADIUS_M,
  altitudeAngleOf,
  altitudeOf,
  arcsecToRad,
  degToRad,
  directionFromHorizontal,
  kmToM,
  mToKm,
  observerPosition,
  radToArcsec,
  radToDeg,
} from './units'

export function unitsBoundarySuite(): SuiteResult {
  return suite(
    'Frontiere physique ↔ rendu (phase 0)',
    { reference: 'conventions du depot : +X est, +Y zenith, −Z nord' },
    (t) => {
      // --- Les directions traversent la frontiere sans conversion -----------
      // C'est la propriete qui rend l'integration possible : le repere de la
      // scene EST un repere physique local. Si elle cassait, tout le moteur
      // pointerait a cote sans qu'aucun calcul physique ne soit faux.
      const aims = [
        { az: 0, alt: 0 },
        { az: 90, alt: 0 },
        { az: 180, alt: 45 },
        { az: 270, alt: -30 },
        { az: 37.5, alt: 89.9 },
        { az: 315, alt: 12.25 },
      ]
      for (const aim of aims) {
        const scene = viewDirection(aim.az, aim.alt)
        const physics = directionFromHorizontal(degToRad(aim.az), degToRad(aim.alt))
        const gap = Math.hypot(scene[0] - physics[0], scene[1] - physics[1], scene[2] - physics[2])
        t.check(`direction az ${aim.az}° alt ${aim.alt}° : scene vs solveur`, gap, 0, 1e-12)
      }

      // Reperes cardinaux, en clair : une inversion de signe sur l'axe est a
      // deja ete attrapee une fois dans ce depot (voir README).
      const north = directionFromHorizontal(0, 0)
      const east = directionFromHorizontal(degToRad(90), 0)
      const zenith = directionFromHorizontal(0, degToRad(90))
      t.check('nord = −Z', north[2], -1, 1e-12)
      t.check('est = +X', east[0], 1, 1e-12)
      t.check('zenith = +Y', zenith[1], 1, 1e-12)

      // --- Aller-retour direction ↔ hauteur ---------------------------------
      for (const alt of [-89, -45, -0.5, 0, 0.5, 30, 88.7]) {
        const dir = directionFromHorizontal(degToRad(123), degToRad(alt))
        t.check(`hauteur retrouvee a ${alt}°`, radToDeg(altitudeAngleOf(dir)), alt, 1e-10, '°')
      }

      // --- Unites -----------------------------------------------------------
      t.check('km → m → km', mToKm(kmToM(1234.5678)), 1234.5678, 1e-9, ' km')
      t.check('degre → radian', degToRad(180), Math.PI, 1e-15, ' rad')
      t.check('radian → seconde d’arc', radToArcsec(1), 206264.806, 1e-3, '″')
      t.check('seconde d’arc → radian → seconde d’arc', radToArcsec(arcsecToRad(34.5)), 34.5, 1e-9, '″')
      // La refraction astronomique a l'horizon vaut environ 35′ : c'est l'ordre
      // de grandeur que la phase 11 devra retrouver, et l'unite dans laquelle
      // elle se lit.
      t.check('35′ en radians', arcsecToRad(35 * 60), 0.010181, 1e-6, ' rad')

      // --- Position de l'observateur ----------------------------------------
      for (const elevation of [0, 35, 2877]) {
        const p = observerPosition(elevation)
        t.check(`altitude retrouvee a ${elevation} m`, altitudeOf(p), elevation, 1e-6, ' m')
        t.check(`observateur sur l’axe zenithal a ${elevation} m`, Math.hypot(p[0], p[2]), 0, 1e-12, ' m')
      }
      t.check(
        'rayon terrestre moyen du transport radiatif',
        observerPosition(0)[1],
        EARTH_MEAN_RADIUS_M,
        1e-9,
        ' m',
      )

      // --- Profondeur de scene : ce qu'elle preserve -------------------------
      // Croissance stricte ⇒ l'ordre des occultations est celui des distances.
      // C'est ce qui fait tomber les eclipses du tampon de profondeur, et le
      // moteur atmospherique ne doit rien y changer.
      const distancesKm = [1, 10, 400, 35_786, 384_400, 1.5e8, 4.5e9]
      t.checkMonotonic('la profondeur de scene croit avec la distance', distancesKm.map(sceneDepth), 'croissant')

      // Le diametre apparent est exact : c'est l'autre moitie du contrat.
      const bodies = [
        { name: 'Soleil', radiusKm: 695_700, distanceKm: 1.496e8 },
        { name: 'Lune', radiusKm: 1737.4, distanceKm: 384_400 },
        { name: 'Jupiter', radiusKm: 69_911, distanceKm: 6.28e8 },
      ]
      for (const b of bodies) {
        const trueAngular = 2 * Math.asin(b.radiusKm / b.distanceKm)
        const rendered = 2 * Math.asin(sceneRadiusForBody(b.radiusKm, b.distanceKm) / sceneDepth(b.distanceKm))
        t.check(`${b.name} : diametre apparent preserve`, rendered / DEG, trueAngular / DEG, 1e-6, '°')
      }

      // --- Le piege : profondeur n'est pas distance --------------------------
      // Un rapport de distances de 4,5 milliards se comprime en un rapport de
      // profondeurs inferieur a 100. Interpreter l'une pour l'autre donnerait
      // des profondeurs optiques fausses de plusieurs ordres de grandeur, sans
      // qu'aucun test de physique ne le signale.
      const distanceRatio = 4.5e9 / 1
      const depthRatio = sceneDepth(4.5e9) / sceneDepth(1)
      t.checkTrue(
        'la profondeur de scene n’est pas proportionnelle a la distance',
        depthRatio < distanceRatio / 1e6,
        `distances ×${distanceRatio.toExponential(1)} → profondeurs ×${depthRatio.toFixed(1)} : ` +
          `la distance reelle doit voyager separement (uniform en metres)`,
      )
      t.note(
        `profondeurs de scene : 1 km → ${sceneDepth(1).toFixed(2)}, ` +
          `400 km → ${sceneDepth(400).toFixed(2)}, Lune → ${sceneDepth(384_400).toFixed(2)}, ` +
          `Soleil → ${sceneDepth(1.496e8).toFixed(2)}, Neptune → ${sceneDepth(4.5e9).toFixed(2)}`,
      )
    },
  )
}
