/**
 * Ponts entre les reperes astronomiques et le repere de la scene Three.js.
 *
 * Repere de la scene : +X = est, +Y = zenith, −Z = nord.
 * L'observateur est a l'origine et regarde l'interieur d'une sphere celeste
 * de rayon unite.
 */
import { Matrix4 } from 'three'
import { DEG } from '@/astro/coords'
import { lstDegrees } from '@/astro/time'
import type { GeoLocation, Horizontal } from '@/astro/types'

/**
 * Rayon auquel sont placees les references angulaires : etoiles, grilles,
 * constellations. Elles sont a l'infini optique, donc au fond de la scene.
 */
export const SKY_RADIUS = 200

/** Rayon du dome de fond, derriere tout le reste. */
export const DOME_RADIUS = 320
/**
 * Rayon de la calotte de sol. Elle doit etre **plus proche** que les etoiles et
 * les grilles (SKY_RADIUS) pour les masquer sous l'horizon, tout en restant
 * plus lointaine que le corps le plus eloigne du systeme solaire (~73).
 */
export const GROUND_RADIUS = 150

/**
 * Profondeur de scene attribuee a une distance reelle.
 *
 * Le systeme solaire couvre quatre ordres de grandeur entre un satellite en
 * orbite basse et Neptune : les placer a l'echelle exploserait la precision du
 * tampon de profondeur. On comprime donc le rayon en logarithme — une fonction
 * strictement croissante, donc qui **preserve l'ordre des occultations**.
 *
 * La taille de chaque corps est ensuite mise a l'echelle par le meme rapport
 * (voir `sceneRadiusForBody`), ce qui conserve exactement son diametre
 * apparent. Geometrie angulaire juste, profondeur juste : une eclipse se joue
 * alors toute seule dans le tampon de profondeur.
 *
 * **L'ordonnee a l'origine n'est pas anodine.** Elle valait −11,19, ce qui
 * annulait la profondeur a 32,9 km et la rendait *negative* en deca. Un rayon
 * negatif passe a `horizontalToScene` renvoie le point de l'autre cote de
 * l'observateur, donc derriere la camera : invisible. Tant que la scene ne
 * contenait que des objets astronomiques — le satellite le plus bas est a
 * quelques centaines de kilometres — le defaut restait sans effet. Il est
 * apparu avec les avions, qui vivent entre 1 et 75 km : ceux d'a cote
 * disparaissaient purement et simplement, silhouette et trainee comprises,
 * seule leur icone en pixels restant visible puisqu'elle est posee a
 * `SKY_RADIUS`.
 *
 * L'ordonnee vaut donc maintenant la profondeur voulue a un kilometre, la
 * distance la plus courte que la scene ait a representer. Toute la courbe est
 * translatee d'autant : les rapports de taille sont inchanges — ils ne
 * dependent que de `rayon / distance` —, l'ordre des occultations aussi, et le
 * corps le plus lointain reste tres en deca de `GROUND_RADIUS`.
 */
const DEPTH_SLOPE = 7.375
/**
 * Profondeur attribuee a un objet a un kilometre. Confortablement au-dela du
 * plan rapproche de la camera (0,1), pour qu'un avion presque au zenith ne
 * vienne pas s'y faire tronquer.
 */
const DEPTH_AT_ONE_KM = 0.4

export function sceneDepth(distanceKm: number): number {
  return DEPTH_SLOPE * Math.log10(Math.max(1, distanceKm)) + DEPTH_AT_ONE_KM
}

/**
 * Rayon de rendu d'un corps de rayon physique `radiusKm` vu a `distanceKm`.
 * Le rapport rayon/distance — donc le diametre apparent — est preserve.
 */
export function sceneRadiusForBody(radiusKm: number, distanceKm: number): number {
  return (radiusKm * sceneDepth(distanceKm)) / Math.max(1, distanceKm)
}

/**
 * Matrice transformant un point du repere equatorial (x vers l'equinoxe,
 * z vers le pole nord celeste) vers le repere de la scene.
 *
 * Elle compose la rotation horaire (−LST autour de l'axe polaire) et le
 * basculement du pole a la latitude de l'observateur. L'appliquer au groupe des
 * etoiles evite de recalculer 5 000 conversions par image.
 */
