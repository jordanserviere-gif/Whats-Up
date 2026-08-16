/**
 * Verification numerique de la couche astronomique.
 *
 * Confronte les conversions de reperes maison aux resultats d'astronomy-engine,
 * et controle la coherence physique du propagateur orbital.
 *
 * Usage : npm run verify
 */
import * as A from 'astronomy-engine'
import { Matrix4, Vector3 } from 'three'
import {
  DEG,
  EARTH_MU,
  RAD,
  eciToGeodetic,
  eciVectorToHorizontal,
  equatorialToHorizontal,
  observerEci,
} from '../src/astro/coords.ts'
import { gmstDegrees, lstDegrees } from '../src/astro/time.ts'
import { orbitalPeriod, propagate } from '../src/astro/kepler.ts'
import { computeSatelliteState } from '../src/astro/satellite.ts'
import { computeBodyState, BODIES, BODY_BY_ID } from '../src/astro/bodies.ts'
import { AIRGLOW_LUX, airmass, diskObscuration, skyLuminance, skySurfaceBrightness } from '../src/astro/photometry.ts'
import {
  DEEP_SKY_COUNT,
  DEEP_SKY_MAG_LIMIT,
  MESSIER_OBJECTS,
  buildDeepSkyGeometry,
  findDeepSkyObject,
} from '../src/astro/deepsky.ts'
import { equatorialToSceneMatrix, horizontalToScene, sceneDepth, sceneRadiusForBody } from '../src/scene/sceneMath.ts'

let failures = 0
const check = (label, actual, expected, tolerance, unit = '') => {
  const delta = Math.abs(actual - expected)
  const ok = delta <= tolerance
  if (!ok) failures++
  const status = ok ? 'OK  ' : 'ECHEC'
  console.log(
    `${status} ${label.padEnd(52)} ecart ${delta.toExponential(2)}${unit} (tolerance ${tolerance.toExponential(1)}${unit})`,
  )
}

const LOCATIONS = [
  { name: 'Paris', latitude: 48.8566, longitude: 2.3522, elevation: 35 },
  { name: 'Paranal', latitude: -24.6272, longitude: -70.4039, elevation: 2635 },
  { name: 'Tromso', latitude: 69.6492, longitude: 18.9553, elevation: 10 },
]
const DATES = [
  new Date('2026-08-16T21:30:00Z'),
  new Date('2026-01-03T04:15:00Z'),
  new Date('2031-11-27T13:05:00Z'),
]

console.log('\n=== 0. Temps sidereal ===')
for (const date of DATES) {
  // astronomy-engine renvoie le temps sidereal apparent en heures.
  const reference = A.SiderealTime(date) * 15
  const delta = Math.abs(((gmstDegrees(date) - reference + 540) % 360) - 180)
  check(`GMST ${date.toISOString().slice(0, 10)}`, delta, 0, 0.005, '°')
}

console.log('\n=== 1. Conversion equatorial → horizontal ===')
for (const loc of LOCATIONS) {
  for (const date of DATES) {
    const observer = new A.Observer(loc.latitude, loc.longitude, loc.elevation)
    // Trois etoiles de reference, coordonnees de la date via astronomy-engine.
    for (const body of [A.Body.Sun, A.Body.Moon, A.Body.Jupiter]) {
      const eq = A.Equator(body, date, observer, true, true)
      // Sans refraction : `equatorialToHorizontal` est purement geometrique.
      const reference = A.Horizon(date, observer, eq.ra, eq.dec)
      const mine = equatorialToHorizontal({ ra: eq.ra * 15, dec: eq.dec }, loc, date)

      const dAz = Math.abs(((mine.azimuth - reference.azimuth + 540) % 360) - 180)
      check(`${loc.name} ${body} azimut`, dAz, 0, 0.02, '°')
      check(`${loc.name} ${body} hauteur`, mine.altitude, reference.altitude, 0.02, '°')
    }
  }
}

