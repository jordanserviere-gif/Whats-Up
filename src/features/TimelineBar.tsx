import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, IconButton, SegmentedButton, Surface, Tooltip } from '@/ui'
import { TIME_SPEEDS, useSkyStore } from '@/state/store'
import { useSkyConditions } from '@/state/hooks'
import { MS_PER_DAY, MS_PER_HOUR, formatDate, formatTime, localTimeZone, toDateTimeLocalValue } from '@/astro/time'
import { LuminanceBand } from './LuminanceBand'
import './TimelineBar.css'

/** Etendue totale de la fenetre parcourue par le curseur, en heures. */
const WINDOW_HOURS = 24
const WINDOW_MS = WINDOW_HOURS * MS_PER_HOUR
/** Marge, en fraction de la fenetre, avant recentrage automatique. */
const RECENTER_MARGIN = 0.06

const windowStartFor = (t: number) => Math.round(t / MS_PER_HOUR) * MS_PER_HOUR - WINDOW_MS / 2

/**
 * Frise temporelle.
 *
 * La fenetre affichee est independante de l'instant vise : elle ne se recale
 * que lorsque la tete de lecture approche d'un bord, et jamais pendant qu'on la
 * fait glisser. Sans cela, deplacer le curseur deplacerait aussi le fond, et
 * l'on aurait l'impression de tirer le decor plutot que le temps.
 */
