/**
 * Validation du transform d'affichage — phase 0.5.
 *
 * Le refactor repose entierement sur une propriete : `radianceFromDisplay()`
 * doit etre l'**inverse exact** de `displayTransform()`. C'est elle qui rend la
 * migration neutre pour les materiaux pas encore physiques — un sol, un trait
 * de grille, une etoile — dont la couleur reste une valeur d'affichage heritee.
 *
 * Si l'inverse derivait, toutes ces couches s'assombriraient ou s'eclairciraient
 * silencieusement, et rien dans le rendu ne le signalerait autrement que par un
 * « ça a changé » impossible a attribuer.
 *
 * La suite vit dans `atmosphere/validation/` plutot qu'a cote du module qu'elle
 * teste parce que `scene/display/tonemap.ts` appartient a la couche de rendu :
 * c'est le harnais qui vient a lui, pas l'inverse.
 */
import {
  DISPLAY_SATURATION,
  RADIANCE_AT_DISPLAY_WHITE,
  displayTransform,
  radianceFromDisplay,
} from '@/scene/display/tonemap'
import { suite, type SuiteResult } from './harness'

const LUMA = [0.2126, 0.7152, 0.0722] as const
const luma = (c: readonly [number, number, number]) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2]

export function displayTransformSuite(): SuiteResult {
  return suite(
    'Transform d’affichage (phase 0.5)',
    { reference: 'ACES filmique (Narkowicz 2015) + re-saturation' },
    (t) => {
      // --- Aller-retour : la propriete dont depend tout le refactor ---------
      // On part de valeurs d'**affichage**, puisque c'est le sens dans lequel
      // les cales sont utilisees : une couleur heritee remontee en radiance
      // doit se reafficher a l'identique.
      const displayColours: ReadonlyArray<readonly [number, number, number]> = [
        [0, 0, 0],
        [0.012, 0.016, 0.039], // socle nocturne, token --app-sky-zenith
        [0.05, 0.05, 0.05],
        [0.25, 0.4, 0.6],
        [0.5, 0.5, 0.5],
        [0.72, 0.6, 0.42],
        [0.9, 0.9, 0.9],
      ]
      for (const c of displayColours) {
        const back = displayTransform(radianceFromDisplay(c))
        const gap = Math.max(...back.map((v, i) => Math.abs(v - c[i])))
        t.check(`aller-retour affichage → radiance → affichage (${c.join(', ')})`, gap, 0, 1e-9)
      }

      // --- Monotonie ---------------------------------------------------------
      // Strictement croissante **sous la saturation** seulement : au-dela de
      // RADIANCE_AT_DISPLAY_WHITE la courbe est ecretee a 1, donc plate. C'est
      // le comportement voulu, pas un defaut de monotonie.
      const ramp: number[] = []
      for (let x = 0; x < RADIANCE_AT_DISPLAY_WHITE; x += 0.02) ramp.push(displayTransform([x, x, x])[1])
      t.checkMonotonic('la courbe croit strictement sous la saturation', ramp, 'croissant')
      t.checkTrue(
        'la courbe reste a 1 au-dela de la saturation',
        [8, 50, 1e4].every((x) => displayTransform([x, x, x])[1] === 1),
      )

      const inverseRamp: number[] = []
      for (let y = 0; y <= 0.99; y += 0.01) inverseRamp.push(radianceFromDisplay([y, y, y])[1])
      t.checkMonotonic('l’inverse est strictement croissant', inverseRamp, 'croissant')

      // --- Points fixes -------------------------------------------------------
      t.check('le noir reste noir', displayTransform([0, 0, 0])[0], 0, 1e-15)
      t.check('le noir s’inverse en zero', radianceFromDisplay([0, 0, 0])[0], 0, 1e-15)
      t.checkRelative(
        'la radiance qui s’affiche en blanc',
        displayTransform([RADIANCE_AT_DISPLAY_WHITE, RADIANCE_AT_DISPLAY_WHITE, RADIANCE_AT_DISPLAY_WHITE])[1],
        1,
        1e-9,
      )
      t.note(
        `RADIANCE_AT_DISPLAY_WHITE = ${RADIANCE_AT_DISPLAY_WHITE.toFixed(4)} — ` +
          `c’est le seuil du bloom, et le facteur qui traduit l’ancien sur-eclat du Soleil`,
      )

      // --- Bornage ------------------------------------------------------------
      t.checkTrue(
        'la courbe borne a 1 quelle que soit la radiance',
        [10, 100, 1e6].every((x) => displayTransform([x, x, x]).every((v) => v <= 1)),
      )
      t.checkTrue(
        'la courbe ne rend jamais de valeur negative',
        displayTransform([1e-9, 0, 0.5]).every((v) => v >= 0),
      )

      // --- La re-saturation preserve la luminance ------------------------------
      // C'est cette propriete qui rend l'inverse analytique : sans elle, il
      // faudrait resoudre un systeme couple sur les trois canaux.
      for (const c of [[0.3, 0.5, 0.7], [0.9, 0.2, 0.1]] as const) {
        const mapped = displayTransform(radianceFromDisplay(c))
        t.checkRelative(`la luminance survit a la re-saturation (${c.join(', ')})`, luma(mapped), luma(c), 1e-9)
      }
      // ⚠️ **Ce controle epinglait 1,4**, la valeur heritee de l'atmosphere
      // artistique. Elle envoyait un canal sous zero sur 3,7 % du ciel a dix
      // degres de depression solaire et jusqu'a 12,9 % a quatorze — la bande de
      // l'horizon devenait un aplat sans degrade. Voir `tonemap.ts` pour la
      // mesure complete.
      //
      // Ce qui est epingle maintenant n'est plus une valeur mais une
      // **propriete** : la chaine d'affichage ne retouche pas la saturation.
      // Toute valeur superieure a un reintroduirait le meme ecretage.
      t.check('la chaine d’affichage ne retouche pas la saturation', DISPLAY_SATURATION, 1, 0)

      // Et la propriete qui le justifie : aucune couleur affichable ne doit
      // pouvoir sortir du domaine par la seule re-saturation.
      let worstNegative = 0
      for (let r = 0; r <= 1.0001; r += 0.1) {
        for (let g = 0; g <= 1.0001; g += 0.1) {
          for (let b = 0; b <= 1.0001; b += 0.1) {
            const luminance = luma([r, g, b])
            for (const v of [r, g, b]) {
              worstNegative = Math.min(worstNegative, luminance + (v - luminance) * DISPLAY_SATURATION)
            }
          }
        }
      }
      t.check('aucun canal ne sort du domaine par la re-saturation', worstNegative, 0, 0)

      // --- Regime des faibles valeurs -----------------------------------------
      // Aux faibles radiances la courbe est quasi lineaire, de pente 0,03/0,14.
      // C'est ce qui fait que l'addition de deux sources tenues — une etoile sur
      // le fond de ciel — reste approximativement additive apres la migration.
      // La pente limite vaut 0,03/0,14. Il faut descendre bien sous 10⁻⁴ pour
      // la mesurer : a 10⁻⁴ les termes quadratiques pesent encore 0,8 %.
      const slope = displayTransform([1e-9, 1e-9, 1e-9])[1] / 1e-9
      t.checkRelative('pente de la courbe a l’origine', slope, 0.03 / 0.14, 1e-6)
      t.note(
        `pente a l’origine : ${slope.toFixed(4)} — l’additivite des sources tenues ` +
          `(etoiles, halos) est donc preservee a la migration`,
      )
    },
  )
}
