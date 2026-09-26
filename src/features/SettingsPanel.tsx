import { useState } from 'react'
import {
  Button,
  DataRow,
  Divider,
  IconButton,
  List,
  ListItem,
  SegmentedButton,
  Section,
  Slider,
  Switch,
  TextField,
  useSnackbar,
  useTheme,
} from '@/ui'
import { sameSite, useSkyStore, type LayerVisibility } from '@/state/store'
import { cx } from '@/ui/utils'
import type { GeoLocation } from '@/astro/types'
import { useSkyConditions } from '@/state/hooks'
import { bortleLabel, bortleSkyBrightness } from '@/astro/photometry'
import { formatAge } from '@/data-sources/types'
import { DEEP_SKY_COUNT } from '@/astro/deepsky'
import './SettingsPanel.css'
import { STAR_COUNT, STAR_MAG_LIMIT } from '@/astro/catalog'
import { localTimeZone } from '@/astro/time'
import { horizonDipDeg } from '@/atmosphere/refraction/rayBending'
import { horizonRangeM } from '@/scene/terrain/ridgeField'
import { LocationMap } from './LocationMap'

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
  {
    key: 'terrain',
    label: 'Banc atmosphère — relief',
    hint: 'une chaîne à 15 km à l’est, longue de 600 : la distance seule y varie',
  },
]

/** Reglages : lieu d'observation, calques, apparence. */
const THEME_SUMMARY = { light: 'clair', dark: 'sombre', night: 'night' } as const

