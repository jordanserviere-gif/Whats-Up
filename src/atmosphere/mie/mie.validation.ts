/**
 * Validation de Mie et des aerosols — phase 6.
 *
 * Une implementation de Mie ne se valide pas contre une table recopiee : elle
 * se valide contre des **limites analytiques**, dont l'algorithme ne sait rien.
 *
 * 1. **La limite de Rayleigh.** Quand la particule devient petite, Mie doit
 *    retrouver `Q_sca → (8/3)x⁴|(m²−1)/(m²+2)|²`. Mieux : il doit retrouver la
 *    section efficace que le module Rayleigh de la phase 3 calcule par un tout
 *    autre chemin. Deux algorithmes independants, un seul nombre.
 * 2. **Le paradoxe de l'extinction.** `Q_ext → 2` pour une grosse particule —
 *    elle intercepte deux fois sa section geometrique.
 * 3. **La conservation.** `ω₀ ≤ 1` toujours, et exactement 1 pour un materiau
 *    non absorbant. C'est ce controle qui a attrape une convention de signe
 *    inversee sur la partie imaginaire de l'indice : le calcul rendait des
 *    albedos de 1,5, c'est-a-dire une particule diffusant plus de lumiere
 *    qu'elle n'en intercepte.
 * 4. **La normalisation** de la fonction de phase.
 *
 * Pour la population, la validation porte sur les **observables** : exposant
 * d'Angstrom, albedo de diffusion simple, facteur d'asymetrie. Ce sont les
 * trois grandeurs que les reseaux de photometres solaires publient, et les
 * seules par lesquelles un modele d'aerosol se juge.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { uniformSpectralGrid } from '../spectral/SpectralGrid'
import { rayleighCrossSection } from '../rayleigh/rayleigh'
import { STANDARD_AIR_NUMBER_DENSITY, kingFactor, standardAirRefractiveIndex } from '../rayleigh/standardAir'
import {
  mieCoefficients,
  mieEfficiencies,
  miePhaseFunction,
  rayleighLimitQSca,
  sizeParameter,
  type Complex,
} from './mie'
import {
  AOD_PER_TURBIDITY,
  CONTINENTAL_AEROSOL,
  PHASE_ANGLE_COUNT,
  aerosolNumberDensity,
  aerosolOptics,
  aerosolPhase,
  angstromExponent,
  aodFromTurbidity,
  withAod,
} from './aerosol'

const grid = uniformSpectralGrid(360, 830, 16)

/** Integrale d'une fonction de phase sur la sphere. */
function integrateOverSphere(p: (mu: number) => number, steps = 20000): number {
  let sum = 0
  for (let i = 0; i < steps; i++) sum += p(-1 + ((i + 0.5) * 2) / steps) * (2 / steps)
  return 2 * Math.PI * sum
}

