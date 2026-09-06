import { useEffect, useMemo, useRef } from 'react'
import {
  AdditiveBlending,
  Color,
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
import { buildDeepSkyGeometry, DEEP_SKY_TYPES } from '@/astro/deepsky'
import {
  EXTINCTION_COEFFICIENT,
  POINT_BRIGHTNESS_SCALE,
  POINT_VISIBILITY_FADE_END,
  POINT_VISIBILITY_FADE_START,
  skySurfaceBrightness,
} from '@/astro/photometry'
import {
  ARCSEC2_STERADIAN,
  PHOTOPIC_FLOOR,
  SCOTOPIC_CEILING,
  ZERO_MAGNITUDE_LUX,
} from './display/adaptation'
import {
  DSO_ATLAS_GRID,
  DSO_ATLAS_TILE,
  DSO_PROFILE_HI_DEX,
  DSO_PROFILE_LO_DEX,
  atlasSlotOf,
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

/** Couleur par type OpenNGC, resolue depuis les tokens applicatifs. */
function typeColorTokens(): Record<string, string> {
  return {
    G: '--app-dso-galaxy',
    GPair: '--app-dso-galaxy',
    GTrpl: '--app-dso-galaxy',
    GGroup: '--app-dso-galaxy',
    GCl: '--app-dso-cluster-globular',
    OCl: '--app-dso-cluster-open',
    'Cl+N': '--app-dso-nebula-emission',
    PN: '--app-dso-nebula-planetary',
    Neb: '--app-dso-nebula-reflection',
    HII: '--app-dso-nebula-emission',
    EmN: '--app-dso-nebula-emission',
    RfN: '--app-dso-nebula-reflection',
    DrkN: '--app-dso-default',
    SNR: '--app-dso-supernova',
    Nova: '--app-dso-supernova',
    Other: '--app-dso-default',
  }
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
  illuminance,
  aerosolTurbidity,
  resolveToken,
}: {
  date: Date
  location: GeoLocation
  magnitudeLimit: number
  limitingMagnitude: number
  illuminance: number
  /**
   * Trouble atmospherique.
   *
   * Il entre ici pour la meme raison que dans les etoiles : un ciel plus charge
   * en aerosols eteint davantage, et c'est le meme phenomene qui blanchit
   * l'horizon.
   */
  aerosolTurbidity: number
  /** Resolution d'un token CSS en couleur — injectee pour suivre le theme. */
  resolveToken: (token: string, fallback?: string) => string
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
    /** Emplacement dans l'atlas d'images, −1 pour les objets qui n'en ont pas. */
    const slots = new Float32Array(n)

    const tokens = typeColorTokens()
    const paletteCache = new Map<string, Color>()
    const colorFor = (typeIndex: number) => {
      const type = DEEP_SKY_TYPES[typeIndex] ?? 'Other'
      const cached = paletteCache.get(type)
      if (cached) return cached
      const color = new Color(resolveToken(tokens[type] ?? '--app-dso-default', '#d6d9e6'))
      paletteCache.set(type, color)
      return color
    }

    for (let k = 0; k < n; k++) {
      const a = Math.max(data.semiMajor[k], 0)
      const b = Math.max(data.semiMinor[k], 0)
      semiMajor[k] = a
      semiMinor[k] = b > 0 ? b : a
      // Le quad est carre : il doit contenir le grand axe quelle que soit la
      // rotation, et le plancher quand l'objet n'est pas resolu.
      quadSemi[k] = Math.max(a, QUAD_FLOOR)
      slots[k] = atlasSlotOf(data.indices[k])

      const color = colorFor(data.types[k])
      colors[k * 3] = color.r
      colors[k * 3 + 1] = color.g
      colors[k * 3 + 2] = color.b
    }

    plane.setAttribute('aSemiMajor', new InstancedBufferAttribute(semiMajor, 1))
    plane.setAttribute('aSemiMinor', new InstancedBufferAttribute(semiMinor, 1))
    plane.setAttribute('aQuadSemi', new InstancedBufferAttribute(quadSemi, 1))
    plane.setAttribute('aMag', new InstancedBufferAttribute(data.magnitudes.slice(), 1))
    plane.setAttribute('aSb', new InstancedBufferAttribute(data.surfaceBrightness.slice(), 1))
    plane.setAttribute('aExtended', new InstancedBufferAttribute(data.extended.slice(), 1))
    plane.setAttribute('aColor', new InstancedBufferAttribute(colors, 3))
    plane.setAttribute('aSlot', new InstancedBufferAttribute(slots, 1))

    const shader = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        ...refractionUniforms(),
        uLimitMag: { value: limitingMagnitude },
        uSkySb: { value: 21.8 },
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
        attribute float aSlot;

        varying vec2 vUv;
        varying vec3 vColor;
        varying float vSemiMajor;
        varying float vSemiMinor;
        varying float vQuadSemi;
        varying float vMag;
        varying float vSb;
        varying float vExtended;
        varying float vAirmass;
        varying float vSlot;

        void main() {
          vUv = uv * 2.0 - 1.0;
          vSlot = aSlot;
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
        varying float vSlot;

        uniform float uExtinctionK;
        uniform float uLimitMag;
        uniform float uSkySb;
        uniform float uPixelsPerRadian;
        uniform float uMinPixelRadius;
        uniform sampler2D uAtlas;
        uniform float uHasAtlas;

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
          if (d > 1.0) discard;

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
          bool image = uHasAtlas > 0.5 && vSlot >= 0.0;
          float dex = 0.0;
          if (image) {
            float rapport = vSemiMinor / max(vSemiMajor, 1e-9);
            vec2 tile = vec2((angular.x / b) * rapport, angular.y / a) * 0.5 + 0.5;
            float edge = 0.5 / ${DSO_ATLAS_TILE.toFixed(1)};
            tile = clamp(tile, edge, 1.0 - edge);
            float grid = ${DSO_ATLAS_GRID.toFixed(1)};
            float column = mod(vSlot, grid);
            // ⚠️ Les rangees de l'atlas sont comptees depuis le **haut** de
            // l'image, la coordonnee de texture depuis le bas.
            float row = floor(vSlot / grid);
            vec2 uvAtlas = vec2(column + tile.x, grid - row - 1.0 + tile.y) / grid;
            float q = texture2D(uAtlas, uvAtlas).r;
            dex = ${DSO_PROFILE_LO_DEX.toFixed(1)} +
                  q * ${(DSO_PROFILE_HI_DEX - DSO_PROFILE_LO_DEX).toFixed(1)};
          }
          float sbLocal = sbObserved - 2.5 * dex;

          float opacity;
          if (vExtended > 0.5) {
            // Objet etendu : c'est le contraste de brillance de surface avec le
            // fond de ciel qui decide, non la magnitude integree.
            float contrast = uSkySb - sbLocal;
            opacity = clamp((contrast + 1.5) / 3.5, 0.0, 1.0);
          } else {
            // Dimensions inconnues : on retombe sur la loi des sources
            // ponctuelles — meme courbe que pointIntensity(), voir photometry.ts.
            float delta = vMag + extinction - uLimitMag;
            float rel = pow(10.0, -0.4 * delta);
            float gate = 1.0 - smoothstep(${POINT_VISIBILITY_FADE_START.toFixed(1)}, ${POINT_VISIBILITY_FADE_END.toFixed(1)}, delta);
            opacity = clamp(${POINT_BRIGHTNESS_SCALE} * log(1.0 + rel) * gate, 0.0, 1.0);
          }

          // Un objet reste toujours plus tenu que les etoiles qui l'entourent.
          opacity *= 0.42;

          float falloff;
          if (image) {
            // Le profil est deja dans la brillance locale. Il ne reste qu'a
            // eteindre le bord de l'ellipse — ⚠️ un objet reel la franchit sans
            // s'arreter, et la couper net se verrait.
            falloff = 1.0 - smoothstep(0.85, 1.0, d);
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
          float retinal = ${ZERO_MAGNITUDE_LUX.toExponential(6)} *
                          pow(10.0, -0.4 * sbLocal) /
                          ${ARCSEC2_STERADIAN.toExponential(6)};
          float mesopic = log2(max(1e-9, retinal) / ${SCOTOPIC_CEILING.toFixed(4)}) /
                          log2(${PHOTOPIC_FLOOR.toFixed(1)} / ${SCOTOPIC_CEILING.toFixed(4)});
          float rods = 1.0 - smoothstep(0.0, 1.0, mesopic);

          // Rougissement par l'extinction, normalise sur le rouge — la meme loi
          // que les etoiles.
          float xr = max(0.0, vAirmass - 1.0);
          vec3 tinted = vColor * vec3(1.0, exp(-0.035 * xr), exp(-0.085 * xr));
          vec3 seen = mix(tinted, vec3(dot(tinted, vec3(0.2126, 0.7152, 0.0722))), rods);

          gl_FragColor = vec4(radianceFromDisplay(seen), alpha);
        }
      `,
    })

    return { geometry: plane, material: shader, count: n }
    // La precession est imperceptible a l'echelle d'une session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date.getUTCFullYear(), magnitudeLimit, resolveToken])

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
    material.uniforms.uPixelsPerRadian.value = size.height / (2 * Math.tan(fov / 2))
    material.uniforms.uLimitMag.value = limitingMagnitude
    material.uniforms.uSkySb.value = skySurfaceBrightness(illuminance)
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
