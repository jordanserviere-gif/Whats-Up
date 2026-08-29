import { useMemo } from 'react'
import { BackSide, Color, ShaderMaterial, Vector3 } from 'three'
import { useFrame } from '@react-three/fiber'
import { AERIAL_LUT_GLSL } from '@/atmosphere/lut/aerialPerspectiveLut'
import { aerialUniforms, applyAerialUniforms, useAerialLut } from './useAerialLut'
import { setRefractionEnabled } from '@/atmosphere/refraction/refractionTable'
import { refractionSite } from './refractionTexture'
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
 * geometrie spherique, diffusion simple et multiple avec test d'ombre
 * terrestre. Voir `atmosphere/lut/aerialPerspectiveLut.ts` et `useAerialLut.ts`.
 *
 * Cette table porte **toutes les distances**, pas seulement le ciel entier. Le
 * fond de ciel en lit la derniere tranche — celle qui va jusqu'a la sortie de
 * l'atmosphere — et les corps du systeme solaire lisent exactement la meme.
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
 * Les corps et les avions lisent **la meme table**, a leur propre distance —
 * l'infini pour un astre, quelques centaines de kilometres pour un avion. La
 * dette d'un ciel et d'un voile suivant deux modeles differents est soldee : le
 * raccord entre un astre bas et le ciel qui l'entoure n'est pas ajuste, il est
 * structurel.
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
    ${AERIAL_LUT_GLSL}

    varying vec3 vDir;

    uniform vec3 uNight;
    uniform vec3 uMoonDir;
    uniform float uMoonFactor;
    uniform vec3 uMoonGlow;
    uniform vec3 uPollution;

    void main() {
      vec3 dir = normalize(vDir);

      // --- Diffusion : une lecture de table, plus aucune integration ---------
      // La table porte une radiance en sRGB lineaire, calculee par le solveur
      // physique (voir \`atmosphere/lut/aerialPerspectiveLut.ts\`).
      // \`uAerialExposure\` la porte dans l'espace du transform d'affichage —
      // c'est la seule grandeur de cette ligne qui ne soit pas physique, et elle
      // est documentee comme telle dans \`display/exposure.ts\`.
      //
      // Le fond de ciel n'a rien devant lui : il lit donc la tranche a l'infini,
      // et jette la transmittance. Un astre lit la meme tranche et la garde.
      vec3 ignoredTransmittance;
      vec3 scattered = dir.y < 0.0
        ? vec3(0.0)
        : aerialPerspectiveToSpace(dir, ignoredTransmittance);

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
      ...aerialUniforms(),
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
  /** Distance Terre-Soleil, ua — l'eclairement varie en `1/d²`. */
  sunDistanceAu: number
  /** Colonne d'ozone, DU — ce qui rend le crepuscule bleu. */
  ozoneColumnDu: number
  /** Le calque « atmosphere » est-il actif ? Faux = vue depuis l'espace. */
  atmosphereEnabled: boolean
  /**
   * Trouble atmospherique — charge en aerosols, 1 = air tres pur.
   *
   * Il n'est plus un multiplicateur de coefficient : il se traduit en
   * **epaisseur optique a 550 nm**, la grandeur que mesurent les photometres
   * solaires. Voir `atmosphere/mie/aerosol.ts`.
   */
  aerosolTurbidity: number
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
  sunDistanceAu,
  ozoneColumnDu,
  atmosphereEnabled,
  aerosolTurbidity,
  skyExposure,
  pollutionGain = 0,
  pollutionColor = '#ffb066',
}: SkyBackgroundProps) {
  const material = useMemo(buildSkyMaterial, [])

  // La table vit **dans** le composant du ciel, donc sous le `<Canvas>` : elle
  // se met a jour par `useFrame`, et les rappels de react-three-fiber ne sont
  // disponibles que la. C'est aussi la bonne place du point de vue des
  // responsabilites — le materiau du ciel possede la table qu'il echantillonne.
  useAerialLut(
    sunAltitude,
    observerElevationM,
    aerosolTurbidity,
    atmosphereEnabled,
    sunDistanceAu,
    ozoneColumnDu,
  )

  // Le fond de ciel publie l'etat de l'atmosphere pour toutes les couches : les
  // corps, les etoiles, le ciel profond et les constellations lisent la meme
  // table de refraction, et le meme interrupteur. C'est cette unicite qui
  // garantit qu'une planete ne se detache pas de son champ d'etoiles.
  refractionSite.observerElevationM = observerElevationM
  setRefractionEnabled(atmosphereEnabled)

  useFrame(() => {
    const u = material.uniforms

    // Repere de la scene : +X est, +Y zenith, −Z nord.
    const alt = (sunAltitude * Math.PI) / 180
    const az = (sunAzimuth * Math.PI) / 180
    applyAerialUniforms(
      u as unknown as ReturnType<typeof aerialUniforms>,
      [Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az)],
      skyExposure,
    )

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
