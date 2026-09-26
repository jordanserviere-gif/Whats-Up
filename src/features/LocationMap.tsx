import { useEffect, useRef, useState } from 'react'
import { Map as MapLibre, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl'
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { TextField } from '@/ui'
import { useTheme } from '@/ui/ThemeProvider'
import { readToken } from '@/scene/sceneMath'
import { buildMapStyle } from './mapStyle'
import './LocationMap.css'

/**
 * Carte de selection du lieu — MapLibre sur tuiles OpenFreeMap.
 *
 * On s'y deplace et on y zoome librement ; un clic, ou le marqueur qu'on
 * glisse, **propose** un lieu, et la recherche en trouve un par son nom. Rien
 * n'est applique ici : la carte ne fait que remplir le brouillon du panneau,
 * que l'utilisateur valide ensuite — un changement de lieu reconstruit tout le
 * ciel, il ne doit pas partir d'un clic egare.
 *
 * Aucune cle : les tuiles viennent d'OpenFreeMap, la recherche de Photon
 * (geocodeur OpenStreetMap de Komoot). Le style est peint avec les tokens du
 * theme, et en night le filtre physique commun le ramene a l'ambre.
 */
export interface LocationMapProps {
  latitudeDeg: number
  longitudeDeg: number
  /** Un lieu est propose ; `name` vient de la recherche, s'il y en a une. */
  onPick: (latitudeDeg: number, longitudeDeg: number, name?: string) => void
}

// Le worker de MapLibre importe un module voisin : servi tel quel depuis le
// prebundle de Vite, il ne le trouve plus. `?worker&url` le fait empaqueter
// avec ses dependances, et on lui donne son adresse.
setWorkerUrl(mapWorkerUrl)

interface SearchHit {
  name: string
  detail: string
  lat: number
  lon: number
}

const PHOTON = 'https://photon.komoot.io/api/'
/** Delai de frappe avant d'interroger le geocodeur, ms. */
const SEARCH_DEBOUNCE_MS = 300

async function searchPlaces(query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, limit: '6', lang: 'fr' })
  const response = await fetch(`${PHOTON}?${params}`, { signal })
  if (!response.ok) return []
  const data = (await response.json()) as {
    features: Array<{ geometry: { coordinates: [number, number] }; properties: Record<string, string | undefined> }>
  }
  return data.features.map(({ geometry, properties: p }) => ({
    name: p.name ?? p.city ?? p.county ?? 'Lieu',
    detail: [p.city !== p.name ? p.city : undefined, p.state, p.country].filter(Boolean).join(', '),
    lon: geometry.coordinates[0],
    lat: geometry.coordinates[1],
  }))
}

export function LocationMap({ latitudeDeg, longitudeDeg, onPick }: LocationMapProps) {
  const { mode } = useTheme()
  const host = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibre | null>(null)
  const marker = useRef<Marker | null>(null)
  // Le rappel change a chaque rendu du panneau ; la carte, elle, n'est creee
  // qu'une fois. On lit donc toujours le dernier par une reference.
  const pick = useRef(onPick)
  pick.current = onPick
  const initial = useRef<[number, number]>([longitudeDeg, latitudeDeg])

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)

  // --- La carte, creee une fois ----------------------------------------------
  useEffect(() => {
    if (!host.current) return
    const instance = new MapLibre({
      container: host.current,
      style: buildMapStyle(),
      center: initial.current,
      zoom: 8,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    })
    instance.touchZoomRotate.disableRotation()
    // L'attribution compacte s'ouvre d'elle-meme sur une carte large : dans un
    // panneau, elle masquerait le tiers du bas. On la replie, le « i » reste.
    instance.once('load', () => {
      host.current?.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show')
    })
    instance.addControl(new NavigationControl({ showCompass: false }), 'top-right')

    const pin = new Marker({ draggable: true, color: readToken('--md-sys-color-primary', '#2c4f9e') })
      .setLngLat(initial.current)
      .addTo(instance)
    pin.on('dragend', () => {
      const at = pin.getLngLat()
      pick.current(at.lat, at.lng)
    })
    instance.on('click', (e) => pick.current(e.lngLat.lat, e.lngLat.lng))

    map.current = instance
    marker.current = pin
    return () => {
      instance.remove()
      map.current = null
      marker.current = null
    }
  }, [])

  // --- Le style suit le theme --------------------------------------------------
  // Les tokens sont deja ceux du nouveau theme : `ThemeProvider` pose
  // l'attribut pendant le rendu, avant cet effet.
  // Le marqueur, lui, garde sa couleur : le primaire est le meme en clair et
  // en sombre, et le night le convertit par filtre.
  const styledFor = useRef(mode)
  useEffect(() => {
    if (styledFor.current === mode) return
    styledFor.current = mode
    map.current?.setStyle(buildMapStyle())
  }, [mode])

  // --- Le marqueur suit le lieu propose ---------------------------------------
  // Quelle qu'en soit l'origine — clic, recherche, saisie, prereglage — et la
  // carte ne recentre que si le lieu sort de la vue : un clic ne doit pas faire
  // sauter la carte sous le curseur.
  useEffect(() => {
    const at: [number, number] = [longitudeDeg, latitudeDeg]
    marker.current?.setLngLat(at)
    const m = map.current
    if (m && !m.getBounds().contains(at)) m.easeTo({ center: at })
  }, [latitudeDeg, longitudeDeg])

  // --- Recherche ----------------------------------------------------------------
  useEffect(() => {
    const q = query.trim()
    if (q.length < 3) {
      setHits([])
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setSearching(true)
      searchPlaces(q, controller.signal)
        .then(setHits)
        .catch(() => {
          if (!controller.signal.aborted) setHits([])
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [query])

  const choose = (hit: SearchHit) => {
    map.current?.flyTo({ center: [hit.lon, hit.lat], zoom: 11 })
    pick.current(hit.lat, hit.lon, hit.name)
    setQuery('')
    setHits([])
  }

  return (
    <div className="location-map">
      <div className="location-map__search">
        <TextField
          label="Rechercher un lieu"
          leadingIcon="search"
          density="compact"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) choose(hits[0])
            if (e.key === 'Escape') setQuery('')
          }}
          supportingText={searching ? 'Recherche…' : undefined}
        />
        {hits.length > 0 && (
          <ul className="location-map__hits" role="listbox" aria-label="Lieux trouvés">
            {hits.map((hit) => (
              <li key={`${hit.lat},${hit.lon}`}>
                <button type="button" role="option" aria-selected="false" onClick={() => choose(hit)}>
                  <span className="md-type-body-medium">{hit.name}</span>
                  {hit.detail && <span className="md-type-body-small location-map__hit-detail">{hit.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="location-map__frame">
        <div ref={host} className="location-map__canvas" aria-label="Carte — cliquer pour proposer un lieu" />
      </div>
    </div>
  )
}
