import { useEffect, useRef, useState } from 'react'
import './Ripple.css'

interface Wave {
  id: number
  x: number
  y: number
  size: number
}

/**
 * Couche d'onde Material.
 *
 * L'ecoute se fait sur l'element parent : la couche elle-meme est transparente
 * aux pointeurs, sans quoi elle capterait — ou laisserait passer, selon l'ordre
 * de peinture — les clics destines au contenu du bouton.
 * Le parent doit etre en `position: relative`.
 */
export function Ripple({ disabled = false }: { disabled?: boolean }) {
  const [waves, setWaves] = useState<Wave[]>([])
  const host = useRef<HTMLSpanElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    const el = host.current
    const parent = el?.parentElement
    if (!el || !parent || disabled) return

    const timers = new Set<number>()

    const onPointerDown = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      // Diametre couvrant le coin le plus eloigne du point de contact.
      const size =
        2 *
        Math.max(
          Math.hypot(x, y),
          Math.hypot(r.width - x, y),
          Math.hypot(x, r.height - y),
          Math.hypot(r.width - x, r.height - y),
        )
      const id = ++seq.current
      setWaves((w) => [...w, { id, x, y, size }])
      const timer = window.setTimeout(() => {
        setWaves((w) => w.filter((v) => v.id !== id))
        timers.delete(timer)
      }, 600)
      timers.add(timer)
    }

    parent.addEventListener('pointerdown', onPointerDown)
    return () => {
      parent.removeEventListener('pointerdown', onPointerDown)
      for (const t of timers) window.clearTimeout(t)
    }
  }, [disabled])

  return (
    <span ref={host} className="md-ripple" aria-hidden="true">
      {waves.map((w) => (
        <span
          key={w.id}
          className="md-ripple__wave"
          style={{ left: w.x - w.size / 2, top: w.y - w.size / 2, width: w.size, height: w.size }}
        />
      ))}
    </span>
  )
}
