import { useEffect, useMemo, useRef } from 'react'
import {
  AdditiveBlending,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { buildDeepSkyGeometry, DEEP_SKY_INDEX } from '@/astro/deepsky'
import { bvToRgb } from '@/astro/catalog'
import {
  EXTINCTION_COEFFICIENT,
  POINT_BRIGHTNESS_SCALE,
  POINT_VISIBILITY_FADE_END,
  POINT_VISIBILITY_FADE_START,
} from '@/astro/photometry'
import {
  ARCSEC2_STERADIAN,
  EYE_POINT_SPREAD_SR,
  PHOTOPIC_FLOOR,
  SCOTOPIC_CEILING,
  ZERO_MAGNITUDE_LUX,
} from './display/adaptation'
import { instrumentGainMag } from './display/instrument'
import { effectiveSummationSr } from './display/extendedVision'
import {
  DSO_ATLAS_MARGIN,
  DSO_PROFILE_HI_DEX,
  DSO_PROFILE_LO_DEX,
  atlasRectOf,
  useDeepSkyAtlas,
} from './deepSkyAtlas'
import type { GeoLocation } from '@/astro/types'
import { DISPLAY_TONEMAP_GLSL } from './display/tonemap'
import { REFRACTION_LUT_GLSL } from '@/atmosphere/refraction/refractionTable'
import { applyRefractionUniforms, refractionUniforms } from './refractionTexture'
import { equatorialToSceneMatrix, SKY_RADIUS } from './sceneMath'

const DEG = Math.PI / 180
const ARCMIN = DEG / 60

/**
 * Taille minimale du quad, en radians.
 *
 * Le maillage instancie ne peut pas grandir avec le champ : chaque quad est
 * dimensionne une fois pour toutes. On lui donne donc un plancher assez large
 * pour contenir, au champ le plus ouvert, la tache de quelques pixels par
 * laquelle un objet non resolu se signale. Le nuanceur ne dessine a l'interieur
 * que l'ellipse reelle, ou ce point.
 */
const QUAD_FLOOR = 8 * ARCMIN

/**
 * Indice de couleur median du catalogue, pour les objets qui n'en ont pas.
 *
 * ⚠️ Treize pour cent des objets de l'atlas n'ont pas de magnitude B. Leur
 * donner la mediane de ceux qui en ont vaut mieux que d'inventer une teinte :
 * c'est la couleur d'un objet quelconque du lot, et rien de plus.
 */
const MEDIAN_COLOUR_INDEX = (() => {
  const bv: number[] = []
  for (const o of DEEP_SKY_INDEX) {
    if (o.blueMagnitude !== null && Number.isFinite(o.magnitude)) bv.push(o.blueMagnitude - o.magnitude)
  }
  bv.sort((x, y) => x - y)
  return bv.length ? bv[bv.length >> 1] : 0.56
})()

/**
 * Couleur d'un objet, depuis son indice de couleur B−V.
 *
 * ⚠️ **Elle venait d'un jeton d'interface** — un par type d'objet, si bien que
 * toutes les galaxies partageaient une teinte decidee dans une feuille de
 * style. Le catalogue porte pourtant des magnitudes B **calibrees** pour 87 %
 * des objets de l'atlas : B−V donne une vraie couleur, par la meme conversion
 * que les etoiles.
 *
 * ⚠️ Ce que cette conversion suppose : que l'objet rayonne comme un corps noir.
 * C'est defendable pour une galaxie, dont la lumiere est la somme de celle de
 * ses etoiles ; c'est **faux** pour une nebuleuse a emission, qui rayonne en
 * raies. Le sens de la teinte reste bon — Halpha rougit, et B−V le voit — mais
 * pas sa saturation.
 */
function colourFor(catalogueIndex: number): [number, number, number] {
  const o = DEEP_SKY_INDEX[catalogueIndex]
  const bv =
    o && o.blueMagnitude !== null && Number.isFinite(o.magnitude)
      ? o.blueMagnitude - o.magnitude
      : MEDIAN_COLOUR_INDEX
  return bvToRgb(bv)
}

/**
 * Objets du ciel profond, dessines a leur taille apparente reelle.
 *
 * Un maillage instancie unique porte les 1 700 objets : chaque instance est un
 * quad oriente vers l'observateur et mis a l'echelle des deux axes de l'objet,
 * ce qui donne l'ellipse sans geometrie dediee. Les matrices d'instance sont
 * calculees dans le repere equatorial, donc **une seule fois** — la rotation
 * diurne est portee par la matrice du groupe, comme pour les etoiles.
 *
 * La visibilite ne suit pas la magnitude integree mais la **brillance de
 * surface** comparee a celle du fond de ciel : c'est ce qui fait qu'une galaxie
 * de magnitude 3,4 etalee sur trois degres reste discrete, et qu'elle disparait
 * de jour sans traitement particulier.
 */
export function DeepSky({
  date,
  location,
  magnitudeLimit,
  limitingMagnitude,
  aerosolTurbidity,
}: {
  date: Date
  location: GeoLocation
  magnitudeLimit: number
  /**
   * Magnitude limite du ciel courant.
   *
   * C'est par elle que la brillance du fond entre desormais : un objet etendu
   * se detecte quand le flux d'un element de resolution la depasse, exactement
   * comme une etoile. L'eclairement n'a plus a etre passe separement.
   */
  limitingMagnitude: number
  /**
   * Trouble atmospherique.
   *
   * Il entre ici pour la meme raison que dans les etoiles : un ciel plus charge
   * en aerosols eteint davantage, et c'est le meme phenomene qui blanchit
   * l'horizon.
   */
  aerosolTurbidity: number
}) {
  const meshRef = useRef<InstancedMesh>(null)
  const matrix = useRef(new Matrix4())

  const { geometry, material, count } = useMemo(() => {
    const data = buildDeepSkyGeometry(date, magnitudeLimit)
    const n = data.count

    const plane = new PlaneGeometry(1, 1)
    const semiMajor = new Float32Array(n)
    const semiMinor = new Float32Array(n)
    const quadSemi = new Float32Array(n)
    const colors = new Float32Array(n * 3)
    /**
     * Rectangle de l'objet dans l'atlas — `[u0, v0, du, dv]`.
     *
     * Une etendue nulle signale un objet sans image : le profil analytique
     * prend alors le relais.
     */
    const rects = new Float32Array(n * 4)
    /**
     * Ecart entre brillance de surface et magnitude de l'element de detection.
     *
     * `2,5·log10(Omega_eff)` — voir display/extendedVision.ts. Calcule par
     * instance plutot que dans le nuanceur : il ne depend que du catalogue.
     */
    const elementOffset = new Float32Array(n)

    for (let k = 0; k < n; k++) {
      const a = Math.max(data.semiMajor[k], 0)
      const b = Math.max(data.semiMinor[k], 0)
      semiMajor[k] = a
      semiMinor[k] = b > 0 ? b : a
      // Le quad est carre : il doit contenir le grand axe quelle que soit la
      // rotation, la marge de cadrage de l'atlas, et le plancher quand l'objet
      // n'est pas resolu.
      quadSemi[k] = Math.max(a * DSO_ATLAS_MARGIN, QUAD_FLOOR)
      // Angle solide de l'ellipse ; l'aire de sommation de l'oeil le plafonne.
      const omega = effectiveSummationSr(Math.PI * a * (b > 0 ? b : a)) / ARCSEC2_STERADIAN
      elementOffset[k] = 2.5 * Math.log10(omega)

      const rect = atlasRectOf(data.indices[k])
      if (rect) rects.set(rect, k * 4)

      const [r, g, bl] = colourFor(data.indices[k])
      colors[k * 3] = r
      colors[k * 3 + 1] = g
      colors[k * 3 + 2] = bl
    }

    plane.setAttribute('aSemiMajor', new InstancedBufferAttribute(semiMajor, 1))
    plane.setAttribute('aSemiMinor', new InstancedBufferAttribute(semiMinor, 1))
    plane.setAttribute('aQuadSemi', new InstancedBufferAttribute(quadSemi, 1))
    plane.setAttribute('aMag', new InstancedBufferAttribute(data.magnitudes.slice(), 1))
    plane.setAttribute('aSb', new InstancedBufferAttribute(data.surfaceBrightness.slice(), 1))
    plane.setAttribute('aExtended', new InstancedBufferAttribute(data.extended.slice(), 1))
    plane.setAttribute('aColor', new InstancedBufferAttribute(colors, 3))
    plane.setAttribute('aRect', new InstancedBufferAttribute(rects, 4))
    plane.setAttribute('aElementOffset', new InstancedBufferAttribute(elementOffset, 1))

    const shader = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        ...refractionUniforms(),
        uLimitMag: { value: limitingMagnitude },
        /** Gain de l'instrument que le champ implique, magnitudes. */
        uInstrumentGain: { value: 0 },
        /** Pixels par radian : convertit une taille angulaire en taille ecran. */
        uPixelsPerRadian: { value: 1000 },
        uMinPixelRadius: { value: 1.4 },
        /** Coefficient d'extinction, magnitudes par masse d'air. */
        uExtinctionK: { value: EXTINCTION_COEFFICIENT },
        /** Atlas de profils, charge en tache de fond — nul tant qu'il n'est pas la. */
        uAtlas: { value: null as unknown as null },
        uHasAtlas: { value: 0 },
      },
      vertexShader: /* glsl */ `
        ${REFRACTION_LUT_GLSL}
        attribute float aSemiMajor;
        attribute float aSemiMinor;
        attribute float aQuadSemi;
        attribute float aMag;
        attribute float aSb;
        attribute float aExtended;
        attribute vec3 aColor;
        attribute vec4 aRect;
        attribute float aElementOffset;

        varying vec2 vUv;
        varying vec3 vColor;
        varying float vSemiMajor;
        varying float vSemiMinor;
        varying float vQuadSemi;
        varying float vMag;
        varying float vSb;
        varying float vExtended;
        varying float vAirmass;
        varying vec4 vRect;
        varying float vElementOffset;

        void main() {
          vUv = uv * 2.0 - 1.0;
          vRect = aRect;
          vElementOffset = aElementOffset;
          vColor = aColor;
          vSemiMajor = aSemiMajor;
          vSemiMinor = aSemiMinor;
          vQuadSemi = aQuadSemi;
          vMag = aMag;
          vSb = aSb;
          vExtended = aExtended;
          // Meme redressement que les etoiles : un amas doit rester au milieu
          // des etoiles qui le composent, y compris pres de l'horizon.
          vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
          // ⚠️ La hauteur **vraie**, relevee avant le redressement : c'est elle
          // qui donne la masse d'air, et la refraction ne change pas le trajet
          // parcouru dans l'atmosphere.
          //
          // La table est lue **ici** et non dans le fragment, comme pour les
          // etoiles : le plafond de douze est le leur, pour que les deux
          // calques s'eteignent ensemble au ras de l'horizon.
          float trueAltDeg = degrees(asin(clamp(normalize(world.xyz).y, -1.0, 1.0)));
          vAirmass = min(airmassAt(trueAltDeg), 12.0);
          world.xyz = refractSceneDirection(world.xyz);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        ${DISPLAY_TONEMAP_GLSL}
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vSemiMajor;
        varying float vSemiMinor;
        varying float vQuadSemi;
        varying float vMag;
        varying float vSb;
        varying float vExtended;
        varying float vAirmass;
        varying vec4 vRect;
        varying float vElementOffset;

        uniform float uExtinctionK;
        uniform float uLimitMag;
        uniform float uInstrumentGain;
        uniform float uPixelsPerRadian;
        uniform float uMinPixelRadius;
        uniform sampler2D uAtlas;
        uniform float uHasAtlas;

        /** Transfert sRVB inverse, exact — les couleurs de catalogue y sont encodees. */
        vec3 srgbToLinear(vec3 c) {
          return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
        }

        void main() {
          // Taille angulaire minimale pour rester perceptible a l'ecran : en
          // deca, l'objet se signale comme un point plutot que de disparaitre.
          float minAngular = uMinPixelRadius / max(uPixelsPerRadian, 1.0);
          float a = max(vSemiMajor, minAngular);
          float b = max(vSemiMinor, minAngular);

          // vUv couvre le quad ; on le ramene en unites angulaires, puis on
          // normalise par les demi-axes : la distance obtenue vaut 1 sur l'ellipse.
          vec2 angular = vUv * vQuadSemi;
          float d = length(vec2(angular.x / b, angular.y / a));
          // ⚠️ On dessine au-dela de l'ellipse du catalogue, jusqu'a la marge du
          // cadrage : un objet reel ne s'arrete pas a son ellipse, et la couper
          // net laissait un bord franc et decoupe.
          if (d > ${DSO_ATLAS_MARGIN.toFixed(3)}) discard;

          // --- L'extinction atmospherique ------------------------------------
          //
          // ⚠️ **Ce calque l'ignorait entierement.** Il etait le seul du moteur
          // dans ce cas : les etoiles, les astres, le fond de ciel et le terrain
          // y passent tous. Une galaxie brillait donc autant a l'horizon qu'au
          // zenith.
          //
          // Pour une source **etendue**, l'extinction s'applique a la brillance
          // de surface exactement comme a une magnitude : elle attenue la
          // radiance le long du rayon, et l'angle solide, lui, ne change pas.
          //
          //     mu_observee = mu_intrinseque + k · X
          //
          float extinction = uExtinctionK * vAirmass;
          float sbObserved = vSb + extinction;

          // --- Le profil : l'image du releve, ou le modele --------------------
          //
          // ⚠️ L'atlas ne porte **pas** une luminance. Il porte l'ecart local a
          // la brillance moyenne de l'objet, en magnitudes — c'est le moteur
          // qui garde la main sur le niveau absolu, comme pour l'orthophoto
          // drapee sur le terrain.
          //
          //     mu_locale = mu_moyenne − 2,5·log10(p)
          //
          // La tuile couvre exactement le grand axe du catalogue, l'ellipse y
          // etant inscrite ; on projette donc l'ellipse **dessinee** sur celle
          // de la tuile, ce qui reste juste meme quand le plancher de taille
          // apparente a elargi la premiere.
          bool image = uHasAtlas > 0.5 && vRect.z > 0.0;
          float dex = 0.0;
          if (image) {
            float rapport = vSemiMinor / max(vSemiMajor, 1e-9);
            vec2 tile = vec2((angular.x / b) * rapport, angular.y / a) /
                        ${DSO_ATLAS_MARGIN.toFixed(3)} * 0.5 + 0.5;
            // Le rectangle porte deja le retrait d'un demi-texel.
            vec2 uvAtlas = vRect.xy + clamp(tile, 0.0, 1.0) * vRect.zw;
            float q = texture2D(uAtlas, uvAtlas).r;
            dex = ${DSO_PROFILE_LO_DEX.toFixed(1)} +
                  q * ${(DSO_PROFILE_HI_DEX - DSO_PROFILE_LO_DEX).toFixed(1)};
          }
          float sbLocal = sbObserved - 2.5 * dex;

          // --- Une seule loi, et c'est celle des etoiles ----------------------
          //
          // ⚠️ Ce calque avait la sienne : un contraste decale de 1,5 puis
          // divise par 3,5, plafonne, multiplie par 0,42. Trois constantes
          // inventees, et une saturation atteinte des deux magnitudes
          // au-dessus du fond : le coeur de M31 rendait **169 niveaux sur
          // un ciel a 0**.
          //
          // Un objet etendu se detecte quand le flux tombant dans l'aire sur
          // laquelle l'oeil **somme** passe le seuil, exactement comme une
          // source ponctuelle — voir display/extendedVision.ts, ou cette aire
          // est deduite d'un ancrage observationnel et plafonnee par l'objet
          // lui-meme.
          //
          //     m_element = mu − 2,5·log10(Omega_eff)
          //
          // Les deux branches deviennent alors la meme courbe : un objet plus
          // petit que l'aire de sommation retombe exactement sur sa magnitude
          // integree. Il ne reste plus aucune constante propre au ciel profond.
          // ⚠️ **Detecter et paraitre brillant sont deux questions distinctes**,
          // et les confondre est ce qui rendait le coeur de M31 a 80 % du blanc
          // sous un ciel vierge, la ou l'oeil ne voit qu'une lueur.
          //
          // **Detecter** profite de la sommation : c'est le flux tombant dans
          // l'aire sur laquelle l'oeil integre qui passe le seuil.
          //
          // **Paraitre brillant** n'en profite pas. Ce que l'oeil ressent, c'est
          // la luminance sur la retine — et pour une source etendue, l'image
          // retinienne a la meme brillance de surface que l'objet, quelle que
          // soit sa taille. La grandeur comparable est donc le flux dans la
          // seule tache de diffusion.
          //
          // Pour une source ponctuelle les deux coincident, et l'on retombe
          // exactement sur la loi des etoiles.
          float mSeen = vExtended > 0.5
            ? sbLocal - ${(2.5 * Math.log10(EYE_POINT_SPREAD_SR / ARCSEC2_STERADIAN)).toFixed(4)}
            : vMag + extinction;
          float mDetect = vExtended > 0.5 ? sbLocal - vElementOffset : vMag + extinction;

          // L'instrument que le champ implique deplace la limite — voir
          // display/instrument.ts. A champ large il est nul, et le rendu est
          // exactement celui de l'oeil ; en zoomant, l'ouverture requise
          // depasse la pupille et l'objet se leve.
          float limit = uLimitMag + uInstrumentGain;
          float rel = pow(10.0, -0.4 * (mSeen - limit));
          float gate = 1.0 - smoothstep(${POINT_VISIBILITY_FADE_START.toFixed(1)}, ${POINT_VISIBILITY_FADE_END.toFixed(1)}, mDetect - limit);
          float opacity = clamp(${POINT_BRIGHTNESS_SCALE} * log(1.0 + rel) * gate, 0.0, 1.0);

          float falloff;
          if (image) {
            // Le profil est deja dans la brillance locale ; l'image porte de
            // vraies valeurs jusqu'a la marge, et l'on n'eteint que le tout
            // dernier liseré, la ou la tuile s'arrete.
            // Le fondu enjambe la frontiere de l'ellipse au lieu de commencer
            // apres elle : sinon les etoiles de champ restent vives jusqu'a la
            // coupe, et le bord ressort dentele.
            falloff = 1.0 - smoothstep(0.9, ${DSO_ATLAS_MARGIN.toFixed(3)}, d);
          } else {
            // Sans image : noyau concentre et halo etendu, plutot qu'un disque
            // uni. C'est ainsi que se presente une galaxie ou un amas — la
            // brillance chute vite depuis le centre, et le bord n'existe pas.
            float core = exp(-d * d * 9.0);
            float halo = exp(-d * d * 2.0) * 0.35;
            falloff = (core + halo) * (1.0 - smoothstep(0.8, 1.0, d));
          }
          float alpha = falloff * opacity;
          if (alpha < 0.004) discard;

          // --- La couleur, et pourquoi elle doit s'en aller ------------------
          //
          // ⚠️ **A l'oeil nu, un objet du ciel profond est gris.** Sa brillance
          // de surface le place en plein regime scotopique, ou les cones ne
          // repondent plus : seule une pose longue en revele la teinte. Le
          // moteur applique deja cette loi aux etoiles et au fond de ciel ; ce
          // calque y echappait, et rendait la chromaticite pleine d'un jeton
          // d'interface.
          //
          // Contrairement a une etoile, un objet etendu **a** une luminance : sa
          // brillance de surface en donne une directement, sans passer par la
          // tache de diffusion de l'oeil.
          //
          //     L = E_mag0 · 10^(−0,4·mu) / (1 arcsec² en steradians)
          //
          // Verification : 22 mag/arcsec² rend 1,71·10⁻⁴ cd/m², contre 1,7·10⁻⁴
          // publie pour un ciel tres noir.
          // C'est la brillance **locale** qui decide : le coeur d'une nebuleuse
          // peut franchir le plafond scotopique quand ses bords n'y sont pas.
          //
          // Meme expression que pour une etoile, et pour cause : m_seen ramene
          // les deux cas au flux tombant dans la tache de diffusion.
          float retinal = ${ZERO_MAGNITUDE_LUX.toExponential(6)} *
                          pow(10.0, -0.4 * mSeen) /
                          ${EYE_POINT_SPREAD_SR.toExponential(6)};
          float mesopic = log2(max(1e-9, retinal) / ${SCOTOPIC_CEILING.toFixed(4)}) /
                          log2(${PHOTOPIC_FLOOR.toFixed(1)} / ${SCOTOPIC_CEILING.toFixed(4)});
          float rods = 1.0 - smoothstep(0.0, 1.0, mesopic);

          // --- ⚠️ Un capteur n'a pas de batonnets --------------------------
          //
          // Le gris du ciel profond est une propriete de **l'oeil** : sous le
          // plafond scotopique, les cones ne repondent plus. Un capteur ne
          // connait pas cette limite, et la loi mesopique cesse donc de
          // s'appliquer a mesure qu'il prend le relais de la pupille.
          //
          // La part qu'il prend se deduit, elle ne se regle pas : c'est la
          // fraction de la lumiere que l'oeil seul n'aurait pas pu collecter.
          //
          //     part = 1 − (D_oeil / D)² = 1 − 10^(−0,4·gain)
          //
          // Nulle a champ large — le rendu reste exactement celui de l'oeil, et
          // une galaxie y est grise comme elle doit l'etre.
          float sensor = 1.0 - pow(10.0, -0.4 * uInstrumentGain);
          rods *= 1.0 - sensor;

          // Rougissement par l'extinction, normalise sur le rouge — la meme loi
          // que les etoiles.
          float xr = max(0.0, vAirmass - 1.0);
          vec3 tinted = vColor * vec3(1.0, exp(-0.035 * xr), exp(-0.085 * xr));
          vec3 seen = mix(tinted, vec3(dot(tinted, vec3(0.2126, 0.7152, 0.0722))), rods);

          // --- ⚠️ La cale de transition ne conserve pas la teinte -----------
          //
          // La cale inverse la courbe d affichage **canal par
          // canal**. C'est exact quand la couleur ressort telle quelle, mais
          // ici elle est multipliee par une opacite faible, et l'inversion
          // diverge des qu'un canal touche un : la conversion B−V rend un rouge
          // a un, et le rapport 1 : 0,91 : 0,83 devenait **1 : 0,26 : 0,15**.
          // Une galaxie a peine jaune sortait orange vif.
          //
          // On separe donc les deux : la cale ne porte que la **luminance**, la
          // teinte passe par le lineaire, ou elle a un sens physique.
          float luma = dot(seen, vec3(0.2126, 0.7152, 0.0722));
          vec3 linear = srgbToLinear(seen);
          vec3 chroma = linear / max(1e-6, dot(linear, vec3(0.2126, 0.7152, 0.0722)));
          gl_FragColor = vec4(chroma * radianceFromDisplay(vec3(luma)), alpha);
        }
      `,
    })

    return { geometry: plane, material: shader, count: n }
    // La precession est imperceptible a l'echelle d'une session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date.getUTCFullYear(), magnitudeLimit])

  // L'atlas arrive apres le premier rendu ; d'ici la, le profil analytique tient.
  const atlas = useDeepSkyAtlas()
  useEffect(() => {
    material.uniforms.uAtlas.value = atlas as never
    material.uniforms.uHasAtlas.value = atlas ? 1 : 0
  }, [atlas, material])

  // Pose des matrices d'instance, une seule fois apres construction du maillage.
  const posed = useRef<number | null>(null)
  const { camera, size } = useThree()

  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh) return

    if (posed.current !== count) {
      const data = buildDeepSkyGeometry(date, magnitudeLimit)
      const instance = new Matrix4()
      const position = new Vector3()
      const toObserver = new Vector3()
      const north = new Vector3()
      const east = new Vector3()
      const axisX = new Vector3()
      const axisY = new Vector3()
      const basis = new Matrix4()
      const quaternion = new Quaternion()
      const scale = new Vector3()

      for (let k = 0; k < data.count; k++) {
        const x = data.positions[k * 3]
        const y = data.positions[k * 3 + 1]
        const z = data.positions[k * 3 + 2]
        position.set(x, y, z).multiplyScalar(SKY_RADIUS)

        const dec = Math.asin(Math.min(1, Math.max(-1, z)))
        const ra = Math.atan2(y, x)
        north.set(-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)).normalize()
        east.set(-Math.sin(ra), Math.cos(ra), 0).normalize()

        const pa = data.angle[k]
        axisY.copy(north).multiplyScalar(Math.cos(pa)).addScaledVector(east, Math.sin(pa)).normalize()
        toObserver.copy(position).multiplyScalar(-1).normalize()
        axisX.crossVectors(axisY, toObserver).normalize()

        basis.makeBasis(axisX, axisY, toObserver)
        quaternion.setFromRotationMatrix(basis)

        const quad = Math.max(data.semiMajor[k], QUAD_FLOOR)
        const world = 2 * SKY_RADIUS * quad
        scale.set(world, world, 1)

        instance.compose(position, quaternion, scale)
        mesh.setMatrixAt(k, instance)
      }
      mesh.instanceMatrix.needsUpdate = true
      posed.current = count
    }

    equatorialToSceneMatrix(date, location, matrix.current)
    mesh.matrix.copy(matrix.current)
    mesh.matrixAutoUpdate = false
    mesh.matrixWorldNeedsUpdate = true

    const fov = (camera as PerspectiveCamera).fov * DEG
    const pixelsPerRadian = size.height / (2 * Math.tan(fov / 2))
    material.uniforms.uPixelsPerRadian.value = pixelsPerRadian
    material.uniforms.uLimitMag.value = limitingMagnitude
    // L'ouverture minimale capable de resoudre un pixel affiche — nulle tant
    // que l'oeil y suffit, c'est-a-dire au-dela de cinq degres de champ.
    material.uniforms.uInstrumentGain.value = instrumentGainMag(1 / pixelsPerRadian)
    // Le meme coefficient que les etoiles, trouble compris : les deux calques
    // doivent s'eteindre ensemble.
    material.uniforms.uExtinctionK.value = EXTINCTION_COEFFICIENT * aerosolTurbidity
    // La meme table que les etoiles : un amas doit rester au milieu des etoiles
    // qui le composent.
    applyRefractionUniforms(material.uniforms as Parameters<typeof applyRefractionUniforms>[0])
  })

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      frustumCulled={false}
      renderOrder={3}
    />
  )
}
