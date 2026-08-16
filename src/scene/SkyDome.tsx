import { useMemo, useRef } from 'react'
import { BackSide, Color, Mesh, ShaderMaterial } from 'three'
import { useFrame } from '@react-three/fiber'
import { DOME_RADIUS, GROUND_RADIUS } from './sceneMath'

/**
 * Fond de ciel.
 *
 * Le degrade n'est pas une decoration : sa luminance suit l'eclairement reel du
 * ciel. En pleine nuit il s'efface presque completement — c'est ce qui evite au
 * decor de se lire comme une voute peinte — et il ne reprend de la matiere qu'a
 * mesure que le Soleil remonte, ou qu'une Lune haute rehausse le fond.
 */
export function SkyDome({
  /** Eclairement horizontal total, en lux. */
  illuminance,
  /** Part de l'eclairement due au Soleil : elle seule colore le ciel en bleu. */
  solarLux,
  sunAltitude,
  sunAzimuth,
  nightColor,
  dayColor,
  horizonColor,
  twilightColor,
  moonGlowColor,
  moonAltitude,
  moonAzimuth,
  lunarLux,
}: {
  illuminance: number
  solarLux: number
  sunAltitude: number
  sunAzimuth: number
  nightColor: string
  dayColor: string
  horizonColor: string
  twilightColor: string
  moonGlowColor: string
  moonAltitude: number
  moonAzimuth: number
  lunarLux: number
}) {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        depthTest: false,
        uniforms: {
          uSunDir: { value: [0, 0, -1] },
          uMoonDir: { value: [0, 0, -1] },
          uSunAltitude: { value: 0 },
          uMoonAltitude: { value: 0 },
          uDayFactor: { value: 0 },
          uTwilightFactor: { value: 0 },
          uMoonFactor: { value: 0 },
          uNight: { value: new Color('#04050b') },
          uDay: { value: new Color('#7ec8ff') },
          uHorizon: { value: new Color('#0d1220') },
          uTwilight: { value: new Color('#ff9d5c') },
          uMoonGlow: { value: new Color('#8fa8d8') },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 vDir;
          uniform vec3 uSunDir;
          uniform vec3 uMoonDir;
          uniform float uSunAltitude;
          uniform float uMoonAltitude;
          uniform float uDayFactor;
          uniform float uTwilightFactor;
          uniform float uMoonFactor;
          uniform vec3 uNight;
          uniform vec3 uDay;
          uniform vec3 uHorizon;
          uniform vec3 uTwilight;
          uniform vec3 uMoonGlow;

          void main() {
            vec3 dir = normalize(vDir);
            float h = clamp(dir.y, -1.0, 1.0);

            // Socle nocturne : quasi noir, a peine plus clair vers l'horizon.
            vec3 col = mix(uNight * 1.6, uNight, smoothstep(0.0, 0.45, h));

            // Diffusion diurne : le bleu s'installe et pale vers l'horizon.
            vec3 daySky = mix(uHorizon * 1.4 + uDay * 0.55, uDay, smoothstep(-0.05, 0.8, h));
            col = mix(col, daySky, uDayFactor);

            // Lueur crepusculaire : basse sur l'horizon, centree sur l'azimut solaire.
            float towardSun = max(0.0, dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))));
            float low = exp(-pow(max(0.0, h) / 0.3, 2.0));
            col += uTwilight * uTwilightFactor * low * pow(towardSun, 2.2);

            // Halo lunaire : diffusion autour de la Lune quand elle est levee.
            float toMoon = max(0.0, dot(dir, normalize(uMoonDir)));
            col += uMoonGlow * uMoonFactor * (0.25 + 0.75 * pow(toMoon, 6.0));

            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    [],
  )

  useFrame(() => {
    const u = material.uniforms
    const az = (sunAzimuth * Math.PI) / 180
    u.uSunDir.value = [Math.sin(az), 0, -Math.cos(az)]
    const maz = (moonAzimuth * Math.PI) / 180
    const malt = (moonAltitude * Math.PI) / 180
    u.uMoonDir.value = [Math.cos(malt) * Math.sin(maz), Math.sin(malt), -Math.cos(malt) * Math.cos(maz)]
    u.uSunAltitude.value = sunAltitude
    u.uMoonAltitude.value = moonAltitude

    // Le facteur diurne suit l'eclairement solaire en logarithme : c'est ainsi
    // que la transition jour/nuit se fait au bon rythme, et qu'une eclipse
    // totale plonge le ciel dans une teinte de crepuscule.
    const logSolar = Math.log10(Math.max(1e-6, solarLux))
    u.uDayFactor.value = Math.min(1, Math.max(0, (logSolar - 0.6) / (4.6 - 0.6)))
    // Le crepuscule culmine autour de 3 lux, entre chien et loup.
    u.uTwilightFactor.value = Math.exp(-Math.pow((logSolar - 1.4) / 1.5, 2))
    u.uMoonFactor.value = Math.min(0.5, Math.max(0, lunarLux * 0.55)) * (moonAltitude > 0 ? 1 : 0)

    ;(u.uNight.value as Color).set(nightColor)
    ;(u.uDay.value as Color).set(dayColor)
    ;(u.uHorizon.value as Color).set(horizonColor)
    ;(u.uTwilight.value as Color).set(twilightColor)
    ;(u.uMoonGlow.value as Color).set(moonGlowColor)
    void illuminance
  })

  return (
    <mesh material={material} frustumCulled={false} renderOrder={-100}>
      <sphereGeometry args={[DOME_RADIUS, 48, 32]} />
    </mesh>
  )
}

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
  const mesh = useRef<Mesh>(null)
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
    <mesh ref={mesh} material={material} renderOrder={6} frustumCulled={false}>
      {/* Hemisphere inferieur : thetaStart a l'equateur, ouverture d'un quart de tour. */}
      <sphereGeometry args={[GROUND_RADIUS, 96, 32, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]} />
    </mesh>
  )
}