console.log('\n=== 2. Matrice equatorial → scene ===')
{
  const loc = LOCATIONS[0]
  const date = DATES[0]
  const matrix = equatorialToSceneMatrix(date, loc)
  // Une dizaine de directions equatoriales quelconques.
  for (let i = 0; i < 10; i++) {
    const ra = (i * 37.3) % 360
    const dec = -80 + i * 17
    const cd = Math.cos(dec * DEG)
    const viaMatrix = new Vector3(cd * Math.cos(ra * DEG), cd * Math.sin(ra * DEG), Math.sin(dec * DEG))
      .applyMatrix4(matrix)
      .multiplyScalar(100)

    const hor = equatorialToHorizontal({ ra, dec }, loc, date)
    const [x, y, z] = horizontalToScene(hor, 100)
    check(`direction ${i} (RA ${ra.toFixed(0)}° dec ${dec}°)`, viaMatrix.distanceTo(new Vector3(x, y, z)), 0, 1e-3)
  }
}

console.log('\n=== 2 bis. Topocentrique ECI, reference externe ===')
for (const loc of LOCATIONS) {
  for (const date of DATES) {
    // Vecteur geocentrique de la Lune, ramene au repere equatorial de la date.
    const eqj = A.GeoVector(A.Body.Moon, date, false)
    const eqd = A.RotateVector(A.Rotation_EQJ_EQD(date), eqj)
    const moon = [eqd.x * A.KM_PER_AU, eqd.y * A.KM_PER_AU, eqd.z * A.KM_PER_AU]
    const obs = observerEci(loc, date)
    const mine = eciVectorToHorizontal([moon[0] - obs[0], moon[1] - obs[1], moon[2] - obs[2]], loc, date)

    const observer = new A.Observer(loc.latitude, loc.longitude, loc.elevation)
    const eq = A.Equator(A.Body.Moon, date, observer, true, false)
    const reference = A.Horizon(date, observer, eq.ra, eq.dec)

    const dAz = Math.abs(((mine.azimuth - reference.azimuth + 540) % 360) - 180)
    check(`${loc.name} Lune topocentrique azimut`, dAz, 0, 0.05, '°')
    check(`${loc.name} Lune topocentrique hauteur`, mine.altitude, reference.altitude, 0.05, '°')
  }
}

console.log('\n=== 3. Propagateur keplerien ===')
{
  // Un geostationnaire parfait doit rester fixe en azimut et hauteur.
  const geo = {
    id: 'geo',
    name: 'GEO',
    semiMajorAxisKm: 42164.17,
    eccentricity: 0,
    inclination: 0,
    raan: 0,
    argPerigee: 0,
    meanAnomaly: 0,
    epoch: DATES[0].toISOString(),
    useJ2: false,
    color: '#fff',
  }
  const loc = LOCATIONS[0]
  const t0 = computeSatelliteState(geo, DATES[0], loc)
  const t1 = computeSatelliteState(geo, new Date(DATES[0].getTime() + 6 * 3600_000), loc)
  const dAz = Math.abs(((t1.horizontal.azimuth - t0.horizontal.azimuth + 540) % 360) - 180)
  check('GEO : derive d’azimut sur 6 h', dAz, 0, 0.35, '°')
  check('GEO : derive de hauteur sur 6 h', t1.horizontal.altitude, t0.horizontal.altitude, 0.35, '°')
  check('GEO : periode', orbitalPeriod(geo.semiMajorAxisKm), 86164, 3, ' s')

  // Conservation de l'energie : le module de vitesse suit l'equation vis-viva.
  const ell = { ...geo, semiMajorAxisKm: 26554, eccentricity: 0.74, inclination: 63.4, useJ2: false }
  for (const minutes of [0, 90, 210, 400]) {
    const s = propagate(ell, new Date(DATES[0].getTime() + minutes * 60_000))
    const r = Math.hypot(...s.position)
    const v = Math.hypot(...s.velocity)
    const visViva = Math.sqrt(EARTH_MU * (2 / r - 1 / ell.semiMajorAxisKm))
    check(`Molniya t+${minutes} min : vis-viva`, v, visViva, 1e-6, ' km/s')
  }

  // Le perigee doit tomber a l'altitude attendue.
  const perigee = propagate({ ...ell, meanAnomaly: 0 }, new Date(ell.epoch))
  check(
    'Molniya : rayon au perigee',
    Math.hypot(...perigee.position),
    ell.semiMajorAxisKm * (1 - ell.eccentricity),
    1e-6,
    ' km',
  )
}

