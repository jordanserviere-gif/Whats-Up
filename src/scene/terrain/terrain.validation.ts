/**
 * Validation du relief reel — geodesie, tuiles, pyramide, horizon.
 *
 * Aucun de ces controles ne touche le reseau. Ils portent sur la partie
 * **calculable** de la chaine : ou l'on projette, ce qu'on decode, comment on
 * echantillonne, et ou le globe s'arrete. Le telechargement, lui, n'a rien a
 * valider — il rend des octets ou il n'en rend pas.
 *
 * Le controle central est celui de l'ecart au vrai geodesique. Il aurait ete
 * facile d'affirmer qu'une sphere de rayon gaussien « suffit » ; on le
 * **mesure**, contre la solution inverse de Vincenty sur l'ellipsoide WGS84.
 */
import { EARTH_MEAN_RADIUS_M } from '@/atmosphere/core/units'
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import { horizonDipDeg } from '@/atmosphere/refraction/rayBending'
import { HORIZON_MARGIN_DEG } from '@/atmosphere/horizonMargin'
import {
  enuToGeodetic,
  gaussianRadiusM,
  geodeticToEnu,
  lonLatToTile,
  meridianRadiusM,
  sphericalEnuToGeodetic,
  tileGroundResolutionM,
  tileToLonLat,
  vincentyInverse,
  zoomForResolution,
} from './geodesy'
import { decodeTerrariumTile, terrainSurfaceM, terrariumHeightM } from './terrarium'
import {
  CLIPMAP_HALF_SPANS_M,
  CLIPMAP_SIZE,
  createClipmap,
  sampleClipmap,
} from './elevationClipmap'
import { apparentElevationRad, effectiveEarthRadiusM, horizonRangeM } from './ridgeField'

const DEG = Math.PI / 180

/** Le raccourci au premier ordre, present pour mesurer ce qu'on gagne a le fuir. */
function firstOrderGeodetic(lat0Deg: number, lon0Deg: number, eastM: number, northM: number) {
  const R = EARTH_MEAN_RADIUS_M
  const latitudeDeg = lat0Deg + (northM / R) / DEG
  const longitudeDeg = lon0Deg + (eastM / (R * Math.cos(lat0Deg * DEG))) / DEG
  return { latitudeDeg, longitudeDeg }
}

/** Ecart de position, m, entre un point vise et le point reellement place. */
function placementErrorM(
  lat0: number,
  lon0: number,
  targetDistanceM: number,
  targetBearingDeg: number,
  placed: { latitudeDeg: number; longitudeDeg: number },
): number {
  const got = vincentyInverse(lat0, lon0, placed.latitudeDeg, placed.longitudeDeg)
  let dBearing = got.bearingDeg - targetBearingDeg
  if (dBearing > 180) dBearing -= 360
  if (dBearing < -180) dBearing += 360
  // Erreur radiale et erreur transverse, composees.
  return Math.hypot(got.distanceM - targetDistanceM, targetDistanceM * dBearing * DEG)
}

