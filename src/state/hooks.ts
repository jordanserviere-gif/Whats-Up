import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useSkyStore } from './store'
import { elementsFromGp } from '@/astro/sgp4'
import { fetchGroup, type CelestrakGroup } from '@/data-sources/celestrak'
import { DEFAULT_STATUS, type SourceStatus } from '@/data-sources/types'
import { readToken } from '@/scene/sceneMath'
import {
  BODIES,
  BODY_BY_ID,
  computeAllBodies,
  computeMoonInfo,
  computeRiseSet,
  computeSkyConditions,
} from '@/astro/bodies'
import { computeSatelliteStates, findPasses, sampleSkyTrack } from '@/astro/satellite'
import type { BodyId, BodyState, GeoLocation, OrbitalElements, SatellitePass } from '@/astro/types'

/** Cadence de recalcul des ephemerides : 10 Hz suffit largement a l'oeil. */
const EPHEMERIS_HZ = 10

/**
 * Moteur temporel : avance l'instant simule selon la vitesse choisie.
 * Il pilote le store a cadence limitee ; le rendu 3D, lui, tourne a la
 * frequence de l'ecran et reste fluide.
 */
export function useTimeEngine() {
  const playing = useSkyStore((s) => s.playing)
  const speed = useSkyStore((s) => s.speed)
  const live = useSkyStore((s) => s.live)

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let lastWall = performance.now()
    let lastCommit = 0

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = now - lastWall
      lastWall = now
      if (now - lastCommit < 1000 / EPHEMERIS_HZ) return
      lastCommit = now

      const store = useSkyStore.getState()
      if (live && speed === 1) {
        useSkyStore.setState({ time: Date.now() })
      } else {
        useSkyStore.setState({ time: store.time + dt * speed })
      }
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, live])
}

/** Instant simule sous forme de `Date` stable entre deux recalculs. */
export function useSimulatedDate(): Date {
  const time = useSkyStore((s) => s.time)
  return useMemo(() => new Date(time), [time])
}

/** Ephemerides de tous les corps affiches. */
export function useBodyStates(): BodyState[] {
  const date = useSimulatedDate()
  const location = useSkyStore((s) => s.location)
  return useMemo(() => computeAllBodies(date, location), [date, location])
}

/** Conditions d'observation courantes. */
export function useSkyConditions() {
  const date = useSimulatedDate()
  const location = useSkyStore((s) => s.location)
  return useMemo(() => computeSkyConditions(date, location), [date, location])
}

/** Donnees lunaires : recalculees a la minute, la phase evolue lentement. */
export function useMoonInfo() {
  const time = useSkyStore((s) => s.time)
  const minute = Math.floor(time / 60000)
  return useMemo(() => computeMoonInfo(new Date(minute * 60000)), [minute])
}

/** Lever / culmination / coucher d'un corps, recalcules a l'heure. */
export function useRiseSet(id: BodyId | null) {
  const time = useSkyStore((s) => s.time)
  const location = useSkyStore((s) => s.location)
  const hour = Math.floor(time / 3_600_000)

  return useMemo(() => {
    if (!id) return null
    const def = BODY_BY_ID.get(id)
    if (!def) return null
    try {
      return computeRiseSet(def, new Date(hour * 3_600_000), location)
    } catch {
      return null
    }
  }, [id, hour, location])
}

/** Ephemerides de lever/coucher pour tous les corps (panneau « objets »). */
export function useAllRiseSets() {
  const time = useSkyStore((s) => s.time)
  const location = useSkyStore((s) => s.location)
  const hour = Math.floor(time / 3_600_000)

  return useMemo(() => {
    const map = new Map<BodyId, ReturnType<typeof computeRiseSet> | null>()
    for (const def of BODIES) {
      try {
        map.set(def.id, computeRiseSet(def, new Date(hour * 3_600_000), location))
      } catch {
        map.set(def.id, null)
      }
    }
    return map
  }, [hour, location])
}

/**
 * Nombre maximal d'objets propages simultanement.
 *
 * SGP4 coute une dizaine de microsecondes par objet et par instant. Les
 * grandeurs communes — direction du Soleil, position de l'observateur — sont
 * desormais calculees une fois pour tout le lot, ce qui laisse deux mille objets
 * a 10 Hz sous une vingtaine de millisecondes par seconde de calcul.
 *
 * Les groupes de constellations depassent encore ce plafond. On tronque alors,
 * et l'interface le dit plutot que de ramer en silence.
 */
