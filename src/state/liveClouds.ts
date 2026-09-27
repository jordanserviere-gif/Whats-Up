import { useEffect, useState } from 'react'
import { useSkyStore } from './store'
import { LIVE_MAX_AGE_MS, fetchLive, liveKey, readLive, type LiveRecord } from '@/data-sources/liveWeather'

/**
 * Prevision en direct pour les nuages : l'identifiant du scenario a rendre,
 * ou `null`.
 *
 * Actif seulement si les nuages sont allumes et qu'aucune journee archivee
 * n'est choisie. On lit d'abord le cache du navigateur ; on ne telecharge que
 * s'il manque, s'il a plus de trois heures, s'il est incomplet, ou si
 * l'instant affiche sort des 72 heures qu'il couvre. L'ancienne prevision
 * reste a l'ecran pendant le telechargement.
 */
const inflight = new Set<string>()

const covers = (r: LiveRecord, timeMs: number) => {
  const t = r.scenario.times
  return timeMs >= Date.parse(`${t[0]}Z`) && timeMs <= Date.parse(`${t[t.length - 1]}Z`)
}

export function useLiveCloudsId(): string | null {
  const enabled = useSkyStore((s) => s.layers.clouds && s.layers.atmosphere && s.weatherScenario == null)
  const lat = useSkyStore((s) => Math.round(s.location.latitude * 20) / 20)
  const lon = useSkyStore((s) => Math.round(s.location.longitude * 20) / 20)
  // L'instant a l'heure pres : assez pour savoir si la prevision le couvre.
  const hour = useSkyStore((s) => Math.floor(s.time / 3_600_000))
  const [id, setId] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) {
      setId(null)
      return
    }
    let alive = true
    const key = liveKey(lat, lon)
    const check = async () => {
      const record = await readLive(key)
      if (!alive) return
      const timeMs = hour * 3_600_000
      if (record && covers(record, timeMs)) setId(record.scenario.id)
      const stale = !record || !record.complete || Date.now() - record.fetchedAt > LIVE_MAX_AGE_MS || !covers(record, timeMs)
      if (stale && !inflight.has(key)) {
        inflight.add(key)
        fetchLive(lat, lon, (r) => {
          if (alive) setId(r.scenario.id)
        })
          .catch(() => {})
          .finally(() => inflight.delete(key))
      }
    }
    void check()
    // Une prevision vieillit meme appli ouverte : on revoit l'age toutes les dix minutes.
    const timer = setInterval(() => void check(), 10 * 60_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [enabled, lat, lon, hour])

  return enabled ? id : null
}
