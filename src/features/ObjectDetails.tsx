import { useMemo } from 'react'
import { Badge, Button, Card, CardBody, CardHeader, DataGrid, DataRow, Divider, StatTile } from '@/ui'
import { NAMED_STARS } from '@/astro/catalog'
import { CONSTELLATIONS } from '@/astro/catalog'
import { DEEP_SKY_INDEX } from '@/astro/deepsky'
import { computeFixedRiseSet } from '@/astro/bodies'
import {
  azimuthToCardinal,
  equatorialToHorizontal,
  formatDeg,
  formatDms,
  formatRa,
  precessFromJ2000,
} from '@/astro/coords'
import { skySurfaceBrightness } from '@/astro/photometry'
import { formatTime } from '@/astro/time'
import { useSkyStore } from '@/state/store'
import { useSimulatedDate, useSkyConditions } from '@/state/hooks'
import type { Equatorial, RiseSetInfo } from '@/astro/types'

/** Nombre a la francaise : virgule decimale, sans exception. */
const fr = (v: number, digits = 1) => v.toFixed(digits).replace('.', ',')

/**
 * Fiche d'un objet fixe : etoile nommee, objet du ciel profond, constellation.
 *
 * Les corps du systeme solaire et les satellites ont leurs propres fiches, plus
 * riches, dans leurs panneaux respectifs. Ici on decrit ce qui ne bouge pas :
 * la position se deduit des coordonnees de catalogue, precessees a la date.
 */
export function FixedObjectDetails({
  kind,
  id,
}: {
  kind: 'star' | 'deepsky' | 'constellation'
  id: string
}) {
  const date = useSimulatedDate()
  const location = useSkyStore((s) => s.location)
  const focusOn = useSkyStore((s) => s.focusOn)
  const sky = useSkyConditions()

  const entry = useMemo(() => resolveFixedObject(kind, id), [kind, id])

  // Le lever et le coucher ne se recalculent qu'a l'heure : ils ne bougent pas
  // a l'echelle d'une image, et la recherche d'evenement coute cher.
  const hour = Math.floor(date.getTime() / 3_600_000)
  const riseSet = useMemo<RiseSetInfo | null>(() => {
    if (!entry) return null
    try {
      return computeFixedRiseSet(entry.equatorialJ2000, new Date(hour * 3_600_000), location)
    } catch {
      return null
    }
  }, [entry, hour, location])

  if (!entry) return null

  const ofDate = precessFromJ2000(entry.equatorialJ2000, date)
  const horizontal = equatorialToHorizontal(ofDate, location, date)
  const above = horizontal.altitude > 0

  return (
    <Card variant="filled" shape="extra-large">
      <CardHeader
        overline={entry.overline}
        title={entry.title}
        subtitle={above ? 'visible au-dessus de l’horizon' : 'sous l’horizon'}
        trailing={
          entry.magnitude !== null ? (
            <Badge tone={above ? 'primary' : 'neutral'}>mag {fr(entry.magnitude)}</Badge>
          ) : undefined
        }
      />
      <CardBody>
        <DataGrid columns={2}>
          <StatTile
            label="Hauteur"
            value={formatDeg(horizontal.altitude, 1)}
            tone={above ? 'primary' : 'neutral'}
            icon="height"
          />
          <StatTile
            label="Azimut"
            value={`${fr(horizontal.azimuth)}°`}
            unit={azimuthToCardinal(horizontal.azimuth)}
            icon="explore"
          />
        </DataGrid>

        <Divider />

        <DataRow label="Ascension droite" value={formatRa(ofDate.ra)} hint="équinoxe de la date" />
        <DataRow label="Déclinaison" value={formatDms(ofDate.dec)} hint="équinoxe de la date" />
        {entry.rows.map((r) => (
          <DataRow key={r.label} label={r.label} value={r.value} unit={r.unit} hint={r.hint} />
        ))}

        {entry.surfaceBrightness !== null && (
          <VisibilityNote objectSb={entry.surfaceBrightness} illuminance={sky.illuminance} />
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
            {riseSet.circumpolar && (
              <Badge tone="secondary" icon="all_inclusive">
                circumpolaire
              </Badge>
            )}
            {riseSet.alwaysBelow && (
              <Badge tone="neutral" icon="visibility_off">
                jamais levé
              </Badge>
            )}
          </>
        )}

        <Button
          variant="tonal"
          icon="center_focus_strong"
          fullWidth
          onClick={() => focusOn(horizontal.azimuth, horizontal.altitude)}
        >
          Centrer dans le ciel
        </Button>
      </CardBody>
    </Card>
  )
}

