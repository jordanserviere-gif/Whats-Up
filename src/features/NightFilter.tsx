import { useMemo } from 'react'
import { useTheme } from '@/ui/ThemeProvider'
import { hexToLinearRgb, readToken } from '@/scene/sceneMath'

/** Ponderations de luminance Rec. 709, les memes que le shader du terrain. */
const LUMA = [0.2126, 0.7152, 0.0722] as const

/**
 * Filtre SVG du theme night, pour le DOM.
 *
 * Le pendant, pour le DOM, de la conversion du sol (shader du terrain) :
 * luminance lineaire, portee par `--app-night-ui-tint`. Le blanc devient
 * ambre, le noir reste noir. Il ne sert qu'aux elements qui affichent une couleur physique —
 * pastilles des corps, frise d'eclairement, cadran lunaire — via le token
 * `--app-physical-filter` ; l'interface, elle, a ses propres tokens night.
 *
 * `feColorMatrix` travaille en RGB lineaire par defaut
 * (`color-interpolation-filters: linearRGB`), comme le shader.
 *
 * Les tokens lus ici existent dans tous les themes : les lire pendant le rendu,
 * avant que `data-theme` ne change, ne donne donc jamais une valeur perimee.
 */
export function NightFilter() {
  const { mode } = useTheme()
  const matrix = useMemo(() => {
    const tint = hexToLinearRgb(readToken('--app-night-ui-tint', '#cc7f00'))
    const row = (c: number) => `${LUMA.map((w) => (w * c).toFixed(5)).join(' ')} 0 0`
    return `${row(tint[0])} ${row(tint[1])} ${row(tint[2])} 0 0 0 1 0`
  }, [mode])

  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <filter id="app-night-filter" colorInterpolationFilters="linearRGB">
        <feColorMatrix type="matrix" values={matrix} />
      </filter>
    </svg>
  )
}
