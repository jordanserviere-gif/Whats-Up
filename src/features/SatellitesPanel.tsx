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
  Select,
  Slider,
  StatTile,
  Switch,
  useSnackbar,
} from '@/ui'
import { azimuthToCardinal, formatDeg } from '@/astro/coords'
import { formatDuration, formatTime } from '@/astro/time'
import { meanMotionRevPerDay, apogeeAltitude, orbitalPeriod, perigeeAltitude } from '@/astro/kepler'
import { CELESTRAK_GROUPS, STALE_EPOCH_DAYS } from '@/data-sources/celestrak'
import { formatAge } from '@/data-sources/types'
import { selectedSatelliteId, useSkyStore } from '@/state/store'
import {
  MAX_TRACKED_SATELLITES,
  useAllSatellites,
  useCelestrakSatellites,
  useSatellitePasses,
  useSatelliteStates,
} from '@/state/hooks'
import { OrbitEditor } from './OrbitEditor'
import type { OrbitalElements, SatellitePass, SatelliteState } from '@/astro/types'
import './SatellitesPanel.css'

const fr = (v: number, digits = 1) => v.toFixed(digits).replace('.', ',')

/**
 * Outil satellite.
 *
 * Deux origines cohabitent : les orbites decrites a la main par leurs elements
 * keplerians, et les objets reels du catalogue CelesTrak propages par SGP4. Une
 * fois selectionnes, les uns et les autres se lisent de la meme facon — c'est le
 * propagateur qui differe, pas l'observation.
 */
export function SatellitesPanel() {
  const manual = useSkyStore((s) => s.satellites)
  const selectedId = useSkyStore(selectedSatelliteId)
  const selectSatellite = useSkyStore((s) => s.selectSatellite)
  const addSatellite = useSkyStore((s) => s.addSatellite)
  const trackWindow = useSkyStore((s) => s.trackWindowMinutes)
  const setTrackWindow = useSkyStore((s) => s.setTrackWindow)
  const lookAt = useSkyStore((s) => s.lookAt)
  const all = useAllSatellites()
  const states = useSatelliteStates(all)
  const { show } = useSnackbar()

  const openSatellite = (el: OrbitalElements) => {
    selectSatellite(el.id)
    const state = states.get(el.id)
    if (state) lookAt(state.horizontal.azimuth, state.horizontal.altitude)
  }

  return (
    <>
      <CelestrakSection />

      <Section
        title="Orbites saisies"
        icon="edit_note"
        summary={`${manual.length}`}
        collapsible={manual.length > 0}
        defaultOpen
        actions={
          <Button
            variant="text"
            size="xs"
            icon="add"
            onClick={() => {
              addSatellite()
              show('Satellite créé — ajustez ses éléments orbitaux')
            }}
          >
            Ajouter
          </Button>
        }
      >
        {manual.length === 0 ? (
          <p className="md-type-body-medium satellites-panel__intro">
            Un satellite se décrit par six nombres : la taille et la forme de son ellipse (demi-grand axe,
            excentricité), l’orientation de son plan (inclinaison, longitude du nœud ascendant, argument du
            périgée) et sa position à une date de référence (anomalie moyenne).
          </p>
        ) : (
          <List>
            {manual.map((el) => (
              <SatelliteRow
                key={el.id}
                element={el}
                state={states.get(el.id) ?? null}
                selected={selectedId === el.id}
                onClick={() => openSatellite(el)}
              />
            ))}
          </List>
        )}

        <Slider
          label="Longueur de la trace affichée"
          min={10}
          max={720}
          step={10}
          value={trackWindow}
          showValue
          format={(v) => (v >= 60 ? `${fr(v / 60)} h` : `${v} min`)}
          onChange={setTrackWindow}
        />
      </Section>
    </>
  )
}

/**
 * Fiche ancree du panneau satellite.
 *
 * Sans selection, la fiche explique ou trouver un objet plutot que de rester
 * vide : le catalogue compte des milliers d'entrees, et c'est la recherche —
 * non une liste — qui y mene.
 */
export function SatelliteDetail() {
  const selectedId = useSkyStore(selectedSatelliteId)
  const updateSatellite = useSkyStore((s) => s.updateSatellite)
  const removeSatellite = useSkyStore((s) => s.removeSatellite)
  const all = useAllSatellites()
  const states = useSatelliteStates(all)
  const { show } = useSnackbar()

  const selected = all.find((s) => s.id === selectedId) ?? null

  if (!selected) {
    return (
      <Card variant="outlined" shape="extra-large">
        <CardHeader
          icon="search"
          overline="Aucun objet suivi"
          title="Chercher un satellite"
          subtitle="Son nom ou son numéro NORAD dans la barre de recherche, ou un clic sur son point dans le ciel"
        />
      </Card>
    )
  }

  return (
    <>
      <SatelliteLiveCard element={selected} state={states.get(selected.id) ?? null} />
      {selected.source === 'celestrak' ? (
        <CatalogElements element={selected} />
      ) : (
        <Section title="Éléments orbitaux" icon="edit" defaultOpen={false}>
          <OrbitEditor
            element={selected}
            onChange={(patch) => updateSatellite(selected.id, patch)}
            onRemove={() => {
              removeSatellite(selected.id)
              show(`« ${selected.name} » supprimé`)
            }}
          />
        </Section>
      )}
      <PassesSection element={selected} />
    </>
  )
}

