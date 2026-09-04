/**
 * L'orthophotographie de l'IGN, drapee sur le terrain — **sa teinte seulement**.
 *
 * ## ⚠️ Une orthophoto n'est pas un albedo
 *
 * C'est une image **deja eclairee**. Elle porte le Soleil du jour de la prise de
 * vue, ses ombres portees, et la balance des couleurs du traitement. La brancher
 * telle quelle sur
 *
 *     sortante = albedo × eclairement / π
 *
 * reviendrait a **compter la lumiere deux fois**. Le symptome serait immediat :
 * on descend le Soleil au couchant, et les ombres de l'image restent celles de
 * midi. Tout le travail d'ombre porte du moteur se retrouverait contredit par
 * la texture.
 *
 * ## Ce qu'on en garde
 *
 * La **chrominance**, et rien d'autre. On ramene l'image a luminance unite et
 * l'on ne conserve que ses rapports de couleur :
 *
 *     teinte = ortho / luminance(ortho)
 *     albedo = albedoPhysique × teinte
 *
 * Les champs, les bois, la roche nue, l'eau et les villages peignent alors la
 * **couleur** du sol ; le moteur garde entierement sa **brillance**. Les ombres
 * cuites disparaissent en grande partie — elles sont surtout de la luminance — et
 * la teinte de l'illuminant de prise de vue se divise au passage.
 *
 * ⚠️ **Ce qu'on perd** : les vrais ecarts d'albedo, une foret a 0,08 contre un
 * calcaire a 0,35. Ils vivent dans la luminance, qu'on jette avec l'eclairage.
 * Les recuperer demanderait de separer la structure fine — la couverture du sol —
 * du degrade large — l'eclairage du jour. Au registre.
 *
 * ## La grille est celle qu'on lit deja
 *
 * `PM_6_19` est le pseudo-Mercator, la meme projection que les tuiles
 * d'altitude Terrarium. Contrairement au RGE ALTI, qui avait impose une grille
 * geographique, il n'y a donc aucune trigonometrie nouvelle.
 *
 * ## Une mosaique, pas un tableau
 *
 * Les tuiles ne sont jamais decodees vers le processeur : on les dessine dans un
 * seul canevas hors ecran, et c'est lui qui part au GPU. Une image n'a pas
 * besoin d'etre lue pixel par pixel — seulement d'etre echantillonnee.
 *
 * ⚠️ **France seulement.** Ailleurs le service repond 404 et le drape ne
 * s'applique pas ; l'albedo reste celui du modele.
 */
import { fetchBinary } from '@/data-sources/fetchJson'

/** Racine du service WMTS de la Geoplateforme. Aucune cle n'est requise. */
const WMTS = 'https://data.geopf.fr/wmts'

/** BD ORTHO, 20 cm. Le prefixe `HR.` fait partie de l'identifiant. */
const LAYER = 'HR.ORTHOIMAGERY.ORTHOPHOTOS'

/** Pseudo-Mercator, la grille des tuiles d'altitude. */
const MATRIX_SET = 'PM_6_19'

/** Cote d'une tuile, en pixels. */
export const ORTHO_TILE_SIZE = 256

/**
 * Niveau de zoom retenu.
 *
 * ⚠️ **La couverture compte plus que la finesse.** La premiere version prenait
 * le zoom quinze, 3,4 metres par pixel sur sept kilometres — la meme maille que
 * le champ proche d'altitude. Mesure faite depuis le mont Ventoux : le drape ne
 * changeait que 0,2 % de la chrominance, parce que **depuis un sommet a 1912
 * metres, presque rien de ce qu'on voit n'est a moins de trois kilometres et
 * demi**. Le domaine ne croisait pas l'image.
 *
 * Le zoom treize donne 13,7 metres par pixel sur vingt-huit kilometres, soit
 * exactement l'etendue du niveau fin de la pyramide d'altitudes. A cinq
 * kilometres, un pixel y sous-tend 0,16 degre : amplement suffisant pour une
 * **couleur**, qui n'a pas besoin de la resolution qu'exige une silhouette.
 */
export const ORTHO_ZOOM = 13

