import { useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Color, LineSegments, Matrix4, ShaderMaterial } from 'three'
import { useFrame } from '@react-three/fiber'
import { buildConstellationGeometry } from '@/astro/catalog'
import { toRadiance } from './display/tonemap'
import { REFRACTION_LUT_GLSL } from '@/atmosphere/refraction/refractionTable'
import { applyRefractionUniforms, refractionUniforms } from './refractionTexture'
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

  /**
   * Materiau propre, la ou un `lineBasicMaterial` suffisait.
   *
   * La refraction n'est pas une transformation lineaire : aucune matrice ne peut
   * la porter. Les figures doivent donc etre redressees **sommet par sommet**,
   * comme les etoiles qu'elles relient — sans quoi une constellation basse se
   * decrocherait de ses propres etoiles d'un demi-degre.
   */
  const material = useMemo(
    () =>
      new ShaderMaterial({
        name: 'ConstellationLinesMaterial',
        uniforms: {
          ...refractionUniforms(),
          uColor: { value: new Color(1, 1, 1) },
          uOpacity: { value: 0.55 },
        },
        vertexShader: /* glsl */ `
          ${REFRACTION_LUT_GLSL}
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            world.xyz = refractSceneDirection(world.xyz);
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uOpacity;
          void main() {
            gl_FragColor = vec4(uColor, uOpacity);
          }
        `,
        transparent: true,
        depthWrite: false,
      }),
    [],
  )
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

    ;(material.uniforms.uColor.value as Color).copy(radiance)
    material.uniforms.uOpacity.value = 0.55 * Math.min(1, darkness * 2)
    applyRefractionUniforms(material.uniforms as Parameters<typeof applyRefractionUniforms>[0])
  })

  return (
    <lineSegments ref={ref} geometry={geometry} material={material} frustumCulled={false} renderOrder={0} />
  )
}
