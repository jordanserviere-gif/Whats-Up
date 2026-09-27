import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AdditiveBlending,
  BackSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  NoColorSpace,
  PerspectiveCamera,
  RepeatWrapping,
  ClampToEdgeWrapping,
  ShaderMaterial,
  SphereGeometry,
  Texture,
  TextureLoader,
} from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import RAW from '@/data/milky-way.json'
import {
  POINT_BRIGHTNESS_SCALE,
  POINT_VISIBILITY_FADE_END,
  POINT_VISIBILITY_FADE_START,
  extinctionCoefficient,
} from '@/astro/photometry'
import {
  ARCSEC2_STERADIAN,
  EYE_POINT_SPREAD_SR,
} from './display/adaptation'
import { EYE_SUMMATION_SR } from './display/extendedVision'
import { instrumentGainMag } from './display/instrument'
import { DISPLAY_TONEMAP_GLSL } from './display/tonemap'
import { applySkyGlow, SKY_GLOW_GLSL, skyGlowUniforms, type SkyGlow } from './display/skyGlowGradient'
import { REFRACTION_LUT_GLSL } from '@/atmosphere/refraction/refractionTable'
import { applyRefractionUniforms, refractionUniforms } from './refractionTexture'
import { equatorialToSceneMatrix, SKY_RADIUS } from './sceneMath'
import type { GeoLocation } from '@/astro/types'

/**
 * La Voie lactee.
 *
 * ## Ce qu'elle est, pour le moteur
 *
 * Une **source etendue**, et rien d'autre : la lueur des etoiles trop faibles
 * pour etre resolues, que le catalogue ne dessine pas une par une. Elle passe
 * donc par la loi du ciel profond, sans une constante de plus — detection par
 * l'aire de sommation de l'oeil, eclat par la tache retinienne, seuil a la
 * magnitude limite du moment. Voir `DeepSky.tsx` et `display/extendedVision.ts`.
 *
 * C'est ce qui la fait disparaitre d'elle-meme la ou elle doit disparaitre :
 * la pollution lumineuse, la Lune et le crepuscule abaissent la magnitude
 * limite, et la Voie lactee s'eteint par le meme chemin qu'une galaxie. Rien ne
 * l'ecrit. Sous un ciel vierge, le nuage du Sagittaire (19,9 mag/arcsec²) est
 * franchement visible, le Cygne (22,8) a peine, les poles galactiques pas du
 * tout.
 *
 * ## La carte
 *
 * Gaia DR2 sans les etoiles Hipparcos et Tycho, NASA SVS — voir
 * `scripts/build-milky-way.mjs`, qui en dit la source, l'orientation mesuree et
 * l'ancrage. Le canal rouge porte une brillance de surface, pas une intensite ;
 * le vert et le bleu, la teinte.
 *
 * ## La couleur
 *
 * Celle de la carte, lissee sur un degre — pas de gris scotopique, voir le
 * nuanceur.
 *
 * ## ⚠️ Ce qu'elle ne fait pas
 *
 * **Pas de lumiere zodiacale**, ni de lumiere diffuse galactique distincte :
 * seule la lueur stellaire est cartographiee. **Pas de rejet a 0,004** comme
 * dans le ciel profond : sur une nappe continue, ce seuil dessinerait une
 * courbe de niveau.
 */

/** Magnitude, en mag/arcsec², portee par l'octet nul et pas d'un octet. */
/**
 * Part de la teinte de la carte conservee, de 0 (gris) a 1 (pleine).
 *
 * ⚠️ Un choix d'apparence, pas une grandeur : la carte pleine tirait trop sur
 * l'orange. Le gris scotopique, lui, a ete ecarte — voir le nuanceur.
 */
const MILKY_WAY_SATURATION = 0.5
const MU_BRIGHT = RAW.muBright
const MU_STEP = RAW.muStep
/**
 * URL de la carte, avec son empreinte : une carte en cache d'une version
 * precedente serait lue avec le decodage de celle-ci — une premiere version en
 * niveaux de gris, lue comme teinte, rendait la Voie lactee verte.
 */
const MILKY_WAY_URL = `textures/milky-way.png?v=${RAW.hash}`

/**
 * Ecart entre brillance de surface et magnitude du flux tombant dans l'aire de
 * sommation. La Voie lactee est bien plus grande que cette aire : aucun
 * plafond par l'objet ne joue, contrairement au ciel profond.
 */
const SUMMATION_OFFSET = 2.5 * Math.log10(EYE_SUMMATION_SR / ARCSEC2_STERADIAN)
/** Idem pour la tache de diffusion de l'oeil — ce qui decide de l'eclat. */
const SPREAD_OFFSET = 2.5 * Math.log10(EYE_POINT_SPREAD_SR / ARCSEC2_STERADIAN)

let cached: Texture | null = null
let pending: Promise<Texture> | null = null