export function mieSuite(): SuiteResult {
  return suite(
    'Theorie de Mie (phase 6)',
    { reference: 'Bohren & Huffman (1983), chapitre 4' },
    (t) => {
      const absorbing: Complex = { re: 1.53, im: 0.008 }
      const transparent: Complex = { re: 1.33, im: 0 }

      // --- Limite de Rayleigh --------------------------------------------------
      for (const x of [0.001, 0.01, 0.05]) {
        const q = mieEfficiencies(mieCoefficients(x, absorbing)).qSca
        t.checkRelative(`limite de Rayleigh a x = ${x}`, q, rayleighLimitQSca(x, absorbing), 1e-3)
      }
      t.checkTrue(
        'l’ecart a Rayleigh croit avec la taille',
        Math.abs(mieEfficiencies(mieCoefficients(0.5, absorbing)).qSca / rayleighLimitQSca(0.5, absorbing) - 1) > 0.01,
        `a x = 0,5 l’ecart atteint ` +
          `${((mieEfficiencies(mieCoefficients(0.5, absorbing)).qSca / rayleighLimitQSca(0.5, absorbing) - 1) * 100).toFixed(1)} % : ` +
          `Rayleigh cesse d’etre suffisant`,
      )

      // --- Mie contre le module Rayleigh, par deux chemins independants --------
      // Le meilleur controle du lot : une molecule d'air traitee comme une
      // sphere minuscule d'indice `n_air` doit rendre la meme section efficace
      // que la formule de Bodhaine de la phase 3.
      //
      // Le rayon equivalent se deduit de la densite : `(4/3)πr³ N = 1`, soit le
      // volume moyen par molecule. L'accord n'est pas exact — Bodhaine inclut
      // le facteur de King, absent d'un modele de sphere isotrope — mais il doit
      // etre du bon ordre et suivre la meme loi spectrale.
      const equivalentRadius = Math.cbrt(3 / (4 * Math.PI * STANDARD_AIR_NUMBER_DENSITY))
      const spectralRatio = (lambdaNm: number) => {
        const n = standardAirRefractiveIndex(lambdaNm)
        const x = sizeParameter(equivalentRadius, lambdaNm)
        const q = mieEfficiencies(mieCoefficients(x, { re: n, im: 0 })).qSca
        return (q * Math.PI * equivalentRadius * equivalentRadius) / rayleighCrossSection(lambdaNm)
      }
      // L'ecart entre les deux n'est pas un residu inexplique : c'est **exactement**
      // le facteur de King. Bodhaine le porte, un modele de sphere isotrope ne
      // peut pas l'avoir. Le corriger doit donc ramener le rapport a 1 — et il
      // varie lui-meme avec λ, ce qui explique que le rapport brut ne soit pas
      // tout a fait constant.
      for (const lambdaNm of [420, 450, 550, 650, 750]) {
        t.checkRelative(
          `Mie x facteur de King = Rayleigh de Bodhaine, a ${lambdaNm} nm`,
          spectralRatio(lambdaNm) * kingFactor(lambdaNm),
          1,
          2e-3,
        )
      }
      t.note(
        `Mie sur une sphere equivalente / Bodhaine : ×${spectralRatio(450).toFixed(4)} a 450 nm et ` +
          `×${spectralRatio(650).toFixed(4)} a 650 nm, pour des facteurs de King de ` +
          `${kingFactor(450).toFixed(4)} et ${kingFactor(650).toFixed(4)} — ` +
          `deux algorithmes independants, un seul nombre une fois la depolarisation retablie`,
      )

      // --- Paradoxe de l'extinction --------------------------------------------
      for (const x of [50, 200, 800]) {
        const q = mieEfficiencies(mieCoefficients(x, transparent)).qExt
        t.check(`paradoxe de l’extinction a x = ${x}`, q, 2, 0.25)
      }

      // --- Conservation ---------------------------------------------------------
      // C'est ce controle qui a attrape une convention de signe inversee.
      for (const x of [0.5, 5, 50]) {
        const q = mieEfficiencies(mieCoefficients(x, transparent))
        t.checkRelative(`diffuseur pur : ω₀ = 1 exactement a x = ${x}`, q.singleScatteringAlbedo, 1, 1e-12)
      }
      t.checkTrue(
        'l’albedo de diffusion simple ne depasse jamais 1',
        [0.1, 1, 5, 20, 100, 500].every((x) => mieEfficiencies(mieCoefficients(x, absorbing)).singleScatteringAlbedo <= 1),
        'une particule ne peut pas diffuser plus de lumiere qu’elle n’en intercepte',
      )
      t.checkTrue(
        'l’absorption est nulle pour un indice reel',
        mieEfficiencies(mieCoefficients(5, transparent)).qAbs === 0,
      )

      // --- Normalisation et forme de la fonction de phase -----------------------
      for (const x of [0.1, 1, 5, 20]) {
        const coefficients = mieCoefficients(x, absorbing)
        const q = mieEfficiencies(coefficients)
        t.checkRelative(
          `fonction de phase normalisee a x = ${x}`,
          integrateOverSphere((mu) => miePhaseFunction(coefficients, mu, q.qSca)),
          1,
          1e-4,
        )
      }

      // Une petite particule diffuse presque symetriquement, une grosse vers
      // l'avant. C'est toute la difference entre un ciel clair et un halo.
      const small = mieEfficiencies(mieCoefficients(0.05, absorbing))
      const large = mieEfficiencies(mieCoefficients(20, absorbing))
      t.checkTrue(
        'l’asymetrie croit avec la taille',
        small.asymmetry < 0.01 && large.asymmetry > 0.7,
        `g = ${small.asymmetry.toFixed(4)} a x = 0,05 · ${large.asymmetry.toFixed(4)} a x = 20`,
      )
    },
  )
}

