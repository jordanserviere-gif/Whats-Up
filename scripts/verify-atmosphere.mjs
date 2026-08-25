/**
 * Validation numerique du moteur atmospherique.
 *
 * Ne charge ni Three.js pour rendre, ni DOM, ni contexte GPU : le moteur
 * physique doit etre verifiable sans regarder l'ecran. C'est ce qui permet de
 * repondre par un nombre a « quelle pression a 10 km ? » ou « quelle profondeur
 * optique Rayleigh a 550 nm ? ».
 *
 * Les suites vivent a cote des modules qu'elles valident et sont recensees dans
 * `src/atmosphere/validation/suites.ts`. Ce script ne fait que les executer et
 * les mettre en forme.
 *
 * Usage : npm run verify:atmosphere
 *         npm run verify:atmosphere -- refraction     (filtre sur le nom)
 */
import { allSuites } from '../src/atmosphere/validation/suites.ts'
import { totalChecks, totalFailures } from '../src/atmosphere/validation/harness.ts'

const filter = process.argv[2]?.toLowerCase()
const suites = allSuites().filter((s) => !filter || s.name.toLowerCase().includes(filter))

if (suites.length === 0) {
  console.log(`Aucune suite ne correspond a « ${filter} ».`)
  process.exit(1)
}

/** Ecart formate dans l'unite du controle. */
function formatDelta(check) {
  if (check.kind === 'booleen' || check.kind === 'monotonie') return ''
  const suffix = check.kind === 'relatif' ? '' : check.unit
  return `ecart ${check.delta.toExponential(2)}${suffix} (tol. ${check.tolerance.toExponential(1)}${suffix})`
}

let width = 0
for (const s of suites) for (const c of s.checks) width = Math.max(width, c.label.length)
width = Math.min(width, 62)

for (const s of suites) {
  console.log(`\n=== ${s.name} ===`)
  if (s.reference) console.log(`    reference : ${s.reference}`)
  console.log('')

  for (const c of s.checks) {
    const status = c.ok ? 'OK   ' : 'ECHEC'
    const kind = c.kind === 'relatif' ? ' [rel]' : ''
    console.log(`${status} ${c.label.padEnd(width)} ${formatDelta(c)}${kind}`)
    // Le detail ne s'affiche qu'en cas d'echec, ou lorsqu'il porte une mesure
    // qu'on veut lire meme quand tout va bien (invariants qualitatifs).
    if (c.detail && (!c.ok || c.kind === 'booleen')) {
      console.log(`      ${c.detail.replace(/\n/g, '\n      ')}`)
    }
    if (!c.ok && c.actual !== null && c.expected !== null) {
      console.log(`      obtenu ${c.actual} — attendu ${c.expected}`)
    }
  }

  for (const note of s.notes) console.log(`  · ${note}`)
}

const failures = totalFailures(suites)
const checks = totalChecks(suites)

console.log(
  `\n${checks} controle(s) sur ${suites.length} suite(s) — ` +
    (failures === 0 ? 'aucun echec.' : `${failures} ECHEC(S).`),
)

process.exit(failures === 0 ? 0 : 1)