/** Ligne de liste commune aux deux origines. */
function SatelliteRow({
  element,
  state,
  selected,
  onClick,
}: {
  element: OrbitalElements
  state: SatelliteState | null
  selected: boolean
  onClick: () => void
}) {
  return (
    <ListItem
      leadingDot={element.color}
      headline={element.name}
      supportingText={
        state
          ? `${azimuthToCardinal(state.horizontal.azimuth)} · ${Math.round(state.altitudeKm)} km · ${
              state.sunlit ? 'éclairé' : 'dans l’ombre'
            }`
          : 'éléments invalides'
      }
      trailingText={state ? formatDeg(state.horizontal.altitude, 0) : '—'}
      selected={selected}
      onClick={onClick}
    />
  )
}

/**
 * Satellites reels.
 *
 * La section reste visible meme calque eteint : c'est la qu'on choisit quel
 * groupe suivre, et l'interrupteur y est le pendant du bouton de la barre haute.
 */
function CelestrakSection() {
  const enabled = useSkyStore((s) => s.layers.celestrak)
  const setLayer = useSkyStore((s) => s.setLayer)
  const group = useSkyStore((s) => s.celestrakGroup)
  const setGroup = useSkyStore((s) => s.setCelestrakGroup)
  const feed = useCelestrakSatellites()
  const states = useSatelliteStates(feed.elements)

  // Deux chiffres suffisent a dire l'etat du ciel : combien d'objets sont suivis,
  // et combien sont effectivement au-dessus de l'horizon a cet instant.
  let aboveHorizon = 0
  let visible = 0
  for (const el of feed.elements) {
    const s = states.get(el.id)
    if (!s || s.horizontal.altitude <= 0) continue
    aboveHorizon++
    if (s.magnitude !== null) visible++
  }

  return (
    <Section
      title="Satellites réels"
      icon="satellite_alt"
      defaultOpen
      summary={enabled ? `${aboveHorizon} levés / ${feed.elements.length}` : 'masqués'}
    >
      <Switch
        label="Afficher les satellites"
        supportingText="Éléments publics CelesTrak, propagés par SGP4"
        checked={enabled}
        onChange={(v) => setLayer('celestrak', v)}
      />

      <Select
        label="Groupe suivi"
        leadingIcon="category"
        value={group}
        options={CELESTRAK_GROUPS.map((g) => ({ value: g.id, label: g.label }))}
        onChange={(v) => setGroup(v as typeof group)}
        disabled={!enabled}
      />

      {enabled && feed.loading && <LinearProgress />}

      {enabled && !feed.loading && feed.elements.length === 0 && (
        <p className="md-type-body-medium satellites-panel__empty">
          Aucun élément disponible : le réseau n’a pas répondu et rien n’est en cache. Les orbites saisies
          plus bas restent utilisables.
        </p>
      )}

      {enabled && feed.status && (
        <>
          <DataRow
            icon="cloud_download"
            label="Source"
            value={feed.status.origin}
            unit={feed.status.ageMs !== null ? formatAge(feed.status.ageMs) : undefined}
            hint="CelesTrak demande la mise en cache de ses réponses : elles sont conservées six heures."
          />
          {feed.truncated > 0 && (
            <DataRow
              icon="filter_list"
              label="Objets non suivis"
              value={`${feed.truncated}`}
              hint={`Le groupe dépasse le plafond de ${MAX_TRACKED_SATELLITES} objets propagés simultanément.`}
            />
          )}
          {feed.staleCount > 0 && (
            <DataRow
              icon="schedule"
              label="Éléments vieillis"
              value={`${feed.staleCount}`}
              hint={`Au-delà de ${STALE_EPOCH_DAYS} jours, la propagation SGP4 dérive sensiblement.`}
            />
          )}
        </>
      )}

      {enabled && feed.elements.length > 0 && (
        <>
          <DataGrid columns={2}>
            <StatTile
              label="Au-dessus de l’horizon"
              value={`${aboveHorizon}`}
              tone={aboveHorizon > 0 ? 'primary' : 'neutral'}
              icon="height"
            />
            <StatTile
              label="Éclairés"
              value={`${visible}`}
              unit={`/ ${aboveHorizon}`}
              icon="wb_sunny"
            />
          </DataGrid>
          {/* Le catalogue compte des milliers d'objets : les enumerer donnerait
              une liste qu'on ne parcourt pas. On dit ou chercher a la place. */}
          <p className="md-type-body-small satellites-panel__intro">
            Chaque objet éclairé apparaît dans le ciel sous la forme d’un point blanc dont l’éclat suit sa
            magnitude estimée. Pour en suivre un, cherchez son nom ou son numéro NORAD dans la barre de
            recherche, ou cliquez son point : sa fiche et sa trace s’affichent alors.
          </p>
        </>
      )}
    </Section>
  )
}