console.log('\n=== 4. Coherence topocentrique ===')
{
  const loc = LOCATIONS[1]
  const date = DATES[2]
  // Un point tres eloigne dans une direction connue doit revenir au bon azimut.
  for (const target of [
    { azimuth: 0, altitude: 45 },
    { azimuth: 90, altitude: 10 },
    { azimuth: 217, altitude: 70 },
  ]) {
    // On reconstruit un vecteur ECI a partir de la direction horizontale voulue,
    // en passant par la position de l'observateur.
    const lst = lstDegrees(date, loc.longitude) * DEG
    const lat = loc.latitude * DEG
    const alt = target.altitude * DEG
    const az = target.azimuth * DEG
    const south = -Math.cos(alt) * Math.cos(az)
    const east = Math.cos(alt) * Math.sin(az)
    const up = Math.sin(alt)
    const range = 500_000
    const rho = [
      range * (Math.sin(lat) * Math.cos(lst) * south - Math.sin(lst) * east + Math.cos(lat) * Math.cos(lst) * up),
      range * (Math.sin(lat) * Math.sin(lst) * south + Math.cos(lst) * east + Math.cos(lat) * Math.sin(lst) * up),
      range * (-Math.cos(lat) * south + Math.sin(lat) * up),
    ]
    const back = eciVectorToHorizontal(rho, loc, date)
    const dAz = Math.abs(((back.azimuth - target.azimuth + 540) % 360) - 180)
    check(`aller-retour SEZ az ${target.azimuth}°`, dAz, 0, 1e-6, '°')
    check(`aller-retour SEZ alt ${target.altitude}°`, back.altitude, target.altitude, 1e-6, '°')
  }

  // Le point sous-satellite d'un observateur doit redonner sa propre position.
  const obs = observerEci(loc, date)
  const geodetic = eciToGeodetic(obs, date)
  check('sous-point : latitude', geodetic.latitude, loc.latitude, 1e-6, '°')
  const dLon = Math.abs(((geodetic.longitude - loc.longitude + 540) % 360) - 180)
  check('sous-point : longitude', dLon, 0, 1e-6, '°')
  check('sous-point : altitude', geodetic.altitudeKm * 1000, loc.elevation, 0.5, ' m')
}

