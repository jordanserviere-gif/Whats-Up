import { useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { NoToneMapping } from 'three'
import { BODIES } from '@/astro/bodies'
import { CARDINALS, equatorialToHorizontal } from '@/astro/coords'
import { useSkyStore } from '@/state/store'
import {
  useBodyStates,
  useSatelliteStates,
  useSatelliteTracks,
  useSimulatedDate,
  useSkyConditions,
} from '@/state/hooks'
import { readToken } from './sceneMath'
import { useSceneColors } from './useSceneColors'
import { CameraRig } from './CameraRig'
import { Starfield } from './Starfield'
import { ConstellationLines } from './ConstellationLines'
import { EclipticLine, EquatorialGrid, HorizonGrid, HorizonLine } from './Grids'
import { Ground, SkyDome } from './SkyDome'
import { Atmosphere } from './Atmosphere'
import { SolarSystemBodies } from './Bodies'
import { useBodyTextures } from './useBodyTextures'
import { SatelliteLayer } from './Satellites'
import { LabelLayer, type SceneLabel } from './LabelLayer'
import { constellationLabels } from '@/astro/catalog'
import './SkyCanvas.css'

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
  const fov = useSkyStore((s) => s.fov)
  const satellites = useSkyStore((s) => s.satellites)
  const selectedBody = useSkyStore((s) => s.selectedBody)
  const selectedSatellite = useSkyStore((s) => s.selectedSatellite)
  const selectBody = useSkyStore((s) => s.selectBody)
  const selectSatellite = useSkyStore((s) => s.selectSatellite)

  const bodies = useBodyStates()
  const sky = useSkyConditions()
  // Miroir des ephemerides pour le navigateur automatise : il a besoin de
  // connaitre la position d'un corps pour pointer la camera dessus.
  if (import.meta.env.DEV) (window as unknown as { __bodyStates: unknown }).__bodyStates = bodies
  const satStates = useSatelliteStates()
  const satTracks = useSatelliteTracks()
  const colors = useSceneColors()
  const textures = useBodyTextures()

  const moon = bodies.find((b) => b.id === 'moon')

  // Sans le calque « atmosphere », on regarde le ciel comme depuis l'espace :
  // magnitude limite fixee au catalogue, aucune diffusion diurne.
  const limitingMagnitude = layers.atmosphere ? sky.limitingMagnitude : 6.6
  const illuminance = layers.atmosphere ? sky.illuminance : 2e-4
  const solarLux = layers.atmosphere ? sky.solarLux : 0

  const bodyColors = useMemo(() => {
    const map = new Map<string, string>()
    for (const def of BODIES) map.set(def.id, readToken(def.colorToken, '#ffffff'))
    return map
  }, [])

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
        })
      }
    }

    if (layers.satellites) {
      for (const el of satellites) {
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
    }

    return out
  }, [layers, bodies, satellites, satStates, colors, bodyColors, limitingMagnitude])

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
        onPointerMissed={() => {
          selectBody(null)
          selectSatellite(null)
        }}
      >
        <CameraRig canvas={host} />

        <SkyDome
          illuminance={illuminance}
          solarLux={solarLux}
          sunAltitude={sky.sunAltitude}
          sunAzimuth={sky.sunAzimuth}
          moonAltitude={layers.atmosphere ? sky.moonAltitude : -90}
          moonAzimuth={moon?.horizontal.azimuth ?? 0}
          lunarLux={layers.atmosphere ? sky.lunarLux : 0}
          nightColor={colors.skyZenith}
          dayColor={colors.skyDay}
          horizonColor={colors.skyHorizon}
          twilightColor={colors.twilight}
          moonGlowColor={colors.moonGlow}
        />

        {layers.atmosphere && (
          <Atmosphere
            sunAltitude={sky.sunAltitude}
            sunAzimuth={sky.sunAzimuth}
            solarLux={sky.solarLux}
            obscuration={sky.obscuration}
          />
        )}

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
            colors={bodyColors}
            sunGlowColor={colors.sunGlow}
            textures={textures}
            selectedId={selectedBody}
            selectionColor={colors.selection}
            onSelect={(id) => selectBody(id as never)}
          />
        )}

        {layers.satellites && (
          <SatelliteLayer
            elements={satellites}
            states={satStates}
            tracks={satTracks}
            showTracks={layers.satelliteTracks}
            palette={colors.track}
            limitingMagnitude={limitingMagnitude}
            selectedId={selectedSatellite}
            onSelect={selectSatellite}
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
            <Bloom mipmapBlur luminanceThreshold={0.9} luminanceSmoothing={0.2} intensity={1.1} radius={0.85} />
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
