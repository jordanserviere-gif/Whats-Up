import { useMemo } from 'react'
import { BackSide, Color, ShaderMaterial, Vector3 } from 'three'
import { useFrame } from '@react-three/fiber'
import { AERIAL_LUT_GLSL } from '@/atmosphere/lut/aerialPerspectiveLut'
import { AIRGLOW_LAYER_ALTITUDE_M, airglowZenithRadiance } from '@/atmosphere/emission/airglow'
import { EARTH_MEAN_RADIUS_M } from '@/atmosphere/core/units'
import { HORIZON_MARGIN_DEG } from '@/atmosphere/horizonMargin'
import { uniformSpectralGrid } from '@/atmosphere/spectral/SpectralGrid'
import { spectralToLinearSrgb } from '@/atmosphere/spectral/SpectralSensor'
import { aerialUniforms, applyAerialUniforms, useAerialLut } from './useAerialLut'
import { PHOTOPIC_FLOOR, SCOTOPIC_CEILING } from './display/adaptation'
import { setRefractionEnabled } from '@/atmosphere/refraction/refractionTable'
import { refractionSite } from './refractionTexture'
import { cachedHorizonDipDeg } from './Globe'
import { eyeAltitudeM } from './terrain/elevationField'
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
/**
 * Radiance de l'airglow au zenith, sRGB lineaire.
 *
 * Calculee une fois : elle ne depend ni de l'heure, ni du lieu, ni de la
 * direction. Le bleu en ressort **negatif** — une emission quasi monochromatique
 * a 557,7 nm sort du triangle sRGB — et l'ecretage de la chaine d'affichage s'en
 * charge, comme pour toute couleur hors gamut.
 *
 * Trente-deux bandes plutot que seize : trois raies etroites sur une grille
 * large donnent une chromaticite qui depend des bords de bande, et la mesure
 * montre qu'elle se stabilise a partir de trente-deux.
 */
const AIRGLOW_GRID = uniformSpectralGrid(360, 830, 32)
const AIRGLOW_ZENITH = spectralToLinearSrgb(AIRGLOW_GRID, airglowZenithRadiance(AIRGLOW_GRID))