console.log('\n=== 5. Photometrie et geometrie d’occultation ===')
{
  const paris = LOCATIONS[0]

  // Nuit noire : on cherche un instant ou Soleil ET Lune sont couches, plutot
  // que de parier sur une date — la Lune se leve un peu plus tard chaque jour.
  let darkNight = null
  let moonlitNight = null
  for (let ms = Date.UTC(2026, 0, 1, 0, 0); ms < Date.UTC(2026, 1, 1); ms += 20 * 60_000) {
    const s = skyLuminance(new Date(ms), paris)
    if (s.sunAltitude > -18) continue
    // Nuit veritablement noire : Soleil bien sous le crepuscule astronomique.
    if (!darkNight && s.moonAltitude < -5 && s.sunAltitude < -30) darkNight = { ms, s }
    // Lune gibbeuse haute : le cas ou elle gate franchement la nuit.
    if (!moonlitNight && s.moonAltitude > 40 && s.moonIllumination > 0.9) moonlitNight = { ms, s }
    if (darkNight && moonlitNight) break
  }

  if (!darkNight || !moonlitNight) {
    failures++
    console.log('ECHEC recherche d’une nuit noire et d’une nuit de pleine lune')
  } else {
    check('nuit noire : eclairement au plancher', darkNight.s.illuminance, AIRGLOW_LUX, 5e-5, ' lx')
    check('nuit noire : magnitude limite', darkNight.s.limitingMagnitude, 6.6, 0.2, ' mag')

    // Le clair de lune doit se voir : c'est tout l'interet d'une echelle en lux.
    const ratio = moonlitNight.s.illuminance / darkNight.s.illuminance
    const brighter = ratio > 100
    if (!brighter) failures++
    console.log(
      `${brighter ? 'OK  ' : 'ECHEC'} ${'pleine lune haute : nuit nettement eclaircie'.padEnd(52)} ` +
        `${moonlitNight.s.illuminance.toFixed(3)} lx contre ${darkNight.s.illuminance.toFixed(4)} lx ` +
        `(×${Math.round(ratio)}), mag limite ${moonlitNight.s.limitingMagnitude.toFixed(1)} contre ${darkNight.s.limitingMagnitude.toFixed(1)}`,
    )
  }

  // Midi solaire : plusieurs dizaines de milliers de lux.
  const noon = new Date('2026-06-21T12:00:00Z')
  const daySky = skyLuminance(noon, paris)
  const okDay = daySky.illuminance > 40000 && daySky.illuminance < 130000
  if (!okDay) failures++
  console.log(
    `${okDay ? 'OK  ' : 'ECHEC'} ${'midi d’ete : eclairement plausible'.padEnd(52)} ${Math.round(daySky.illuminance)} lx (attendu 40 000 – 130 000)`,
  )
  check('midi : la magnitude limite exclut les etoiles', daySky.limitingMagnitude, -4.2, 1.2, ' mag')

  // Masse d'air : valeurs de reference, et surtout absence de divergence sous
  // l'horizon — c'est la que la formule de Pickering brute part a l'infini.
  check('masse d’air au zenith', airmass(90), 1.0, 1e-3)
  check('masse d’air a 30°', airmass(30), 2.0, 5e-2)
  check('masse d’air a 10°', airmass(10), 5.6, 0.2)
  check('masse d’air a l’horizon', airmass(0), 38.7, 1.5)
  {
    let worst = null
    for (let h = -90; h <= 90; h += 0.05) {
      const am = airmass(h)
      if (!Number.isFinite(am) || am < 1 || am > 40) worst = { h, am }
    }
    if (worst) failures++
    console.log(
      `${worst ? 'ECHEC' : 'OK  '} ${'masse d’air bornee sur [-90°, 90°]'.padEnd(52)} ` +
        (worst ? `hauteur ${worst.h.toFixed(2)}° → ${worst.am}` : 'toujours dans [1, 40]'),
    )
  }

  // Recouvrement de deux disques : cas limites analytiques.
  check('obscuration, disques disjoints', diskObscuration(1.0, 0.26, 0.26), 0, 1e-12)
  check('obscuration, disques concentriques egaux', diskObscuration(0, 0.26, 0.26), 1, 1e-12)
  check('obscuration, eclipse annulaire (Lune plus petite)', diskObscuration(0, 0.28, 0.25), (0.25 / 0.28) ** 2, 1e-12)
  check('obscuration, contact exterieur', diskObscuration(0.52, 0.26, 0.26), 0, 1e-12)
}

