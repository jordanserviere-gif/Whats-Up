/**
 * Geodesie locale — du repere de la scene a la Terre, et retour.
 *
 * ## Pourquoi pas le raccourci habituel
 *
 * On voit partout la conversion « une minute de latitude vaut un mille » :
 *
 *     latitude  = latitude0 + nord / R
 *     longitude = longitude0 + est / (R cos latitude0)
 *
 * C'est un developpement au **premier ordre**, et son erreur croit comme le cube
 * de la distance. Mesuree a quatre cent cinquante kilometres depuis Paris, elle
 * atteint **20,9 km** — deux degres et demi de deplacement apparent. Une chaine
 * entiere se retrouverait au mauvais endroit.
 *
 * ## Sphere ou ellipsoide : la mesure a tranche
 *
 * La correction evidente est de resoudre le probleme direct **exactement sur une
 * sphere**, en prenant le rayon de courbure gaussien du site — la moyenne
 * geometrique des deux rayons principaux de l'ellipsoide, qui l'epouse au second
 * ordre :
 *
 *     M   = a(1 - e2) / (1 - e2 sin^2 phi)^{3/2}     meridien
 *     N   = a / sqrt(1 - e2 sin^2 phi)               premiere verticale
 *     R_G = sqrt(M N)
 *
 * On l'a ecrite, puis mesuree : l'ecart residuel au vrai geodesique WGS84 vaut
 * encore **814 metres a quatre cent cinquante kilometres**. Vingt-cinq fois
 * mieux que le premier ordre, et **trois pixels d'ecran** tout de meme. La
 * sphere ne suffisait donc pas.
 *
 * On resout donc sur l'**ellipsoide**, par les equations imbriquees de Vincenty.
 * Elles sont iteratives, ce qui serait redhibitoire par cellule de pyramide —
 * douze millions d'appels. Mais la projection n'est evaluee que sur un
 * **treillis** de 65 par 65 et par niveau, soit douze mille appels en tout :
 * l'exactitude y est gratuite.
 *
 * La version spherique reste exportee : elle sert d'etalon de comparaison dans
 * la validation, qui chiffre ce que chaque choix coute.
 *
 * ## Le repere des tuiles
 *
 * Web Mercator utilise son propre rayon, `6378137 m`, fixe par la specification
 * et non negociable. Ce n'est pas une incoherence avec ce qui precede : les deux
 * vivent dans des domaines differents, et la latitude et la longitude sont la
 * monnaie commune qui les separe. Rien ne melange jamais des metres de l'un avec
 * des metres de l'autre.
 */

/** Demi-grand axe WGS84, m. */
const WGS84_A = 6_378_137
/** Aplatissement WGS84. */
const WGS84_F = 1 / 298.257_223_563
/** Demi-petit axe WGS84, m. */
const WGS84_B = WGS84_A * (1 - WGS84_F)
/** Premiere excentricite au carre, WGS84. */
const WGS84_E2 = WGS84_F * (2 - WGS84_F)

/**
 * Rayon de la sphere de Web Mercator, m.
 *
 * Fixe par la specification EPSG:3857, qui traite la Terre comme une sphere de
 * ce rayon meme lorsque les donnees sont sur l'ellipsoide. Toute autre valeur
 * decalerait les tuiles.
 */
export const WEB_MERCATOR_RADIUS_M = 6_378_137

/** Cote d'une tuile, pixels. Convention des tuiles raster. */
export const TILE_SIZE = 256

const DEG = Math.PI / 180

export interface Geodetic {
  latitudeDeg: number
  longitudeDeg: number
}

export interface LocalOffset {
  /** Vers l'est, m. */
  eastM: number
  /** Vers le nord, m. */
  northM: number
}

/**
 * Rayon de courbure gaussien de l'ellipsoide WGS84 a une latitude.
 *
 * Le rayon de la sphere qui approche le mieux l'ellipsoide **autour du site** —
 * pas le rayon moyen de la Terre, qui n'approche rien en particulier.
 */
