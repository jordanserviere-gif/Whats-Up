import { useEffect, useMemo, useRef } from 'react'
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  PerspectiveCamera,
  Points,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { POINT_BASE_SIZE_PX, pointSizePixels } from '@/astro/photometry'
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

/**
 * Nuee du catalogue : un point blanc par satellite, dimensionne par sa magnitude.
 *
 * Un maillage par objet ne passe pas l'echelle — chaque satellite y coutait un
 * appel de dessin, un materiau et un `useFrame`. Ici, un seul nuage de points
 * porte le catalogue entier : les positions sont reecrites dans le meme tampon a
 * chaque rafraichissement des ephemerides.
 *
 * L'eclat suit la meme loi photometrique que les etoiles, avec la magnitude
 * estimee du satellite : ceux qui rentrent dans l'ombre de la Terre s'eteignent
 * d'eux-memes, puisqu'ils n'ont alors plus de magnitude du tout.
 */
export function SatelliteField({
  elements,
  states,
  limitingMagnitude,
  excludeId,
}: {
  elements: readonly OrbitalElements[]
  states: Map<string, SatelliteState>
  limitingMagnitude: number
  /** Objet rendu separement — le selectionne porte son propre marqueur. */
  excludeId: string | null
}) {
  const points = useRef<Points>(null)

  // Le tampon est dimensionne sur le catalogue, pas sur ce qui est visible :
  // le realouer a chaque image annulerait tout le benefice du nuage unique.
  const geometry = useMemo(() => {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(Math.max(1, elements.length) * 3), 3))
    geo.setAttribute('satMag', new BufferAttribute(new Float32Array(Math.max(1, elements.length)), 1))
    geo.setDrawRange(0, 0)
    // Les satellites couvrent tout le ciel et bougent sans cesse : la sphere
    // englobante calculee une fois serait fausse des l'image suivante.
    geo.boundingSphere = new Sphere(new Vector3(), 1e6)
    return geo
  }, [elements.length])

  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: {
          uLimitMag: { value: limitingMagnitude },
          uPixelRatio: { value: Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio) },
          uBaseSize: { value: POINT_BASE_SIZE_PX },
        },
        vertexShader: /* glsl */ `
          attribute float satMag;
          varying float vIntensity;
          uniform float uLimitMag;
          uniform float uPixelRatio;
          uniform float uBaseSize;

          void main() {
            // Rapport de flux a la magnitude limite : 1 exactement a la limite.
            float rel = pow(10.0, -0.4 * (satMag - uLimitMag));
            float lg = log(1.0 + rel);
            vIntensity = clamp(0.32 * lg, 0.0, 1.0);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            // Plancher d'un pixel et demi : sous cette taille un satellite
            // disparait entre deux pixels et le ciel se met a scintiller.
            gl_PointSize = clamp(uBaseSize * (0.55 + 0.5 * lg) * uPixelRatio, 1.5 * uPixelRatio, 40.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying float vIntensity;
          void main() {
            if (vIntensity < 0.004) discard;
            vec2 d = gl_PointCoord - vec2(0.5);
            float r = length(d) * 2.0;
            float core = exp(-r * r * 7.0);
            float alpha = core * vIntensity;
            if (alpha < 0.004) discard;
            // Un satellite ne renvoie que la lumiere du Soleil : il est blanc.
            gl_FragColor = vec4(1.0, 1.0, 1.0, alpha);
          }
        `,
      }),
    // La magnitude limite passe par un uniform, reecrit a chaque image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useFrame(() => {
    const node = points.current
    if (!node) return
    material.uniforms.uLimitMag.value = limitingMagnitude
    material.uniforms.uPixelRatio.value = Math.min(2, window.devicePixelRatio)

    const position = geometry.getAttribute('position') as BufferAttribute
    const mag = geometry.getAttribute('satMag') as BufferAttribute
    let n = 0

    for (const el of elements) {
      if (el.id === excludeId) continue
      const state = states.get(el.id)
      // Sous l'horizon, le satellite est derriere la Terre : rien a dessiner.
      if (!state || state.horizontal.altitude <= 0) continue
      // Sans magnitude, l'objet traverse l'ombre : il n'est pas visible.
      if (state.magnitude === null) continue
      const [x, y, z] = horizontalToScene(state.horizontal, sceneDepth(state.rangeKm))
      position.setXYZ(n, x, y, z)
      mag.setX(n, state.magnitude)
      n++
    }

    geometry.setDrawRange(0, n)
    position.needsUpdate = true
    mag.needsUpdate = true
  })

  // Le tampon est realoue quand le catalogue change de taille : sans liberation
  // explicite, chaque changement de groupe laisserait le precedent sur la carte.
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  return <points ref={points} geometry={geometry} material={material} renderOrder={10} frustumCulled={false} />
}

/**
 * Couche complete.
 *
 * Deux regimes cohabitent : le catalogue passe par la nuee de points, tandis que
 * les orbites saisies a la main et l'objet selectionne gardent leur losange et
 * leur trace. C'est la distinction utile — on suit nommement quelques objets,
 * on regarde le reste passer.
 */
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
  const { field, marked } = useMemo(() => {
    const f: OrbitalElements[] = []
    const m: OrbitalElements[] = []
    for (const el of elements) {
      if (el.source === 'celestrak' && el.id !== selectedId) f.push(el)
      else m.push(el)
    }
    return { field: f, marked: m }
  }, [elements, selectedId])

  return (
    <group>
      {field.length > 0 && (
        <SatelliteField
          elements={field}
          states={states}
          limitingMagnitude={limitingMagnitude}
          excludeId={selectedId}
        />
      )}
      {marked.map((el) => {
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
