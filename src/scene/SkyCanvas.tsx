import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { DisplayEffect } from './display/DisplayEffect'
import { RADIANCE_AT_DISPLAY_WHITE } from './display/tonemap'
import { HalfFloatType, Matrix4, NoToneMapping } from 'three'
import { BODIES } from '@/astro/bodies'
import { ozoneColumnDu as ozoneColumnDuFor } from '@/atmosphere/absorption/ozoneClimatology'
import { CARDINALS, equatorialToHorizontal } from '@/astro/coords'
import { useSkyStore, selectedBodyId, selectedSatelliteId } from '@/state/store'
import {
  useAerosolAutoSync,
  useLightPollutionAutoSync,
  useAllSatellites,
  useBodyStates,
  useNearbyAircraft,
  useSatelliteStates,
  useSatelliteTracks,
  useSimulatedDate,
  useSkyConditions,
} from '@/state/hooks'
import { fixedEquatorialJ2000 } from '@/astro/search'
import { precessFromJ2000 } from '@/astro/coords'
import { angularDistance, readToken, viewDirection } from './sceneMath'
import { pickSkyTarget } from './picking'
import { fieldLabels } from './fieldLabels'
import { useSceneColors } from './useSceneColors'
import { CameraRig, type PickRequest } from './CameraRig'
import { Starfield } from './Starfield'
import { ConstellationLines } from './ConstellationLines'
import { DeepSky } from './DeepSky'
import { EclipticLine, EquatorialGrid, HorizonGrid, HorizonLine } from './Grids'
import { Globe } from './Globe'
import { Terrain } from './Terrain'
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
import { directSolar, sunDiscTint } from '@/atmosphere/transport/directSolar'
import { uniformSpectralGrid } from '@/atmosphere/spectral/SpectralGrid'
import { ATMOSPHERE_TOP_M } from '@/atmosphere/transport/slantPath'
import { SKY_DISPLAY_EXPOSURE } from './display/exposure'
import './SkyCanvas.css'

const EMPTY_AIRCRAFT: AircraftState[] = []

/**
 * Grille spectrale du transport solaire direct.
 *
 * Trente-deux bandes sur le visible : largement assez pour une **couleur**,
 * dont la resolution utile est fixee par la largeur des fonctions
 * colorimetriques, pas par la finesse du spectre. Les raies de Fraunhofer sont
 * moyennees par bande, sans perte d'energie — voir `SpectralGrid.ts`.
 */
const SOLAR_GRID = uniformSpectralGrid(360, 830, 32)

/** Halo urbain sans teinte : il ne fait qu'eclaircir le ciel. */
const NEUTRAL_GLOW = '#ffffff'

/**
 * Teinte a donner au halo urbain, ou `null` pour n'en donner aucune.
 *
 * L'ambre du token `--app-sky-light-pollution` decrit une nuit de ville vue a
 * travers une atmosphere chargee : ce sont les gouttelettes et les aerosols
 * qui, en diffusant la lumiere des lampes, en revelent la couleur. Par temps
 * sec et par air clair, la meme lumiere remonte sans rencontrer grand-chose et
 * le halo reste bien plus neutre — le teinter alors donne un ciel orange qui
 * n'existe pas.
 *
 * Faute d'un critere d'humidite auquel l'asservir, la teinte reste desactivee.
 * Rendre la constante egale a `colors.lightPollution` suffit a la retablir le
 * jour ou ce critere existera.
 */
