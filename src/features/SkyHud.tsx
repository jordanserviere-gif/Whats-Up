import { Badge, Chip, ChipSet, IconButton, Surface, Toolbar, Tooltip } from '@/ui'
import { useSkyStore, type LayerVisibility } from '@/state/store'
import { AIRCRAFT_RADIUS_KM, useCelestrakSatellites, useNearbyAircraft, useSkyConditions } from '@/state/hooks'
import { azimuthToCardinal, formatDeg } from '@/astro/coords'
import { MAX_FOV, MIN_FOV } from '@/scene/CameraRig'
import { SkySearch } from './SkySearch'
import './SkyHud.css'

/** Calques proposes en acces direct au-dessus de la scene. */
const QUICK_LAYERS: Array<{ key: keyof LayerVisibility; label: string; icon: string }> = [
  { key: 'constellations', label: 'Constellations', icon: 'star' },
  { key: 'deepSky', label: 'Ciel profond', icon: 'blur_on' },
  { key: 'horizonGrid', label: 'Grille horizon', icon: 'grid_on' },
  { key: 'equatorialGrid', label: 'Grille équatoriale', icon: 'public' },
  { key: 'ecliptic', label: 'Écliptique', icon: 'sync_alt' },
  { key: 'satelliteTracks', label: 'Traces satellites', icon: 'timeline' },
  { key: 'atmosphere', label: 'Atmosphère', icon: 'wb_twilight' },
]

/** Elements poses au-dessus de la scene : reperes de visee, recherche et calques. */
export function SkyHud() {
  const viewAzimuth = useSkyStore((s) => s.viewAzimuth)
  const viewAltitude = useSkyStore((s) => s.viewAltitude)
  const fov = useSkyStore((s) => s.fov)
  const layers = useSkyStore((s) => s.layers)
  const toggleLayer = useSkyStore((s) => s.toggleLayer)
  const lookAt = useSkyStore((s) => s.lookAt)
  const setFov = useSkyStore((s) => s.setFov)
  const conditions = useSkyConditions()

  return (
    <div className="sky-hud">
      <Surface level={3} shape="extra-large" glass className="sky-hud__compass">
        <div className="sky-hud__compass-dial" style={{ '--_az': `${-viewAzimuth}deg` } as React.CSSProperties}>
          <span className="sky-hud__compass-needle" />
          <span className="sky-hud__compass-north md-type-label-small is-emphasized">N</span>
        </div>
        <div className="sky-hud__readout">
          <span className="md-type-title-medium is-emphasized md-numeric">
            {azimuthToCardinal(viewAzimuth)} {Math.round(viewAzimuth)}°
          </span>
          <span className="md-type-label-medium sky-hud__readout-sub md-numeric">
            hauteur {formatDeg(viewAltitude, 0)} · champ {formatFov(fov)}
          </span>
        </div>
      </Surface>

      <SkySearch className="sky-hud__search" />

      <div className="sky-hud__live-layers">
        <SatelliteToggle />
        <AircraftToggle />
      </div>

      <Toolbar className="sky-hud__view-tools" vertical>
        <Tooltip content="Regarder le zénith" placement="start">
          <IconButton icon="vertical_align_top" label="Regarder le zénith" onClick={() => lookAt(viewAzimuth, 85)} />
        </Tooltip>
        <Tooltip content="Regarder le nord" placement="start">
          <IconButton icon="explore" label="Regarder le nord" onClick={() => lookAt(0, 20)} />
        </Tooltip>
        <Tooltip content="Regarder le sud" placement="start">
          <IconButton icon="south" label="Regarder le sud" onClick={() => lookAt(180, 20)} />
        </Tooltip>
        <Tooltip content="Élargir le champ" placement="start">
          <IconButton icon="zoom_out" label="Élargir le champ" onClick={() => setFov(Math.min(MAX_FOV, fov * 1.35))} />
        </Tooltip>
        <Tooltip content="Resserrer le champ" placement="start">
          <IconButton icon="zoom_in" label="Resserrer le champ" onClick={() => setFov(Math.max(MIN_FOV, fov / 1.35))} />
        </Tooltip>
      </Toolbar>

      <div className="sky-hud__layers">
        <ChipSet scroll>
          {QUICK_LAYERS.map((l) => (
            <Chip
              key={l.key}
              variant="filter"
              icon={l.icon}
              selected={layers[l.key]}
              onClick={() => toggleLayer(l.key)}
            >
              {l.label}
            </Chip>
          ))}
        </ChipSet>
      </div>

      <Surface level={2} shape="full" glass className="sky-hud__conditions">
        <span className="md-type-label-medium is-emphasized">
          {conditions.twilight}
          {conditions.obscuration > 0.001 && ` · éclipse ${Math.round(conditions.obscuration * 100)} %`}
        </span>
        <span className="md-type-label-small sky-hud__conditions-sub md-numeric">
          Soleil {formatDeg(conditions.sunAltitude, 1)} · magnitude limite{' '}
          {conditions.limitingMagnitude.toFixed(1).replace('.', ',')}
        </span>
      </Surface>
    </div>
  )
}