/** Cote de la mosaique, en pixels. */
export const ORTHO_MOSAIC_SIZE = 2048

/** Resolution au sol d'un pixel de tuile, metres. */
export const orthoResolutionM = (latitudeDeg: number, zoom = ORTHO_ZOOM): number =>
  (40_075_016.686 * Math.cos((latitudeDeg * Math.PI) / 180)) / (2 ** zoom * ORTHO_TILE_SIZE)

/**
 * Demi-etendue de la mosaique, metres.
 *
 * ⚠️ **Elle depend de la latitude**, et ne peut donc pas etre une constante : la
 * resolution du pseudo-Mercator varie en `cos(latitude)`. Vingt-huit kilometres
 * en France, vingt a Reykjavik.
 */
export const orthoHalfSpanM = (latitudeDeg: number): number =>
  (orthoResolutionM(latitudeDeg) * ORTHO_MOSAIC_SIZE) / 2

/** Coordonnee en pixels sur la grille mondiale du zoom. */
export function orthoPixel(
  longitudeDeg: number,
  latitudeDeg: number,
  zoom = ORTHO_ZOOM,
): { x: number; y: number } {
  const n = 2 ** zoom * ORTHO_TILE_SIZE
  const s = Math.sin((latitudeDeg * Math.PI) / 180)
  return {
    x: ((longitudeDeg + 180) / 360) * n,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
  }
}

/** Adresse d'une tuile. */
export const orthoUrl = (col: number, row: number, zoom = ORTHO_ZOOM): string =>
  `${WMTS}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${LAYER}&STYLE=normal` +
  `&TILEMATRIXSET=${MATRIX_SET}&TILEMATRIX=${zoom}&TILEROW=${row}&TILECOL=${col}` +
  `&FORMAT=image/jpeg`

/** Duree de conservation d'une tuile. Le paysage bouge, mais pas vite. */
const TILE_TTL_MS = 30 * 24 * 3600 * 1000

/** Recupere une tuile et la rend prete a dessiner. `null` hors couverture. */
async function fetchTile(col: number, row: number): Promise<ImageBitmap | null> {
  try {
    const sourced = await fetchBinary(
      orthoUrl(col, row),
      { key: `ortho:${ORTHO_ZOOM}/${col}/${row}`, ttlMs: TILE_TTL_MS, timeoutMs: 12_000, attempts: 2 },
      (raw) => raw,
    )
    if (!sourced) return null
    // ⚠️ Hors couverture le service rend un `ExceptionReport` de cent soixante-
    // sept octets. On le reconnait a sa taille avant de tenter un decodage qui
    // leverait — comme pour le RGE ALTI.
    if (sourced.value.byteLength < 1024) return null
    return await createImageBitmap(new Blob([sourced.value], { type: 'image/jpeg' }))
  } catch {
    return null
  }
}

/** La mosaique courante et son ancrage. */
interface Mosaic {
  readonly canvas: OffscreenCanvas
  readonly latitudeDeg: number
  readonly longitudeDeg: number
  ready: boolean
}

let mosaic: Mosaic | null = null
let loading: Promise<boolean> | null = null
let loadedKey = ''

/** Vrai quand une orthophoto est disponible pour le site courant. */
export const orthoReady = (): boolean => mosaic?.ready === true

/** Le canevas a envoyer au GPU, ou `null`. */
export const orthoCanvas = (): OffscreenCanvas | null => (mosaic?.ready ? mosaic.canvas : null)

/** Demi-etendue de la mosaique courante, metres. Zero si aucune. */
export const orthoSpanM = (): number => (mosaic?.ready ? orthoHalfSpanM(mosaic.latitudeDeg) : 0)

/** Cle a inclure dans les memoisations qui en dependent. */
export const orthoRevision = (): string => (mosaic?.ready ? `ortho:${loadedKey}` : 'ortho:0')

/**
 * Charge l'orthophoto autour d'un site.
 *
 * Rend `false` hors couverture : c'est le cas normal partout hors de France, et
 * l'appelant garde alors l'albedo du modele.
 */