const LIGHT_POLLUTION_TINT: string | null = null

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
  const elevationOffsetM = useSkyStore((s) => s.elevationOffsetM)
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
  const selection = useSkyStore((s) => s.selection)
  const cameraLocked = useSkyStore((s) => s.cameraLocked)
  const select = useSkyStore((s) => s.select)
  const selectAircraft = useSkyStore((s) => s.selectAircraft)
  const setTab = useSkyStore((s) => s.setTab)
  const focusOn = useSkyStore((s) => s.focusOn)
  const trackTo = useSkyStore((s) => s.trackTo)

  const bodies = useBodyStates()
  const sky = useSkyConditions()
  useAerosolAutoSync()
  useLightPollutionAutoSync()
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
   * Attenuation due a une eclipse, partagee par les deux echelles d'exposition.
   *
   * Le plancher de 8·10⁻⁴ represente l'atmosphere eclairee hors de l'ombre :
   * pendant la totalite le ciel devient crepusculaire, pas noir. C'est une
   * approximation — la vraie luminance sous l'ombre vient d'un transport
   * horizontal depuis la penombre, hors de portee d'un modele a symetrie de
   * revolution.
   */
  const eclipseDimming = Math.sqrt(1 - sky.obscuration + 8e-4 * sky.obscuration)

  /**
   * Distance Terre-Soleil, ua — prise de l'ephemeride, non supposee unitaire.
   *
   * Elle varie de 0,983 au perihelie a 1,017 a l'aphelie : l'eclairement, en
   * `1/d²`, varie donc de 6,9 % sur l'annee. Le transport savait deja le prendre
   * en compte, personne ne le lui donnait.
   */
  const sunDistanceAu = bodies.find((b) => b.id === 'sun')?.distanceAu ?? 1

  /**
   * Colonne d'ozone du lieu et de la saison, DU.
   *
   * L'ozone est ce qui rend le crepuscule bleu, et sa colonne va de 245 DU sous
   * les tropiques a plus de 400 aux hautes latitudes au printemps. Le moteur
   * employait 300 partout — voir `atmosphere/absorption/ozoneClimatology.ts`,
   * dont la parametrisation est signalee comme une interpolation et non une
   * climatologie publiee.
   */
  const ozoneColumnDu = useMemo(
    () => ozoneColumnDuFor(location.latitude, date),
    [location.latitude, date],
  )


  /**
   * Exposition d'affichage du ciel physique — voir `display/exposure.ts`.
   *
   * Elle porte la radiance reelle de la table de ciel dans l'espace du
   * transform d'affichage. Distincte de `atmosphereExposure`, qui reste une
   * constante de calibrage de l'ancien noyau : les deux echelles coexistent le
   * temps que les corps et les avions passent au meme transport (phase 9).
   */
  const skyExposure = layers.atmosphere ? SKY_DISPLAY_EXPOSURE * eclipseDimming : 0

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
    // Le rapport se prend sur tout ce qui n'est pas l'eclairage public — de
    // nuit c'est l'airglow seul, et l'on retrouve alors exactement la valeur
    // d'avant ; de jour c'est le Soleil, cent mille lux contre deux
    // centiemes, et le halo disparait de lui-meme. Les lampes ne s'eteignent
    // pas au lever du jour : c'est le ciel qui les noie.
    const natural = Math.max(AIRGLOW_LUX, sky.illuminance - sky.pollutionLux)
    return (Math.pow(sky.illuminance / natural, 1 / 2.2) - 1) * nightLuma
  }, [layers.atmosphere, sky.pollutionLux, sky.illuminance])

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
   * Couleur du disque solaire, transmise par l'atmosphere reelle.
   *
   * Le calcul integre la densite moleculaire le long du trajet oblique — quatre
   * mille pas — puis applique Beer-Lambert bande par bande. C'est trop cher
   * pour chaque image, et parfaitement inutile : la hauteur du Soleil varie de
   * quinze degres par heure, soit un vingtieme de degre en douze secondes. On
   * quantifie donc la visee a ce pas, ce qui borne le recalcul sans qu'aucune
   * transition ne se voie.
   *
   * Sans le calque « atmosphere », l'observateur est place au sommet de
   * l'atmosphere : le Soleil y garde son spectre hors atmosphere, plus brillant
   * et plus bleu, ce qui est exactement ce qu'on voit depuis l'espace.
   */
  const sunAltitudeKey = Math.round(sky.sunAltitude * 20) / 20
  const observerElevationM = layers.atmosphere ? location.elevation : ATMOSPHERE_TOP_M
  const sunTint = useMemo<[number, number, number]>(
    () => sunDiscTint(SOLAR_GRID, sunAltitudeKey, { observerElevationM }),
    [sunAltitudeKey, observerElevationM],
  )

  /**
   * Irradiance solaire directe au sol, sRGB lineaire — **non normalisee**.
   *
   * `sunTint` ci-dessus rend la meme grandeur ramenee a une luminance unite au
   * zenith : c'est ce qu'il faut pour **teinter** un disque, et exactement ce
   * qu'il ne faut pas pour **eclairer** une surface. Une surface a besoin de la
   * grandeur absolue, sur la meme echelle que la table de ciel — les deux
   * passent par `spectralToLinearSrgb`, donc elles y sont deja.
   *
   * ⚠️ Elle n'etait autrefois calculee que si le banc de relief etait allume.
   * Le globe est maintenant une **surface eclairee** en permanence, et la
   * couper reviendrait a eteindre le Soleil sur la moitie de la scene. Le
   * calcul integre quatre mille pas le long du trajet oblique, mais il ne
   * depend que de la hauteur solaire quantifiee : il ne se refait donc que
   * lorsque celle-ci bouge, pas a chaque image.
   */
  const sunIrradiance = useMemo<[number, number, number]>(() => {
    const rgb = directSolar(SOLAR_GRID, sunAltitudeKey, { observerElevationM }).linearSrgb
    return [rgb[0], rgb[1], rgb[2]]
  }, [sunAltitudeKey, observerElevationM])

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
          focusOn(bestHorizontal.azimuth, bestHorizontal.altitude)
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
      focusOn(result.horizontal.azimuth, result.horizontal.altitude)
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
      focusOn,
    ],
  )

  /**
   * Suivi de l'objet verrouille.
   *
   * On republie simplement la position du moment a chaque fois qu'elle change.
   * Rien n'est dit ici de la vitesse d'ecoulement du temps : les ephemerides
   * sont recalculees a chaque avancee de l'horloge, donc la visee l'est aussi,
   * et le suivi tient de lui-meme en avance rapide comme en temps reel.
   */
  const followed = useMemo(() => {
    if (!cameraLocked) return null
    if (selectedAircraftHex) {
      const a = aircraftStates.find((x) => x.hex === selectedAircraftHex)
      if (!a) return null
      const geo = extrapolatedGeodetic(a, Date.now())
      return geodeticToHorizontal(geo.latitude, geo.longitude, geo.altitudeKm, location).horizontal
    }
    if (!selection) return null
    if (selection.kind === 'body') return bodies.find((b) => b.id === selection.id)?.horizontal ?? null
    if (selection.kind === 'satellite') return satStates.get(selection.id)?.horizontal ?? null
    const equatorial = fixedEquatorialJ2000(selection.kind, selection.id)
    return equatorial ? equatorialToHorizontal(precessFromJ2000(equatorial, date), location, date) : null
  }, [cameraLocked, selection, selectedAircraftHex, aircraftStates, bodies, satStates, date, location])

  const followAzimuth = followed?.azimuth ?? null
  const followAltitude = followed?.altitude ?? null
  useEffect(() => {
    if (followAzimuth !== null && followAltitude !== null) trackTo(followAzimuth, followAltitude)
  }, [followAzimuth, followAltitude, trackTo])

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
          skyExposure={skyExposure}
          observerElevationM={location.elevation}
          extraHeightM={elevationOffsetM}
          sunDistanceAu={sunDistanceAu}
          ozoneColumnDu={ozoneColumnDu}
          atmosphereEnabled={layers.atmosphere}
          aerosolTurbidity={aerosolTurbidity}
          sunAltitude={sky.sunAltitude}
          sunAzimuth={sky.sunAzimuth}
          moonAltitude={layers.atmosphere ? sky.moonAltitude : -90}
          moonAzimuth={moon?.horizontal.azimuth ?? 0}
          moonIrradianceRatio={layers.atmosphere ? sky.moonIrradianceRatio : 0}
          nightColor={colors.skyZenith}
          pollutionGain={pollutionGain}
          pollutionColor={LIGHT_POLLUTION_TINT ?? NEUTRAL_GLOW}
        />

        {layers.stars && (
          <Starfield
            date={date}
            location={location}
            magnitudeLimit={magnitudeLimit}
            limitingMagnitude={limitingMagnitude}
            aerosolTurbidity={aerosolTurbidity}
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
            aerosolTurbidity={aerosolTurbidity}
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
            sunTint={sunTint}
            skyExposure={skyExposure}
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
            skyExposure={skyExposure}
            dayFactor={dayFactor}
            selectedHex={selectedAircraftHex}
            trackColor={colors.selection}
          />
        )}

        <HorizonLine color={colors.horizonLine} />
        {/* L'altitude passee au globe est celle du **site**, non celle qui bascule
            a cent kilometres quand le calque atmosphere est eteint : la
            depression de l'horizon est une propriete du lieu, pas du calque. */}
        {layers.ground && (
          <Globe
            observerElevationM={location.elevation}
            extraHeightM={elevationOffsetM}
            sunDirection={sunDirection}
            sunIrradiance={sunIrradiance}
            skyExposure={skyExposure}
          />
        )}
        {layers.terrain && (
          <Terrain
            observerElevationM={location.elevation}
            extraHeightM={elevationOffsetM}
            latitudeDeg={location.latitude}
            longitudeDeg={location.longitude}
            sunDirection={sunDirection}
            sunIrradiance={sunIrradiance}
            sunAltitudeDeg={sky.sunAltitude}
            sunAzimuthDeg={sky.sunAzimuth}
            skyExposure={skyExposure}
          />
        )}

        <LabelLayer labels={labels} host={labelHost} />
        {constellationLabelData.length > 0 && (
          <ConstellationLabels labels={constellationLabelData} host={labelHost} color={colors.constellationLabel} />
        )}

        {/* Chaine d'affichage.

            La scene emet desormais de la **radiance lineaire non bornee** : le
            tone mapping ne vit plus dans les materiaux, il est applique une
            seule fois ici. Le composeur est donc inconditionnel — son format de
            tampon ne peut plus dependre d'un reglage d'interface — et rend en
            demi-flottant pour que les valeurs superieures au blanc survivent
            jusqu'a la passe d'affichage.

            L'ordre compte : le bloom passe **avant** le transform d'affichage.
            Un halo lumineux est un phenomene optique, il se produit sur la
            lumiere et non sur des pixels deja compresses. Son seuil s'exprime
            de ce fait en radiance — celle qui s'affiche exactement en blanc —
            la ou l'ancien seuil de 1 se comparait a des valeurs deja ecretees,
            ce qui interdisait structurellement au ciel de deborder quelle que
            soit sa luminance reelle.

            Le multisampling reste demande explicitement : le composeur rend
            hors ecran, ou l'antialiasing du contexte WebGL ne s'applique pas.
            Sans lui, les traits fins scintillent des que le ciel tourne. */}
        <EffectComposer multisampling={4} frameBufferType={HalfFloatType}>
          {layers.bloom ? (
            <Bloom
              mipmapBlur
              luminanceThreshold={RADIANCE_AT_DISPLAY_WHITE}
              luminanceSmoothing={0.15}
              intensity={1.2}
              radius={0.8}
            />
          ) : (
            <></>
          )}
          <DisplayEffect />
        </EffectComposer>
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