export function terrainSuite(): SuiteResult {
  return suite(
    'Relief reel — geodesie, tuiles et pyramide',
    { reference: 'Vincenty (1975) ; EPSG:3857 ; Mapzen terrarium (SRTM/NED)' },
    (t) => {
      const PARIS = { lat: 48.8566, lon: 2.3522 }
      const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315]

      // --- L'aller-retour se referme --------------------------------------
      // Il ne prouve pas l'exactitude, seulement la coherence des deux sens.
      // Une faute de signe sur l'azimut passerait tous les tests de distance et
      // se ferait prendre ici.
      let worstRoundTrip = 0
      for (const site of [PARIS, { lat: -33.9, lon: 151.2 }, { lat: 69.6, lon: 18.9 }]) {
        for (const distance of [1_000, 50_000, 450_000]) {
          for (const bearing of BEARINGS) {
            const eastM = distance * Math.sin(bearing * DEG)
            const northM = distance * Math.cos(bearing * DEG)
            const g = enuToGeodetic(site.lat, site.lon, eastM, northM)
            const back = geodeticToEnu(site.lat, site.lon, g.latitudeDeg, g.longitudeDeg)
            worstRoundTrip = Math.max(
              worstRoundTrip,
              Math.hypot(back.eastM - eastM, back.northM - northM),
            )
          }
        }
      }
      t.check('l aller-retour local revient au point de depart', worstRoundTrip, 0, 1e-3, ' m')

      // --- Deux etalons qui ne doivent rien a Vincenty ----------------------
      //
      // La projection **est** Vincenty : la comparer a Vincenty ne prouverait
      // rien. Il faut deux proprietes que l on sache calculer autrement.
      //
      // La premiere : le long d un meridien, la longueur d arc est l integrale
      // du rayon de courbure meridien. Une marche de Simpson la donne, sans
      // rien emprunter aux equations imbriquees.
      const northPoint = enuToGeodetic(PARIS.lat, PARIS.lon, 0, 450_000)
      const steps = 20_000
      let arcM = 0
      for (let i = 0; i < steps; i++) {
        const a = PARIS.lat + ((northPoint.latitudeDeg - PARIS.lat) * i) / steps
        const b = PARIS.lat + ((northPoint.latitudeDeg - PARIS.lat) * (i + 1)) / steps
        const m = (a + b) / 2
        // Simpson sur chaque intervalle.
        arcM +=
          ((b - a) * DEG * (meridianRadiusM(a) + 4 * meridianRadiusM(m) + meridianRadiusM(b))) / 6
      }
      t.check(
        'un trajet plein nord retombe sur l integrale du rayon meridien',
        arcM,
        450_000,
        0.05,
        ' m',
      )
      t.checkTrue(
        'et la longitude n a pas bouge',
        Math.abs(northPoint.longitudeDeg - PARIS.lon) < 1e-12,
        `${((northPoint.longitudeDeg - PARIS.lon) * 3.6e6).toExponential(1)} millisecondes d arc`,
      )

      // La seconde : l equateur est lui-meme un geodesique, de rayon exactement
      // le demi-grand axe. Aucune iteration necessaire pour savoir ou l on
      // arrive.
      const eastPoint = enuToGeodetic(0, 0, 450_000, 0)
      t.check(
        'et sur l equateur, la longitude vaut la distance sur le demi-grand axe',
        eastPoint.longitudeDeg,
        (450_000 / 6_378_137) / DEG,
        1e-9,
        '°',
      )

      // --- Ce que chaque approximation aurait coute -------------------------
      let worstSpherical = 0
      let worstFirstOrder = 0
      for (const bearing of BEARINGS) {
        const eastM = 450_000 * Math.sin(bearing * DEG)
        const northM = 450_000 * Math.cos(bearing * DEG)
        worstSpherical = Math.max(
          worstSpherical,
          placementErrorM(
            PARIS.lat,
            PARIS.lon,
            450_000,
            bearing,
            sphericalEnuToGeodetic(PARIS.lat, PARIS.lon, eastM, northM),
          ),
        )
        worstFirstOrder = Math.max(
          worstFirstOrder,
          placementErrorM(
            PARIS.lat,
            PARIS.lon,
            450_000,
            bearing,
            firstOrderGeodetic(PARIS.lat, PARIS.lon, eastM, northM),
          ),
        )
      }

      // A quatre cent cinquante kilometres, un pixel d ecran couvre deux cent
      // soixante-treize metres. C est l etalon qui decide si une approximation
      // se verrait.
      t.checkTrue(
        'la sphere gaussienne, elle, se serait vue',
        worstSpherical > 273,
        `${worstSpherical.toFixed(0)} m d ecart pour un pixel qui en couvre 273 — ` +
          'c est ce qui a impose l ellipsoide',
      )
      t.checkTrue(
        'et le raccourci au premier ordre, largement',
        worstFirstOrder > 20 * worstSpherical,
        `${(worstFirstOrder / 1000).toFixed(1)} km contre ${worstSpherical.toFixed(0)} m — ` +
          'soit un deplacement apparent de ' +
          `${(Math.atan(worstFirstOrder / 450_000) / DEG).toFixed(2)} degres`,
      )

      t.note(
        `rayon gaussien a Paris : ${(gaussianRadiusM(PARIS.lat) / 1000).toFixed(1)} km ` +
          `(rayon moyen ${(EARTH_MEAN_RADIUS_M / 1000).toFixed(1)} km)`,
      )

      // --- Les tuiles ------------------------------------------------------
      let worstTile = 0
      for (const zoom of [8, 10, 12]) {
        for (const site of [PARIS, { lat: -33.9, lon: 151.2 }, { lat: 0, lon: -179.5 }]) {
          const tile = lonLatToTile(site.lon, site.lat, zoom)
          const back = tileToLonLat(tile.x, tile.y, zoom)
          worstTile = Math.max(
            worstTile,
            Math.abs(back.latitudeDeg - site.lat),
            Math.abs(back.longitudeDeg - site.lon),
          )
        }
      }
      t.check('l aller-retour tuile revient a la meme position', worstTile, 0, 1e-9, '°')

      // La resolution au sol depend de la latitude : c est elle, et non la
      // valeur equatoriale, qui decide du zoom a demander.
      const resParis = tileGroundResolutionM(PARIS.lat, 12)
      t.checkTrue(
        'la resolution des tuiles suit la latitude',
        resParis > 24 && resParis < 26,
        `z=12 vaut ${resParis.toFixed(1)} m a Paris contre ` +
          `${tileGroundResolutionM(0, 12).toFixed(1)} m a l equateur`,
      )
      // Le choix du zoom tolere un quart de depassement, pour ne pas basculer
      // d'un niveau entier — donc quadrupler le telechargement — pour quelques
      // pour cent de latitude. La tolerance doit tenir a toutes les latitudes.
      let worstOvershoot = 0
      for (let lat = -60; lat <= 60; lat += 2.5) {
        for (const target of [27.4, 109.9, 439.6]) {
          worstOvershoot = Math.max(
            worstOvershoot,
            tileGroundResolutionM(lat, zoomForResolution(lat, target)) / target,
          )
        }
      }
      t.checkTrue(
        'le choix du zoom ne depasse jamais sa tolerance',
        worstOvershoot <= 1.2500001,
        `depassement maximal x${worstOvershoot.toFixed(3)} sur 49 latitudes et les trois niveaux`,
      )

      // --- Le decodage terrarium -------------------------------------------
      // Trois valeurs que l on peut poser a la main : le zero de l encodage,
      // le niveau de la mer, et un sommet.
      t.check('l encodage terrarium a son zero a -32768 m', terrariumHeightM(0, 0, 0), -32768, 1e-9, ' m')
      t.check('le niveau de la mer tombe sur 128,0,0', terrariumHeightM(128, 0, 0), 0, 1e-9, ' m')
      t.check('un sommet de 4808 m se relit', terrariumHeightM(146, 200, 0), 4808, 1e-9, ' m')
      t.check('le canal bleu porte le seizieme de metre', terrariumHeightM(128, 0, 16), 1 / 16, 1e-12, ' m')

      // Le decodage **garde** le signe : la carte de selection du lieu en a
      // besoin pour distinguer la mer de la plaine cotiere.
      const rgba = new Uint8ClampedArray(256 * 256 * 4)
      for (let i = 0; i < 256 * 256; i++) {
        // 100,0,0 vaut -7168 m : une plaine abyssale.
        rgba[i * 4] = 100
        rgba[i * 4 + 3] = 255
      }
      const decoded = decodeTerrariumTile(rgba)
      let deepest = 0
      for (let i = 0; i < decoded.length; i++) deepest = Math.min(deepest, decoded[i])
      t.check('le decodage conserve la bathymetrie', deepest, -7168, 0, ' m')

      // La surface, elle, l ecrete : sans quoi l ocean se creuserait en cuvette
      // et l observateur cotier se retrouverait au bord d une falaise de quatre
      // kilometres.
      t.check('la surface, elle, ecrete au niveau de la mer', terrainSurfaceM(-7168), 0, 0, ' m')
      t.check('et ne touche pas au relief emerge', terrainSurfaceM(4808), 4808, 0, ' m')

      // --- La pyramide ------------------------------------------------------
      const clipmap = createClipmap(PARIS.lat, PARIS.lon, [12, 10, 8])
      t.check('trois niveaux', clipmap.levels.length, 3, 0)
      t.checkTrue(
        'chaque niveau reste autour de deux pixels par cellule',
        clipmap.levels.every((level) => {
          // Le pixel d ecran a la portee du niveau, contre la taille de sa cellule.
          const screenM = level.halfSpanM * 0.0347 * DEG
          return level.stepM > screenM * 0.5 && level.stepM < screenM * 3
        }),
        clipmap.levels
          .map((l) => `${(l.halfSpanM / 1000).toFixed(0)} km a ${l.stepM.toFixed(0)} m`)
          .join(' · '),
      )

      // Rien de charge : la pyramide rend le niveau de la mer, pas du bruit.
      t.check('a vide, la pyramide rend le niveau de la mer', sampleClipmap(clipmap, 5_000, 5_000), 0, 0, ' m')

      // On remplit les deux niveaux fins avec deux constantes differentes pour
      // observer la couture. Sans fondu, le passage de l un a l autre
      // dessinerait un anneau net autour de l observateur.
      clipmap.levels[0].heightM.fill(1000)
      clipmap.levels[0].ready = true
      clipmap.levels[1].heightM.fill(2000)
      clipmap.levels[1].ready = true

      const fine = CLIPMAP_HALF_SPANS_M[0]
      t.check('au coeur du niveau fin, c est lui qui parle', sampleClipmap(clipmap, 0, 0), 1000, 1e-6, ' m')
      t.check('juste au-dela, c est le suivant', sampleClipmap(clipmap, fine * 1.05, 0), 2000, 1e-6, ' m')

      // La couture doit etre continue : on echantillonne en travers et on
      // cherche le plus grand saut entre deux points voisins.
      let worstJump = 0
      let previous = sampleClipmap(clipmap, fine * 0.8, 0)
      for (let i = 1; i <= 400; i++) {
        const eastM = fine * (0.8 + (0.25 * i) / 400)
        const value = sampleClipmap(clipmap, eastM, 0)
        worstJump = Math.max(worstJump, Math.abs(value - previous))
        previous = value
      }
      t.checkTrue(
        'la couture entre niveaux ne fait pas de marche',
        worstJump < 40,
        `saut maximal ${worstJump.toFixed(1)} m sur un ecart de 1000 m entre les deux niveaux`,
      )

      t.note(
        `empreinte de la pyramide : ${((3 * CLIPMAP_SIZE * CLIPMAP_SIZE * 2) / 1e6).toFixed(1)} Mo, ` +
          'independante du rayon demande',
      )

      // --- Le globe s arrete exactement a l horizon apparent -----------------
      //
      // Le nuanceur du globe resout l intersection rayon-sphere avec le rayon
      // effectif sous refraction. La calotte, elle, s ouvre a l horizon apparent
      // donne par l integrale de refraction.
      //
      // Ce qui doit etre vrai, c est que **le rayon touche encore le sol au bord
      // de la calotte** : un discriminant negatif y ferait rejeter le fragment,
      // et une frange de fond de ciel apparaitrait entre le globe et l horizon.
      let worstDisc = Infinity
      let worstRange = 0
      for (const elevationM of [2, 35, 500, 3000, 8000]) {
        const dip = horizonDipDeg(elevationM)
        const R = effectiveEarthRadiusM(elevationM, dip)
        const r0 = R + elevationM
        const mu = -Math.sin(dip * DEG)
        const disc = r0 * r0 * mu * mu - (r0 * r0 - R * R)
        worstDisc = Math.min(worstDisc, disc)
        const range = -r0 * mu - Math.sqrt(Math.max(0, disc))
        worstRange = Math.max(
          worstRange,
          Math.abs(range - horizonRangeM(0, elevationM, R)) / horizonRangeM(0, elevationM, R),
        )
      }
      t.checkTrue(
        'au bord de la calotte, le regard touche encore le globe',
        worstDisc >= 0,
        'aucun fragment rejete a l horizon apparent : pas de frange entre le globe et le ciel',
      )

      // --- Les trois couches n ont qu un seul horizon -----------------------
      //
      // ⚠️ Le defaut que ce controle existe pour empecher : le relief suivait
      // l oeil pendant que le ciel et le globe suivaient l altitude du **site**.
      // Tant que l on se tenait au sol les deux coincidaient et rien ne se
      // voyait. Des qu une hauteur s ajoutait, les horizons se separaient et la
      // bande entre eux n appartenait a personne — on y voyait le fondu du ciel
      // s eteindre seul, a 47 % sept mille metres au-dessus de Chamonix et noir
      // a dix mille.
      //
      // Trois grandeurs doivent donc rester egales pour toute altitude d oeil :
      // la silhouette du relief sur une mer plate, l horizon que le nuanceur du
      // globe calcule par intersection, et l ancrage du fondu du ciel.
      let worstSeam = 0
      let worstFadeReach = -Infinity
      for (const eyeM of [2, 35, 500, 1035, 3000, 7040, 10_000, 15_000]) {
        const dip = horizonDipDeg(eyeM)
        const R = effectiveEarthRadiusM(eyeM, dip)

        // Le relief : le plus haut point de sa silhouette sur une mer plate,
        // atteint a `sqrt(2 R h)`.
        let silhouetteDeg = -Infinity
        for (let i = 1; i <= 4000; i++) {
          const d = (Math.sqrt(2 * R * eyeM) * 2 * i) / 4000
          silhouetteDeg = Math.max(silhouetteDeg, apparentElevationRad(d, 0, eyeM, R) / DEG)
        }

        // Le globe : la hauteur sous laquelle son discriminant devient positif.
        const r0 = R + eyeM
        const globeDeg = -Math.asin(Math.sqrt(1 - (R * R) / (r0 * r0))) / DEG

        worstSeam = Math.max(
          worstSeam,
          Math.abs(silhouetteDeg - globeDeg),
          Math.abs(silhouetteDeg + dip),
        )

        // Le fondu du ciel s ancre sur `dip` et ne retire rien au-dessus de
        // lui. Ce qu il faut verifier n est donc pas un angle mais **ce que le
        // ciel y perd** : la ou le globe s arrete, le fondu doit etre encore
        // indiscernable de un.
        const overshootDeg = Math.max(0, globeDeg + dip)
        const u = Math.min(1, overshootDeg / HORIZON_MARGIN_DEG)
        worstFadeReach = Math.max(worstFadeReach, 3 * u * u - 2 * u * u * u)
      }

      // ⚠️ La tolerance n est pas arbitraire : l ecart residuel est la
      // difference entre la tangente **exacte** que resout le globe et la
      // relation petit-angle `dip = sqrt(2h/R)` dont vivent le relief et la
      // table de refraction. Elle croit comme l altitude et vaut 9,5″ a quinze
      // kilometres — **un dixieme de pixel**. La reduire demanderait de choisir
      // l un des deux modeles pour les deux, ce qui degraderait le globe.
      t.check(
        'relief, globe et ciel partagent un seul horizon',
        worstSeam,
        0,
        0.01,
        '° sur huit altitudes d oeil, de deux metres a quinze kilometres',
      )
      t.checkTrue(
        'et le fondu du ciel n a rien retire la ou le globe s arrete',
        worstFadeReach < 1e-4,
        `perte maximale ${(worstFadeReach * 100).toExponential(1)} % de la radiance du ciel — ` +
          'le fondu ne mord pas dans le ciel visible',
      )

      // ⚠️ Les deux ne donnent pas la **meme distance**, et c est attendu :
      // l intersection est exacte, tandis que `horizonRangeM` garde la relation
      // petit-angle `sqrt(2 R h)`. L ecart croit comme la racine de l altitude
      // et n a aucune consequence visible — il ne deplace pas l horizon d un
      // iota, il ne change que la quantite de voile attribuee au dernier
      // kilometre.
      t.checkTrue(
        'et l ecart de distance au modele petit-angle reste sans effet visible',
        worstRange < 0.05,
        `${(worstRange * 100).toFixed(1)} % au plus, a huit mille metres — ` +
          'meme direction, seule la distance differe, donc seul le voile',
      )
    },
  )
}