/**
 * Elements d'un objet du catalogue, en lecture seule.
 *
 * Les modifier n'aurait aucun effet : la propagation part de l'enregistrement
 * OMM d'origine, pas de ces valeurs. Les afficher sans les rendre modifiables
 * est la seule presentation honnete.
 */
function CatalogElements({ element }: { element: OrbitalElements }) {
  const period = orbitalPeriod(element.semiMajorAxisKm) / 60
  const stale = (element.epochAgeDays ?? 0) > STALE_EPOCH_DAYS

  return (
    <Section title="Éléments du catalogue" icon="inventory_2" defaultOpen={false} summary="lecture seule">
      <DataRow label="Identifiant NORAD" value={element.noradId !== undefined ? `${element.noradId}` : '—'} />
      <DataRow
        label="Époque des éléments"
        value={new Date(element.epoch).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
        unit={element.epochAgeDays !== undefined ? `il y a ${fr(element.epochAgeDays)} j` : undefined}
        emphasis={stale}
      />
      <Divider />
      <DataRow label="Demi-grand axe" value={Math.round(element.semiMajorAxisKm).toLocaleString('fr-FR')} unit="km" />
      <DataRow label="Excentricité" value={element.eccentricity.toFixed(6).replace('.', ',')} />
      <DataRow label="Inclinaison" value={fr(element.inclination, 3)} unit="°" />
      <DataRow label="Nœud ascendant" value={fr(element.raan, 3)} unit="°" />
      <DataRow label="Argument du périgée" value={fr(element.argPerigee, 3)} unit="°" />
      <DataRow label="Anomalie moyenne" value={fr(element.meanAnomaly, 3)} unit="°" />
      <Divider />
      <DataRow label="Période" value={fr(period)} unit="min" />
      <DataRow label="Révolutions par jour" value={fr(meanMotionRevPerDay(element.semiMajorAxisKm), 4)} />
      <DataRow
        label="Périgée / apogée"
        value={`${Math.round(perigeeAltitude(element.semiMajorAxisKm, element.eccentricity))} / ${Math.round(
          apogeeAltitude(element.semiMajorAxisKm, element.eccentricity),
        )}`}
        unit="km"
      />
      {stale && (
        <Badge tone="error" icon="warning">
          éléments vieux de plus de {STALE_EPOCH_DAYS} jours
        </Badge>
      )}
      <p className="md-type-body-small satellites-panel__intro">
        La propagation utilise l’enregistrement OMM d’origine et le modèle SGP4 qui l’accompagne. Les valeurs
        ci-dessus en sont dérivées pour la lecture ; les modifier n’aurait aucun effet sur la trajectoire.
      </p>
    </Section>
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
        overline={element.source === 'celestrak' ? 'Objet CelesTrak' : 'Position instantanée'}
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
          <StatTile
            label="Hauteur"
            value={formatDeg(state.horizontal.altitude, 1)}
            tone={above ? 'primary' : 'neutral'}
            icon="height"
          />
          <StatTile
            label="Azimut"
            value={`${fr(state.horizontal.azimuth)}°`}
            unit={azimuthToCardinal(state.horizontal.azimuth)}
            icon="explore"
          />
          <StatTile label="Distance" value={Math.round(state.rangeKm).toLocaleString('fr-FR')} unit="km" icon="straighten" />
          <StatTile label="Altitude" value={Math.round(state.altitudeKm).toLocaleString('fr-FR')} unit="km" icon="flight" />
        </DataGrid>

        <Divider />
        <DataRow label="Point au sol" value={`${fr(state.latitude, 2)}°, ${fr(state.longitude, 2)}°`} />
        <DataRow
          label="Vitesse radiale"
          value={`${state.rangeRateKm > 0 ? '+' : '−'}${fr(Math.abs(state.rangeRateKm), 2)}`}
          unit="km/s"
          hint={state.rangeRateKm > 0 ? 'le satellite s’éloigne' : 'le satellite se rapproche'}
        />
        <DataRow
          label="Magnitude estimée"
          value={state.magnitude !== null ? fr(state.magnitude) : '—'}
          emphasis={state.magnitude !== null && state.magnitude < 3}
          hint="Modèle sphérique diffusant à magnitude intrinsèque type : un ordre de grandeur, pas une prévision."
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
    <Section title="Prochains passages" icon="radar" defaultOpen summary={loading ? '…' : `${passes.length}`}>
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
      supportingText={`${azimuthToCardinal(pass.startAzimuth)} → ${azimuthToCardinal(pass.endAzimuth)} · ${formatDuration(
        duration,
      )}${pass.maxMagnitude !== null ? ` · mag ${fr(pass.maxMagnitude)}` : ''}`}
      trailingText={formatDeg(pass.peakAltitude, 0)}
      onClick={onSelect}
    />
  )
}
