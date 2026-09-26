import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useSkyStore } from '@/state/store'
import { aerialSkyReady } from '@/scene/useAerialLut'
import { cx } from '@/ui/utils'
import { LOGO_STARS } from '@/brand/logoStars'
import { shuffledPhrases } from './loaderPhrases'
import { setAerialBuildBudget } from '@/scene/useAerialLut'
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
/** Duree d'affichage d'une phrase, ms : le temps de la lire, pas davantage. */
const PHRASE_MS = 2200
/**
 * Budget de construction du ciel par image pendant le chargement, ms — contre
 * 28 hors chargement. Des images plus breves laissent le navigateur respirer ;
 * le ciel met un peu plus longtemps a se poser, et personne ne le regarde.
 */
const LOADING_BUILD_BUDGET_MS = 10

/**
 * Periodes des animations, s. La lueur ondule en trois secondes ; l'echelle
 * tremble a 1,5 Hz, chaque axe pour son compte.
 */
const GLOW_PERIOD_S = 3
const WIGGLE_PERIOD_S = 1 / 1.5

/**
 * Phases, en fraction de periode, par etoile et par animation. Choisies a la
 * main plutot que tirees au hasard : un tirage peut aligner deux etoiles, ou
 * les deux axes d'une meme etoile, et l'on verrait alors un battement commun.
 */
const PHASES = [
  { glow: 0, x: 0.1, y: 0.47 },
  { glow: 0.42, x: 0.63, y: 0.05 },
  { glow: 0.17, x: 0.35, y: 0.79 },
  { glow: 0.71, x: 0.88, y: 0.31 },
  { glow: 0.55, x: 0.22, y: 0.66 },
] as const

/** Boite englobante des etoiles, unites du logo. */
const MIN_X = Math.min(...LOGO_STARS.map((s) => s.cx - s.half))
const MAX_X = Math.max(...LOGO_STARS.map((s) => s.cx + s.half))
const MIN_Y = Math.min(...LOGO_STARS.map((s) => s.cy - s.half))
const MAX_Y = Math.max(...LOGO_STARS.map((s) => s.cy + s.half))
const SPAN_X = MAX_X - MIN_X
const SPAN_Y = MAX_Y - MIN_Y

interface Step {
  label: string
  done: boolean
}

/**
 * Loader de l'application.
 *
 * Pleine page, au lancement et a chaque changement de lieu, tant que le ciel
 * **du nouveau lieu** n'est pas construit — et son relief, si le calque est
 * actif. Changer d'altitude seule ne le rappelle pas : c'est le relief lui-meme
 * qui publie l'altitude du sol une fois charge, et le loader ne doit pas se
 * relancer sur sa propre fin.
 *
 * Il montre les cinq etoiles du logo, chacune vivant pour son compte : une
 * lueur qui ondule en trois secondes, une echelle qui tremble a 1,5 Hz, les
 * deux axes independants, et des phases differentes d'une etoile a l'autre.
 */
