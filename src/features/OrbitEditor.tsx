import { useState } from 'react'
import { Badge, Button, DataGrid, DataRow, Divider, SegmentedButton, Section, Select, StatTile, Switch, TextField } from '@/ui'
import {
  ORBIT_PRESETS,
  apogeeAltitude,
  meanMotionRevPerDay,
  orbitalPeriod,
  perigeeAltitude,
  semiMajorAxisFromMeanMotion,
} from '@/astro/kepler'
import { EARTH_RADIUS_KM } from '@/astro/coords'
import { formatDuration, toDateTimeLocalValue } from '@/astro/time'
import type { OrbitalElements } from '@/astro/types'
import './OrbitEditor.css'

/** Saisie du demi-grand axe : directement, ou via le mouvement moyen. */
type SizeMode = 'sma' | 'meanMotion' | 'altitude'

export interface OrbitEditorProps {
  element: OrbitalElements
  onChange: (patch: Partial<OrbitalElements>) => void
  onRemove: () => void
}

const TRACK_COLORS = ['#7fd6ff', '#9ef0a8', '#ffd24a', '#ff9d5c', '#d5bcf4', '#ff7a9c']

/**
 * Editeur d'elements orbitaux keplerians.
 *
 * Les trois facons de decrire la taille de l'orbite (demi-grand axe, mouvement
 * moyen, altitude circulaire) sont converties entre elles a la saisie : on
 * entre la grandeur que l'on connait, pas celle qu'exige le modele.
 */