export async function loadOrthophoto(latitudeDeg: number, longitudeDeg: number): Promise<boolean> {
  const key = `${latitudeDeg.toFixed(4)},${longitudeDeg.toFixed(4)}`
  if (loadedKey === key && loading) return loading
  loadedKey = key
  mosaic = null
  loading = build(latitudeDeg, longitudeDeg)
  return loading
}

async function build(latitudeDeg: number, longitudeDeg: number): Promise<boolean> {
  // La mosaique est **centree sur l'observateur**, pas alignee sur la grille :
  // on calcule son coin en pixels mondiaux, puis les tuiles qui le recouvrent.
  const centre = orthoPixel(longitudeDeg, latitudeDeg)
  const half = ORTHO_MOSAIC_SIZE / 2
  const originX = centre.x - half
  const originY = centre.y - half

  const firstCol = Math.floor(originX / ORTHO_TILE_SIZE)
  const firstRow = Math.floor(originY / ORTHO_TILE_SIZE)
  const lastCol = Math.floor((originX + ORTHO_MOSAIC_SIZE) / ORTHO_TILE_SIZE)
  const lastRow = Math.floor((originY + ORTHO_MOSAIC_SIZE) / ORTHO_TILE_SIZE)

  const canvas = new OffscreenCanvas(ORTHO_MOSAIC_SIZE, ORTHO_MOSAIC_SIZE)
  const context = canvas.getContext('2d')
  if (!context) return false

  let drawn = 0
  let first = true
  for (let row = firstRow; row <= lastRow; row++) {
    const batch: Array<Promise<ImageBitmap | null>> = []
    const cols: number[] = []
    for (let col = firstCol; col <= lastCol; col++) {
      batch.push(fetchTile(col, row))
      cols.push(col)
    }
    const got = await Promise.all(batch)
    got.forEach((bitmap, i) => {
      if (!bitmap) return
      context.drawImage(
        bitmap,
        cols[i] * ORTHO_TILE_SIZE - originX,
        row * ORTHO_TILE_SIZE - originY,
      )
      bitmap.close()
      drawn++
    })
    // Hors couverture, la premiere rangee suffit a le dire : inutile de demander
    // les soixante autres tuiles pour se l'entendre repeter.
    if (first && drawn === 0) return false
    first = false
  }
  if (drawn === 0) return false

  mosaic = { canvas, latitudeDeg, longitudeDeg, ready: true }
  return true
}

/**
 * Le drape, cote nuanceur.
 *
 * ⚠️ Ne fait rien tant que `uOrthoStrength` vaut zero — hors de France, ou avant
 * l'arrivee de la mosaique.
 */
export const ORTHO_GLSL = /* glsl */ `
  uniform sampler2D uOrtho;
  uniform float uOrthoHalfSpan;
  uniform float uOrthoStrength;

  /**
   * Teinte du sol lue dans l'orthophoto, a luminance unite.
   *
   * ⚠️ **Sa luminance est jetee volontairement.** Une orthophoto est deja
   * eclairee : sa clarte porte le Soleil du jour de la prise de vue et ses
   * ombres portees. La garder reviendrait a compter la lumiere deux fois, et
   * l'on verrait des ombres de midi sous un Soleil couchant.
   */
  vec3 orthoTint(float eastM, float northM) {
    if (uOrthoStrength <= 0.0) return vec3(1.0);
    // Le pseudo-Mercator est conforme : sur trois kilometres et demi, la
    // correspondance entre metres locaux et pixels de mosaique est lineaire a
    // trois dix-millioniemes pres.
    vec2 uv = vec2(eastM, -northM) / (2.0 * uOrthoHalfSpan) + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec3(1.0);

    vec3 image = texture2D(uOrtho, uv).rgb;
    float luminance = dot(image, vec3(0.2126, 0.7152, 0.0722));
    if (luminance < 1e-4) return vec3(1.0);
    vec3 tint = image / luminance;

    // Fondu sur la frange, pour que le bord de la mosaique ne dessine pas un
    // carre sur le sol.
    float reach = max(abs(eastM), abs(northM)) / uOrthoHalfSpan;
    float fade = 1.0 - smoothstep(0.85, 1.0, reach);
    return mix(vec3(1.0), tint, uOrthoStrength * fade);
  }
`
