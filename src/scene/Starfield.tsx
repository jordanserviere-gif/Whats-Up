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
import {
  PERCEIVED_VARIANCE_CEILING,
  PERCEIVED_ZENITH_EXPONENT,
  nakedEyeZenithVariance,
} from '@/atmosphere/turbulence/scintillation'
import { applyRefractionUniforms, refractionUniforms } from './refractionTexture'
import { equatorialToSceneMatrix, SKY_RADIUS } from './sceneMath'
import type { GeoLocation } from '@/astro/types'

/**
 * Variance de scintillation percue au zenith, a l'oeil nu.
 *
 * Calculee une fois : elle ne depend que du profil de turbulence, de la pupille
 * et de la reponse temporelle de l'oeil — rien qui change d'une image a l'autre.
 * Toute la dependance a la hauteur est portee par le nuanceur, en `sec^(7/3)`.
 */
const ZENITH_SCINTILLATION_VARIANCE = nakedEyeZenithVariance()

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
          /**
           * Variance de scintillation percue au zenith, a l'oeil nu.
           *
           * **Toute la physique de la phase 17 tient dans ce seul nombre.** Il
           * sort de l'integrale de `C_n²` du profil de Hufnagel-Valley, du
           * moyennage par la pupille, et de la fraction du spectre temporel que
           * l'oeil percoit reellement. Le nuanceur n'a plus qu'a le porter a la
           * hauteur de chaque etoile.
           */
          uScintillationZenith: { value: 0 },
          /** Plafond, au-dela duquel la theorie de perturbation ne vaut plus. */
          uScintillationCeiling: { value: PERCEIVED_VARIANCE_CEILING },
          /** Secondes ecoulees, en temps **reel** — voir le nuanceur. */
          uScintillationTime: { value: 0 },
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

          // ⚠️ **La masse d'air ne se calcule plus ici.** Ce nuanceur portait sa
          // propre formule de Pickering, bornee a zero degre — un second modele
          // d'atmosphere dans la meme image, et celui-la ignorait que l'horizon
          // descend avec l'observateur. Vue de dix kilometres, la masse d'air a
          // moins trois degres vaut 219 : la formule bornee en donnait 39.
          //
          // Elle est desormais lue dans la table de refraction, canal vert, sur
          // le meme domaine et pour le meme site — voir \`airmassAt\`.

          uniform float uScintillationZenith;
          uniform float uScintillationCeiling;
          uniform float uScintillationTime;

          /** Hachage scalaire, pour donner a chaque etoile sa propre phase. */
          float hash11(float p) {
            p = fract(p * 0.1031);
            p *= p + 33.33;
            p *= p + p;
            return fract(p);
          }

          /**
           * Fluctuation temporelle de variance unite.
           *
           * Trois sinusoides de frequences incommensurables : leur somme n'a pas
           * de periode, et son spectre tient sous la frequence de fusion de
           * l'oeil — au-dessus, la retine moyennerait de toute facon.
           *
           * Le facteur de normalisation est « 1/√(Σaᵢ²/2) », ce qui donne
           * exactement une variance de 1 : c'est ce qui permet a l'amplitude
           * d'etre entierement portee par la physique, et non par ce bruit.
           *
           * ⚠️ La **realisation** est arbitraire — c'est un tirage. Ce qui est
           * physique, c'est sa variance et sa bande passante.
           */
          float flicker(float seed, float t) {
            float a = sin(t * 19.478 + hash11(seed) * 100.0);
            float b = sin(t * 35.814 + hash11(seed + 1.7) * 100.0) * 0.7;
            float c = sin(t * 70.999 + hash11(seed + 3.1) * 100.0) * 0.5;
            return (a + b + c) * 0.75835;
          }

          void main() {
            // La direction equatorielle tournee, **puis** redressee par la
            // refraction — la meme table que les corps du systeme solaire et les
            // constellations. Sans cela une planete se detacherait de son champ
            // d'etoiles de plus d'un diametre lunaire pres de l'horizon.
            vec4 world = modelMatrix * vec4(position, 1.0);
            // Hauteur **vraie**, prise avant le redressement : c'est l'abscisse
            // de la table, qui porte refraction et masse d'air sur le meme axe.
            float trueAltDeg = degrees(asin(clamp(normalize(world.xyz).y, -1.0, 1.0)));
            world.xyz = refractSceneDirection(world.xyz);
            vec3 dir = normalize(world.xyz);
            float altDeg = degrees(asin(clamp(dir.y, -1.0, 1.0)));

            float x = min(airmassAt(trueAltDeg), 12.0);
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

            // --- Scintillation ---------------------------------------------
            //
            // La variance percue croit en « sec^(7/3) ζ » : 11/6 pour la
            // variance elle-meme, plus 1/2 parce qu'une visee oblique allonge
            // la distance a la couche, agrandit le rayon de Fresnel et abaisse
            // donc la frequence — dont l'oeil percoit une fraction d'autant plus
            // grande. Voir turbulence/scintillation.ts.
            //
            // C'est de la seule dependance a la hauteur que sort le fait
            // qu'une etoile basse scintille bien plus qu'une etoile au zenith.
            // Rien ne l'ecrit.
            // La secante de l'angle zenithal **est** l'approximation
            // plan-parallele de la masse d'air : autant lire la vraie, qui
            // connait la courbure et l'altitude du site plutot que de borner la
            // hauteur a zero. Le plafond reste celui d'avant, pour ne pas
            // changer ce que la scintillation vaut au niveau de la mer.
            float secZ = min(airmassAt(trueAltDeg), 20.0);
            float variance = min(uScintillationCeiling,
                                 uScintillationZenith * pow(secZ, ${PERCEIVED_ZENITH_EXPONENT.toFixed(6)}));
            // Loi log-normale : « σ_lnI² = ln(1 + σ_I²) », et une magnitude
            // vaut « −2,5·log₁₀ I », d'ou le facteur 1,0857.
            float sigmaMag = 1.0857362 * sqrt(log(1.0 + variance));
            float fluctuation = sigmaMag * flicker(position.x + position.y * 3.7 + position.z * 11.3,
                                                   uScintillationTime);
            vIntensity *= pow(10.0, -0.4 * fluctuation);
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

  useFrame((state) => {
    const p = pointsRef.current
    if (!p) return
    // Temps **reel** et non simule : la scintillation est un phenomene de
    // quelques dizaines de hertz, sans rapport avec la vitesse a laquelle on
    // fait defiler le ciel. En avance rapide, les etoiles doivent continuer de
    // fremir au meme rythme.
    material.uniforms.uScintillationTime.value = state.clock.elapsedTime
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

    // Sans atmosphere, pas de turbulence : les etoiles cessent de scintiller en
    // meme temps que le ciel disparait. C'est un cas du modele, pas une
    // exception — et le drapeau est celui que la refraction porte deja.
    material.uniforms.uScintillationZenith.value =
      material.uniforms.uRefractionActive.value > 0 ? ZENITH_SCINTILLATION_VARIANCE : 0
  })

  return <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} renderOrder={4} />
}
