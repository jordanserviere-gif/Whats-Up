/**
 * L'imagerie du sol, drapee sur le terrain — **de-eclairee**.
 *
 * Les tuiles viennent de `imagery.ts` : BD ORTHO en France, PNOA en Espagne,
 * NAIP aux Etats-Unis, Sentinel-2 ailleurs, composees aux frontieres.
 *
 * ## ⚠️ Une orthophoto n'est pas un albedo
 *
 * C'est une image **deja eclairee**. Elle porte le Soleil du jour de la prise de
 * vue, l'ombrage des versants, et la balance des couleurs du traitement. La
 * brancher telle quelle sur
 *
 *     sortante = albedo × eclairement / π
 *
 * reviendrait a **compter la lumiere deux fois** : on descendrait le Soleil au
 * couchant, et les versants resteraient eclaires comme a dix heures du matin.
 *
 * ## Ce qu'on en garde
 *
 * La premiere version ne gardait que la **chrominance** — l'image ramenee a
 * luminance unite. Les champs et les bois peignaient la couleur du sol, mais
 * tout le dessin — routes, parcelles, lisieres, villages — vivait dans la
 * luminance et partait avec l'eclairage.
 *
 * On separe maintenant les deux par l'echelle. L'eclairage de la prise de vue
 * varie **lentement** : l'ombrage d'un versant s'etend sur des centaines de
 * metres. Le dessin du sol varie **vite**. D'ou
 *
 *     detail = luminance / luminance floutee (a quelques centaines de metres)
 *     albedo = albedoPhysique × teinte × detail
 *
 * Le detail vaut un en moyenne : l'image ne peut toujours pas apporter de
 * lumiere ni en retirer a grande echelle — le moteur garde la brillance, et ses
 * ombres. Ne restent cuites que les ombres petites devant le flou : arbres,
 * maisons, falaises courtes.
 *
 * ## Un atlas a quatre etages
 *
 * Une seule texture — le nuanceur du relief n'a plus d'unite libre —, quatre
 * mosaiques centrees sur l'observateur, chacune quatre fois plus large et
 * quatre fois plus grossiere que la precedente : 3,6 m par pixel sur 3,7 km,
 * puis 14 m sur 15 km, 57 m sur 59 km, 230 m sur 235 km (a 44° de latitude). Le
 * nuanceur prend la plus fine qui couvre le point, et fond l'une dans l'autre
 * sur leurs bords. La plus grossiere arrive la premiere ; les fines s'y posent
 * ensuite.
 */
import { IMAGERY_TILE_SIZE, imageryTile, latLonToPixel } from './imagery'

/** Cote d'une tuile, pixels. */
export const ORTHO_TILE_SIZE = IMAGERY_TILE_SIZE

/** Zoom de l'etage le plus fin ; chaque etage suivant en retire deux. */
export const ORTHO_ZOOM = 15
/** Nombre d'etages. */
export const ORTHO_LEVELS = 4

/** Cote d'une mosaique d'etage, pixels. */
export const ORTHO_MOSAIC_SIZE = 2048
/** Cote de l'atlas : deux etages par cote. */
export const ORTHO_ATLAS_SIZE = 2 * ORTHO_MOSAIC_SIZE

/** Zoom d'un etage. */
export const orthoLevelZoom = (level: number): number => ORTHO_ZOOM - 2 * level

/** Resolution au sol d'un pixel de tuile, metres. */
export const orthoResolutionM = (latitudeDeg: number, zoom = ORTHO_ZOOM): number =>
  (40_075_016.686 * Math.cos((latitudeDeg * Math.PI) / 180)) / (2 ** zoom * ORTHO_TILE_SIZE)

/**
 * Demi-etendue de l'etage `level`, metres.
 *
 * ⚠️ **Elle depend de la latitude**, et ne peut donc pas etre une constante : la
 * resolution du pseudo-Mercator varie en `cos(latitude)`.
 */
export const orthoHalfSpanM = (latitudeDeg: number, level = 0): number =>
  (orthoResolutionM(latitudeDeg, orthoLevelZoom(level)) * ORTHO_MOSAIC_SIZE) / 2

/** Coordonnee en pixels sur la grille mondiale du zoom. */
export function orthoPixel(longitudeDeg: number, latitudeDeg: number, zoom = ORTHO_ZOOM): { x: number; y: number } {
  return latLonToPixel(latitudeDeg, longitudeDeg, zoom)
}

/** L'atlas courant et son ancrage. */
interface Atlas {
  readonly canvas: OffscreenCanvas
  readonly latitudeDeg: number
  readonly longitudeDeg: number
  /** Etages deja poses. */
  levels: number
  /** Etage par etage, un s'il est pose. */
  mask: [number, number, number, number]
}

