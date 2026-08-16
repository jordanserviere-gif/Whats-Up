import { useEffect, useMemo, useRef, useState } from 'react'
import { useSkyStore } from './store'
import {
  BODIES,
  BODY_BY_ID,
  computeAllBodies,
  computeMoonInfo,
  computeRiseSet,
  computeSkyConditions,
} from '@/astro/bodies'
import { computeSatelliteState, findPasses, sampleSkyTrack } from '@/astro/satellite'
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

/** Etats instantanes de tous les satellites definis. */
export function useSatelliteStates() {
  const date = useSimulatedDate()
  const location = useSkyStore((s) => s.location)
  const satellites = useSkyStore((s) => s.satellites)

  return useMemo(() => {
    const map = new Map<string, ReturnType<typeof computeSatelliteState>>()
    for (const el of satellites) {
      try {
        map.set(el.id, computeSatelliteState(el, date, location))
      } catch {
        /* elements invalides : le satellite est simplement ignore */
      }
    }
    return map
  }, [satellites, date, location])
}

/**
 * Traces dans le ciel. Recalculees seulement toutes les 30 s de temps simule :
 * la forme de la trace evolue lentement par rapport a la position du satellite.
 */
export function useSatelliteTracks() {
  const time = useSkyStore((s) => s.time)
  const location = useSkyStore((s) => s.location)
  const satellites = useSkyStore((s) => s.satellites)
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