export const MAX_TRACKED_SATELLITES = 2000

/**
 * Satellites reels du groupe CelesTrak choisi.
 *
 * La recuperation est differee et tolerante : `fetchGroup` ne leve jamais, et
 * retombe sur le cache si le reseau manque. Rien n'est place dans le store —
 * plusieurs centaines de jeux d'elements n'ont pas a etre serialises dans le
 * stockage local a chaque changement d'instant.
 */
export interface CelestrakFeed {
  elements: OrbitalElements[]
  loading: boolean
  /** Statut de la source : mesuree, en cache, ou repli. Nul tant que rien n'a abouti. */
  status: SourceStatus | null
  /** Nombre d'objets ecartes par le plafond de propagation. */
  truncated: number
  /** Objets dont les elements ont plus de trois jours : leur position derive. */
  staleCount: number
}

/**
 * Etat partage du flux CelesTrak.
 *
 * Le hook est appele par la barre haute, le panneau et la scene. Avec un etat
 * local par appelant, chacun lancait sa propre recuperation et conservait sa
 * propre copie des elements : quatre requetes pour un meme groupe, et surtout
 * quatre tableaux d'identites differentes, ce qui ruinait toute memorisation en
 * aval. L'etat vit donc ici, hors de React, et les composants s'y abonnent.
 */
interface FeedState extends CelestrakFeed {
  group: CelestrakGroup | null
}

const IDLE_FEED: FeedState = {
  group: null,
  elements: [],
  loading: false,
  status: null,
  truncated: 0,
  staleCount: 0,
}

let feedState: FeedState = IDLE_FEED
let feedRequest: CelestrakGroup | null = null
const feedListeners = new Set<() => void>()

function publishFeed(next: FeedState) {
  feedState = next
  for (const listener of feedListeners) listener()
}

function ensureFeed(group: CelestrakGroup) {
  // Une recuperation par groupe, quel que soit le nombre d'abonnes.
  if (feedRequest === group) return
  feedRequest = group
  publishFeed({ ...IDLE_FEED, group, loading: true })

  // Les objets du catalogue partagent une teinte, distincte des orbites
  // saisies : on la resout au moment du chargement, donc apres le theme.
  const color = readToken('--app-body-satellite', '#7fd6ff')

  fetchGroup(group).then((sourced) => {
    // Un groupe a pu changer pendant la requete : le resultat est alors perime.
    if (feedRequest !== group) return
    if (!sourced) {
      publishFeed({ ...IDLE_FEED, group, status: DEFAULT_STATUS })
      return
    }
    const records = sourced.value
    const kept = records.slice(0, MAX_TRACKED_SATELLITES)
    publishFeed({
      group,
      loading: false,
      elements: kept.map((r) =>
        elementsFromGp(r.gp, { id: `celestrak-${r.noradId}`, color, epochAgeDays: r.epochAgeDays }),
      ),
      status: sourced.status,
      truncated: records.length - kept.length,
      staleCount: kept.filter((r) => r.stale).length,
    })
  })
}

const subscribeFeed = (listener: () => void) => {
  feedListeners.add(listener)
  return () => {
    feedListeners.delete(listener)
  }
}

export function useCelestrakSatellites(): CelestrakFeed {
  const enabled = useSkyStore((s) => s.layers.celestrak)
  const group = useSkyStore((s) => s.celestrakGroup)
  const shared = useSyncExternalStore(subscribeFeed, () => feedState)

  useEffect(() => {
    if (enabled) ensureFeed(group)
    else {
      feedRequest = null
      publishFeed(IDLE_FEED)
    }
  }, [enabled, group])

  // Un groupe encore en cours de chargement ne doit pas afficher le precedent :
  // ce serait montrer des satellites qu'on a cesse de suivre.
  const current = enabled && shared.group === group ? shared : null

  return {
    elements: current?.elements ?? EMPTY_ELEMENTS,
    loading: Boolean(current?.loading),
    status: current?.status ?? null,
    truncated: current?.truncated ?? 0,
    staleCount: current?.staleCount ?? 0,
  }
}

const EMPTY_ELEMENTS: OrbitalElements[] = []