/**
 * Verdict de visibilite d'un objet etendu.
 *
 * Ce n'est pas la magnitude integree qui decide, mais le contraste entre la
 * brillance de surface de l'objet et celle du fond de ciel : c'est pourquoi M31,
 * de magnitude 3,4, reste invisible a l'oeil nu ailleurs qu'en son coeur.
 */
function VisibilityNote({ objectSb, illuminance }: { objectSb: number; illuminance: number }) {
  const skySb = skySurfaceBrightness(illuminance)
  const contrast = skySb - objectSb
  const verdict =
    contrast > 1.5
      ? 'nettement plus brillant que le fond de ciel'
      : contrast > 0
        ? 'à peine détaché du fond de ciel'
        : 'noyé dans le fond de ciel'

  return (
    <DataRow
      icon="contrast"
      label="Contraste sur le ciel"
      value={`${contrast >= 0 ? '+' : '−'}${fr(Math.abs(contrast))}`}
      unit="mag/arcsec²"
      hint={`Objet à ${fr(objectSb)}, ciel à ${fr(skySb)} mag/arcsec² : ${verdict}.`}
      emphasis={contrast > 1.5}
    />
  )
}

interface FixedObjectEntry {
  overline: string
  title: string
  magnitude: number | null
  equatorialJ2000: Equatorial
  /** Brillance de surface, pour les objets etendus. */
  surfaceBrightness: number | null
  rows: Array<{ label: string; value: string; unit?: string; hint?: string }>
}

function resolveFixedObject(kind: 'star' | 'deepsky' | 'constellation', id: string): FixedObjectEntry | null {
  if (kind === 'star') {
    const index = Number(id.replace('star-', ''))
    const star = NAMED_STARS.find((s) => s.index === index)
    if (!star) return null
    return {
      overline: 'Étoile',
      title: star.name,
      magnitude: star.magnitude,
      equatorialJ2000: { ra: star.ra, dec: star.dec },
      surfaceBrightness: null,
      rows: [{ label: 'Désignation', value: star.designation }],
    }
  }

  if (kind === 'deepsky') {
    const index = Number(id.replace('dso-', ''))
    const o = DEEP_SKY_INDEX[index]
    if (!o) return null
    const rows: FixedObjectEntry['rows'] = [
      { label: 'Type', value: o.typeLabel },
      { label: 'Catalogue', value: o.messier > 0 ? `M${o.messier} · ${o.id}` : o.id },
    ]
    if (o.name) rows.push({ label: 'Nom usuel', value: o.name })
    if (o.majorArcmin > 0) {
      const minor = o.minorArcmin > 0 ? o.minorArcmin : o.majorArcmin
      rows.push({
        label: 'Dimensions',
        value: `${fr(o.majorArcmin)} × ${fr(minor)}`,
        unit: '′',
        hint: 'grand axe × petit axe apparents',
      })
      if (o.positionAngle > 0) {
        rows.push({ label: 'Angle de position', value: `${Math.round(o.positionAngle)}°`, hint: 'depuis le nord' })
      }
    }
    if (o.surfaceBrightness !== null) {
      rows.push({ label: 'Brillance de surface', value: fr(o.surfaceBrightness), unit: 'mag/arcsec²' })
    }
    return {
      overline: 'Ciel profond',
      title: o.messier > 0 ? `M${o.messier}` : o.id,
      magnitude: Number.isFinite(o.magnitude) ? o.magnitude : null,
      equatorialJ2000: { ra: o.ra, dec: o.dec },
      surfaceBrightness: o.surfaceBrightness,
      rows,
    }
  }

  const constellation = CONSTELLATIONS.find((c) => `const-${c.id}` === id)
  if (!constellation) return null
  return {
    overline: 'Constellation',
    title: constellation.name,
    magnitude: null,
    equatorialJ2000: { ra: constellation.labelRa, dec: constellation.labelDec },
    surfaceBrightness: null,
    rows: [
      { label: 'Abréviation', value: constellation.id.toUpperCase() },
      {
        label: 'Repère',
        value: 'centre de la figure',
        hint: 'les coordonnées désignent le point d’étiquetage, pas un objet',
      },
    ],
  }
}
