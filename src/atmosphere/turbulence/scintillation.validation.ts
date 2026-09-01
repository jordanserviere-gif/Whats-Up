/**
 * Validation de la scintillation.
 *
 * ## Ce que cette suite doit etablir
 *
 * La phase 17 est la premiere depuis longtemps a **atteindre l'ecran**. Il faut
 * donc verifier non seulement que les nombres sont justes, mais que le seul
 * nombre porte jusqu'au GPU suffit a reproduire toute la physique.
 *
 * Trois affirmations, dans l'ordre :
 *
 * 1. **Le seeing n'a pas sa place a l'ecran.** Deux secondes d'arc contre
 *    cinquante-huit de limite pupillaire (phase 16) : l'oeil ne peut pas le
 *    voir. Le rendre serait une erreur, pas un raffinement.
 * 2. **La scintillation, si.** Elle est une variation d'intensite, que l'oeil
 *    percoit parfaitement.
 * 3. **Les planetes ne scintillent pas**, et ce n'est pas une regle ecrite :
 *    c'est le rapport de leur taille projetee au rayon de Fresnel.
 *
 * ## Et une propriete qui permet le rendu
 *
 * La variance percue suit `sec^(7/3) ζ` — somme de `11/6` pour la variance et de
 * `1/2` pour l'allongement du trajet. Cet exposant unique est ce qui permet de
 * ne porter au nuanceur **qu'une seule constante**, toute la dependance a la
 * hauteur etant analytique.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { airyFwhmRad, EYE_PUPIL_NIGHT_M } from '../wave/diffraction'
import { seeingRad } from './turbulenceProfile'
import {
  EYE_FLICKER_FUSION_HZ,
  PERCEIVED_VARIANCE_CEILING,
  PERCEIVED_ZENITH_EXPONENT,
  apertureAveraging,
  effectiveScintillationAltitude,
  fresnelScale,
  nakedEyeZenithVariance,
  scintillation,
  scintillationFrequency,
  sourceSizeAveraging,
  visibleVarianceFraction,
} from './scintillation'

const ARCSEC = 1 / 206264.806
const PUPIL = 0.005

export function scintillationSuite(): SuiteResult {
  return suite(
    'Scintillation',
    { reference: 'Roddier (1981) ; Andrews & Phillips (2005) ch. 10' },
    (t) => {
      // --- La couche responsable, et son echelle -------------------------------
      const altitude = effectiveScintillationAltitude()
      t.checkTrue(
        'la couche qui scintille est la haute troposphere',
        altitude > 5000 && altitude < 12_000,
        `${(altitude / 1000).toFixed(2)} km — c'est le barycentre du moment en h^(5/6), ` +
          'et il retrouve la tranche 5–15 km que la phase 15 avait designee',
      )
      const fresnel = fresnelScale(550, altitude)
      t.checkTrue(
        'le rayon de Fresnel est de quelques centimetres',
        fresnel > 0.03 && fresnel < 0.12,
        `${(fresnel * 100).toFixed(2)} cm — c'est l'echelle du reseau de taches que le vent ` +
          'fait defiler au sol',
      )

      // --- Le seeing n'a pas sa place a l'ecran --------------------------------
      // Repris de la phase 16, parce que c'est la decision de rendu de cette
      // phase-ci : on ne rend pas le seeing.
      const seeing = seeingRad(550, 0)
      const eyeDiffraction = airyFwhmRad(EYE_PUPIL_NIGHT_M, 550)
      t.checkTrue(
        'le seeing reste sous la limite de diffraction de l’oeil, meme pupille dilatee',
        eyeDiffraction > 5 * seeing,
        `${(eyeDiffraction / ARCSEC).toFixed(1)}″ de diffraction contre ` +
          `${(seeing / ARCSEC).toFixed(2)}″ de seeing — le rendre serait une erreur, ` +
          'pas un raffinement',
      )

      // --- L'oeil ne percoit qu'une fraction de la variance --------------------
      const fraction = visibleVarianceFraction(550, altitude)
      const frequency = scintillationFrequency(550, altitude)
      t.checkTrue(
        'le spectre est bien plus rapide que la fusion retinienne',
        frequency > 10 * EYE_FLICKER_FUSION_HZ,
        `${frequency.toFixed(0)} Hz contre ${EYE_FLICKER_FUSION_HZ} Hz de fusion — ` +
          `l'oeil n'en percoit que ${(fraction * 100).toFixed(1)} %, le reste se moyenne ` +
          'dans la retine',
      )
      const zenith = scintillation(0, { apertureM: PUPIL })
      t.checkTrue(
        'la variance percue est donc bien moindre que la totale',
        zenith.variancePerceived < 0.1 * zenith.varianceTotal,
        `${zenith.variancePerceived.toExponential(3)} percue contre ` +
          `${zenith.varianceTotal.toFixed(4)} au total`,
      )
      t.checkTrue(
        'une etoile au zenith ne fait que fremir',
        zenith.magnitudeSigma > 0.02 && zenith.magnitudeSigma < 0.2,
        `σ = ${zenith.magnitudeSigma.toFixed(4)} mag — perceptible, discret`,
      )

      // --- Les etoiles basses scintillent bien plus ----------------------------
      const low = scintillation(70, { apertureM: PUPIL })
      t.checkTrue(
        'et une etoile basse, beaucoup plus',
        low.magnitudeSigma > 3 * zenith.magnitudeSigma,
        `σ = ${low.magnitudeSigma.toFixed(4)} mag a 20° de hauteur contre ` +
          `${zenith.magnitudeSigma.toFixed(4)} au zenith`,
      )

      // --- L'exposant qui permet le rendu ---------------------------------------
      let worstExponent = 0
      for (const zenithDeg of [30, 45, 60, 70]) {
        const ratio =
          scintillation(zenithDeg, { apertureM: PUPIL }).variancePerceived / zenith.variancePerceived
        const sec = 1 / Math.cos((zenithDeg * Math.PI) / 180)
        const exponent = Math.log(ratio) / Math.log(sec)
        worstExponent = Math.max(worstExponent, Math.abs(exponent - PERCEIVED_ZENITH_EXPONENT))
      }
      t.checkTrue(
        'la variance percue suit sec^(7/3), a une constante pres',
        worstExponent < 0.02,
        `ecart maximal ${worstExponent.toFixed(4)} sur l'exposant — 11/6 pour la variance ` +
          "plus 1/2 pour l'allongement du trajet. C'est ce qui permet de ne porter au GPU " +
          'qu’une seule constante',
      )
      t.checkTrue(
        'et cette constante est celle que le rendu porte',
        Math.abs(nakedEyeZenithVariance(PUPIL) - zenith.variancePerceived) < 1e-12,
        `${nakedEyeZenithVariance(PUPIL).toExponential(4)}`,
      )

      // --- Pourquoi les planetes ne scintillent pas -----------------------------
      // Aucune regle ne le dit : c'est le rapport de la taille projetee au rayon
      // de Fresnel, et rien d'autre.
      const star = scintillation(60, { apertureM: PUPIL, sourceAngularDiameterRad: 0 })
      const jupiter = scintillation(60, {
        apertureM: PUPIL,
        sourceAngularDiameterRad: 40 * ARCSEC,
      })
      const moon = scintillation(60, {
        apertureM: PUPIL,
        sourceAngularDiameterRad: 1800 * ARCSEC,
      })

      t.checkTrue(
        'une planete scintille bien moins qu’une etoile',
        jupiter.magnitudeSigma < star.magnitudeSigma / 20,
        `σ = ${star.magnitudeSigma.toFixed(4)} mag pour une etoile contre ` +
          `${jupiter.magnitudeSigma.toFixed(5)} pour Jupiter — un facteur ` +
          `${(star.magnitudeSigma / jupiter.magnitudeSigma).toFixed(0)}`,
      )
      t.checkTrue(
        'et la Lune, pas du tout',
        moon.magnitudeSigma < 1e-4,
        `σ = ${moon.magnitudeSigma.toExponential(2)} mag — sa taille projetee a ` +
          `${(altitude / 1000).toFixed(1)} km fait ${(1800 * ARCSEC * altitude).toFixed(0)} m, ` +
          `contre ${(fresnel * 100).toFixed(1)} cm de rayon de Fresnel`,
      )
      // La transition se fait la ou la taille projetee vaut le rayon de Fresnel.
      const marginal = sourceSizeAveraging(fresnel / altitude, 550, altitude)
      t.checkTrue(
        'la transition se joue quand la taille projetee vaut le rayon de Fresnel',
        marginal > 0.2 && marginal < 0.8,
        `moyennage ${marginal.toFixed(3)} pour une source projetant exactement un rayon ` +
          `de Fresnel, soit ${((fresnel / altitude / ARCSEC)).toFixed(1)}″ d'ouverture angulaire — ` +
          'les planetes sont au-dessus, les etoiles trés en dessous',
      )

      // --- Moyennage d'ouverture ------------------------------------------------
      t.check('une ouverture nulle ne moyenne rien', apertureAveraging(0, 550, altitude), 1, 0)
      t.checkTrue(
        'la pupille de l’oeil ne moyenne presque pas',
        apertureAveraging(PUPIL, 550, altitude) > 0.95,
        `${apertureAveraging(PUPIL, 550, altitude).toFixed(4)} — cinq millimetres contre ` +
          `${(fresnel * 100).toFixed(1)} cm : c’est pourquoi l’oeil nu voit la scintillation ` +
          'dans toute son amplitude',
      )
      const big = apertureAveraging(5, 550, altitude)
      const small = apertureAveraging(0.5, 550, altitude)
      const slope = Math.log(big / small) / Math.log(10)
      t.checkRelative('l’asymptote du moyennage est en D^(−7/3)', slope, -7 / 3, 0.02)

      // --- Le plafond est une borne de validite, pas un reglage -----------------
      const veryLow = scintillation(85, { apertureM: PUPIL })
      t.checkTrue(
        'le modele sort de son domaine pres de l’horizon',
        veryLow.varianceTotal > 1,
        `σ_I² = ${veryLow.varianceTotal.toFixed(1)} a 5° de hauteur — au-dela de 1, la theorie ` +
          'de perturbation surestime et la scintillation reelle sature. Le plafond du rendu, ' +
          `${PERCEIVED_VARIANCE_CEILING}, est la borne du domaine et non un reglage esthetique`,
      )
      t.checkTrue(
        'et le plafond ramene l’amplitude a quelque chose de fini',
        1.0857362 * Math.sqrt(Math.log(1 + PERCEIVED_VARIANCE_CEILING)) < 0.8,
        `σ ≤ ${(1.0857362 * Math.sqrt(Math.log(1 + PERCEIVED_VARIANCE_CEILING))).toFixed(3)} mag`,
      )

      // --- Coherence de la conversion log-normale --------------------------------
      // `σ_lnI² = ln(1 + σ_I²)` et `σ_m = 1,0857·σ_lnI`. Pour une petite variance,
      // `σ_m ≈ 1,0857·σ_I`.
      const tiny = scintillation(0, { apertureM: PUPIL, perceptual: true })
      t.checkRelative(
        'aux faibles variances, σ_mag tend vers 1,0857·σ_I',
        tiny.magnitudeSigma,
        1.0857362 * Math.sqrt(tiny.variancePerceived),
        0.01,
        'mag',
      )
    },
  )
}
