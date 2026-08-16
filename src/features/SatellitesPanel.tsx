import { useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataGrid,
  DataRow,
  Divider,
  LinearProgress,
  List,
  ListItem,
  Section,
  SegmentedButton,
  Slider,
  StatTile,
  useSnackbar,
} from '@/ui'
import { azimuthToCardinal, formatDeg } from '@/astro/coords'
import { formatDuration, formatTime } from '@/astro/time'
import { useSkyStore } from '@/state/store'
import { useSatellitePasses, useSatelliteStates } from '@/state/hooks'
import { OrbitEditor } from './OrbitEditor'
import type { OrbitalElements, SatellitePass, SatelliteState } from '@/astro/types'
import './SatellitesPanel.css'

/**
 * Outil satellite : definition d'une orbite par ses elements keplerians,
 * lecture de l'etat instantane et recherche des passages a venir.
 */
export function SatellitesPanel() {
  const satellites = useSkyStore((s) => s.satellites)
  const selectedId = useSkyStore((s) => s.selectedSatellite)
  const selectSatellite = useSkyStore((s) => s.selectSatellite)
  const addSatellite = useSkyStore((s) => s.addSatellite)
  const updateSatellite = useSkyStore((s) => s.updateSatellite)
  const removeSatellite = useSkyStore((s) => s.removeSatellite)
  const trackWindow = useSkyStore((s) => s.trackWindowMinutes)
  const setTrackWindow = useSkyStore((s) => s.setTrackWindow)
  const lookAt = useSkyStore((s) => s.lookAt)
  const states = useSatelliteStates()
  const { show } = useSnackbar()

  const selected = satellites.find((s) => s.id === selectedId) ?? null

  if (satellites.length === 0) {
    return (
      <Card variant="filled" shape="extra-large">
        <CardHeader
          icon="satellite_alt"
          overline="Outil satellite"
          title="Aucune orbite définie"
          subtitle="Saisissez des éléments orbitaux pour voir la trace apparaître dans le ciel"
        />
        <CardBody>
          <p className="md-type-body-medium satellites-panel__intro">
            Un satellite se décrit par six nombres : la taille et la forme de son ellipse (demi-grand axe,
            excentricité), l’orientation de son plan (inclinaison, longitude du nœud ascendant, argument du
            périgée) et sa position à une date de référence (anomalie moyenne).
          </p>
          <Button
            variant="filled"
            icon="add"
            size="m"
            fullWidth
            onClick={() => {
              addSatellite()
              show('Satellite créé — ajustez ses éléments orbitaux')
            }}
          >
            Créer une orbite
          </Button>
        </CardBody>
      </Card>
    )
  }

  return (
    <>
      <Section
        title="Satellites suivis"
        icon="satellite_alt"
        summary={`${satellites.length}`}
        collapsible={false}
        actions={
          <Button
            variant="text"
            size="xs"
            icon="add"
            onClick={() => {
              addSatellite()
              show('Satellite créé')
            }}
          >
            Ajouter
          </Button>
        }
      >
        <List>
          {satellites.map((el) => {
            const state = states.get(el.id)
            return (
              <ListItem
                key={el.id}
                leadingDot={el.color}
                headline={el.name}
                supportingText={
                  state
                    ? `${azimuthToCardinal(state.horizontal.azimuth)} · ${Math.round(state.altitudeKm)} km · ${state.sunlit ? 'éclairé' : 'dans l’ombre'}`
                    : 'éléments invalides'
                }
                trailingText={state ? formatDeg(state.horizontal.altitude, 0) : '—'}
                selected={selectedId === el.id}
                onClick={() => {
                  selectSatellite(el.id)
                  if (state) lookAt(state.horizontal.azimuth, state.horizontal.altitude)
                }}
              />
            )
          })}
        </List>

        <Slider
          label="Longueur de la trace affichée"
          min={10}
          max={720}
          step={10}
          value={trackWindow}
          showValue
          format={(v) => (v >= 60 ? `${(v / 60).toFixed(1).replace('.', ',')} h` : `${v} min`)}
          onChange={setTrackWindow}
        />
      </Section>

      {selected && (
        <>
          <SatelliteLiveCard element={selected} state={states.get(selected.id) ?? null} />
          <Section title="Éléments orbitaux" icon="edit" defaultOpen>
            <OrbitEditor
              element={selected}
              onChange={(patch) => updateSatellite(selected.id, patch)}
              onRemove={() => {
                removeSatellite(selected.id)
                show(`« ${selected.name} » supprimé`)
              }}
            />
          </Section>
          <PassesSection element={selected} />
        </>
      )}
    </>
  )
}

