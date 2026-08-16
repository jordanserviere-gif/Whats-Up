import { useMemo } from 'react'
import { BackSide, Color, ShaderMaterial } from 'three'
import { useFrame } from '@react-three/fiber'
import { GROUND_RADIUS } from './sceneMath'

/**
 * Sol.
 *
 * Une calotte opaque sous l'horizon, et non un plan : l'observateur etant a
 * hauteur zero, un disque coplanaire ne projetterait qu'une ligne et
 * n'occulterait rien. Son rayon la place entre les corps du systeme solaire et
 * les etoiles, si bien que le tampon de profondeur masque tout ce qui est
 * couche — planetes, satellites, etoiles et grilles comprises — sans qu'aucun
 * calque n'ait a le savoir.
 */
export function Ground({
  color,
  glowColor,
  illuminance,
}: {
  color: string
  glowColor: string
  illuminance: number
}) {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        side: BackSide,
        uniforms: {
          uGround: { value: new Color('#06080d') },
          uGlow: { value: new Color('#0b1120') },
          uBrightness: { value: 0.2 },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            vDir = normalize(world.xyz);
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 vDir;
          uniform vec3 uGround;
          uniform vec3 uGlow;
          uniform float uBrightness;
          void main() {
            // Juste sous l'horizon, le sol capte la lueur du ciel ; plus bas,
            // il s'assombrit franchement.
            float depth = clamp(-vDir.y, 0.0, 1.0);
            vec3 col = mix(uGlow, uGround, smoothstep(0.0, 0.18, depth)) * uBrightness;
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    [],
  )

  useFrame(() => {
    ;(material.uniforms.uGround.value as Color).set(color)
    ;(material.uniforms.uGlow.value as Color).set(glowColor)
    // Le sol s'eclaire avec le jour, sans jamais devenir noir absolu la nuit.
    const t = Math.min(1, Math.max(0, (Math.log10(Math.max(1e-4, illuminance)) + 3) / 8))
    material.uniforms.uBrightness.value = 0.14 + 2.4 * t * t
  })

  return (
    <mesh material={material} renderOrder={6} frustumCulled={false}>
      {/* Hemisphere inferieur : thetaStart a l'equateur, ouverture d'un quart de tour. */}
      <sphereGeometry args={[GROUND_RADIUS, 96, 32, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]} />
    </mesh>
  )
}
