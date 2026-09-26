/// <reference types="vite/client" />
/// <reference types="google.maps" />

interface ImportMetaEnv {
  /** Cle de l'API Google Maps JavaScript (Maps + Places), restreinte par referent. */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string
  /** Map ID Google Maps ; `DEMO_MAP_ID` a defaut, suffisant pour les marqueurs avances. */
  readonly VITE_GOOGLE_MAPS_MAP_ID?: string
}
