import { useMemo } from 'react'
import { useTheme } from '@/ui/ThemeProvider'
import { hexToLinearRgb, readToken } from './sceneMath'

/**
 * Resout en une passe tous les tokens de couleur utilises par la scene 3D.
 *
 * Les composants react-three-fiber vivent dans un reconciler distinct : les
 * contextes React ne les traversent pas. On lit donc les tokens ici, cote DOM,
 * et on les transmet en props.
 */
export function useSceneColors() {
  const { mode } = useTheme()

  return useMemo(
    () => ({
      skyZenith: readToken('--app-sky-zenith', '#05070f'),
      skyHorizon: readToken('--app-sky-horizon', '#0d1220'),
      skyDay: readToken('--app-twilight-day', '#7ec8ff'),
      twilight: readToken('--app-twilight-civil', '#ff9d5c'),
      ground: readToken('--app-sky-ground', '#07090e'),
      groundGlow: readToken('--app-sky-horizon', '#0d1220'),
      horizonLine: readToken('--app-scene-ink-muted', '#8ca4da'),
      horizonGrid: readToken('--app-scene-accent', '#b9c8eb'),
      equatorialGrid: readToken('--app-scene-accent-alt', '#dce4f5'),
      ecliptic: readToken('--app-body-sun', '#ffd24a'),
      constellation: readToken('--app-scene-accent', '#b9c8eb'),
      constellationLabel: readToken('--app-scene-ink-muted', '#8ca4da'),
      cardinal: readToken('--app-scene-accent-muted', '#8ca4da'),
      moonGlow: readToken('--app-moon-glow', '#7d8fc4'),
      lightPollution: readToken('--app-sky-light-pollution', '#ffb066'),
      sunGlow: readToken('--app-body-sun-glow', '#ffe9c4'),
      selection: readToken('--app-selection-ring', '#ffffff'),
      onSurface: readToken('--app-scene-ink', '#dce4f5'),
      onSurfaceVariant: readToken('--app-scene-ink-muted', '#8ca4da'),
      deepSkyLabel: readToken('--app-dso-label', '#c4c5d6'),
      track: {
        sunlit: readToken('--app-track-sunlit', '#ffffff'),
        eclipsed: readToken('--app-scene-ink-muted', '#8ca4da'),
        below: readToken('--wu-blue-800', '#142348'),
      },
      /** Teinte du post-process night, RGB lineaire ; `null` hors night. */
      nightTint: mode === 'night' ? hexToLinearRgb(readToken('--app-night-tint', '#f0a73f')) : null,
    }),
    // Les tokens changent avec le theme.
    [mode],
  )
}

export type SceneColors = ReturnType<typeof useSceneColors>
