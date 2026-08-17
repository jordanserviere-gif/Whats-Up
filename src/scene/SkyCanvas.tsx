import { useCallback, useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { Matrix4, NoToneMapping } from 'three'
import { BODIES } from '@/astro/bodies'
import { CARDINALS, equatorialToHorizontal } from '@/astro/coords'
import { useSkyStore, selectedBodyId, selectedSatelliteId } from '@/state/store'
import {
  useAllSatellites,
  useBodyStates,
  useNearbyAircraft,
  useSatelliteStates,
  useSatelliteTracks,
  useSimulatedDate,
  useSkyConditions,
} from '@/state/hooks'
import { angularDistance, readToken, viewDirection } from './sceneMath'
import { pickSkyTarget } from './picking'
import { fieldLabels } from './fieldLabels'
import { useSceneColors } from './useSceneColors'
import { CameraRig, type PickRequest } from './CameraRig'
import { Starfield } from './Starfield'
import { ConstellationLines } from './ConstellationLines'
import { DeepSky } from './DeepSky'
import { EclipticLine, EquatorialGrid, HorizonGrid, HorizonLine } from './Grids'
import { Ground } from './Ground'
import { SkyBackground } from './SkyBackground'
import { SolarSystemBodies } from './Bodies'
import { useBodyTextures } from './useBodyTextures'
import { SatelliteLayer } from './Satellites'
import { AircraftLayer } from './Aircraft'
import { LabelLayer, type SceneLabel } from './LabelLayer'
import { constellationLabels } from '@/astro/catalog'
import { DEEP_SKY_MAG_LIMIT } from '@/astro/deepsky'
import { extrapolatedGeodetic, geodeticToHorizontal, type AircraftState } from '@/astro/aircraft'
import { AIRGLOW_LUX } from '@/astro/photometry'
import './SkyCanvas.css'

const EMPTY_AIRCRAFT: AircraftState[] = []

/**
 * Vue du ciel.
 *
 * Ce n'est pas une voute : chaque objet occupe une profondeur derivee de sa
 * distance reelle et un diametre angulaire exact. Les occultations — la Lune
 * devant le Soleil, un satellite devant une planete — sortent du tampon de
 * profondeur, pas d'un ordre de dessin choisi a la main.
 */
export function SkyCanvas() {
  const host = useRef<HTMLDivElement>(null)
  const labelHost = useRef<HTMLDivElement>(null)

  const date = useSimulatedDate()
  const location = useSkyStore((s) => s.location)
  const layers = useSkyStore((s) => s.layers)
  const magnitudeLimit = useSkyStore((s) => s.magnitudeLimit)
  const discScale = useSkyStore((s) => s.discScale)
  const aerosolTurbidity = useSkyStore((s) => s.aerosolTurbidity)
  const fov = useSkyStore((s) => s.fov)
  const viewAzimuth = useSkyStore((s) => s.viewAzimuth)
  const viewAltitude = useSkyStore((s) => s.viewAltitude)
  const selectedBody = useSkyStore(selectedBodyId)
  const selectedSatellite = useSkyStore(selectedSatelliteId)
  const selectedAircraftHex = useSkyStore((s) => s.selectedAircraftHex)
  const select = useSkyStore((s) => s.select)
  const selectAircraft = useSkyStore((s) => s.selectAircraft)
  const setTab = useSkyStore((s) => s.setTab)
  const lookAt = useSkyStore((s) => s.lookAt)

  const bodies = useBodyStates()
  const sky = useSkyConditions()
  // Miroir des ephemerides pour le navigateur automatise : il a besoin de
  // connaitre la position d'un corps pour pointer la camera dessus.
  if (import.meta.env.DEV) (window as unknown as { __bodyStates: unknown }).__bodyStates = bodies
  const satellites = useAllSatellites()
  const satStates = useSatelliteStates(satellites)
  if (import.meta.env.DEV) {
    ;(window as unknown as { __satStates: unknown }).__satStates = satellites.map((el) => {
      const s = satStates.get(el.id)
      return { id: el.id, name: el.name, alt: s?.horizontal.altitude ?? null, az: s?.horizontal.azimuth ?? null, mag: s?.magnitude ?? null }
    })
  }

  /**
   * Satellites dont on trace la trajectoire.
   *
   * Une trace coute quatre cents propagations : la dessiner pour deux cents
   * objets du catalogue engorgerait la boucle de rendu sans rien apprendre —
   * deux cents traces enchevetrees ne se lisent pas. Les orbites saisies a la
   * main gardent la leur, et le catalogue n'en montre qu'une : la selectionnee.
   */
  const tracked = useMemo(
    () => satellites.filter((el) => el.source !== 'celestrak' || el.id === selectedSatellite),
    [satellites, selectedSatellite],
  )
  const satTracks = useSatelliteTracks(tracked)
  const aircraftFeed = useNearbyAircraft()
  const aircraftStates = layers.aircraft ? aircraftFeed.aircraft : EMPTY_AIRCRAFT
  if (import.meta.env.DEV) {
    // La position **affichee** compte autant que la mesure brute : c'est elle
    // qui doit avancer sans a-coup. Les exposer separement est ce qui permet de
    // verifier l'extrapolation au lieu de la supposer bonne.
    ;(window as unknown as { __aircraftStates: unknown }).__aircraftStates = aircraftStates.map((a) => {
      const shown = extrapolatedGeodetic(a, Date.now())
      const view = geodeticToHorizontal(shown.latitude, shown.longitude, shown.altitudeKm, location)
      return {
        hex: a.hex,
        az: a.horizontal.azimuth,
        alt: a.horizontal.altitude,
        rangeKm: a.rangeKm,
        measuredAtMs: a.measuredAtMs,
        shownAz: view.horizontal.azimuth,
        shownAlt: view.horizontal.altitude,
      }
    })
  }
  const colors = useSceneColors()
  const textures = useBodyTextures()
  const pickMatrix = useRef(new Matrix4())
  const fieldMatrix = useRef(new Matrix4())

  const moon = bodies.find((b) => b.id === 'moon')

  // Sans le calque « atmosphere », on regarde le ciel comme depuis l'espace :
  // magnitude limite fixee au catalogue, aucune diffusion diurne.
  const limitingMagnitude = layers.atmosphere ? sky.limitingMagnitude : 6.6
  const illuminance = layers.atmosphere ? sky.illuminance : 2e-4

  /**
   * Exposition de la diffusion atmospherique reelle (voir `atmosphere.ts`),
   * partagee par le fond de ciel, les corps du systeme solaire et le voile
   * des avions/trainees — meme formule que `SkyBackground`, pour que tous
   * s'eteignent exactement au meme rythme pendant une eclipse ou en vue
   * depuis l'espace plutot que de deriver chacun de son cote.
   */
  const atmosphereExposure = useMemo(() => {
    if (!layers.atmosphere) return 0
    const eclipse = Math.pow(1 - sky.obscuration + 8e-4 * sky.obscuration, 0.5)
    return 0.3 * eclipse
  }, [layers.atmosphere, sky.obscuration])

  /**
   * Intensite d'affichage du halo urbain.
   *
   * L'eclairement de la pollution est une grandeur lineaire, alors que la
   * couleur de nuit du ciel est un token deja encode pour l'ecran : multiplier
   * l'un par l'autre donnerait un ciel noir jusqu'a la classe 7 puis blanc
   * d'un coup. On passe donc le rapport d'eclairement par l'exposant inverse
   * de la courbe d'affichage, ce qui echelonne le halo comme l'oeil le percoit
   * — chaque classe de Bortle se distingue de la suivante.
   *
   * `AIRGLOW_LUX` sert de reference : la lueur naturelle d'un site vierge, que
   * la couleur de nuit du token represente deja. Un rapport de 1 n'ajoute donc
   * rien du tout.
   */
  const pollutionGain = useMemo(() => {
    if (!layers.atmosphere || sky.pollutionLux <= 0) return 0
    const nightLuma = 0.017
    return (Math.pow(1 + sky.pollutionLux / AIRGLOW_LUX, 1 / 2.2) - 1) * nightLuma
  }, [layers.atmosphere, sky.pollutionLux])

  /**
   * Facteur jour/nuit applique au maillage realiste des avions.
   *
   * Un avion ne reflechit que la lumiere du jour : sans elle, il redevient un
   * point de navigation clignotant, pas une silhouette grise visible. Le
   * repere en pixels fixes, lui, reste allume — c'est le seul qui vaille la
   * nuit, comme les feux de position dans la vraie vie.
   */
  const dayFactor = Math.min(1, Math.max(0.12, (sky.sunAltitude + 6) / 6))

  /**
   * Direction du Soleil dans le repere de la scene.
   *
   * Elle sert la diffusion vers l'avant des trainees de condensation : les
   * cristaux de glace renvoient bien plus de lumiere a contre-jour que dos au
   * Soleil, ce qui est exactement ce qui les fait ressortir en fin de journee.
   */
  const sunDirection = useMemo<[number, number, number]>(
    () => viewDirection(sky.sunAzimuth, sky.sunAltitude),
    [sky.sunAzimuth, sky.sunAltitude],
  )

  /**
   * Designation d'un objet par un clic dans la scene.
   *
   * Le balayage a deja ete ecarte en amont : ce rappel ne recoit que de vraies
   * intentions de pointage. Les avions sont testes en premier — une couche
   * mobile posee au-dessus du reste — avant de retomber sur le catalogue fixe
   * et les satellites. Un clic dans le vide deselectionne, ce qui donne un
   * moyen evident de refermer une fiche.
   */
  const onPick = useCallback(
    (request: PickRequest) => {
      if (layers.aircraft && aircraftStates.length > 0) {
        let bestHex: string | null = null
        let bestHorizontal: { azimuth: number; altitude: number } | null = null
        let bestDistance = Number.POSITIVE_INFINITY
        const pickNow = Date.now()
        for (const a of aircraftStates) {
          // On vise la position affichee a l'instant du clic, pas la derniere
          // mesure brute : entre deux sondages, l'icone a deja glisse.
          const geo = extrapolatedGeodetic(a, pickNow)
          const { horizontal } = geodeticToHorizontal(geo.latitude, geo.longitude, geo.altitudeKm, location)
          if (horizontal.altitude < -2) continue
          const d = angularDistance(request.aim, horizontal)
          if (d <= request.toleranceDeg && d < bestDistance) {
            bestDistance = d
            bestHex = a.hex
            bestHorizontal = horizontal
          }
        }
        if (bestHex && bestHorizontal) {
          selectAircraft(bestHex)
          setTab('objets')
          lookAt(bestHorizontal.azimuth, bestHorizontal.altitude)
          return
        }
      }

      const result = pickSkyTarget(
        request.direction,
        request.aim,
        request.toleranceDeg,
        date,
        location,
        {
          bodies: layers.bodies ? bodies : [],
          satellites: satellites
            .map((element) => ({ element, state: satStates.get(element.id) }))
            .filter((e): e is { element: (typeof satellites)[number]; state: NonNullable<typeof e.state> } =>
              Boolean(e.state),
            ),
          limitingMagnitude,
          includeStars: layers.stars,
          includeDeepSky: layers.deepSky,
        },
        pickMatrix.current,
      )

      if (!result) {
        select(null)
        return
      }

      select({ kind: result.target.kind, id: result.target.id })
      setTab(result.target.kind === 'satellite' ? 'satellites' : 'objets')
      lookAt(result.horizontal.azimuth, result.horizontal.altitude)
    },
    [
      date,
      location,
      layers,
      bodies,
      satellites,
      satStates,
      aircraftStates,
      limitingMagnitude,
      select,
      selectAircraft,
      setTab,
      lookAt,
    ],
  )

  const bodyColors = useMemo(() => {
    const map = new Map<string, string>()
    for (const def of BODIES) map.set(def.id, readToken(def.colorToken, '#ffffff'))
    return map
  }, [])

  /**
   * Objets fixes nommes dans le champ.
   *
   * La recherche parcourt le catalogue du ciel profond : la relancer a chaque
   * degre de balayage la rendrait continue. On arrondit donc la direction de
   * visee au dixieme du champ — en dessous, aucune etiquette n'entre ni ne sort.
   */
  const viewQuantum = Math.max(0.05, fov * 0.1)
  const aimKey = `${Math.round(viewAzimuth / viewQuantum)}:${Math.round(viewAltitude / viewQuantum)}:${Math.round(
    Math.log2(fov) * 4,
  )}`
  const fieldLabelData = useMemo(() => {
    if (!layers.bodyLabels) return []
    return fieldLabels(
      viewDirection(viewAzimuth, viewAltitude),
      fov,
      date,
      location,
      limitingMagnitude,
      { includeStars: layers.stars, includeDeepSky: layers.deepSky },
      fieldMatrix.current,
    )
    // `aimKey` resume la visee : c'est lui qui declenche le recalcul.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aimKey, date, location, limitingMagnitude, layers.bodyLabels, layers.stars, layers.deepSky])

  /** Etiquettes affichees par-dessus la scene. */
  const labels = useMemo(() => {
    const out: SceneLabel[] = []

    if (layers.cardinals) {
      for (const c of CARDINALS) {
        out.push({
          id: `cardinal-${c.short}`,
          text: c.short,
          horizontal: { azimuth: c.azimuth, altitude: 0 },
          color: colors.cardinal,
          kind: 'cardinal',
        })
      }
    }

    if (layers.bodyLabels) {
      for (const b of bodies) {
        if (b.horizontal.altitude < -5) continue
        // On n'etiquette que ce qui est effectivement perceptible.
        if (b.magnitude > limitingMagnitude + 0.5) continue
        out.push({
          id: `body-${b.id}`,
          text: b.name,
          horizontal: b.horizontal,
          color: bodyColors.get(b.id) ?? colors.onSurface,
          kind: 'body',
          // Le disque grossit avec le zoom : l'etiquette suit son bord au lieu
          // de rester a quatorze pixels du centre, ou elle finirait posee au
          // milieu de la planete.
          angularRadiusDeg: (b.angularDiameter / 2) * discScale,
        })
      }

      // Etoiles et objets du ciel profond presents dans le champ. Le seuil de
      // magnitude suit le grossissement : au grand angle on ne nomme que les
      // astres de premiere grandeur, en resserrant on descend plus bas.
      for (const f of fieldLabelData) {
        out.push({
          id: f.id,
          text: f.name,
          horizontal: f.horizontal,
          color: f.kind === 'star' ? colors.onSurfaceVariant : colors.deepSkyLabel,
          kind: 'fixed',
          angularRadiusDeg: f.angularRadiusDeg,
        })
      }
    }

    // Les satellites du catalogue se comptent par centaines : les etiqueter tous
    // couvrirait le ciel de texte. Les orbites saisies portent leur nom, le
    // catalogue ne nomme que l'objet selectionne.
    for (const el of satellites) {
      if (el.source === 'celestrak' && el.id !== selectedSatellite) continue
      const s = satStates.get(el.id)
      if (!s || s.horizontal.altitude < -5) continue
      out.push({
        id: `sat-${el.id}`,
        text: el.name,
        horizontal: s.horizontal,
        color: el.color,
        kind: 'satellite',
      })
    }

    // Repere de chaque avion : c'est lui, pas le maillage realiste, qui reste
    // visible quel que soit le grossissement. Sa position se recalcule a
    // chaque image (voir `resolve`) : sans ca, l'icone resterait figee entre
    // deux sondages ADS-B, vingt secondes durant.
    if (layers.aircraft) {
      for (const a of aircraftStates) {
        if (a.horizontal.altitude < -2) continue
        out.push({
          id: `aircraft-${a.hex}`,
          text: 'flight',
          horizontal: a.horizontal,
          resolve: () => {
            const geo = extrapolatedGeodetic(a, Date.now())
            return geodeticToHorizontal(geo.latitude, geo.longitude, geo.altitudeKm, location).horizontal
          },
          color: '',
          kind: 'aircraft',
        })
      }
    }

    return out
  }, [layers, bodies, satellites, satStates, selectedSatellite, aircraftStates, colors, bodyColors, limitingMagnitude])

  // Les figures ne se lisent que sur un ciel sombre : inutile de les etiqueter
  // en plein jour, ou les etoiles qui les portent sont invisibles.
  const showConstellationLabels = layers.constellationLabels && limitingMagnitude > 2
  const constellationLabelData = useMemo(() => {
    if (!showConstellationLabels) return []
    return constellationLabels(date)
  }, [showConstellationLabels, date.getUTCFullYear()]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="sky-canvas" ref={host}>
      <Canvas
        // `far` englobe le disque de sol ; `near` reste assez court pour un
        // satellite en orbite basse, place a moins de dix unites.
        camera={{ fov, near: 0.1, far: 900, position: [0, 0, 0] }}
        gl={{ antialias: true, alpha: false, toneMapping: NoToneMapping }}
        dpr={[1, 2]}
      >
        <CameraRig canvas={host} onPick={onPick} />

        <SkyBackground
          atmosphereExposure={atmosphereExposure}
          sunAltitude={sky.sunAltitude}
          sunAzimuth={sky.sunAzimuth}
          moonAltitude={layers.atmosphere ? sky.moonAltitude : -90}
          moonAzimuth={moon?.horizontal.azimuth ?? 0}
          lunarLux={layers.atmosphere ? sky.lunarLux : 0}
          nightColor={colors.skyZenith}
          moonGlowColor={colors.moonGlow}
          aerosolTurbidity={aerosolTurbidity}
          pollutionGain={pollutionGain}
          pollutionColor={colors.lightPollution}
        />

        {layers.stars && (
          <Starfield
            date={date}
            location={location}
            magnitudeLimit={magnitudeLimit}
            limitingMagnitude={limitingMagnitude}
          />
        )}
        {layers.constellations && (
          <ConstellationLines date={date} location={location} color={colors.constellation} darkness={sky.darkness} />
        )}
        {layers.deepSky && (
          <DeepSky
            date={date}
            location={location}
            magnitudeLimit={DEEP_SKY_MAG_LIMIT}
            limitingMagnitude={limitingMagnitude}
            illuminance={illuminance}
            resolveToken={readToken}
          />
        )}

        {layers.equatorialGrid && (
          <EquatorialGrid
            date={date}
            location={location}
            color={colors.equatorialGrid}
            equatorColor={colors.equatorialGrid}
            opacity={0.55}
          />
        )}
        {layers.ecliptic && <EclipticLine date={date} location={location} color={colors.ecliptic} opacity={0.7} />}
        {layers.horizonGrid && <HorizonGrid color={colors.horizonGrid} opacity={0.3} />}

        {layers.bodies && (
          <SolarSystemBodies
            states={bodies}
            date={date}
            location={location}
            limitingMagnitude={limitingMagnitude}
            discScale={discScale}
            sunDirection={sunDirection}
            atmosphereExposure={atmosphereExposure}
            aerosolTurbidity={aerosolTurbidity}
            colors={bodyColors}
            sunGlowColor={colors.sunGlow}
            textures={textures}
            selectedId={selectedBody}
            selectionColor={colors.selection}
          />
        )}

        {satellites.length > 0 && (
          <SatelliteLayer
            elements={satellites}
            states={satStates}
            tracks={satTracks}
            showTracks={layers.satelliteTracks}
            palette={colors.track}
            limitingMagnitude={limitingMagnitude}
            selectedId={selectedSatellite}
          />
        )}

        {layers.aircraft && aircraftStates.length > 0 && (
          <AircraftLayer
            states={aircraftStates}
            location={location}
            sunDirection={sunDirection}
            atmosphereExposure={atmosphereExposure}
            aerosolTurbidity={aerosolTurbidity}
            dayFactor={dayFactor}
            selectedHex={selectedAircraftHex}
            trackColor={colors.selection}
          />
        )}

        <HorizonLine color={colors.horizonLine} />
        {layers.ground && <Ground color={colors.ground} glowColor={colors.groundGlow} illuminance={illuminance} />}

        <LabelLayer labels={labels} host={labelHost} />
        {constellationLabelData.length > 0 && (
          <ConstellationLabels labels={constellationLabelData} host={labelHost} color={colors.constellationLabel} />
        )}

        {/* Le tampon en virgule flottante laisse passer les valeurs superieures a
            1 : c'est ce qui permet au Soleil, rendu a intensite 6, de deborder en
            halo lumineux plutot que d'etre simplement ecrete au blanc. */}
        {layers.bloom && (
          <EffectComposer multisampling={0}>
            {/* Seuil a 1 : le ciel, ramene sous 1 par la courbe filmique, ne
                deborde pas. Seules les vraies sources — le Soleil, rendu a
                intensite 6 — alimentent le halo. */}
            <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.15} intensity={1.2} radius={0.8} />
          </EffectComposer>
        )}
      </Canvas>
      <div className="sky-labels" ref={labelHost} aria-hidden="true" />
    </div>
  )
}

/** Etiquettes de constellations : coordonnees equatoriales projetees a chaque instant. */
function ConstellationLabels({
  labels,
  host,
  color,
}: {
  labels: Array<{ id: string; name: string; ra: number; dec: number }>
  host: React.RefObject<HTMLDivElement>
  color: string
}) {
  const date = useSimulatedDate()
  const location = useSkyStore((s) => s.location)

  const projected = useMemo<SceneLabel[]>(() => {
    return labels
      .map((l) => ({
        id: `const-${l.id}`,
        text: l.name,
        horizontal: equatorialToHorizontal({ ra: l.ra, dec: l.dec }, location, date),
        color,
        kind: 'constellation' as const,
      }))
      .filter((l) => l.horizontal.altitude > -5)
  }, [labels, location, date, color])

  return <LabelLayer labels={projected} host={host} />
}
