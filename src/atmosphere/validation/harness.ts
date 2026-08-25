/**
 * Harnais de validation numerique du moteur atmospherique.
 *
 * **Le moteur physique ne doit pas etre testable uniquement en regardant
 * l'ecran.** Ce harnais est le moyen de repondre par un nombre a des questions
 * comme « quelle pression obtient-on a 10 km ? » ou « quelle profondeur optique
 * Rayleigh a 550 nm ? ». Il ne depend ni de Three.js, ni du DOM, ni d'un
 * contexte GPU : les suites tournent dans Node.
 *
 * Il suit deliberement l'esprit de `scripts/verify-astro.mjs` — meme style de
 * sortie, meme code de retour — mais rend des **donnees** plutot que d'imprimer
 * directement. Une suite est ainsi consommable par autre chose qu'un terminal :
 * un rapport, une comparaison entre deux versions du moteur, un tableau de
 * bord. Le formatage vit dans le script, pas ici.
 *
 * Quatre formes de controle, et le choix entre elles n'est pas cosmetique :
 *
 * - `check` — ecart **absolu**, quand la tolerance a un sens physique dans
 *   l'unite de la grandeur (« la pression a 11 km, a 1 Pa pres »).
 * - `checkRelative` — ecart **relatif**, quand la grandeur couvre plusieurs
 *   ordres de grandeur. Une tolerance absolue de 1 Pa serait triviale a 0 km
 *   et impossible a 80 km, ou la pression vaut 0,37 Pa.
 * - `checkTrue` — invariant booleen, quand il n'y a pas de nombre a comparer.
 * - `checkMonotonic` — monotonie d'une serie. C'est le controle le plus utile
 *   du lot : il ne demande **aucune reference externe** et attrape les erreurs
 *   de signe, qui sont les plus frequentes et les plus invisibles a l'oeil.
 */

export type CheckKind = 'absolu' | 'relatif' | 'booleen' | 'monotonie'

export interface CheckResult {
  ok: boolean
  label: string
  kind: CheckKind
  /** Valeur obtenue. `null` pour un controle booleen ou de monotonie. */
  actual: number | null
  /** Valeur attendue. `null` pour un controle booleen ou de monotonie. */
  expected: number | null
  /** Ecart mesure, dans l'unite du controle (sans dimension si relatif). */
  delta: number
  tolerance: number
  unit: string
  /** Precision libre affichee sous le controle, notamment en cas d'echec. */
  detail?: string
}

export interface SuiteResult {
  name: string
  /** Reference scientifique de la suite, affichee dans le rapport. */
  reference?: string
  checks: CheckResult[]
  notes: string[]
  failures: number
}

export interface SuiteTools {
  /** Ecart absolu, exprime dans l'unite de la grandeur. */
  check(label: string, actual: number, expected: number, tolerance: number, unit?: string): void
  /** Ecart relatif : `|actual − expected| / |expected|`. `tolerance` est une fraction (1e-3 = 0,1 %). */
  checkRelative(label: string, actual: number, expected: number, tolerance: number, unit?: string): void
  /** Invariant sans valeur numerique associee. */
  checkTrue(label: string, condition: boolean, detail?: string): void
  /**
   * Monotonie stricte d'une serie. `direction` vaut `'croissant'` ou
   * `'decroissant'`. Rend l'indice et les valeurs de la premiere violation.
   */
  checkMonotonic(label: string, values: readonly number[], direction: 'croissant' | 'decroissant'): void
  /** Observation chiffree, sans jugement — pour documenter une valeur obtenue. */
  note(text: string): void
}

/**
 * Definit une suite de controles.
 *
 * Une exception levee dans le corps n'interrompt pas la campagne : elle est
 * convertie en echec. Un solveur qui explose sur un cas limite doit apparaitre
 * comme un test rouge parmi les autres, pas faire tomber tout le rapport et
 * masquer les suites suivantes.
 */
export function suite(
  name: string,
  options: { reference?: string },
  body: (t: SuiteTools) => void,
): SuiteResult {
  const checks: CheckResult[] = []
  const notes: string[] = []

  const push = (r: CheckResult) => checks.push(r)

  const tools: SuiteTools = {
    check(label, actual, expected, tolerance, unit = '') {
      const delta = Math.abs(actual - expected)
      push({
        ok: Number.isFinite(delta) && delta <= tolerance,
        label,
        kind: 'absolu',
        actual,
        expected,
        delta,
        tolerance,
        unit,
      })
    },

    checkRelative(label, actual, expected, tolerance, unit = '') {
      // Un attendu nul n'a pas d'ecart relatif defini : on retombe sur l'absolu
      // plutot que de rendre une division par zero deguisee en reussite.
      const denominator = Math.abs(expected)
      const delta = denominator > 0 ? Math.abs(actual - expected) / denominator : Math.abs(actual - expected)
      push({
        ok: Number.isFinite(delta) && delta <= tolerance,
        label,
        kind: denominator > 0 ? 'relatif' : 'absolu',
        actual,
        expected,
        delta,
        tolerance,
        unit,
      })
    },

    checkTrue(label, condition, detail) {
      push({
        ok: condition,
        label,
        kind: 'booleen',
        actual: null,
        expected: null,
        delta: condition ? 0 : 1,
        tolerance: 0,
        unit: '',
        ...(detail ? { detail } : {}),
      })
    },

    checkMonotonic(label, values, direction) {
      let violation = -1
      for (let i = 1; i < values.length; i++) {
        const rising = values[i] > values[i - 1]
        if (direction === 'croissant' ? !rising : rising) {
          violation = i
          break
        }
      }
      const ok = violation < 0 && values.length > 1
      push({
        ok,
        label,
        kind: 'monotonie',
        actual: null,
        expected: null,
        delta: ok ? 0 : 1,
        tolerance: 0,
        unit: '',
        ...(violation >= 0
          ? {
              detail: `rupture a l'indice ${violation} : ${values[violation - 1].toExponential(4)} → ${values[
                violation
              ].toExponential(4)}`,
            }
          : values.length <= 1
            ? { detail: 'serie trop courte pour etre monotone' }
            : {}),
      })
    },

    note(text) {
      notes.push(text)
    },
  }

  try {
    body(tools)
  } catch (error) {
    push({
      ok: false,
      label: 'exception levee pendant la suite',
      kind: 'booleen',
      actual: null,
      expected: null,
      delta: 1,
      tolerance: 0,
      unit: '',
      detail: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    })
  }

  return {
    name,
    ...(options.reference ? { reference: options.reference } : {}),
    checks,
    notes,
    failures: checks.filter((c) => !c.ok).length,
  }
}

/** Total des echecs d'une campagne. */
export const totalFailures = (suites: readonly SuiteResult[]): number =>
  suites.reduce((sum, s) => sum + s.failures, 0)

/** Total des controles d'une campagne. */
export const totalChecks = (suites: readonly SuiteResult[]): number =>
  suites.reduce((sum, s) => sum + s.checks.length, 0)
