import { useMemo, useRef } from 'react'
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  ShaderMaterial,
  SphereGeometry,
  Texture,
  Vector3,
} from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { BODY_BY_ID } from '@/astro/bodies'
import { bodyOrientation } from '@/astro/orientation'
import { extinctionMagnitudes, extinctionTint, pointIntensity, pointSizePixels } from '@/astro/photometry'
import type { BodyState, GeoLocation } from '@/astro/types'
import { equatorialDirectionToScene, sceneDepth, sceneRadiusForBody } from './sceneMath'

const DEG = Math.PI / 180

/** Taille monde d'un objet devant occuper `pixels` a l'ecran, a la distance `depth`. */
function worldSizeForPixels(pixels: number, camera: PerspectiveCamera, viewportHeight: number, depth: number): number {
  const worldHeight = 2 * depth * Math.tan((camera.fov * DEG) / 2)
  return (worldHeight * pixels) / Math.max(1, viewportHeight)
}

/**
 * Surface d'un corps eclaire par le Soleil.
 *
 * La phase n'est pas dessinee : elle resulte du produit scalaire entre la
 * normale et la direction reelle du Soleil, transportee depuis le repere
 * equatorial. Croissant lunaire, phase de Venus et orientation du terminateur
 * sortent donc de la geometrie.
 *
 * La carte de surface est plaquee en projection equirectangulaire, dans un
 * repere aligne sur l'axe de rotation et le meridien origine du corps.
 */
function bodyMaterial() {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color('#ffffff') },
      uMap: { value: null as Texture | null },
      uHasMap: { value: 0 },
      uSunDir: { value: new Vector3(1, 0, 0) },
      uEmissive: { value: 0 },
      uEmissiveGain: { value: 1 },
      uNightSide: { value: 0.02 },
      uTint: { value: new Vector3(1, 1, 1) },
      uBrightness: { value: 1 },
      /** Relief simule a partir du gradient de l'albedo : creuse les crateres. */
      uRelief: { value: 0 },
      uTexelSize: { value: 1 / 2048 },
      /**
       * Lumiere atmospherique diffusee entre l'observateur et l'astre.
       * Sans elle, la face nuit d'une planete se decoupe en noir sur un ciel de
       * jour — un trou dans le ciel. C'est ce voile, et non l'eclat de l'astre,
       * qui rend les planetes invisibles en plein jour.
       */
      uAirlight: { value: new Vector3(0, 0, 0) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vViewDir = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform sampler2D uMap;
      uniform float uHasMap;
      uniform vec3 uSunDir;
      uniform float uEmissive;
      uniform float uEmissiveGain;
      uniform float uNightSide;
      uniform vec3 uTint;
      uniform float uBrightness;
      uniform float uRelief;
      uniform float uTexelSize;
      uniform vec3 uAirlight;

      void main() {
        vec3 n = normalize(vNormal);
        vec3 sun = normalize(uSunDir);

        vec3 albedo = uColor;
        if (uHasMap > 0.5) {
          albedo = texture2D(uMap, vUv).rgb * uColor;

          // Relief approche : la carte d'albedo sert de carte de hauteur. Sur la
          // Lune, cela suffit a faire accrocher la lumiere rasante aux crateres
          // pres du terminateur, la ou l'oeil l'attend.
          if (uRelief > 0.0) {
            float hx = texture2D(uMap, vUv + vec2(uTexelSize, 0.0)).g - texture2D(uMap, vUv - vec2(uTexelSize, 0.0)).g;
            float hy = texture2D(uMap, vUv + vec2(0.0, uTexelSize)).g - texture2D(uMap, vUv - vec2(0.0, uTexelSize)).g;
            // Base tangente approchee : suffisante pour une perturbation locale.
            vec3 tangent = normalize(cross(vec3(0.0, 1.0, 0.0), n));
            vec3 bitangent = cross(n, tangent);
            n = normalize(n - uRelief * (hx * tangent + hy * bitangent));
          }
        }

        float lambert = max(0.0, dot(n, sun));

        // Le terminateur d'un corps sans atmosphere est net, mais jamais a
        // l'echelle du pixel : on l'adoucit sur une fraction de degre.
        float lit = smoothstep(0.0, 0.05, lambert) * pow(lambert, 0.55);

        // Assombrissement centre-bord : le limbe recoit la lumiere en incidence rasante.
        float mu = max(0.0, dot(n, normalize(vViewDir)));
        float limb = 0.55 + 0.45 * pow(mu, 0.45);

        // uNightSide porte la lumiere cendree cote nuit.
        float shade = mix(uNightSide, limb, lit);
        vec3 col = albedo * mix(shade, uEmissiveGain, uEmissive) * uTint * uBrightness;
        gl_FragColor = vec4(col + uAirlight, 1.0);
      }
    `,
  })
}

/**
 * Disque solaire.
 *
 * Le Soleil n'est pas une surface eclairee : c'est une source. On le rend blanc
 * et sature, avec le seul assombrissement centre-bord de la photosphere, et une
 * intensite superieure a 1 pour alimenter le flou lumineux. Le rougissement au
 * ras de l'horizon vient de l'extinction atmospherique, pas d'une couleur fixe.
 */
function sunMaterial() {
  return new ShaderMaterial({
    uniforms: {
      uTint: { value: new Vector3(1, 1, 1) },
      uGain: { value: 6 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vViewDir = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      uniform vec3 uTint;
      uniform float uGain;
      void main() {
        float mu = max(0.0, dot(normalize(vNormal), normalize(vViewDir)));
        // Assombrissement centre-bord de la photosphere (loi en u = 0,6).
        float limb = 1.0 - 0.6 * (1.0 - pow(max(mu, 0.001), 0.5));
        gl_FragColor = vec4(vec3(1.0) * uTint * limb * uGain, 1.0);
      }
    `,
  })
}

