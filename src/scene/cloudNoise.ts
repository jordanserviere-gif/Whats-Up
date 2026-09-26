import {
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  WebGL3DRenderTarget,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { STRUCTURE_OCTAVES } from '@/atmosphere/cloud/cloudLayer'

/**
 * Octaves de bruit precalculees — une fois, sur la carte graphique.
 *
 * Marcher dans un nuage evalue son champ des centaines de fois par pixel ; a
 * vingt hachages par octave, le bruit coutait l'essentiel de l'image. On le
 * range donc dans des textures periodiques, et chaque echantillon devient une
 * lecture filtree. C'est la methode des moteurs qui rendent des ciels en temps
 * reel (Schneider, « Nubis », 2015 et suivants).
 *
 * - **Structure** (2D, 2048², RGBA) : les quatre octaves du champ de
 *   `cloudLayer.ts`, une par canal, pour que le filtrage au pixel puisse
 *   encore les retirer une a une. Periode : 32 mailles de l'octave de base.
 * - **Detail** (3D, 128³, RGBA) : quatre octaves de bruit de valeur 3D,
 *   frequences 1, 2, 4, 8 sur une periode de 8 unites. Le nuanceur les replie
 *   en bourgeons et les lit a deux echelles : huit octaves pour deux lectures.
 *
 * Meme hachage et meme interpolation que `cloudLayer.ts` : la texture de
 * structure *est* le champ valide, echantillonne.
 */

export const STRUCTURE_PERIOD = 32
const STRUCTURE_SIZE = 2048
export const DETAIL_PERIOD = 8
const DETAIL_SIZE = 128

const QUAD = new PlaneGeometry(2, 2)
const CAMERA = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

const PERIODIC_VALUE_NOISE_2D = /* glsl */ `
  float bakeHash(vec2 p) {
    return fract(sin(p.x * 127.1 + p.y * 311.7) * 43758.5453123);
  }
  /** Bruit de valeur de periode \`period\` mailles, interpolation quintique. */
  float periodicNoise(vec2 x, float period) {
    vec2 i = floor(x);
    vec2 f = x - i;
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 i0 = mod(i, period);
    vec2 i1 = mod(i + 1.0, period);
    float a = bakeHash(i0);
    float b = bakeHash(vec2(i1.x, i0.y));
    float c = bakeHash(vec2(i0.x, i1.y));
    float d = bakeHash(i1);
    return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
  }
`

function structureMaterial() {
  return new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      ${PERIODIC_VALUE_NOISE_2D}
      varying vec2 vUv;
      void main() {
        vec4 o;
        for (int k = 0; k < ${STRUCTURE_OCTAVES}; k++) {
          float cells = ${STRUCTURE_PERIOD}.0 * pow(2.0, float(k));
          vec2 offset = vec2(17.3 * float(k) + 0.37, -9.1 * float(k) + 0.71);
          // Un decalage constant ne rompt pas la periode : l'indice est pris modulo.
          float n = periodicNoise(vUv * cells + offset, cells);
          if (k == 0) o.r = n; else if (k == 1) o.g = n; else if (k == 2) o.b = n; else o.a = n;
        }
        gl_FragColor = o;
      }
    `,
  })
}

function detailMaterial() {
  return new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: { uLayer: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uLayer;
      varying vec2 vUv;
      float hash3(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
      }
      float periodicNoise3(vec3 x, float period) {
        vec3 i = floor(x);
        vec3 f = x - i;
        vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        vec3 a = mod(i, period);
        vec3 b = mod(i + 1.0, period);
        return mix(
          mix(mix(hash3(a), hash3(vec3(b.x, a.y, a.z)), u.x),
              mix(hash3(vec3(a.x, b.y, a.z)), hash3(vec3(b.x, b.y, a.z)), u.x), u.y),
          mix(mix(hash3(vec3(a.x, a.y, b.z)), hash3(vec3(b.x, a.y, b.z)), u.x),
              mix(hash3(vec3(a.x, b.y, b.z)), hash3(b), u.x), u.y),
          u.z);
      }
      void main() {
        vec3 uvw = vec3(vUv, (uLayer + 0.5) / ${DETAIL_SIZE}.0);
        vec4 o;
        for (int k = 0; k < 4; k++) {
          float cells = ${DETAIL_PERIOD}.0 * pow(2.0, float(k));
          float n = periodicNoise3(uvw * cells + float(k) * 7.0, cells);
          if (k == 0) o.r = n; else if (k == 1) o.g = n; else if (k == 2) o.b = n; else o.a = n;
        }
        gl_FragColor = o;
      }
    `,
  })
}

let baked: { structure: Texture; detail: Texture } | null = null

/** Les deux textures, precalculees au premier appel. */
export function cloudNoiseTextures(gl: WebGLRenderer): { structure: Texture; detail: Texture } {
  if (baked) return baked
  const previous = gl.getRenderTarget()

  const structure = new WebGLRenderTarget(STRUCTURE_SIZE, STRUCTURE_SIZE, {
    type: UnsignedByteType,
    format: RGBAFormat,
    depthBuffer: false,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
  })
  const scene = new Scene()
  const quad = new Mesh(QUAD, structureMaterial())
  quad.frustumCulled = false
  scene.add(quad)
  const structureMat = quad.material as ShaderMaterial
  gl.setRenderTarget(structure)
  gl.render(scene, CAMERA)
  structureMat.dispose()

  const detail = new WebGL3DRenderTarget(DETAIL_SIZE, DETAIL_SIZE, DETAIL_SIZE, {
    type: UnsignedByteType,
    format: RGBAFormat,
    depthBuffer: false,
  })
  detail.texture.magFilter = LinearFilter
  detail.texture.minFilter = LinearFilter
  detail.texture.wrapS = RepeatWrapping
  detail.texture.wrapT = RepeatWrapping
  detail.texture.wrapR = RepeatWrapping
  const material = detailMaterial()
  quad.material = material
  for (let layer = 0; layer < DETAIL_SIZE; layer++) {
    material.uniforms.uLayer.value = layer
    gl.setRenderTarget(detail, layer)
    gl.render(scene, CAMERA)
  }

  gl.setRenderTarget(previous)
  ;(quad.material as ShaderMaterial).dispose()
  baked = { structure: structure.texture, detail: detail.texture }
  return baked
}
