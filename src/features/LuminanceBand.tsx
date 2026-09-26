import { useMemo } from 'react'
import { AIRGLOW_LUX, skyLuminance } from '@/astro/photometry'
import type { GeoLocation } from '@/astro/types'
import { useTheme } from '@/ui/ThemeProvider'
import './LuminanceBand.css'

/**
 * Rampe eclairement → couleur.
 *
 * Les points d'ancrage sont places sur des seuils physiques : fond de ciel
 * nocturne, clair de lune, fin du crepuscule civil, lever du Soleil, plein jour.
 * Comme l'echelle est continue et logarithmique, la bande dit d'elle-meme ce
 * qui se passe : une Lune haute eclaircit la nuit, une eclipse creuse le jour.
 */
const RAMP: ReadonlyArray<[lux: number, rgb: [number, number, number]]> = [
  [0.00015, [4, 5, 11]], // nuit noire, sans Lune
  [0.001, [8, 11, 24]], // airglow et Lune tres basse
  [0.01, [15, 20, 44]], // croissant leve / crepuscule astronomique
  [0.08, [26, 34, 74]], // clair de lune franc
  [0.5, [40, 47, 100]], // pleine lune haute
  [3.4, [69, 62, 122]], // fin du crepuscule civil
  [40, [140, 88, 116]], // entre chien et loup
  [400, [201, 116, 66]], // Soleil a l'horizon
  [3000, [176, 148, 168]], // bascule vers le bleu du jour
  [15000, [116, 165, 219]],
  [60000, [150, 199, 244]],
  [130000, [176, 216, 255]], // Soleil au zenith
]

function rampColor(lux: number): string {
  const x = Math.log10(Math.max(1e-5, lux))
  if (x <= Math.log10(RAMP[0][0])) return `rgb(${RAMP[0][1].join(',')})`
  for (let i = 0; i + 1 < RAMP.length; i++) {
    const x0 = Math.log10(RAMP[i][0])
    const x1 = Math.log10(RAMP[i + 1][0])
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0)
      const a = RAMP[i][1]
      const b = RAMP[i + 1][1]
      return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(
        a[2] + (b[2] - a[2]) * t,
      )})`
    }
  }
  return `rgb(${RAMP[RAMP.length - 1][1].join(',')})`
}

/**
 * Bande de luminance de la frise temporelle.
 *
 * Chaque echantillon est un vrai bilan lumineux — Soleil, occultation du disque
 * solaire, Lune — et non une simple lecture de la hauteur du Soleil. La bande
 * fait donc apparaitre sans code dedie le clair de lune qui gate une nuit, et
 * l'encoche sombre d'une eclipse en plein jour.
 */
export function LuminanceBand({
  start,
  end,
  location,
  samples = 128,
}: {
  start: number
  end: number
  location: GeoLocation
  samples?: number
}) {
  const { mode } = useTheme()

  const gradient = useMemo(() => {
    const stops: string[] = []
    for (let i = 0; i <= samples; i++) {
      const t = new Date(start + ((end - start) * i) / samples)
      const lux = skyLuminance(t, location).illuminance
      stops.push(`${rampColor(lux)} ${((i / samples) * 100).toFixed(2)}%`)
    }
    return `linear-gradient(90deg, ${stops.join(', ')})`
    // Le theme n'entre pas dans le calcul : la rampe est physique, pas decorative.
  }, [start, end, location, samples])

  void mode

  return <div className="luminance-band" style={{ background: gradient }} aria-hidden="true" />
}

/** Repere de lecture : quelques paliers d'eclairement, pour la legende. */
export const LUMINANCE_LEGEND = [
  { lux: AIRGLOW_LUX, label: 'nuit noire' },
  { lux: 0.1, label: 'clair de lune' },
  { lux: 3.4, label: 'crépuscule' },
  { lux: 400, label: 'lever' },
  { lux: 100000, label: 'plein jour' },
] as const
