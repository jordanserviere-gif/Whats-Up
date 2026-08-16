import { useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Group, Matrix4 } from 'three'
import { useFrame } from '@react-three/fiber'
import {
  altitudeCircle,
  azimuthCircle,
  declinationCircle,
  eclipticCircle,
  equatorialToSceneMatrix,
  mergeSegments,
  rightAscensionCircle,
  toSegments,
} from './sceneMath'
import type { GeoLocation } from '@/astro/types'

function segmentGeometry(parts: Float32Array[]) {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(mergeSegments(parts.map(toSegments)), 3))
  return geo
}

/** Grille horizontale : almucantarats tous les 15°, verticaux tous les 30°. */
export function HorizonGrid({ color, opacity = 1 }: { color: string; opacity?: number }) {
  const geometry = useMemo(() => {
    const parts: Float32Array[] = []
    for (let alt = -75; alt <= 75; alt += 15) parts.push(altitudeCircle(alt))
    for (let az = 0; az < 360; az += 30) parts.push(azimuthCircle(az))
    return segmentGeometry(parts)
  }, [])

  return (
    <lineSegments geometry={geometry} frustumCulled={false} renderOrder={2}>
      <lineBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
    </lineSegments>
  )
}

/** Applique la rotation equatorial → scene au groupe, image par image. */
function useEquatorialFrame(date: Date, location: GeoLocation) {
  const ref = useRef<Group>(null)
  const matrix = useRef(new Matrix4())
  useFrame(() => {
    const g = ref.current
    if (!g) return
    equatorialToSceneMatrix(date, location, matrix.current)
    g.matrix.copy(matrix.current)
    g.matrixAutoUpdate = false
    g.matrixWorldNeedsUpdate = true
  })
  return ref
}

/** Grille equatoriale : paralleles de declinaison et meridiens d'ascension droite. */
export function EquatorialGrid({
  date,
  location,
  color,
  equatorColor,
  opacity = 1,
}: {
  date: Date
  location: GeoLocation
  color: string
  equatorColor: string
  opacity?: number
}) {
  const ref = useEquatorialFrame(date, location)

  const { grid, equator } = useMemo(
    () => ({
      grid: segmentGeometry([
        ...[-75, -60, -45, -30, -15, 15, 30, 45, 60, 75].map((d) => declinationCircle(d)),
        ...[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((r) => rightAscensionCircle(r)),
      ]),
      equator: segmentGeometry([declinationCircle(0, 256)]),
    }),
    [],
  )

  return (
    <group ref={ref} renderOrder={2}>
      <lineSegments geometry={grid} frustumCulled={false}>
        <lineBasicMaterial color={color} transparent opacity={opacity * 0.6} depthWrite={false} />
      </lineSegments>
      <lineSegments geometry={equator} frustumCulled={false}>
        <lineBasicMaterial color={equatorColor} transparent opacity={opacity} depthWrite={false} />
      </lineSegments>
    </group>
  )
}

/** Ecliptique : la route suivie par le Soleil et, a peu pres, par les planetes. */
export function EclipticLine({
  date,
  location,
  color,
  opacity = 1,
}: {
  date: Date
  location: GeoLocation
  color: string
  opacity?: number
}) {
  const ref = useEquatorialFrame(date, location)
  const year = date.getUTCFullYear()
  const geometry = useMemo(() => segmentGeometry([eclipticCircle(new Date(Date.UTC(year, 6, 1)), 256)]), [year])

  return (
    <group ref={ref} renderOrder={2}>
      <lineSegments geometry={geometry} frustumCulled={false}>
        <lineBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
      </lineSegments>
    </group>
  )
}

/** Ligne d'horizon marquee : reference visuelle permanente. */
export function HorizonLine({ color }: { color: string }) {
  const geometry = useMemo(() => segmentGeometry([altitudeCircle(0, 256)]), [])
  return (
    <lineSegments geometry={geometry} frustumCulled={false} renderOrder={3}>
      <lineBasicMaterial color={color} transparent opacity={0.85} depthWrite={false} />
    </lineSegments>
  )
}
