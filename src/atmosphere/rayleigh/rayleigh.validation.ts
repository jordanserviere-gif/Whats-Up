/**
 * Validation de la diffusion Rayleigh — phase 3.
 *
 * L'ancre principale est l'**epaisseur optique zenithale a 550 nm**, que la
 * litterature donne a 0,0973 au niveau de la mer. Elle met en jeu, d'un seul
 * coup, l'indice de refraction, le facteur de King, la section efficace et le
 * profil de densite de la phase 1 : si elle tombe juste, c'est que toute la
 * chaine tombe juste.
 *
 * S'y ajoutent trois controles qui ne demandent aucune donnee exterieure :
 *
 * - la **normalisation de la fonction de phase**, integree numeriquement sur la
 *   sphere ;
 * - la **colonne moleculaire**, qui doit egaler `P₀/(m·g₀)` par simple
 *   equilibre hydrostatique — recoupement direct entre les phases 1 et 3 ;
 * - la **cible posee en phase 2** : 90,2 % de transmission zenithale, deduite de
 *   l'ecart entre l'eclairement solaire hors atmosphere et les 120 klx au sol
 *   de `astro/photometry.ts`. Elle a ete ecrite **avant** ce module.
 */
import { BOLTZMANN, DRY_AIR_MOLAR_MASS, STANDARD_GRAVITY, AVOGADRO } from '../core/constants'
import { suite, type SuiteResult } from '../validation/harness'
import { uniformSpectralGrid } from '../spectral/SpectralGrid'
import { solarIrradianceOn } from '../spectral/SolarSpectrum'
import { luminance } from '../spectral/SpectralSensor'
import { standardProfile } from '../thermodynamics/standardAtmosphere'
import {
  STANDARD_AIR_NUMBER_DENSITY,
  depolarizationRatio,
  kingFactor,
  standardAirRefractiveIndex,
} from './standardAir'
import {
  idealRayleighPhaseFunction,
  molecularColumnAbove,
  rayleighCoefficientAtAltitude,
  rayleighCrossSection,
  rayleighOpticalDepth,
  rayleighPhaseFunction,
  rayleighScatteringCoefficient,
  rayleighTransmittanceOn,
} from './rayleigh'

/**
 * Integrale d'une fonction de phase sur toute la sphere.
 *
 * `∮ p(θ) dΩ = 2π ∫₋₁¹ p(μ) dμ`. Simpson sur µ, qui est exact ici : la fonction
 * de phase est un polynome de degre 2 en µ.
 */
function integrateOverSphere(p: (cosTheta: number) => number, steps = 2000): number {
  const h = 2 / steps
  let sum = 0
  for (let i = 0; i < steps; i++) {
    const a = -1 + i * h
    sum += (h / 6) * (p(a) + 4 * p(a + h / 2) + p(a + h))
  }
  return 2 * Math.PI * sum
}

