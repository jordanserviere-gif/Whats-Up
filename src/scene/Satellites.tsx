import { useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, PerspectiveCamera, ShaderMaterial } from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { pointSizePixels } from '@/astro/photometry'
import type { OrbitalElements, SatelliteState, TrackPoint } from '@/astro/types'
import { horizontalToScene, sceneDepth } from './sceneMath'

const DEG = Math.PI / 180

/**
 * Trace d'un satellite dans le ciel.
 *
 * Un seul tampon de segments porte toute la trajectoire ; la couleur par sommet
 * distingue les portions eclairees, eclipsees et situees sous l'horizon, sans
 * multiplier les objets a dessiner.
 */
function trackGeometry(points: TrackPoint[], sunlit: Color, eclipsed: Color, below: Color) {
  const positions: number[] = []
  const colors: number[] = []

  const push = (p: TrackPoint) => {
    // Chaque point est place a sa distance reelle : la trace se rapproche
    // visiblement au zenith du passage et s'eloigne vers l'horizon.
    const [x, y, z] = horizontalToScene(p, sceneDepth(p.rangeKm))
    positions.push(x, y, z)
    const c = p.altitude < 0 ? below : p.sunlit ? sunlit : eclipsed
    colors.push(c.r, c.g, c.b)
  }

  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]
    const b = points[i + 1]
    // Un saut d'azimut de plus de 180° signale un passage par le meridien nord :
    // on coupe le segment pour eviter un trait en travers du ciel.
    if (Math.abs(b.azimuth - a.azimuth) > 180) continue
    push(a)
    push(b)
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  return geo
}

export interface TrackPalette {
  sunlit: string
  eclipsed: string
  below: string
}

export function SatelliteTrack({
  points,
  palette,
  opacity = 1,
}: {
  points: TrackPoint[]
  palette: TrackPalette
  opacity?: number
}) {
  const geometry = useMemo(
    () =>
      trackGeometry(points, new Color(palette.sunlit), new Color(palette.eclipsed), new Color(palette.below)),
    [points, palette],
  )

  return (
    <lineSegments geometry={geometry} frustumCulled={false} renderOrder={7}>
      <lineBasicMaterial vertexColors transparent opacity={opacity} depthWrite={false} />
    </lineSegments>
  )
}

/** Marqueur du satellite : losange lumineux, terni quand il traverse l'ombre. */
export function SatelliteMarker({
  element,
  state,
  limitingMagnitude,
  selected,
}: {
  element: OrbitalElements
  state: SatelliteState
  limitingMagnitude: number
  selected: boolean
}) {
  const mesh = useRef<Mesh>(null)
  const { camera, size } = useThree()

  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: {
          uColor: { value: new Color(element.color) },
          uOpacity: { value: 1 },
          uSunlit: { value: 1 },
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
          uniform float uSunlit;
          void main() {
            // Losange : distance de Manhattan tournee de 45°.
            float d = abs(vUv.x) + abs(vUv.y);
            if (d > 1.0) discard;
            float core = smoothstep(1.0, 0.25, d);
            float ring = smoothstep(0.55, 0.75, d) * smoothstep(1.0, 0.85, d);
            float a = max(core * mix(0.35, 1.0, uSunlit), ring);
            gl_FragColor = vec4(uColor, a * uOpacity);
          }
        `,
      }),
    [element.color],
  )

  useFrame(() => {
    const m = mesh.current
    if (!m) return
    // Le satellite occupe sa distance reelle : il passe donc devant la Lune et
    // les planetes, comme dans le ciel.
    const depth = sceneDepth(state.rangeKm)
    const [x, y, z] = horizontalToScene(state.horizontal, depth)
    m.position.set(x, y, z)
    m.lookAt(camera.position)

    // Taille photometrique, coherente avec les etoiles ; un plancher garantit
    // que le marqueur reste saisissable a la souris.
    const photometric = state.magnitude !== null ? pointSizePixels(state.magnitude, limitingMagnitude) : 0
    const px = Math.max(selected ? 26 : 18, photometric * 2.2)
    const worldHeight = 2 * depth * Math.tan(((camera as PerspectiveCamera).fov * DEG) / 2)
    m.scale.setScalar((worldHeight * px) / Math.max(1, size.height))

    material.uniforms.uSunlit.value = state.sunlit ? 1 : 0
    // Sous l'horizon, le marqueur s'efface sans disparaitre : on garde le repere.
    material.uniforms.uOpacity.value = state.horizontal.altitude > 0 ? 1 : 0.18
    ;(material.uniforms.uColor.value as Color).set(element.color)
  })

  return (
    /* La designation passe par la recherche angulaire de `picking.ts`, comme
       pour les corps : un losange de dix-huit pixels serait cliquable, mais un
       clic apres un balayage le serait aussi, et le ciel se selectionnerait
       tout seul. */
    <mesh ref={mesh} material={material} renderOrder={11} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  )
}

/** Couche complete : traces et marqueurs de tous les satellites definis. */
export function SatelliteLayer({
  elements,
  states,
  tracks,
  showTracks,
  palette,
  limitingMagnitude,
  selectedId,
}: {
  elements: OrbitalElements[]
  states: Map<string, SatelliteState>
  tracks: Map<string, TrackPoint[]>
  showTracks: boolean
  palette: TrackPalette
  limitingMagnitude: number
  selectedId: string | null
}) {
  return (
    <group>
      {elements.map((el) => {
        const state = states.get(el.id)
        const track = tracks.get(el.id)
        const dimmed = selectedId !== null && selectedId !== el.id
        return (
          <group key={el.id}>
            {showTracks && track && <SatelliteTrack points={track} palette={palette} opacity={dimmed ? 0.3 : 0.9} />}
            {state && (
              <SatelliteMarker
                element={el}
                state={state}
                limitingMagnitude={limitingMagnitude}
                selected={selectedId === el.id}
              />
            )}
          </group>
        )
      })}
    </group>
  )
}