let atlas: Atlas | null = null
let loading: Promise<boolean> | null = null
let loadedKey = ''
let revision = 0
const listeners = new Set<() => void>()

/** Vrai quand une imagerie est disponible pour le site courant. */
export const orthoReady = (): boolean => (atlas?.levels ?? 0) > 0

/** Le canevas a envoyer au GPU, ou `null`. */
export const orthoCanvas = (): OffscreenCanvas | null => (orthoReady() ? atlas!.canvas : null)

/** Demi-etendue de l'etage le plus fin, metres. Zero si aucun. */
export const orthoSpanM = (): number => (orthoReady() ? orthoHalfSpanM(atlas!.latitudeDeg) : 0)

/** Etages poses, un par composante : un etage absent ne doit pas masquer le precedent. */
export const orthoLevelMask = (): [number, number, number, number] => atlas?.mask ?? [0, 0, 0, 0]

/** Cle a inclure dans les memoisations qui en dependent. */
export const orthoRevision = (): string => `ortho:${loadedKey}:${revision}`

/** Appele a chaque etage pose : la texture doit repartir au GPU. */
export function subscribeOrtho(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Charge l'imagerie autour d'un site.
 *
 * Rend `true` des que l'etage le plus grossier est pose ; les autres suivent et
 * se signalent par `subscribeOrtho`.
 */
export async function loadOrthophoto(latitudeDeg: number, longitudeDeg: number): Promise<boolean> {
  const key = `${latitudeDeg.toFixed(4)},${longitudeDeg.toFixed(4)}`
  if (loadedKey === key && loading) return loading
  loadedKey = key
  atlas = null
  const canvas = new OffscreenCanvas(ORTHO_ATLAS_SIZE, ORTHO_ATLAS_SIZE)
  const mine: Atlas = { canvas, latitudeDeg, longitudeDeg, levels: 0, mask: [0, 0, 0, 0] }
  let firstDone: (ok: boolean) => void = () => {}
  loading = new Promise<boolean>((resolve) => (firstDone = resolve))
  void (async () => {
    // Du plus grossier au plus fin : la vue se peint d'abord en grand.
    let first = true
    for (let level = ORTHO_LEVELS - 1; level >= 0; level--) {
      if (loadedKey !== key) return
      const ok = await buildLevel(canvas, level, latitudeDeg, longitudeDeg, () => loadedKey !== key)
      if (loadedKey !== key) return
      if (ok) {
        mine.levels++
        mine.mask[level] = 1
        atlas = mine
        revision++
        listeners.forEach((fn) => fn())
      }
      if (first) {
        first = false
        firstDone(ok)
      }
    }
  })()
  return loading
}

/** Coin de l'etage `level` dans l'atlas, pixels. */
const levelOrigin = (level: number) => ({ x: (level % 2) * ORTHO_MOSAIC_SIZE, y: Math.floor(level / 2) * ORTHO_MOSAIC_SIZE })

async function buildLevel(canvas: OffscreenCanvas, level: number, latitudeDeg: number, longitudeDeg: number, stale: () => boolean): Promise<boolean> {
  const zoom = orthoLevelZoom(level)
  // L'etage est **centre sur l'observateur**, pas aligne sur la grille.
  const centre = orthoPixel(longitudeDeg, latitudeDeg, zoom)
  const half = ORTHO_MOSAIC_SIZE / 2
  const originX = centre.x - half
  const originY = centre.y - half
  const firstCol = Math.floor(originX / ORTHO_TILE_SIZE)
  const firstRow = Math.floor(originY / ORTHO_TILE_SIZE)
  const lastCol = Math.floor((originX + ORTHO_MOSAIC_SIZE) / ORTHO_TILE_SIZE)
  const lastRow = Math.floor((originY + ORTHO_MOSAIC_SIZE) / ORTHO_TILE_SIZE)

  const context = canvas.getContext('2d')
  if (!context) return false
  const at = levelOrigin(level)
  // L'etage se dessine dans sa case de l'atlas, et seulement la.
  context.save()
  context.beginPath()
  context.rect(at.x, at.y, ORTHO_MOSAIC_SIZE, ORTHO_MOSAIC_SIZE)
  context.clip()
  const tile = new OffscreenCanvas(ORTHO_TILE_SIZE, ORTHO_TILE_SIZE)
  const tctx = tile.getContext('2d')!
  let drawn = 0
  const jobs: Array<{ col: number; row: number }> = []
  for (let row = firstRow; row <= lastRow; row++) for (let col = firstCol; col <= lastCol; col++) jobs.push({ col, row })
  let next = 0
  const run = async () => {
    while (next < jobs.length && !stale()) {
      const { col, row } = jobs[next++]
      const data = await imageryTile(zoom, col, row).catch(() => null)
      if (!data) continue
      tctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, ORTHO_TILE_SIZE, ORTHO_TILE_SIZE), 0, 0)
      context.drawImage(tile, at.x + col * ORTHO_TILE_SIZE - originX, at.y + row * ORTHO_TILE_SIZE - originY)
      drawn++
    }
  }
  await Promise.all(Array.from({ length: 6 }, run))
  context.restore()
  return drawn > 0
}

