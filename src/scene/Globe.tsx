import { useMemo } from 'react'
import { BackSide, ShaderMaterial, Vector3 } from 'three'
import { useFrame } from '@react-three/fiber'
import { horizonDipDeg } from '@/atmosphere/refraction/rayBending'
import { defaultAtmosphereState } from '@/atmosphere/state/AtmosphereState'
import { AERIAL_LUT_GLSL } from '@/atmosphere/lut/aerialPerspectiveLut'
import { aerialTextures, aerialUniforms, applyAerialUniforms } from './useAerialLut'
import { GROUND_RADIUS } from './sceneMath'
import { effectiveEarthRadiusM } from './terrain/ridgeField'
import { eyeAltitudeM } from './terrain/elevationField'

/**
 * Depression de l'horizon, memoisee par site.
 *
 * L'integrale suit la branche descendante du rayon : quelques millisecondes,
 * une fois par lieu d'observation. Elle ne depend ni de l'heure ni de la visee.
 */
const dipCache = new Map<number, number>()
export function cachedHorizonDipDeg(observerElevationM: number): number {
  const key = Math.round(observerElevationM)
  const cached = dipCache.get(key)
  if (cached !== undefined) return cached
  const dip = horizonDipDeg(key)
  dipCache.set(key, dip)
  return dip
}

/**
 * Le reste du globe — la Terre sans relief, eclairee comme tout le reste.
 *
 * ## Ce qu'il remplace
 *
 * Le sol etait une calotte **peinte** : deux couleurs choisies, fondues sous
 * l'horizon, remontees en radiance par une constante d'affichage. Son propre
 * en-tete l'admettait — « sa couleur reste une valeur d'affichage », et la cale
 * devait disparaitre en phase 9. Elle n'avait pas disparu.
 *
 * Le probleme n'etait pas esthetique. Un sol peint ne sait pas ou est le
 * Soleil : il gardait la meme teinte a midi et sous l'horizon, il ne rougissait
 * pas au couchant, et il ne se voilait pas avec la distance. Surtout, **rien
 * n'arretait la lumiere** : la moitie inferieure de la scene n'etait pas une
 * surface, seulement un cache.
 *
 * ## Ce qui le remplace, et pourquoi ce n'est pas un maillage
 *
 * Le relief, lui, a besoin d'un maillage : sa hauteur varie d'un point a
 * l'autre et il faut bien la porter quelque part. Un globe **sans relief** n'a
 * aucune hauteur a porter — sa surface est entierement decrite par une equation.
 * On garde donc une calotte grossiere comme simple support de rasterisation, et
 * chaque pixel resout lui-meme son intersection avec la sphere :
 *
 *     t = -r0 mu - sqrt( r0^2 mu^2 - r0^2 + R^2 )
 *
 * ou `mu` est le cosinus zenithal de la visee et `r0 = R + altitude`. C'est la
 * racine **proche**, la seule devant l'observateur.
 *
 * Le rayon employe est le **rayon effectif sous refraction**, celui-la meme qui
 * place les sommets du relief et qui donne la depression de l'horizon. Un rayon
 * courbe au-dessus d'une sphere de rayon R equivaut a un rayon droit au-dessus
 * d'une sphere de rayon R_eff : c'est ce qui fait que le globe et le relief
 * s'arretent exactement au meme horizon, au lieu de laisser une frange.
 *
 * ## La lumiere cogne vraiment
 *
 * La normale au point d'impact est `normalize(P)`, avec `P` le point dans le
 * repere geocentrique. Elle **s'incline avec la distance** : un point situe a
 * deux cents kilometres voit sa verticale tournee de 1,8° par rapport a celle
 * de l'observateur.
 *
 * C'est ce qui fait que le globe porte un **terminateur**. Soleil sous l'horizon
 * de l'observateur, le sol lointain dans sa direction peut encore etre eclairee
 * — et le sol proche ne l'est plus. Rien n'est peint : la separation tombe la ou
 * `dot(N, soleil)` change de signe.
 *
 * ## Et le voile
 *
 * Le sol lointain est vu **a travers** deux cents kilometres d'air. Il recoit
 * donc la meme equation du transfert que le relief : ce qu'il emet, attenue,
 * plus ce que l'air ajoute. C'est ce qui fait fondre l'horizon dans le ciel au
 * lieu de le trancher — et c'est ce que la calotte peinte ne pouvait pas faire.
 *
 * ## ⚠️ Ce qu'il ne fait pas
 *
 * **Un seul albedo.** Sans couverture du sol, la mer, la foret et le desert
 * partagent la valeur de `AtmosphereState.groundAlbedo`. C'est la meme valeur
 * qui nourrit deja la diffusion multiple : au moins, le globe visible et le
 * globe qui eclaire le ciel sont d'accord.
 *
 * **L'eclairement du ciel est celui de l'observateur.** A deux cents kilometres,
 * le ciel n'est pas tout a fait le meme. L'ecart est du second ordre devant
 * l'extinction du trajet, qui domine largement a cette distance.
 */
