import { useMemo } from 'react'
import { BackSide, Color, ShaderMaterial, Vector3 } from 'three'
import { useFrame } from '@react-three/fiber'
import { DOME_RADIUS } from './sceneMath'
import { DISPLAY_TONEMAP_GLSL } from './display/tonemap'
import {
  ATMOSPHERE_GLSL,
  ATMOSPHERE_HAZE_COLOR_FN,
  ATMOSPHERE_UNIFORM_DECLARATIONS,
  applyAerosolTurbidity,
  atmosphereUniforms,
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
 * Elle appelle `hazeColorAlong()`, exactement la fonction que les corps et les
 * avions utilisent pour se fondre dans le ciel : un objet quasiment cote nuit
 * (la Lune en conjonction, par exemple) doit disparaitre dans le ciel qui
 * l'entoure, pas se detacher parce que son propre voile suit un mappage
 * different de celui affiche autour de lui.
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
    ${ATMOSPHERE_UNIFORM_DECLARATIONS}
    ${DISPLAY_TONEMAP_GLSL}
    ${ATMOSPHERE_HAZE_COLOR_FN}

    varying vec3 vDir;

    uniform vec3 uNight;
    uniform vec3 uMoonDir;
    uniform float uMoonFactor;
    uniform vec3 uMoonGlow;
    uniform vec3 uPollution;

    void main() {
      vec3 dir = normalize(vDir);
      vec3 scattered = hazeColorAlong(dir);

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

      // Halo urbain. La lumiere perdue par l'eclairage public part du sol et
      // remonte : elle traverse d'autant plus d'air qu'on regarde bas, et le
      // ciel s'eclaircit donc vers l'horizon bien plus qu'au zenith. C'est ce
      // gradient, autant que la teinte orangee des lampes, qui rend une nuit
      // de ville reconnaissable.
      float lowSky = pow(1.0 - clamp(h, 0.0, 1.0), 2.0);
      night += uPollution * (0.3 + 0.7 * lowSky);

      // La teinte de nuit est encore une couleur d'affichage peinte a la main — socle
      // nocturne, lueur lunaire, halo urbain. On la remonte en radiance pour
      // l'additionner a la diffusion, qui en est une. La conversion est exacte :
      // de nuit, ou la diffusion est nulle, le transform d'affichage restitue
      // exactement la couleur d'origine.
      //
      // Cette cale disparaitra en phase 11, quand airglow et pollution
      // lumineuse deviendront de vraies sources du transfert radiatif.
      gl_FragColor = vec4(radianceFromDisplay(night) + scattered, 1.0);
    }
  `

  return new ShaderMaterial({
    name: 'SkyBackgroundMaterial',
    uniforms: {
      ...atmosphereUniforms(),
      uMoonDir: { value: new Vector3(0, -1, 0) },
      uMoonFactor: { value: 0 },
      uNight: { value: new Color('#03040a') },
      uMoonGlow: { value: new Color('#7d8fc4') },
      uPollution: { value: new Color('#000000') },
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
  sunAltitude: number
  sunAzimuth: number
  moonAltitude: number
  moonAzimuth: number
  lunarLux: number
  nightColor: string
  moonGlowColor: string
  /**
   * Exposition de la diffusion atmospherique — voir `SkyCanvas.tsx`. Memes
   * unites, meme valeur que celle recue par les corps et les avions : c'est
   * ce qui garantit qu'un objet presque cote nuit se fond dans le ciel plutot
   * que de s'en detacher.
   */
  atmosphereExposure: number
  /**
   * Trouble atmospherique — multiplie le coefficient de diffusion Mie
   * (aerosols). 1 = air standard. C'est le levier destine a la qualite de
   * l'air et a la nebulosite : plus il monte, plus l'horizon blanchit et le
   * ciel s'eclaircit, comme une vraie brume de pollution.
   */
  aerosolTurbidity?: number
  /**
   * Intensite du halo urbain, deja mise a l'echelle de l'affichage — voir
   * `SkyCanvas.tsx`. Zero sur un site vierge : le rendu est alors strictement
   * celui d'avant l'existence de ce reglage.
   */
  pollutionGain?: number
  /** Teinte des lampes urbaines renvoyee par le ciel. */
  pollutionColor?: string
}

export function SkyBackground({
  sunAltitude,
  sunAzimuth,
  moonAltitude,
  moonAzimuth,
  lunarLux,
  nightColor,
  moonGlowColor,
  atmosphereExposure,
  aerosolTurbidity = 1,
  pollutionGain = 0,
  pollutionColor = '#ffb066',
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

    applyAerosolTurbidity(u as Parameters<typeof applyAerosolTurbidity>[0], aerosolTurbidity)
    u.uAtmosphereExposure.value = atmosphereExposure

    u.uMoonFactor.value = moonAltitude > 0 ? Math.min(0.5, Math.max(0, lunarLux * 0.55)) : 0

    ;(u.uNight.value as Color).set(nightColor)
    ;(u.uMoonGlow.value as Color).set(moonGlowColor)
    ;(u.uPollution.value as Color).set(pollutionColor).multiplyScalar(pollutionGain)
  })

  return (
    <mesh material={material} frustumCulled={false} renderOrder={-1000}>
      <sphereGeometry args={[DOME_RADIUS, 64, 40]} />
    </mesh>
  )
}
