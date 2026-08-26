import { useMemo } from 'react'
import { BackSide, Color, DataTexture, ShaderMaterial, Vector2, Vector3 } from 'three'
import { useFrame } from '@react-three/fiber'
import { SKY_VIEW_LUT_GLSL } from '@/atmosphere/lut/skyViewLut'
import { useSkyViewLut } from './useSkyViewLut'
import { DOME_RADIUS } from './sceneMath'
import { DISPLAY_TONEMAP_GLSL } from './display/tonemap'

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
 * ## Le ciel n'est plus integre, il est lu
 *
 * Le nuanceur ne marche plus aucun rayon. Il echantillonne une table calculee
 * sur le processeur par le solveur physique — atmosphere standard, spectre
 * solaire mesure, sections efficaces de Rayleigh derivees, transport oblique en
 * geometrie spherique, diffusion simple avec test d'ombre terrestre. Voir
 * `atmosphere/lut/skyViewLut.ts` et `useSkyViewLut.ts`.
 *
 * Le ciel bleu, son blanchiment vers l'horizon, l'arche crepusculaire et
 * l'ombre de la Terre ne sont ecrits nulle part : ils sortent du calcul.
 *
 * ## Ce qui reste de l'ancien modele
 *
 * Le socle nocturne — airglow, lueur lunaire, halo urbain — est encore peint,
 * et ce sont de vraies sources d'emission qui ont leur place dans l'equation du
 * transfert, pas par-dessus. Phase 11.
 *
 * Les corps et les avions continuent d'utiliser `hazeColorAlong()`, l'ancien
 * noyau. **Le ciel et le voile des objets suivent donc temporairement deux
 * modeles differents** : un astre bas sur l'horizon ne se fond plus exactement
 * dans le ciel qui l'entoure. C'est la dette de cette etape, et elle se solde a
 * la phase 9, quand la perspective atmospherique des objets passera au meme
 * transport.
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
    ${DISPLAY_TONEMAP_GLSL}
    ${SKY_VIEW_LUT_GLSL}

    varying vec3 vDir;

    uniform sampler2D uSkyLut;
    uniform vec2 uSkyLutSize;
    uniform vec3 uSunDir;
    uniform float uSkyExposure;

    uniform vec3 uNight;
    uniform vec3 uMoonDir;
    uniform float uMoonFactor;
    uniform vec3 uMoonGlow;
    uniform vec3 uPollution;

    void main() {
      vec3 dir = normalize(vDir);

      // --- Diffusion : une lecture de table, plus aucune integration ---------
      // La table porte une radiance en sRGB lineaire, calculee par le solveur
      // physique (voir \`atmosphere/lut/skyViewLut.ts\`). \`uSkyExposure\` la
      // porte dans l'espace du transform d'affichage — c'est la seule grandeur
      // de cette ligne qui ne soit pas physique, et elle est documentee comme
      // telle dans \`display/exposure.ts\`.
      vec3 scattered = sampleSkyView(uSkyLut, uSkyLutSize, dir, normalize(uSunDir)) * uSkyExposure;

      // --- Socle nocturne : encore peint, encore a remplacer ------------------
      // Airglow, lueur lunaire et halo urbain restent des couleurs choisies. Ce
      // sont de vraies sources d'emission, et elles ont leur place dans
      // l'equation du transfert, pas par-dessus — phase 11.
      float h = clamp(dir.y, -1.0, 1.0);
      vec3 night = mix(uNight * 1.6, uNight, smoothstep(0.0, 0.45, h));

      float toMoon = max(0.0, dot(dir, normalize(uMoonDir)));
      night += uMoonGlow * uMoonFactor * (0.25 + 0.75 * pow(toMoon, 6.0));

      float lowSky = pow(1.0 - clamp(h, 0.0, 1.0), 2.0);
      night += uPollution * (0.3 + 0.7 * lowSky);

      gl_FragColor = vec4(radianceFromDisplay(night) + scattered, 1.0);
    }
  `

  return new ShaderMaterial({
    name: 'SkyBackgroundMaterial',
    uniforms: {
      uSkyLut: { value: null as DataTexture | null },
      uSkyLutSize: { value: new Vector2(1, 1) },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uSkyExposure: { value: 0 },
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
  /** Altitude de l'observateur, m — la table de ciel en depend. */
  observerElevationM: number
  /** Le calque « atmosphere » est-il actif ? Faux = vue depuis l'espace. */
  atmosphereEnabled: boolean
  /**
   * Exposition d'affichage du ciel — voir `display/exposure.ts`.
   *
   * Porte la radiance physique de la table dans l'espace du transform
   * d'affichage. Zero eteint le ciel : c'est la vue depuis l'espace.
   */
  skyExposure: number
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
  observerElevationM,
  atmosphereEnabled,
  skyExposure,
  pollutionGain = 0,
  pollutionColor = '#ffb066',
}: SkyBackgroundProps) {
  const material = useMemo(buildSkyMaterial, [])

  // La table vit **dans** le composant du ciel, donc sous le `<Canvas>` : elle
  // se met a jour par `useFrame`, et les rappels de react-three-fiber ne sont
  // disponibles que la. C'est aussi la bonne place du point de vue des
  // responsabilites — le materiau du ciel possede la table qu'il echantillonne.
  const skyView = useSkyViewLut(sunAltitude, observerElevationM, atmosphereEnabled)

  useFrame(() => {
    const u = material.uniforms

    // Repere de la scene : +X est, +Y zenith, −Z nord.
    const alt = (sunAltitude * Math.PI) / 180
    const az = (sunAzimuth * Math.PI) / 180
    ;(u.uSunDir.value as Vector3).set(Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az))

    u.uSkyLut.value = skyView.texture
    ;(u.uSkyLutSize.value as Vector2).copy(skyView.size)
    u.uSkyExposure.value = skyExposure

    const malt = (moonAltitude * Math.PI) / 180
    const maz = (moonAzimuth * Math.PI) / 180
    ;(u.uMoonDir.value as Vector3).set(
      Math.cos(malt) * Math.sin(maz),
      Math.sin(malt),
      -Math.cos(malt) * Math.cos(maz),
    )

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
