import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from './Button'
import { IconButton } from './IconButton'
import './Snackbar.css'

interface SnackMessage {
  id: number
  text: string
  actionLabel?: string
  onAction?: () => void
}

interface SnackbarApi {
  show: (text: string, options?: { actionLabel?: string; onAction?: () => void; durationMs?: number }) => void
}

const SnackbarContext = createContext<SnackbarApi>({ show: () => {} })

/** Fournit `useSnackbar()` et rend la file de messages ancree en bas de l'ecran. */
export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<SnackMessage[]>([])
  const seq = useRef(0)

  const dismiss = useCallback((id: number) => setQueue((q) => q.filter((m) => m.id !== id)), [])

  const show = useCallback<SnackbarApi['show']>(
    (text, options) => {
      const id = ++seq.current
      setQueue((q) => [...q.slice(-2), { id, text, actionLabel: options?.actionLabel, onAction: options?.onAction }])
      window.setTimeout(() => dismiss(id), options?.durationMs ?? 4500)
    },
    [dismiss],
  )

  const api = useMemo(() => ({ show }), [show])

  return (
    <SnackbarContext.Provider value={api}>
      {children}
      <div className="wu-snackbar-host" role="status" aria-live="polite">
        {queue.map((m) => (
          <div key={m.id} className="wu-snackbar">
            <span className="wu-type-body-m wu-snackbar__text">{m.text}</span>
            {m.actionLabel && (
              <Button
                variant="text"
                size="xs"
                className="wu-snackbar__action"
                onClick={() => {
                  m.onAction?.()
                  dismiss(m.id)
                }}
              >
                {m.actionLabel}
              </Button>
            )}
            <IconButton icon="close" size="xs" label="Fermer" onClick={() => dismiss(m.id)} />
          </div>
        ))}
      </div>
    </SnackbarContext.Provider>
  )
}

export const useSnackbar = () => useContext(SnackbarContext)
