/**
 * Publication d'une version — numero, journal, tag.
 *
 * Le numero suit SemVer et se deduit des commits depuis le dernier tag, qui
 * suivent la convention `type(portee): sujet` :
 *
 * - `feat` → version mineure ; `fix` et `perf` → correctif ;
 * - un `!` apres le type, ou `BREAKING CHANGE` dans le corps → majeure. Tant
 *   que le projet est en 0.x, une rupture ne fait monter que la mineure :
 *   c'est l'usage SemVer d'avant la 1.0.
 *
 * Le script met a jour `package.json` (et `package-lock.json`), ajoute la
 * section de la version en tete de `CHANGELOG.md`, commite, et pose un tag
 * annote `vX.Y.Z`.
 *
 * Usage :
 *   npm run release                 version deduite, commit et tag locaux
 *   npm run release -- --dry        apercu, rien n'est ecrit
 *   npm run release -- --push       pousse aussi le commit et le tag
 *   npm run release -- --as minor   impose le niveau (major, minor, patch)
 *   npm run release -- --version 0.2.0   impose le numero
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const option = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

if (!flag('dry') && git('status', '--porcelain') !== '') {
  console.error('Des modifications ne sont pas commitees : commite-les ou mets-les de cote avant une version.')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
let lastTag = null
try {
  lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*')
} catch {
  lastTag = null
}
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD'
const SEP = '\u001f'
const END = '\u001e'
const log = git('log', range, `--format=%h${SEP}%s${SEP}%b${END}`, '--no-merges')
const commits = log
  .split(END)
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => {
    const [hash, subject, body = ''] = c.split(SEP)
    const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject)
    return {
      hash,
      type: m ? m[1] : 'autre',
      scope: m ? m[2] ?? null : null,
      breaking: Boolean(m && m[3]) || /BREAKING CHANGE/.test(body),
      subject: m ? m[4] : subject,
    }
  })
  .filter((c) => !(c.type === 'chore' && c.scope === 'release'))

if (commits.length === 0 && !option('version')) {
  console.log(`Rien de neuf depuis ${lastTag} : pas de version a publier.`)
  process.exit(0)
}

// --- Numero --------------------------------------------------------------------
const [major, minor, patch] = pkg.version.split('.').map(Number)
let level = option('as')
if (!level) {
  if (commits.some((c) => c.breaking)) level = major === 0 ? 'minor' : 'major'
  else if (commits.some((c) => c.type === 'feat')) level = 'minor'
  else level = 'patch'
}
const bumped = {
  major: `${major + 1}.0.0`,
  minor: `${major}.${minor + 1}.0`,
  patch: `${major}.${minor}.${patch + 1}`,
}
// Premiere version : le numero du paquet tel qu'il est, sans le faire monter.
const version = option('version') ?? (lastTag ? bumped[level] : pkg.version)
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Numero invalide : ${version}`)
  process.exit(1)
}

// --- Journal -------------------------------------------------------------------
const SECTIONS = [
  ['feat', 'Nouveautes'],
  ['fix', 'Corrections'],
  ['perf', 'Performances'],
  ['refactor', 'Reorganisation du code'],
  ['style', 'Apparence'],
  ['docs', 'Documentation'],
]
const date = new Date().toISOString().slice(0, 10)
const lines = [`## v${version} — ${date}`, '']
const breaking = commits.filter((c) => c.breaking)
if (breaking.length) {
  lines.push('### Ruptures', '', ...breaking.map((c) => `- ${c.scope ? `**${c.scope}** : ` : ''}${c.subject} (${c.hash})`), '')
}
for (const [type, title] of SECTIONS) {
  const items = commits.filter((c) => c.type === type)
  if (!items.length) continue
  lines.push(`### ${title}`, '', ...items.map((c) => `- ${c.scope ? `**${c.scope}** : ` : ''}${c.subject} (${c.hash})`), '')
}
const section = lines.join('\n')

if (flag('dry')) {
  console.log(`Derniere version : ${lastTag ?? 'aucune'} — ${commits.length} commit(s) — niveau ${lastTag ? level : 'premiere'}`)
  console.log(`Prochaine : v${version}\n`)
  console.log(section)
  process.exit(0)
}

const HEADER = '# Journal des versions\n\nChaque version est un tag `vX.Y.Z`, publie par `npm run release`.\n\n'
const previous = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8').replace(HEADER, '') : ''
writeFileSync('CHANGELOG.md', `${HEADER}${section}\n${previous}`)

pkg.version = version
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
if (existsSync('package-lock.json')) {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  lock.version = version
  if (lock.packages?.['']) lock.packages[''].version = version
  writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`)
}

git('add', 'CHANGELOG.md', 'package.json', ...(existsSync('package-lock.json') ? ['package-lock.json'] : []))
git('commit', '-m', `chore(release): v${version}`)
git('tag', '-a', `v${version}`, '-m', `v${version}\n\n${section}`)
console.log(`Version v${version} : commit et tag crees.`)

if (flag('push')) {
  git('push', 'origin', 'HEAD')
  git('push', 'origin', `v${version}`)
  console.log('Commit et tag pousses.')
} else {
  console.log(`Pour publier : git push origin HEAD && git push origin v${version}  (ou npm run release -- --push la prochaine fois)`)
}
