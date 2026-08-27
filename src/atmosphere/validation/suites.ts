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
import { aerosolSuite, mieSuite } from '../mie/mie.validation'
import { columnLutSuite } from '../lut/transmittanceLut.validation'
import { skyViewLutSuite } from '../lut/skyViewLut.validation'
import { aerialPerspectiveLutSuite } from '../lut/aerialPerspectiveLut.validation'
import { atmosphereStateSuite } from '../state/AtmosphereState.validation'
import { standardAtmosphereSuite } from '../thermodynamics/standardAtmosphere.validation'
import { waterVapourSuite } from '../thermodynamics/waterVapour.validation'
import { displayTransformSuite } from './display.validation'
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
    // Infrastructure — tables precalculees.
    columnLutSuite(),
    skyViewLutSuite(),
    // Phase 9 — perspective atmospherique sur les objets.
    aerialPerspectiveLutSuite(),
  ]
}
