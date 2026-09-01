/**
 * Validation de l'optique ondulatoire.
 *
 * ## Ce qui est verifie, et pourquoi c'est plus qu'une formule
 *
 * **Le 1,22 n'est pas une constante du moteur.** C'est le premier zero de la
 * fonction de Bessel `J₁`, divise par π. La suite le trouve par dichotomie sur
 * `J₁` plutot que de le supposer — si l'implementation de Bessel derive, le
 * critere de Rayleigh derive avec elle.
 *
 * **Les couronnes ne sont ecrites nulle part.** La suite calcule la fonction de
 * phase de Mie d'une gouttelette de nuage — le solveur exact de la phase 6, sans
 * un coefficient de plus — et **cherche ou elle a des minima**. Que ceux-ci
 * tombent la ou la diffraction les predit est un resultat, pas une entree.
 *
 * **Et le croisement retrouve `r₀`.** Le diametre au-dela duquel l'atmosphere
 * l'emporte sur la diffraction est calcule ici a partir de la tache d'Airy et du
 * seeing ; il doit retomber sur le parametre de Fried de la phase 15, obtenu
 * par une integrale de `C_n²`. Deux chemins sans rien de commun.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { friedParameter, seeingRad } from '../turbulence/turbulenceProfile'
import {
  EYE_PUPIL_DAY_M,
  EYE_PUPIL_NIGHT_M,
  FIRST_BESSEL_ZERO,
  airyFirstDarkRingRad,
  airyFwhmRad,
  airyIntensity,
  besselJ1,
  resolutionLimit,
  seeingLimitedAperture,
} from './diffraction'
import { coronaProfile, diffractionFirstDarkRingRad, dropletRadiusFromRing } from './corona'

const ARCSEC = 206264.806

export function waveOpticsSuite(): SuiteResult {
  return suite(
    'Optique ondulatoire',
    { reference: 'Born & Wolf (1999) ch. 8 ; van de Hulst (1957) ch. 8' },
    (t) => {
      // --- Le 1,22 est trouve, pas ecrit --------------------------------------
      let low = 3
      let high = 5
      for (let i = 0; i < 100; i++) {
        const mid = (low + high) / 2
        if (besselJ1(mid) > 0) low = mid
        else high = mid
      }
      const zero = (low + high) / 2
      t.checkRelative('premier zero de J₁, trouve par dichotomie', zero, FIRST_BESSEL_ZERO, 1e-7)
      t.checkRelative(
        'le critere de Rayleigh en decoule',
        zero / Math.PI,
        1.2196698912665045,
        1e-7,
      )

      // --- La tache d'Airy ------------------------------------------------------
      t.check('intensite unite sur l’axe', airyIntensity(0, 0.1, 550), 1, 1e-12)
      t.checkTrue(
        'et nulle au premier anneau sombre',
        airyIntensity(airyFirstDarkRingRad(0.1, 550), 0.1, 550) < 1e-12,
        `${airyIntensity(airyFirstDarkRingRad(0.1, 550), 0.1, 550).toExponential(2)} — ` +
          'numeriquement zero',
      )
      t.checkRelative(
        'rapport largeur a mi-hauteur / premier zero',
        airyFwhmRad(0.1, 550) / airyFirstDarkRingRad(0.1, 550),
        0.8437,
        1e-3,
      )
      // La diffraction varie en 1/D : doubler l'ouverture divise la tache par deux.
      t.checkRelative(
        'la tache varie en 1/D',
        airyFwhmRad(0.2, 550),
        airyFwhmRad(0.1, 550) / 2,
        1e-12,
      )

      // --- Pourquoi l'oeil nu ne voit pas le seeing ----------------------------
      const seeing = seeingRad(550, 0)
      const day = resolutionLimit(EYE_PUPIL_DAY_M, 550, seeing)
      const night = resolutionLimit(EYE_PUPIL_NIGHT_M, 550, seeing)

      t.checkTrue(
        'l’oeil nu est limite par sa propre diffraction, de loin',
        day.diffractionLimited && day.diffractionRad > 10 * seeing,
        `${(day.diffractionRad * ARCSEC).toFixed(1)}″ de diffraction pour une pupille de 2 mm, ` +
          `contre ${(seeing * ARCSEC).toFixed(2)}″ de seeing — un facteur ` +
          `${(day.diffractionRad / seeing).toFixed(0)}. C’est pourquoi les etoiles ne paraissent ` +
          'pas floues a l’oeil nu, alors qu’elles scintillent parfaitement',
      )
      t.checkTrue(
        'et cela reste vrai pupille dilatee',
        night.diffractionLimited,
        `${(night.diffractionRad * ARCSEC).toFixed(1)}″ a 7 mm — encore ` +
          `${(night.diffractionRad / seeing).toFixed(0)} fois le seeing`,
      )
      const telescope = resolutionLimit(0.2, 550, seeing)
      t.checkTrue(
        'un telescope de 200 mm, lui, est limite par l’atmosphere',
        !telescope.diffractionLimited,
        `${(telescope.diffractionRad * ARCSEC).toFixed(2)}″ de diffraction contre ` +
          `${(seeing * ARCSEC).toFixed(2)}″ de seeing : la tache reelle vaut ` +
          `${(telescope.effectiveRad * ARCSEC).toFixed(2)}″`,
      )
      t.checkTrue(
        'agrandir au-dela n’ameliore plus la resolution',
        Math.abs(resolutionLimit(1, 550, seeing).effectiveRad / telescope.effectiveRad - 1) < 0.05,
        'de 200 mm a 1 m, la tache ne bouge plus que de quelques pour cent — ' +
          'le gain restant est en lumiere, pas en finesse',
      )

      // --- Le croisement retrouve le parametre de Fried ------------------------
      // Calcule ici par la tache d'Airy et le seeing ; calcule la-bas par une
      // integrale de C_n². Rien de commun entre les deux chemins.
      const crossover = seeingLimitedAperture(550, seeing)
      const r0 = friedParameter(550, 0)
      t.checkRelative('l’ouverture de croisement est le parametre de Fried', crossover, r0, 0.1, 'm')

      // --- Les couronnes emergent du calcul de Mie -----------------------------
      // Aucun anneau n'est ecrit : on calcule la fonction de phase exacte et on
      // cherche ou elle a des minima.
      const measured: Array<{ radiusM: number; mie: number; predicted: number; error: number }> = []
      for (const radiusM of [5e-6, 10e-6, 20e-6]) {
        const profile = coronaProfile(radiusM, 550, 25, 3000)
        const predicted = diffractionFirstDarkRingRad(radiusM, 550)
        if (profile.firstDarkRingRad === null) continue
        measured.push({
          radiusM,
          mie: profile.firstDarkRingRad,
          predicted,
          error: Math.abs(profile.firstDarkRingRad - predicted) / predicted,
        })
      }
      t.check('trois tailles de gouttelettes donnent bien un anneau', measured.length, 3, 0)
      const worst = Math.max(...measured.map((m) => m.error))
      t.checkTrue(
        'les anneaux de Mie tombent ou la diffraction les predit',
        worst < 0.05,
        `ecart maximal ${(worst * 100).toFixed(1)} % — le solveur resout Maxwell autour d’une ` +
          'sphere transparente, la prediction traite la gouttelette comme un disque opaque',
      )
      // L'approximation de diffraction est asymptotique en parametre de taille :
      // plus la gouttelette est grosse, mieux elle vaut.
      t.checkTrue(
        'et l’accord s’ameliore avec la taille, comme une asymptotique le doit',
        measured[2].error < measured[0].error,
        `${(measured[0].error * 100).toFixed(1)} % a 5 µm contre ` +
          `${(measured[2].error * 100).toFixed(1)} % a 20 µm`,
      )

      const rings = coronaProfile(10e-6, 550, 25, 3000).rings.length
      t.checkTrue(
        'une gouttelette de nuage produit plusieurs anneaux',
        rings >= 3,
        `${rings} maxima trouves au-dela du premier minimum — ce sont les anneaux successifs ` +
          'd’une couronne',
      )

      // --- La couronne est coloree, et dans le bon sens -------------------------
      const blue = coronaProfile(10e-6, 450, 25, 3000).firstDarkRingRad!
      const red = coronaProfile(10e-6, 650, 25, 3000).firstDarkRingRad!
      t.checkTrue(
        'le bleu forme l’anneau interieur, le rouge l’exterieur',
        blue < red,
        `${((blue * 180) / Math.PI).toFixed(3)}° a 450 nm contre ` +
          `${((red * 180) / Math.PI).toFixed(3)}° a 650 nm — c’est l’inverse d’un arc-en-ciel, ` +
          'ou commande la dispersion et non la diffraction',
      )
      t.checkRelative('et le rayon suit la longueur d’onde', red / blue, 650 / 450, 0.01)

      // --- La lecture inverse, usage historique des couronnes -------------------
      const observed = coronaProfile(8e-6, 550, 25, 3000).firstDarkRingRad!
      t.checkRelative(
        'le rayon observe redonne la taille de la gouttelette',
        dropletRadiusFromRing(observed, 550),
        8e-6,
        0.1,
        'm',
      )

      // --- L'approximation se degrade vers les petites tailles ------------------
      //
      // ⚠️ Un controle precedent affirmait qu'a 3 µm la prediction par diffraction
      // « cessait de valoir », sur la foi d'un ecart de 43 %. C'etait faux : ces
      // 43 % venaient de la **structure de resonances** d'une gouttelette unique,
      // que la detection du premier minimum prenait pour l'anneau. Une fois la
      // distribution de tailles introduite — ce que fait tout nuage reel —
      // l'ecart tombe a 4,4 %.
      //
      // L'enonce correct est plus modeste : l'accord se degrade vers les petites
      // tailles, sans rupture.
      const tinyError =
        Math.abs(coronaProfile(3e-6, 550).firstDarkRingRad! - diffractionFirstDarkRingRad(3e-6, 550)) /
        diffractionFirstDarkRingRad(3e-6, 550)
      t.checkTrue(
        'l’accord se degrade vers les petites gouttelettes, sans rupture',
        tinyError > measured[2].error && tinyError < 0.1,
        `${(tinyError * 100).toFixed(1)} % a 3 µm contre ${(measured[2].error * 100).toFixed(1)} % ` +
          'a 20 µm — le parametre de taille y est moins grand, et une sphere s’y comporte moins ' +
          'comme un disque',
      )

      // --- La dispersion des tailles est ce qui rend les anneaux nets -----------
      // Sur une gouttelette unique, les resonances brouillent l'enveloppe. C'est
      // aussi pourquoi une couronne bien marquee signale un nuage a distribution
      // etroite.
      const monodisperse = coronaProfile(10e-6, 550, 25, 1200, { sizeSpread: 0 })
      const spread = coronaProfile(10e-6, 550, 25, 1200)
      const monoError =
        Math.abs(monodisperse.firstDarkRingRad! - diffractionFirstDarkRingRad(10e-6, 550)) /
        diffractionFirstDarkRingRad(10e-6, 550)
      const spreadError =
        Math.abs(spread.firstDarkRingRad! - diffractionFirstDarkRingRad(10e-6, 550)) /
        diffractionFirstDarkRingRad(10e-6, 550)
      t.checkTrue(
        'une distribution de tailles rend l’anneau plus net, pas moins',
        spreadError < monoError,
        `${(monoError * 100).toFixed(1)} % pour une gouttelette unique contre ` +
          `${(spreadError * 100).toFixed(1)} % avec 5 % de dispersion — les resonances propres ` +
          'de la sphere sont lissees, l’enveloppe de diffraction reste',
      )
    },
  )
}
