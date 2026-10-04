/**
 * Le relief du mode photo, tel que le terrain l'affiche.
 *
 * Plus de maillage : le relief arrive des workers deja rendu, pixel par pixel,
 * dans une grille angulaire — distance, altitude, part du Soleil, couverture,
 * normale, part du ciel. Un materiau plein ecran relit cette grille pour chaque
 * pixel de l'image et l'eclaire avec **le meme nuanceur** que le maillage
 * courant, `shadeTerrain`. Il ecrit aussi la profondeur du point, si bien que
 * les avions, les nuages et les astres s'ordonnent avec lui comme avec le relief
 * courant.
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  NearestFilter,
  PlaneGeometry,
  RedFormat,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
} from 'three'
import { NEAR_M, TERRAIN_DEPTH_SLOPE, TERRAIN_NEAR_DEPTH } from '../terrain/meshSampling'
import type { PhotoFrame } from './photoRaster'

export interface PhotoRender {
  /** La grille de cette passe — deja decalee de sa fraction de pixel. */
  frame: PhotoFrame
  /** Ce decalage, en pixels : le nuanceur vise le meme point du pixel. */
  jitter: [number, number]
  /**
   * Deux texels par pixel, demi-flottants : distance (km), altitude, part du
   * Soleil, couverture ; puis normale de scene (x, reste de la distance en
   * metres, z) et part du ciel.
   */
  g: DataTexture
  /** Carte d'ombre fine, pour le voile atmospherique — commune a toutes les passes. */
  shadow: DataTexture
  shadowHalfSpanM: number
  shadowSize: number
}

let current: PhotoRender | null = null
const listeners = new Set<() => void>()

export const photoRender = (): PhotoRender | null => current

