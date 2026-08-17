import { useMemo } from 'react'
import { BackSide, Color, ShaderMaterial, Vector3 } from 'three'
import { useFrame } from '@react-three/fiber'
import { DOME_RADIUS } from './sceneMath'
import {
  ATMOSPHERE_GLSL,
  ATMOSPHERE_RADIUS_M,
  MIE_COEFFICIENT,
  MIE_G,
  MIE_SCALE_HEIGHT_M,
  PLANET_RADIUS_M,
  RAYLEIGH_COEFFICIENTS,
  RAYLEIGH_SCALE_HEIGHT_M,
  SUN_INTENSITY_REF,
} from './atmosphere'

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
 * La diffusion vient desormais d'une vraie integrale de diffusion simple
 * (Rayleigh + Mie, voir `atmosphere.ts`), pas d'un modele empirique (Preetham)
 * complete a la main d'un degrade crepusculaire invente. La forme et la
 * couleur du halo solaire — y compris son rougissement bas sur l'horizon —
 * sortent directement de la geometrie Terre-atmosphere-Soleil, ce qui est
 * exactement ce qui manquait a l'ancien rendu.
 *
 * Son disque solaire est retire — la scene rend le sien, a sa distance, faute
 * de quoi la Lune ne pourrait pas l'occulter.
 */
