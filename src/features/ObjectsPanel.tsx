import { useMemo } from 'react'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataGrid,
  DataRow,
  Divider,
  List,
  ListItem,
  Section,
  StatTile,
} from '@/ui'
import { BODIES, BODY_BY_ID } from '@/astro/bodies'
import { azimuthToCardinal, formatDeg, formatDms, formatRa } from '@/astro/coords'
import { formatTime } from '@/astro/time'
import { readToken } from '@/scene/sceneMath'
import { useSkyStore } from '@/state/store'
import { useAllRiseSets, useBodyStates, useMoonInfo, useRiseSet } from '@/state/hooks'
import { MoonPhaseDial } from './MoonPhaseDial'
import type { BodyState, RiseSetInfo } from '@/astro/types'
import './ObjectsPanel.css'

const KM_PER_AU = 149_597_870.7

function bodyColor(id: string): string {
  const def = BODY_BY_ID.get(id as never)
  return def ? readToken(def.colorToken, '#ffffff') : '#ffffff'
}

/** Distance lisible : millions de km au-dela de la Lune. */
function formatDistance(distanceAu: number, id: string): { value: string; unit: string } {
  const km = distanceAu * KM_PER_AU
  if (id === 'moon') return { value: Math.round(km).toLocaleString('fr-FR'), unit: 'km' }
  if (distanceAu < 0.05) return { value: (km / 1000).toFixed(0), unit: '× 10³ km' }
  return { value: distanceAu.toFixed(3).replace('.', ','), unit: 'ua' }
}

/** Liste des corps du systeme solaire, triee par hauteur decroissante. */
export function ObjectsPanel() {
  const bodies = useBodyStates()
  const riseSets = useAllRiseSets()
  const selectedBody = useSkyStore((s) => s.selectedBody)
  const selectBody = useSkyStore((s) => s.selectBody)
  const lookAt = useSkyStore((s) => s.lookAt)

  const sorted = useMemo(
    () => [...bodies].sort((a, b) => b.horizontal.altitude - a.horizontal.altitude),
    [bodies],
  )
  const visibleCount = sorted.filter((b) => b.visible).length
  const selected = sorted.find((b) => b.id === selectedBody) ?? null

  return (
    <>
      <Section
        title="Au-dessus de l’horizon"
        icon="visibility"
        summary={`${visibleCount} / ${BODIES.length}`}
        collapsible={false}
      >
        <List>
          {sorted.map((b) => (
            <ListItem
              key={b.id}
              leadingDot={bodyColor(b.id)}
              headline={b.name}
              supportingText={`${azimuthToCardinal(b.horizontal.azimuth)} · mag ${b.magnitude.toFixed(1).replace('.', ',')}`}
              trailingText={formatDeg(b.horizontal.altitude, 0)}
              selected={selectedBody === b.id}
              className={b.visible ? undefined : 'objects-panel__below'}
              onClick={() => {
                selectBody(b.id)
                lookAt(b.horizontal.azimuth, b.horizontal.altitude)
              }}
            />
          ))}
        </List>
      </Section>

      {selected && <BodyDetails state={selected} riseSet={riseSets.get(selected.id) ?? null} />}
      {!selected && <MoonSummaryCard />}
    </>
  )
}

