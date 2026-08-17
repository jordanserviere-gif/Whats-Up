import { useMemo } from 'react'
import { useTheme } from '@/ui/ThemeProvider'
import { readToken } from './sceneMath'

/**
 * Resout en une passe tous les tokens de couleur utilises par la scene 3D.
 *
 * Les composants react-three-fiber vivent dans un reconciler distinct : les
 * contextes React ne les traversent pas. On lit donc les tokens ici, cote DOM,
 * et on les transmet en props.
 */
export function useSceneColors() {
  const { mode, contrast } = useTheme()

  return useMemo(
    () => ({
      skyZenith: readToken('--app-sky-zenith', '#05070f'),
      skyHorizon: readToken('--app-sky-horizon', '#0d1220'),
      skyDay: readToken('--app-twilight-day', '#7ec8ff'),
      twilight: readToken('--app-twilight-civil', '#ff9d5c'),
      ground: readToken('--app-sky-ground', '#07090e'),
      groundGlow: readToken('--app-sky-horizon', '#0d1220'),
      horizonLine: readToken('--md-sys-color-outline', '#8e909f'),
      horizonGrid: readToken('--md-sys-color-primary', '#b8c3ff'),
      equatorialGrid: readToken('--md-sys-color-tertiary', '#d5bcf4'),
      ecliptic: readToken('--app-body-sun', '#ffd24a'),
      constellation: readToken('--md-sys-color-primary', '#b8c3ff'),
      constellationLabel: readToken('--md-sys-color-on-surface-variant', '#c4c5d6'),
      cardinal: readToken('--md-sys-color-secondary', '#c8c2ea'),
      moonGlow: readToken('--app-moon-glow', '#7d8fc4'),
      sunGlow: readToken('--app-body-sun-glow', '#ffe9c4'),
      selection: readToken('--app-selection-ring', '#b8c3ff'),
      onSurface: readToken('--md-sys-color-on-surface', '#e2e1ef'),
      onSurfaceVariant: readToken('--md-sys-color-on-surface-variant', '#c4c5d6'),
      deepSkyLabel: readToken('--app-dso-label', '#c4c5d6'),
      track: {
        sunlit: readToken('--md-sys-color-tertiary', '#d5bcf4'),
        eclipsed: readToken('--md-sys-color-outline', '#8e909f'),
        below: readToken('--md-sys-color-surface-container-highest', '#33343f'),
      },
    }),
    // Les tokens changent avec le theme et le niveau de contraste.
    [mode, contrast],
  )
}

export type SceneColors = ReturnType<typeof useSceneColors>