/** Etat instantane du satellite selectionne. */
function SatelliteLiveCard({ element, state }: { element: OrbitalElements; state: SatelliteState | null }) {
  const lookAt = useSkyStore((s) => s.lookAt)

  if (!state) {
    return (
      <Card variant="outlined" shape="extra-large">
        <CardHeader icon="error" title={element.name} subtitle="Éléments orbitaux invalides" />
      </Card>
    )
  }

  const above = state.horizontal.altitude > 0

  return (
    <Card variant="filled" shape="extra-large">
      <CardHeader
        overline="Position instantanée"
        title={element.name}
        subtitle={above ? 'au-dessus de l’horizon' : 'sous l’horizon'}
        trailing={
          <Badge tone={state.sunlit ? 'tertiary' : 'neutral'} icon={state.sunlit ? 'wb_sunny' : 'dark_mode'}>
            {state.sunlit ? 'éclairé' : 'éclipse'}
          </Badge>
        }
      />
      <CardBody>
        <DataGrid columns={2}>
          <StatTile label="Hauteur" value={formatDeg(state.horizontal.altitude, 1)} tone={above ? 'primary' : 'neutral'} icon="height" />
          <StatTile
            label="Azimut"
            value={`${state.horizontal.azimuth.toFixed(1).replace('.', ',')}°`}
            unit={azimuthToCardinal(state.horizontal.azimuth)}
            icon="explore"
          />
          <StatTile label="Distance" value={Math.round(state.rangeKm).toLocaleString('fr-FR')} unit="km" icon="straighten" />
          <StatTile label="Altitude" value={Math.round(state.altitudeKm).toLocaleString('fr-FR')} unit="km" icon="flight" />
        </DataGrid>

        <Divider />
        <DataRow
          label="Point au sol"
          value={`${state.latitude.toFixed(2).replace('.', ',')}°, ${state.longitude.toFixed(2).replace('.', ',')}°`}
        />
        <DataRow
          label="Vitesse radiale"
          value={`${state.rangeRateKm > 0 ? '+' : '−'}${Math.abs(state.rangeRateKm).toFixed(2).replace('.', ',')}`}
          unit="km/s"
          hint={state.rangeRateKm > 0 ? 'le satellite s’éloigne' : 'le satellite se rapproche'}
        />
        <DataRow
          label="Magnitude estimée"
          value={state.magnitude !== null ? state.magnitude.toFixed(1).replace('.', ',') : '—'}
          emphasis={state.magnitude !== null && state.magnitude < 3}
        />

        <Button
          variant="tonal"
          icon="center_focus_strong"
          fullWidth
          onClick={() => lookAt(state.horizontal.azimuth, state.horizontal.altitude)}
        >
          Centrer dans le ciel
        </Button>
      </CardBody>
    </Card>
  )
}

/** Recherche et liste des passages a venir. */
function PassesSection({ element }: { element: OrbitalElements }) {
  const location = useSkyStore((s) => s.location)
  const setTime = useSkyStore((s) => s.setTime)
  const lookAt = useSkyStore((s) => s.lookAt)
  const [hours, setHours] = useState(24)
  const [filter, setFilter] = useState<'tous' | 'visibles'>('visibles')

  const { passes, loading } = useSatellitePasses(element, location, hours, filter === 'visibles')

  return (
    <Section
      title="Prochains passages"
      icon="radar"
      defaultOpen
      summary={loading ? '…' : `${passes.length}`}
    >
      <SegmentedButton
        ariaLabel="Filtrer les passages"
        fullWidth
        segments={[
          { value: 'visibles', label: 'Visibles à l’œil' },
          { value: 'tous', label: 'Tous' },
        ]}
        value={filter}
        onChange={setFilter}
      />
      <SegmentedButton
        ariaLabel="Fenêtre de recherche"
        fullWidth
        segments={[
          { value: '12', label: '12 h' },
          { value: '24', label: '24 h' },
          { value: '72', label: '3 j' },
        ]}
        value={String(hours)}
        onChange={(v) => setHours(Number(v))}
      />

      {loading && <LinearProgress />}

      {!loading && passes.length === 0 && (
        <p className="md-type-body-medium satellites-panel__empty">
          Aucun passage {filter === 'visibles' ? 'visible ' : ''}au-dessus de 10° de hauteur sur cette fenêtre.
        </p>
      )}

      <List>
        {passes.map((p) => (
          <PassRow
            key={p.start.getTime()}
            pass={p}
            onSelect={() => {
              setTime(p.peak.getTime())
              lookAt(((p.startAzimuth + p.endAzimuth) / 2 + 360) % 360, p.peakAltitude)
            }}
          />
        ))}
      </List>
    </Section>
  )
}

function PassRow({ pass, onSelect }: { pass: SatellitePass; onSelect: () => void }) {
  const duration = (pass.end.getTime() - pass.start.getTime()) / 1000
  return (
    <ListItem
      leadingIcon={pass.visible ? 'visibility' : 'visibility_off'}
      overline={pass.start.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}
      headline={`${formatTime(pass.start)} → ${formatTime(pass.end)}`}
      supportingText={`${azimuthToCardinal(pass.startAzimuth)} → ${azimuthToCardinal(pass.endAzimuth)} · ${formatDuration(duration)}${
        pass.maxMagnitude !== null ? ` · mag ${pass.maxMagnitude.toFixed(1).replace('.', ',')}` : ''
      }`}
      trailingText={formatDeg(pass.peakAltitude, 0)}
      onClick={onSelect}
    />
  )
}
