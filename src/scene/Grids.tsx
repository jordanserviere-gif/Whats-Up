import { useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, Matrix4 } from 'three'
import { useFrame } from '@react-three/fiber'
import {
  altitudeCircle,
  declinationCircle,
  eclipticCircle,
  equatorialToSceneMatrix,
  hourCircle,
  verticalCircle,
} from './sceneMath'
import type { GeoLocation } from '@/astro/types'

function circleGeometry(points: Float32Array) {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(points, 3))
  return geo
}

/** Materiau de trait, partage par tous les cercles d'une meme grille. */
function useLineMaterial(color: string, opacity: number) {
  const material = useMemo(() => new LineBasicMaterial({ transparent: true, depthWrite: false }), [])
  material.color.set(color)
  material.opacity = opacity
  return material
}

/** Rend une famille de cercles fermes sous un meme materiau. */
function Circles({ geometries, material }: { geometries: BufferGeometry[]; material: LineBasicMaterial }) {
  return (
    <>
      {geometries.map((geometry, i) => (
        <lineLoop key={i} geometry={geometry} material={material} frustumCulled={false} />
      ))}
    </>
  )
}

/** Grille horizontale : almucantarats tous les 15°, verticaux tous les 30°. */
export function HorizonGrid({ color, opacity = 1 }: { color: string; opacity?: number }) {
  const geometries = useMemo(() => {
    const out: BufferGeometry[] = []
    for (let alt = -75; alt <= 75; alt += 15) out.push(circleGeometry(altitudeCircle(alt)))
    // Un vertical couvre son azimut et l'oppose : six suffisent pour douze traces.
    for (let az = 0; az < 180; az += 30) out.push(circleGeometry(verticalCircle(az)))
    return out
  }, [])
  const material = useLineMaterial(color, opacity)

  return (
    <group renderOrder={2}>
      <Circles geometries={geometries} material={material} />
    </group>
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
      grid: [
        ...[-75, -60, -45, -30, -15, 15, 30, 45, 60, 75].map((d) => circleGeometry(declinationCircle(d))),
        // Comme les verticaux, un cercle horaire couvre l'ascension droite
        // demandee et son oppose.
        ...[0, 30, 60, 90, 120, 150].map((r) => circleGeometry(hourCircle(r))),
      ],
      equator: circleGeometry(declinationCircle(0, 256)),
    }),
    [],
  )
  const gridMaterial = useLineMaterial(color, opacity * 0.6)
  const equatorMaterial = useLineMaterial(equatorColor, opacity)

  return (
    <group ref={ref} renderOrder={2}>
      <Circles geometries={grid} material={gridMaterial} />
      <lineLoop geometry={equator} material={equatorMaterial} frustumCulled={false} />
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
  const geometry = useMemo(() => circleGeometry(eclipticCircle(new Date(Date.UTC(year, 6, 1)))), [year])
  const material = useLineMaterial(color, opacity)

  return (
    <group ref={ref} renderOrder={2}>
      <lineLoop geometry={geometry} material={material} frustumCulled={false} />
    </group>
  )
}

/** Ligne d'horizon marquee : reference visuelle permanente. */
export function HorizonLine({ color }: { color: string }) {
  const geometry = useMemo(() => circleGeometry(altitudeCircle(0, 256)), [])
  const material = useLineMaterial(color, 0.85)
  return <lineLoop geometry={geometry} material={material} frustumCulled={false} renderOrder={3} />
}
