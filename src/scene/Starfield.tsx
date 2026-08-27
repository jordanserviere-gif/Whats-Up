import { useMemo, useRef } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Matrix4, Points, ShaderMaterial } from 'three'
import { useFrame } from '@react-three/fiber'
import { buildStarGeometry } from '@/astro/catalog'
import {
  EXTINCTION_COEFFICIENT,
  POINT_BASE_SIZE_PX,
  POINT_BRIGHTNESS_SCALE,
  POINT_VISIBILITY_FADE_END,
  POINT_VISIBILITY_FADE_START,
} from '@/astro/photometry'
import { DISPLAY_TONEMAP_GLSL } from './display/tonemap'
import { REFRACTION_LUT_GLSL } from '@/atmosphere/refraction/refractionTable'
import { applyRefractionUniforms, refractionUniforms } from './refractionTexture'
import { equatorialToSceneMatrix, SKY_RADIUS } from './sceneMath'
import type { GeoLocation } from '@/astro/types'

/**
 * Champ d'etoiles.
 *
 * Les positions sont figees dans le repere equatorial ; la rotation diurne
 * passe par la matrice du groupe. Taille et eclat, eux, sont calcules dans le
 * nuanceur a partir de la magnitude reelle, de la magnitude limite du moment
 * et de l'extinction atmospherique : les etoiles s'eteignent au lever du jour
 * et reapparaissent pendant une eclipse totale, sans traitement particulier.
 */
export function Starfield({
  date,
  location,
  magnitudeLimit,
  /** Magnitude la plus faible perceptible, issue du bilan lumineux du ciel. */
  limitingMagnitude,
  /** Trouble atmospherique -- meme reglage que le voile du ciel, voir `atmosphere.ts`. */
  aerosolTurbidity = 1,
}: {
  date: Date
  location: GeoLocation
  magnitudeLimit: number
  limitingMagnitude: number
  aerosolTurbidity?: number
}) {
  const pointsRef = useRef<Points>(null)
  const matrix = useRef(new Matrix4())

  const geometry = useMemo(() => {
    const data = buildStarGeometry(date, magnitudeLimit)
    const geo = new BufferGeometry()
    const scaled = new Float32Array(data.positions.length)
    for (let i = 0; i < data.positions.length; i++) scaled[i] = data.positions[i] * SKY_RADIUS
    geo.setAttribute('position', new BufferAttribute(scaled, 3))
    geo.setAttribute('starColor', new BufferAttribute(data.colors, 3))
    geo.setAttribute('starMag', new BufferAttribute(data.magnitudes, 1))
    geo.computeBoundingSphere()
    return geo
    // La precession est imperceptible a l'echelle d'une session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date.getUTCFullYear(), magnitudeLimit])

  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
        uniforms: {
          ...refractionUniforms(),
          uLimitMag: { value: limitingMagnitude },
          uPixelRatio: { value: Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio) },
          uBaseSize: { value: POINT_BASE_SIZE_PX },
          uExtinctionK: { value: EXTINCTION_COEFFICIENT },
        },
        vertexShader: /* glsl */ `
          ${REFRACTION_LUT_GLSL}
          attribute vec3 starColor;
          attribute float starMag;
          varying vec3 vColor;
          varying float vIntensity;
          uniform float uLimitMag;
          uniform float uPixelRatio;
          uniform float uBaseSize;
          uniform float uExtinctionK;

          // Masse d'air traversee (Pickering 2002), valable jusqu'a l'horizon.
          // La hauteur est bornee a zero : en dessous, la formule diverge puis
          // devient negative, et l'extinction se mettrait a amplifier l'eclat.
          float airmass(float altDeg) {
            float h = max(altDeg, 0.0);
            float rad = 0.017453292519943295;
            float am = 1.0 / sin((h + 244.0 / (165.0 + 47.0 * pow(h + 0.001, 1.1))) * rad);
            return clamp(am, 1.0, 40.0);
          }

          void main() {
            // La direction equatorielle tournee, **puis** redressee par la
            // refraction — la meme table que les corps du systeme solaire et les
            // constellations. Sans cela une planete se detacherait de son champ
            // d'etoiles de plus d'un diametre lunaire pres de l'horizon.
            vec4 world = modelMatrix * vec4(position, 1.0);
            world.xyz = refractSceneDirection(world.xyz);
            vec3 dir = normalize(world.xyz);
            float altDeg = degrees(asin(clamp(dir.y, -1.0, 1.0)));

            float x = min(airmass(altDeg), 12.0);
            float extinction = uExtinctionK * x;

            // Ecart a la magnitude limite, et rapport de flux correspondant :
            // 1 exactement a la limite.
            float delta = starMag + extinction - uLimitMag;
            float rel = pow(10.0, -0.4 * delta);
            float lg = log(1.0 + rel);

            // Meme courbe que pointIntensity() — voir photometry.ts. Le
            // logarithme porte la dynamique, le seuil eteint franchement ce qui
            // passe sous la limite. Les constantes viennent de la, pas d'ici.
            float gate = 1.0 - smoothstep(${POINT_VISIBILITY_FADE_START.toFixed(1)}, ${POINT_VISIBILITY_FADE_END.toFixed(1)}, delta);
            vIntensity = clamp(${POINT_BRIGHTNESS_SCALE} * lg * gate, 0.0, 1.0);
            // Rougissement par l'extinction, normalise sur le rouge.
            float xr = max(0.0, x - 1.0);
            vColor = starColor * vec3(1.0, exp(-0.035 * xr), exp(-0.085 * xr));

            gl_Position = projectionMatrix * viewMatrix * world;
            // Plafond de securite : une etoile reste une source ponctuelle, et
            // une taille aberrante deviendrait un carre plein a l'ecran.
            gl_PointSize = clamp(uBaseSize * (0.7 + 0.55 * lg) * uPixelRatio, 0.0, 64.0);
          }
        `,
        fragmentShader: /* glsl */ `
          ${DISPLAY_TONEMAP_GLSL}
          varying vec3 vColor;
          varying float vIntensity;
          void main() {
            if (vIntensity < 0.004) discard;
            // Profil gaussien : coeur net, halo doux — une etoile n'a pas de bord.
            vec2 d = gl_PointCoord - vec2(0.5);
            float r = length(d) * 2.0;
            float core = exp(-r * r * 6.0);
            float halo = exp(-r * r * 1.6) * 0.35;
            float alpha = (core + halo) * vIntensity;
            if (alpha < 0.004) discard;
            gl_FragColor = vec4(radianceFromDisplay(vColor), alpha);
          }
        `,
      }),
    // La magnitude limite passe par un uniform, mis a jour a chaque image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useFrame(() => {
    const p = pointsRef.current
    if (!p) return
    equatorialToSceneMatrix(date, location, matrix.current)
    p.matrix.copy(matrix.current)
    p.matrixAutoUpdate = false
    p.matrixWorldNeedsUpdate = true
    material.uniforms.uLimitMag.value = limitingMagnitude
    // Un ciel plus charge en aerosols eteint aussi davantage les etoiles, par
    // le meme phenomene qui blanchit l'horizon -- meme trouble que la
    // diffusion Mie du fond de ciel, voir `atmosphere/mie/aerosol.ts`.
    material.uniforms.uExtinctionK.value = EXTINCTION_COEFFICIENT * aerosolTurbidity
    // La meme table que les corps du systeme solaire et les constellations.
    applyRefractionUniforms(material.uniforms as Parameters<typeof applyRefractionUniforms>[0])
  })

  return <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} renderOrder={4} />
}