export function SettingsPanel() {
  const location = useSkyStore((s) => s.location)
  const setLocation = useSkyStore((s) => s.setLocation)
  const elevationOffsetM = useSkyStore((s) => s.elevationOffsetM)
  const setElevationOffsetM = useSkyStore((s) => s.setElevationOffsetM)
  const layers = useSkyStore((s) => s.layers)
  const setLayer = useSkyStore((s) => s.setLayer)
  const magnitudeLimit = useSkyStore((s) => s.magnitudeLimit)
  const setMagnitudeLimit = useSkyStore((s) => s.setMagnitudeLimit)
  const discScale = useSkyStore((s) => s.discScale)
  const setDiscScale = useSkyStore((s) => s.setDiscScale)
  const lightPollution = useSkyStore((s) => s.lightPollution)
  const setLightPollution = useSkyStore((s) => s.setLightPollution)
  const lightPollutionAuto = useSkyStore((s) => s.lightPollutionAuto)
  const setLightPollutionAuto = useSkyStore((s) => s.setLightPollutionAuto)
  const autoLightPollutionStatus = useSkyStore((s) => s.autoLightPollutionStatus)
  const measuredSkyBrightness = useSkyStore((s) => s.measuredSkyBrightness)
  const aerosolTurbidity = useSkyStore((s) => s.aerosolTurbidity)
  const setAerosolTurbidity = useSkyStore((s) => s.setAerosolTurbidity)
  const aerosolAuto = useSkyStore((s) => s.aerosolAuto)
  const setAerosolAuto = useSkyStore((s) => s.setAerosolAuto)
  const autoAerosolStatus = useSkyStore((s) => s.autoAerosolStatus)
  const sky = useSkyConditions()
  const { mode, setMode } = useTheme()
  const { show } = useSnackbar()
  const [locating, setLocating] = useState(false)
  const [placeTab, setPlaceTab] = useState<'map' | 'favorites'>('map')
  const favorites = useSkyStore((s) => s.favorites)
  const toggleFavorite = useSkyStore((s) => s.toggleFavorite)

  /**
   * Lieu propose, pas encore applique.
   *
   * Changer de lieu reconstruit tout le ciel et, avec le relief, telecharge des
   * dizaines de megaoctets : chaque saisie, chaque clic sur la carte ne fait
   * donc que remplir ce brouillon, et rien ne part avant « Valider ».
   */
  const [draft, setDraft] = useState<GeoLocation | null>(null)
  const shown = draft ?? location
  const propose = (next: Partial<GeoLocation>) => setDraft({ ...shown, ...next })
  const pending =
    draft !== null &&
    (draft.latitude !== location.latitude ||
      draft.longitude !== location.longitude ||
      draft.elevation !== location.elevation ||
      draft.name !== location.name)

  const validate = () => {
    if (!draft) return
    setLocation(draft)
    setDraft(null)
    show(`Lieu d’observation : ${draft.name}`)
  }

  const useMyPosition = () => {
    if (!navigator.geolocation) {
      show('La géolocalisation n’est pas disponible dans ce navigateur')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        propose({
          name: 'Position actuelle',
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          elevation: pos.coords.altitude ?? shown.elevation,
        })
        setLocating(false)
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
        <SegmentedButton
          ariaLabel="Choisir le lieu"
          fullWidth
          segments={[
            { value: 'map', label: 'Carte', icon: 'map' },
            { value: 'favorites', label: 'Favoris', icon: 'star' },
          ]}
          value={placeTab}
          onChange={setPlaceTab}
        />

        {placeTab === 'map' ? (
          <LocationMap
            latitudeDeg={shown.latitude}
            longitudeDeg={shown.longitude}
            onPick={(latitude, longitude, name) => propose({ name: name ?? 'Lieu choisi sur la carte', latitude, longitude })}
          />
        ) : favorites.length > 0 ? (
          <List className="settings-location__favorites">
            {favorites.map((f) => (
              <ListItem
                key={`${f.latitude},${f.longitude}`}
                headline={f.name}
                supportingText={`${f.latitude.toFixed(3).replace('.', ',')}° · ${f.longitude.toFixed(3).replace('.', ',')}° · ${Math.round(f.elevation)} m`}
                leadingIcon="star"
                selected={sameSite(f, shown)}
                onClick={() => setDraft(f)}
                trailing={
                  <IconButton icon="close" label={`Retirer ${f.name} des favoris`} onClick={() => toggleFavorite(f)} />
                }
              />
            ))}
          </List>
        ) : (
          <p className="md-type-body-small">Aucun favori : ajoutez un lieu depuis la carte avec l’étoile.</p>
        )}

        <div className={cx('settings-location__confirm', !pending && 'is-current')} role="group" aria-label="Lieu proposé">
          <div className="settings-location__place">
            <p className="md-type-body-medium">
              {pending ? 'Nouveau lieu' : 'Lieu actuel'} : <strong>{shown.name}</strong>
              <span className="md-type-body-small md-numeric settings-location__coords">
                {shown.latitude.toFixed(4).replace('.', ',')}° · {shown.longitude.toFixed(4).replace('.', ',')}°
              </span>
            </p>
            <IconButton
              icon="star"
              selectedIcon="star"
              selected={favorites.some((f) => sameSite(f, shown))}
              label={favorites.some((f) => sameSite(f, shown)) ? 'Retirer des favoris' : 'Ajouter aux favoris'}
              onClick={() => toggleFavorite(shown)}
            />
          </div>
          {pending && (
            <div className="settings-location__actions">
              <Button variant="text" onClick={() => setDraft(null)}>
                Annuler
              </Button>
              <Button variant="filled" icon="check" onClick={validate}>
                Valider ce lieu
              </Button>
            </div>
          )}
        </div>

        <Button variant="outlined" icon="my_location" fullWidth disabled={locating} onClick={useMyPosition}>
          {locating ? 'Localisation…' : 'Utiliser ma position'}
        </Button>

        <TextField
          label="Altitude du sol"
          type="number"
          numeric
          step="1"
          suffix="m"
          value={shown.elevation.toFixed(0)}
          onChange={(e) => propose({ elevation: Number(e.target.value) })}
        />
        <TextField
          label="Hauteur au-dessus du sol"
          type="number"
          numeric
          step="10"
          suffix="m"
          value={elevationOffsetM.toFixed(0)}
          onChange={(e) => setElevationOffsetM(Math.max(0, Number(e.target.value)))}
        />
        <p className="md-type-body-small">
          {elevationOffsetM > 0
            ? `Horizon abaisse de ${horizonDipDeg(location.elevation + elevationOffsetM).toFixed(2).replace('.', ',')}° — le relief visible porte jusqu'a ${Math.round(horizonRangeM(4000, location.elevation + elevationOffsetM, 7_669_000) / 1000)} km sur un sommet de 4000 m.`
            : `L'altitude du sol est relue sur le modele numerique de terrain des que celui-ci est charge ; la hauteur ci-dessus s'y ajoute.`}
        </p>
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

      <Section
        title="Conditions du site"
        icon="foggy"
        defaultOpen={false}
        summary={
          lightPollution <= 1 && aerosolTurbidity === 1
            ? 'ciel naturel'
            : `Bortle ${Math.round(lightPollution)} · trouble ×${aerosolTurbidity.toFixed(1).replace('.', ',')}`
        }
      >
        <Switch
          label="Pollution lumineuse automatique"
          supportingText="Mesurée au lieu d’observation (Light Pollution Atlas, VIIRS)"
          checked={lightPollutionAuto}
          onChange={setLightPollutionAuto}
        />

        <Slider
          label="Pollution lumineuse"
          min={1}
          max={9}
          step={1}
          value={lightPollution}
          showValue
          disabled={lightPollutionAuto}
          format={(v) => `Bortle ${Math.round(v)} · ${bortleLabel(v)}`}
          onChange={setLightPollution}
        />
        {lightPollutionAuto && (
          <DataRow
            icon="cloud_download"
            label="Source"
            value={autoLightPollutionStatus.origin}
            unit={autoLightPollutionStatus.ageMs !== null ? formatAge(autoLightPollutionStatus.ageMs) : undefined}
            hint={
              autoLightPollutionStatus.note ??
              'Atlas annuel dérivé des observations VIIRS, calibré sur le World Atlas de Falchi et al. (2016).'
            }
          />
        )}
        <p className="md-type-body-small">
          Échelle de Bortle, ancrée sur la brillance réelle du fond de ciel :{' '}
          {(measuredSkyBrightness ?? bortleSkyBrightness(lightPollution)).toFixed(1).replace('.', ',')}{' '}
          mag/arcsec² au zénith{measuredSkyBrightness !== null ? ' (mesuré)' : ''}. La valeur entre dans
          le bilan lumineux comme une source de plus, au même titre que la Lune — elle recule donc la
          magnitude limite, efface les objets étendus et éclaircit le ciel d’elle-même, surtout vers
          l’horizon d’où monte le halo urbain. Magnitude limite actuelle :{' '}
          {sky.limitingMagnitude.toFixed(1).replace('.', ',')}.
        </p>

        <Divider />

        <Switch
          label="Trouble automatique"
          supportingText="Mesuré depuis la qualité de l’air au lieu d’observation (Open-Meteo)"
          checked={aerosolAuto}
          onChange={setAerosolAuto}
        />

        <Slider
          label="Trouble atmosphérique"
          min={0.5}
          max={6}
          step={0.1}
          value={aerosolTurbidity}
          showValue
          disabled={aerosolAuto}
          format={(v) => `× ${v.toFixed(1).replace('.', ',')}`}
          onChange={setAerosolTurbidity}
        />
        {aerosolAuto && (
          <DataRow
            icon="cloud_download"
            label="Source"
            value={autoAerosolStatus.origin}
            unit={autoAerosolStatus.ageMs !== null ? formatAge(autoAerosolStatus.ageMs) : undefined}
            hint={autoAerosolStatus.note ?? 'Particules fines (PM2,5) au sol, rafraîchies toutes les trente minutes.'}
          />
        )}
        <p className="md-type-body-small">
          Charge en aérosols — poussière, humidité, particules fines — qui pilote la diffusion de Mie.
          Ces particules restent confinées dans le premier kilomètre d’atmosphère : vers l’horizon, le
          regard en traverse plusieurs dizaines de fois plus qu’au zénith. C’est donc là que la brume se
          voit, grisant le bas du ciel, resserrant le halo solaire et éteignant les astres rasants, tandis
          que le haut du ciel garde son bleu. À ×1, le modèle décrit un air très pur ; en montant, le bas
          du ciel blanchit d’abord, le reste ensuite. Le réglage vaut pour toutes les couches à la fois —
          fond de ciel, disques planétaires, étoiles, silhouettes d’avions — chacune selon la hauteur à
          laquelle on la regarde. En mode automatique, il suit la concentration en particules fines
          (PM2,5) mesurée au lieu d’observation ; le curseur redevient manuel dès qu’il est désactivé.
        </p>
      </Section>

      <Section title="Apparence" icon="palette" defaultOpen={false} summary={THEME_SUMMARY[mode]}>
        <SegmentedButton
          ariaLabel="Thème de l’interface"
          fullWidth
          segments={[
            { value: 'light', label: 'Clair', icon: 'light_mode' },
            { value: 'dark', label: 'Sombre', icon: 'dark_mode' },
            { value: 'night', label: 'Night', icon: 'nightlight' },
          ]}
          value={mode}
          onChange={setMode}
        />
      </Section>

      <SourcesSection />
    </>
  )
}

/**
 * Sources et attributions.
 *
 * Les cartes de surface sont sous licence CC BY 4.0 : les créditer n'est pas
 * une politesse mais une condition d'usage, et elle doit être visible dans
 * l'application, pas seulement dans le dépôt.
 */
function SourcesSection() {
  return (
    <Section title="Sources et licences" icon="menu_book" defaultOpen={false} summary="crédits">
      <DataRow label="Éphémérides" value="astronomy-engine" />
      <DataRow label="Étoiles" value={`HYG v4.1 · ${STAR_COUNT.toLocaleString('fr-FR')}`} />
      <DataRow label="Ciel profond" value={`OpenNGC · ${DEEP_SKY_COUNT.toLocaleString('fr-FR')}`} />
      <DataRow label="Figures" value="d3-celestial" />
      <Divider />
      <p className="md-type-body-small">
        Cartes de surface des planètes et de la Lune :{' '}
        <a className="settings__link" href="https://www.solarsystemscope.com/textures/" target="_blank" rel="noreferrer">
          Solar System Scope
        </a>
        , sous licence{' '}
        <a className="settings__link" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
          CC BY 4.0
        </a>
        . Elles sont redimensionnées mais non modifiées.
      </p>
      <p className="md-type-body-small">
        Catalogue OpenNGC de Mattia Verga, sous CC BY-SA 4.0. Base HYG d’Astronexus, sous CC BY-SA 2.5.
      </p>
    </Section>
  )
}