function loadMilkyWay(): Promise<Texture> {
  if (cached) return Promise.resolve(cached)
  if (pending) return pending
  pending = new Promise<Texture>((resolve, reject) => {
    new TextureLoader().load(
      MILKY_WAY_URL,
      (texture) => {
        // L'octet est une magnitude : aucun decodage sRGB, qui la courberait.
        texture.colorSpace = NoColorSpace
        // Des mipmaps, cette fois : c'est une nappe continue, et a champ large
        // plusieurs texels tombent dans un pixel. Moyenner des magnitudes
        // revient a une moyenne geometrique du flux, a peine plus sombre.
        texture.generateMipmaps = true
        texture.minFilter = LinearMipmapLinearFilter
        texture.magFilter = LinearFilter
        texture.wrapS = RepeatWrapping
        texture.wrapT = ClampToEdgeWrapping
        cached = texture
        resolve(texture)
      },
      undefined,
      (err) => {
        pending = null
        reject(err)
      },
    )
  })
  return pending
}

export function MilkyWay({
  date,
  location,
  limitingMagnitude,
  aerosolTurbidity,
  extinction = true,
  skyGlow,
}: {
  date: Date
  location: GeoLocation
  /** Magnitude limite du ciel courant — c'est elle qui porte pollution, Lune et crepuscule. */
  limitingMagnitude: number
  aerosolTurbidity: number
  /** Sans atmosphere, rien ne l'eteint. */
  extinction?: boolean
  /** Fond de ciel au zenith : il s'eclaircit vers l'horizon, et la Voie lactee s'y noie. */
  skyGlow: SkyGlow
}) {
  const meshRef = useRef<Mesh>(null)
  const matrix = useRef(new Matrix4())
  const [texture, setTexture] = useState<Texture | null>(cached)
  const { camera, size } = useThree()

  useEffect(() => {
    let alive = true
    loadMilkyWay()
      .then((t) => alive && setTexture(t))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Assez fine pour que la refraction, appliquee par sommet, reste lisse pres
  // de l'horizon : un demi-degre de refraction sur une maille de trois degres.
  const geometry = useMemo(() => new SphereGeometry(SKY_RADIUS, 128, 64), [])

  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
        side: BackSide,
        uniforms: {
          ...refractionUniforms(),
          ...skyGlowUniforms(),
          uMap: { value: null as Texture | null },
          uLimitMag: { value: limitingMagnitude },
          uInstrumentGain: { value: 0 },
          uExtinctionK: { value: extinctionCoefficient(aerosolTurbidity) },
        },
        vertexShader: /* glsl */ `
          ${REFRACTION_LUT_GLSL}
          ${SKY_GLOW_GLSL}
          uniform float uExtinctionK;
          varying vec3 vEquatorial;
          varying float vAirmass;
          varying float vLimitShift;
          void main() {
            // La position du sommet **est** une direction equatoriale : x vers
            // l'equinoxe, z vers le pole nord celeste. La sphere n'a pas
            // d'orientation propre, seule la matrice du groupe tourne.
            vEquatorial = position;
            vec4 world = modelMatrix * vec4(position, 1.0);
            float trueAltDeg = degrees(asin(clamp(normalize(world.xyz).y, -1.0, 1.0)));
            vAirmass = min(airmassAt(trueAltDeg), 12.0);
            // Le ciel local : sous un ciel de banlieue, c'est ce qui eteint le
            // Sagittaire, bas sur l'horizon europeen, avant le Cygne au zenith.
            vLimitShift = limitShiftAt(trueAltDeg, vAirmass, uExtinctionK);
            world.xyz = refractSceneDirection(world.xyz);
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: /* glsl */ `
          ${DISPLAY_TONEMAP_GLSL}
          #define PI 3.141592653589793
          uniform sampler2D uMap;
          uniform float uLimitMag;
          uniform float uInstrumentGain;
          uniform float uExtinctionK;
          varying vec3 vEquatorial;
          varying float vAirmass;
          varying float vLimitShift;

          void main() {
            vec3 d = normalize(vEquatorial);
            // Carte equirectangulaire : ascension droite croissante vers la
            // droite a partir de 0, nord en haut (la texture est retournee au
            // chargement, d'ou v = 0,5 + dec/π).
            float u = fract(atan(d.y, d.x) / (2.0 * PI));
            float v = 0.5 + asin(clamp(d.z, -1.0, 1.0)) / PI;
            // ⚠️ A 0 h d'ascension droite, u saute de 1 a 0 : sa derivee y
            // explose, et le filtrage choisirait la plus petite mipmap — un trait
            // le long de la couture. On prend la derivee d'une seconde
            // coordonnee, centree sur la couture, la ou elle est plus petite.
            float uAlt = fract(u + 0.5) - 0.5;
            vec2 gx = vec2(abs(dFdx(uAlt)) < abs(dFdx(u)) ? dFdx(uAlt) : dFdx(u), dFdx(v));
            vec2 gy = vec2(abs(dFdy(uAlt)) < abs(dFdy(u)) ? dFdy(uAlt) : dFdy(u), dFdy(v));
            vec3 texel = textureGrad(uMap, vec2(u, v), gx, gy).rgb;
            float q = texel.r * 255.0;
            // L'octet plein marque « sous la plage codee » : rien a dessiner.
            if (q > 254.5) discard;
            float mu = ${MU_BRIGHT.toFixed(3)} + q * ${MU_STEP.toFixed(4)};

            // Seul l'exces sur le zenith se compare a la limite, comme pour les
            // etoiles et le ciel profond — voir \`visibilityExtinction\`.
            float extinction = uExtinctionK * (vAirmass - 1.0);
            float sb = mu + extinction;

            // La loi du ciel profond, branche etendue, sans plafond par l'objet.
            float mSeen = sb - ${SPREAD_OFFSET.toFixed(4)};
            float mDetect = sb - ${SUMMATION_OFFSET.toFixed(4)};
            float limit = uLimitMag - vLimitShift + uInstrumentGain;
            float rel = pow(10.0, -0.4 * (mSeen - limit));
            float gate = 1.0 - smoothstep(${POINT_VISIBILITY_FADE_START.toFixed(1)}, ${POINT_VISIBILITY_FADE_END.toFixed(1)}, mDetect - limit);
            float alpha = clamp(${POINT_BRIGHTNESS_SCALE} * log(1.0 + rel) * gate, 0.0, 1.0);
            if (alpha < 1e-5) discard;

            // --- La couleur : celle de la carte, comme dans Stellarium --------
            //
            // ⚠️ Pas de desaturation scotopique. A 20 mag/arcsec² la Voie lactee
            // vaut 10⁻³ cd/m², sous le plafond ou les cones decrochent, et un
            // oeil la voit grise ; le rendu le faisait, et le ciel entier
            // tournait au noir et blanc. On montre ici la teinte que ses etoiles
            // lui donnent — le bulbe plus chaud, les bras plus bleus — comme le
            // font les planetariums.
            //
            // Canaux vert et bleu : \`log2(R/V)\` et \`log2(B/V)\` sur
            // ±${RAW.chromaRange}, lisses sur un degre. La luminance reste dans le
            // rouge, intacte.
            float lr = (texel.g * 2.0 - 1.0) * ${RAW.chromaRange.toFixed(2)};
            float lb = (texel.b * 2.0 - 1.0) * ${RAW.chromaRange.toFixed(2)};
            // ⚠️ Saturation ramenee a MILKY_WAY_SATURATION : pleine, la teinte de
            // la carte — ses couleurs Gaia sont equilibrees « a l'oeil » par la
            // NASA — tirait trop sur l'orange dans les poussieres. Choix
            // d'apparence, assume comme tel.
            vec3 base = vec3(exp2(lr * ${MILKY_WAY_SATURATION.toFixed(2)}), 1.0, exp2(lb * ${MILKY_WAY_SATURATION.toFixed(2)}));
            // Rougissement par l'extinction, la meme loi que les etoiles.
            float xr = max(0.0, vAirmass - 1.0);
            vec3 tinted = base * vec3(1.0, exp(-0.035 * xr), exp(-0.085 * xr));
            // Luminance unite : la cale ne porte que la luminance, la teinte
            // passe par le lineaire — meme separation que le ciel profond.
            vec3 chroma = tinted / max(1e-6, dot(tinted, vec3(0.2126, 0.7152, 0.0722)));
            gl_FragColor = vec4(chroma * radianceFromDisplay(vec3(1.0)), alpha);
          }
        `,
      }),
    // Tout ce qui change passe par les uniformes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useEffect(() => {
    material.uniforms.uMap.value = texture
  }, [texture, material])

  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh) return
    equatorialToSceneMatrix(date, location, matrix.current)
    mesh.matrix.copy(matrix.current)
    mesh.matrixAutoUpdate = false
    mesh.matrixWorldNeedsUpdate = true

    const fov = ((camera as PerspectiveCamera).fov * Math.PI) / 180
    const pixelsPerRadian = size.height / (2 * Math.tan(fov / 2))
    material.uniforms.uLimitMag.value = limitingMagnitude
    applySkyGlow(material.uniforms as unknown as ReturnType<typeof skyGlowUniforms>, skyGlow)
    material.uniforms.uInstrumentGain.value = instrumentGainMag(1 / pixelsPerRadian)
    material.uniforms.uExtinctionK.value = extinction ? extinctionCoefficient(aerosolTurbidity) : 0
    applyRefractionUniforms(material.uniforms as Parameters<typeof applyRefractionUniforms>[0])
  })

  if (!texture) return null
  return <mesh ref={meshRef} geometry={geometry} material={material} frustumCulled={false} renderOrder={1} />
}
