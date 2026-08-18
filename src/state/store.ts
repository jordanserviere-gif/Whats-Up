import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { BodyId, GeoLocation, OrbitalElements } from '@/astro/types'
import type { TargetKind } from '@/astro/search'
import type { CelestrakGroup } from '@/data-sources/celestrak'
import { defaultElements } from '@/astro/kepler'
import { DEFAULT_STATUS, type SourceStatus } from '@/data-sources/types'

export type ViewTab = 'ciel' | 'objets' | 'satellites' | 'reglages'

/**
 * Objet designe dans la scene ou par la recherche.
 *
 * Une seule selection pour toutes les familles : c'est ce qui permet de cliquer
 * indifferemment une planete, une etoile ou un satellite et d'obtenir une fiche,
 * sans qu'aucune couche n'ait a savoir ce que les autres ont selectionne.
 */
export interface SkySelection {
  kind: TargetKind
  id: string
}

/**
 * Multiplicateurs de vitesse d'ecoulement du temps.
 *
 * Le libelle reste un multiple, y compris pour le temps reel : « temps réel »
 * etait deux fois plus long que tous les autres et se faisait tronquer dans la
 * serie. Le sens complet passe par `title`, lu par les technologies d'assistance
 * comme par l'info-bulle du navigateur.
 */
export const TIME_SPEEDS = [
  { value: 1, label: '×1', title: 'temps réel' },
  { value: 60, label: '×60', title: 'une minute par seconde' },
  { value: 600, label: '×600', title: 'dix minutes par seconde' },
  { value: 3600, label: '×1 h/s', title: 'une heure par seconde' },
  { value: 86400, label: '×1 j/s', title: 'un jour par seconde' },
] as const

export const PRESET_LOCATIONS: readonly GeoLocation[] = [
  { name: 'Paris', latitude: 48.8566, longitude: 2.3522, elevation: 35 },
  { name: 'Marseille', latitude: 43.2965, longitude: 5.3698, elevation: 12 },
  { name: 'Pic du Midi', latitude: 42.9369, longitude: 0.1425, elevation: 2877 },
  { name: 'Nançay', latitude: 47.38, longitude: 2.1956, elevation: 145 },
  { name: 'Bruxelles', latitude: 50.8503, longitude: 4.3517, elevation: 13 },
  { name: 'Montréal', latitude: 45.5019, longitude: -73.5674, elevation: 36 },
  { name: 'Nouméa', latitude: -22.2758, longitude: 166.458, elevation: 15 },
  { name: 'La Réunion', latitude: -21.1151, longitude: 55.5364, elevation: 75 },
  { name: 'Cerro Paranal', latitude: -24.6272, longitude: -70.4039, elevation: 2635 },
] as const

/** Calques affichables dans la scene. */
export interface LayerVisibility {
  stars: boolean
  constellations: boolean
  constellationLabels: boolean
  bodies: boolean
  bodyLabels: boolean
  /** Objets du ciel profond : galaxies, amas, nebuleuses. */
  deepSky: boolean
  horizonGrid: boolean
  equatorialGrid: boolean
  ecliptic: boolean
  ground: boolean
  cardinals: boolean
  atmosphere: boolean
  /** Satellites saisis a la main dans l'outil orbital. */
  satellites: boolean
  /** Satellites reels recuperes depuis CelesTrak. */
  celestrak: boolean
  satelliteTracks: boolean
  /** Avions reels recuperes en direct (ADS-B), dans un rayon autour du lieu. */
  aircraft: boolean
  /** Flou lumineux autour des sources vives : le halo du Soleil en depend. */
  bloom: boolean
}

interface SkyState {
  // --- Temps ---
  /** Instant simule. */
  time: number
  /** Le temps suit-il l'horloge ? */
  live: boolean
  playing: boolean
  speed: number
  setTime: (t: number) => void
  nudgeTime: (deltaMs: number) => void
  goLive: () => void
  setPlaying: (p: boolean) => void
  setSpeed: (s: number) => void

  // --- Lieu ---
  location: GeoLocation
  setLocation: (l: GeoLocation) => void