export function TimelineBar() {
  const time = useSkyStore((s) => s.time)
  const live = useSkyStore((s) => s.live)
  const playing = useSkyStore((s) => s.playing)
  const speed = useSkyStore((s) => s.speed)
  const location = useSkyStore((s) => s.location)
  const setTime = useSkyStore((s) => s.setTime)
  const nudgeTime = useSkyStore((s) => s.nudgeTime)
  const goLive = useSkyStore((s) => s.goLive)
  const setPlaying = useSkyStore((s) => s.setPlaying)
  const setSpeed = useSkyStore((s) => s.setSpeed)

  const sky = useSkyConditions()
  const [editing, setEditing] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  const scrubbingRef = useRef(false)
  const [windowStart, setWindowStart] = useState(() => windowStartFor(time))
  const windowEnd = windowStart + WINDOW_MS

  // Recentrage : uniquement hors manipulation, et seulement au bord.
  useEffect(() => {
    if (scrubbingRef.current) return
    const margin = WINDOW_MS * RECENTER_MARGIN
    if (time < windowStart + margin || time > windowEnd - margin) setWindowStart(windowStartFor(time))
  }, [time, windowStart, windowEnd])

  const beginScrub = useCallback(() => {
    scrubbingRef.current = true
    setScrubbing(true)
  }, [])
  const endScrub = useCallback(() => {
    scrubbingRef.current = false
    setScrubbing(false)
  }, [])

  const progress = Math.min(1, Math.max(0, (time - windowStart) / WINDOW_MS))
  const date = new Date(time)
  const now = Date.now()
  const nowProgress = now >= windowStart && now <= windowEnd ? (now - windowStart) / WINDOW_MS : null

  // Quelques graduations horaires, pour situer la lecture.
  const ticks: Array<{ left: number; label: string }> = []
  const firstTick = Math.ceil(windowStart / (3 * MS_PER_HOUR)) * 3 * MS_PER_HOUR
  for (let t = firstTick; t < windowEnd; t += 3 * MS_PER_HOUR) {
    ticks.push({ left: ((t - windowStart) / WINDOW_MS) * 100, label: formatTime(new Date(t)) })
  }

  return (
    <Surface level={3} shape="extra-large-increased" glass className="timeline">
      <div className="timeline__row timeline__row--main">
        <Tooltip content={playing ? 'Suspendre' : 'Lancer'} placement="top">
          <IconButton
            icon={playing ? 'pause' : 'play_arrow'}
            label={playing ? 'Suspendre le temps' : 'Lancer le temps'}
            variant="filled"
            size="m"
            selected={playing}
            onClick={() => setPlaying(!playing)}
          />
        </Tooltip>

        <div className="timeline__clock">
          {editing ? (
            <input
              className="timeline__input md-numeric"
              type="datetime-local"
              autoFocus
              value={toDateTimeLocalValue(date)}
              onBlur={() => setEditing(false)}
              onChange={(e) => {
                const parsed = new Date(e.target.value)
                if (!Number.isNaN(parsed.getTime())) {
                  setTime(parsed.getTime())
                  setWindowStart(windowStartFor(parsed.getTime()))
                }
              }}
            />
          ) : (
            <Tooltip content="Régler la date et l’heure" placement="bottom">
              <button
                type="button"
                className="timeline__clock-button"
                aria-label="Régler la date et l’heure"
                onClick={() => setEditing(true)}
              >
                <span className="timeline__time md-numeric">{formatTime(date, true)}</span>
                <span className="md-type-label-medium timeline__date">{formatDate(date)}</span>
              </button>
            </Tooltip>
          )}
          <div className="timeline__badges">
            {live ? (
              <Badge tone="primary" icon="sensors">
                en direct
              </Badge>
            ) : (
              <Badge tone="neutral" icon="history">
                simulé
              </Badge>
            )}
            <Badge tone="secondary">{sky.twilight}</Badge>
            {sky.obscuration > 0.001 && (
              <Badge tone="error" icon="brightness_3">
                éclipse {Math.round(sky.obscuration * 100)} %
              </Badge>
            )}
          </div>
        </div>

        <div className="timeline__jumps">
          <Tooltip content="Reculer d’un jour" placement="top">
            <IconButton icon="keyboard_double_arrow_left" label="Reculer d’un jour" onClick={() => nudgeTime(-MS_PER_DAY)} />
          </Tooltip>
          <Tooltip content="Reculer d’une heure" placement="top">
            <IconButton icon="chevron_left" label="Reculer d’une heure" onClick={() => nudgeTime(-MS_PER_HOUR)} />
          </Tooltip>
          <Tooltip content="Revenir à maintenant" placement="top">
            <IconButton
              icon="restore"
              label="Revenir à l’instant présent"
              variant="tonal"
              selected={live}
              onClick={() => {
                goLive()
                setWindowStart(windowStartFor(Date.now()))
              }}
            />
          </Tooltip>
          <Tooltip content="Avancer d’une heure" placement="top">
            <IconButton icon="chevron_right" label="Avancer d’une heure" onClick={() => nudgeTime(MS_PER_HOUR)} />
          </Tooltip>
          <Tooltip content="Avancer d’un jour" placement="top">
            <IconButton icon="keyboard_double_arrow_right" label="Avancer d’un jour" onClick={() => nudgeTime(MS_PER_DAY)} />
          </Tooltip>
        </div>

        <SegmentedButton
          className="timeline__speed"
          ariaLabel="Vitesse d’écoulement du temps"
          segments={TIME_SPEEDS.map((s) => ({ value: String(s.value), label: s.label, title: s.title }))}
          value={String(speed)}
          onChange={(v) => setSpeed(Number(v))}
        />
      </div>

      <div
        className={`timeline__scrubber${scrubbing ? ' is-scrubbing' : ''}${
          playing && speed !== 1 ? ' is-running' : ''
        }`}
      >
        <LuminanceBand start={windowStart} end={windowEnd} location={location} samples={96} />

        {ticks.map((t) => (
          <span key={t.left} className="timeline__tick" style={{ left: `${t.left}%` }} aria-hidden="true">
            <span className="md-type-label-small timeline__tick-label">{t.label}</span>
          </span>
        ))}

        {nowProgress !== null && (
          <span className="timeline__now" style={{ left: `${nowProgress * 100}%` }} aria-hidden="true" />
        )}
        <span className="timeline__cursor" style={{ left: `${progress * 100}%` }} aria-hidden="true" />

        <input
          className="timeline__range"
          type="range"
          min={windowStart}
          max={windowEnd}
          step={30_000}
          value={time}
          aria-label="Position dans la journée"
          aria-valuetext={`${formatDate(date)} ${formatTime(date)}`}
          onPointerDown={beginScrub}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onKeyDown={beginScrub}
          onKeyUp={endScrub}
          onChange={(e) => setTime(Number(e.target.value))}
        />
      </div>

      <div className="timeline__footer">
        <span className="md-type-label-small timeline__lux md-numeric">
          {formatIlluminance(sky.illuminance)} · mag limite {sky.limitingMagnitude.toFixed(1).replace('.', ',')}
          {sky.lunarLux > sky.solarLux && sky.moonAltitude > 0 ? ' · ciel dominé par la Lune' : ''}
        </span>
        <span className="md-type-label-small timeline__zone">{localTimeZone()}</span>
      </div>
    </Surface>
  )
}

/** Eclairement en notation lisible : lux, ou millilux sous le seuil. */
function formatIlluminance(lux: number): string {
  if (lux >= 1000) return `${Math.round(lux / 1000).toLocaleString('fr-FR')} klx`
  if (lux >= 1) return `${lux.toFixed(1).replace('.', ',')} lx`
  if (lux >= 0.001) return `${(lux * 1000).toFixed(1).replace('.', ',')} mlx`
  return `${(lux * 1e6).toFixed(0)} µlx`
}