export function gaussianRadiusM(latitudeDeg: number): number {
  const s = Math.sin(latitudeDeg * DEG)
  const w = 1 - WGS84_E2 * s * s
  const meridian = (WGS84_A * (1 - WGS84_E2)) / Math.pow(w, 1.5)
  const primeVertical = WGS84_A / Math.sqrt(w)
  return Math.sqrt(meridian * primeVertical)
}

/** Rayon de courbure meridien, m — la courbure dans le plan nord-sud. */
export function meridianRadiusM(latitudeDeg: number): number {
  const s = Math.sin(latitudeDeg * DEG)
  return (WGS84_A * (1 - WGS84_E2)) / Math.pow(1 - WGS84_E2 * s * s, 1.5)
}

/**
 * Probleme direct sur une **sphere** de rayon donne.
 *
 *     sin(phi) = sin(phi0) cos(s) + cos(phi0) sin(s) cos(alpha)
 *     lambda   = lambda0 + atan2( sin(alpha) sin(s) cos(phi0),
 *                                 cos(s) - sin(phi0) sin(phi) )
 *
 * Conservee comme etalon : c'est la solution qu'on aurait gardee sans mesurer.
 */
export function sphericalEnuToGeodetic(
  originLatitudeDeg: number,
  originLongitudeDeg: number,
  eastM: number,
  northM: number,
  radiusM = gaussianRadiusM(originLatitudeDeg),
): Geodetic {
  const distance = Math.hypot(eastM, northM)
  if (distance === 0) return { latitudeDeg: originLatitudeDeg, longitudeDeg: originLongitudeDeg }

  const bearing = Math.atan2(eastM, northM)
  const s = distance / radiusM
  const phi0 = originLatitudeDeg * DEG

  const sinPhi = Math.sin(phi0) * Math.cos(s) + Math.cos(phi0) * Math.sin(s) * Math.cos(bearing)
  const phi = Math.asin(Math.max(-1, Math.min(1, sinPhi)))
  const lambda =
    originLongitudeDeg * DEG +
    Math.atan2(
      Math.sin(bearing) * Math.sin(s) * Math.cos(phi0),
      Math.cos(s) - Math.sin(phi0) * sinPhi,
    )

  return { latitudeDeg: phi / DEG, longitudeDeg: wrapLongitude(lambda / DEG) }
}

/**
 * Repliement sur [-180, 180].
 *
 * Une visee vers l'ouest depuis le Pacifique franchit l'antimeridien, et une
 * longitude de 190 degres n'adresse aucune tuile.
 */
function wrapLongitude(longitudeDeg: number): number {
  let out = longitudeDeg
  while (out > 180) out -= 360
  while (out < -180) out += 360
  return out
}

/**
 * Probleme direct de Vincenty — la solution **exacte** sur l'ellipsoide.
 *
 * Partir du site et avancer `distanceM` le long du geodesique d'azimut initial
 * `bearingDeg`. Les equations imbriquees convergent en trois a cinq tours pour
 * des distances continentales ; la borne a cent tours ne protege que des points
 * presque antipodaux, ou l'algorithme est de toute facon mal conditionne — cas
 * qui ne se presente jamais a quatre cent cinquante kilometres.
 *
 * Reference : Vincenty, T. (1975), *Direct and inverse solutions of geodesics on
 * the ellipsoid with application of nested equations*, Survey Review 23(176).
 */
