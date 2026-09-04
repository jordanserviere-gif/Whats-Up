/**
 * Validation du micro-relief — une texture inventee, mais pas n'importe comment.
 *
 * ## Ce qui se valide d'un motif faux
 *
 * Pas sa ressemblance : il ne ressemble a rien, et c'est assume. Ce qui se
 * valide, c'est **son amplitude**, **sa normalisation** et **son absence de
 * structure** — les trois choses qui font la difference entre un grain credible
 * et un motif qu'on reconnait.
 *
 * ⚠️ Le nuanceur, lui, ne se valide pas : ces controles portent sur le miroir
 * TypeScript des memes fonctions. Ils attrapent une erreur de calibration ou de
 * hachage, pas une divergence entre les deux ecritures.
 */
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import {
  MICRO_CELLS_PER_FOOTPRINT,
  MICRO_GRADIENT_RMS,
  MICRO_RELIEF_GLSL,
  MICRO_SLOPE_RMS,
  microGradient,
  microHash,
  microNoise,
} from './microRelief'

/**
 * Pente efficace mesuree sur des tuiles RGE ALTI a 3,4 m, par site.
 *
 * C'est l'enveloppe dans laquelle une amplitude inventee reste plausible.
 */
const MESURES = [
  { site: 'Beauce', pente: 0.012 },
  { site: 'Camargue', pente: 0.017 },
  { site: 'Landes', pente: 0.017 },
  { site: 'vallee du Rhone', pente: 0.087 },
  { site: 'mont Ventoux', pente: 0.291 },
]

/** Suite pseudo-aleatoire deterministe, pour echantillonner le bruit. */
function* points(n: number): Generator<[number, number]> {
  for (let i = 0; i < n; i++) {
    yield [(i * 0.61803398875) % 997.3, (i * 0.38196601125 + 13.7) % 991.7]
  }
}