export function OrbitEditor({ element, onChange, onRemove }: OrbitEditorProps) {
  const [sizeMode, setSizeMode] = useState<SizeMode>('sma')

  const a = element.semiMajorAxisKm
  const e = element.eccentricity
  const period = orbitalPeriod(a)
  const perigee = perigeeAltitude(a, e)
  const apogee = apogeeAltitude(a, e)
  const invalid = perigee < 0 || e < 0 || e >= 1 || a <= EARTH_RADIUS_KM

  const applyPreset = (name: string) => {
    const preset = ORBIT_PRESETS.find((p) => p.name === name)
    if (!preset) return
    const { description: _description, ...rest } = preset
    onChange({ ...rest, epoch: new Date().toISOString() })
  }

  return (
    <div className="orbit-editor">
      <Select
        label="Orbite de référence"
        leadingIcon="bookmark"
        value=""
        options={[
          { value: '', label: 'Charger un modèle…' },
          ...ORBIT_PRESETS.map((p) => ({ value: p.name, label: p.name })),
        ]}
        onChange={applyPreset}
        supportingText="Remplace tous les éléments par des valeurs typiques"
      />

      <TextField
        label="Nom"
        value={element.name}
        leadingIcon="satellite_alt"
        onChange={(ev) => onChange({ name: ev.target.value })}
      />

      <Section title="Taille et forme" icon="donut_large" defaultOpen>
        <SegmentedButton
          ariaLabel="Mode de saisie de la taille de l’orbite"
          fullWidth
          segments={[
            { value: 'sma', label: 'Demi-grand axe' },
            { value: 'meanMotion', label: 'Mouvement moyen' },
            { value: 'altitude', label: 'Altitude' },
          ]}
          value={sizeMode}
          onChange={setSizeMode}
        />

        {sizeMode === 'sma' && (
          <TextField
            label="Demi-grand axe (a)"
            type="number"
            numeric
            step="1"
            suffix="km"
            value={a.toFixed(1)}
            errorText={a <= EARTH_RADIUS_KM ? 'Doit dépasser le rayon terrestre (6 378 km)' : undefined}
            supportingText="Distance moyenne au centre de la Terre"
            onChange={(ev) => onChange({ semiMajorAxisKm: Number(ev.target.value) })}
          />
        )}
        {sizeMode === 'meanMotion' && (
          <TextField
            label="Mouvement moyen (n)"
            type="number"
            numeric
            step="0.0001"
            suffix="tours/j"
            value={meanMotionRevPerDay(a).toFixed(6)}
            supportingText="Champ n des TLE, ligne 2"
            onChange={(ev) => {
              const n = Number(ev.target.value)
              if (n > 0) onChange({ semiMajorAxisKm: semiMajorAxisFromMeanMotion(n) })
            }}
          />
        )}
        {sizeMode === 'altitude' && (
          <TextField
            label="Altitude circulaire"
            type="number"
            numeric
            step="1"
            suffix="km"
            value={(a - EARTH_RADIUS_KM).toFixed(1)}
            supportingText="Au-dessus du rayon équatorial"
            onChange={(ev) => onChange({ semiMajorAxisKm: Number(ev.target.value) + EARTH_RADIUS_KM })}
          />
        )}

        <TextField
          label="Excentricité (e)"
          type="number"
          numeric
          step="0.0001"
          min="0"
          max="0.95"
          value={e.toFixed(6)}
          errorText={e < 0 || e >= 1 ? 'Doit rester entre 0 et 1' : undefined}
          supportingText="0 = cercle, proche de 1 = ellipse très allongée"
          onChange={(ev) => onChange({ eccentricity: Number(ev.target.value) })}
        />
      </Section>

      <Section title="Orientation du plan" icon="3d_rotation" defaultOpen>
        <TextField
          label="Inclinaison (i)"
          type="number"
          numeric
          step="0.01"
          suffix="°"
          value={element.inclination.toFixed(4)}
          supportingText="0° = équatorial, 90° = polaire, > 90° = rétrograde"
          onChange={(ev) => onChange({ inclination: Number(ev.target.value) })}
        />
        <TextField
          label="Longitude du nœud ascendant (Ω)"
          type="number"
          numeric
          step="0.01"
          suffix="°"
          value={element.raan.toFixed(4)}
          supportingText="Orientation du plan autour de l’axe des pôles"
          onChange={(ev) => onChange({ raan: Number(ev.target.value) })}
        />
        <TextField
          label="Argument du périgée (ω)"
          type="number"
          numeric
          step="0.01"
          suffix="°"
          value={element.argPerigee.toFixed(4)}
          supportingText="Position du point le plus bas dans le plan"
          onChange={(ev) => onChange({ argPerigee: Number(ev.target.value) })}
        />
      </Section>

      <Section title="Position à l’époque" icon="schedule" defaultOpen>
        <TextField
          label="Anomalie moyenne (M)"
          type="number"
          numeric
          step="0.01"
          suffix="°"
          value={element.meanAnomaly.toFixed(4)}
          supportingText="Où se trouve le satellite sur son orbite à l’époque"
          onChange={(ev) => onChange({ meanAnomaly: Number(ev.target.value) })}
        />
        <TextField
          label="Époque des éléments"
          type="datetime-local"
          value={toDateTimeLocalValue(new Date(element.epoch))}
          onChange={(ev) => {
            const parsed = new Date(ev.target.value)
            if (!Number.isNaN(parsed.getTime())) onChange({ epoch: parsed.toISOString() })
          }}
        />
        <Button variant="text" icon="update" onClick={() => onChange({ epoch: new Date().toISOString() })}>
          Caler l’époque sur maintenant
        </Button>
      </Section>

      <Section title="Modèle et affichage" icon="tune" defaultOpen={false} summary={element.useJ2 ? 'J2 activé' : 'Kepler pur'}>
        <Switch
          label="Perturbations J2"
          supportingText="Dérive du nœud et du périgée dues à l’aplatissement terrestre"
          checked={element.useJ2}
          onChange={(v) => onChange({ useJ2: v })}
        />
        <div className="orbit-editor__colors" role="radiogroup" aria-label="Couleur de la trace">
          {TRACK_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={element.color === c}
              aria-label={`Couleur ${c}`}
              className={`orbit-editor__color${element.color === c ? ' is-selected' : ''}`}
              style={{ background: c }}
              onClick={() => onChange({ color: c })}
            />
          ))}
        </div>
      </Section>

      <Divider />

      <DataGrid columns={2}>
        <StatTile label="Période" value={formatDuration(period)} icon="rotate_right" tone="secondary" />
        <StatTile label="Tours/jour" value={meanMotionRevPerDay(a).toFixed(2).replace('.', ',')} icon="repeat" />
      </DataGrid>
      <DataRow label="Altitude au périgée" value={perigee.toFixed(0)} unit="km" emphasis={perigee < 0} />
      <DataRow label="Altitude à l’apogée" value={apogee.toFixed(0)} unit="km" />
      {invalid && (
        <Badge tone="error" icon="warning">
          Orbite impossible : le périgée passe sous la surface
        </Badge>
      )}

      <Button variant="text" icon="delete" onClick={onRemove} className="orbit-editor__delete">
        Supprimer ce satellite
      </Button>
    </div>
  )
}
