import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SnackbarProvider, ThemeProvider } from '@/ui'
import { useSkyStore } from '@/state/store'
import { App } from './App'
import './styles/base.css'

const container = document.getElementById('root')
if (!container) throw new Error('Element racine introuvable')

// En developpement seulement : point d'entree pour piloter la scene depuis un
// navigateur automatise (`scripts/shoot.mjs`), qui fixe l'instant, le lieu et la
// visee avant de capturer le rendu.
if (import.meta.env.DEV) {
  ;(window as unknown as { __skyStore: typeof useSkyStore }).__skyStore = useSkyStore
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <SnackbarProvider>
        <App />
      </SnackbarProvider>
    </ThemeProvider>
  </StrictMode>,
)