export function microReliefSuite(): SuiteResult {
  return suite(
    'Micro-relief du sol (texture inventee)',
    { reference: 'pente efficace mesuree sur tuiles RGE ALTI a 3,4 m — Beauce, Camargue, Landes, Rhone, Ventoux' },
    (t) => {
      // --- L'amplitude tombe dans ce qu'une plaine a vraiment ---------------
      const plaines = MESURES.filter((m) => m.pente < 0.1)
      const min = Math.min(...plaines.map((m) => m.pente))
      const max = Math.max(...plaines.map((m) => m.pente))
      t.checkTrue(
        'l amplitude choisie tient dans l intervalle mesure des plaines',
        MICRO_SLOPE_RMS >= min && MICRO_SLOPE_RMS <= max,
        `${MICRO_SLOPE_RMS} contre ${min} en ${plaines[0].site} et ${max} en ${plaines[plaines.length - 1].site} — ` +
          `le motif est invente, son ampleur est plausible`,
      )
      t.checkTrue(
        'et reste bien en deca de la montagne',
        MICRO_SLOPE_RMS < 0.291 / 3,
        'une plaine ne doit pas rendre comme un eboulis du Ventoux',
      )

      // --- La normalisation, sans quoi l amplitude ne veut rien dire --------
      //
      // `MICRO_SLOPE_RMS` n'est une pente que si le gradient du bruit est
      // ramene a un ecart-type de un. La constante de normalisation est donc
      // une **mesure**, pas un reglage, et c'est ici qu'on la releve.
      let carres = 0
      let n = 0
      for (const [x, y] of points(200_000)) {
        const g = microGradient(x, y)
        carres += g.dx * g.dx + g.dy * g.dy
        n += 2
      }
      const mesure = Math.sqrt(carres / n)
      t.checkRelative('la constante de normalisation vaut le gradient mesure', MICRO_GRADIENT_RMS, mesure, 0.02)

      // Et la pente qui en resulte doit valoir l'amplitude visee.
      const penteRendue = mesure * (MICRO_SLOPE_RMS / MICRO_GRADIENT_RMS)
      t.checkRelative('la pente rendue vaut l amplitude visee', penteRendue, MICRO_SLOPE_RMS, 0.02)

      // --- Le hachage ne doit pas avoir de structure ------------------------
      //
      // ⚠️ **La premiere version en avait une, et elle se voyait.** Un hachage
      // en `sin(a·x + b·y)` est constant le long des droites `a·x + b·y = cte`,
      // et le sol se couvrait de hachures obliques. Le controle mesure la
      // correlation dans plusieurs directions, dont celle qui avait trahi.
      let moyenne = 0
      for (let i = 0; i < 40_000; i++) moyenne += microHash(i % 211, Math.floor(i / 211))
      moyenne /= 40_000
      t.check('le hachage est centre sur un demi', moyenne, 0.5, 0.02)

      const correlation = (dx: number, dy: number): number => {
        let sxy = 0
        let sx = 0
        let sy = 0
        let sxx = 0
        let syy = 0
        const m = 40_000
        for (let i = 0; i < m; i++) {
          const ix = i % 211
          const iy = Math.floor(i / 211)
          const a = microHash(ix, iy)
          const b = microHash(ix + dx, iy + dy)
          sxy += a * b
          sx += a
          sy += b
          sxx += a * a
          syy += b * b
        }
        const num = m * sxy - sx * sy
        const den = Math.sqrt((m * sxx - sx * sx) * (m * syy - sy * sy))
        return den > 0 ? num / den : 0
      }
      const directions: Array<[number, number, string]> = [
        [1, 0, 'est'],
        [0, 1, 'nord'],
        [1, 1, 'diagonale'],
        [3, -1, 'oblique'],
        [311, -127, 'la direction qui trahissait le sinus'],
      ]
      const pires = directions.map(([dx, dy, nom]) => ({ nom, r: Math.abs(correlation(dx, dy)) }))
      const pire = pires.reduce((a, b) => (b.r > a.r ? b : a))
      t.checkTrue(
        'le hachage n est correle dans aucune direction',
        pire.r < 0.05,
        pires.map((p) => `${p.nom} ${p.r.toFixed(3)}`).join(' ; '),
      )

      // --- Le bruit lui-meme -------------------------------------------------
      let hors = 0
      for (const [x, y] of points(50_000)) {
        const v = microNoise(x, y).value
        if (v < -1e-9 || v > 1 + 1e-9) hors++
      }
      t.check('le bruit reste dans [0, 1]', hors, 0, 0, ' points')

      // Le gradient analytique doit valoir la difference finie, sans quoi la
      // normale serait perturbee dans une direction qui n'est pas la pente.
      let pireEcart = 0
      const h = 1e-4
      for (const [x, y] of points(2_000)) {
        const g = microNoise(x, y)
        const dx = (microNoise(x + h, y).value - microNoise(x - h, y).value) / (2 * h)
        const dy = (microNoise(x, y + h).value - microNoise(x, y - h).value) / (2 * h)
        pireEcart = Math.max(pireEcart, Math.abs(dx - g.dx), Math.abs(dy - g.dy))
      }
      t.check('le gradient analytique vaut la difference finie', pireEcart, 0, 1e-4)

      // --- ⚠️ Le gabarit GLSL -----------------------------------------------
      //
      // Un nombre entier injecte dans le nuanceur s'ecrit sans point decimal, et
      // GLSL refuse alors de l'affecter a un `float` : le fragment ne compile
      // plus et le terrain **disparait**. Le defaut ne se montre jamais pendant
      // qu'on regle une valeur fractionnaire, et toujours quand on la met a zero
      // pour comparer — ce qui est arrive.
      const constantes = [...MICRO_RELIEF_GLSL.matchAll(/const float (\w+) = ([^;]+);/g)]
      const sansPoint = constantes.filter((m) => !m[2].includes('.'))
      t.checkTrue(
        'toute constante flottante du nuanceur porte un point decimal',
        constantes.length >= 3 && sansPoint.length === 0,
        constantes.length === 0
          ? 'aucune constante trouvee — le gabarit a change'
          : constantes.map((m) => `${m[1]} = ${m[2]}`).join(' ; '),
      )
      t.checkTrue(
        'le nuanceur n emploie pas de hachage en sinus d une somme',
        !/sin\s*\([^)]*\*\s*127\.1/.test(MICRO_RELIEF_GLSL),
        'le hachage trigonometrique correlait le long des diagonales',
      )
      t.note(
        `maille du bruit : ${MICRO_CELLS_PER_FOOTPRINT} par empreinte de pixel, ` +
          'quantifiee en octaves pour que le motif ne nage pas quand la camera bouge',
      )
      t.note(
        'contraste local mesure au Ventoux vers la plaine : sol proche 0,16 -> 5,64 ; ' +
          'plaine lointaine 0,27 -> 0,28 — au loin le voile efface la texture, et c est correct',
      )
    },
  )
}