function buildSkyMaterial(): ShaderMaterial {
  const vertexShader = /* glsl */ `
    varying vec3 vDir;
    void main() {
      // La sphere est centree a l'origine, sans echelle : la position locale
      // est deja, une fois normalisee, la direction de visee.
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `

  const fragmentShader = /* glsl */ `
    ${ATMOSPHERE_GLSL}

    varying vec3 vDir;

    uniform vec3 uSunDir;
    uniform float uSunIntensity;
    uniform float uPlanetRadius;
    uniform float uAtmosphereRadius;
    uniform vec3 uRayleighCoeff;
    uniform float uMieCoeff;
    uniform float uRayleighScaleHeight;
    uniform float uMieScaleHeight;
    uniform float uMieG;

    uniform float uExposure;
    uniform float uSaturation;
    uniform vec3 uNight;
    uniform vec3 uMoonDir;
    uniform float uMoonFactor;
    uniform vec3 uMoonGlow;

    // Approximation filmique ACES (Narkowicz 2015).
    //
    // Le modele de diffusion produit des radiances physiques, bien au-dela de
    // 1 : la scene n'applique aucun tone mapping global — les autres couleurs
    // viennent des tokens et doivent rester fideles — on mappe donc ici, et
    // seulement ici.
    vec3 acesFilmic(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }

    // La courbe filmique desature fortement les hautes lumieres : un ciel de
    // midi en ressort laiteux. On lui rend sa couleur en reecartant les
    // canaux autour de leur luminance, sans changer l'exposition.
    vec3 resaturate(vec3 c, float amount) {
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      return clamp(mix(vec3(luma), c, amount), 0.0, 1.0);
    }

    void main() {
      vec3 dir = normalize(vDir);
      // Observateur au sol, dans le repere centre sur la planete qu'attend
      // atmosphere() : seule la hauteur au-dessus du sol local compte, donc
      // poser l'observateur sur l'axe +Y suffit — inutile de reconstituer sa
      // vraie latitude/longitude ECEF pour ce que cette passe calcule.
      vec3 r0 = vec3(0.0, uPlanetRadius, 0.0);

      vec3 raw = atmosphere(
        dir, r0, uSunDir, uSunIntensity,
        uPlanetRadius, uAtmosphereRadius,
        uRayleighCoeff, uMieCoeff, uRayleighScaleHeight, uMieScaleHeight, uMieG
      );

      vec3 scattered = resaturate(acesFilmic(raw * uExposure), uSaturation);

      // --- Socle nocturne : presque noir, a peine plus clair vers l'horizon ---
      // La diffusion simple ne restitue pas l'arche crepusculaire bleue ni la
      // lueur du ciel nocturne (airglow, pollution lumineuse) : ce socle reste
      // necessaire en dessous, pas pour imiter le crepuscule — la geometrie
      // s'en charge desormais — mais pour que les etoiles se detachent d'un
      // fond jamais completement noir.
      float h = clamp(dir.y, -1.0, 1.0);
      vec3 night = mix(uNight * 1.6, uNight, smoothstep(0.0, 0.45, h));

      // Diffusion autour de la Lune levee : elle aussi eclaire l'atmosphere.
      float toMoon = max(0.0, dot(dir, normalize(uMoonDir)));
      night += uMoonGlow * uMoonFactor * (0.25 + 0.75 * pow(toMoon, 6.0));

      gl_FragColor = vec4(night + scattered, 1.0);
    }
  `

  return new ShaderMaterial({
    name: 'SkyBackgroundMaterial',
    uniforms: {
      uSunDir: { value: new Vector3(0, 1, 0) },
      uSunIntensity: { value: SUN_INTENSITY_REF },
      uPlanetRadius: { value: PLANET_RADIUS_M },
      uAtmosphereRadius: { value: ATMOSPHERE_RADIUS_M },
      uRayleighCoeff: { value: new Vector3(...RAYLEIGH_COEFFICIENTS) },
      uMieCoeff: { value: MIE_COEFFICIENT },
      uRayleighScaleHeight: { value: RAYLEIGH_SCALE_HEIGHT_M },
      uMieScaleHeight: { value: MIE_SCALE_HEIGHT_M },
      uMieG: { value: MIE_G },
      uExposure: { value: 0.3 },
      uSaturation: { value: 1.4 },
      uMoonDir: { value: new Vector3(0, -1, 0) },
      uMoonFactor: { value: 0 },
      uNight: { value: new Color('#03040a') },
      uMoonGlow: { value: new Color('#7d8fc4') },
    },
    vertexShader,
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
  /**
   * Calque « atmosphere » actif ? Coupe l'exposition d'affichage sans toucher
   * au modele physique — la diffusion elle-meme decoule deja de l'altitude
   * reelle du Soleil, y compris tres bas sous l'horizon : rien dans la
   * geometrie ne permettrait de distinguer « nuit noire, calque actif » d'
   * « atmosphere desactivee », d'ou ce signal explicite plutot qu'un seuil
   * sur l'eclairement, qui aurait tronque le crepuscule avant l'heure.
   */
  enabled: boolean
  /** Fraction du disque solaire masquee : creuse la luminance pendant une eclipse. */
  obscuration: number
  sunAltitude: number
  sunAzimuth: number
  moonAltitude: number
  moonAzimuth: number
  lunarLux: number
  nightColor: string
  moonGlowColor: string
  /**
   * Trouble atmospherique — multiplie le coefficient de diffusion Mie
   * (aerosols). 1 = air standard. C'est le levier destine a la qualite de
   * l'air et a la nebulosite : plus il monte, plus l'horizon blanchit et le
   * ciel s'eclaircit, comme une vraie brume de pollution.
   */
  aerosolTurbidity?: number
  /**
   * Exposition appliquee avant la courbe filmique. C'est le reglage qui decide
   * de la surexposition : au-dela de 0,4 le ciel de midi part vers le blanc.
   */
  exposure?: number
  /** Correction de la desaturation induite par la courbe filmique. */
  saturation?: number
}

export function SkyBackground({
  enabled,
  obscuration,
  sunAltitude,
  sunAzimuth,
  moonAltitude,
  moonAzimuth,
  lunarLux,
  nightColor,
  moonGlowColor,
  aerosolTurbidity = 1,
  exposure = 0.3,
  saturation = 1.4,
}: SkyBackgroundProps) {
  const material = useMemo(buildSkyMaterial, [])

  useFrame(() => {
    const u = material.uniforms

    // Repere de la scene : +X est, +Y zenith, −Z nord.
    const alt = (sunAltitude * Math.PI) / 180
    const az = (sunAzimuth * Math.PI) / 180
    ;(u.uSunDir.value as Vector3).set(Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az))

    const malt = (moonAltitude * Math.PI) / 180
    const maz = (moonAzimuth * Math.PI) / 180
    ;(u.uMoonDir.value as Vector3).set(
      Math.cos(malt) * Math.sin(maz),
      Math.sin(malt),
      -Math.cos(malt) * Math.cos(maz),
    )

    u.uMieCoeff.value = MIE_COEFFICIENT * aerosolTurbidity
    u.uMieScaleHeight.value = MIE_SCALE_HEIGHT_M * Math.sqrt(aerosolTurbidity)

    // Eclipse : la luminance du Soleil chute avec la part masquee. Le plancher
    // (8e-4) est la lumiere cendree pendant une totale — jamais tout a fait
    // nulle, la couronne et le ciel diffus restant faiblement eclaires.
    const eclipse = Math.pow(1 - obscuration + 8e-4 * obscuration, 0.5)
    u.uExposure.value = exposure * (enabled ? 1 : 0) * eclipse
    u.uSaturation.value = saturation

    u.uMoonFactor.value = moonAltitude > 0 ? Math.min(0.5, Math.max(0, lunarLux * 0.55)) : 0

    ;(u.uNight.value as Color).set(nightColor)
    ;(u.uMoonGlow.value as Color).set(moonGlowColor)
  })

  return (
    <mesh material={material} frustumCulled={false} renderOrder={-1000}>
      <sphereGeometry args={[DOME_RADIUS, 64, 40]} />
    </mesh>
  )
}