/** Halo additif : c'est lui qui donne son eclat a une source non resolue. */
function glowMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: {
      uColor: { value: new Color('#ffffff') },
      uOpacity: { value: 1 },
      uFalloff: { value: 3.2 },
      uCore: { value: 0.16 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uFalloff;
      uniform float uCore;
      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;
        float core = smoothstep(uCore, 0.0, r);
        float halo = pow(max(0.0, 1.0 - r), uFalloff);
        gl_FragColor = vec4(uColor, (core * 0.85 + halo) * uOpacity);
      }
    `,
  })
}

/** Geometrie partagee : tous les corps sont la meme sphere, a l'echelle pres. */
const SPHERE = new SphereGeometry(1, 96, 64)

interface BodyProps {
  state: BodyState
  color: string
  /** Teinte du halo — distincte du disque pour le Soleil. */
  glowColor: string
  texture: Texture | null
  date: Date
  location: GeoLocation
  limitingMagnitude: number
  discScale: number
  /** Voile atmospherique ajoute au disque : voir l'uniforme `uAirlight`. */
  airlight: [number, number, number]
  selected: boolean
  selectionColor: string
  onSelect: (id: string) => void
}

/**
 * Un corps du systeme solaire, place a sa profondeur reelle (comprimee) et a
 * son diametre apparent exact. Le halo photometrique prend le relais quand le
 * disque devient plus petit qu'un pixel.
 */
function Body({
  state,
  color,
  glowColor,
  texture,
  date,
  location,
  limitingMagnitude,
  discScale,
  airlight,
  selected,
  selectionColor,
  onSelect,
}: BodyProps) {
  const group = useRef<Group>(null)
  const sphere = useRef<Mesh>(null)
  const glow = useRef<Mesh>(null)
  const ring = useRef<Mesh>(null)
  const { camera, size } = useThree()

  const isSun = state.id === 'sun'
  const surface = useMemo(() => (isSun ? sunMaterial() : bodyMaterial()), [isSun])
  const halo = useMemo(glowMaterial, [])
  const scratch = useRef(new Matrix4())
  const basis = useRef(new Matrix4())

  useFrame(({ clock }) => {
    const g = group.current
    const s = sphere.current
    if (!g || !s) return

    const depth = sceneDepth(state.distanceKm)
    const dir = equatorialDirectionToScene(
      [
        state.positionEq[0] / state.distanceKm,
        state.positionEq[1] / state.distanceKm,
        state.positionEq[2] / state.distanceKm,
      ],
      date,
      location,
      scratch.current,
    )
    g.position.set(dir[0] * depth, dir[1] * depth, dir[2] * depth)

    const trueRadius = sceneRadiusForBody(state.radiusKm, state.distanceKm)
    s.scale.setScalar(trueRadius * discScale)

    const extinction = extinctionMagnitudes(state.horizontal.altitude)
    const tint = extinctionTint(state.horizontal.altitude)

    if (isSun) {
      // Un Soleil haut est blanc et eblouissant ; c'est l'extinction qui le
      // rougit et l'affaiblit quand il descend, comme dans le ciel.
      ;(surface.uniforms.uTint.value as Vector3).set(tint[0], tint[1], tint[2])
      surface.uniforms.uGain.value = 6 * Math.pow(10, -0.4 * extinction * 0.5)
    } else {
      const sd = equatorialDirectionToScene(state.sunDirectionEq, date, location, scratch.current)
      ;(surface.uniforms.uSunDir.value as Vector3).set(sd[0], sd[1], sd[2])
      surface.uniforms.uEmissive.value = 0
      surface.uniforms.uNightSide.value = state.id === 'moon' ? 0.035 : 0.008
      surface.uniforms.uHasMap.value = texture ? 1 : 0
      surface.uniforms.uMap.value = texture
      // Le relief simule ne sert que sur la Lune : elle seule se resout assez.
      surface.uniforms.uRelief.value = state.id === 'moon' ? 6 : 0
      surface.uniforms.uTexelSize.value = 1 / ((texture?.image as { width?: number } | undefined)?.width ?? 2048)
      // La carte porte deja la couleur : le token ne sert qu'aux corps sans carte.
      ;(surface.uniforms.uColor.value as Color).set(texture ? '#ffffff' : color)
      ;(surface.uniforms.uTint.value as Vector3).set(tint[0], tint[1], tint[2])
      surface.uniforms.uBrightness.value = Math.pow(10, -0.4 * extinction * 0.6)
      ;(surface.uniforms.uAirlight.value as Vector3).set(airlight[0], airlight[1], airlight[2])

      // Orientation reelle : axe de rotation et meridien origine du corps.
      const def = BODY_BY_ID.get(state.id)
      if (def && texture) {
        const o = bodyOrientation(def.body, date)
        const north = equatorialDirectionToScene(o.north, date, location, scratch.current)
        const meridian = equatorialDirectionToScene(o.primeMeridian, date, location, scratch.current)
        // Cartes equirectangulaires : longitude 0 au centre de l'image, donc sur
        // l'axe +X local de la sphere de three.js ; le pole nord sur +Y.
        const y = new Vector3(north[0], north[1], north[2]).normalize()
        const x = new Vector3(meridian[0], meridian[1], meridian[2])
        x.sub(y.clone().multiplyScalar(x.dot(y))).normalize()
        const z = new Vector3().crossVectors(x, y)
        basis.current.makeBasis(x, y, z)
        s.quaternion.setFromRotationMatrix(basis.current)
      }
    }

    const gl = glow.current
    if (gl) {
      const discPixels =
        (trueRadius * discScale * 2 * size.height) /
        (2 * depth * Math.tan(((camera as PerspectiveCamera).fov * DEG) / 2))

      if (isSun) {
        // Le halo solaire est un eblouissement, pas une source ponctuelle.
        //
        // Tant que le disque tient dans quelques pixels, l'eblouissement porte
        // tout l'objet et s'etale largement. Des qu'on grossit assez pour le
        // resoudre, il se resserre en aureole autour du limbe : sinon le halo
        // recouvrirait le disque, qui paraitrait alors plus sombre que sa
        // propre couronne.
        const resolved = Math.min(1, discPixels / 60)
        gl.scale.setScalar(trueRadius * discScale * (2.2 + 6 * (1 - resolved)))
        halo.uniforms.uOpacity.value = (0.16 + 0.5 * (1 - resolved)) * Math.pow(10, -0.4 * extinction * 0.4)
        halo.uniforms.uFalloff.value = 3
        // Aucun coeur sature : il masquerait le limbe.
        halo.uniforms.uCore.value = 0
        ;(halo.uniforms.uColor.value as Color).set(glowColor)
      } else {
        const apparentMag = state.magnitude + extinction
        const px = pointSizePixels(apparentMag, limitingMagnitude)
        const glowWorld = worldSizeForPixels(Math.max(px, 0.5), camera as PerspectiveCamera, size.height, depth)
        // Le halo s'efface des que le disque est resolu : sinon il le noierait.
        const resolved = Math.min(1, discPixels / Math.max(1e-3, px))
        gl.scale.setScalar(Math.max(glowWorld, trueRadius * discScale * 2.4))
        halo.uniforms.uOpacity.value = pointIntensity(apparentMag, limitingMagnitude) * (1 - 0.85 * resolved)
        halo.uniforms.uFalloff.value = 3.4
        halo.uniforms.uCore.value = 0.16
        ;(halo.uniforms.uColor.value as Color).set(color)
      }

      gl.lookAt(camera.position)
      gl.visible = halo.uniforms.uOpacity.value > 0.004
    }

    const r = ring.current
    if (r) {
      r.lookAt(camera.position)
      const base = worldSizeForPixels(44, camera as PerspectiveCamera, size.height, depth)
      r.scale.setScalar(Math.max(base, trueRadius * discScale * 3) * (1 + 0.05 * Math.sin(clock.elapsedTime * 2.4)))
    }
  })

  return (
    <group ref={group}>
      <mesh
        ref={sphere}
        geometry={SPHERE}
        material={surface}
        renderOrder={20}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(state.id)
        }}
      />
      <mesh ref={glow} material={halo} renderOrder={21}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      {selected && (
        <mesh ref={ring} renderOrder={24}>
          <ringGeometry args={[0.44, 0.5, 56]} />
          <meshBasicMaterial
            color={selectionColor}
            transparent
            opacity={0.9}
            depthWrite={false}
            depthTest={false}
            side={DoubleSide}
          />
        </mesh>
      )}
    </group>
  )
}

/**
 * Anneaux de Saturne. Sans eux, Saturne resolue ressemble a une bille : c'est le
 * seul detail qui change vraiment la lecture d'un disque planetaire.
 * La carte porte l'alpha, donc la division de Cassini et l'anneau de crepe.
 */
function SaturnRings({
  state,
  date,
  location,
  texture,
  discScale,
}: {
  state: BodyState
  date: Date
  location: GeoLocation
  texture: Texture | null
  discScale: number
}) {
  const mesh = useRef<Mesh>(null)
  const scratch = useRef(new Matrix4())
  const basis = useRef(new Matrix4())

  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        side: DoubleSide,
        depthWrite: false,
        uniforms: {
          uMap: { value: null as Texture | null },
          uHasMap: { value: 0 },
          uColor: { value: new Color('#f0dda3') },
          uTint: { value: new Vector3(1, 1, 1) },
          uBrightness: { value: 1 },
          uInner: { value: 1.24 },
          uOuter: { value: 2.27 },
        },
        vertexShader: /* glsl */ `
          varying vec3 vLocal;
          void main() {
            vLocal = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 vLocal;
          uniform sampler2D uMap;
          uniform float uHasMap;
          uniform vec3 uColor;
          uniform vec3 uTint;
          uniform float uBrightness;
          uniform float uInner;
          uniform float uOuter;
          void main() {
            // La carte d'anneau est une bande : on l'echantillonne selon le
            // rayon, seule dimension qui porte de l'information.
            float r = length(vLocal.xy);
            float t = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);
            vec4 sampled = uHasMap > 0.5 ? texture2D(uMap, vec2(t, 0.5)) : vec4(uColor, 0.85);
            if (sampled.a < 0.01) discard;
            gl_FragColor = vec4(sampled.rgb * uTint * uBrightness, sampled.a);
          }
        `,
      }),
    [],
  )

  useFrame(() => {
    const m = mesh.current
    if (!m) return

    const depth = sceneDepth(state.distanceKm)
    const dir = equatorialDirectionToScene(
      [
        state.positionEq[0] / state.distanceKm,
        state.positionEq[1] / state.distanceKm,
        state.positionEq[2] / state.distanceKm,
      ],
      date,
      location,
      scratch.current,
    )
    m.position.set(dir[0] * depth, dir[1] * depth, dir[2] * depth)
    m.scale.setScalar(sceneRadiusForBody(state.radiusKm, state.distanceKm) * discScale)

    // Le plan des anneaux est l'equateur de Saturne : sa normale est l'axe.
    const def = BODY_BY_ID.get('saturn')
    if (def) {
      const o = bodyOrientation(def.body, date)
      const north = equatorialDirectionToScene(o.north, date, location, scratch.current)
      const meridian = equatorialDirectionToScene(o.primeMeridian, date, location, scratch.current)
      // La geometrie « ring » vit dans le plan XY, normale +Z : on y amene l'axe.
      const z = new Vector3(north[0], north[1], north[2]).normalize()
      const x = new Vector3(meridian[0], meridian[1], meridian[2])
      x.sub(z.clone().multiplyScalar(x.dot(z))).normalize()
      const y = new Vector3().crossVectors(z, x)
      basis.current.makeBasis(x, y, z)
      m.quaternion.setFromRotationMatrix(basis.current)
    }

    const tint = extinctionTint(state.horizontal.altitude)
    ;(material.uniforms.uTint.value as Vector3).set(tint[0], tint[1], tint[2])
    material.uniforms.uBrightness.value = Math.pow(10, -0.4 * extinctionMagnitudes(state.horizontal.altitude) * 0.6)
    material.uniforms.uHasMap.value = texture ? 1 : 0
    material.uniforms.uMap.value = texture
  })

  return (
    <mesh ref={mesh} material={material} renderOrder={19}>
      <ringGeometry args={[1.24, 2.27, 128, 1]} />
    </mesh>
  )
}

/** Ensemble des corps du systeme solaire, en profondeur reelle. */
export function SolarSystemBodies({
  states,
  date,
  location,
  limitingMagnitude,
  discScale,
  airlight,
  colors,
  sunGlowColor,
  textures,
  selectedId,
  selectionColor,
  onSelect,
}: {
  states: BodyState[]
  date: Date
  location: GeoLocation
  limitingMagnitude: number
  discScale: number
  airlight: [number, number, number]
  colors: Map<string, string>
  sunGlowColor: string
  textures: Map<string, Texture>
  selectedId: string | null
  selectionColor: string
  onSelect: (id: string) => void
}) {
  const saturn = states.find((s) => s.id === 'saturn')

  return (
    <group>
      {states.map((state) => (
        <Body
          key={state.id}
          state={state}
          color={colors.get(state.id) ?? '#ffffff'}
          glowColor={state.id === 'sun' ? sunGlowColor : (colors.get(state.id) ?? '#ffffff')}
          texture={textures.get(state.id) ?? null}
          date={date}
          location={location}
          limitingMagnitude={limitingMagnitude}
          discScale={discScale}
          airlight={airlight}
          selected={selectedId === state.id}
          selectionColor={selectionColor}
          onSelect={onSelect}
        />
      ))}
      {saturn && (
        <SaturnRings
          state={saturn}
          date={date}
          location={location}
          texture={textures.get('saturn-ring') ?? null}
          discScale={discScale}
        />
      )}
    </group>
  )
}
