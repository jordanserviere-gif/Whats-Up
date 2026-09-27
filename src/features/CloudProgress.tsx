import { useSkyStore } from '@/state/store'
import { LinearProgress } from '@/ui'
import './CloudProgress.css'

/**
 * Avancement discret du calcul des nuages, en bas a gauche de la scene.
 *
 * Il ne s'affiche que pendant qu'une carte neuve se construit — apres un
 * changement d'heure — et jamais sous le loader, qui a son propre suivi. Le
 * ciel reste utilisable : l'ancienne carte est a l'ecran jusqu'au fondu.
 */
export function CloudProgress() {
  const progress = useSkyStore((s) => s.cloudProgress)
  const loading = useSkyStore((s) => s.sceneLoading)
  const visible = progress != null && !loading
  return (
    <div className={`cloud-progress${visible ? ' is-visible' : ''}`} aria-hidden={!visible}>
      <span className="cloud-progress__label md-type-label-small">Nuages</span>
      <LinearProgress progress={progress ?? 0} className="cloud-progress__bar" />
    </div>
  )
}
