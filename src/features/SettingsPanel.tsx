import { useState } from 'react'
import {
  Button,
  Divider,
  SegmentedButton,
  Section,
  Select,
  Slider,
  Switch,
  TextField,
  useSnackbar,
  useTheme,
} from '@/ui'
import { PRESET_LOCATIONS, useSkyStore, type LayerVisibility } from '@/state/store'
import { STAR_COUNT, STAR_MAG_LIMIT } from '@/astro/catalog'
import { localTimeZone } from '@/astro/time'

const LAYER_LABELS: Array<{ key: keyof LayerVisibility; label: string; hint?: string }> = [
  { key: 'stars', label: 'Étoiles' },
  { key: 'constellations', label: 'Figures de constellations' },
  { key: 'constellationLabels', label: 'Noms des constellations' },
  { key: 'bodies', label: 'Corps du système solaire' },
  { key: 'bodyLabels', label: 'Noms des corps' },
  { key: 'satellites', label: 'Satellites' },
  { key: 'satelliteTracks', label: 'Traces des satellites' },
  { key: 'horizonGrid', label: 'Grille horizontale', hint: 'azimut et hauteur' },
  { key: 'equatorialGrid', label: 'Grille équatoriale', hint: 'ascension droite et déclinaison' },
  { key: 'ecliptic', label: 'Écliptique' },
  { key: 'cardinals', label: 'Points cardinaux' },
  { key: 'ground', label: 'Sol' },
  { key: 'atmosphere', label: 'Atmosphère', hint: 'le ciel bleuit de jour et masque les étoiles' },
]

/** Reglages : lieu d'observation, calques, apparence. */
export function SettingsPanel() {
  const location = useSkyStore((s) => s.location)
  const setLocation = useSkyStore((s) => s.setLocation)
  const layers = useSkyStore((s) => s.layers)
  const setLayer = useSkyStore((s) => s.setLayer)
  const magnitudeLimit = useSkyStore((s) => s.magnitudeLimit)
  const setMagnitudeLimit = useSkyStore((s) => s.setMagnitudeLimit)
  const discScale = useSkyStore((s) => s.discScale)
  const setDiscScale = useSkyStore((s) => s.setDiscScale)
  const { mode, setMode, contrast, setContrast } = useTheme()
  const { show } = useSnackbar()
  const [locating, setLocating] = useState(false)

  const useMyPosition = () => {
    if (!navigator.geolocation) {
      show('La géolocalisation n’est pas disponible dans ce navigateur')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({
          name: 'Position actuelle',
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          elevation: pos.coords.altitude ?? 0,
        })
        setLocating(false)
        show('Lieu d’observation mis à jour')
      },
      () => {
        setLocating(false)
        show('Position refusée ou indisponible')
      },
      { enableHighAccuracy: false, timeout: 10_000 },
    )
  }

  return (
    <>
      <Section title="Lieu d’observation" icon="place" defaultOpen summary={location.name}>
        <Select
          label="Lieu enregistré"
          leadingIcon="location_city"
          value={PRESET_LOCATIONS.some((l) => l.name === location.name) ? location.name : ''}
          options={[
            ...(PRESET_LOCATIONS.some((l) => l.name === location.name) ? [] : [{ value: '', label: location.name }]),
            ...PRESET_LOCATIONS.map((l) => ({ value: l.name, label: l.name })),
          ]}
          onChange={(name) => {
            const found = PRESET_LOCATIONS.find((l) => l.name === name)
            if (found) setLocation(found)
          }}
        />

        <TextField
          label="Latitude"
          type="number"
          numeric
          step="0.0001"
          suffix="°N"
          value={location.latitude.toFixed(4)}
          onChange={(e) => setLocation({ ...location, name: 'Lieu personnalisé', latitude: Number(e.target.value) })}
        />
        <TextField
          label="Longitude"
          type="number"
          numeric
          step="0.0001"
          suffix="°E"
          value={location.longitude.toFixed(4)}
          onChange={(e) => setLocation({ ...location, name: 'Lieu personnalisé', longitude: Number(e.target.value) })}
        />
        <TextField
          label="Altitude"
          type="number"
          numeric
          step="1"
          suffix="m"
          value={location.elevation.toFixed(0)}
          onChange={(e) => setLocation({ ...location, elevation: Number(e.target.value) })}
        />

        <Button variant="tonal" icon="my_location" fullWidth disabled={locating} onClick={useMyPosition}>
          {locating ? 'Localisation…' : 'Utiliser ma position'}
        </Button>
        <p className="md-type-body-small">Fuseau horaire : {localTimeZone()}</p>
      </Section>

      <Section title="Calques de la scène" icon="layers" defaultOpen={false} summary={`${Object.values(layers).filter(Boolean).length} actifs`}>
        {LAYER_LABELS.map((l) => (
          <Switch
            key={l.key}
            label={l.label}
            supportingText={l.hint}
            checked={layers[l.key]}
            onChange={(v) => setLayer(l.key, v)}
          />
        ))}
        <Divider />
        <Slider
          label="Magnitude limite des étoiles"
          min={2}
          max={STAR_MAG_LIMIT}
          step={0.5}
          value={magnitudeLimit}
          showValue
          format={(v) => `mag ${v.toFixed(1).replace('.', ',')}`}
          onChange={setMagnitudeLimit}
        />
        <p className="md-type-body-small">
          Catalogue HYG : {STAR_COUNT.toLocaleString('fr-FR')} étoiles jusqu’à la magnitude{' '}
          {STAR_MAG_LIMIT.toFixed(1).replace('.', ',')}. L’éclat affiché suit la magnitude réelle et
          l’extinction atmosphérique ; la magnitude limite du moment dépend de la luminosité du ciel.
        </p>
      </Section>

      <Section
        title="Échelle des disques"
        icon="zoom_out_map"
        defaultOpen={false}
        summary={discScale === 1 ? 'taille réelle' : `×${discScale}`}
      >
        <Slider
          label="Grossissement des disques planétaires"
          min={1}
          max={50}
          step={1}
          value={discScale}
          showValue
          format={(v) => (v === 1 ? 'taille réelle' : `× ${v}`)}
          onChange={setDiscScale}
        />
        <p className="md-type-body-small">
          Par défaut, chaque corps occupe son diamètre apparent exact : Jupiter mesure une quarantaine de
          secondes d’arc, soit une fraction de pixel à champ large. Resserrez le champ à moins d’un degré
          pour voir les disques, ou grossissez-les ici — au prix de la fidélité.
        </p>
      </Section>

      <Section title="Apparence" icon="palette" defaultOpen={false} summary={mode === 'dark' ? 'sombre' : 'clair'}>
        <SegmentedButton
          ariaLabel="Thème de l’interface"
          fullWidth
          segments={[
            { value: 'dark', label: 'Sombre', icon: 'dark_mode' },
            { value: 'light', label: 'Clair', icon: 'light_mode' },
          ]}
          value={mode}
          onChange={setMode}
        />
        <SegmentedButton
          ariaLabel="Niveau de contraste"
          fullWidth
          segments={[
            { value: 'standard', label: 'Standard' },
            { value: 'medium', label: 'Moyen' },
            { value: 'high', label: 'Élevé' },
          ]}
          value={contrast}
          onChange={setContrast}
        />
      </Section>
    </>
  )
}
