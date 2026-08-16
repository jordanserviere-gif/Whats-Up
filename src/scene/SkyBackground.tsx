import { useMemo } from 'react'
import { BackSide, Color, ShaderMaterial, UniformsUtils, Vector3, type IUniform } from 'three'
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
 * Fond de ciel — ciel nocturne et atmosphere diurne en **une seule passe opaque**.
 *
 * Les deux etaient auparavant deux maillages distincts, dont l'atmosphere en
 * `transparent: true`. Or three.js dessine tous les objets opaques avant tous
 * les transparents, quel que soit leur `renderOrder` : l'atmosphere repassait
 * donc par-dessus le disque solaire, pourtant bien plus proche. On ne voyait
 * plus du Soleil que son halo additif, dessine apres — d'ou un disque plus
 * sombre que sa propre couronne. Fusionner les deux supprime la classe entiere
 * de ces bugs d'ordre.
 *
 * La diffusion atmospherique reprend le modele de Preetham livre avec three.js
 * (`objects/Sky.js`) : Rayleigh pour le bleu du zenith, Mie pour le halo
 * solaire et le blanchiment vers l'horizon. Son disque solaire est retire — la
 * scene rend le sien, a sa distance, faute de quoi la Lune ne pourrait pas
 * l'occulter.
 */
function buildSkyMaterial(): ShaderMaterial {
  const shader = ThreeSky.SkyShader as unknown as SkyShaderDefinition

  const fragmentShader = shader.fragmentShader
    .replace(
      'varying vec3 vWorldPosition;',
      `varying vec3 vWorldPosition;

      uniform float uAtmosphere;
      uniform float uExposure;
      uniform float uSaturation;
      uniform vec3 uMoonDir;
      uniform float uMoonFactor;
      uniform float uTwilightFactor;
      uniform vec3 uNight;
      uniform vec3 uMoonGlow;
      uniform vec3 uTwilight;

      // Approximation filmique ACES (Narkowicz 2015).
      //
      // Le modele de Preetham produit des luminances physiques, bien au-dela de
      // 1 : l'exemple three.js s'appuie sur le tone mapping du rendu pour les
      // ramener a l'ecran. La scene n'en applique aucun — les autres couleurs
      // viennent des tokens et doivent rester fideles — on mappe donc ici, et
      // seulement ici. Sans cette courbe, le ciel sature uniformement au blanc.
      vec3 acesFilmic(vec3 x) {
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
      }

      // La courbe filmique desature fortement les hautes lumieres : un ciel de
      // midi en ressort laiteux. On lui rend sa couleur en reecartant les
      // canaux autour de leur luminance, ce qui restitue un bleu franc sans
      // avoir a rabaisser l'exposition — donc sans assombrir la scene.
      vec3 resaturate(vec3 c, float amount) {
        float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
        return clamp(mix(vec3(luma), c, amount), 0.0, 1.0);
      }`,
    )
    // Le disque solaire du modele ferait doublon avec le Soleil de la scene,
    // et surtout il ne serait jamais occulte par la Lune.
    .replace('L0 += ( vSunE * 19000.0 * Fex ) * sundisk;', '// disque solaire rendu separement')
    .replace(
      'gl_FragColor = vec4( retColor, 1.0 );',
      `
      // --- Socle nocturne : presque noir, a peine plus clair vers l'horizon ---
      float h = clamp( direction.y, -1.0, 1.0 );
      vec3 night = mix( uNight * 1.6, uNight, smoothstep( 0.0, 0.45, h ) );

      // Diffusion autour de la Lune levee : elle aussi eclaire l'atmosphere.
      float toMoon = max( 0.0, dot( direction, normalize( uMoonDir ) ) );
      night += uMoonGlow * uMoonFactor * ( 0.25 + 0.75 * pow( toMoon, 6.0 ) );

      // --- Lueur crepusculaire basse, centree sur l'azimut solaire ---
      // Elle prend le relais sous l'horizon, la ou le modele de Preetham s'eteint.
      vec3 horizontalDir = vec3( direction.x, 0.0, direction.z );
      vec3 horizontalSun = vec3( vSunDirection.x, 0.0, vSunDirection.z );
      float towardSun = length( horizontalDir ) < 1e-4 || length( horizontalSun ) < 1e-4
        ? 0.0
        : max( 0.0, dot( normalize( horizontalDir ), normalize( horizontalSun ) ) );
      float low = exp( -pow( max( 0.0, h ) / 0.3, 2.0 ) );
      vec3 dusk = uTwilight * uTwilightFactor * low * pow( towardSun, 2.2 );

      // --- Composition additive ---
      // Le fond de ciel est toujours present ; la lumiere solaire diffusee s'y
      // ajoute. Pendant une eclipse totale, uExposure s'effondre et l'on
      // retombe naturellement sur le ciel nocturne, sans traitement dedie.
      vec3 scattered = resaturate( acesFilmic( retColor * uExposure ), uSaturation ) * uAtmosphere;
      gl_FragColor = vec4( night + scattered + dusk, 1.0 );
      `,
    )

  return new ShaderMaterial({
    name: 'SkyBackgroundMaterial',
    uniforms: {
      ...UniformsUtils.clone(shader.uniforms),
      uAtmosphere: { value: 0 },
      uExposure: { value: 0.3 },
      uSaturation: { value: 1.4 },
      uMoonDir: { value: new Vector3(0, -1, 0) },
      uMoonFactor: { value: 0 },
      uTwilightFactor: { value: 0 },
      uNight: { value: new Color('#03040a') },
      uMoonGlow: { value: new Color('#7d8fc4') },
      uTwilight: { value: new Color('#ff9d5c') },
    },
    vertexShader: shader.vertexShader,
    fragmentShader,
    side: BackSide,
    // Opaque et sans test de profondeur : c'est le fond, il est peint en premier
    // et tout le reste se dessine dessus.
    transparent: false,
    depthWrite: false,
    depthTest: false,
  })
}