export function vincentyDirect(
  latitudeDeg: number,
  longitudeDeg: number,
  distanceM: number,
  bearingDeg: number,
): Geodetic {
  const alpha1 = bearingDeg * DEG
  const sinAlpha1 = Math.sin(alpha1)
  const cosAlpha1 = Math.cos(alpha1)

  const tanU1 = (1 - WGS84_F) * Math.tan(latitudeDeg * DEG)
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1)
  const sinU1 = tanU1 * cosU1

  const sigma1 = Math.atan2(tanU1, cosAlpha1)
  const sinAlpha = cosU1 * sinAlpha1
  const cosSqAlpha = 1 - sinAlpha * sinAlpha
  const uSq = (cosSqAlpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B)
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)))
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))

  const sigmaZero = distanceM / (WGS84_B * A)
  let sigma = sigmaZero
  let sinSigma = Math.sin(sigma)
  let cosSigma = Math.cos(sigma)
  let cos2SigmaM = Math.cos(2 * sigma1 + sigma)

  for (let i = 0; i < 100; i++) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma)
    sinSigma = Math.sin(sigma)
    cosSigma = Math.cos(sigma)
    const deltaSigma =
      B *
      sinSigma *
      (cos2SigmaM +
        (B / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (B / 6) *
              cos2SigmaM *
              (-3 + 4 * sinSigma * sinSigma) *
              (-3 + 4 * cos2SigmaM * cos2SigmaM)))
    const next = sigmaZero + deltaSigma
    const converged = Math.abs(next - sigma) < 1e-12
    sigma = next
    if (converged) break
  }

  cos2SigmaM = Math.cos(2 * sigma1 + sigma)
  sinSigma = Math.sin(sigma)
  cosSigma = Math.cos(sigma)

  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1
  const phi = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - WGS84_F) * Math.hypot(sinAlpha, tmp),
  )
  const lambda = Math.atan2(sinSigma * sinAlpha1, cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1)
  const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha))
  const L =
    lambda -
    (1 - C) *
      WGS84_F *
      sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))

  return { latitudeDeg: phi / DEG, longitudeDeg: wrapLongitude(longitudeDeg + L / DEG) }
}

/** Probleme inverse de Vincenty : distance et azimut initial entre deux points. */
export function vincentyInverse(
  lat1Deg: number,
  lon1Deg: number,
  lat2Deg: number,
  lon2Deg: number,
): { distanceM: number; bearingDeg: number } {
  const L = wrapLongitude(lon2Deg - lon1Deg) * DEG
  const U1 = Math.atan((1 - WGS84_F) * Math.tan(lat1Deg * DEG))
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(lat2Deg * DEG))
  const sinU1 = Math.sin(U1)
  const cosU1 = Math.cos(U1)
  const sinU2 = Math.sin(U2)
  const cosU2 = Math.cos(U2)

  let lambda = L
  let sinSigma = 0
  let cosSigma = 1
  let sigma = 0
  let cosSqAlpha = 1
  let cos2SigmaM = 0
  let sinAlpha = 0

  for (let i = 0; i < 100; i++) {
    const sinLambda = Math.sin(lambda)
    const cosLambda = Math.cos(lambda)
    sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda)
    if (sinSigma === 0) return { distanceM: 0, bearingDeg: 0 }
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda
    sigma = Math.atan2(sinSigma, cosSigma)
    sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma
    cosSqAlpha = 1 - sinAlpha * sinAlpha
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0
    const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha))
    const next =
      L +
      (1 - C) *
        WGS84_F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))
    const converged = Math.abs(next - lambda) < 1e-13
    lambda = next
    if (converged) break
  }

  const uSq = (cosSqAlpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B)
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)))
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)))

  const sinLambda = Math.sin(lambda)
  const cosLambda = Math.cos(lambda)
  return {
    distanceM: WGS84_B * A * (sigma - deltaSigma),
    bearingDeg: Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) / DEG,
  }
}

/**
 * Probleme direct : ou arrive-t-on en partant du site vers l'est et le nord ?
 *
 * C'est la fonction que le moteur utilise. Elle passe par l'ellipsoide — voir
 * l'en-tete pour la mesure qui a impose ce choix.
 */
export function enuToGeodetic(
  originLatitudeDeg: number,
  originLongitudeDeg: number,
  eastM: number,
  northM: number,
): Geodetic {
  const distanceM = Math.hypot(eastM, northM)
  if (distanceM === 0) return { latitudeDeg: originLatitudeDeg, longitudeDeg: originLongitudeDeg }
  // Azimut compte depuis le nord, vers l'est — la convention de la navigation,
  // et celle de la scene ou +X est l'est et -Z le nord.
  const bearingDeg = Math.atan2(eastM, northM) / DEG
  return vincentyDirect(originLatitudeDeg, originLongitudeDeg, distanceM, bearingDeg)
}