/**
 * Bascule des satellites reels.
 *
 * Le nombre d'objets suivis est affiche a meme le bouton : c'est la seule facon
 * de savoir d'un coup d'oeil si le catalogue a bien ete recupere, s'il vient du
 * cache, ou si le reseau a manque et qu'on regarde un ciel sans satellites.
 */
function SatelliteToggle() {
  const enabled = useSkyStore((s) => s.layers.celestrak)
  const setLayer = useSkyStore((s) => s.setLayer)
  const setTab = useSkyStore((s) => s.setTab)
  const { elements, loading, status } = useCelestrakSatellites()

  const label = enabled ? 'Masquer les satellites' : 'Afficher les satellites'
  const detail = !enabled
    ? 'Objets réels depuis CelesTrak'
    : loading
      ? 'Récupération des éléments…'
      : elements.length === 0
        ? 'Aucun élément disponible hors ligne'
        : `${elements.length} objets · source ${status?.origin ?? 'défaut'}`

  return (
    <Toolbar className="sky-hud__satellites">
      <Tooltip content={detail} placement="bottom">
        <IconButton
          icon="satellite_alt"
          label={label}
          variant="tonal"
          selected={enabled}
          loading={loading}
          onClick={() => setLayer('celestrak', !enabled)}
        />
      </Tooltip>
      {enabled && elements.length > 0 && (
        <button type="button" className="sky-hud__satellites-count" onClick={() => setTab('satellites')}>
          <Badge tone="tertiary">{elements.length}</Badge>
        </button>
      )}
    </Toolbar>
  )
}

/**
 * Bascule des avions reels.
 *
 * Suivi en direct uniquement : l'ADS-B n'a pas d'archive gratuite, donc rien
 * n'apparait quand la frise s'est eloignee de l'instant present — le detail
 * dit pourquoi plutot que de laisser un bouton mysterieusement inactif.
 */
function AircraftToggle() {
  const enabled = useSkyStore((s) => s.layers.aircraft)
  const setLayer = useSkyStore((s) => s.setLayer)
  const setTab = useSkyStore((s) => s.setTab)
  const { aircraft, loading, status, live } = useNearbyAircraft()

  const label = enabled ? 'Masquer les avions' : 'Afficher les avions'
  const detail = !live
    ? `Disponible en direct seulement (rayon ${AIRCRAFT_RADIUS_KM} km)`
    : !enabled
      ? `Positions réelles dans un rayon de ${AIRCRAFT_RADIUS_KM} km`
      : loading && aircraft.length === 0
        ? 'Récupération des positions…'
        : aircraft.length === 0
          ? 'Aucun avion dans le rayon suivi'
          : `${aircraft.length} avions · source ${status?.origin ?? 'défaut'}`

  return (
    <Toolbar className="sky-hud__aircraft">
      <Tooltip content={detail} placement="bottom">
        <IconButton
          icon="flight"
          label={label}
          variant="tonal"
          selected={enabled}
          loading={enabled && loading && aircraft.length === 0}
          disabled={!live}
          onClick={() => setLayer('aircraft', !enabled)}
        />
      </Tooltip>
      {enabled && aircraft.length > 0 && (
        <button type="button" className="sky-hud__aircraft-count" onClick={() => setTab('objets')}>
          <Badge tone="tertiary">{aircraft.length}</Badge>
        </button>
      )}
    </Toolbar>
  )
}

/**
 * Champ affiche. Sous le degre, l'arrondi a l'entier afficherait « 0° » sur
 * toute la plage ou se joue justement l'observation planetaire.
 */
function formatFov(fov: number): string {
  if (fov >= 10) return `${Math.round(fov)}°`
  if (fov >= 1) return `${fov.toFixed(1).replace('.', ',')}°`
  return `${(fov * 60).toFixed(fov * 60 >= 10 ? 0 : 1).replace('.', ',')}′`
}