  // --- Vue ---
  tab: ViewTab
  setTab: (t: ViewTab) => void
  panelOpen: boolean
  setPanelOpen: (o: boolean) => void
  /** Direction de visee : azimut et hauteur du centre de l'ecran. */
  viewAzimuth: number
  viewAltitude: number
  fov: number
  setView: (azimuth: number, altitude: number) => void
  setFov: (fov: number) => void
  /** Recentre la vue sur un objet. */
  lookAtTarget: { azimuth: number; altitude: number; key: number } | null
  /** Recentrage ponctuel : la camera cesse de suivre ce qu'elle suivait. */
  lookAt: (azimuth: number, altitude: number) => void
  /**
   * La camera reste-t-elle accrochee a l'objet selectionne ?
   *
   * Le verrou ne connait pas l'objet : il dit seulement que la visee doit
   * rester celle de la selection. C'est la scene qui republie cette position a
   * chaque mise a jour des ephemerides — donc aussi souvent que le temps
   * avance, sans que la vitesse d'ecoulement ait a etre traitee a part.
   */
  cameraLocked: boolean
  /** Recentre sur un objet et l'y accroche. */
  focusOn: (azimuth: number, altitude: number) => void
  /** Reprise de visee du suivi : ne cree ni ne libere le verrou. */
  trackTo: (azimuth: number, altitude: number) => void
  /** Libere le verrou — un balayage du ciel reprend la main. */
  unlockCamera: () => void

  // --- Selection ---
  selection: SkySelection | null
  /** Selectionne un objet, quelle que soit sa famille. */
  select: (selection: SkySelection | null) => void
  selectBody: (id: BodyId | null) => void
  selectSatellite: (id: string | null) => void
  /**
   * Avion designe.
   *
   * A part : un avion n'appartient a aucun catalogue et ne se cherche pas par
   * nom, contrairement aux familles couvertes par `SkySelection`. Selectionner
   * l'un efface l'autre, pour qu'une seule fiche s'affiche a la fois.
   */
  selectedAircraftHex: string | null
  selectAircraft: (hex: string | null) => void

  // --- Calques ---
  layers: LayerVisibility
  toggleLayer: (key: keyof LayerVisibility) => void
  setLayer: (key: keyof LayerVisibility, value: boolean) => void
  /** Magnitude limite des etoiles affichees. */
  magnitudeLimit: number
  setMagnitudeLimit: (m: number) => void
  /**
   * Grossissement des disques planetaires. 1 = diametre apparent vrai, ce qui
   * est la valeur par defaut : au-dela, on quitte la realite pour la lisibilite.
   */
  discScale: number
  setDiscScale: (s: number) => void
  /**
   * Pollution lumineuse du site, sur l'echelle de Bortle (1 a 9).
   *
   * Par defaut 1 : le rendu reste alors celui d'un ciel naturel, sans rien
   * d'ajoute. C'est un choix delibere — une valeur realiste pour un lieu urbain
   * effacerait d'emblee la quasi-totalite des etoiles, ce qui est fidele mais
   * fait un mauvais etat initial pour une carte du ciel.
   */
  lightPollution: number
  setLightPollution: (bortle: number) => void
  /**
   * Pollution lumineuse asservie a l'atlas mesure plutot qu'au curseur — voir
   * `useLightPollutionAutoSync` dans `state/hooks.ts`. Comme pour les
   * aerosols, `lightPollution` reste la meme valeur dans les deux cas : seule
   * change la main qui l'ecrit.
   */
  lightPollutionAuto: boolean
  setLightPollutionAuto: (auto: boolean) => void
  /** Provenance de la derniere lecture d'atlas -- defaut tant qu'aucune n'a abouti. */
  autoLightPollutionStatus: SourceStatus
  /** Brillance de fond mesuree au lieu courant, en mag/arcsec². Nulle sans mesure. */
  measuredSkyBrightness: number | null
  /**
   * Trouble atmospherique — charge en aerosols, multipliant la diffusion de
   * Mie. 1 = air standard du modele (une epaisseur optique de 0,025, soit un
   * air tres pur) ; au-dela, l'horizon blanchit et les astres bas s'eteignent,
   * comme sous une brume de pollution ou d'humidite.
   */
  aerosolTurbidity: number
  setAerosolTurbidity: (t: number) => void
  /**
   * Trouble asservi a une mesure reelle de qualite de l'air (AOD) plutot qu'au
   * curseur manuel — voir `useAerosolAutoSync` dans `state/hooks.ts`. Le
   * curseur reste utilisable des que ce mode est desactive : `aerosolTurbidity`
   * est la meme valeur dans les deux cas, seule change la main qui l'ecrit.
   */
  aerosolAuto: boolean
  setAerosolAuto: (auto: boolean) => void
  /** Provenance de la derniere mesure d'AOD -- defaut tant qu'aucune n'a abouti. */
  autoAerosolStatus: SourceStatus

