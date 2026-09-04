/**
 * Les lumieres des villes — ou elles sont, combien elles valent, de quelle
 * couleur.
 *
 * ## Ce que ce module ajoute au moteur
 *
 * Le sol ne faisait que **renvoyer** de la lumiere. Il en **emet** desormais la
 * nuit, aux endroits ou les hommes en mettent. Le terme s'ajoute a la radiance
 * sortante, donc il traverse l'atmosphere par le meme chemin que le reste : une
 * ville a trente kilometres sort attenuee et rougie sans qu'on ecrive une ligne
 * pour cela, et une crete qui la masque la masque.
 *
 * ## Trois questions, trois reponses independantes
 *
 * **Ou ?** Le fond de carte OSM sombre de terrestris. ⚠️ Il n'est pas noir : son
 * fond vaut **exactement 48** sur 255, mesure identique au Causse Mejean desert,
 * en foret de la Sainte-Baume, a Avignon et a Marseille. On le nivelle donc a
 * zero, et ce qui depasse est la trame batie. La part au-dessus du fond suit
 * l'urbanisation : 4,8 % sur le Causse, 13 % en foret, 26 % a Avignon.
 *
 * **Combien ?** La norme EN 13201-2 fixe la luminance moyenne d'une chaussee
 * eclairee : 2,0 cd/m² en classe M1, 1,5 en M2, **1,0 en M3**, 0,75 en M4, 0,5
 * en M5. La M3 est la classe urbaine courante, et c'est elle qu'on prend pour un
 * pixel pleinement eclaire.
 *
 * **De quelle couleur ?** Un spectre de Planck a 2700 K, passe par le meme
 * operateur spectral que le Soleil et le ciel. Ce n'est pas une couleur choisie
 * dans un nuancier : c'est un spectre, converti en radiance par la meme chaine
 * que tout le reste du moteur.
 *
 * ## ⚠️ Ce qui reste approche
 *
 * **La temperature de couleur est un choix dans un intervalle reglementaire.**
 * L'arrete du 27 decembre 2018 plafonne l'eclairage exterieur francais a
 * 3000 K, 2700 K en peripherie de parc national, 2400 K dans les coeurs de
 * parc. Le sodium haute pression encore en service tire lui vers 2000 K. On
 * retient 2700 K, entre le neuf reglemente et l'ancien.
 *
 * **Un spectre de Planck n'est pas un spectre de lampe.** Le sodium emet des
 * raies, un blanc LED un pic bleu et un phosphore : la courbe de Planck en
 * reproduit approximativement la **couleur**, pas la structure. L'extinction
 * atmospherique dependant de la longueur d'onde, l'ecart n'est pas nul.
 *
 * **La carte exagere la surface eclairee.** Une route y est dessinee a la
 * largeur du trait cartographique, pas a la sienne : a cent metres par pixel,
 * une departementale occupe un pixel entier la ou elle fait sept metres. La
 * repartition est donc juste, l'aire eclairee surestimee.
 *
 * Voir le registre.
 */
import type { SpectralGrid } from '@/atmosphere/spectral/SpectralGrid'
import { planckRadiance } from '@/atmosphere/spectral/blackbody'
import { luminance, spectralToLinearSrgb, type LinearRgb } from '@/atmosphere/spectral/SpectralSensor'

/** Service WMS d'OpenStreetMap, sans clef. */
const WMS = 'https://ows.terrestris.de/osm/service'

/** Fond de carte sombre : terres foncees, voirie et bati plus clairs. */
const LAYER = 'Dark'

/**
 * Niveau de gris du fond, sur 255.
 *
 * ⚠️ **La carte n'est pas noire.** Mesure du mode de l'histogramme sur quatre
 * sites — Causse Mejean, Sainte-Baume, Avignon, Marseille : **48 partout**, du
 * desert au centre-ville. C'est donc une constante du style, pas une estimation,
 * et la niveler a zero est exact.
 */
export const CITY_LIGHT_BACKGROUND = 48

/**
 * Luminance d'une chaussee pleinement eclairee, cd/m².
 *
 * EN 13201-2, classe **M3** — la classe urbaine courante. Les autres classes de
 * la norme donnent l'echelle : M1 2,0 ; M2 1,5 ; M3 1,0 ; M4 0,75 ; M5 0,5.
 */
export const ROAD_LUMINANCE_CD_M2 = 1.0

/**
 * Temperature de couleur des lampes, kelvins.
 *
 * ⚠️ **Choix dans un intervalle reglementaire**, pas deduction. L'arrete du
 * 27 decembre 2018 plafonne l'eclairage exterieur a 3000 K en France, 2700 K en
 * peripherie de parc national et 2400 K dans les coeurs. Le sodium haute
 * pression encore installe tire vers 2000 K. 2700 K se tient entre les deux.
 */
