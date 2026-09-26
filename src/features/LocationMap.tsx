import { useEffect, useRef, useState } from 'react'
import { useTheme } from '@/ui/ThemeProvider'
import { GOOGLE_MAPS_MAP_ID, googleMapsConfigured, loadGoogleMaps } from './googleMaps'
import './LocationMap.css'

/**
 * Carte de selection du lieu — un petit client Google Maps.
 *
 * On s'y deplace et on y zoome librement ; un clic, ou le marqueur qu'on
 * glisse, **propose** un lieu, et la recherche en trouve un par son nom. Rien
 * n'est applique ici : la carte ne fait que remplir le brouillon du panneau,
 * que l'utilisateur valide ensuite — un changement de lieu reconstruit tout le
 * ciel, il ne doit pas partir d'un clic egare.
 *
 * Le fond suit le theme : clair, sombre, et en night le filtre physique
 * commun (`--app-physical-filter`) le ramene a l'ambre comme le sol de la
 * scene.
 */
export interface LocationMapProps {
  latitudeDeg: number
  longitudeDeg: number
  /** Un lieu est propose ; `name` vient de la recherche, s'il y en a une. */
  onPick: (latitudeDeg: number, longitudeDeg: number, name?: string) => void
}

type Status = 'loading' | 'ready' | 'error'

export function LocationMap({ latitudeDeg, longitudeDeg, onPick }: LocationMapProps) {
  const { mode } = useTheme()
  const mapHost = useRef<HTMLDivElement>(null)
  const searchHost = useRef<HTMLDivElement>(null)
  const map = useRef<google.maps.Map | null>(null)
  const marker = useRef<google.maps.marker.AdvancedMarkerElement | null>(null)
  const [status, setStatus] = useState<Status>(googleMapsConfigured() ? 'loading' : 'error')
  // Le rappel change a chaque rendu du panneau ; la carte, elle, n'est creee
  // qu'une fois par theme. On lit donc toujours le dernier par une reference.
  const pick = useRef(onPick)
  pick.current = onPick
  const initial = useRef({ lat: latitudeDeg, lng: longitudeDeg })
  initial.current = { lat: latitudeDeg, lng: longitudeDeg }

  // --- La carte, recreee au changement de theme --------------------------
  // `colorScheme` ne se fixe qu'a la creation : c'est la seule facon, sans
  // style cartographique dedie, de suivre le clair et le sombre.
  useEffect(() => {
    if (!googleMapsConfigured()) return
    let alive = true
    const listeners: google.maps.MapsEventListener[] = []
    void (async () => {
      try {
        const maps = await loadGoogleMaps()
        const [{ Map }, { AdvancedMarkerElement }, core] = await Promise.all([
          maps.importLibrary('maps') as Promise<google.maps.MapsLibrary>,
          maps.importLibrary('marker') as Promise<google.maps.MarkerLibrary>,
          maps.importLibrary('core') as Promise<google.maps.CoreLibrary>,
        ])
        if (!alive || !mapHost.current) return
        const centre = map.current?.getCenter()?.toJSON() ?? initial.current
        const zoom = map.current?.getZoom() ?? 9
        const instance = new Map(mapHost.current, {
          center: centre,
          zoom,
          mapId: GOOGLE_MAPS_MAP_ID,
          colorScheme: mode === 'light' ? core.ColorScheme.LIGHT : core.ColorScheme.DARK,
          disableDefaultUI: true,
          zoomControl: true,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: false,
          // Dans un panneau etroit, exiger Ctrl pour zoomer serait une gene : la
          // carte est l'unique cible de la molette quand on la survole.
          gestureHandling: 'greedy',
        })
        const pin = new AdvancedMarkerElement({ map: instance, position: initial.current, gmpDraggable: true, title: 'Lieu proposé' })
        listeners.push(
          instance.addListener('click', (e: google.maps.MapMouseEvent) => {
            if (e.latLng) pick.current(e.latLng.lat(), e.latLng.lng())
          }),
          pin.addListener('dragend', () => {
            const p = pin.position
            if (!p) return
            const at = p instanceof google.maps.LatLng ? p.toJSON() : { lat: Number(p.lat), lng: Number(p.lng) }
            pick.current(at.lat, at.lng)
          }),
        )
        map.current = instance
        marker.current = pin
        setStatus('ready')
      } catch {
        if (alive) setStatus('error')
      }
    })()
    return () => {
      alive = false
      listeners.forEach((l) => l.remove())
      if (marker.current) marker.current.map = null
    }
  }, [mode])

  // --- La recherche, creee une fois ---------------------------------------
  useEffect(() => {
    if (!googleMapsConfigured()) return
    let alive = true
    let element: google.maps.places.PlaceAutocompleteElement | null = null
    const onSelect = async (event: Event) => {
      const { placePrediction } = event as unknown as { placePrediction: google.maps.places.PlacePrediction }
      const place = placePrediction.toPlace()
      await place.fetchFields({ fields: ['displayName', 'location'] })
      if (!place.location) return
      const lat = place.location.lat()
      const lng = place.location.lng()
      map.current?.panTo({ lat, lng })
      map.current?.setZoom(11)
      pick.current(lat, lng, place.displayName ?? undefined)
    }
    void (async () => {
      try {
        const maps = await loadGoogleMaps()
        const { PlaceAutocompleteElement } = (await maps.importLibrary('places')) as google.maps.PlacesLibrary
        if (!alive || !searchHost.current) return
        element = new PlaceAutocompleteElement({})
        element.setAttribute('placeholder', 'Rechercher un lieu')
        element.addEventListener('gmp-select', onSelect)
        searchHost.current.appendChild(element)
      } catch {
        /* la carte signale deja l'erreur */
      }
    })()
    return () => {
      alive = false
      element?.removeEventListener('gmp-select', onSelect)
      element?.remove()
    }
  }, [])

  // --- Le marqueur suit le lieu propose -----------------------------------
  // Quelle qu'en soit l'origine — clic, recherche, saisie, prereglage — et la
  // carte recentre seulement si le lieu sort de la vue : un clic ne doit pas
  // faire sauter la carte sous le curseur.
  useEffect(() => {
    const at = { lat: latitudeDeg, lng: longitudeDeg }
    if (marker.current) marker.current.position = at
    const bounds = map.current?.getBounds()
    if (map.current && bounds && !bounds.contains(at)) map.current.panTo(at)
  }, [latitudeDeg, longitudeDeg, status])

  if (!googleMapsConfigured()) {
    return (
      <p className="md-type-body-small location-map__missing">
        Carte indisponible : la clé Google Maps n’est pas configurée (<code>VITE_GOOGLE_MAPS_API_KEY</code> dans{' '}
        <code>.env.local</code>). Les coordonnées restent saisissables ci-dessus.
      </p>
    )
  }

  return (
    <div className="location-map">
      <div ref={searchHost} className="location-map__search" />
      <div className="location-map__frame">
        <div ref={mapHost} className="location-map__canvas" aria-label="Carte — cliquer pour proposer un lieu" />
        {status !== 'ready' && (
          <p className="md-type-body-small location-map__state">
            {status === 'loading' ? 'Chargement de la carte…' : 'La carte n’a pas pu se charger.'}
          </p>
        )}
      </div>
    </div>
  )
}