export function subscribePhotoRender(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function setPhotoRender(next: PhotoRender | null): void {
  if (current && current !== next) {
    current.g.dispose()
    if (current.shadow !== next?.shadow) current.shadow.dispose()
  }
  current = next
  listeners.forEach((fn) => fn())
}

function gTexture(data: Float32Array | Uint16Array, width: number, height: number, half: boolean): DataTexture {
  const t = new DataTexture(data as Float32Array<ArrayBuffer>, width, height, RGBAFormat, half ? HalfFloatType : FloatType)
  t.minFilter = NearestFilter
  t.magFilter = NearestFilter
  t.wrapS = ClampToEdgeWrapping
  t.wrapT = ClampToEdgeWrapping
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

/** La carte d'ombre fine, en texture : une fois par photo. */
export function photoShadowTexture(shadow: { size: number; height: Float32Array }): DataTexture {
  const s = new DataTexture(shadow.height as Float32Array<ArrayBuffer>, shadow.size, shadow.size, RedFormat, FloatType)
  s.minFilter = LinearFilter
  s.magFilter = LinearFilter
  s.wrapS = ClampToEdgeWrapping
  s.wrapT = ClampToEdgeWrapping
  s.generateMipmaps = false
  s.needsUpdate = true
  return s
}

export function makePhotoRender(
  frame: PhotoFrame,
  jitter: [number, number],
  g: Uint16Array,
  shadow: DataTexture,
  shadowHalfSpanM: number,
): PhotoRender {
  return {
    frame,
    jitter,
    g: gTexture(g, frame.cols * 2, frame.rows, true),
    shadow,
    shadowHalfSpanM,
    shadowSize: shadow.image.width,
  }
}

/** Un triangle... deux, en fait : le plein ecran, en coordonnees de decoupe. */
export const FULLSCREEN = new PlaneGeometry(2, 2)

/**
 * Materiau du relief au pixel.
 *
 * Il partage les uniformes du materiau courant — eclairage, eau, lampes,
 * atmosphere — et n'ajoute que la grille et les matrices de la camera. Le
 * micro-relief invente est coupe : ici, les normales sont vraies jusqu'au pixel.
 */
export function photoTerrainMaterial(base: ShaderMaterial, shadeGlsl: string): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthTest: true,
    depthWrite: true,
    uniforms: {
      ...base.uniforms,
      uMicroRelief: { value: 0 },
      uG: { value: null as DataTexture | null },
      /** Azimut et hauteur du centre, radians ; `u` et `v` du bord de la grille. */
      uFrame: { value: new Vector4() },
      /** Colonnes, lignes, pas. */
      uGrid: { value: new Vector3(1, 1, 1) },
      uProjInv: { value: new Matrix4() },
      uCamWorld: { value: new Matrix4() },
      uViewProj: { value: new Matrix4() },
      uResolution: { value: new Vector2(1, 1) },
      /** Decalage de la passe, pixels. */
      uJitter: { value: new Vector2() },
    },
    vertexShader: /* glsl */ `
      varying vec2 vNdc;
      void main() {
        // Les coordonnees normalisees du pixel viennent du triangle plein ecran
        // lui-meme : elles restent justes quelle que soit la taille du tampon
        // dans lequel le compositeur rend.
        vNdc = position.xy;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${shadeGlsl}
      uniform sampler2D uG;
      uniform vec4 uFrame;
      uniform vec3 uGrid;
      uniform mat4 uProjInv;
      uniform mat4 uCamWorld;
      uniform mat4 uViewProj;
      uniform vec2 uResolution;
      uniform vec2 uJitter;
      varying vec2 vNdc;

      void main() {
        // Le rayon de ce pixel, decale du point d'echantillonnage de la passe —
        // le meme decalage que celui de la grille : chaque passe lit le centre
        // d'une case, en un autre point du pixel.
        vec2 ndc = vNdc + uJitter * vec2(dFdx(vNdc.x), dFdy(vNdc.y));
        vec4 v = uProjInv * vec4(ndc, 1.0, 1.0);
        vec3 dir = normalize(mat3(uCamWorld) * (v.xyz / v.w));
        // Sa case dans la grille, espacee comme l'ecran — voir photoRaster.
        float az = atan(dir.x, -dir.z);
        float da = az - uFrame.x;
        da -= 6.28318530718 * floor(da / 6.28318530718 + 0.5);
        if (abs(da) > 1.4835) discard;
        vec2 screenUv = vec2(tan(da), tan(asin(clamp(dir.y, -1.0, 1.0)) - uFrame.y) / cos(da));
        vec2 cell = (screenUv - uFrame.zw) / uGrid.z;
        if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= uGrid.x || cell.y >= uGrid.y) discard;
        ivec2 ij = ivec2(cell);
        vec4 g1 = texelFetch(uG, ivec2(ij.x * 2, ij.y), 0);
        if (g1.x <= 0.0) discard;
        vec4 g2 = texelFetch(uG, ivec2(ij.x * 2 + 1, ij.y), 0);
        // La distance : kilometres arrondis, plus le reste en metres — voir le
        // worker. La normale verticale se recalcule, toujours positive.
        float range = g1.x * 1000.0 + g2.y;
        vec3 normal = vec3(g2.x, sqrt(max(0.0, 1.0 - g2.x * g2.x - g2.z * g2.z)), g2.z);

        vec3 radiance = shadeTerrain(dir, range, g1.y, normalize(normal), g1.z, g2.w);
        float luma = dot(radiance, vec3(0.2126, 0.7152, 0.0722));
        vec3 color = mix(radiance, luma * uNightTint, uNight);

        // La profondeur du point, par la meme loi que le maillage courant.
        float depth = ${TERRAIN_DEPTH_SLOPE.toFixed(3)} * log(max(${NEAR_M.toFixed(3)}, range) / ${NEAR_M.toFixed(3)}) / log(10.0) + ${TERRAIN_NEAR_DEPTH.toFixed(3)};
        vec4 clip = uViewProj * vec4(dir * depth, 1.0);
        gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
        // La couverture fait l'anticrenelage des cretes contre le ciel.
        gl_FragColor = vec4(color, g1.w);
      }
    `,
  })
}
