import { useMemo } from 'react'
import { BackSide, ShaderMaterial, UniformsUtils, Vector3, type IUniform } from 'three'
import { Sky as ThreeSky } from 'three/examples/jsm/objects/Sky.js'
import { useFrame } from '@react-three/fiber'
import { DOME_RADIUS } from './sceneMath'

/** `Sky.SkyShader` est declare `object` dans les typages de three : on le precise. */
interface SkyShaderDefinition {
  uniforms: Record<string, IUniform>
  vertexShader: string
  fragmentShader: string
}

/**
 * Atmosphere diurne.
 *
 * On reprend le modele de Preetham livre avec three.js (`objects/Sky.js`) :
 * diffusion de Rayleigh pour le bleu du zenith, diffusion de Mie pour le halo
 * autour du Soleil et le blanchiment vers l'horizon. Plutot que de le
 * reimplementer, on clone son shader et on y greffe deux entrees.
 *
 * `uOpacity` fond l'atmosphere dans le ciel nocturne au fil du crepuscule ;
 * `uExposure` module la luminance globale, ce qui permet a une eclipse
 * d'assombrir le ciel sans toucher a la physique de la diffusion.
 *
 * Le disque solaire integre au modele est retire : la scene rend son propre
 * Soleil, a sa distance, faute de quoi la Lune ne pourrait pas l'occulter.
 */
function buildAtmosphereMaterial(): ShaderMaterial {
  const shader = ThreeSky.SkyShader as unknown as SkyShaderDefinition

  const fragmentShader = shader.fragmentShader
    // Reglages et courbe de rendu ajoutes au modele d'origine.
    .replace(
      'varying vec3 vWorldPosition;',
      `varying vec3 vWorldPosition;
      uniform float uOpacity;
      uniform float uExposure;

      // Approximation filmique ACES (Narkowicz 2015).
      //
      // Le modele de Preetham produit des luminances physiques, bien au-dela de
      // 1 : l'exemple three.js s'appuie sur le tone mapping du rendu pour les
      // ramener a l'ecran. Comme la scene n'en applique aucun — les autres
      // couleurs viennent des tokens et doivent rester fideles — on mappe ici,
      // et seulement ici. Sans cette courbe, le ciel sature uniformement au blanc.
      vec3 acesFilmic(vec3 x) {
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
      }`,
    )
    // Le disque solaire du modele ferait doublon avec le Soleil de la scene,
    // et surtout il ne serait jamais occulte par la Lune.
    .replace('L0 += ( vSunE * 19000.0 * Fex ) * sundisk;', '// disque solaire rendu separement')
    .replace(
      'gl_FragColor = vec4( retColor, 1.0 );',
      'gl_FragColor = vec4( acesFilmic( retColor * uExposure ), uOpacity );',
    )

  return new ShaderMaterial({
    name: 'AtmosphereMaterial',
    uniforms: {
      ...UniformsUtils.clone(shader.uniforms),
      uOpacity: { value: 0 },
      uExposure: { value: 1 },
    },
    vertexShader: shader.vertexShader,
    fragmentShader,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  })
}

export function Atmosphere({
  sunAltitude,
  sunAzimuth,
  /** Eclairement solaire au sol, occultation comprise. */
  solarLux,
  /** Fraction du disque solaire masquee : creuse la luminance pendant une eclipse. */
  obscuration,
  /** Trouble atmospherique : 2 = air tres pur, 8 = brume urbaine. */
  turbidity = 2.6,
  rayleigh = 2,
}: {
  sunAltitude: number
  sunAzimuth: number
  solarLux: number
  obscuration: number
  turbidity?: number
  rayleigh?: number
}) {
  const material = useMemo(buildAtmosphereMaterial, [])

  useFrame(() => {
    const u = material.uniforms
    const alt = (sunAltitude * Math.PI) / 180
    const az = (sunAzimuth * Math.PI) / 180
    // Repere de la scene : +X est, +Y zenith, −Z nord.
    ;(u.sunPosition.value as Vector3).set(
      Math.cos(alt) * Math.sin(az),
      Math.sin(alt),
      -Math.cos(alt) * Math.cos(az),
    )
    u.turbidity.value = turbidity
    u.rayleigh.value = rayleigh
    u.mieCoefficient.value = 0.005
    u.mieDirectionalG.value = 0.8

    // Fondu geometrique : l'atmosphere s'eteint au crepuscule nautique. On se
    // fonde sur l'eclairement qu'aurait un Soleil non occulte, pour que le
    // fondu suive la course du Soleil et non l'eclipse.
    const geometricLux = solarLux / Math.max(1e-6, 1 - obscuration + 8e-4 * obscuration)
    u.uOpacity.value = Math.min(1, Math.max(0, (Math.log10(Math.max(1e-6, geometricLux)) + 2) / 4))

    // Exposition, appliquee avant la courbe filmique. La valeur de base reprend
    // celle de l'exemple three.js ; l'eclipse la creuse. L'exposant adoucit la
    // chute, sans quoi la totalite virerait au noir plutot qu'au crepuscule.
    u.uExposure.value = 0.5 * Math.pow(1 - obscuration + 8e-4 * obscuration, 0.5)
  })

  return (
    <mesh material={material} frustumCulled={false} renderOrder={-99}>
      <sphereGeometry args={[DOME_RADIUS * 0.98, 48, 32]} />
    </mesh>
  )
}
