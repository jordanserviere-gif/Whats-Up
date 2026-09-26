import { useEffect, useRef, useState } from 'react'
import { LoadingIndicator } from '@/ui'
import { useSkyStore } from '@/state/store'
import { aerialSkyReady } from '@/scene/useAerialLut'
import { cx } from '@/ui/utils'
import './AppLoader.css'

/**
 * Duree minimale d'affichage, ms. Sous ce seuil, le loader ne serait qu'un
 * eclair : un changement de lieu qui ne demande aucun calcul le traverse sans
 * clignoter.
 */
const MIN_VISIBLE_MS = 600
/**
 * Au-dela, on rend la main quoi qu'il arrive : un relief qui ne se charge pas
 * (hors ligne, source en panne) ne doit pas bloquer la vue du ciel.
 */
const MAX_VISIBLE_MS = 25_000
const POLL_MS = 150

interface Step {
  label: string
  done: boolean
}

/**
 * Loader de l'application.
 *
 * Il couvre la scene au lancement et a chaque changement de lieu, tant que le
 * ciel **du nouveau lieu** n'est pas construit — et son relief, si le calque est
 * actif. Changer d'altitude seule ne le rappelle pas : c'est le relief lui-meme
 * qui publie l'altitude du sol une fois charge, et le loader ne doit pas se
 * relancer sur sa propre fin.
 */
export function AppLoader() {
  const location = useSkyStore((s) => s.location)
  const terrainOn = useSkyStore((s) => s.layers.terrain)
  const site = `${location.latitude},${location.longitude}`

  const [active, setActive] = useState(true)
  const [steps, setSteps] = useState<Step[]>([])
  const startedAt = useRef(performance.now())
  const firstSite = useRef(site)

  useEffect(() => {
    if (site === firstSite.current) return
    firstSite.current = site
    startedAt.current = performance.now()
    setActive(true)
  }, [site])

  useEffect(() => {
    if (!active) return
    const tick = () => {
      const state = useSkyStore.getState()
      const levels = state.terrainProgress?.levelsReady ?? 0
      const next: Step[] = [{ label: 'Atmosphère du lieu', done: aerialSkyReady() }]
      if (terrainOn) next.push({ label: 'Relief', done: levels >= 1 })
      setSteps(next)
      const elapsed = performance.now() - startedAt.current
      if ((elapsed >= MIN_VISIBLE_MS && next.every((s) => s.done)) || elapsed >= MAX_VISIBLE_MS) setActive(false)
    }
    tick()
    const id = window.setInterval(tick, POLL_MS)
    return () => window.clearInterval(id)
  }, [active, terrainOn])

  return (
    <div className={cx('app-loader', active && 'is-active')} aria-hidden={!active} role="status" aria-live="polite">
      <div className="app-loader__card">
        <LoadingIndicator size={64} label="Préparation du ciel" />
        <div className="app-loader__text">
          <span className="md-type-title-medium">{location.name}</span>
          <span className="md-type-body-small app-loader__sub md-numeric">
            {location.latitude.toFixed(3).replace('.', ',')}° · {location.longitude.toFixed(3).replace('.', ',')}°
          </span>
        </div>
        <ul className="app-loader__steps">
          {steps.map((s) => (
            <li key={s.label} className={cx('md-type-label-medium', s.done && 'is-done')}>
              <span className="md-icon" aria-hidden="true">
                {s.done ? 'check_circle' : 'radio_button_unchecked'}
              </span>
              {s.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
