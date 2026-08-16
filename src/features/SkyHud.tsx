import { Chip, ChipSet, IconButton, Surface, Toolbar, Tooltip } from '@/ui'
import { useSkyStore, type LayerVisibility } from '@/state/store'
import { useSkyConditions } from '@/state/hooks'
import { azimuthToCardinal, formatDeg } from '@/astro/coords'
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

/** Elements poses au-dessus de la scene : reperes de visee et calques rapides. */
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
            hauteur {formatDeg(viewAltitude, 0)} · champ {Math.round(fov)}°
          </span>
        </div>
      </Surface>

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
          <IconButton icon="zoom_out" label="Élargir le champ" onClick={() => setFov(Math.min(110, fov * 1.35))} />
        </Tooltip>
        <Tooltip content="Resserrer le champ" placement="start">
          <IconButton icon="zoom_in" label="Resserrer le champ" onClick={() => setFov(Math.max(0.15, fov / 1.35))} />
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
