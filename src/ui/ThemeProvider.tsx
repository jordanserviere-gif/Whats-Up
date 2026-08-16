import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemeMode = 'dark' | 'light'
export type ContrastLevel = 'standard' | 'medium' | 'high'

interface ThemeApi {
  mode: ThemeMode
  contrast: ContrastLevel
  setMode: (m: ThemeMode) => void
  toggleMode: () => void
  setContrast: (c: ContrastLevel) => void
}

const ThemeContext = createContext<ThemeApi | null>(null)
const STORAGE_KEY = 'ciel.theme'

/**
 * Applique le theme via les attributs `data-theme` / `data-contrast` sur `<html>`,
 * ce qui bascule d'un jeu de tokens de couleur a l'autre sans re-render de l'arbre.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(`${STORAGE_KEY}.mode`)
    return saved === 'light' || saved === 'dark' ? saved : 'dark'
  })
  const [contrast, setContrastState] = useState<ContrastLevel>(
    () => (localStorage.getItem(`${STORAGE_KEY}.contrast`) as ContrastLevel) ?? 'standard',
  )

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = mode
    root.dataset.themeTransition = 'on'
    localStorage.setItem(`${STORAGE_KEY}.mode`, mode)
    const t = window.setTimeout(() => delete root.dataset.themeTransition, 400)
    return () => window.clearTimeout(t)
  }, [mode])

  useEffect(() => {
    const root = document.documentElement
    if (contrast === 'standard') delete root.dataset.contrast
    else root.dataset.contrast = contrast
    localStorage.setItem(`${STORAGE_KEY}.contrast`, contrast)
  }, [contrast])

  const setMode = useCallback((m: ThemeMode) => setModeState(m), [])
  const toggleMode = useCallback(() => setModeState((m) => (m === 'dark' ? 'light' : 'dark')), [])
  const setContrast = useCallback((c: ContrastLevel) => setContrastState(c), [])

  const api = useMemo(
    () => ({ mode, contrast, setMode, toggleMode, setContrast }),
    [mode, contrast, setMode, toggleMode, setContrast],
  )

  return <ThemeContext.Provider value={api}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeApi {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme doit etre utilise dans un ThemeProvider')
  return ctx
}
