import { useEffect, useState } from 'react'
import { Badge, Button, Card, CardBody, CardHeader, DataGrid, DataRow, Divider, StatTile } from '@/ui'
import { azimuthToCardinal, formatDeg } from '@/astro/coords'
import { useSkyStore } from '@/state/store'
import { useNearbyAircraft } from '@/state/hooks'
import { getAircraftHistory } from '@/state/aircraftFeed'
import './AircraftDetail.css'

/** Nombre a la francaise : virgule decimale. */
const fr = (v: number, digits = 0) => v.toFixed(digits).replace('.', ',')

interface AdsbdbInfo {
  registration: string | null
  type: string | null
  manufacturer: string | null
  owner: string | null
  photoUrl: string | null
}

/**
 * Metadonnees statiques d'un appareil — immatriculation, type, photo.
 *
 * adsbdb.com est la seule source testee qui ouvre son CORS a ce site (voir
 * `corsRelay.ts` pour ce qui ne l'ouvre pas) : elle sert de proxy officieux vers
 * les photos de planespotters.net, lesquelles rejettent tout appel direct
 * depuis un navigateur faute de pouvoir y fixer un en-tete `User-Agent`
 * descriptif — un en-tete que le navigateur, justement, ne laisse jamais
 * surcharger.
 *
 * Un memoire de process suffit : l'identite d'un avion (immatriculation,
 * type, photo) ne change pas pendant une session, inutile de la refaire tenir
 * dans le cache IndexedDB partage avec les sources temporelles.
 */
const metaCache = new Map<string, AdsbdbInfo | null>()

async function fetchAdsbdbInfo(hex: string): Promise<AdsbdbInfo | null> {
  try {
    const res = await fetch(`https://api.adsbdb.com/v0/aircraft/${hex}`)
    if (!res.ok) return null
    const json = (await res.json()) as {
      response?: {
        aircraft?: {
          registration?: string
          type?: string
          manufacturer?: string
          registered_owner?: string
          url_photo?: string | null
        }
      }
    }
    const a = json.response?.aircraft
    if (!a) return null
    return {
      registration: a.registration ?? null,
      type: a.type ?? null,
      manufacturer: a.manufacturer ?? null,
      owner: a.registered_owner ?? null,
      photoUrl: a.url_photo ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Fiche d'un avion designe.
 *
 * La trace affichee n'est pas historique : aucune source gratuite n'en fournit.
 * C'est l'observation accumulee depuis que l'appareil est suivi ici, et la
 * fiche le dit plutot que de laisser croire a un vrai historique de vol.
 */
export function AircraftDetail() {
  const hex = useSkyStore((s) => s.selectedAircraftHex)
  const lookAt = useSkyStore((s) => s.lookAt)
  const { aircraft, live } = useNearbyAircraft()
  const [meta, setMeta] = useState<AdsbdbInfo | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)

  const state = aircraft.find((a) => a.hex === hex) ?? null

  useEffect(() => {
    if (!hex) {
      setMeta(null)
      return
    }
    const cached = metaCache.get(hex)
    if (cached !== undefined) {
      setMeta(cached)
      return
    }
    let cancelled = false
    setMetaLoading(true)
    fetchAdsbdbInfo(hex).then((info) => {
      metaCache.set(hex, info)
      if (!cancelled) {
        setMeta(info)
        setMetaLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [hex])

  if (!hex) return null

  if (!live) {
    return (
      <Card variant="outlined" shape="extra-large">
        <CardHeader
          icon="flight"
          overline="Avion"
          title="Disponible en direct seulement"
          subtitle="L’ADS-B n’a pas d’archive gratuite : revenez à l’instant présent pour suivre cet appareil"
        />
      </Card>
    )
  }

  if (!state) {
    return (
      <Card variant="outlined" shape="extra-large">
        <CardHeader icon="flight_land" overline="Avion" title="Hors de portée" subtitle="Sorti du rayon suivi ou disparu du flux" />
      </Card>
    )
  }

  const history = getAircraftHistory(hex)
  const trackedSinceMin = history.length > 1 ? (Date.now() - history[0].time) / 60_000 : 0
  const altitudeFt = state.altitudeFt !== null ? Math.round(state.altitudeFt) : null
  const title = state.flight ?? meta?.registration ?? state.hex.toUpperCase()
  const above = state.horizontal.altitude > 0

  return (
    <Card variant="filled" shape="extra-large">
      <CardHeader
        overline={meta?.type ?? state.typeCode ?? 'Avion'}
        title={title}
        subtitle={meta?.owner ?? (state.registration ? `immatriculation ${state.registration}` : `code ${state.hex}`)}
        trailing={
          altitudeFt !== null ? (
            <Badge tone={above ? 'primary' : 'neutral'} icon="height">
              {altitudeFt.toLocaleString('fr-FR')} ft
            </Badge>
          ) : undefined
        }
      />
      <CardBody>
        {meta?.photoUrl && (
          <img
            className="aircraft-detail__photo"
            src={meta.photoUrl}
            alt={title}
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        )}
        {metaLoading && <p className="md-type-body-small aircraft-detail__note">Recherche des informations de l’appareil…</p>}

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
          <StatTile
            label="Vitesse"
            value={state.groundSpeedKt !== null ? fr(state.groundSpeedKt) : '—'}
            unit="nd"
            icon="speed"
          />
          <StatTile label="Distance" value={fr(state.rangeKm)} unit="km" icon="straighten" />
        </DataGrid>

        <Divider />
        <DataRow label="Indicatif" value={state.flight ?? '—'} />
        <DataRow label="Immatriculation" value={meta?.registration ?? state.registration ?? '—'} />
        <DataRow label="Constructeur" value={meta?.manufacturer ?? '—'} />
        <DataRow
          label="Vitesse verticale"
          value={state.verticalRateFtMin !== null ? `${state.verticalRateFtMin > 0 ? '+' : ''}${state.verticalRateFtMin}` : '—'}
          unit="ft/min"
        />
        <DataRow label="Route" value={state.trackDeg !== null ? `${Math.round(state.trackDeg)}°` : '—'} />
        {state.squawk && <DataRow label="Squawk" value={state.squawk} />}

        <Divider />
        <DataRow
          icon="timeline"
          label="Trace suivie"
          value={history.length > 1 ? `${history.length} points` : 'pas encore assez de points'}
          unit={history.length > 1 ? (trackedSinceMin < 1 ? 'depuis moins d’une minute' : `depuis ${Math.round(trackedSinceMin)} min`) : undefined}
          hint="Aucune API gratuite ne fournit d’historique de vol : cette trace n’existe que depuis que l’appareil est observé ici, pas avant."
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
