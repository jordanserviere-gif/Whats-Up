import { useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Color, LineSegments, Matrix4 } from 'three'
import { useFrame } from '@react-three/fiber'
import { buildConstellationGeometry } from '@/astro/catalog'
import { toRadiance } from './display/tonemap'
import { equatorialToSceneMatrix, SKY_RADIUS } from './sceneMath'
import type { GeoLocation } from '@/astro/types'

/** Figures des 88 constellations, dessinees dans le repere equatorial. */
export function ConstellationLines({
  date,
  location,
  color,
  darkness,
}: {
  date: Date
  location: GeoLocation
  color: string
  darkness: number
}) {
  const ref = useRef<LineSegments>(null)
  const matrix = useRef(new Matrix4())
  // Passer un objet `Color` plutot qu'une chaine : `Material.color.set()` le
  // copie tel quel, sans reconversion d'espace, ce qui preserve la radiance.
  const radiance = useMemo(() => toRadiance(new Color(color)), [color])

  const geometry = useMemo(() => {
    const { positions } = buildConstellationGeometry(date)
    const scaled = new Float32Array(positions.length)
    // Legerement en retrait des etoiles pour eviter le z-fighting visuel.
    for (let i = 0; i < positions.length; i++) scaled[i] = positions[i] * SKY_RADIUS * 0.995
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(scaled, 3))
    return geo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date.getUTCFullYear()])

  useFrame(() => {
    const l = ref.current
    if (!l) return
    equatorialToSceneMatrix(date, location, matrix.current)
    l.matrix.copy(matrix.current)
    l.matrixAutoUpdate = false
    l.matrixWorldNeedsUpdate = true
  })

  return (
    <lineSegments ref={ref} geometry={geometry} frustumCulled={false} renderOrder={0}>
      <lineBasicMaterial color={radiance} transparent opacity={0.55 * Math.min(1, darkness * 2)} depthWrite={false} />
    </lineSegments>
  )
}
