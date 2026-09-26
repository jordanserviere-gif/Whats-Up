import { useEffect, useState } from 'react'
import { Badge, Button, Card, CardBody, CardHeader, DataGrid, DataRow, Divider, SegmentedButton, StatTile } from '@/ui'
import { azimuthToCardinal, formatDeg } from '@/astro/coords'
import { useSkyStore } from '@/state/store'
import { useNearbyAircraft } from '@/state/hooks'
import { getAircraftHistory } from '@/state/aircraftFeed'
import './AircraftDetail.css'

/** Nombre a la francaise : virgule decimale. */
const fr = (v: number, digits = 0) => v.toFixed(digits).replace('.', ',')

/**
 * Categorie d'emetteur ADS-B (DO-260B table 2-16) : deux caracteres, un jeu
 * (A/B/C) et un rang. Seuls les codes reellement vus dans le flux ont une
 * traduction ; un code absent de la table s'affiche tel quel.
 */
const CATEGORY_LABELS: Record<string, string> = {
  A1: 'avion léger',
  A2: 'avion petit-porteur',
  A3: 'avion moyen-courrier',
  A4: 'avion moyen-courrier, forte turbulence de sillage',
  A5: 'avion gros-porteur',
  A6: 'avion à hautes performances',
  A7: 'hélicoptère',
  B1: 'planeur',
  B2: 'plus léger que l’air',
  B3: 'parachutiste',
  B4: 'ULM',
  B6: 'drone',
  B7: 'véhicule spatial',
  C1: 'véhicule d’urgence',
  C2: 'véhicule de piste',
  C3: 'obstacle fixe',
}

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
  const focusOn = useSkyStore((s) => s.focusOn)
  const { aircraft, live } = useNearbyAircraft()
  const [meta, setMeta] = useState<AdsbdbInfo | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)
  const [page, setPage] = useState<'essentiel' | 'details'>('essentiel')

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
        <CardHeader icon="flight" title="Disponible en direct seulement" />
      </Card>
    )
  }

  if (!state) {
    return (
      <Card variant="outlined" shape="extra-large">
        <CardHeader icon="flight_land" title="Hors de portée" />
      </Card>
    )
  }

  const history = getAircraftHistory(hex)
  const trackedSinceMin = history.length > 1 ? (Date.now() - history[0].time) / 60_000 : 0
  const altitudeFt = state.altitudeFt !== null ? Math.round(state.altitudeFt) : null
  const title = state.flight ?? meta?.registration ?? state.hex.toUpperCase()
  const above = state.horizontal.altitude > 0
  // Constructeur, type et exploitant tiennent sur la ligne sous le titre : pas
  // de surtitre, et la fiche gagne une ligne de tableau.
  const subtitle = [
    [meta?.manufacturer, meta?.type ?? state.typeCode].filter(Boolean).join(' '),
    meta?.owner ?? (state.registration ? `immatriculation ${state.registration}` : `code ${state.hex}`),
  ]
    .filter(Boolean)
    .join(' · ')

  const category = state.category ? (CATEGORY_LABELS[state.category] ?? state.category) : null
  const emergency = state.emergency && state.emergency !== 'none' ? state.emergency : null
  const hasDetails =
    category !== null ||
    state.altitudeGeomFt !== null ||
    state.indicatedSpeedKt !== null ||
    state.trueSpeedKt !== null ||
    state.mach !== null ||
    state.windSpeedKt !== null ||
    state.outsideAirTempC !== null ||
    emergency !== null

  return (
    <Card variant="filled" shape="extra-large">
      <CardHeader
        title={title}
        subtitle={subtitle}
        trailing={
          emergency ? (
            <Badge tone="error" icon="warning">
              urgence
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

        {hasDetails && page === 'details' ? (
          <>
            {category && <DataRow icon="category" label="Catégorie" value={category} />}
            {emergency && <DataRow icon="warning" label="Urgence déclarée" value={emergency} />}
            <DataGrid columns={2}>
              {state.altitudeGeomFt !== null && (
                <DataRow
                  label="Altitude GPS"
                  value={Math.round(state.altitudeGeomFt).toLocaleString('fr-FR')}
                  unit="ft"
                />
              )}
              {state.indicatedSpeedKt !== null && <DataRow label="Vitesse indiquée" value={fr(state.indicatedSpeedKt)} unit="nd" />}
              {state.trueSpeedKt !== null && <DataRow label="Vitesse vraie" value={fr(state.trueSpeedKt)} unit="nd" />}
              {state.mach !== null && <DataRow label="Mach" value={state.mach.toFixed(2).replace('.', ',')} />}
              {state.windSpeedKt !== null && (
                <DataRow
                  label="Vent estimé"
                  value={fr(state.windSpeedKt)}
                  unit="nd"
                  hint={state.windDirDeg !== null ? `venant du ${Math.round(state.windDirDeg)}°` : undefined}
                />
              )}
              {state.outsideAirTempC !== null && (
                <DataRow label="Température extérieure" value={`${state.outsideAirTempC > 0 ? '+' : ''}${fr(state.outsideAirTempC)}`} unit="°C" />
              )}
            </DataGrid>
          </>
        ) : (
          <>
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

            {/* Ni indicatif ni constructeur ici : le premier est le titre de la
                fiche, le second son surtitre. Le reste tient sur deux colonnes —
                ce sont des valeurs courtes, une pleine largeur chacune gaspillait
                la moitie de la ligne. */}
            <Divider />
            {/* En pleine ligne comme le reste, pas dans une pastille de l'en-tete :
                l'altitude n'a rien de plus important que la route ou le vario. */}
            <DataGrid columns={2}>
              <DataRow label="Altitude" value={altitudeFt !== null ? altitudeFt.toLocaleString('fr-FR') : '—'} unit="ft" />
              <DataRow label="Immat." value={meta?.registration ?? state.registration ?? '—'} />
              <DataRow label="Route" value={state.trackDeg !== null ? `${Math.round(state.trackDeg)}°` : '—'} />
              <DataRow
                label="Vario"
                value={state.verticalRateFtMin !== null ? `${state.verticalRateFtMin > 0 ? '+' : ''}${state.verticalRateFtMin}` : '—'}
                unit="ft/min"
              />
              {state.squawk && <DataRow label="Squawk" value={state.squawk} />}
            </DataGrid>

            <Divider />
            <DataRow
              icon="timeline"
              label="Trace suivie"
              value={history.length > 1 ? `${history.length} points` : 'pas encore assez de points'}
              unit={history.length > 1 ? (trackedSinceMin < 1 ? 'depuis moins d’une minute' : `depuis ${Math.round(trackedSinceMin)} min`) : undefined}
            />
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