export function equatorialToSceneMatrix(date: Date, location: GeoLocation, target = new Matrix4()): Matrix4 {
  const lst = lstDegrees(date, location.longitude) * DEG
  const lat = location.latitude * DEG
  const cl = Math.cos(lst)
  const sl = Math.sin(lst)
  const cp = Math.cos(lat)
  const sp = Math.sin(lat)

  // u = Rz(−LST) · p place l'axe x sur le meridien local, puis on projette sur
  // le triedre SEZ et on le renomme selon les axes de la scene :
  //   X (est)    =  u_y            = −cosδ·sin H
  //   Y (zenith) =  cosφ·u_x + sinφ·u_z
  //   Z (sud)    =  sinφ·u_x − cosφ·u_z
  return target.set(
    -sl, cl, 0, 0,
    cp * cl, cp * sl, sp, 0,
    sp * cl, sp * sl, -cp, 0,
    0, 0, 0, 1,
  )
}

/** Coordonnees horizontales vers position dans la scene. */
export function horizontalToScene(h: Horizontal, radius = SKY_RADIUS): [number, number, number] {
  const alt = h.altitude * DEG
  const az = h.azimuth * DEG
  const ca = Math.cos(alt)
  return [radius * ca * Math.sin(az), radius * Math.sin(alt), -radius * ca * Math.cos(az)]
}

/**
 * Direction du repere equatorial vers le repere de la scene.
 * La transformation etant une rotation pure, elle s'applique telle quelle aux
 * vecteurs unitaires — c'est ainsi qu'on transporte la direction d'eclairement
 * d'un corps sans repasser par des angles de position.
 */
export function equatorialDirectionToScene(
  v: readonly [number, number, number],
  date: Date,
  location: GeoLocation,
  scratch = new Matrix4(),
): [number, number, number] {
  const m = equatorialToSceneMatrix(date, location, scratch).elements
  // Matrix4.elements est en colonne-majeure : m[col * 4 + row].
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ]
}

/**
 * Position dans la scene vers coordonnees horizontales.
 * Inverse exact de `horizontalToScene` : c'est par elle qu'un point de l'ecran
 * devient une direction du ciel, donc que le pointage devient possible.
 */
export function sceneToHorizontal(v: readonly [number, number, number]): Horizontal {
  const r = Math.hypot(v[0], v[1], v[2]) || 1
  const altitude = Math.asin(Math.min(1, Math.max(-1, v[1] / r))) / DEG
  const azimuth = (((Math.atan2(v[0], -v[2]) / DEG) % 360) + 360) % 360
  return { azimuth, altitude }
}

/**
 * Direction de la scene vers le repere equatorial.
 *
 * `equatorialToSceneMatrix` est une rotation pure : son inverse est sa
 * transposee. Transporter la direction visee dans le repere equatorial coute
 * une seule matrice, la ou convertir les cinq mille etoiles du catalogue dans
 * le repere de la scene en couterait cinq mille.
 */
export function sceneDirectionToEquatorial(
  v: readonly [number, number, number],
  date: Date,
  location: GeoLocation,
  scratch = new Matrix4(),
): [number, number, number] {
  const m = equatorialToSceneMatrix(date, location, scratch).elements
  // Transposee : eq[i] = somme sur r de M[r][i] · v[r], et M[r][i] = m[i * 4 + r].
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
  ]
}

/** Direction de visee (azimut, hauteur) vers vecteur unitaire de la scene. */
export function viewDirection(azimuth: number, altitude: number): [number, number, number] {
  return horizontalToScene({ azimuth, altitude }, 1)
}

/**
 * Ecart angulaire entre deux directions horizontales, en degres.
 * Passe par le produit scalaire des vecteurs unitaires : stable jusqu'aux tres
 * petits ecarts, la ou une difference d'azimut deviendrait absurde pres du zenith.
 */
export function angularDistance(a: Horizontal, b: Horizontal): number {
  const va = horizontalToScene(a, 1)
  const vb = horizontalToScene(b, 1)
  const dot = va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]
  return Math.acos(Math.min(1, Math.max(-1, dot))) / DEG
}

/** Interpolation d'angle circulaire, en degres. */
export function lerpAngle(from: number, to: number, t: number): number {
  const delta = ((to - from + 540) % 360) - 180
  return from + delta * t
}

/**
 * Cercles du ciel — boucles fermees, a dessiner avec `lineLoop`.
 *
 * Aucun de ces generateurs ne repete le premier point a la fin : c'est la
 * primitive qui referme le tour. Decouper une polyligne en segments disjoints,
 * comme le faisait le code precedent, fait rasteriser deux fois le pixel de
 * chaque jonction ; sous un materiau translucide la double couche l'eclaircit,
 * et ces points plus clairs se mettent a scintiller des que le ciel tourne.
 */

