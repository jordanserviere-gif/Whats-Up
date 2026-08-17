import { useMemo, useState } from 'react'
import { SearchBar, type SearchSuggestion } from '@/ui'
import { BODY_BY_ID } from '@/astro/bodies'
import { equatorialToHorizontal, formatDeg, precessFromJ2000 } from '@/astro/coords'
import { satelliteTarget, searchTargets, type SkyTarget } from '@/astro/search'
import { readToken } from '@/scene/sceneMath'
import { useSkyStore } from '@/state/store'
import { useAllSatellites, useBodyStates, useSimulatedDate } from '@/state/hooks'
import './SkySearch.css'

/** Icone de repli par famille, quand l'objet n'a pas de couleur propre. */
const KIND_ICON: Record<SkyTarget['kind'], string> = {
  body: 'public',
  star: 'star',
  deepsky: 'blur_on',
  satellite: 'satellite_alt',
  constellation: 'auto_awesome',
}

/**
 * Recherche d'un objet du ciel.
 *
 * Le meme index sert au clavier et au pointage : chercher « Vega » et cliquer
 * l'etoile menent a la meme fiche. La selection recentre la vue, ouvre le
 * panneau et pose la fiche — un seul geste pour aller voir.
 */
export function SkySearch({ className }: { className?: string }) {
  const [query, setQuery] = useState('')
  const date = useSimulatedDate()
  const location = useSkyStore((s) => s.location)
  const select = useSkyStore((s) => s.select)
  const setTab = useSkyStore((s) => s.setTab)
  const lookAt = useSkyStore((s) => s.lookAt)
  const bodies = useBodyStates()
  const satellites = useAllSatellites()

  const results = useMemo(() => {
    if (query.trim().length === 0) return []
    return searchTargets(query, { extra: satellites.map(satelliteTarget), limit: 10 })
  }, [query, satellites])

  /** Hauteur actuelle de l'objet : c'est l'information qui decide d'aller voir ou non. */
  const altitudeOf = (target: SkyTarget): number | null => {
    if (target.kind === 'body') return bodies.find((b) => b.id === target.id)?.horizontal.altitude ?? null
    if (target.equatorialJ2000) {
      return equatorialToHorizontal(precessFromJ2000(target.equatorialJ2000, date), location, date).altitude
    }
    return null
  }

  const suggestions: SearchSuggestion[] = results.map((t) => {
    const altitude = altitudeOf(t)
    const def = t.kind === 'body' ? BODY_BY_ID.get(t.id as never) : null
    const magnitude =
      t.kind === 'body' ? (bodies.find((b) => b.id === t.id)?.magnitude ?? null) : t.magnitude
    return {
      id: t.id,
      headline: t.name,
      supporting: magnitude !== null ? `${t.detail} · mag ${magnitude.toFixed(1).replace('.', ',')}` : t.detail,
      leadingIcon: KIND_ICON[t.kind],
      dot: def ? readToken(def.colorToken, '#ffffff') : undefined,
      trailing: altitude !== null ? formatDeg(altitude, 0) : undefined,
    }
  })

  const onSelect = (id: string) => {
    const target = results.find((t) => t.id === id)
    if (!target) return

    select({ kind: target.kind, id: target.id })
    setTab(target.kind === 'satellite' ? 'satellites' : 'objets')

    // On ne recentre que sur ce qu'on sait situer : une constellation par son
    // etiquette, un objet fixe par ses coordonnees, un mobile par son etat.
    if (target.kind === 'body') {
      const state = bodies.find((b) => b.id === target.id)
      if (state) lookAt(state.horizontal.azimuth, state.horizontal.altitude)
    } else if (target.kind === 'satellite') {
      // La position d'un satellite change trop vite pour etre figee ici : c'est
      // le panneau qui la reprend et recentre avec l'etat courant.
    } else if (target.equatorialJ2000) {
      const h = equatorialToHorizontal(precessFromJ2000(target.equatorialJ2000, date), location, date)
      lookAt(h.azimuth, h.altitude)
    }

    setQuery('')
  }

  return (
    <SkySearchShell className={className}>
      <SearchBar
        value={query}
        onChange={setQuery}
        suggestions={suggestions}
        onSelect={onSelect}
        placeholder="Chercher un astre, une étoile, M31…"
        label="Rechercher un objet du ciel"
        emptyText="Aucun objet ne correspond. Essayez un nom propre, une désignation (α Lyr) ou un numéro de catalogue (M31, NGC 224)."
      />
    </SkySearchShell>
  )
}

function SkySearchShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={['sky-search', className].filter(Boolean).join(' ')}>{children}</div>
}