/** Probleme inverse : quel deplacement local separe deux points ? */
export function geodeticToEnu(
  originLatitudeDeg: number,
  originLongitudeDeg: number,
  latitudeDeg: number,
  longitudeDeg: number,
): LocalOffset {
  const { distanceM, bearingDeg } = vincentyInverse(
    originLatitudeDeg,
    originLongitudeDeg,
    latitudeDeg,
    longitudeDeg,
  )
  return {
    eastM: distanceM * Math.sin(bearingDeg * DEG),
    northM: distanceM * Math.cos(bearingDeg * DEG),
  }
}

/**
 * Coordonnee de tuile, fractionnaire.
 *
 * L'entier est l'index de la tuile, la fraction la position du pixel dedans.
 * Rendre le fractionnaire evite d'avoir a refaire le calcul pour retrouver le
 * pixel — et evite l'erreur classique qui consiste a le recalculer autrement.
 */
export function lonLatToTile(longitudeDeg: number, latitudeDeg: number, zoom: number) {
  const n = 2 ** zoom
  // Mercator diverge aux poles ; on borne a la latitude conventionnelle des
  // tuiles, au-dela de laquelle aucune donnee n'existe de toute facon.
  const lat = Math.max(-85.051_128_78, Math.min(85.051_128_78, latitudeDeg)) * DEG
  const x = ((longitudeDeg + 180) / 360) * n
  const y = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n
  return { x, y }
}

/** Reciproque de `lonLatToTile`. */
export function tileToLonLat(x: number, y: number, zoom: number): Geodetic {
  const n = 2 ** zoom
  const longitudeDeg = (x / n) * 360 - 180
  const latitudeDeg = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / DEG
  return { latitudeDeg, longitudeDeg }
}

/**
 * Taille au sol d'un pixel de tuile, m.
 *
 * Elle depend de la latitude : Mercator etire les hautes latitudes, si bien
 * qu'une tuile de zoom donne couvre moins de terrain a Oslo qu'a Quito. C'est
 * cette valeur, et non la nominale de l'equateur, qui decide du zoom a demander
 * pour une resolution voulue.
 */
export function tileGroundResolutionM(latitudeDeg: number, zoom: number): number {
  return (
    (2 * Math.PI * WEB_MERCATOR_RADIUS_M * Math.cos(latitudeDeg * DEG)) / (TILE_SIZE * 2 ** zoom)
  )
}

/**
 * Le zoom le plus economique dont la resolution au sol tient sous une cible.
 *
 * ⚠️ **La tolerance n'est pas un confort, elle evite une falaise.** Les zooms
 * vont de deux en deux : exiger la cible au sens strict fait basculer d'un
 * niveau entier pour quelques pour cent, et **quadruple le telechargement**.
 *
 * Mesure du defaut : a Chamonix, 45,92° de latitude, le niveau fin tenait en
 * 217 tuiles ; a Nice, 43,70°, la meme demande en reclamait **703** — parce que
 * la resolution du zoom 12 y passe de 25,1 a 27,7 metres, pour une cellule qui
 * en demande 27,4. Un pour cent d'ecart, trois fois plus d'octets.
 *
 * Un quart de tolerance borne la perte a une fraction de la finesse d'une
 * cellule, la ou celle-ci est de toute facon deja une fois et demie plus
 * grossiere que ce que l'ecran resout a la portee du niveau.
 */
export function zoomForResolution(
  latitudeDeg: number,
  targetM: number,
  maxZoom = 15,
  tolerance = 1.25,
): number {
  for (let z = 0; z <= maxZoom; z++) {
    if (tileGroundResolutionM(latitudeDeg, z) <= targetM * tolerance) return z
  }
  return maxZoom
}