console.log('\n=== 6. Eclipse totale du 12 aout 2026 ===')
{
  // Le trajet de la totalite traverse l'Islande et le nord de l'Espagne.
  const sites = [
    { name: 'Reykjavik', latitude: 64.1466, longitude: -21.9426, elevation: 40 },
    { name: 'Oviedo', latitude: 43.3619, longitude: -5.8494, elevation: 232 },
    { name: 'Paris', latitude: 48.8566, longitude: 2.3522, elevation: 35 },
  ]

  for (const site of sites) {
    let peak = { obscuration: 0, time: null, illuminance: 0, limit: 0 }
    // Balayage de la journee a la minute, autour de l'apres-midi europeen.
    for (let ms = Date.UTC(2026, 7, 12, 15, 0); ms <= Date.UTC(2026, 7, 12, 21, 0); ms += 60_000) {
      const s = skyLuminance(new Date(ms), site)
      if (s.obscuration > peak.obscuration) {
        peak = { obscuration: s.obscuration, time: new Date(ms), illuminance: s.illuminance, limit: s.limitingMagnitude }
      }
    }
    const clear = skyLuminance(new Date(Date.UTC(2026, 7, 12, 12, 0)), site)
    console.log(
      `     ${site.name.padEnd(12)} obscuration max ${(peak.obscuration * 100).toFixed(1).padStart(5)} %` +
        ` a ${peak.time ? peak.time.toISOString().slice(11, 16) : '--:--'} UTC` +
        ` — eclairement ${Math.round(peak.illuminance).toLocaleString('fr-FR')} lx` +
        ` (vs ${Math.round(clear.illuminance).toLocaleString('fr-FR')} lx a midi), mag limite ${peak.limit.toFixed(1)}`,
    )
  }

  // L'Islande est dans la bande de totalite : le disque doit etre entierement couvert.
  let icelandMax = 0
  let icelandDark = Infinity
  for (let ms = Date.UTC(2026, 7, 12, 17, 0); ms <= Date.UTC(2026, 7, 12, 19, 0); ms += 20_000) {
    const s = skyLuminance(new Date(ms), sites[0])
    icelandMax = Math.max(icelandMax, s.obscuration)
    if (s.obscuration > 0.99) icelandDark = Math.min(icelandDark, s.illuminance)
  }
  const totality = icelandMax > 0.99
  if (!totality) failures++
  console.log(`${totality ? 'OK  ' : 'ECHEC'} ${'Reykjavik : totalite atteinte'.padEnd(52)} obscuration ${(icelandMax * 100).toFixed(2)} %`)

  // Pendant la totalite, l'eclairement doit tomber au niveau d'un crepuscule.
  const dusk = Number.isFinite(icelandDark) && icelandDark < 500
  if (!dusk) failures++
  console.log(
    `${dusk ? 'OK  ' : 'ECHEC'} ${'totalite : ciel de crepuscule'.padEnd(52)} ${Number.isFinite(icelandDark) ? Math.round(icelandDark) : '—'} lx (attendu < 500)`,
  )

  // Ordre de profondeur : la Lune doit passer DEVANT le Soleil dans la scene.
  const t = new Date(Date.UTC(2026, 7, 12, 18, 0))
  const moon = computeBodyState(BODY_BY_ID.get('moon'), t, sites[0])
  const sun = computeBodyState(BODY_BY_ID.get('sun'), t, sites[0])
  const ordered = sceneDepth(moon.distanceKm) < sceneDepth(sun.distanceKm)
  if (!ordered) failures++
  console.log(
    `${ordered ? 'OK  ' : 'ECHEC'} ${'profondeur : Lune devant Soleil'.padEnd(52)} ${sceneDepth(moon.distanceKm).toFixed(2)} < ${sceneDepth(sun.distanceKm).toFixed(2)}`,
  )

  // Le rapport rayon/profondeur doit reproduire le diametre apparent reel.
  for (const body of [moon, sun]) {
    const angular = 2 * Math.asin(sceneRadiusForBody(body.radiusKm, body.distanceKm) / sceneDepth(body.distanceKm)) * RAD
    check(`${body.name} : diametre apparent preserve`, angular, body.angularDiameter, 1e-6, '°')
  }
}

