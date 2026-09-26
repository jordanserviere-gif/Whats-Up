/**
 * Avions reels : silhouette a l'echelle, trainee de condensation, halo
 * atmospherique. La position vient de `astro/aircraft.ts` — deja en
 * coordonnees horizontales, aucune propagation a faire ici.
 */
import { useEffect, useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Color, DoubleSide, LineSegments, Mesh, ShaderMaterial, Sphere, Vector2, Vector3, Vector4 } from 'three'
import { useFrame } from '@react-three/fiber'
import {
  advanceGeodetic,
  extrapolatedGeodetic,
  geodeticToHorizontal,
  groundDistanceKm,
  type AircraftState,
} from '@/astro/aircraft'
import { getAircraftHistory } from '@/state/aircraftFeed'
import type { GeoLocation } from '@/astro/types'
import { horizontalToScene, sceneDepth, sceneRadiusForBody } from './sceneMath'
import { DISPLAY_TONEMAP_GLSL } from './display/tonemap'
import { AERIAL_LUT_GLSL } from '@/atmosphere/lut/aerialPerspectiveLut'
import { aerialTextures, aerialUniforms, applyAerialUniforms } from './useAerialLut'
import { CLOUD_PHASE_GLSL } from '@/atmosphere/cloud/phase'
import {
  CONTRAIL_GLSL,
  DEFAULT_CONTRAIL,
  DEFAULT_ENVIRONMENT,
  contrailDeathAgeS,
  contrailSigmaM,
  initialExtinctionPerLengthM,
} from '@/atmosphere/cloud/contrail'
import { ambientRadianceAtAltitude, sunAltitudeAt, sunIrradianceAtAltitude } from './contrailLighting'

const DEG = Math.PI / 180

/**
 * Silhouette vue du dessous, plate dans le plan XZ local : fuselage, ailes en
 * fleche, empennage. Le nez pointe vers +Z local ; `AircraftMesh` fait
 * correspondre cette direction a la route reelle de l'avion.
 */
function buildAircraftGeometry(): BufferGeometry {
  const vertices: Record<string, [number, number]> = {
    nose: [0, 0.55],
    fuseFrontL: [-0.035, 0.15],
    fuseFrontR: [0.035, 0.15],
    fuseBackL: [-0.03, -0.45],
    fuseBackR: [0.03, -0.45],
    tailEnd: [0, -0.58],
    wingTipL: [-0.5, 0.05],
    wingTipR: [0.5, 0.05],
    wingBackL: [-0.06, -0.1],
    wingBackR: [0.06, -0.1],
    tailTipL: [-0.18, -0.42],
    tailTipR: [0.18, -0.42],
  }
  const order = Object.keys(vertices)
  const idx = (k: string) => order.indexOf(k)
  const positions = new Float32Array(order.length * 3)
  order.forEach((k, i) => {
    const [x, z] = vertices[k]
    positions[i * 3] = x
    positions[i * 3 + 1] = 0
    positions[i * 3 + 2] = z
  })
  const triangles: Array<[string, string, string]> = [
    ['nose', 'fuseFrontL', 'fuseFrontR'],
    ['fuseFrontL', 'fuseBackL', 'fuseBackR'],
    ['fuseFrontL', 'fuseBackR', 'fuseFrontR'],
    ['fuseBackL', 'tailEnd', 'fuseBackR'],
    ['wingTipL', 'fuseFrontL', 'wingBackL'],
    ['wingTipR', 'wingBackR', 'fuseFrontR'],
    ['tailTipL', 'fuseBackL', 'tailEnd'],
    ['tailTipR', 'tailEnd', 'fuseBackR'],
  ]
  const indices: number[] = []
  for (const [a, b, c] of triangles) indices.push(idx(a), idx(b), idx(c))

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(positions, 3))
  geo.setIndex(indices)
  return geo
}

const AIRCRAFT_GEOMETRY = buildAircraftGeometry()
/** Envergure representee : quarante metres, comme demande — un moyen-courrier type. */
const WINGSPAN_KM = 0.04

function aircraftMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uColor: { value: new Color('#e9ebf1') },
      /** Distance reelle a l'appareil, en metres : longueur d'air a traverser. */
      uRangeM: { value: 0 },
      uOpacity: { value: 1 },
      ...aerialUniforms(),
    },
    vertexShader: /* glsl */ `
      varying vec3 vView;
      void main() {
        // L'observateur est a l'origine : la position dans le monde donne
        // directement la direction sous laquelle on voit ce point.
        vView = normalize((modelMatrix * vec4(position, 1.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    // Un avion est *dans* l'atmosphere : la colonne d'air a traverser s'arrete
    // a lui, elle ne va pas jusqu'a l'espace. `uRangeM` borne donc l'integrale
    // a sa distance reelle — trente kilometres d'air rasant portent bien plus
    // de voile que dix kilometres au zenith, pour un meme appareil.
    //
    // Le melange empirique d'autrefois (une fraction tiree de la masse d'air)
    // laisse place aux deux termes physiques : ce que l'air ajoute devant
    // l'appareil, et ce qu'il laisse passer de sa propre teinte.
    fragmentShader: /* glsl */ `
      ${DISPLAY_TONEMAP_GLSL}
      ${AERIAL_LUT_GLSL}
      varying vec3 vView;
      uniform vec3 uColor;
      uniform float uRangeM;
      uniform float uOpacity;
      void main() {
        vec3 transmittance;
        vec3 haze = aerialPerspective(vView, uRangeM, transmittance);
        gl_FragColor = vec4(radianceFromDisplay(uColor) * transmittance + haze, uOpacity);
      }
    `,
  })
}

/**
 * Un avion : silhouette posee a plat a son altitude, orientee par sa route.
 *
 * La position affichee n'est pas la derniere mesure telle quelle : ADS-B ne
 * rafraichit qu'a chaque sondage (vingt secondes), alors qu'un avion parcourt
 * facilement deux kilometres dans cet intervalle. Chaque image avance donc la
 * derniere position connue au rythme de la vitesse sol et de la route — voir
 * `extrapolatedGeodetic` — pour un glissement continu plutot qu'un saut toutes
 * les vingt secondes.
 */
function AircraftMesh({
  state,
  location,
  sunDirection,
  skyExposure,
  dayFactor,
  selected,
}: {
  state: AircraftState
  location: GeoLocation
  /** Direction du Soleil dans le repere de la scene, unitaire. */
  sunDirection: [number, number, number]
  /** Exposition de la diffusion atmospherique — voir `SkyCanvas.tsx`, meme valeur que le fond de ciel. */
  skyExposure: number
  /** Charge en aerosols, identique a celle du fond de ciel. */
  /** Facteur jour/nuit : un avion ne se voit quasiment plus une fois la nuit tombee. */
  dayFactor: number
  selected: boolean
}) {
  const mesh = useRef<Mesh>(null)
  const material = useMemo(aircraftMaterial, [])

  useFrame(() => {
    const m = mesh.current
    if (!m) return

    const geo = extrapolatedGeodetic(state, Date.now())
    const { horizontal, rangeKm } = geodeticToHorizontal(geo.latitude, geo.longitude, geo.altitudeKm, location)

    const depth = sceneDepth(rangeKm)
    const [x, y, z] = horizontalToScene(horizontal, depth)
    m.position.set(x, y, z)

    // Rotation autour du zenith local : le nez (local +Z) suit la route vraie.
    // Nord = -Z dans le repere de la scene, d'ou le dephasage de π.
    const trackRad = (state.trackDeg ?? 0) * DEG
    m.rotation.set(0, Math.PI - trackRad, 0)

    const halfSpan = sceneRadiusForBody(WINGSPAN_KM / 2, rangeKm)
    m.scale.setScalar(halfSpan * 2)

    material.uniforms.uRangeM.value = rangeKm * 1000
    applyAerialUniforms(
      material.uniforms as unknown as ReturnType<typeof aerialUniforms>,
      sunDirection,
      skyExposure,
    )
    ;(material.uniforms.uColor.value as Color).setRGB(
      selected ? 1 : 0.914,
      selected ? 1 : 0.925,
      selected ? 1 : 0.945,
    )
    material.uniforms.uOpacity.value = horizontal.altitude > -1 ? dayFactor : 0
  })

  return (
    <mesh ref={mesh} geometry={AIRCRAFT_GEOMETRY} material={material} renderOrder={12} frustumCulled={false} />
  )
}

/**
 * Trainee de condensation — le tube de glace de `atmosphere/cloud/contrail.ts`.
 *
 * ## Ce que porte chaque sommet
 *
 * Le ruban est construit, a chaque image, depuis la position extrapolee de
 * l'avion ; chaque rangee est un **age** — le temps ecoule depuis que l'avion
 * y est passe —, et tout le reste en decoule : la largeur du tube, sa quantite
 * de glace, sa formation derriere les reacteurs. Les rangees sont resserrees
 * pres de l'avion, la ou la trainee change vite.
 *
 * Le ruban fait face a l'observateur et s'etend a ±3σ de l'axe : sa coordonnee
 * laterale **est** la distance entre le rayon de visee et l'axe du tube, celle
 * qu'attend l'epaisseur optique en forme close. L'angle entre la visee et
 * l'axe, lui, est calcule en metres, pas dans la scene compressee.
 *
 * ## Ce que fait le nuanceur
 *
 * Rien de peint. L'opacite vaut `1 − e^(−τ)`. La couleur est ce que la glace
 * diffuse vers l'oeil : le Soleil **tel qu'il arrive a l'altitude de vol**
 * — rougi, ou eteint par l'ombre de la Terre — pondere par la fonction de
 * phase des cristaux, plus la lumiere diffuse du ciel et du sol. Le trajet
 * jusqu'a l'oeil passe par la perspective atmospherique, rangee par rangee.
 * Tout est en radiance, sur l'echelle du ciel : c'est le transform d'affichage
 * qui decide de ce qui brille.
 *
 * Diffusion simple : une trainee a une epaisseur optique de quelques dixiemes,
 * ou la diffusion multiple ne pese que quelques pour cent.
 */
const CONTRAIL_ROWS = 64
/** Resserrement des rangees vers l'avion : age ∝ (i/N)^k. */
const CONTRAIL_ROW_EXPONENT = 1.8
/**
 * Age maximal dessine, s. Une trainee persistante vit des heures : a 450 nœuds,
 * trente minutes font deja 400 km de ruban, d'un horizon a l'autre.
 */
const CONTRAIL_MAX_AGE_S = 1800
/**
 * Demi-largeur du ruban, en ecarts-types de la section. Quatre et non trois :
 * les panaches ecartes, la turbulence et l'ondulation de Crow deplacent l'axe
 * de pres d'un ecart-type.
 */
const CONTRAIL_HALF_WIDTH_SIGMAS = 4
/**
 * Periode de l'horloge passee au nuanceur, s. La position dans la masse d'air
 * en derive ; un flottant garde sa precision sur une journee, pas sur l'epoque.
 */
const CONTRAIL_CLOCK_PERIOD_S = 86_400

function contrailMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      /** (σ₀ m, D_h m²/s, D_v m²/s, K₀ m²/m) — voir `CONTRAIL_GLSL`. */
      uContrail: { value: new Vector4() },
      /** (σ_z du sillage m, phase de sillage s, M₀ kg/m, formation s). */
      uContrailWake: { value: new Vector4() },
      /** (cisaillement s⁻¹, exces de vapeur kg/m³) : l'air au niveau de vol. */
      uContrailEnv: { value: new Vector2() },
      /** Irradiance solaire directe a l'altitude de la trainee, sRGB lineaire. */
      uSunIrradiance: { value: new Vector3() },
      /** Radiance diffuse moyenne recue par la glace. */
      uAmbientRadiance: { value: new Vector3() },
      /** Horloge murale modulo une journee, s, et vitesse sol, m/s. */
      uNowS: { value: 0 },
      uSpeedMS: { value: 0 },
      ...aerialUniforms(),
    },
    vertexShader: /* glsl */ `
      attribute float aAge;
      attribute float aLateral;
      attribute float aSinAngle;
      attribute float aRangeM;
      varying float vAge;
      varying float vLateral;
      varying float vSinAngle;
      varying float vRangeM;
      varying vec3 vView;
      void main() {
        vAge = aAge;
        vLateral = aLateral;
        vSinAngle = aSinAngle;
        vRangeM = aRangeM;
        // L'observateur est a l'origine : la position dans le monde donne
        // directement la direction sous laquelle on voit ce point.
        vView = normalize((modelMatrix * vec4(position, 1.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${AERIAL_LUT_GLSL}
      ${CLOUD_PHASE_GLSL}
      ${CONTRAIL_GLSL}
      varying float vAge;
      varying float vLateral;
      varying float vSinAngle;
      varying float vRangeM;
      varying vec3 vView;
      uniform vec4 uContrail;
      uniform vec4 uContrailWake;
      uniform vec2 uContrailEnv;
      uniform vec3 uSunIrradiance;
      uniform vec3 uAmbientRadiance;
      uniform float uNowS;
      uniform float uSpeedMS;

      void main() {
        // Position dans la masse d'air : la distance parcourue par l'avion
        // quand cette glace a ete emise. La structure y est attachee, et reste
        // en place pendant que l'avion avance.
        float along = (uNowS - vAge) * uSpeedMS;
        float tau = contrailStructuredDepth(vAge, vLateral, vSinAngle, uContrail, uContrailWake, uContrailEnv, along, fwidth(along));
        float alpha = 1.0 - exp(-tau);
        if (!(alpha > 0.002)) discard;

        // Angle de diffusion : entre la lumiere qui arrive du Soleil et celle
        // qui repart vers l'oeil. Face au Soleil, c'est le pic avant.
        vec3 view = normalize(vView);
        float mu = dot(view, normalize(uAerialSunDir));
        vec3 scattered = uSunIrradiance * cloudIcePhase(mu) + uAmbientRadiance;

        vec3 transmittance;
        vec3 haze = aerialPerspective(view, vRangeM, transmittance);
        gl_FragColor = vec4(scattered * uAerialExposure * transmittance + haze, alpha);
      }
    `,
  })
}

function AircraftContrail({
  state,
  location,
  sunDirection,
  sunAltitudeDeg,
  sunAzimuthDeg,
  groundSunIrradiance,
  skyExposure,
}: {
  state: AircraftState
  location: GeoLocation
  sunDirection: [number, number, number]
  /** Hauteur et azimut du Soleil pour l'observateur, degres. */
  sunAltitudeDeg: number
  sunAzimuthDeg: number
  /** Irradiance solaire directe au sol, pour la lumiere que le sol renvoie vers la trainee. */
  groundSunIrradiance: readonly [number, number, number]
  /** Exposition de la diffusion atmospherique — voir `SkyCanvas.tsx`, meme valeur que le fond de ciel. */
  skyExposure: number
}) {
  const mesh = useRef<Mesh>(null)
  const material = useMemo(contrailMaterial, [])
  const params = DEFAULT_CONTRAIL

  const geometry = useMemo(() => {
    const geo = new BufferGeometry()
    const vertices = CONTRAIL_ROWS * 2
    geo.setAttribute('position', new BufferAttribute(new Float32Array(vertices * 3), 3))
    for (const name of ['aAge', 'aLateral', 'aSinAngle', 'aRangeM']) {
      geo.setAttribute(name, new BufferAttribute(new Float32Array(vertices), 1))
    }
    // Indices fixes : seules les valeurs des sommets changent d'une image a l'autre.
    const indices: number[] = []
    for (let i = 0; i < CONTRAIL_ROWS - 1; i++) {
      const a = i * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    geo.setIndex(indices)
    // La trainee couvre plusieurs degres et bouge sans cesse : une sphere
    // englobante calculee une fois serait fausse des l'image suivante.
    geo.boundingSphere = new Sphere(new Vector3(), 1e6)
    return geo
  }, [])

  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  const rows = useMemo(
    () =>
      Array.from({ length: CONTRAIL_ROWS }, () => ({
        scene: new Vector3(),
        metric: new Vector3(),
        ageS: 0,
        rangeKm: 0,
      })),
    [],
  )
  const scratch = useRef({ direction: new Vector3(), radial: new Vector3(), side: new Vector3(), axis: new Vector3() })

  useFrame(() => {
    const m = mesh.current
    if (!m) return

    const head = extrapolatedGeodetic(state, Date.now())
    const headView = geodeticToHorizontal(head.latitude, head.longitude, head.altitudeKm, location)
    const track = state.trackDeg ?? 0
    const backBearing = (track + 180) % 360
    const perSecondKm = groundDistanceKm(state, 1)
    const climbKmPerS = ((state.verticalRateFtMin ?? 0) / 60) * 0.0003048
    // La duree de vie vient de l'humidite au niveau de vol quand on la connait.
    // L'air au niveau de vol decide de tout : jusqu'ou le ruban va — l'age ou
    // la glace s'epuise —, et comment il s'etale.
    const env = state.contrailEnvironment ?? DEFAULT_ENVIRONMENT
    const maxAgeS = Math.min(CONTRAIL_MAX_AGE_S, contrailDeathAgeS(env, params))

    // Passe 1 — l'axe, en scene et en metres (repere local centre sur l'observateur).
    for (let i = 0; i < CONTRAIL_ROWS; i++) {
      const ageS = maxAgeS * Math.pow(i / (CONTRAIL_ROWS - 1), CONTRAIL_ROW_EXPONENT)
      // La trainee se depose derriere l'avion, a l'altitude qu'il avait alors.
      const at = advanceGeodetic(head, perSecondKm * ageS, backBearing, -climbKmPerS * ageS)
      const view = geodeticToHorizontal(at.latitude, at.longitude, at.altitudeKm, location)
      const [x, y, z] = horizontalToScene(view.horizontal, sceneDepth(view.rangeKm))
      const row = rows[i]
      row.scene.set(x, y, z)
      const alt = view.horizontal.altitude * DEG
      const az = view.horizontal.azimuth * DEG
      row.metric
        .set(Math.cos(alt) * Math.sin(az), Math.sin(alt), Math.cos(alt) * Math.cos(az))
        .multiplyScalar(view.rangeKm * 1000)
      row.ageS = ageS
      row.rangeKm = view.rangeKm
    }

    // Passe 2 — l'epaisseur, face a l'observateur, et ce que porte chaque sommet.
    const position = geometry.getAttribute('position') as BufferAttribute
    const aAge = geometry.getAttribute('aAge') as BufferAttribute
    const aLateral = geometry.getAttribute('aLateral') as BufferAttribute
    const aSinAngle = geometry.getAttribute('aSinAngle') as BufferAttribute
    const aRangeM = geometry.getAttribute('aRangeM') as BufferAttribute
    const { direction, radial, side, axis } = scratch.current
    for (let i = 0; i < CONTRAIL_ROWS; i++) {
      const previous = rows[Math.max(0, i - 1)]
      const next = rows[Math.min(CONTRAIL_ROWS - 1, i + 1)]
      const row = rows[i]

      // Le ruban se developpe perpendiculairement a la fois a l'axe et a la
      // ligne de visee : sans cela il disparaitrait vu par la tranche.
      direction.copy(next.scene).sub(previous.scene)
      if (direction.lengthSq() === 0) direction.set(1, 0, 0)
      radial.copy(row.scene).normalize()
      side.copy(direction).cross(radial)
      if (side.lengthSq() === 0) side.set(1, 0, 0)
      const halfWidthM = CONTRAIL_HALF_WIDTH_SIGMAS * contrailSigmaM(row.ageS, env, params)
      side.normalize().multiplyScalar(sceneRadiusForBody(halfWidthM / 1000, row.rangeKm))

      // Angle entre la visee et l'axe, en vraie geometrie.
      axis.copy(next.metric).sub(previous.metric)
      const sinAngle =
        axis.lengthSq() > 0 ? axis.normalize().cross(radial.copy(row.metric).normalize()).length() : 1

      const index = i * 2
      const p = row.scene
      position.setXYZ(index, p.x - side.x, p.y - side.y, p.z - side.z)
      position.setXYZ(index + 1, p.x + side.x, p.y + side.y, p.z + side.z)
      for (const [v, lateral] of [
        [index, -halfWidthM],
        [index + 1, halfWidthM],
      ] as const) {
        aAge.setX(v, row.ageS)
        aLateral.setX(v, lateral)
        aSinAngle.setX(v, sinAngle)
        aRangeM.setX(v, row.rangeKm * 1000)
      }
    }
    for (const a of [position, aAge, aLateral, aSinAngle, aRangeM]) a.needsUpdate = true

    // Eclairage, a l'altitude et au lieu de la trainee.
    const altitudeM = head.altitudeKm * 1000
    const groundRangeKm = headView.rangeKm * Math.cos(headView.horizontal.altitude * DEG)
    const localSun = sunAltitudeAt(sunAltitudeDeg, sunAzimuthDeg, headView.horizontal.azimuth, groundRangeKm)
    const sun = sunIrradianceAtAltitude(localSun, altitudeM)
    const ambient = ambientRadianceAtAltitude(altitudeM, aerialTextures.skyIrradiance, groundSunIrradiance, sunAltitudeDeg)
    const u = material.uniforms
    ;(u.uSunIrradiance.value as Vector3).set(sun[0], sun[1], sun[2])
    ;(u.uAmbientRadiance.value as Vector3).set(ambient[0], ambient[1], ambient[2])
    // La probabilite de condensation dose la glace deposee : sous le seuil,
    // la trainee s'amincit jusqu'a disparaitre au lieu de s'eteindre d'un coup.
    ;(u.uContrail.value as Vector4).set(
      params.initialSigmaM,
      params.horizontalDiffusivityM2S,
      params.verticalDiffusivityM2S,
      initialExtinctionPerLengthM(params) * state.contrailLikelihood,
    )
    ;(u.uContrailWake.value as Vector4).set(params.wakeSigmaZM, params.wakePhaseS, params.initialIceKgPerM, params.formationS)
    ;(u.uContrailEnv.value as Vector2).set(env.shearPerS, env.excessVapourKgM3)
    u.uNowS.value = (Date.now() / 1000) % CONTRAIL_CLOCK_PERIOD_S
    u.uSpeedMS.value = perSecondKm * 1000
    applyAerialUniforms(u as unknown as ReturnType<typeof aerialUniforms>, sunDirection, skyExposure)
    m.visible = headView.horizontal.altitude > -1 && state.contrailLikelihood > 0.02
  })

  return <mesh ref={mesh} geometry={geometry} material={material} renderOrder={8} frustumCulled={false} />
}

/**
 * Trace suivie de l'avion selectionne — pas un historique de vol, seulement ce
 * qui a ete observe depuis que l'appareil est suivi ici (voir
 * `aircraftFeed.ts`). S'eclaircit du plus ancien au plus recent, pour se lire
 * comme un sillage plutot que comme un trait uniforme.
 *
 * L'historique grandit par mutation d'un tableau partage (`getAircraftHistory`) :
 * sa reference ne change jamais, donc `useMemo` ne verrait aucun point neuf. On
 * reconstruit la geometrie a chaque image ou sa longueur a change, plutot qu'a
 * chaque image tout court — un simple entier compare suffit a l'economiser.
 */
function AircraftTrack({ hex, location, color }: { hex: string; location: GeoLocation; color: string }) {
  const segments = useRef<LineSegments>(null)
  const geometry = useMemo(() => {
    const geo = new BufferGeometry()
    geo.boundingSphere = new Sphere(new Vector3(), 1e6)
    return geo
  }, [])
  const lastLength = useRef(-1)
  const tint = useMemo(() => new Color(color), [color])

  useEffect(() => () => geometry.dispose(), [geometry])

  useFrame(() => {
    const history = getAircraftHistory(hex)
    if (history.length === lastLength.current) return
    lastLength.current = history.length
    if (history.length < 2) {
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(0), 3))
      geometry.setAttribute('color', new BufferAttribute(new Float32Array(0), 3))
      return
    }

    // Segments plutot que ligne continue : la meme construction que la trace
    // satellite, sans les conflits de typage JSX de l'element `<line>`.
    const segmentCount = history.length - 1
    const positions = new Float32Array(segmentCount * 2 * 3)
    const colors = new Float32Array(segmentCount * 2 * 3)
    for (let i = 0; i < segmentCount; i++) {
      for (let end = 0; end < 2; end++) {
        const p = history[i + end]
        const { horizontal, rangeKm } = geodeticToHorizontal(p.latitude, p.longitude, p.altitudeKm, location)
        const [x, y, z] = horizontalToScene(horizontal, sceneDepth(rangeKm))
        const vertex = i * 2 + end
        positions[vertex * 3] = x
        positions[vertex * 3 + 1] = y
        positions[vertex * 3 + 2] = z
        // Le plus ancien point s'efface presque totalement, le plus recent
        // porte toute la couleur : ce degrade donne l'impression d'un sillage.
        const age = 0.1 + 0.9 * ((i + end) / segmentCount)
        colors[vertex * 3] = tint.r * age
        colors[vertex * 3 + 1] = tint.g * age
        colors[vertex * 3 + 2] = tint.b * age
      }
    }
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
  })

  return (
    <lineSegments ref={segments} geometry={geometry} frustumCulled={false} renderOrder={6}>
      <lineBasicMaterial vertexColors transparent opacity={0.8} depthWrite={false} />
    </lineSegments>
  )
}

/** Couche complete : un maillage et, le cas echeant, une trainee par avion visible. */
export function AircraftLayer({
  states,
  location,
  sunDirection,
  skyExposure,
  dayFactor,
  sunAltitudeDeg,
  sunAzimuthDeg,
  groundSunIrradiance,
  selectedHex,
  trackColor,
}: {
  states: readonly AircraftState[]
  location: GeoLocation
  /** Direction du Soleil dans le repere de la scene, unitaire. */
  sunDirection: [number, number, number]
  /** Exposition de la diffusion atmospherique — voir `SkyCanvas.tsx`, meme valeur que le fond de ciel. */
  skyExposure: number
  /** Charge en aerosols, identique a celle du fond de ciel. */
  dayFactor: number
  /** Hauteur et azimut du Soleil pour l'observateur, degres — la trainee s'eclaire a sa propre altitude. */
  sunAltitudeDeg: number
  sunAzimuthDeg: number
  /** Irradiance solaire directe au sol, sRGB lineaire. */
  groundSunIrradiance: readonly [number, number, number]
  selectedHex: string | null
  /** Couleur de la trace suivie de l'avion selectionne. */
  trackColor: string
}) {
  return (
    <group>
      {states.map((s) => (
        <group key={s.hex}>
          <AircraftMesh
            state={s}
            location={location}
            sunDirection={sunDirection}
            skyExposure={skyExposure}
            dayFactor={dayFactor}
            selected={s.hex === selectedHex}
          />
          {s.contrailLikelihood > 0.02 && (
            <AircraftContrail
              state={s}
              location={location}
              sunDirection={sunDirection}
              sunAltitudeDeg={sunAltitudeDeg}
              sunAzimuthDeg={sunAzimuthDeg}
              groundSunIrradiance={groundSunIrradiance}
              skyExposure={skyExposure}
            />
          )}
        </group>
      ))}
      {selectedHex && <AircraftTrack hex={selectedHex} location={location} color={trackColor} />}
    </group>
  )
}