export const LAMP_TEMPERATURE_K = 2700

/**
 * Radiance emise par un pixel pleinement eclaire, en unites du moteur.
 *
 * ## Pourquoi passer par un spectre
 *
 * Le moteur ne travaille pas en RVB mais en **radiance spectrale**, et sa chaine
 * d'affichage convertit en cd/m² par `L_v = 683 · ∫ L(λ)·ȳ(λ) dλ`. Poser une
 * couleur RVB pour les lampes reviendrait a court-circuiter cette chaine, et
 * l'eclairage urbain ne serait plus commensurable avec le Soleil ni avec le
 * ciel.
 *
 * On construit donc un spectre de Planck a la temperature des lampes, on le
 * **remet a l'echelle pour qu'il porte exactement la luminance de la norme**, et
 * on le convertit par le meme operateur que le reste. La couleur et l'intensite
 * en sortent ensemble, sans constante d'ajustement.
 */
export function cityLightEmission(grid: SpectralGrid): LinearRgb {
  const spectrum = new Float64Array(grid.count)
  for (let i = 0; i < grid.count; i++) {
    spectrum[i] = planckRadiance(grid.lambdaNm[i], LAMP_TEMPERATURE_K)
  }
  // Mise a l'echelle photometrique : le spectre porte alors exactement la
  // luminance que la norme prescrit pour une chaussee eclairee.
  const brut = luminance(grid, spectrum)
  const facteur = brut > 0 ? ROAD_LUMINANCE_CD_M2 / brut : 0
  for (let i = 0; i < grid.count; i++) spectrum[i] *= facteur
  return spectralToLinearSrgb(grid, spectrum)
}

/** Cote de la mosaique, en pixels. */
export const CITY_MOSAIC_SIZE = 2048

/**
 * Demi-etendues couvertes, metres au sol — proche puis lointaine.
 *
 * ## ⚠️ Pourquoi deux cartes, et pas une
 *
 * La premiere version n'en avait qu'une, a cent kilometres, soit quatre-vingt-
 * dix-huit metres par pixel. Le resultat etait juste au loin — villages et
 * routes a leur place — et **faux au premier plan** : le sol proche visible tient
 * dans une poignee de texels autour du centre de la carte, et le centre, c'est
 * l'observateur. Une route qui passe pres de lui allumait alors tout le
 * paysage proche d'un seul tenant.
 *
 * Une echelle unique ne peut pas servir cent metres et cent kilometres. La
 * proche donne 13,7 metres par pixel — une route y occupe un texel, pas une
 * region ; la lointaine porte les villes que la premiere ne voit plus.
 */
export const CITY_HALF_SPANS_M = [14_000, 100_000] as const

/** Demi-etendue de la carte lointaine, metres — la portee du drape. */
export const CITY_HALF_SPAN_M = CITY_HALF_SPANS_M[1]

const R = 6_378_137

/** Coordonnees en metres de la projection de Mercator spherique. */
export function mercator(latitudeDeg: number, longitudeDeg: number): { x: number; y: number } {
  const phi = (latitudeDeg * Math.PI) / 180
  return {
    x: (R * longitudeDeg * Math.PI) / 180,
    y: R * Math.log(Math.tan(Math.PI / 4 + phi / 2)),
  }
}

/**
 * Adresse de la carte, pour une emprise au sol donnee.
 *
 * ⚠️ Le metre de Mercator n'est pas le metre au sol : il s'etire en
 * `1/cos(latitude)`. L'emprise demandee au service doit donc etre dilatee, sans
 * quoi la carte couvrirait 72 km au lieu de 100 a la latitude de la France.
 */
export function cityLightsUrl(
  latitudeDeg: number,
  longitudeDeg: number,
  halfSpanM: number = CITY_HALF_SPAN_M,
): string {
  const c = mercator(latitudeDeg, longitudeDeg)
  const half = halfSpanM / Math.cos((latitudeDeg * Math.PI) / 180)
  const bbox = [c.x - half, c.y - half, c.x + half, c.y + half].join(',')
  return (
    `${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${LAYER}&STYLES=` +
    `&CRS=EPSG:3857&BBOX=${bbox}&WIDTH=${CITY_MOSAIC_SIZE}&HEIGHT=${CITY_MOSAIC_SIZE}` +
    `&FORMAT=image/png&TRANSPARENT=FALSE`
  )
}

const mosaics: Array<OffscreenCanvas | null> = [null, null]
let loading: Promise<boolean> | null = null
let loadedKey = ''

