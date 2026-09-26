/**
 * Chargement de l'API Google Maps JavaScript.
 *
 * Une seule insertion du script pour toute la session, quelle que soit la
 * frequence a laquelle la carte est montee et demontee : le panneau des
 * reglages s'ouvre et se ferme, l'API reste. Les bibliotheques sont ensuite
 * tirees a la demande par `importLibrary`, comme le recommande Google.
 */

const KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
export const GOOGLE_MAPS_MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID'

export const googleMapsConfigured = (): boolean => Boolean(KEY)

let loading: Promise<typeof google.maps> | null = null

export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (!KEY) return Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY absente'))
  if (loading) return loading
  loading = new Promise((resolve, reject) => {
    const callback = '__whatsUpMapsReady'
    ;(window as unknown as Record<string, () => void>)[callback] = () => resolve(google.maps)
    const script = document.createElement('script')
    const params = new URLSearchParams({ key: KEY, v: 'weekly', loading: 'async', callback, language: 'fr' })
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`
    script.async = true
    script.onerror = () => {
      loading = null
      reject(new Error('Chargement de Google Maps impossible'))
    }
    document.head.appendChild(script)
  })
  return loading
}
