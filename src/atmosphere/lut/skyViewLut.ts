/**
 * Table de ciel — la radiance du ciel, precalculee par direction.
 *
 * ## Ce qu'elle rend possible
 *
 * Le solveur de diffusion simple coute 0,067 ms par direction une fois la table
 * de colonne en place (voir `transmittanceLut.ts`). Beaucoup trop pour un
 * fragment shader, mais **assez peu pour balayer tout le ciel** : deux mille
 * directions tiennent dans une trentaine de millisecondes.
 *
 * Le rendu n'a donc plus a integrer quoi que ce soit. Il echantillonne une
 * texture, et toute la physique des phases 1 a 5 arrive a l'ecran sans qu'un
 * seul rayon ne soit marche par pixel.
 *
 * ## La symetrie qui divise le travail par deux
 *
 * L'atmosphere est a symetrie de revolution autour de la verticale, et les
 * rayons solaires sont paralleles. Le ciel est donc **exactement symetrique**
 * par rapport au plan vertical contenant le Soleil : la direction a +40°
 * d'azimut du Soleil et celle a −40° recoivent la meme radiance.
 *
 * Ne stocker que la moitie du tour — de 0 a 180° d'azimut relatif — n'est donc
 * pas une approximation mais une consequence du modele. Elle cessera d'etre
 * exacte le jour ou l'atmosphere cessera d'etre a symetrie de revolution
 * (phase 13), et il faudra alors stocker le tour complet.
 *
 * ## Parametrisation
 *
 *     u = azimut relatif / 180°
 *     v = √(hauteur / 90°)          soit  hauteur = 90° · v²
 *
 * Le carre concentre les lignes pres de l'horizon, ou la luminance varie d'un
 * facteur six sur les derniers degres. Un maillage uniforme en hauteur y
 * placerait une ligne tous les trois degres et manquerait completement l'arche
 * crepusculaire.
 *
 * ## Ce qu'elle ne couvre pas
 *
 * Les directions **sous l'horizon** : le rayon y rencontre le sol et la
 * radiance du ciel y est nulle. Le sol est de toute facon dessine par-dessus.
 */
import type { SpectralGrid } from '../spectral/SpectralGrid'
import { skyRadiance, type SingleScatteringOptions } from '../transport/singleScattering'

export interface SkyViewLut {
  readonly width: number
  readonly height: number
  /** sRGB lineaire non borne, quatre composantes par texel (la quatrieme est nulle). */
  readonly data: Float32Array
  /** Hauteur solaire pour laquelle la table a ete calculee, degres. */
  readonly sunAltitudeDeg: number
  /** Altitude de l'observateur, m. */
  readonly observerElevationM: number
}

/** Hauteur de visee correspondant a une coordonnee verticale de [0,1]. */
export const skyViewAltitudeDeg = (v: number): number => 90 * v * v

/** Coordonnee verticale correspondant a une hauteur de visee. */
export const skyViewV = (altitudeDeg: number): number => Math.sqrt(Math.max(0, altitudeDeg) / 90)

export interface SkyViewLutOptions extends SingleScatteringOptions {
  width?: number
  height?: number
}

/**
 * Construit la table pour une position solaire donnee.
 *
 * **Elle depend du Soleil**, contrairement a la table de colonne : il faut donc
 * la reconstruire quand celui-ci bouge sensiblement. Un quart de degre —
 * environ une minute de temps reel — suffit largement : c'est bien en dessous
 * de ce que l'oeil distingue sur un degrade de ciel.
 */
export function buildSkyViewLut(
  grid: SpectralGrid,
  sunAltitudeDeg: number,
  options: SkyViewLutOptions = {},
): SkyViewLut {
  const { width = 64, height = 32, ...transport } = options
  const data = new Float32Array(width * height * 4)
  fillSkyViewRows(data, grid, sunAltitudeDeg, width, height, 0, height, transport)
  return { width, height, data, sunAltitudeDeg, observerElevationM: transport.observerElevationM ?? 0 }
}

/**
 * Remplit une **tranche de lignes** de la table.
 *
 * C'est la forme dont le rendu a besoin. Construire les deux mille directions
 * d'un coup coute une quarantaine de millisecondes : imperceptible une fois par
 * minute en temps reel, mais un hoquet net en avance rapide, ou le Soleil
 * franchit le seuil de reconstruction plusieurs fois par seconde.
 *
 * Etaler le travail sur quelques images le supprime sans rien retirer a la
 * physique. Le prix est un retard de quelques images sur la position du
 * Soleil — invisible, et de toute facon sans objet : personne ne juge la
 * couleur d'un ciel qui defile en accelere.
 */