export function rayleighSuite(): SuiteResult {
  return suite(
    'Diffusion Rayleigh (phase 3)',
    { reference: 'Bodhaine et al. (1999), J. Atmos. Oceanic Technol. 16, 1854 ; Peck & Reeder (1972)' },
    (t) => {
      // --- Indice de refraction de l'air standard ---------------------------
      const n550 = standardAirRefractiveIndex(550)
      t.checkRelative('n(550 nm) − 1 de l’air standard', n550 - 1, 2.7782e-4, 1e-3)
      t.checkTrue(
        'l’air est plus refringent dans le bleu',
        standardAirRefractiveIndex(400) > standardAirRefractiveIndex(700),
        `n(400) − 1 = ${((standardAirRefractiveIndex(400) - 1) * 1e6).toFixed(2)}·10⁻⁶ · ` +
          `n(700) − 1 = ${((standardAirRefractiveIndex(700) - 1) * 1e6).toFixed(2)}·10⁻⁶ — ` +
          `c’est de la que sortira la dispersion de la refraction (phase 11)`,
      )
      const dispersion: number[] = []
      for (let l = 380; l <= 780; l += 20) dispersion.push(standardAirRefractiveIndex(l))
      t.checkMonotonic('n decroit avec la longueur d’onde', dispersion, 'decroissant')

      // Une teneur en CO₂ plus forte rend l'air legerement plus refringent.
      t.checkTrue(
        'le CO₂ augmente l’indice',
        standardAirRefractiveIndex(550, 420e-6) > standardAirRefractiveIndex(550, 300e-6),
        `300 ppm → ${(standardAirRefractiveIndex(550, 300e-6) - 1).toExponential(6)} · ` +
          `420 ppm → ${(standardAirRefractiveIndex(550, 420e-6) - 1).toExponential(6)}`,
      )

      // --- Facteur de King et depolarisation --------------------------------
      t.checkRelative('facteur de King a 550 nm', kingFactor(550), 1.0484, 2e-3)
      t.checkTrue(
        'la depolarisation renforce la diffusion de ~5 %',
        kingFactor(550) > 1.04 && kingFactor(550) < 1.06,
        `F(550) = ${kingFactor(550).toFixed(4)} — ignorer cette correction sous-estimerait le ciel d’autant`,
      )
      const rho = depolarizationRatio(550)
      t.checkTrue(
        'taux de depolarisation de l’air dans la plage mesuree',
        rho > 0.027 && rho < 0.031,
        `ρ(550) = ${rho.toFixed(5)} (litterature : 0,027–0,030)`,
      )
      t.checkTrue(
        'le facteur de King croit vers le bleu',
        kingFactor(400) > kingFactor(700),
        `F(400) = ${kingFactor(400).toFixed(4)} · F(700) = ${kingFactor(700).toFixed(4)}`,
      )

      // --- Colonne moleculaire : recoupement phases 1 ↔ 3 -------------------
      // A l'equilibre hydrostatique, ∫N dz = P₀·N_A/(M·g₀), exactement.
      const column = molecularColumnAbove(0)
      const hydrostatic = (101_325 * AVOGADRO) / (DRY_AIR_MOLAR_MASS * STANDARD_GRAVITY)
      t.checkRelative('colonne moleculaire vs equilibre hydrostatique', column, hydrostatic, 5e-3, ' m⁻²')
      t.note(`colonne moleculaire au niveau de la mer : ${column.toExponential(4)} m⁻²`)

      // --- L'ancre : epaisseur optique zenithale ----------------------------
      const tau550 = rayleighOpticalDepth(550)
      t.checkRelative('epaisseur optique Rayleigh a 550 nm', tau550, 0.0973, 1e-2)
      t.note(
        `σ(550 nm) = ${rayleighCrossSection(550).toExponential(4)} m² ` +
          `= ${(rayleighCrossSection(550) * 1e4).toExponential(3)} cm² · τ = ${tau550.toFixed(5)}`,
      )
      t.note(
        `β(550 nm) au niveau de la mer = ${rayleighCoefficientAtAltitude(550, 0).toExponential(4)} m⁻¹ ` +
          `— le rendu actuel code 13,0·10⁻⁶ m⁻¹ en dur pour le vert`,
      )

      // --- Dependance spectrale ---------------------------------------------
      // L'exposant effectif n'est PAS 4 : l'indice et le facteur de King
      // dependent eux aussi de λ. On le mesure, on ne le suppose pas.
      const exponent =
        -Math.log(rayleighCrossSection(700) / rayleighCrossSection(400)) / Math.log(700 / 400)
      t.check('exposant spectral effectif entre 400 et 700 nm', exponent, 4.09, 0.03)
      t.note(`exposant spectral mesure : λ^−${exponent.toFixed(3)} (la loi idealisee dirait −4)`)

      const crossSections: number[] = []
      for (let l = 380; l <= 780; l += 20) crossSections.push(rayleighCrossSection(l))
      t.checkMonotonic('σ decroit avec la longueur d’onde', crossSections, 'decroissant')
      t.checkTrue(
        'le bleu diffuse bien plus que le rouge',
        rayleighCrossSection(450) / rayleighCrossSection(650) > 4,
        `σ(450)/σ(650) = ${(rayleighCrossSection(450) / rayleighCrossSection(650)).toFixed(2)} — ` +
          `voila le ciel bleu, sans qu’aucune couleur soit ecrite nulle part`,
      )

      // --- Dependance en densite et en altitude ------------------------------
      // β = σ·N exactement : la section efficace ne doit PAS dependre de
      // l'altitude, sous peine de compter deux fois la densite.
      const surface = standardProfile(0)
      const high = standardProfile(10_000)
      t.checkRelative(
        'β proportionnel a la densite numerique',
        rayleighCoefficientAtAltitude(550, 10_000) / rayleighCoefficientAtAltitude(550, 0),
        high.numberDensityPerM3 / surface.numberDensityPerM3,
        1e-12,
      )
      t.checkRelative(
        'β = σ·N par construction',
        rayleighScatteringCoefficient(550, surface.numberDensityPerM3),
        rayleighCrossSection(550) * surface.numberDensityPerM3,
        1e-15,
        ' m⁻¹',
      )
      const betaProfile: number[] = []
      for (let z = 0; z <= 80_000; z += 1000) betaProfile.push(rayleighCoefficientAtAltitude(550, z))
      t.checkMonotonic('β decroit avec l’altitude', betaProfile, 'decroissant')

      // L'observateur en altitude a moins d'air au-dessus de lui : au Pic du
      // Midi, un quart de la colonne est deja sous ses pieds. Le rendu actuel
      // ignore totalement ce degre de liberte.
      const tauPicDuMidi = rayleighOpticalDepth(550, 2877)
      t.checkRelative(
        'epaisseur optique au Pic du Midi vs rapport de pression',
        tauPicDuMidi / tau550,
        standardProfile(2877).pressurePa / surface.pressurePa,
        5e-3,
      )
      t.note(
        `τ(550 nm) : ${tau550.toFixed(4)} au niveau de la mer, ${tauPicDuMidi.toFixed(4)} au Pic du Midi ` +
          `(2 877 m) — soit ${((1 - tauPicDuMidi / tau550) * 100).toFixed(0)} % de colonne en moins`,
      )

      // --- Fonction de phase --------------------------------------------------
      t.checkRelative(
        'fonction de phase idealisee normalisee sur la sphere',
        integrateOverSphere(idealRayleighPhaseFunction),
        1,
        1e-12,
      )
      t.checkRelative(
        'fonction de phase depolarisee normalisee sur la sphere',
        integrateOverSphere((mu) => rayleighPhaseFunction(mu, 550)),
        1,
        1e-12,
      )
      t.checkRelative(
        'rapport avant/lateral de la phase idealisee',
        idealRayleighPhaseFunction(1) / idealRayleighPhaseFunction(0),
        2,
        1e-12,
      )
      // La depolarisation remonte le minimum a 90° : le rapport descend sous 2.
      const ratio = rayleighPhaseFunction(1, 550) / rayleighPhaseFunction(0, 550)
      t.checkTrue(
        'la depolarisation remonte le minimum lateral',
        ratio < 2 && ratio > 1.9,
        `p(0°)/p(90°) = ${ratio.toFixed(4)} au lieu de 2 — le ciel a 90° du Soleil n’est jamais totalement polarise`,
      )
      t.checkRelative(
        'symetrie avant/arriere de la diffusion Rayleigh',
        rayleighPhaseFunction(1, 550),
        rayleighPhaseFunction(-1, 550),
        1e-15,
      )

      // --- LA cible posee en phase 2 -----------------------------------------
      // L'eclairement solaire hors atmosphere vaut 133,1 klx (phase 2) ; les
      // paliers de `astro/photometry.ts` donnent 120 klx au sol pour un Soleil
      // au zenith. L'ecart doit etre l'extinction, et le Rayleigh doit en
      // rendre l'essentiel.
      const grid = uniformSpectralGrid(360, 830, 64)
      const solar = solarIrradianceOn(grid)
      const transmittance = rayleighTransmittanceOn(grid, 0)
      const attenuated = new Float64Array(grid.count)
      for (let i = 0; i < grid.count; i++) attenuated[i] = solar[i] * transmittance[i]

      const aboveAtmosphere = luminance(grid, solar)
      const atGround = luminance(grid, attenuated)
      const photopicTransmission = atGround / aboveAtmosphere

      t.checkTrue(
        'transmission zenithale Rayleigh proche de la cible posee en phase 2',
        photopicTransmission > 0.88 && photopicTransmission < 0.93,
        `${(photopicTransmission * 100).toFixed(1)} % — cible 90,2 %, ecrite avant ce module`,
      )
      t.checkTrue(
        'eclairement au sol coherent avec photometry.ts',
        atGround > 112_000 && atGround < 128_000,
        `${(atGround / 1000).toFixed(1)} klx contre 120 klx dans les paliers de photometry.ts, ` +
          `Rayleigh seul (ni ozone, ni aerosols)`,
      )
      t.note(
        `transmission zenithale : ${(photopicTransmission * 100).toFixed(2)} % en ponderation photopique, ` +
          `${(Math.exp(-tau550) * 100).toFixed(2)} % a 550 nm seul`,
      )
      t.note(
        `eclairement : ${(aboveAtmosphere / 1000).toFixed(1)} klx hors atmosphere → ` +
          `${(atGround / 1000).toFixed(1)} klx au sol, Soleil au zenith`,
      )

      // Le Soleil transmis doit **rougir**, sans qu'aucune couleur soit ecrite.
      t.checkTrue(
        'la transmission est plus faible dans le bleu',
        transmittance[2] < transmittance[grid.count - 3],
        `T(${grid.lambdaNm[2].toFixed(0)} nm) = ${(transmittance[2] * 100).toFixed(1)} % · ` +
          `T(${grid.lambdaNm[grid.count - 3].toFixed(0)} nm) = ${(transmittance[grid.count - 3] * 100).toFixed(1)} %`,
      )

      // A l'horizon, la masse d'air depasse 35 : c'est ce qui doit produire un
      // Soleil rouge, par la seule loi de Beer-Lambert.
      const horizon = rayleighTransmittanceOn(grid, 0, undefined, 38)
      t.checkTrue(
        'a l’horizon le bleu est presque entierement retire',
        horizon[2] < 0.05 && horizon[grid.count - 3] > 0.25,
        `masse d’air 38 : bleu ${(horizon[2] * 100).toFixed(2)} % · rouge ` +
          `${(horizon[grid.count - 3] * 100).toFixed(1)} % — le coucher de Soleil, sans code dedie`,
      )

      // --- Coherence des conditions de reference ------------------------------
      t.checkRelative(
        'densite numerique standard optique (15 °C, 1013,25 hPa)',
        STANDARD_AIR_NUMBER_DENSITY,
        101_325 / (BOLTZMANN * 288.15),
        1e-15,
        ' m⁻³',
      )
    },
  )
}
