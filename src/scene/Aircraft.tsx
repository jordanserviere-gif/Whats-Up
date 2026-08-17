/**
 * Avions reels : silhouette a l'echelle, trainee de condensation, halo
 * atmospherique. La position vient de `astro/aircraft.ts` — deja en
 * coordonnees horizontales, aucune propagation a faire ici.
 */
import { useMemo, useRef } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, ShaderMaterial } from 'three'
import { useFrame } from '@react-three/fiber'
import { airmass } from '@/astro/photometry'
import { extrapolatedGeodetic, geodeticToHorizontal, type AircraftState } from '@/astro/aircraft'
import { getAircraftHistory } from '@/state/aircraftFeed'
import type { GeoLocation } from '@/astro/types'
import { horizontalToScene, sceneDepth, sceneRadiusForBody } from './sceneMath'

const DEG = Math.PI / 180

/**
 * Silhouette vue du dessous, plate dans le plan XZ local : fuselage, ailes en
 * fleche, empennage. Le nez pointe vers +Z local ; `AircraftMesh` fait
 * correspondre cette direction a la route reelle de l'avion.
 */
function buildAircraftGeometry(): BufferGeometry {
  const vertices: Record<string, [number, number]> = {
    nose: [0, 0.55],
    fuseFrontL: [-0.035, 0.15],
    fuseFrontR: [0.035, 0.15],
    fuseBackL: [-0.03, -0.45],
    fuseBackR: [0.03, -0.45],
    tailEnd: [0, -0.58],
    wingTipL: [-0.5, 0.05],
    wingTipR: [0.5, 0.05],
    wingBackL: [-0.06, -0.1],
    wingBackR: [0.06, -0.1],
    tailTipL: [-0.18, -0.42],
    tailTipR: [0.18, -0.42],
  }
  const order = Object.keys(vertices)
  const idx = (k: string) => order.indexOf(k)
  const positions = new Float32Array(order.length * 3)
  order.forEach((k, i) => {
    const [x, z] = vertices[k]
    positions[i * 3] = x
    positions[i * 3 + 1] = 0
    positions[i * 3 + 2] = z
  })
  const triangles: Array<[string, string, string]> = [
    ['nose', 'fuseFrontL', 'fuseFrontR'],
    ['fuseFrontL', 'fuseBackL', 'fuseBackR'],
    ['fuseFrontL', 'fuseBackR', 'fuseFrontR'],
    ['fuseBackL', 'tailEnd', 'fuseBackR'],
    ['wingTipL', 'fuseFrontL', 'wingBackL'],
    ['wingTipR', 'wingBackR', 'fuseFrontR'],
    ['tailTipL', 'fuseBackL', 'tailEnd'],
    ['tailTipR', 'tailEnd', 'fuseBackR'],
  ]
  const indices: number[] = []
  for (const [a, b, c] of triangles) indices.push(idx(a), idx(b), idx(c))

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(positions, 3))
  geo.setIndex(indices)
  return geo
}

const AIRCRAFT_GEOMETRY = buildAircraftGeometry()
/** Envergure representee : quarante metres, comme demande — un moyen-courrier type. */
const WINGSPAN_KM = 0.04

function aircraftMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uColor: { value: new Color('#e9ebf1') },
      uHazeColor: { value: new Color('#000000') },
      uHaze: { value: 0 },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    // Le voile atmospherique melange la teinte propre de l'avion vers la
    // couleur du ciel dans sa direction : c'est la meme idee que la diffusion
    // de Rayleigh qui blanchit et bleuit un objet lointain bas sur l'horizon.
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uHazeColor;
      uniform float uHaze;
      uniform float uOpacity;
      void main() {
        gl_FragColor = vec4(mix(uColor, uHazeColor, uHaze), uOpacity);
      }
    `,
  })
}

/**
 * Un avion : silhouette posee a plat a son altitude, orientee par sa route.
 *
 * La position affichee n'est pas la derniere mesure telle quelle : ADS-B ne
 * rafraichit qu'a chaque sondage (vingt secondes), alors qu'un avion parcourt
 * facilement deux kilometres dans cet intervalle. Chaque image avance donc la
 * derniere position connue au rythme de la vitesse sol et de la route — voir
 * `extrapolatedGeodetic` — pour un glissement continu plutot qu'un saut toutes
 * les vingt secondes.
 */
function AircraftMesh({
  state,
  location,
  airlight,
  dayFactor,
  selected,
}: {
  state: AircraftState
  location: GeoLocation
  /** Teinte du ciel diurne dans la meme direction — reprise telle quelle des corps. */
  airlight: [number, number, number]
  /** Facteur jour/nuit : un avion ne se voit quasiment plus une fois la nuit tombee. */
  dayFactor: number
  selected: boolean
}) {
  const mesh = useRef<Mesh>(null)
  const material = useMemo(aircraftMaterial, [])

  useFrame(() => {
    const m = mesh.current
    if (!m) return

    const geo = extrapolatedGeodetic(state, Date.now())
    const { horizontal, rangeKm } = geodeticToHorizontal(geo.latitude, geo.longitude, geo.altitudeKm, location)

    const depth = sceneDepth(rangeKm)
    const [x, y, z] = horizontalToScene(horizontal, depth)
    m.position.set(x, y, z)

    // Rotation autour du zenith local : le nez (local +Z) suit la route vraie.
    // Nord = -Z dans le repere de la scene, d'ou le dephasage de π.
    const trackRad = (state.trackDeg ?? 0) * DEG
    m.rotation.set(0, Math.PI - trackRad, 0)

    const halfSpan = sceneRadiusForBody(WINGSPAN_KM / 2, rangeKm)
    m.scale.setScalar(halfSpan * 2)

    const am = airmass(horizontal.altitude)
    material.uniforms.uHaze.value = 1 - Math.exp(-0.14 * (am - 1))
    ;(material.uniforms.uHazeColor.value as Color).setRGB(airlight[0], airlight[1], airlight[2])
    ;(material.uniforms.uColor.value as Color).setRGB(
      selected ? 1 : 0.914,
      selected ? 1 : 0.925,
      selected ? 1 : 0.945,
    )
    material.uniforms.uOpacity.value = horizontal.altitude > -1 ? dayFactor : 0
  })

  return (
    <mesh ref={mesh} geometry={AIRCRAFT_GEOMETRY} material={material} renderOrder={12} frustumCulled={false} />
  )
}

/** Nombre de points de trainee conserves : au-dela, elle se serait de toute facon dissipee. */
const CONTRAIL_POINTS = 24

/**
 * Trainee de condensation.
 *
 * Reconstruite chaque image a partir de l'historique de position observe
 * depuis l'ouverture de l'app — aucune API gratuite ne fournit de trace
 * anterieure. L'opacite decroit vers la queue et depend de la probabilite de
 * condensation a l'altitude de l'avion : sous sept kilometres elle est nulle,
 * le tampon reste alors simplement vide.
 */
function AircraftContrail({ hex, location }: { hex: string; location: GeoLocation }) {
  const geometry = useMemo(() => {
    const geo = new BufferGeometry()
    const segments = CONTRAIL_POINTS - 1
    geo.setAttribute('position', new BufferAttribute(new Float32Array(segments * 2 * 3), 3))
    geo.setAttribute('trailAlpha', new BufferAttribute(new Float32Array(segments * 2), 1))
    geo.setDrawRange(0, 0)
    return geo
  }, [])

  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: {},
        vertexShader: /* glsl */ `
          attribute float trailAlpha;
          varying float vAlpha;
          void main() {
            vAlpha = trailAlpha;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying float vAlpha;
          void main() {
            if (vAlpha < 0.01) discard;
            gl_FragColor = vec4(1.0, 1.0, 1.0, vAlpha);
          }
        `,
      }),
    [],
  )

  useFrame(() => {
    const history = getAircraftHistory(hex)
    if (history.length < 2) {
      geometry.setDrawRange(0, 0)
      return
    }
    const position = geometry.getAttribute('position') as BufferAttribute
    const alpha = geometry.getAttribute('trailAlpha') as BufferAttribute
    const n = Math.min(history.length, CONTRAIL_POINTS)
    const start = history.length - n

    let vertex = 0
    for (let i = 0; i < n - 1; i++) {
      const a = history[start + i]
      const b = history[start + i + 1]
      const fadeA = i / (n - 1)
      const fadeB = (i + 1) / (n - 1)

      for (const [p, fade] of [
        [a, fadeA],
        [b, fadeB],
      ] as const) {
        const { horizontal, rangeKm } = geodeticToHorizontal(p.latitude, p.longitude, p.altitudeKm, location)
        const depth = sceneDepth(rangeKm)
        const [x, y, z] = horizontalToScene(horizontal, depth)
        position.setXYZ(vertex, x, y, z)
        const km = p.altitudeKm
        const localLikelihood = Math.max(0, Math.min(1, (km - 7) / 2.5))
        alpha.setX(vertex, fade * localLikelihood * 0.45)
        vertex++
      }
    }
    geometry.setDrawRange(0, vertex)
    position.needsUpdate = true
    alpha.needsUpdate = true
  })

  return <lineSegments geometry={geometry} material={material} renderOrder={9} frustumCulled={false} />
}

/** Couche complete : un maillage et, le cas echeant, une trainee par avion visible. */
export function AircraftLayer({
  states,
  location,
  airlight,
  dayFactor,
  selectedHex,
}: {
  states: readonly AircraftState[]
  location: GeoLocation
  airlight: [number, number, number]
  dayFactor: number
  selectedHex: string | null
}) {
  return (
    <group>
      {states.map((s) => (
        <group key={s.hex}>
          <AircraftMesh
            state={s}
            location={location}
            airlight={airlight}
            dayFactor={dayFactor}
            selected={s.hex === selectedHex}
          />
          {s.contrailLikelihood > 0.02 && <AircraftContrail hex={s.hex} location={location} />}
        </group>
      ))}
    </group>
  )
}