export function fillSkyViewRows(
  target: Float32Array,
  grid: SpectralGrid,
  sunAltitudeDeg: number,
  width: number,
  height: number,
  fromRow: number,
  toRow: number,
  options: SingleScatteringOptions = {},
): void {
  // Convention de Bruneton : le **centre** du premier et du dernier texel porte
  // exactement la borne du domaine. C'est ce que fait le recentrage cote GPU, et
  // construire la table autrement decalerait toute l'interpolation d'un demi
  // texel — invisible au milieu, faux a l'horizon et au zenith.
  for (let y = Math.max(0, fromRow); y < Math.min(height, toRow); y++) {
    const altitudeDeg = skyViewAltitudeDeg(height > 1 ? y / (height - 1) : 0)
    for (let x = 0; x < width; x++) {
      const azimuthDeg = 180 * (width > 1 ? x / (width - 1) : 0)
      const sky = skyRadiance(grid, altitudeDeg, azimuthDeg, sunAltitudeDeg, options)
      const i = (y * width + x) * 4
      target[i] = sky.linearSrgb[0]
      target[i + 1] = sky.linearSrgb[1]
      target[i + 2] = sky.linearSrgb[2]
      target[i + 3] = 0
    }
  }
}

/**
 * Lit la table par interpolation bilineaire, dans les memes conventions qu'un
 * echantillonneur GPU en `LinearFilter` et `ClampToEdgeWrapping`.
 *
 * `azimuthFromSunDeg` peut valoir n'importe quoi : il est replie sur [0, 180]
 * par la symetrie du plan vertical solaire.
 */
export function sampleSkyViewLut(
  lut: SkyViewLut,
  viewAltitudeDeg: number,
  azimuthFromSunDeg: number,
): [number, number, number] {
  if (viewAltitudeDeg < 0) return [0, 0, 0]

  // Repliement : |azimut| ramene dans [0, 180].
  const folded = Math.abs(((((azimuthFromSunDeg + 180) % 360) + 360) % 360) - 180)

  const u = folded / 180
  const v = skyViewV(Math.min(90, viewAltitudeDeg))

  // Meme convention que le GPU apres recentrage : la coordonnee normalisee
  // s'etale sur les centres des texels, de 0 a `taille − 1`.
  const fx = Math.max(0, Math.min(lut.width - 1, u * (lut.width - 1)))
  const fy = Math.max(0, Math.min(lut.height - 1, v * (lut.height - 1)))
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(lut.width - 1, x0 + 1)
  const y1 = Math.min(lut.height - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0

  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const c00 = lut.data[(y0 * lut.width + x0) * 4 + c]
    const c10 = lut.data[(y0 * lut.width + x1) * 4 + c]
    const c01 = lut.data[(y1 * lut.width + x0) * 4 + c]
    const c11 = lut.data[(y1 * lut.width + x1) * 4 + c]
    out[c] = (c00 * (1 - tx) + c10 * tx) * (1 - ty) + (c01 * (1 - tx) + c11 * tx) * ty
  }
  return out
}

/**
 * Fonction GLSL d'acces a la table.
 *
 * Volontairement identique a `sampleSkyViewLut` ci-dessus — la suite de
 * validation compare les deux chemins.
 *
 * Le repliement de l'azimut se fait par `abs()` sur l'angle signe : c'est la
 * symetrie du plan vertical solaire, pas une astuce d'echantillonnage.
 */
export const SKY_VIEW_LUT_GLSL = /* glsl */ `
  /**
   * Radiance du ciel dans une direction, en sRGB lineaire non borne.
   *
   * \`dir\` est unitaire dans le repere de la scene (+Y zenith), \`sunDir\`
   * aussi. \`lutSize\` porte les dimensions de la table.
   */
  vec3 sampleSkyView(sampler2D lut, vec2 lutSize, vec3 dir, vec3 sunDir) {
    if (dir.y < 0.0) return vec3(0.0);

    // Azimut relatif : angle entre les projections horizontales des deux
    // directions. \`abs\` replie sur [0, 180°] — la symetrie du plan solaire.
    vec2 flatDir = normalize(vec2(dir.x, dir.z) + vec2(1e-9));
    vec2 flatSun = normalize(vec2(sunDir.x, sunDir.z) + vec2(1e-9));
    float cosAzimuth = clamp(dot(flatDir, flatSun), -1.0, 1.0);
    float u = acos(cosAzimuth) / 3.14159265;

    float altitude = degrees(asin(clamp(dir.y, 0.0, 1.0)));
    float v = sqrt(clamp(altitude, 0.0, 90.0) / 90.0);

    // Recentrage sur les texels : sans lui, l'interpolation extrapole au
    // zenith et a l'horizon, ou la table est justement la plus tendue.
    vec2 uv = vec2(0.5 / lutSize.x + u * (1.0 - 1.0 / lutSize.x),
                   0.5 / lutSize.y + v * (1.0 - 1.0 / lutSize.y));
    return texture2D(lut, uv).rgb;
  }
`
