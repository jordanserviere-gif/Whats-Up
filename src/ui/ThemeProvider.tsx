import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * `night` est un theme a part entiere, pas une variante du sombre : noir pur et
 * ambre, pour observer sans perdre l'adaptation de l'oeil a l'obscurite.
 */
export type ThemeMode = 'dark' | 'light' | 'night'
export type ContrastLevel = 'standard' | 'medium' | 'high'

interface ThemeApi {
  mode: ThemeMode
  contrast: ContrastLevel
  setMode: (m: ThemeMode) => void
  toggleMode: () => void
  /** Bascule night ↔ le dernier theme de jour choisi. */
  toggleNight: () => void
  setContrast: (c: ContrastLevel) => void
}

const ThemeContext = createContext<ThemeApi | null>(null)
const STORAGE_KEY = 'ciel.theme'

const isMode = (v: string | null): v is ThemeMode => v === 'light' || v === 'dark' || v === 'night'

/**
 * Pose les attributs de theme sur `<html>`, **avant** le rendu qui en depend.
 *
 * La scene lit ses couleurs dans les tokens CSS pendant son rendu
 * (`useSceneColors`). Poser l'attribut dans un effet, apres coup, lui faisait
 * lire les tokens du theme precedent — invisible entre clair et sombre, dont
 * les accents se ressemblent, flagrant en night.
 */
function applyTheme(mode: ThemeMode, contrast: ContrastLevel) {
  const root = document.documentElement
  root.dataset.theme = mode
  if (contrast === 'standard') delete root.dataset.contrast
  else root.dataset.contrast = contrast
}

/**
 * Applique le theme via les attributs `data-theme` / `data-contrast` sur `<html>`,
 * ce qui bascule d'un jeu de tokens de couleur a l'autre sans re-render de l'arbre.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(`${STORAGE_KEY}.mode`)
    return isMode(saved) ? saved : 'dark'
  })
  const [contrast, setContrastState] = useState<ContrastLevel>(
    () => (localStorage.getItem(`${STORAGE_KEY}.contrast`) as ContrastLevel) ?? 'standard',
  )
  // Pendant le rendu, et non dans un effet : voir `applyTheme`. L'operation est
  // idempotente, la repeter a chaque rendu ne coute rien.
  applyTheme(mode, contrast)
  // Theme vers lequel revenir en quittant night.
  const [dayMode, setDayMode] = useState<Exclude<ThemeMode, 'night'>>(() =>
    localStorage.getItem(`${STORAGE_KEY}.day`) === 'light' ? 'light' : 'dark',
  )

  useEffect(() => {
    const root = document.documentElement
    root.dataset.themeTransition = 'on'
    localStorage.setItem(`${STORAGE_KEY}.mode`, mode)
    if (mode !== 'night') {
      setDayMode(mode)
      localStorage.setItem(`${STORAGE_KEY}.day`, mode)
    }
    // La barre d'etat du systeme suit le fond : en night, un bandeau gris en
    // haut de l'ecran suffirait a eblouir.
    const background = getComputedStyle(root).getPropertyValue('--md-sys-color-background').trim()
    if (background) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background)
    const t = window.setTimeout(() => delete root.dataset.themeTransition, 400)
    return () => window.clearTimeout(t)
  }, [mode])

  useEffect(() => {
    localStorage.setItem(`${STORAGE_KEY}.contrast`, contrast)
  }, [contrast])

  const setMode = useCallback((m: ThemeMode) => setModeState(m), [])
  const toggleMode = useCallback(() => setModeState((m) => (m === 'light' ? 'dark' : 'light')), [])
  const toggleNight = useCallback(() => setModeState((m) => (m === 'night' ? dayMode : 'night')), [dayMode])
  const setContrast = useCallback((c: ContrastLevel) => setContrastState(c), [])

  const api = useMemo(
    () => ({ mode, contrast, setMode, toggleMode, toggleNight, setContrast }),
    [mode, contrast, setMode, toggleMode, toggleNight, setContrast],
  )

  return <ThemeContext.Provider value={api}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeApi {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme doit etre utilise dans un ThemeProvider')
  return ctx
}
