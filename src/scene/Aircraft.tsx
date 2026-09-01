/**
 * Avions reels : silhouette a l'echelle, trainee de condensation, halo
 * atmospherique. La position vient de `astro/aircraft.ts` — deja en
 * coordonnees horizontales, aucune propagation a faire ici.
 */
import { useEffect, useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Color, DoubleSide, LineSegments, Mesh, ShaderMaterial, Sphere, Vector3 } from 'three'
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
import { aerialUniforms, applyAerialUniforms } from './useAerialLut'

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
 * Trainee de condensation.
 *
 * Deux panaches, un par groupe de reacteurs, ecartes de vingt metres. Chacun
 * part etroit derriere l'aile et s'evase en s'eloignant, comme le fait une
 * trainee reelle en se melangeant a l'air ambiant.
 *
 * Le ruban est **construit depuis la position extrapolee de l'avion**, pas
 * depuis l'historique des mesures. L'historique n'a qu'un point toutes les
 * vingt secondes : il ne donnerait qu'un ou deux segments, et surtout sa tete
 * resterait accrochee a la derniere position recue pendant que l'avion, lui,
 * continue d'avancer — la trainee se detachait alors de son avion.
 *
 * La longueur est fixee en **degres apparents** plutot qu'en kilometres :
 * c'est ce qui se voit. Un avion lointain traine donc physiquement plus long,
 * pour une meme empreinte a l'ecran.
 */
const CONTRAIL_SEGMENTS = 28
/** Longueur apparente visee, en degres. */
const CONTRAIL_LENGTH_DEG = 6
/** Ecartement des deux panaches, en kilometres. */
const CONTRAIL_SPACING_KM = 0.02
/** Demi-largeur du panache a la sortie du reacteur, puis en fin de course. */
const CONTRAIL_WIDTH_START_KM = 0.012
const CONTRAIL_WIDTH_END_KM = 0.32

function contrailMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uColor: { value: new Color('#ffffff') },
      /**
       * Distance a la tete du panache, en metres. La queue est un peu plus
       * loin, mais la trainee ne couvre que quelques degres : l'ecart de
       * colonne d'air entre ses deux bouts est sans effet visible.
       */
      uRangeM: { value: 0 },
      uOpacity: { value: 0 },
      ...aerialUniforms(),
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vView;
      void main() {
        vUv = uv;
        // L'observateur est a l'origine : la position dans le monde donne
        // directement la direction sous laquelle on voit ce point.
        vView = normalize((modelMatrix * vec4(position, 1.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${DISPLAY_TONEMAP_GLSL}
      ${AERIAL_LUT_GLSL}
      varying vec2 vUv;
      varying vec3 vView;
      uniform vec3 uColor;
      uniform float uRangeM;
      uniform float uOpacity;

      void main() {
        // vUv.x traverse le panache, vUv.y le parcourt. Aucun bord net : le
        // profil transversal est une gaussienne, et la queue se dissout.
        float across = vUv.x * 2.0 - 1.0;
        float radial = exp(-across * across * 3.2);

        // Naissance juste derriere le reacteur, puis dissipation progressive.
        float birth = smoothstep(0.0, 0.06, vUv.y);
        float decay = pow(1.0 - vUv.y, 1.6);

        // Les cristaux de glace diffusent surtout vers l'avant : une trainee
        // vue a contre-jour est bien plus lumineuse que la meme vue dos au
        // Soleil. C'est ce qui la fait ressortir en fin de journee.
        float forward = max(0.0, dot(normalize(vView), normalize(uAerialSunDir)));
        float scatter = 0.75 + 1.9 * pow(forward, 6.0);

        float alpha = radial * birth * decay * uOpacity * scatter;
        if (alpha < 0.004) discard;

        // Meme traitement que la silhouette, borne a la meme distance : de
        // nuit le voile ajoute est reellement noir — plus de trainee qui
        // ressort a contretemps du ciel — et de jour les cristaux perdent en
        // s'eloignant ce que l'air leur prend.
        vec3 transmittance;
        vec3 haze = aerialPerspective(vView, uRangeM, transmittance);
        gl_FragColor = vec4(radianceFromDisplay(uColor) * transmittance + haze, min(alpha, 0.85));
      }
    `,
  })
}

/**
 * Ruban unique portant les deux panaches.
 *
 * Un seul tampon les contient tous les deux — deux bandes de triangles a la
 * suite — pour n'avoir qu'un appel de dessin par avion plutot que deux.
 */
function AircraftContrail({
  state,
  location,
  sunDirection,
  skyExposure,
  dayFactor,
}: {
  state: AircraftState
  location: GeoLocation
  sunDirection: [number, number, number]
  /** Exposition de la diffusion atmospherique — voir `SkyCanvas.tsx`, meme valeur que le fond de ciel. */
  skyExposure: number
  /** Charge en aerosols, identique a celle du fond de ciel. */
  dayFactor: number
}) {
  const mesh = useRef<Mesh>(null)
  const material = useMemo(contrailMaterial, [])

  const geometry = useMemo(() => {
    const geo = new BufferGeometry()
    const rows = CONTRAIL_SEGMENTS + 1
    const vertices = rows * 2 * 2 // deux panaches, deux bords par section
    geo.setAttribute('position', new BufferAttribute(new Float32Array(vertices * 3), 3))
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(vertices * 2), 2))

    // Indices fixes : seules les positions changent d'une image a l'autre.
    const indices: number[] = []
    for (let plume = 0; plume < 2; plume++) {
      const base = plume * rows * 2
      for (let i = 0; i < CONTRAIL_SEGMENTS; i++) {
        const a = base + i * 2
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
    geo.setIndex(indices)
    // La trainee couvre plusieurs degres et bouge sans cesse : une sphere
    // englobante calculee une fois serait fausse des l'image suivante.
    geo.boundingSphere = new Sphere(new Vector3(), 1e6)
    return geo
  }, [])

  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  /**
   * Axe du panache en coordonnees de scene, reconstruit a chaque image.
   *
   * Deux passes : on pose d'abord l'axe, puis on l'epaissit. La largeur d'une
   * section a besoin de la direction *locale* de l'axe, donc de ses voisins des
   * deux cotes — ce qu'une passe unique ne peut pas fournir pour le premier
   * point.
   */
  const axis = useMemo(
    () => Array.from({ length: CONTRAIL_SEGMENTS + 1 }, () => ({ point: new Vector3(), halfWidth: 0 })),
    [],
  )
  const scratch = useRef({ direction: new Vector3(), radial: new Vector3(), side: new Vector3() })

  useFrame(() => {
    const m = mesh.current
    if (!m) return

    const head = extrapolatedGeodetic(state, Date.now())
    const headView = geodeticToHorizontal(head.latitude, head.longitude, head.altitudeKm, location)

    // Longueur physique deduite de la longueur apparente voulue.
    const lengthKm = Math.max(0.4, headView.rangeKm * Math.tan(CONTRAIL_LENGTH_DEG * DEG))
    const track = state.trackDeg ?? 0
    const backBearing = (track + 180) % 360
    const sideBearing = (track + 90) % 360
    // La trainee se depose derriere l'avion : elle garde l'altitude qu'il avait
    // en la produisant, donc perd ce qu'il vient de gagner en montant.
    const perSecondKm = groundDistanceKm(state, 1)
    const spannedSeconds = perSecondKm > 0 ? lengthKm / perSecondKm : 0
    const dropKm = ((state.verticalRateFtMin ?? 0) / 60) * 0.0003048 * spannedSeconds

    const position = geometry.getAttribute('position') as BufferAttribute
    const uv = geometry.getAttribute('uv') as BufferAttribute
    const { direction, radial, side } = scratch.current
    const rows = CONTRAIL_SEGMENTS + 1

    for (let plume = 0; plume < 2; plume++) {
      const lateralKm = (plume === 0 ? -1 : 1) * (CONTRAIL_SPACING_KM / 2)
      const lateralBearing = lateralKm < 0 ? (sideBearing + 180) % 360 : sideBearing

      // Passe 1 — l'axe.
      for (let i = 0; i < rows; i++) {
        const t = i / CONTRAIL_SEGMENTS
        const along = advanceGeodetic(head, lengthKm * t, backBearing, -dropKm * t)
        const at = advanceGeodetic(along, Math.abs(lateralKm), lateralBearing)
        const view = geodeticToHorizontal(at.latitude, at.longitude, at.altitudeKm, location)
        const [x, y, z] = horizontalToScene(view.horizontal, sceneDepth(view.rangeKm))
        axis[i].point.set(x, y, z)
        // Demi-largeur croissante : le panache s'evase en vieillissant.
        const halfWidthKm =
          CONTRAIL_WIDTH_START_KM + (CONTRAIL_WIDTH_END_KM - CONTRAIL_WIDTH_START_KM) * Math.pow(t, 0.7)
        axis[i].halfWidth = sceneRadiusForBody(halfWidthKm, view.rangeKm)
      }

      // Passe 2 — l'epaisseur, face a l'observateur.
      for (let i = 0; i < rows; i++) {
        const previous = axis[Math.max(0, i - 1)].point
        const next = axis[Math.min(rows - 1, i + 1)].point
        direction.copy(next).sub(previous)
        if (direction.lengthSq() === 0) direction.set(1, 0, 0)

        // Le ruban se developpe perpendiculairement a la fois a l'axe du
        // panache et a la ligne de visee : sans cela il disparaitrait vu par
        // la tranche, exactement quand on regarde l'avion s'eloigner.
        radial.copy(axis[i].point).normalize()
        side.copy(direction).cross(radial)
        if (side.lengthSq() === 0) side.set(1, 0, 0)
        side.normalize().multiplyScalar(axis[i].halfWidth)

        const p = axis[i].point
        const index = plume * rows * 2 + i * 2
        position.setXYZ(index, p.x - side.x, p.y - side.y, p.z - side.z)
        position.setXYZ(index + 1, p.x + side.x, p.y + side.y, p.z + side.z)
        uv.setXY(index, 0, i / CONTRAIL_SEGMENTS)
        uv.setXY(index + 1, 1, i / CONTRAIL_SEGMENTS)
      }
    }

    position.needsUpdate = true
    uv.needsUpdate = true

    material.uniforms.uRangeM.value = headView.rangeKm * 1000
    applyAerialUniforms(
      material.uniforms as unknown as ReturnType<typeof aerialUniforms>,
      sunDirection,
      skyExposure,
    )
    // Sous l'horizon rien a montrer ; sinon l'opacite suit la probabilite de
    // condensation a l'altitude courante et la lumiere du jour.
    const visible = headView.horizontal.altitude > -1 ? state.contrailLikelihood * dayFactor : 0
    material.uniforms.uOpacity.value = visible * 0.55
    m.visible = visible > 0.01
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
              skyExposure={skyExposure}
                dayFactor={dayFactor}
            />
          )}
        </group>
      ))}
      {selectedHex && <AircraftTrack hex={selectedHex} location={location} color={trackColor} />}
    </group>
  )
}