export interface SkyBackgroundProps {
  /** Part de l'eclairement due au Soleil, occultation comprise. */
  solarLux: number
  /** Fraction du disque solaire masquee : creuse la luminance pendant une eclipse. */
  obscuration: number
  sunAltitude: number
  sunAzimuth: number
  moonAltitude: number
  moonAzimuth: number
  lunarLux: number
  nightColor: string
  twilightColor: string
  moonGlowColor: string
  /** Trouble atmospherique : 2 = air tres pur, 10 = brume urbaine. */
  turbidity?: number
  rayleigh?: number
  /**
   * Exposition appliquee avant la courbe filmique. C'est le reglage qui decide
   * de la surexposition : au-dela de 0,2 le ciel de midi part vers le blanc.
   */
  exposure?: number
  /** Correction de la desaturation induite par la courbe filmique. */
  saturation?: number
}

export function SkyBackground({
  solarLux,
  obscuration,
  sunAltitude,
  sunAzimuth,
  moonAltitude,
  moonAzimuth,
  lunarLux,
  nightColor,
  twilightColor,
  moonGlowColor,
  turbidity = 2,
  rayleigh = 3,
  exposure = 0.14,
  saturation = 1.45,
}: SkyBackgroundProps) {
  const material = useMemo(buildSkyMaterial, [])

  useFrame(() => {
    const u = material.uniforms

    // Repere de la scene : +X est, +Y zenith, −Z nord.
    const alt = (sunAltitude * Math.PI) / 180
    const az = (sunAzimuth * Math.PI) / 180
    ;(u.sunPosition.value as Vector3).set(
      Math.cos(alt) * Math.sin(az),
      Math.sin(alt),
      -Math.cos(alt) * Math.cos(az),
    )

    const malt = (moonAltitude * Math.PI) / 180
    const maz = (moonAzimuth * Math.PI) / 180
    ;(u.uMoonDir.value as Vector3).set(
      Math.cos(malt) * Math.sin(maz),
      Math.sin(malt),
      -Math.cos(malt) * Math.cos(maz),
    )

    u.turbidity.value = turbidity
    u.rayleigh.value = rayleigh
    u.mieCoefficient.value = 0.005
    u.mieDirectionalG.value = 0.8

    // Fondu geometrique : l'atmosphere s'eteint au crepuscule nautique. On se
    // fonde sur l'eclairement qu'aurait un Soleil non occulte, pour que le
    // fondu suive la course du Soleil et non l'eclipse.
    const geometricLux = solarLux / Math.max(1e-6, 1 - obscuration + 8e-4 * obscuration)
    u.uAtmosphere.value = Math.min(1, Math.max(0, (Math.log10(Math.max(1e-6, geometricLux)) + 2) / 4))

    // Exposition : c'est ici que l'eclipse agit. L'exposant adoucit la chute,
    // sans quoi la totalite virerait au noir plutot qu'au crepuscule.
    u.uExposure.value = exposure * Math.pow(1 - obscuration + 8e-4 * obscuration, 0.5)
    u.uSaturation.value = saturation

    // Le crepuscule culmine autour de 25 lux, entre chien et loup.
    const logSolar = Math.log10(Math.max(1e-6, solarLux))
    u.uTwilightFactor.value = 0.55 * Math.exp(-Math.pow((logSolar - 1.4) / 1.5, 2))
    u.uMoonFactor.value = moonAltitude > 0 ? Math.min(0.5, Math.max(0, lunarLux * 0.55)) : 0

    ;(u.uNight.value as Color).set(nightColor)
    ;(u.uTwilight.value as Color).set(twilightColor)
    ;(u.uMoonGlow.value as Color).set(moonGlowColor)
  })

  return (
    <mesh material={material} frustumCulled={false} renderOrder={-1000}>
      <sphereGeometry args={[DOME_RADIUS, 64, 40]} />
    </mesh>
  )
}