console.log('\n=== 7. Eclairement solaire des corps ===')
{
  // La scene n'oriente plus les phases a la main : elle transporte le vecteur
  // corps → Soleil depuis le repere equatorial. Ce vecteur doit donc, a lui
  // seul, reproduire l'angle de phase de chaque corps — de la Lune a Neptune.
  // Une erreur ici passerait inapercue sur la Lune, ou la geometrie est proche
  // de l'opposition, mais retournerait le croissant de Venus.
  const paris = LOCATIONS[0]
  const dates = [new Date('2026-02-14T20:00:00Z'), new Date('2026-08-16T22:30:00Z')]

  for (const date of dates) {
    console.log(`  ${date.toISOString().slice(0, 16)} UTC`)
    for (const def of BODIES) {
      if (def.id === 'sun') continue
      const st = computeBodyState(def, date, paris)

      // Direction corps → observateur : l'oppose de la ligne de visee.
      const r = Math.hypot(...st.positionEq)
      const toObserver = st.positionEq.map((v) => -v / r)
      const cosPhase =
        st.sunDirectionEq[0] * toObserver[0] +
        st.sunDirectionEq[1] * toObserver[1] +
        st.sunDirectionEq[2] * toObserver[2]

      const phaseDeg = Math.acos(Math.min(1, Math.max(-1, cosPhase))) * RAD
      const fraction = (1 + cosPhase) / 2
      const ref = A.Illumination(def.body, date)

      // Tolerance elargie pour la Lune : la reference est geocentrique, notre
      // geometrie topocentrique, et la parallaxe lunaire atteint le degre.
      const tolerance = def.id === 'moon' ? 1.2 : 0.05
      check(`  ${def.name} : angle de phase`, phaseDeg, ref.phase_angle, tolerance, '°')
      check(`  ${def.name} : fraction eclairee`, fraction, ref.phase_fraction, def.id === 'moon' ? 1e-2 : 1e-3)
    }
  }

  // Coherence physique : plus un corps est loin, plus son angle de phase vu de
  // la Terre est contraint. Au-dela de Mars, il ne peut plus depasser
  // asin(1 ua / distance heliocentrique).
  const date = dates[0]
  for (const id of ['jupiter', 'saturn', 'uranus', 'neptune']) {
    const def = BODY_BY_ID.get(id)
    const st = computeBodyState(def, date, paris)
    const ref = A.Illumination(def.body, date)
    const helio = A.HelioDistance(def.body, date)
    const maxPhase = Math.asin(Math.min(1, 1 / helio)) * RAD
    const ok = ref.phase_angle <= maxPhase + 0.5 && st.illumination > 0.97
    if (!ok) failures++
    console.log(
      `${ok ? 'OK  ' : 'ECHEC'} ${`${def.name} : phase bornee par la distance`.padEnd(52)} ` +
        `${ref.phase_angle.toFixed(2)}° ≤ ${maxPhase.toFixed(2)}°, eclaire a ${(st.illumination * 100).toFixed(1)} %`,
    )
  }

  // Venus doit montrer des phases marquees : c'est le test qui distingue une
  // direction d'eclairement juste d'une direction simplement plausible.
  let minFraction = 1
  let maxFraction = 0
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 5 * 86400000) {
    const st = computeBodyState(BODY_BY_ID.get('venus'), new Date(ms), paris)
    minFraction = Math.min(minFraction, st.illumination)
    maxFraction = Math.max(maxFraction, st.illumination)
  }
  const venusOk = minFraction < 0.15 && maxFraction > 0.9
  if (!venusOk) failures++
  console.log(
    `${venusOk ? 'OK  ' : 'ECHEC'} ${'Venus : amplitude des phases sur un an'.padEnd(52)} ` +
      `de ${(minFraction * 100).toFixed(1)} % a ${(maxFraction * 100).toFixed(1)} % (attendu < 15 % et > 90 %)`,
  )
}