  // --- Satellites ---
  satellites: OrbitalElements[]
  addSatellite: (el?: OrbitalElements) => string
  updateSatellite: (id: string, patch: Partial<OrbitalElements>) => void
  removeSatellite: (id: string) => void
  /** Fenetre de trace affichee autour de l'instant courant, en minutes. */
  trackWindowMinutes: number
  setTrackWindow: (m: number) => void

  // --- Catalogue CelesTrak ---
  /** Groupe d'objets suivi. Un seul a la fois : les groupes se comptent en milliers. */
  celestrakGroup: CelestrakGroup
  setCelestrakGroup: (g: CelestrakGroup) => void
}

const DEFAULT_LAYERS: LayerVisibility = {
  stars: true,
  constellations: true,
  constellationLabels: false,
  bodies: true,
  bodyLabels: true,
  deepSky: true,
  horizonGrid: false,
  equatorialGrid: false,
  ecliptic: false,
  ground: true,
  cardinals: true,
  atmosphere: true,
  satellites: true,
  celestrak: false,
  satelliteTracks: true,
  aircraft: false,
  bloom: true,
}

let satSeq = 0
const nextSatId = () => `sat-${Date.now().toString(36)}-${++satSeq}`

export const useSkyStore = create<SkyState>()(
  persist(
    (set, get) => ({
      time: Date.now(),
      live: true,
      playing: true,
      speed: 1,
      setTime: (t) => set({ time: t, live: false }),
      nudgeTime: (deltaMs) => set((s) => ({ time: s.time + deltaMs, live: false })),
      goLive: () => set({ time: Date.now(), live: true, playing: true, speed: 1 }),
      setPlaying: (playing) => set({ playing }),
      setSpeed: (speed) => set({ speed, live: speed === 1 ? get().live : false }),

      location: PRESET_LOCATIONS[0],
      setLocation: (location) => set({ location }),

      tab: 'ciel',
      setTab: (tab) => set({ tab, panelOpen: true }),
      panelOpen: true,
      setPanelOpen: (panelOpen) => set({ panelOpen }),

      viewAzimuth: 180,
      viewAltitude: 30,
      fov: 65,
      setView: (viewAzimuth, viewAltitude) => set({ viewAzimuth, viewAltitude }),
      setFov: (fov) => set({ fov }),
      lookAtTarget: null,
      lookAt: (azimuth, altitude) =>
        set({ lookAtTarget: { azimuth, altitude, key: Date.now() }, cameraLocked: false }),
      cameraLocked: false,
      focusOn: (azimuth, altitude) =>
        set({ lookAtTarget: { azimuth, altitude, key: Date.now() }, cameraLocked: true }),
      trackTo: (azimuth, altitude) => set({ lookAtTarget: { azimuth, altitude, key: Date.now() } }),
      unlockCamera: () => set((s) => (s.cameraLocked ? { cameraLocked: false } : s)),

      selection: null,
      // Deselectionner libere le verrou : il n'y a plus rien a suivre.
      select: (selection) =>
        set({ selection, selectedAircraftHex: null, cameraLocked: selection !== null && get().cameraLocked }),
      selectBody: (id) => set({ selection: id ? { kind: 'body', id } : null, selectedAircraftHex: null }),
      selectSatellite: (id) => set({ selection: id ? { kind: 'satellite', id } : null, selectedAircraftHex: null }),
      selectedAircraftHex: null,
      selectAircraft: (hex) => set(hex ? { selectedAircraftHex: hex, selection: null } : { selectedAircraftHex: null }),

      layers: DEFAULT_LAYERS,
      toggleLayer: (key) => set((s) => ({ layers: { ...s.layers, [key]: !s.layers[key] } })),
      setLayer: (key, value) => set((s) => ({ layers: { ...s.layers, [key]: value } })),
      magnitudeLimit: 6,
      setMagnitudeLimit: (magnitudeLimit) => set({ magnitudeLimit }),
      discScale: 1,
      setDiscScale: (discScale) => set({ discScale }),
      lightPollution: 1,
      setLightPollution: (lightPollution) => set({ lightPollution }),
      lightPollutionAuto: false,
      setLightPollutionAuto: (lightPollutionAuto) => set({ lightPollutionAuto }),
      autoLightPollutionStatus: DEFAULT_STATUS,
      measuredSkyBrightness: null,
      aerosolTurbidity: 1,
      setAerosolTurbidity: (aerosolTurbidity) => set({ aerosolTurbidity }),
      aerosolAuto: false,
      setAerosolAuto: (aerosolAuto) => set({ aerosolAuto }),
      autoAerosolStatus: DEFAULT_STATUS,

      satellites: [],
      addSatellite: (el) => {
        const id = nextSatId()
        const entry = el ? { ...el, id } : defaultElements(id)
        set((s) => ({ satellites: [...s.satellites, entry], selectedSatellite: id }))
        return id
      },
      updateSatellite: (id, patch) =>
        set((s) => ({ satellites: s.satellites.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
      removeSatellite: (id) =>
        set((s) => ({
          satellites: s.satellites.filter((x) => x.id !== id),
          selection: s.selection?.id === id ? null : s.selection,
        })),
      trackWindowMinutes: 90,
      setTrackWindow: (trackWindowMinutes) => set({ trackWindowMinutes }),

      celestrakGroup: 'stations',
      setCelestrakGroup: (celestrakGroup) => set({ celestrakGroup }),
    }),
    {
      name: 'ciel.state',
      // Le temps et la selection sont volatils : on ne persiste que les preferences.
      partialize: (s) => ({
        location: s.location,
        layers: s.layers,
        magnitudeLimit: s.magnitudeLimit,
        discScale: s.discScale,
        lightPollution: s.lightPollution,
        lightPollutionAuto: s.lightPollutionAuto,
        aerosolTurbidity: s.aerosolTurbidity,
        aerosolAuto: s.aerosolAuto,
        satellites: s.satellites,
        trackWindowMinutes: s.trackWindowMinutes,
        celestrakGroup: s.celestrakGroup,
        fov: s.fov,
      }),
      /**
       * La fusion par defaut est superficielle : un `layers` enregistre par une
       * version anterieure ecraserait le jeu par defaut et laisserait les
       * calques ajoutes depuis a `undefined`. On refusionne donc les calques
       * explicitement, de sorte qu'une preference conservee n'empeche jamais
       * l'apparition d'un nouveau calque.
       */
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SkyState>
        return {
          ...current,
          ...saved,
          layers: { ...DEFAULT_LAYERS, ...(saved.layers ?? {}) },
        }
      },
    },
  ),
)

/** Instant simule sous forme de `Date`. */
export const selectDate = (s: SkyState) => new Date(s.time)

/**
 * Selecteurs de compatibilite : les couches qui ne connaissent qu'une famille
 * d'objets continuent de lire un identifiant simple, sans avoir a filtrer.
 */
export const selectedBodyId = (s: SkyState): BodyId | null =>
  s.selection?.kind === 'body' ? (s.selection.id as BodyId) : null
export const selectedSatelliteId = (s: SkyState): string | null =>
  s.selection?.kind === 'satellite' ? s.selection.id : null
