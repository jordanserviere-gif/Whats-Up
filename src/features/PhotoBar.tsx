import { useEffect } from 'react'
import { Button, IconButton, LinearProgress, SegmentedButton, Surface, Tooltip } from '@/ui'
import { useSkyStore } from '@/state/store'
import './PhotoBar.css'

/**
 * Bouton d'entree du mode photo.
 *
 * Entrer fige le temps — une photo est un instant, et les ombres comme le
 * relief fin sont calcules pour lui — et range le panneau lateral : ce que
 * l'utilisateur voit devient le pre-rendu de la photo.
 */
export function PhotoToggle() {
  const phase = useSkyStore((s) => s.photo.phase)
  const enterPhoto = () => {
    const s = useSkyStore.getState()
    s.setPhoto({ phase: 'preview', resumePlaying: s.playing, message: null, progress: null })
    s.setPlaying(false)
    s.setPanelOpen(false)
  }
  return (
    <Tooltip content="Mode photo" placement="bottom">
      <IconButton icon="photo_camera" label="Mode photo" variant="tonal" selected={phase !== 'off'} onClick={enterPhoto} />
    </Tooltip>
  )
}

const SCALES = [
  { value: '1', label: '× 1' },
  { value: '2', label: '× 2' },
  { value: '3', label: '× 3' },
] as const

/**
 * Barre du mode photo.
 *
 * En apercu : la definition et le declenchement. En travail : l'etape et sa
 * progression — le calcul tourne dans un worker, l'apercu reste fluide, et
 * l'on peut annuler a tout moment.
 */
export function PhotoBar() {
  const photo = useSkyStore((s) => s.photo)
  const setPhoto = useSkyStore((s) => s.setPhoto)

  // L'interface s'efface le temps du mode photo : seule la scene reste, avec
  // cette barre. Pendant le calcul, la camera ne bouge plus — le cadrage est
  // fige, et le maillage n'est valable que pour lui.
  useEffect(() => {
    const body = document.body
    if (photo.phase === 'off') {
      delete body.dataset.photo
    } else {
      body.dataset.photo = photo.phase === 'preview' ? 'apercu' : 'calcul'
    }
    return () => {
      delete body.dataset.photo
    }
  }, [photo.phase])

  // Echap quitte le mode photo, ou annule le calcul en cours.
  useEffect(() => {
    if (photo.phase === 'off') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      const s = useSkyStore.getState()
      if (s.photo.phase === 'working' || s.photo.phase === 'capturing') s.setPhoto({ phase: 'preview', progress: null, message: 'Photo annulée' })
      else if (s.photo.phase === 'preview') leave()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [photo.phase])

  if (photo.phase === 'off') return null

  const busy = photo.phase === 'working' || photo.phase === 'capturing'
  const progress = photo.progress

  return (
    <Surface level={3} shape="extra-large" className="photo-bar" role="toolbar" aria-label="Mode photo">
      {busy ? (
        <div className="photo-bar__progress">
          <div className="photo-bar__status">
            <span className="wu-type-title-s">{progress?.step ?? 'Préparation'}</span>
            <span className="wu-type-caption photo-bar__detail wu-numeric">
              {progress?.detail ?? `${Math.round((progress?.fraction ?? 0) * 100)} %`}
            </span>
          </div>
          <LinearProgress progress={progress?.fraction ?? 0} />
        </div>
      ) : (
        <div className="photo-bar__status">
          <span className="wu-type-title-s">Mode photo</span>
          <span className="wu-type-caption photo-bar__detail">
            {photo.message ?? 'Cadrez, puis déclenchez : relief LiDAR, ombres fines, haute définition.'}
          </span>
        </div>
      )}

      <div className="photo-bar__actions">
        {!busy && (
          <SegmentedButton
            ariaLabel="Définition de la photo"
            segments={SCALES.map((s) => ({ value: s.value, label: s.label }))}
            value={String(photo.scale) as '1' | '2' | '3'}
            onChange={(v) => setPhoto({ scale: Number(v) as 1 | 2 | 3 })}
          />
        )}
        {busy ? (
          <Button
            variant="text"
            icon="close"
            disabled={photo.phase === 'capturing'}
            onClick={() => setPhoto({ phase: 'preview', progress: null, message: 'Photo annulée' })}
          >
            Annuler
          </Button>
        ) : (
          <>
            <Button variant="text" icon="close" onClick={leave}>
              Quitter
            </Button>
            <Button
              variant="filled"
              icon="photo_camera"
              onClick={() => setPhoto({ phase: 'working', message: null, progress: { step: 'Préparation', fraction: 0 } })}
            >
              Prendre la photo
            </Button>
          </>
        )}
      </div>
    </Surface>
  )
}

function leave() {
  const s = useSkyStore.getState()
  const resume = s.photo.resumePlaying
  s.setPhoto({ phase: 'off', progress: null, message: null })
  if (resume) s.setPlaying(true)
}