export function AppLoader() {
  const location = useSkyStore((s) => s.location)
  const terrainOn = useSkyStore((s) => s.layers.terrain)
  const site = `${location.latitude},${location.longitude}`

  const [active, setActive] = useState(true)
  const [steps, setSteps] = useState<Step[]>([])
  const startedAt = useRef(performance.now())
  const firstSite = useRef(site)
  const [phrases, setPhrases] = useState(shuffledPhrases)
  const [phraseIndex, setPhraseIndex] = useState(0)

  useEffect(() => {
    if (site === firstSite.current) return
    firstSite.current = site
    startedAt.current = performance.now()
    setPhrases(shuffledPhrases())
    setPhraseIndex(0)
    setActive(true)
  }, [site])

  // La scene se rend au rabais tant qu'on la couvre — voir `sceneLoading`.
  const setSceneLoading = useSkyStore((s) => s.setSceneLoading)
  useEffect(() => {
    setSceneLoading(active)
    setAerialBuildBudget(active ? LOADING_BUILD_BUDGET_MS : undefined)
  }, [active, setSceneLoading])

  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setPhraseIndex((i) => i + 1), PHRASE_MS)
    return () => window.clearInterval(id)
  }, [active])

  useEffect(() => {
    if (!active) return
    const tick = () => {
      const state = useSkyStore.getState()
      const levels = state.terrainProgress?.levelsReady ?? 0
      const next: Step[] = [{ label: 'Atmosphère du lieu', done: aerialSkyReady() }]
      if (terrainOn) next.push({ label: 'Relief', done: levels >= 1 })
      // Pas de rendu si rien n'a change : le loader ne doit rien couter au fil
      // principal qu'il cherche justement a menager.
      setSteps((prev) =>
        prev.length === next.length && prev.every((s, k) => s.done === next[k].done && s.label === next[k].label)
          ? prev
          : next,
      )
      const elapsed = performance.now() - startedAt.current
      if ((elapsed >= MIN_VISIBLE_MS && next.every((s) => s.done)) || elapsed >= MAX_VISIBLE_MS) setActive(false)
    }
    tick()
    const id = window.setInterval(tick, POLL_MS)
    return () => window.clearInterval(id)
  }, [active, terrainOn])

  return (
    <div className={cx('app-loader', active && 'is-active')} aria-hidden={!active} role="status" aria-live="polite">
      <div
        className="app-loader__stars"
        style={{ aspectRatio: `${SPAN_X} / ${SPAN_Y}` }}
        role="img"
        aria-label="Préparation du ciel"
      >
        {LOGO_STARS.map((star, i) => {
          const phase = PHASES[i % PHASES.length]
          // Chaque etoile est son propre SVG : filtre et transformation CSS s'y
          // appliquent partout, ce qui n'est pas acquis sur un element interne.
          const style = {
            left: `${((star.cx - star.half - MIN_X) / SPAN_X) * 100}%`,
            top: `${((star.cy - star.half - MIN_Y) / SPAN_Y) * 100}%`,
            width: `${((2 * star.half) / SPAN_X) * 100}%`,
            '--glow-delay': `${-phase.glow * GLOW_PERIOD_S}s`,
            '--sx-delay': `${-phase.x * WIGGLE_PERIOD_S}s`,
            '--sy-delay': `${-phase.y * WIGGLE_PERIOD_S}s`,
            '--glow-half-period': `${GLOW_PERIOD_S / 2}s`,
            '--wiggle-half-period': `${WIGGLE_PERIOD_S / 2}s`,
          } as CSSProperties
          const viewBox = `${star.cx - star.half} ${star.cy - star.half} ${2 * star.half} ${2 * star.half}`
          // ⚠️ Rien ici n'anime autre chose que `transform` et `opacity` : ce
          // sont les seules proprietes que le navigateur anime **hors du fil
          // principal**. Or ce fil est pris, pendant le chargement, par la
          // construction du ciel — une lueur en `filter` ou une echelle en
          // propriete personnalisee s'y figeaient a chaque image longue.
          //
          // Les deux axes vivent sur deux boites imbriquees, chacune son
          // `scaleX` ou son `scaleY` ; la lueur est une copie deja floutee,
          // dont seule l'opacite respire.
          return (
            <div key={i} className="app-loader__star" style={style}>
              <div className="app-loader__sx">
                <div className="app-loader__sy">
                  <svg className="app-loader__glow" viewBox={viewBox} aria-hidden="true">
                    <path d={star.d} fill="currentColor" />
                  </svg>
                  <svg className="app-loader__shape" viewBox={viewBox} aria-hidden="true">
                    <path d={star.d} fill="currentColor" />
                  </svg>
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {/* La cle relance le fondu a chaque phrase. */}
      <p key={phraseIndex} className="md-type-body-large app-loader__phrase">
        {phrases[phraseIndex % phrases.length]}
      </p>
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
  )
}