/**
 * Albedo du globe.
 *
 * Repris tel quel de l'etat atmospherique, ou il nourrit deja la diffusion
 * multiple : le sol qu'on voit et le sol qui eclaire le ciel sont ainsi le meme.
 */
const GROUND_ALBEDO = defaultAtmosphereState().groundAlbedo

export function Globe({
  observerElevationM,
  extraHeightM,
  sunDirection,
  sunIrradiance,
  skyExposure,
}: {
  /** Altitude de l'observateur, metres — elle seule fixe ou est l'horizon. */
  observerElevationM: number
  /** Hauteur de l'observateur au-dessus du sol, m. */
  extraHeightM: number
  sunDirection: readonly [number, number, number]
  /** Irradiance solaire directe transmise, sRGB lineaire. */
  sunIrradiance: readonly [number, number, number]
  skyExposure: number
}) {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        side: BackSide,
        // Opaque par son alpha, transparent par sa file de rendu. three dessine
        // **tous** les opaques avant **tous** les transparents : un globe opaque
        // passerait avant les corps du systeme solaire quel que soit son rang,
        // et une planete couchee se dessinerait par-dessus. Sans test de
        // profondeur non plus, parce que `sceneDepth` est logarithmique et place
        // tout le systeme solaire **a l'interieur** de la calotte.
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          ...aerialUniforms(),
          uSunDirection: { value: new Vector3(0, 1, 0) },
          uSunIrradiance: { value: new Vector3() },
          uSkyIrradiance: { value: new Vector3() },
          uAlbedo: { value: GROUND_ALBEDO },
          uObserverAltitude: { value: 0 },
          uEffectiveRadius: { value: 6_371_000 },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            vDir = world.xyz;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: /* glsl */ `
          ${AERIAL_LUT_GLSL}
          varying vec3 vDir;
          uniform vec3 uSunDirection;
          uniform vec3 uSunIrradiance;
          uniform vec3 uSkyIrradiance;
          uniform float uAlbedo;
          uniform float uObserverAltitude;
          uniform float uEffectiveRadius;

          void main() {
            vec3 d = normalize(vDir);

            // --- Ou le regard touche le sol --------------------------------
            float r0 = uEffectiveRadius + uObserverAltitude;
            float mu = d.y;
            float disc = r0 * r0 * mu * mu - (r0 * r0 - uEffectiveRadius * uEffectiveRadius);
            // La calotte s'ouvre a l'horizon apparent, donc toute sa surface
            // rencontre le sol. Le rejet ne protege que du pixel de bord, la ou
            // le discriminant frole zero.
            if (disc < 0.0 || mu >= 0.0) discard;
            float range = -r0 * mu - sqrt(disc);

            // --- La verticale du point vise, qui n'est pas la notre ---------
            // L'observateur est sur l'axe +Y a la distance r0 du centre : le
            // point d'impact s'ecrit donc directement, et sa normale est sa
            // propre direction depuis le centre.
            vec3 hit = vec3(0.0, r0, 0.0) + range * d;
            vec3 N = normalize(hit);

            // --- Eclairement ------------------------------------------------
            // Le cosinus est pris avec **cette** normale-la : c'est ce qui fait
            // que le terminateur traverse le sol au lieu de l'eteindre d'un bloc.
            float cosIncidence = max(0.0, dot(N, normalize(uSunDirection)));
            float skyView = 0.5 * (1.0 + dot(N, vec3(0.0, 1.0, 0.0)));
            vec3 irradiance = uSunIrradiance * cosIncidence + uSkyIrradiance * skyView;

            // Surface lambertienne : la radiance sortante vaut l'eclairement
            // recu divise par pi, quelle que soit la direction de sortie.
            vec3 outgoing = uAlbedo * irradiance / 3.14159265;

            // --- Le trajet jusqu'a l'oeil -----------------------------------
            vec3 transmittance;
            vec3 haze = aerialPerspective(d, range, transmittance);
            gl_FragColor = vec4(outgoing * transmittance * uAerialExposure + haze, 1.0);
          }
        `,
      }),
    [],
  )

  useFrame(() => {
    const u = material.uniforms
    applyAerialUniforms(u as unknown as ReturnType<typeof aerialUniforms>, sunDirection, skyExposure)
    ;(u.uSunDirection.value as Vector3).set(sunDirection[0], sunDirection[1], sunDirection[2])
    ;(u.uSunIrradiance.value as Vector3).set(sunIrradiance[0], sunIrradiance[1], sunIrradiance[2])
    // Mesure sur la table du ciel, comme pour le relief : le meme eclairement
    // diffus nourrit les deux surfaces.
    const sky = aerialTextures.skyIrradiance
    ;(u.uSkyIrradiance.value as Vector3).set(sky[0], sky[1], sky[2])
    // ## Le globe est au niveau de la mer, et c'est ce qu'il faut
    //
    // On pourrait le croire mal place : un observateur alpin le verrait mille
    // metres sous ses pieds. Mais le relief le recouvre entierement des le
    // premier metre, et le globe ne reapparait qu'**au-dela de la portee des
    // donnees** — quatre cent cinquante kilometres. La, la pyramide rend elle
    // aussi zero, faute de mieux : les deux surfaces se rejoignent sans marche.
    //
    // Et quand le calque du relief est eteint, le niveau de la mer redevient
    // simplement la seule surface qu'on puisse affirmer.
    // ⚠️ Le rayon effectif se deduit de la depression, et la depression est
    // celle de **l'oeil** — pas celle du site. Les prendre a deux altitudes
    // differentes revenait a donner au globe un horizon et au relief un autre.
    const eyeM = eyeAltitudeM(observerElevationM, extraHeightM)
    u.uObserverAltitude.value = eyeM
    u.uEffectiveRadius.value = effectiveEarthRadiusM(eyeM, cachedHorizonDipDeg(eyeM))
  })

  // Apres tout le reste : le rang le plus eleve de la scene est 24, l'anneau de
  // selection d'un astre — qu'un astre couche ne doit pas montrer non plus.
  return (
    <mesh material={material} renderOrder={25} frustumCulled={false}>
{/* ⚠️ **La calotte s'ouvre a l'horizontale, pas a l'horizon.**

          Elle s'arretait autrefois a la depression de l'horizon, calculee sur
          l'altitude du **site**. Des qu'une hauteur s'y ajoutait, l'horizon reel
          descendait avec l'oeil et la calotte, elle, restait ou elle etait : la
          bande entre les deux n'appartenait a personne, et l'on y voyait le ciel
          s'eteindre seul. Mesure : 1,56° de bande a six mille metres au-dessus
          de Chamonix, ou le ciel tombait a 47 % ; 2,85° et un noir complet a dix
          mille metres.

          La geometrie ne decide donc plus de rien. Elle couvre tout l'hemisphere
          inferieur, et c'est le test d'intersection **par pixel** qui taille le
          bord exact — au metre pres, et toujours au meme endroit que le relief,
          puisque les deux resolvent la meme sphere. */}
      <sphereGeometry args={[GROUND_RADIUS, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]} />
    </mesh>
  )
}