/**
 * Tous les satellites affichables : ceux saisis a la main et ceux du catalogue.
 * Les deux familles suivent ensuite exactement le meme chemin.
 */
export function useAllSatellites(): OrbitalElements[] {
  const manual = useSkyStore((s) => s.satellites)
  const showManual = useSkyStore((s) => s.layers.satellites)
  const { elements: fetched } = useCelestrakSatellites()

  return useMemo(() => {
    const out: OrbitalElements[] = []
    if (showManual) out.push(...manual)
    out.push(...fetched)
    return out
  }, [manual, showManual, fetched])
}

/**
 * Memoire d'une seule entree pour la propagation d'un lot.
 *
 * Cinq composants demandent les memes etats au meme instant — la scene, la
 * recherche, la barre haute, le panneau et sa fiche. Chacun avait son propre
 * `useMemo` : le catalogue etait donc propage cinq fois par rafraichissement.
 * Comme tous partagent desormais le meme tableau d'elements, une memoire d'une
 * entree suffit a ramener le travail a une seule passe.
 */
let statesKey: { list: readonly OrbitalElements[]; time: number; location: GeoLocation } | null = null
let statesValue: ReturnType<typeof computeSatelliteStates> = new Map()

function satelliteStatesFor(list: readonly OrbitalElements[], date: Date, location: GeoLocation) {
  const time = date.getTime()
  if (statesKey && statesKey.list === list && statesKey.time === time && statesKey.location === location) {
    return statesValue
  }
  statesValue = computeSatelliteStates(list, date, location)
  statesKey = { list, time, location }
  return statesValue
}

/** Etats instantanes de tous les satellites definis. */
export function useSatelliteStates(satellites?: readonly OrbitalElements[]) {
  const date = useSimulatedDate()
  const location = useSkyStore((s) => s.location)
  const stored = useSkyStore((s) => s.satellites)
  const list = satellites ?? stored

  return useMemo(() => satelliteStatesFor(list, date, location), [list, date, location])
}

/**
 * Traces dans le ciel. Recalculees seulement toutes les 30 s de temps simule :
 * la forme de la trace evolue lentement par rapport a la position du satellite.
 */
export function useSatelliteTracks(satellites: readonly OrbitalElements[]) {
  const time = useSkyStore((s) => s.time)
  const location = useSkyStore((s) => s.location)
  const windowMinutes = useSkyStore((s) => s.trackWindowMinutes)
  const bucket = Math.floor(time / 30_000)

  return useMemo(() => {
    const map = new Map<string, ReturnType<typeof sampleSkyTrack>>()
    for (const el of satellites) {
      try {
        map.set(el.id, sampleSkyTrack(el, location, new Date(bucket * 30_000), windowMinutes, 400))
      } catch {
        /* ignore */
      }
    }
    return map
  }, [satellites, location, bucket, windowMinutes])
}

/**
 * Recherche asynchrone des passages : le calcul balaye plusieurs milliers
 * d'instants, on le differe pour ne pas bloquer la saisie dans le formulaire.
 */
export function useSatellitePasses(
  element: OrbitalElements | null,
  location: GeoLocation,
  hours: number,
  visibleOnly: boolean,
): { passes: SatellitePass[]; loading: boolean } {
  const [passes, setPasses] = useState<SatellitePass[]>([])
  const [loading, setLoading] = useState(false)
  const token = useRef(0)

  const key = element
    ? `${element.id}|${element.semiMajorAxisKm}|${element.eccentricity}|${element.inclination}|${element.raan}|${element.argPerigee}|${element.meanAnomaly}|${element.epoch}|${element.useJ2}`
    : ''

  useEffect(() => {
    if (!element) {
      setPasses([])
      return
    }
    const myToken = ++token.current
    setLoading(true)
    const handle = window.setTimeout(() => {
      try {
        const result = findPasses(element, location, new Date(), {
          hours,
          minPeakAltitude: 10,
          visibleOnly,
        })
        if (token.current === myToken) setPasses(result)
      } catch {
        if (token.current === myToken) setPasses([])
      } finally {
        if (token.current === myToken) setLoading(false)
      }
    }, 120)
    return () => window.clearTimeout(handle)
    // `key` resume les elements orbitaux : inutile de reagir a la couleur ou au nom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, location, hours, visibleOnly])

  return { passes, loading }
}