export function aerosolSuite(): SuiteResult {
  return suite(
    'Aerosols : population et proprietes optiques (phase 6)',
    { reference: 'observables AERONET : exposant d’Angstrom, ω₀, g' },
    (t) => {
      const optics = aerosolOptics(grid, { ...CONTINENTAL_AEROSOL, aod550: aodFromTurbidity(1) })

      // --- Les trois observables -----------------------------------------------
      // Un seul parametre a ete cale — le rayon median, sur l'exposant
      // d'Angstrom. Les deux autres doivent tomber d'eux-memes dans leurs
      // plages publiees, sans quoi le calage serait une coincidence.
      const alpha = angstromExponent(grid, optics)
      t.checkTrue(
        'exposant d’Angstrom d’un aerosol continental',
        alpha > 1.1 && alpha < 1.6,
        `α = ${alpha.toFixed(3)} (AERONET continental : 1,2 a 1,5) — c’est sur lui que le rayon median est cale`,
      )

      const mid = Math.round(grid.count / 2) - 1
      const albedo = optics.scattering[mid] / optics.extinction[mid]
      t.checkTrue(
        'albedo de diffusion simple dans la plage publiee',
        albedo > 0.9 && albedo < 0.98,
        `ω₀ = ${albedo.toFixed(4)} a ${grid.lambdaNm[mid].toFixed(0)} nm (litterature : 0,92 a 0,96) — ` +
          `non cale, il suit`,
      )
      t.checkTrue(
        'facteur d’asymetrie dans la plage publiee',
        optics.asymmetry[mid] > 0.55 && optics.asymmetry[mid] < 0.75,
        `g = ${optics.asymmetry[mid].toFixed(4)} (litterature : 0,6 a 0,7) — non cale, il suit`,
      )

      // --- Bien moins selectif en longueur d'onde que Rayleigh -------------------
      // C'est la raison physique du blanchiment : la brume diffuse presque
      // autant le rouge que le bleu, la ou Rayleigh privilegie le bleu d'un
      // facteur cinq.
      t.checkTrue(
        'la diffusion de Mie est bien moins selective que Rayleigh',
        alpha < 2,
        `α = ${alpha.toFixed(2)} pour les aerosols contre ${(
          -Math.log(rayleighCrossSection(870) / rayleighCrossSection(440)) / Math.log(870 / 440)
        ).toFixed(2)} pour Rayleigh — voila pourquoi la brume blanchit au lieu de bleuir`,
      )

      // --- Fonction de phase tabulee --------------------------------------------
      for (const band of [1, 8, 15]) {
        t.checkRelative(
          `phase tabulee normalisee, bande ${band}`,
          integrateOverSphere((mu) => aerosolPhase(optics, band, mu), PHASE_ANGLE_COUNT * 8),
          1,
          1e-2,
        )
      }
      const forward = aerosolPhase(optics, 8, 1)
      const side = aerosolPhase(optics, 8, 0)
      t.checkTrue(
        'la phase de Mie est fortement dirigee vers l’avant',
        forward > 20 * side,
        `p(0°)/p(90°) = ${(forward / side).toFixed(0)} contre 1,9 pour Rayleigh — c’est le halo solaire`,
      )

      // --- Profil vertical et calage de l'epaisseur optique ----------------------
      t.checkRelative(
        'la densite decroit d’un facteur e sur la hauteur d’echelle',
        aerosolNumberDensity(optics, optics.scaleHeightM) / aerosolNumberDensity(optics, 0),
        Math.exp(-1),
        1e-12,
      )

      // L'epaisseur optique verticale doit valoir exactement ce qui a ete
      // demande : c'est la grandeur mesurable, et le seul reglage physique.
      let column = 0
      const step = 20
      for (let z = 0; z < 60_000; z += step) column += aerosolNumberDensity(optics, z + step / 2) * step
      // Interpolation de la section efficace d'extinction a 550 nm.
      let extinction550 = optics.extinction[0]
      for (let b = 1; b < grid.count; b++) {
        if (grid.lambdaNm[b] >= 550) {
          const f = (550 - grid.lambdaNm[b - 1]) / (grid.lambdaNm[b] - grid.lambdaNm[b - 1])
          extinction550 = optics.extinction[b - 1] + (optics.extinction[b] - optics.extinction[b - 1]) * f
          break
        }
      }
      t.checkRelative(
        'epaisseur optique verticale a 550 nm = AOD demandee',
        column * extinction550,
        aodFromTurbidity(1),
        2e-3,
      )

      // --- Changer la quantite sans refaire le calcul de Mie ---------------------
      const doubled = withAod(optics, aodFromTurbidity(2), aodFromTurbidity(1))
      t.checkRelative(
        'doubler l’epaisseur optique double la densite',
        doubled.groundNumberDensity,
        2 * optics.groundNumberDensity,
        1e-12,
      )
      t.checkTrue(
        'les proprietes optiques sont inchangees',
        doubled.scattering === optics.scattering && doubled.asymmetry === optics.asymmetry,
        'seule la quantite change : le calcul de Mie ne depend que de la nature des particules',
      )

      t.check('trouble 1 = air tres pur', aodFromTurbidity(1), AOD_PER_TURBIDITY, 1e-12)
      t.note(
        `trouble → AOD(550) : ${[1, 2, 4, 6].map((v) => `${v} → ${aodFromTurbidity(v).toFixed(2)}`).join(' · ')}`,
      )
    },
  )
}
