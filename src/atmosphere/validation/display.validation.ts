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
import { RELIEF_MAX_TILT_DEG, maxLambertUnderTilt } from '@/scene/bodies/surfaceRelief'
import { SKY_RADIANCE_GLSL } from '@/scene/display/skyRadiance'
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

      // --- Une seule expression de la radiance du ciel -------------------------
      //
      // ⚠️ **Le defaut que ce controle existe pour empecher.** Cette grandeur
      // etait ecrite deux fois : le fond de ciel additionnait diffusion, airglow
      // et termes peints, le disque d'un astre ne reprenait que la diffusion. Or
      // un corps au-dela de l'atmosphere n'occulte rien — tout est devant lui —
      // et sa face nuit, qui n'emet rien, doit rendre exactement le ciel.
      //
      // Mesure du defaut : six niveaux sur 255 entre la face nuit d'une Lune de
      // jour et le bleu voisin, la ou une photographie ne les distingue pas.
      //
      // La propriete se verifie **sur la source**, faute de pouvoir executer du
      // GLSL ici : `aerialPerspectiveToSpace` ne doit avoir qu'un seul appelant,
      // le module qui porte l'expression unique. Tout materiau qui remplace le
      // ciel sur ses pixels passe par lui.
      // La suite tourne sous Node ; le projet n'embarque pas ses declarations de
      // types, d'ou cet acces direct plutot qu'un import.
      const readFileSync = (
        globalThis as unknown as {
          require?: (m: string) => { readFileSync: (p: string, e: string) => string }
        }
      ).require?.('node:fs').readFileSync
      const scanned = [
        'src/scene/SkyBackground.tsx',
        'src/scene/Bodies.tsx',
        'src/scene/Aircraft.tsx',
        'src/scene/Satellites.tsx',
        'src/scene/Starfield.tsx',
        'src/scene/DeepSky.tsx',
        'src/scene/Globe.tsx',
        'src/scene/Terrain.tsx',
      ]
      const callers = scanned.filter((file) => {
        try {
          return readFileSync?.(file, 'utf8').includes('aerialPerspectiveToSpace(') ?? false
        } catch {
          return false
        }
      })
      t.check(
        'la radiance du ciel n’a qu’une expression',
        callers.length,
        0,
        0,
        ` appel(s) direct(s) a aerialPerspectiveToSpace hors du module partage${
          callers.length ? ' : ' + callers.join(', ') : ''
        }`,
      )
      t.checkTrue(
        'et le module partage la porte bien en entier',
        ['aerialPerspectiveToSpace(', 'uAirglowZenith', 'sampleSkyView(', 'uPollution'].every(
          (term) => SKY_RADIANCE_GLSL.includes(term),
        ),
        'diffusion solaire, airglow, ciel lunaire et halo urbain reunis dans skyRadianceToSpace',
      )

      // --- Le clair de lune n'est plus peint --------------------------------
      //
      // ⚠️ Il l'a ete : `uMoonGlow × uMoonFactor × (0,25 + 0,75·cos⁶)`, une
      // couleur d'interface et un cosinus a la puissance six. Il portait **3 a
      // 25 %** de la luminance du ciel une heure et demie apres le coucher au
      // Ventoux, et ne connaissait ni l'extinction, ni la diffusion de Mie vers
      // l'avant, ni le bleuissement loin de la source.
      //
      // Le controle tient l'absence, faute de pouvoir mesurer des pixels hors
      // du navigateur : un terme peint qui reviendrait porterait a nouveau ces
      // deux noms.
      t.checkTrue(
        'le halo lunaire peint a disparu de l expression du ciel',
        !SKY_RADIANCE_GLSL.includes('uMoonGlow') && !SKY_RADIANCE_GLSL.includes('uMoonFactor'),
        'le clair de lune passe par la table de ciel, avec la Lune pour source',
      )
      t.note(
        'le controle est structurel : il tient l’unicite de l’expression, non l’egalite ' +
          'numerique des pixels, qu’on ne peut pas mesurer hors du navigateur',
      )

      // --- Le relief simule ne peut pas inventer de lumiere --------------------
      //
      // ⚠️ La carte d'albedo sert de carte de hauteur : un cratere accroche la
      // lumiere rasante parce que son albedo varie, non parce que le sol monte.
      // Sans borne, cette perturbation atteignait quarante-deux degres, et la
      // face nuit d'un croissant s'allumait — jusqu'a **48 niveaux sur 255**
      // au-dessus du ciel, et d'autant plus qu'on grossissait.
      //
      // La propriete est purement geometrique : sous `λ = −sin(pente)`, aucune
      // normale du cone ne peut voir le Soleil.
      const beyond = -Math.sin((RELIEF_MAX_TILT_DEG * Math.PI) / 180) - 1e-9
      let worstLeak = -1
      for (let lambda = -1; lambda <= beyond; lambda += 0.01) {
        worstLeak = Math.max(worstLeak, maxLambertUnderTilt(lambda))
      }
      t.checkTrue(
        'au-dela de la pente admise, aucune bosse ne capte le Soleil',
        worstLeak <= 0,
        `incidence maximale ${worstLeak.toExponential(2)} sous ${RELIEF_MAX_TILT_DEG}° de pente — ` +
          'la face nuit reste noire quel que soit le zoom',
      )
      // Et la bande ou elle en capte encore est bien celle du terminateur.
      t.checkTrue(
        'et pres du terminateur elle en capte',
        maxLambertUnderTilt(-0.1) > 0,
        `a 6° sous l’horizon local, une pente de ${RELIEF_MAX_TILT_DEG}° rend ` +
          `${maxLambertUnderTilt(-0.1).toFixed(3)} — c’est le relief qui accroche la lumiere rasante`,
      )
    },
  )
}
