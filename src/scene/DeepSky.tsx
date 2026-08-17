import { useMemo, useRef } from 'react'
import {
  AdditiveBlending,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { buildDeepSkyGeometry, DEEP_SKY_TYPES } from '@/astro/deepsky'
import {
  POINT_BRIGHTNESS_SCALE,
  POINT_VISIBILITY_FADE_END,
  POINT_VISIBILITY_FADE_START,
  skySurfaceBrightness,
} from '@/astro/photometry'
import type { GeoLocation } from '@/astro/types'
import { equatorialToSceneMatrix, SKY_RADIUS } from './sceneMath'

const DEG = Math.PI / 180
const ARCMIN = DEG / 60

/**
 * Taille minimale du quad, en radians.
 *
 * Le maillage instancie ne peut pas grandir avec le champ : chaque quad est
 * dimensionne une fois pour toutes. On lui donne donc un plancher assez large
 * pour contenir, au champ le plus ouvert, la tache de quelques pixels par
 * laquelle un objet non resolu se signale. Le nuanceur ne dessine a l'interieur
 * que l'ellipse reelle, ou ce point.
 */
const QUAD_FLOOR = 8 * ARCMIN

/** Couleur par type OpenNGC, resolue depuis les tokens applicatifs. */
function typeColorTokens(): Record<string, string> {
  return {
    G: '--app-dso-galaxy',
    GPair: '--app-dso-galaxy',
    GTrpl: '--app-dso-galaxy',
    GGroup: '--app-dso-galaxy',
    GCl: '--app-dso-cluster-globular',
    OCl: '--app-dso-cluster-open',
    'Cl+N': '--app-dso-nebula-emission',
    PN: '--app-dso-nebula-planetary',
    Neb: '--app-dso-nebula-reflection',
    HII: '--app-dso-nebula-emission',
    EmN: '--app-dso-nebula-emission',
    RfN: '--app-dso-nebula-reflection',
    DrkN: '--app-dso-default',
    SNR: '--app-dso-supernova',
    Nova: '--app-dso-supernova',
    Other: '--app-dso-default',
  }
}

/**
 * Objets du ciel profond, dessines a leur taille apparente reelle.
 *
 * Un maillage instancie unique porte les 1 700 objets : chaque instance est un
 * quad oriente vers l'observateur et mis a l'echelle des deux axes de l'objet,
 * ce qui donne l'ellipse sans geometrie dediee. Les matrices d'instance sont
 * calculees dans le repere equatorial, donc **une seule fois** — la rotation
 * diurne est portee par la matrice du groupe, comme pour les etoiles.
 *
 * La visibilite ne suit pas la magnitude integree mais la **brillance de
 * surface** comparee a celle du fond de ciel : c'est ce qui fait qu'une galaxie
 * de magnitude 3,4 etalee sur trois degres reste discrete, et qu'elle disparait
 * de jour sans traitement particulier.
 */
export function DeepSky({
  date,
  location,
  magnitudeLimit,
  limitingMagnitude,
  illuminance,
  resolveToken,
}: {
  date: Date
  location: GeoLocation
  magnitudeLimit: number
  limitingMagnitude: number
  illuminance: number
  /** Resolution d'un token CSS en couleur — injectee pour suivre le theme. */
  resolveToken: (token: string, fallback?: string) => string
}) {
  const meshRef = useRef<InstancedMesh>(null)
  const matrix = useRef(new Matrix4())

  const { geometry, material, count } = useMemo(() => {
    const data = buildDeepSkyGeometry(date, magnitudeLimit)
    const n = data.count

    const plane = new PlaneGeometry(1, 1)
    const semiMajor = new Float32Array(n)
    const semiMinor = new Float32Array(n)
    const quadSemi = new Float32Array(n)
    const colors = new Float32Array(n * 3)

    const tokens = typeColorTokens()
    const paletteCache = new Map<string, Color>()
    const colorFor = (typeIndex: number) => {
      const type = DEEP_SKY_TYPES[typeIndex] ?? 'Other'
      const cached = paletteCache.get(type)
      if (cached) return cached
      const color = new Color(resolveToken(tokens[type] ?? '--app-dso-default', '#d6d9e6'))
      paletteCache.set(type, color)
      return color
    }

    for (let k = 0; k < n; k++) {
      const a = Math.max(data.semiMajor[k], 0)
      const b = Math.max(data.semiMinor[k], 0)
      semiMajor[k] = a
      semiMinor[k] = b > 0 ? b : a
      // Le quad est carre : il doit contenir le grand axe quelle que soit la
      // rotation, et le plancher quand l'objet n'est pas resolu.
      quadSemi[k] = Math.max(a, QUAD_FLOOR)

      const color = colorFor(data.types[k])
      colors[k * 3] = color.r
      colors[k * 3 + 1] = color.g
      colors[k * 3 + 2] = color.b
    }

    plane.setAttribute('aSemiMajor', new InstancedBufferAttribute(semiMajor, 1))
    plane.setAttribute('aSemiMinor', new InstancedBufferAttribute(semiMinor, 1))
    plane.setAttribute('aQuadSemi', new InstancedBufferAttribute(quadSemi, 1))
    plane.setAttribute('aMag', new InstancedBufferAttribute(data.magnitudes.slice(), 1))
    plane.setAttribute('aSb', new InstancedBufferAttribute(data.surfaceBrightness.slice(), 1))
    plane.setAttribute('aExtended', new InstancedBufferAttribute(data.extended.slice(), 1))
    plane.setAttribute('aColor', new InstancedBufferAttribute(colors, 3))

    const shader = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uLimitMag: { value: limitingMagnitude },
        uSkySb: { value: 21.8 },
        /** Pixels par radian : convertit une taille angulaire en taille ecran. */
        uPixelsPerRadian: { value: 1000 },
        uMinPixelRadius: { value: 1.4 },
      },
      vertexShader: /* glsl */ `
        attribute float aSemiMajor;
        attribute float aSemiMinor;
        attribute float aQuadSemi;
        attribute float aMag;
        attribute float aSb;
        attribute float aExtended;
        attribute vec3 aColor;

        varying vec2 vUv;
        varying vec3 vColor;
        varying float vSemiMajor;
        varying float vSemiMinor;
        varying float vQuadSemi;
        varying float vMag;
        varying float vSb;
        varying float vExtended;

        void main() {
          vUv = uv * 2.0 - 1.0;
          vColor = aColor;
          vSemiMajor = aSemiMajor;
          vSemiMinor = aSemiMinor;
          vQuadSemi = aQuadSemi;
          vMag = aMag;
          vSb = aSb;
          vExtended = aExtended;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vSemiMajor;
        varying float vSemiMinor;
        varying float vQuadSemi;
        varying float vMag;
        varying float vSb;
        varying float vExtended;

        uniform float uLimitMag;
        uniform float uSkySb;
        uniform float uPixelsPerRadian;
        uniform float uMinPixelRadius;

        void main() {
          // Taille angulaire minimale pour rester perceptible a l'ecran : en
          // deca, l'objet se signale comme un point plutot que de disparaitre.
          float minAngular = uMinPixelRadius / max(uPixelsPerRadian, 1.0);
          float a = max(vSemiMajor, minAngular);
          float b = max(vSemiMinor, minAngular);

          // vUv couvre le quad ; on le ramene en unites angulaires, puis on
          // normalise par les demi-axes : la distance obtenue vaut 1 sur l'ellipse.
          vec2 angular = vUv * vQuadSemi;
          float d = length(vec2(angular.x / b, angular.y / a));
          if (d > 1.0) discard;

          float opacity;
          if (vExtended > 0.5) {
            // Objet etendu : c'est le contraste de brillance de surface avec le
            // fond de ciel qui decide, non la magnitude integree.
            float contrast = uSkySb - vSb;
            opacity = clamp((contrast + 1.5) / 3.5, 0.0, 1.0);
          } else {
            // Dimensions inconnues : on retombe sur la loi des sources
            // ponctuelles — meme courbe que pointIntensity(), voir photometry.ts.
            float delta = vMag - uLimitMag;
            float rel = pow(10.0, -0.4 * delta);
            float gate = 1.0 - smoothstep(${POINT_VISIBILITY_FADE_START.toFixed(1)}, ${POINT_VISIBILITY_FADE_END.toFixed(1)}, delta);
            opacity = clamp(${POINT_BRIGHTNESS_SCALE} * log(1.0 + rel) * gate, 0.0, 1.0);
          }

          // Un objet reste toujours plus tenu que les etoiles qui l'entourent.
          opacity *= 0.42;

          // Profil : noyau concentre et halo etendu, plutot qu'un disque uni.
          // C'est ainsi que se presente une galaxie ou un amas — la brillance
          // chute vite depuis le centre, et le bord n'existe pas.
          float core = exp(-d * d * 9.0);
          float halo = exp(-d * d * 2.0) * 0.35;
          float falloff = (core + halo) * (1.0 - smoothstep(0.8, 1.0, d));
          float alpha = falloff * opacity;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
    })

    return { geometry: plane, material: shader, count: n }
    // La precession est imperceptible a l'echelle d'une session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date.getUTCFullYear(), magnitudeLimit, resolveToken])

  // Pose des matrices d'instance, une seule fois apres construction du maillage.
  const posed = useRef<number | null>(null)
  const { camera, size } = useThree()

  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh) return

    if (posed.current !== count) {
      const data = buildDeepSkyGeometry(date, magnitudeLimit)
      const instance = new Matrix4()
      const position = new Vector3()
      const toObserver = new Vector3()
      const north = new Vector3()
      const east = new Vector3()
      const axisX = new Vector3()
      const axisY = new Vector3()
      const basis = new Matrix4()
      const quaternion = new Quaternion()
      const scale = new Vector3()

      for (let k = 0; k < data.count; k++) {
        const x = data.positions[k * 3]
        const y = data.positions[k * 3 + 1]
        const z = data.positions[k * 3 + 2]
        position.set(x, y, z).multiplyScalar(SKY_RADIUS)

        const dec = Math.asin(Math.min(1, Math.max(-1, z)))
        const ra = Math.atan2(y, x)
        north.set(-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)).normalize()
        east.set(-Math.sin(ra), Math.cos(ra), 0).normalize()

        const pa = data.angle[k]
        axisY.copy(north).multiplyScalar(Math.cos(pa)).addScaledVector(east, Math.sin(pa)).normalize()
        toObserver.copy(position).multiplyScalar(-1).normalize()
        axisX.crossVectors(axisY, toObserver).normalize()

        basis.makeBasis(axisX, axisY, toObserver)
        quaternion.setFromRotationMatrix(basis)

        const quad = Math.max(data.semiMajor[k], QUAD_FLOOR)
        const world = 2 * SKY_RADIUS * quad
        scale.set(world, world, 1)

        instance.compose(position, quaternion, scale)
        mesh.setMatrixAt(k, instance)
      }
      mesh.instanceMatrix.needsUpdate = true
      posed.current = count
    }

    equatorialToSceneMatrix(date, location, matrix.current)
    mesh.matrix.copy(matrix.current)
    mesh.matrixAutoUpdate = false
    mesh.matrixWorldNeedsUpdate = true

    const fov = (camera as PerspectiveCamera).fov * DEG
    material.uniforms.uPixelsPerRadian.value = size.height / (2 * Math.tan(fov / 2))
    material.uniforms.uLimitMag.value = limitingMagnitude
    material.uniforms.uSkySb.value = skySurfaceBrightness(illuminance)
  })

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      frustumCulled={false}
      renderOrder={3}
    />
  )
}