/**
 * Le drape, cote nuanceur.
 *
 * ⚠️ Ne fait rien tant que `uOrthoStrength` vaut zero — avant l'arrivee du
 * premier etage. En mode photo, `gGroundTint` porte la teinte deja calculee au
 * pixel, a une finesse que l'atlas n'a pas : elle passe avant lui.
 */
export const ORTHO_GLSL = /* glsl */ `
  uniform sampler2D uOrtho;
  uniform float uOrthoHalfSpan;
  uniform float uOrthoStrength;
  /** Etages poses : un etage encore absent laisse voir le precedent. */
  uniform vec4 uOrthoLevels;

  /** Teinte du sol calculee ailleurs — le mode photo — ; negative quand il n'y en a pas. */
  vec3 gGroundTint = vec3(-1.0);

  /** Luminance, la ponderation de la validation. */
  float orthoLuminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  /**
   * Un etage de l'atlas : teinte de luminance unite, multipliee par le detail —
   * la luminance rapportee a sa version floutee, seize pixels plus large.
   *
   * ⚠️ **L'eclairage de la prise de vue est jete.** Il varie lentement, le
   * dessin du sol vite : le flou garde le premier, la division le retire. Le
   * detail vaut un en moyenne, et l'image ne peut ni apporter ni retirer de
   * lumiere a grande echelle.
   */
  vec3 orthoLevel(vec2 en, float halfSpan, vec2 corner) {
    vec2 uv = vec2(en.x, -en.y) / (2.0 * halfSpan) + 0.5;
    vec2 atlasUv = corner + clamp(uv, 0.0, 1.0) * 0.5;
    vec3 image = texture2D(uOrtho, atlasUv).rgb;
    vec3 broad = texture2D(uOrtho, atlasUv, 4.0).rgb;
    float luminance = orthoLuminance(image);
    float broadLuminance = orthoLuminance(broad);
    if (luminance < 1e-4 || broadLuminance < 1e-4) return vec3(1.0);
    vec3 tint = image / luminance;
    float detail = clamp(luminance / broadLuminance, 0.3, 2.5);
    return tint * detail;
  }

  vec3 orthoTint(float eastM, float northM) {
    if (gGroundTint.x >= 0.0) return gGroundTint;
    if (uOrthoStrength <= 0.0) return vec3(1.0);
    vec2 en = vec2(eastM, northM);
    float reach = max(abs(eastM), abs(northM));
    // Les quatre etages sont lus sans condition : un echantillonnage dans une
    // branche perdrait ses derivees, et le choix du niveau de mip avec elles.
    vec3 t0 = orthoLevel(en, uOrthoHalfSpan, vec2(0.0, 0.0));
    vec3 t1 = orthoLevel(en, uOrthoHalfSpan * 4.0, vec2(0.5, 0.0));
    vec3 t2 = orthoLevel(en, uOrthoHalfSpan * 16.0, vec2(0.0, 0.5));
    vec3 t3 = orthoLevel(en, uOrthoHalfSpan * 64.0, vec2(0.5, 0.5));
    // Du plus large au plus fin : chaque etage se fond dans le precedent sur
    // ses bords, ou le flou deborderait sur la case voisine de l'atlas.
    float w0 = (1.0 - smoothstep(0.8, 0.93, reach / uOrthoHalfSpan)) * uOrthoLevels.x;
    float w1 = (1.0 - smoothstep(0.8, 0.93, reach / (uOrthoHalfSpan * 4.0))) * uOrthoLevels.y;
    float w2 = (1.0 - smoothstep(0.8, 0.93, reach / (uOrthoHalfSpan * 16.0))) * uOrthoLevels.z;
    float w3 = (1.0 - smoothstep(0.8, 0.93, reach / (uOrthoHalfSpan * 64.0))) * uOrthoLevels.w;
    vec3 tint = mix(vec3(1.0), t3, w3);
    tint = mix(tint, t2, w2);
    tint = mix(tint, t1, w1);
    tint = mix(tint, t0, w0);
    return mix(vec3(1.0), tint, uOrthoStrength);
  }
`