console.log('\n=== 8. Ciel profond (OpenNGC) ===')
{
  console.log(`     ${DEEP_SKY_COUNT} objets embarques jusqu'a la magnitude ${DEEP_SKY_MAG_LIMIT}`)

  // Positions de reference. Elles viennent du catalogue lui-meme, mais les
  // valeurs attendues sont celles, independantes, de la consigne de mission.
  const references = [
    { query: 'M31', ra: 10.6848, dec: 41.2688, name: 'Andromeda Galaxy' },
    { query: 'M42', ra: 83.8221, dec: -5.3911, name: 'Great Orion Nebula' },
    { query: 'M13', ra: 250.4235, dec: 36.4613, name: 'Hercules Globular Cluster' },
  ]

  for (const ref of references) {
    const object = findDeepSkyObject(ref.query)
    if (!object) {
      failures++
      console.log(`ECHEC ${`${ref.query} introuvable`.padEnd(52)}`)
      continue
    }
    check(`${ref.query} : ascension droite`, object.ra, ref.ra, 0.02, '°')
    check(`${ref.query} : declinaison`, object.dec, ref.dec, 0.02, '°')
    const named = object.name === ref.name
    if (!named) failures++
    console.log(`${named ? 'OK  ' : 'ECHEC'} ${`${ref.query} : nom usuel`.padEnd(52)} « ${object.name} »`)
  }

  // Taille apparente : M31 fait environ 3°, soit six fois la Lune. Si elle
  // sortait ponctuelle, tout le rendu des objets etendus serait faux.
  const m31 = findDeepSkyObject('M31')
  const moonDiameter = 0.518
  const ratio = m31.majorArcmin / 60 / moonDiameter
  check('M31 : grand axe apparent', m31.majorArcmin / 60, 2.96, 0.1, '°')
  const sixMoons = ratio > 5 && ratio < 7
  if (!sixMoons) failures++
  console.log(
    `${sixMoons ? 'OK  ' : 'ECHEC'} ${'M31 : rapport a la Lune'.padEnd(52)} ${ratio.toFixed(1)}× (attendu ≈ 6×)`,
  )

  // Brillance de surface : c'est elle, et non la magnitude integree, qui
  // explique qu'une galaxie de magnitude 3,4 reste difficile a l'oeil nu.
  check('M31 : brillance de surface', m31.surfaceBrightness, 22.1, 0.6, ' mag/arcsec²')
  const darkSky = skySurfaceBrightness(AIRGLOW_LUX)
  check('fond de ciel, site noir', darkSky, 21.8, 0.01, ' mag/arcsec²')
  const fainterThanSky = m31.surfaceBrightness > darkSky
  if (!fainterThanSky) failures++
  console.log(
    `${fainterThanSky ? 'OK  ' : 'ECHEC'} ${'M31 : plus tenue que le fond de ciel'.padEnd(52)} ` +
      `${m31.surfaceBrightness.toFixed(2)} > ${darkSky.toFixed(2)} — seul le noyau ressort a l'oeil nu`,
  )

  // De jour, le fond de ciel doit noyer tout objet etendu.
  const daySky = skySurfaceBrightness(100000)
  const invisibleByDay = daySky < 5
  if (!invisibleByDay) failures++
  console.log(
    `${invisibleByDay ? 'OK  ' : 'ECHEC'} ${'fond de ciel de jour'.padEnd(52)} ` +
      `${daySky.toFixed(2)} mag/arcsec² — aucun objet etendu ne s'en detache`,
  )

  // Precession J2000 → date : le catalogue est en J2000, la scene en repere de
  // la date. Sur un quart de siecle, l'ecart doit etre de l'ordre du tiers de degre.
  const geometry = buildDeepSkyGeometry(new Date('2026-08-17T00:00:00Z'))
  const k = geometry.indices.indexOf(m31.index)
  const [x, y, z] = [geometry.positions[k * 3], geometry.positions[k * 3 + 1], geometry.positions[k * 3 + 2]]
  const precessed = { ra: ((Math.atan2(y, x) * RAD) + 360) % 360, dec: Math.asin(z) * RAD }
  const shift = Math.acos(
    Math.min(
      1,
      Math.sin(precessed.dec * DEG) * Math.sin(m31.dec * DEG) +
        Math.cos(precessed.dec * DEG) * Math.cos(m31.dec * DEG) * Math.cos((precessed.ra - m31.ra) * DEG),
    ),
  ) * RAD
  const plausible = shift > 0.2 && shift < 0.5
  if (!plausible) failures++
  console.log(
    `${plausible ? 'OK  ' : 'ECHEC'} ${'M31 : precession J2000 → 2026'.padEnd(52)} ` +
      `${(shift * 60).toFixed(1)}′ (attendu 12′ à 30′ sur 26 ans)`,
  )

  // Le catalogue Messier doit etre presque complet.
  const messierOk = MESSIER_OBJECTS.length >= 100
  if (!messierOk) failures++
  console.log(
    `${messierOk ? 'OK  ' : 'ECHEC'} ${'objets Messier presents'.padEnd(52)} ` +
      `${MESSIER_OBJECTS.length} / 110 (les manquants sont des asterismes ou des doublons)`,
  )
}

console.log(`\n${failures === 0 ? 'Toutes les verifications passent.' : `${failures} verification(s) en echec.`}`)
process.exit(failures === 0 ? 0 : 1)