/** Fiche detaillee d'un corps selectionne. */
export function BodyDetails({ state, riseSet }: { state: BodyState; riseSet: RiseSetInfo | null }) {
  const lookAt = useSkyStore((s) => s.lookAt)
  const moon = useMoonInfo()
  const distance = formatDistance(state.distanceAu, state.id)

  return (
    <Card variant="filled" shape="extra-large">
      <CardHeader
        overline="Objet sélectionné"
        title={state.name}
        subtitle={state.visible ? 'visible au-dessus de l’horizon' : 'sous l’horizon'}
        trailing={
          state.id === 'moon' ? (
            <MoonPhaseDial illumination={moon.illumination} phaseAngle={moon.phaseAngle} size={44} />
          ) : (
            <Badge tone={state.visible ? 'primary' : 'neutral'}>mag {state.magnitude.toFixed(1).replace('.', ',')}</Badge>
          )
        }
      />
      <CardBody>
        <DataGrid columns={2}>
          <StatTile label="Hauteur" value={formatDeg(state.horizontal.altitude, 1)} tone={state.visible ? 'primary' : 'neutral'} icon="height" />
          <StatTile
            label="Azimut"
            value={`${state.horizontal.azimuth.toFixed(1).replace('.', ',')}°`}
            unit={azimuthToCardinal(state.horizontal.azimuth)}
            icon="explore"
          />
        </DataGrid>

        <Divider />

        <DataRow label="Ascension droite" value={formatRa(state.equatorial.ra)} />
        <DataRow label="Déclinaison" value={formatDms(state.equatorial.dec)} />
        <DataRow label="Distance" value={distance.value} unit={distance.unit} />
        <DataRow label="Diamètre apparent" value={`${(state.angularDiameter * 60).toFixed(2).replace('.', ',')}′`} />
        {state.id !== 'sun' && (
          <>
            <DataRow label="Phase éclairée" value={`${Math.round(state.illumination * 100)}`} unit="%" />
            <DataRow label="Élongation solaire" value={`${state.elongation.toFixed(1).replace('.', ',')}°`} />
          </>
        )}

        {riseSet && (
          <>
            <Divider />
            <DataRow icon="wb_twilight" label="Lever" value={riseSet.rise ? formatTime(riseSet.rise) : '—'} />
            <DataRow
              icon="vertical_align_top"
              label="Culmination"
              value={riseSet.transit ? formatTime(riseSet.transit) : '—'}
              unit={riseSet.transitAltitude !== null ? formatDeg(riseSet.transitAltitude, 0) : undefined}
              emphasis
            />
            <DataRow icon="nights_stay" label="Coucher" value={riseSet.set ? formatTime(riseSet.set) : '—'} />
            {riseSet.circumpolar && <Badge tone="secondary" icon="all_inclusive">circumpolaire</Badge>}
            {riseSet.alwaysBelow && <Badge tone="neutral" icon="visibility_off">jamais levé</Badge>}
          </>
        )}

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

/** Carte de synthese lunaire, affichee quand rien n'est selectionne. */
function MoonSummaryCard() {
  const moon = useMoonInfo()
  const riseSet = useRiseSet('moon')

  return (
    <Card variant="filled" shape="extra-large">
      <CardHeader
        overline="Lune"
        title={moon.phaseName}
        subtitle={`${Math.round(moon.illumination * 100)} % éclairée · ${moon.ageDays.toFixed(1).replace('.', ',')} jours`}
        trailing={<MoonPhaseDial illumination={moon.illumination} phaseAngle={moon.phaseAngle} size={52} />}
      />
      <CardBody>
        <DataGrid columns={2}>
          <StatTile label="Distance" value={Math.round(moon.distanceKm).toLocaleString('fr-FR')} unit="km" icon="straighten" />
          <StatTile label="Diamètre" value={`${(moon.angularDiameter * 60).toFixed(1).replace('.', ',')}′`} icon="radio_button_unchecked" />
        </DataGrid>
        <DataRow label="Libration en longitude" value={formatDeg(moon.librationLon, 2)} />
        <DataRow label="Libration en latitude" value={formatDeg(moon.librationLat, 2)} />
        <Divider />
        <DataRow icon="dark_mode" label="Prochaine nouvelle lune" value={moon.nextNewMoon.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} />
        <DataRow icon="light_mode" label="Prochaine pleine lune" value={moon.nextFullMoon.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} />
        {riseSet && (
          <>
            <Divider />
            <DataRow label="Lever" value={riseSet.rise ? formatTime(riseSet.rise) : '—'} />
            <DataRow label="Coucher" value={riseSet.set ? formatTime(riseSet.set) : '—'} />
          </>
        )}
      </CardBody>
    </Card>
  )
}
