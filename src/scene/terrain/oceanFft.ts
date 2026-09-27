import {
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { FFT_SIZE, cascadeSpectrum, type Cascade, type SeaComponent } from '@/atmosphere/water/seaSurface'

/**
 * Vagues par transformee de Fourier, sur le GPU (Tessendorf 2001).
 *
 * Par cascade et par image :
 * 1. **Evolution** : h(k, t) = h0(k) e^{iωt} + conj(h0(−k)) e^{−iωt}, ω = √(g k).
 *    Les pentes s'en deduisent par i k. Deux champs reels par champ complexe :
 *    (h + i·∂h/∂x) et (∂h/∂y), soit trois grandeurs en une texture.
 * 2. **Transformee inverse** : Stockham radix 2, huit passes horizontales puis
 *    huit verticales — l'algorithme qui range lui-meme ses sorties.
 * 3. **Composition** : pentes et carres des pentes (x, y, x², y²) dans une
 *    texture multiresolution, hauteur dans une autre. Les carres sont la clef du
 *    filtrage LEADR (Dupuy et al. 2013) : la moyenne d'un niveau de mip rend la
 *    pente moyenne, et `E[s²] − E[s]²` la variance que ce niveau a lissee — qui
 *    passe dans la statistique de Cox & Munk plutot que d'etre perdue.
 */

const N = FFT_SIZE
const STAGES = Math.log2(N)

const VERTEX = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`

function evolveMaterial() {
  return new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: { uH0: { value: null as Texture | null }, uTime: { value: 0 }, uSize: { value: 1 } },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D uH0;
      uniform float uTime;
      uniform float uSize;
      void main() {
        ivec2 px = ivec2(floor(gl_FragCoord.xy));
        float n = float(px.x < ${N / 2} ? px.x : px.x - ${N});
        float m = float(px.y < ${N / 2} ? px.y : px.y - ${N});
        vec2 k = 6.2831853 * vec2(n, m) / uSize;
        float omega = sqrt(9.80665 * length(k));
        vec4 h0 = texelFetch(uH0, px, 0);
        float c = cos(omega * uTime);
        float s = sin(omega * uTime);
        vec2 h = vec2(h0.x * c - h0.y * s, h0.x * s + h0.y * c)
               + vec2(h0.z * c + h0.w * s, h0.w * c - h0.z * s);
        vec2 sx = vec2(-k.x * h.y, k.x * h.x);
        vec2 sy = vec2(-k.y * h.y, k.y * h.x);
        gl_FragColor = vec4(h.x - sx.y, h.y + sx.x, sy);
      }
    `,
  })
}

function butterflyMaterial() {
  return new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: { uInput: { value: null as Texture | null }, uNs: { value: 1 }, uHorizontal: { value: 1 } },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D uInput;
      uniform float uNs;
      uniform float uHorizontal;
      vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
      void main() {
        ivec2 px = ivec2(floor(gl_FragCoord.xy));
        bool horizontal = uHorizontal > 0.5;
        float o = float(horizontal ? px.x : px.y);
        float span = 2.0 * uNs;
        float within = mod(o, span);
        float k = mod(within, uNs);
        float j = floor(o / span) * uNs + k;
        ivec2 ia = horizontal ? ivec2(int(j), px.y) : ivec2(px.x, int(j));
        ivec2 ib = horizontal ? ivec2(int(j) + ${N / 2}, px.y) : ivec2(px.x, int(j) + ${N / 2});
        vec4 a = texelFetch(uInput, ia, 0);
        vec4 b = texelFetch(uInput, ib, 0);
        float angle = 3.14159265 * k / uNs;
        vec2 w = vec2(cos(angle), sin(angle));
        vec4 wb = vec4(cmul(w, b.xy), cmul(w, b.zw));
        gl_FragColor = within < uNs ? a + wb : a - wb;
      }
    `,
  })
}

function composeMaterial() {
  return new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: { uInput: { value: null as Texture | null }, uHeight: { value: 0 } },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D uInput;
      uniform float uHeight;
      void main() {
        vec4 f = texelFetch(uInput, ivec2(floor(gl_FragCoord.xy)), 0);
        // f.x : hauteur ; f.y : pente est ; f.z : pente nord.
        gl_FragColor = uHeight > 0.5 ? vec4(f.x, 0.0, 0.0, 1.0) : vec4(f.y, f.z, f.y * f.y, f.z * f.z);
      }
    `,
  })
}

