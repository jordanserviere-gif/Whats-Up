import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { BodyId, GeoLocation, OrbitalElements } from '@/astro/types'
import { defaultElements } from '@/astro/kepler'

export type ViewTab = 'ciel' | 'objets' | 'satellites' | 'reglages'

/** Multiplicateurs de vitesse d'ecoulement du temps. */
export const TIME_SPEEDS = [
  { value: 1, label: 'temps réel' },
  { value: 60, label: '×60' },
  { value: 600, label: '×600' },
  { value: 3600, label: '×1 h/s' },
  { value: 86400, label: '×1 j/s' },
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
  horizonGrid: boolean
  equatorialGrid: boolean
  ecliptic: boolean
  ground: boolean
  cardinals: boolean
  atmosphere: boolean
  satellites: boolean
  satelliteTracks: boolean
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
  lookAt: (azimuth: number, altitude: number) => void

  // --- Selection ---
  selectedBody: BodyId | null
  selectBody: (id: BodyId | null) => void
  selectedSatellite: string | null
  selectSatellite: (id: string | null) => void

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

  // --- Satellites ---
  satellites: OrbitalElements[]
  addSatellite: (el?: OrbitalElements) => string
  updateSatellite: (id: string, patch: Partial<OrbitalElements>) => void
  removeSatellite: (id: string) => void
  /** Fenetre de trace affichee autour de l'instant courant, en minutes. */
  trackWindowMinutes: number
  setTrackWindow: (m: number) => void
}

const DEFAULT_LAYERS: LayerVisibility = {
  stars: true,
  constellations: true,
  constellationLabels: false,
  bodies: true,
  bodyLabels: true,
  horizonGrid: false,
  equatorialGrid: false,
  ecliptic: false,
  ground: true,
  cardinals: true,
  atmosphere: true,
  satellites: true,
  satelliteTracks: true,
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
      lookAt: (azimuth, altitude) => set({ lookAtTarget: { azimuth, altitude, key: Date.now() } }),

      selectedBody: null,
      selectBody: (selectedBody) => set({ selectedBody, selectedSatellite: null }),
      selectedSatellite: null,
      selectSatellite: (selectedSatellite) => set({ selectedSatellite, selectedBody: null }),

      layers: DEFAULT_LAYERS,
      toggleLayer: (key) => set((s) => ({ layers: { ...s.layers, [key]: !s.layers[key] } })),
      setLayer: (key, value) => set((s) => ({ layers: { ...s.layers, [key]: value } })),
      magnitudeLimit: 6,
      setMagnitudeLimit: (magnitudeLimit) => set({ magnitudeLimit }),
      discScale: 1,
      setDiscScale: (discScale) => set({ discScale }),

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
          selectedSatellite: s.selectedSatellite === id ? null : s.selectedSatellite,
        })),
      trackWindowMinutes: 90,
      setTrackWindow: (trackWindowMinutes) => set({ trackWindowMinutes }),
    }),
    {
      name: 'ciel.state',
      // Le temps et la selection sont volatils : on ne persiste que les preferences.
      partialize: (s) => ({
        location: s.location,
        layers: s.layers,
        magnitudeLimit: s.magnitudeLimit,
        discScale: s.discScale,
        satellites: s.satellites,
        trackWindowMinutes: s.trackWindowMinutes,
        fov: s.fov,
      }),
    },
  ),
)

/** Instant simule sous forme de `Date`. */
export const selectDate = (s: SkyState) => new Date(s.time)