/** Vrai quand les deux cartes sont disponibles. */
export const cityLightsReady = (): boolean => mosaics.every((m) => m !== null)

/** Le canevas d'une echelle, ou `null`. */
export const cityLightsCanvas = (index: number): OffscreenCanvas | null => mosaics[index] ?? null

/** Recupere une carte pour une emprise donnee. */
async function fetchMap(
  latitudeDeg: number,
  longitudeDeg: number,
  halfSpanM: number,
): Promise<OffscreenCanvas | null> {
  try {
    const response = await fetch(cityLightsUrl(latitudeDeg, longitudeDeg, halfSpanM))
    if (!response.ok) return null
    const bitmap = await createImageBitmap(await response.blob())
    const canvas = new OffscreenCanvas(CITY_MOSAIC_SIZE, CITY_MOSAIC_SIZE)
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0, CITY_MOSAIC_SIZE, CITY_MOSAIC_SIZE)
    bitmap.close()
    return canvas
  } catch {
    return null
  }
}

/**
 * Charge les cartes des lumieres autour d'un site.
 *
 * Une requete par echelle : le service rend l'emprise demandee d'un bloc,
 * jusqu'a huit mille pixels de cote. Rien a mosaiquer, contrairement aux tuiles.
 */
export async function loadCityLights(latitudeDeg: number, longitudeDeg: number): Promise<boolean> {
  const key = `${latitudeDeg.toFixed(4)},${longitudeDeg.toFixed(4)}`
  if (loadedKey === key && loading) return loading
  loadedKey = key
  mosaics[0] = null
  mosaics[1] = null
  loading = (async () => {
    const got = await Promise.all(
      CITY_HALF_SPANS_M.map((half) => fetchMap(latitudeDeg, longitudeDeg, half)),
    )
    got.forEach((canvas, i) => {
      mosaics[i] = canvas
    })
    return got.every((c) => c !== null)
  })()
  return loading
}

/**
 * Les lumieres, cote nuanceur.
 *
 * ⚠️ Ne fait rien tant que `uCityStrength` vaut zero.
 */
export const CITY_LIGHTS_GLSL = /* glsl */ `
  uniform sampler2D uCityNear;
  uniform sampler2D uCityFar;
  uniform vec2 uCityHalfSpans;
  uniform vec3 uCityEmission;
  uniform float uCityStrength;

  /**
   * Part batie d'un pixel, dans une carte donnee.
   *
   * ⚠️ **Le fond de la carte n'est pas noir.** Il vaut 48 sur 255, du desert au
   * centre-ville : on le nivelle, sans quoi la campagne entiere brillerait
   * presque autant que les villes.
   */
  float cityBuilt(sampler2D carte, float halfSpan, float eastM, float northM) {
    vec2 uv = vec2(eastM, -northM) / (2.0 * halfSpan) + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
    vec3 c = texture2D(carte, uv).rgb;
    // La carte arrive en sRGB ; sa clarte perceptuelle est ce que le style
    // module, donc on nivelle **avant** toute linearisation.
    float clarte = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float fond = ${(48 / 255).toFixed(6)};
    return max(0.0, clarte - fond) / (1.0 - fond);
  }

  /**
   * Radiance emise par le sol, en unites du moteur.
   *
   * ⚠️ **Deux echelles.** Une seule carte ne peut pas servir cent metres et cent
   * kilometres : a la resolution qu'exige la seconde, le sol proche tient dans
   * quelques texels autour de l'observateur, et une route qui passe pres de lui
   * allume tout le paysage. La carte proche prend donc la main dans son domaine.
   */
  vec3 cityEmission(float eastM, float northM) {
    if (uCityStrength <= 0.0) return vec3(0.0);

    float loin = cityBuilt(uCityFar, uCityHalfSpans.y, eastM, northM);
    float reachProche = max(abs(eastM), abs(northM)) / uCityHalfSpans.x;
    float bati = loin;
    if (reachProche < 1.0) {
      float proche = cityBuilt(uCityNear, uCityHalfSpans.x, eastM, northM);
      // Fondu sur la frange, les deux cartes ne rendant pas exactement la meme
      // chose a la limite de resolution.
      bati = mix(proche, loin, smoothstep(0.85, 1.0, reachProche));
    }

    // Fondu du bord exterieur, pour que la carte ne dessine pas un carre au sol.
    float reachLoin = max(abs(eastM), abs(northM)) / uCityHalfSpans.y;
    float fade = 1.0 - smoothstep(0.9, 1.0, reachLoin);
    return uCityEmission * (bati * uCityStrength * fade);
  }
`