const target = (type: typeof FloatType | typeof HalfFloatType, mip: boolean) =>
  new WebGLRenderTarget(N, N, {
    type,
    format: RGBAFormat,
    depthBuffer: false,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
    magFilter: mip ? LinearFilter : NearestFilter,
    minFilter: mip ? LinearMipmapLinearFilter : NearestFilter,
    generateMipmaps: mip,
  })

interface CascadeState {
  cascade: Cascade
  h0: DataTexture
  ping: WebGLRenderTarget
  pong: WebGLRenderTarget
  slope: WebGLRenderTarget
  height: WebGLRenderTarget
  slopeVariance: number
}

export class OceanCascades {
  readonly cascades: CascadeState[]
  private scene = new Scene()
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private quad: Mesh
  private evolve = evolveMaterial()
  private butterfly = butterflyMaterial()
  private compose = composeMaterial()

  constructor(cascades: readonly Cascade[]) {
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.evolve)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
    this.cascades = cascades.map((cascade) => {
      const h0 = new DataTexture(new Float32Array(N * N * 4), N, N, RGBAFormat, FloatType)
      h0.minFilter = NearestFilter
      h0.magFilter = NearestFilter
      h0.needsUpdate = true
      return { cascade, h0, ping: target(FloatType, false), pong: target(FloatType, false), slope: target(HalfFloatType, true), height: target(HalfFloatType, true), slopeVariance: 0 }
    })
  }

  /** Nouveau spectre : nouvel etat de mer. Tirages deterministes par cascade. */
  setSpectrum(components: SeaComponent[], seed: number) {
    this.cascades.forEach((c, i) => {
      const r = cascadeSpectrum(c.cascade, components, seed + i * 17)
      ;(c.h0.image.data as unknown as Float32Array).set(r.h0)
      c.h0.needsUpdate = true
      c.slopeVariance = r.slopeVariance
    })
  }

  /** Variance des pentes portee par l'ensemble des cascades. */
  get slopeVariance(): number {
    return this.cascades.reduce((s, c) => s + c.slopeVariance, 0)
  }

  private draw(gl: WebGLRenderer, material: ShaderMaterial, out: WebGLRenderTarget) {
    this.quad.material = material
    gl.setRenderTarget(out)
    gl.render(this.scene, this.camera)
  }

  /** Avance les vagues a l'instant `timeS`. */
  update(gl: WebGLRenderer, timeS: number) {
    const previous = gl.getRenderTarget()
    const autoClear = gl.autoClear
    gl.autoClear = false
    for (const c of this.cascades) {
      this.evolve.uniforms.uH0.value = c.h0
      this.evolve.uniforms.uTime.value = timeS
      this.evolve.uniforms.uSize.value = c.cascade.sizeM
      this.draw(gl, this.evolve, c.ping)
      let src = c.ping
      let dst = c.pong
      for (const horizontal of [1, 0]) {
        for (let s = 0; s < STAGES; s++) {
          this.butterfly.uniforms.uInput.value = src.texture
          this.butterfly.uniforms.uNs.value = 2 ** s
          this.butterfly.uniforms.uHorizontal.value = horizontal
          this.draw(gl, this.butterfly, dst)
          ;[src, dst] = [dst, src]
        }
      }
      this.compose.uniforms.uInput.value = src.texture
      this.compose.uniforms.uHeight.value = 0
      this.draw(gl, this.compose, c.slope)
      this.compose.uniforms.uHeight.value = 1
      this.draw(gl, this.compose, c.height)
    }
    gl.setRenderTarget(previous)
    gl.autoClear = autoClear
  }

  dispose() {
    for (const c of this.cascades) {
      c.h0.dispose()
      c.ping.dispose()
      c.pong.dispose()
      c.slope.dispose()
      c.height.dispose()
    }
    this.evolve.dispose()
    this.butterfly.dispose()
    this.compose.dispose()
  }
}