/** Cercle de hauteur constante (almucantarat). */
export function altitudeCircle(altitudeDeg: number, segments = 128, radius = SKY_RADIUS): Float32Array {
  const out = new Float32Array(segments * 3)
  for (let i = 0; i < segments; i++) {
    const az = (360 * i) / segments
    const [x, y, z] = horizontalToScene({ azimuth: az, altitude: altitudeDeg }, radius)
    out[i * 3] = x
    out[i * 3 + 1] = y
    out[i * 3 + 2] = z
  }
  return out
}

/**
 * Vertical : grand cercle complet passant par le zenith et le nadir.
 *
 * Il couvre l'azimut demande **et** son oppose — les deux moities d'un meme
 * cercle. Six verticaux suffisent donc la ou il fallait douze demi-cercles, et
 * le tour se referme sans raccord.
 */
export function verticalCircle(azimuthDeg: number, segments = 256, radius = SKY_RADIUS): Float32Array {
  const az = azimuthDeg * DEG
  const sa = Math.sin(az)
  const ca = Math.cos(az)
  const out = new Float32Array(segments * 3)
  for (let i = 0; i < segments; i++) {
    const t = (2 * Math.PI * i) / segments
    const st = Math.sin(t)
    out[i * 3] = radius * st * sa
    out[i * 3 + 1] = radius * Math.cos(t)
    out[i * 3 + 2] = -radius * st * ca
  }
  return out
}

/**
 * Cercle de declinaison constante, exprime dans le repere equatorial :
 * il sera place dans un groupe portant `equatorialToSceneMatrix`.
 */
export function declinationCircle(decDeg: number, segments = 128, radius = SKY_RADIUS): Float32Array {
  const out = new Float32Array(segments * 3)
  const dec = decDeg * DEG
  const cd = Math.cos(dec)
  const sd = Math.sin(dec)
  for (let i = 0; i < segments; i++) {
    const ra = (2 * Math.PI * i) / segments
    out[i * 3] = radius * cd * Math.cos(ra)
    out[i * 3 + 1] = radius * cd * Math.sin(ra)
    out[i * 3 + 2] = radius * sd
  }
  return out
}

/**
 * Cercle horaire : grand cercle complet passant par les deux poles celestes.
 *
 * Comme le vertical, il couvre l'ascension droite demandee et son oppose.
 */
export function hourCircle(raDeg: number, segments = 256, radius = SKY_RADIUS): Float32Array {
  const ra = raDeg * DEG
  const cr = Math.cos(ra)
  const sr = Math.sin(ra)
  const out = new Float32Array(segments * 3)
  for (let i = 0; i < segments; i++) {
    const t = (2 * Math.PI * i) / segments
    const st = Math.sin(t)
    out[i * 3] = radius * st * cr
    out[i * 3 + 1] = radius * st * sr
    out[i * 3 + 2] = radius * Math.cos(t)
  }
  return out
}

/** Ecliptique dans le repere equatorial (obliquite moyenne de la date). */
export function eclipticCircle(date: Date, segments = 256, radius = SKY_RADIUS): Float32Array {
  const t = (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525
  const eps = (23.439291 - 0.0130042 * t) * DEG
  const out = new Float32Array(segments * 3)
  for (let i = 0; i < segments; i++) {
    const lon = (2 * Math.PI * i) / segments
    const x = Math.cos(lon)
    const y = Math.sin(lon) * Math.cos(eps)
    const z = Math.sin(lon) * Math.sin(eps)
    out[i * 3] = radius * x
    out[i * 3 + 1] = radius * y
    out[i * 3 + 2] = radius * z
  }
  return out
}

/** Couleur hexadecimale vers composantes normalisees [0, 1]. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.trim().replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const n = Number.parseInt(full, 16)
  if (!Number.isFinite(n)) return [1, 1, 1]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Couleur hexadecimale sRGB → RGB lineaire, fonction de transfert sRGB exacte. */
export function hexToLinearRgb(hex: string): [number, number, number] {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = hexToRgb(hex)
  return [lin(r), lin(g), lin(b)]
}

/** Lit une couleur de token CSS resolue sur `document.documentElement`. */
export function readToken(token: string, fallback = '#ffffff'): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  return value || fallback
}
