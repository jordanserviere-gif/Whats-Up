/**
 * Registre des suites de validation du moteur atmospherique.
 *
 * **Chaque couche du moteur ajoute sa suite ici, et une seule ligne.** C'est le
 * seul endroit a modifier pour qu'une nouvelle physique entre dans la campagne
 * — le script d'execution n'a pas a la connaitre.
 *
 * Les suites sont ordonnees comme les phases : une couche n'est validee
 * qu'apres celles dont elle depend, et un echec haut dans la liste explique
 * generalement les suivants.
 */
import { unitsBoundarySuite } from '../core/units.validation'
import {
  blackbodySuite,
  colourMatchingSuite,
  sensorSuite,
  solarSpectrumSuite,
  spectralGridSuite,
} from '../spectral/spectral.validation'
import { rayleighSuite } from '../rayleigh/rayleigh.validation'
import { directSolarSuite, slantPathSuite } from '../transport/directSolar.validation'
import { singleScatteringSuite } from '../transport/singleScattering.validation'
import { multipleScatteringSuite } from '../transport/multipleScattering.validation'
import { ozoneSuite } from '../absorption/ozone.validation'
import { airIndexSuite } from '../refraction/airIndex.validation'
import { rayBendingSuite } from '../refraction/rayBending.validation'
import { rayTracerSuite } from '../field/rayTracer.validation'
import { mirageSuite } from '../field/mirageTransfer.validation'
import { turbulenceSuite } from '../turbulence/turbulence.validation'
import { waveOpticsSuite } from '../wave/wave.validation'
import { scintillationSuite } from '../turbulence/scintillation.validation'
import { calibrationSuite } from '../absorption/ozoneClimatology.validation'
import { airglowSuite } from '../emission/airglow.validation'
import { aerosolSuite, mieSuite } from '../mie/mie.validation'
import { columnLutSuite } from '../lut/transmittanceLut.validation'
import { skyViewLutSuite } from '../lut/skyViewLut.validation'
import { aerialPerspectiveLutSuite } from '../lut/aerialPerspectiveLut.validation'
import { atmosphereStateSuite } from '../state/AtmosphereState.validation'
import { standardAtmosphereSuite } from '../thermodynamics/standardAtmosphere.validation'
import { waterVapourSuite } from '../thermodynamics/waterVapour.validation'
import { displayTransformSuite } from './display.validation'
import { adaptationSuite } from '@/scene/display/adaptation.validation'
import type { SuiteResult } from './harness'

/** Toutes les suites, dans l'ordre des phases. */
export function allSuites(): SuiteResult[] {
  return [
    // Phase 0 — le contrat sur lequel tout repose.
    unitsBoundarySuite(),
    // Phase 1 — etat physique et thermodynamique.
    standardAtmosphereSuite(),
    waterVapourSuite(),
    atmosphereStateSuite(),
    // Phase 2 — base spectrale et colorimetrie.
    spectralGridSuite(),
    colourMatchingSuite(),
    sensorSuite(),
    blackbodySuite(),
    solarSpectrumSuite(),
    // Phase 3 — diffusion moleculaire.
    rayleighSuite(),
    // Phase 0.5 — chaine d'affichage lineaire.
    displayTransformSuite(),
    // Dette : adaptation visuelle — l'exposition suit le ciel.
    adaptationSuite(),
    // Phase 4 — transport direct.
    slantPathSuite(),
    directSolarSuite(),
    // Phase 5 — diffusion simple.
    singleScatteringSuite(),
    // Phase 6 — aerosols et theorie de Mie.
    mieSuite(),
    aerosolSuite(),
    // Phase 7 — absorption.
    ozoneSuite(),
    // Phase 8 — diffusion multiple.
    multipleScatteringSuite(),
    // Phase 10 — indice de refraction de l'air.
    airIndexSuite(),
    // Phase 11 — courbure des rayons.
    rayBendingSuite(),
    // Phase 13 — champ 3D et traceur de rayons.
    rayTracerSuite(),
    // Phase 14 — inversions thermiques et mirages.
    mirageSuite(),
    // Phase 15 — turbulence optique.
    turbulenceSuite(),
    // Phase 16 — optique ondulatoire.
    waveOpticsSuite(),
    // Phase 17 — seeing et scintillation.
    scintillationSuite(),
    // Phase 19 — calage scientifique.
    calibrationSuite(),
    // Dette : socle nocturne — l'airglow devient une emission calculee.
    airglowSuite(),
    // Infrastructure — tables precalculees.
    columnLutSuite(),
    skyViewLutSuite(),
    // Phase 9 — perspective atmospherique sur les objets.
    aerialPerspectiveLutSuite(),
  ]
}
