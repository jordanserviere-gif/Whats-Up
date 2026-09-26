import { useMemo, useState } from 'react'
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
  SegmentedButton,
  Section,
  StatTile,
} from '@/ui'
import { BODIES, BODY_BY_ID, nextRelativeLongitudeEvent } from '@/astro/bodies'
import { azimuthToCardinal, formatDeg, formatDms, formatRa } from '@/astro/coords'
import { formatDate, formatTime } from '@/astro/time'
import { isFixedKind } from '@/astro/search'
import { readToken } from '@/scene/sceneMath'
import { selectedBodyId, useSkyStore } from '@/state/store'
import { useAllRiseSets, useBodyStates, useMoonInfo, useRiseSet } from '@/state/hooks'
import { FixedObjectDetails } from './ObjectDetails'
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

/**
 * Liste des corps du systeme solaire, triee par hauteur decroissante.
 *
 * La fiche de l'objet designe ne vit plus ici mais dans la zone ancree du
 * panneau : on parcourt le catalogue sans perdre de vue ce qu'on a selectionne.
 */
export function ObjectsPanel() {
  const bodies = useBodyStates()
  const selectedBody = useSkyStore(selectedBodyId)
  const selectBody = useSkyStore((s) => s.selectBody)
  const focusOn = useSkyStore((s) => s.focusOn)

  const sorted = useMemo(
    () => [...bodies].sort((a, b) => b.horizontal.altitude - a.horizontal.altitude),
    [bodies],
  )
  const visibleCount = sorted.filter((b) => b.visible).length

  return (
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
              focusOn(b.horizontal.azimuth, b.horizontal.altitude)
            }}
          />
        ))}
      </List>
    </Section>
  )
}

/**
 * Fiche ancree du panneau « objets ».
 *
 * Elle couvre tout ce qui n'est pas un satellite : corps du systeme solaire,
 * etoiles nommees, ciel profond, constellations. Sans selection, la Lune tient
 * la place — c'est l'objet que l'on regarde le plus souvent, et un panneau vide
 * n'apprendrait rien.
 */
export function ObjectsDetail() {
  const bodies = useBodyStates()
  const riseSets = useAllRiseSets()
  const selection = useSkyStore((s) => s.selection)
  const selectedBody = useSkyStore(selectedBodyId)

  const selected = bodies.find((b) => b.id === selectedBody) ?? null
  if (selected) return <BodyDetails state={selected} riseSet={riseSets.get(selected.id) ?? null} />

  if (selection && isFixedKind(selection.kind)) {
    return <FixedObjectDetails kind={selection.kind} id={selection.id} />
  }
  return <MoonSummaryCard />
}

/** Fiche detaillee d'un corps selectionne. */
export function BodyDetails({ state, riseSet }: { state: BodyState; riseSet: RiseSetInfo | null }) {
  const focusOn = useSkyStore((s) => s.focusOn)
  const moon = useMoonInfo()
  const distance = formatDistance(state.distanceAu, state.id)
  const [page, setPage] = useState<'essentiel' | 'details'>('essentiel')

  // Calee a l'heure : une recherche d'evenement, comme le lever et le coucher,
  // n'a pas a se refaire a chaque image.
  const time = useSkyStore((s) => s.time)
  const hourBucket = Math.floor(time / 3_600_000)
  const nextEvent = useMemo(
    () => nextRelativeLongitudeEvent(state.id, new Date(hourBucket * 3_600_000)),
    [state.id, hourBucket],
  )
  const hasDetails = state.id === 'saturn' || state.id === 'moon' || nextEvent !== null
  const showDetails = hasDetails && page === 'details'

  return (
    <Card variant="filled" shape="extra-large">
      <CardHeader
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
        {hasDetails && (
          <SegmentedButton
            ariaLabel="Page de la fiche"
            size="s"
            fullWidth
            segments={[
              { value: 'essentiel', label: 'Essentiel', icon: 'info' },
              { value: 'details', label: 'Détails', icon: 'auto_awesome' },
            ]}
            value={page}
            onChange={(v) => setPage(v as typeof page)}
          />
        )}

        {showDetails ? (
          <>
            {state.id === 'saturn' && state.ringTiltDeg !== null && (
              <DataRow
                icon="ring_volume"
                label="Inclinaison des anneaux"
                value={formatDeg(Math.abs(state.ringTiltDeg), 1)}
                hint={
                  Math.abs(state.ringTiltDeg) < 3 ? 'vus par la tranche' : 'côté ' + (state.ringTiltDeg >= 0 ? 'nord' : 'sud')
                }
              />
            )}
            {state.id === 'moon' && (
              <>
                <DataRow label="Libration en longitude" value={formatDeg(moon.librationLon, 2)} />
                <DataRow label="Libration en latitude" value={formatDeg(moon.librationLat, 2)} />
                <Divider />
                <DataRow
                  icon="dark_mode"
                  label="Prochaine nouvelle lune"
                  value={moon.nextNewMoon.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}
                />
                <DataRow
                  icon="light_mode"
                  label="Prochaine pleine lune"
                  value={moon.nextFullMoon.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}
                />
              </>
            )}
            {nextEvent && (
              <DataRow
                icon="sync_alt"
                label={nextEvent.kind === 'opposition' ? 'Prochaine opposition' : 'Prochaine conjonction inférieure'}
                value={formatDate(nextEvent.date)}
              />
            )}
          </>
        ) : (
          <>
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
            {/* La Lune n'a pas de pastille de magnitude — le cadran de phase en
                tient la place — donc son eclat apparent n'apparaissait nulle part. */}
            {state.id === 'moon' && (
              <DataRow label="Magnitude apparente" value={state.magnitude.toFixed(1).replace('.', ',')} />
            )}
            <DataRow label="Magnitude absolue" value={state.absoluteMagnitude.toFixed(2).replace('.', ',')} />
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
          </>
        )}

        <Button
          variant="tonal"
          icon="center_focus_strong"
          fullWidth
          onClick={() => focusOn(state.horizontal.azimuth, state.horizontal.altitude)}
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