/** `R/(R+h)` de la couche d'airglow — le seul terme du facteur van Rhijn. */
const AIRGLOW_RADIUS_RATIO = EARTH_MEAN_RADIUS_M / (EARTH_MEAN_RADIUS_M + AIRGLOW_LAYER_ALTITUDE_M)

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
    uniform vec3 uAirglowZenith;
    uniform float uAirglowRadiusRatio;
    uniform float uSkyExposure;
    uniform float uScotopic;
    uniform float uHorizonMargin;
    uniform float uHorizonDip;
    uniform float uScotopicCeiling;
    uniform float uPhotopicFloor;

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
      //
      // La coupure ne se fait plus a la hauteur zero mais quelques degres plus
      // bas. Elle y etait nette, et l'horizon geometrique n'est pas l'horizon
      // visible : la refraction en decale la frontiere d'un demi-degre, et
      // l'abaissement d'horizon davantage encore. La table clampe deja sa
      // coordonnee verticale a sa premiere ligne, si bien que la marge lit la
      // couleur de l'horizon plutot qu'un trou noir.
      //
      // ⚠️ Le fondu lui-meme n'a rien de physique : c'est le garde-fou de
      // \`atmosphere/horizonMargin.ts\`, et il agit sous une calotte de sol qui le
      // recouvre entierement.
      vec3 transmittanceToSpace = vec3(1.0);
      // La marge se compte sous l'horizon **apparent**, pas sous l'horizontale :
      // pour un observateur en hauteur les deux different, et faire partir le
      // fondu de zero attenuait une bande de ciel encore parfaitement visible.
      float elevDeg = degrees(asin(clamp(dir.y, -1.0, 1.0)));
      float belowDeg = -(elevDeg + uHorizonDip);
      float horizonFade = 1.0 - smoothstep(0.0, uHorizonMargin, belowDeg);
      vec3 scattered = horizonFade > 0.0
        ? aerialPerspectiveToSpace(dir, transmittanceToSpace) * horizonFade
        : vec3(0.0);

      // --- Le socle nocturne : forme calculee, amplitude encore choisie -------
      //
      // La haute atmosphere brille d'elle-meme : le rayonnement ultraviolet
      // dissocie l'oxygene le jour, les atomes se recombinent la nuit et rendent
      // cette energie en raies. C'est de la chimiluminescence, dans une couche
      // mince a quatre-vingt-dix kilometres.
      //
      // Vue obliquement, cette couche est traversee plus longuement — facteur de
      // van Rhijn, qui atteint six a l'horizon. Mais la lumiere doit ensuite
      // traverser toute l'atmosphere, et une visee rasante y perd presque tout.
      // Leur produit donne un maximum vers dix a quinze degres puis un
      // effondrement au ras de l'horizon : c'est ce qu'on observe, et le
      // smoothstep d'autrefois l'imitait sans le calculer.
      //
      // La transmittance employee est celle que la table de perspective avait
      // deja calculee pour le fond de ciel, et que ce nuanceur jetait.
      //
      // **L'amplitude est desormais physique aussi.** Elle ne l'etait pas tant
      // que l'exposition restait fixe : l'airglow vaut 3,7e-5 cd/m² au zenith,
      // soit 4e-10 d'un blanc ancre a 86 302. Depuis que l'exposition suit la
      // luminance du ciel, le plancher d'adaptation est precisement cette
      // valeur, et l'airglow retrouve sa place — la couleur peinte a disparu.
      float h = clamp(dir.y, -1.0, 1.0);
      float sinZ = sqrt(max(0.0, 1.0 - h * h));
      float shell = uAirglowRadiusRatio * sinZ;
      float vanRhijn = inversesqrt(max(1e-6, 1.0 - shell * shell));
      // La couche d'airglow suit la meme marge que la diffusion : sans le
      // fondu, elle resterait a pleine intensite sous l'horizon, ou
      // \`transmittanceToSpace\` n'a pas ete ecrite et vaut encore un.
      vec3 airglow = uAirglowZenith * vanRhijn * transmittanceToSpace * uAerialExposure * horizonFade;

      // --- Ce qui reste peint ---------------------------------------------------
      // La lueur lunaire est de la diffusion, exactement comme le ciel de jour :
      // sa place est dans le transport, avec la Lune pour source. Le halo urbain
      // est une emission renvoyee par l'atmosphere, que decrit le modele de
      // Garstang (1989). Ni l'un ni l'autre n'est encore calcule.
      float toMoon = max(0.0, dot(dir, normalize(uMoonDir)));
      vec3 painted = uMoonGlow * uMoonFactor * (0.25 + 0.75 * pow(toMoon, 6.0));
      float lowSky = pow(1.0 - clamp(h, 0.0, 1.0), 2.0);
      painted += uPollution * (0.3 + 0.7 * lowSky);

      vec3 total = radianceFromDisplay(painted) + scattered + airglow;

      // --- Vision scotopique : les batonnets ne voient pas les couleurs ---------
      //
      // Sous 0,01 cd/m² l'oeil ne distingue plus aucune teinte : les batonnets
      // ne portent qu'un pigment, et aucune comparaison entre recepteurs n'est
      // possible. L'airglow est physiquement verdatre — sa raie a 557,7 nm
      // domine — mais personne ne voit ce vert.
      //
      // **La bascule est locale, non globale.** Une premiere version employait
      // la luminance moyenne du ciel et grisait donc tout, y compris la bande
      // orange de l'horizon au crepuscule nautique — qui rendait un 220,220,220
      // absurde alors qu'elle est la chose la plus lumineuse du ciel.
      //
      // C'est faux : l'adaptation est globale, mais la dominance des cones
      // depend de l'eclairement retinien **local**. C'est pourquoi on voit la
      // couleur d'un feu la nuit pendant que le reste du paysage reste gris.
      //
      // ⚠️ Seule la desaturation est modelisee. Le decalage de Purkinje, qui
      // ferait tirer la nuit vers le bleu, demanderait la courbe V'(lambda) que
      // le moteur n'embarque pas : le ciel nocturne sort donc **gris**.
      float lum = dot(total, vec3(0.2126, 0.7152, 0.0722));
      // Retour en candelas par metre carre : total est une radiance deja
      // multipliee par l'exposition, et la luminance vaut 683 fois la luma.
      float localCdM2 = (683.0 * lum) / max(1e-9, uAerialExposure);
      // **En logarithme, non en lineaire.** L'oeil travaille en decades, et le
      // domaine mesopique en couvre deux et demie. Interpole lineairement, un
      // ciel a 1,8 cd/m² se retrouvait a 34 % de vision batonnets alors qu'il
      // est presque photopique — la bande orange du crepuscule nautique en
      // ressortait grise.
      float decades = log2(max(1e-9, localCdM2) / uScotopicCeiling) /
                      log2(uPhotopicFloor / uScotopicCeiling);
      float rods = 1.0 - smoothstep(0.0, 1.0, decades);
      total = mix(total, vec3(lum), rods * uScotopic);

      gl_FragColor = vec4(total, 1.0);
    }
  `

  return new ShaderMaterial({
    name: 'SkyBackgroundMaterial',
    uniforms: {
      ...aerialUniforms(),
      /**
       * Radiance de l'airglow au zenith, sRGB lineaire.
       *
       * Calculee par `atmosphere/emission/airglow.ts` et normalisee sur
       * `AIRGLOW_LUX`, l'ancre que le moteur portait deja. Le nuanceur n'ajoute
       * que la geometrie.
       */
      uAirglowZenith: { value: new Vector3() },
      /** `R/(R+h)` pour la couche d'airglow — le seul terme du facteur van Rhijn. */
      uAirglowRadiusRatio: { value: 0 },
      /**
       * Interrupteur global de la desaturation scotopique.
       *
       * Il ne porte que l'extinction du calque atmosphere : la bascule
       * elle-meme se fait **par pixel**, sur la luminance locale.
       */
      uScotopic: { value: 0 },
      /** Profondeur sous l'horizon ou l'atmosphere cesse d'etre calculee, degres. */
      uHorizonMargin: { value: HORIZON_MARGIN_DEG },
      /** Depression de l'horizon apparent, degres — zero au niveau de la mer. */
      uHorizonDip: { value: 0 },
      /** Bornes du domaine mesopique, cd/m². */
      uScotopicCeiling: { value: SCOTOPIC_CEILING },
      uPhotopicFloor: { value: PHOTOPIC_FLOOR },
      /** Exposition d'affichage, partagee avec la diffusion. */
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
  /** Altitude du sol sous l'observateur, m — la table de ciel en depend. */
  observerElevationM: number
  /** Hauteur de l'observateur au-dessus de ce sol, m. */
  extraHeightM: number
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
  extraHeightM,
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
  // ⚠️ **L'altitude qui compte est celle de l'oeil**, pas l'altitude nominale du
  // site : a six mille metres au-dessus de celui-ci, ce sont deux grandeurs sans
  // rapport. La refraction, la depression de l'horizon et le profil de densite
  // dependent toutes trois d'ou le regard part.
  const eyeM = eyeAltitudeM(observerElevationM, extraHeightM)

  useAerialLut(
    sunAltitude,
    // Quantifiee a dix metres : le ciel n'y distingue rien, et cela evite de
    // reconstruire toute la table a chaque metre que le relief gagne en se
    // chargeant — trois paliers, trois reconstructions.
    Math.round(eyeM / 10) * 10,
    aerosolTurbidity,
    atmosphereEnabled,
    sunDistanceAu,
    ozoneColumnDu,
  )

  // Le fond de ciel publie l'etat de l'atmosphere pour toutes les couches : les
  // corps, les etoiles, le ciel profond et les constellations lisent la meme
  // table de refraction, et le meme interrupteur. C'est cette unicite qui
  // garantit qu'une planete ne se detache pas de son champ d'etoiles.
  refractionSite.observerElevationM = eyeM
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

    // L'airglow ne depend ni de l'heure ni de la direction du Soleil : sa
    // radiance zenithale est une constante, et le nuanceur n'y ajoute que la
    // geometrie de la couche. Il s'eteint avec le calque atmosphere — sans
    // atmosphere, pas de couche emissive.
    ;(u.uAirglowZenith.value as Vector3).set(
      atmosphereEnabled ? AIRGLOW_ZENITH[0] : 0,
      atmosphereEnabled ? AIRGLOW_ZENITH[1] : 0,
      atmosphereEnabled ? AIRGLOW_ZENITH[2] : 0,
    )
    u.uAirglowRadiusRatio.value = AIRGLOW_RADIUS_RATIO
    u.uSkyExposure.value = skyExposure
    // Le ciel descend jusqu'a l'horizon **apparent**, celui de l'oeil. C'est la
    // meme depression dont le globe et le relief se servent, et les trois
    // doivent venir de la meme source sous peine de laisser une couture.
    //
    // ⚠️ Elles n'en venaient plus. Le relief suivait l'oeil quand le ciel et le
    // globe suivaient le site : la hauteur ajoutee les separait, et la bande
    // entre les deux horizons n'appartenait a personne. On y voyait le fondu du
    // ciel s'eteindre seul — a 47 % sept mille metres au-dessus de Chamonix,
    // noir a dix mille.
    u.uHorizonDip.value = cachedHorizonDipDeg(eyeAltitudeM(observerElevationM, extraHeightM))
    // La desaturation suit la luminance du ciel reellement affiche, la meme qui
    // pilote l'exposition. Sans atmosphere, la question ne se pose pas.
    u.uScotopic.value = atmosphereEnabled ? 1 : 0

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
