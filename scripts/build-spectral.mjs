/**
 * Genere les donnees spectrales embarquees dans src/data/ :
 *  - cie1931.json    : fonctions colorimetriques CIE 1931 2°, 360–830 nm a 1 nm
 *  - solar-am0.json  : irradiance solaire spectrale hors atmosphere (AM0)
 *  - ozone-cross-section.json : sections efficaces d'absorption de l'ozone
 *
 * Usage : npm run data:spectral
 *
 * Comme les catalogues d'etoiles, les fichiers generes sont **commites** :
 * l'application n'a besoin d'aucun reseau a l'execution.
 *
 * ## Pourquoi telecharger plutot que saisir
 *
 * Ces deux tables sont des donnees scientifiques de reference, longues de
 * plusieurs centaines de lignes. Les recopier a la main — ou de memoire —
 * introduirait des erreurs indetectables : une valeur fausse au milieu d'une
 * courbe de sensibilite ne se voit sur aucune image, mais decale toutes les
 * couleurs du moteur. On les prend donc a la source, avec leur provenance.
 *
 * ## Sources
 *
 * **CIE 1931 2° standard observer** — via `colour-science/colour`
 * (BSD-3-Clause), qui republie la table CIE a 1 nm. C'est la fonction de
 * reponse de l'oeil humain moyen : elle transforme un spectre en trois nombres,
 * et c'est le dernier maillon du moteur avant l'ecran.
 *
 * **ASTM G173-03, colonne « extraterrestrial »** — via `pvlib/pvlib-python`
 * (BSD-3-Clause). C'est le spectre solaire hors atmosphere a 1 UA, derive de
 * l'ASTM E-490, en W/m²/nm, tabule de 280 a 4000 nm.
 *
 * > **L'integrale de la table ne vaut PAS la constante solaire, et c'est
 * > normal.** Elle donne 1347,9 W/m² sur 280–4000 nm, contre 1361 W/m² de
 * > constante solaire (TSI moderne, SORCE/TIM). Les 13,1 W/m² manquants —
 * > 0,96 % — sont l'infrarouge lointain au-dela de 4 µm et l'ultraviolet sous
 * > 280 nm, hors du domaine tabule. Confondre les deux nombres reviendrait a
 * > renormaliser la table de 1 % pour rien.
 * >
 * > Le domaine qui interesse le moteur, 360–830 nm, porte **734,8 W/m²**, soit
 * > 54,5 % du tabule.
 *
 * **Sections efficaces de l'ozone** — spectres de reference de l'IUP Bremen
 * (*o3spectra2011*, 233 K), moyennes par intervalle de 10 nm de 360 a 830 nm,
 * republies par `ebruneton/precomputed_atmospheric_scattering` (BSD-3-Clause).
 *
 * C'est la **bande de Chappuis** : une absorption large et modeste, culminant a
 * 5,0·10⁻²⁵ m² vers 600 nm — donc dans l'orange. Elle retire au ciel
 * precisement les longueurs d'onde que la diffusion Rayleigh lui laisse, et
 * c'est elle, non Rayleigh, qui fait le bleu du ciel crepusculaire (Hulburt,
 * 1953).
 *
 * > La temperature de 233 K est celle de la stratosphere, ou vit l'ozone. La
 * > bande de Chappuis depend peu de la temperature — quelques pour cent entre
 * > 200 et 300 K — ce qui rend ce choix sans consequence ici, contrairement aux
 * > bandes ultraviolettes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'scripts', '.cache')
const OUT = join(ROOT, 'src', 'data')

const SOURCES = {
  cmfs: 'https://raw.githubusercontent.com/colour-science/colour/develop/colour/colorimetry/datasets/cmfs.py',
  solar: 'https://raw.githubusercontent.com/pvlib/pvlib-python/main/pvlib/data/ASTMG173.csv',
  ozone: 'https://raw.githubusercontent.com/ebruneton/precomputed_atmospheric_scattering/master/atmosphere/demo/demo.cc',
}

mkdirSync(CACHE, { recursive: true })
mkdirSync(OUT, { recursive: true })

async function cached(key, url) {
  const path = join(CACHE, key)
  if (existsSync(path)) return readFileSync(path, 'utf8')
  process.stdout.write(`telechargement ${key}… `)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  const text = await res.text()
  writeFileSync(path, text)
  console.log(`${(text.length / 1e3).toFixed(0)} ko`)
  return text
}

// ---------------------------------------------------------------------------
// CIE 1931 2° standard observer
// ---------------------------------------------------------------------------

function parseColourMatchingFunctions(source) {
  // Le fichier amont est du Python : un dictionnaire de dictionnaires, dont on
  // extrait la seule section qui nous interesse. On decoupe donc sur les
  // en-tetes de section plutot que d'essayer d'interpreter la syntaxe.
  const start = source.indexOf('"CIE 1931 2 Degree Standard Observer": {')
  if (start < 0) throw new Error('section « CIE 1931 2 Degree Standard Observer » introuvable en amont')

  // La section suivante commence a la prochaine cle de meme niveau.
  const rest = source.slice(start + 40)
  const end = rest.search(/^ {4}"/m)
  const body = end < 0 ? rest : rest.slice(0, end)

  const lambdaNm = []
  const x = []
  const y = []
  const z = []

  const entry = /^\s*(\d+):\s*\(\s*([-\d.eE+]+),\s*([-\d.eE+]+),\s*([-\d.eE+]+),?\s*\)/gm
  let match
  while ((match = entry.exec(body)) !== null) {
    lambdaNm.push(Number(match[1]))
    x.push(Number(match[2]))
    y.push(Number(match[3]))
    z.push(Number(match[4]))
  }

  if (lambdaNm.length === 0) throw new Error('aucune entree extraite des fonctions colorimetriques')
  return { lambdaNm, x, y, z }
}

// ---------------------------------------------------------------------------
// Spectre solaire hors atmosphere
// ---------------------------------------------------------------------------

function parseSolarSpectrum(csv) {
  const lines = csv.split(/\r?\n/)
  // Ligne 1 : titre. Ligne 2 : noms de colonnes. Donnees ensuite.
  const header = lines[1].split(',').map((s) => s.trim().toLowerCase())
  const wavelengthColumn = header.indexOf('wavelength')
  const extraterrestrialColumn = header.indexOf('extraterrestrial')
  if (wavelengthColumn < 0 || extraterrestrialColumn < 0) {
    throw new Error(`colonnes attendues introuvables dans l'en-tete : ${lines[1]}`)
  }

  const lambdaNm = []
  const irradiance = []
  for (const line of lines.slice(2)) {
    if (!line.trim()) continue
    const cells = line.split(',')
    const lambda = Number(cells[wavelengthColumn])
    const value = Number(cells[extraterrestrialColumn])
    if (!Number.isFinite(lambda) || !Number.isFinite(value)) continue
    lambdaNm.push(lambda)
    irradiance.push(value)
  }

  if (lambdaNm.length === 0) throw new Error('aucune entree extraite du spectre solaire')
  return { lambdaNm, irradiance }
}

// ---------------------------------------------------------------------------
// Sections efficaces de l'ozone
// ---------------------------------------------------------------------------

function parseOzoneCrossSection(source) {
  const start = source.indexOf('kOzoneCrossSection')
  if (start < 0) throw new Error('table « kOzoneCrossSection » introuvable en amont')
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  const values = source
    .slice(open + 1, close)
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v))

  if (values.length === 0) throw new Error('aucune valeur extraite des sections efficaces de l’ozone')

  // Les valeurs sont des moyennes par intervalle de 10 nm a partir de 360 nm.
  // On rend le **centre** de chaque intervalle : c'est la que la moyenne d'une
  // fonction lisse est atteinte, et c'est ce qu'attend une interpolation.
  const lambdaNm = values.map((_, i) => 365 + 10 * i)
  return { lambdaNm, crossSection: values }
}

/** Integrale trapezoidale d'une serie echantillonnee, pour le controle de coherence. */
function integrate(lambdaNm, values) {
  let total = 0
  for (let i = 1; i < lambdaNm.length; i++) {
    total += ((values[i] + values[i - 1]) / 2) * (lambdaNm[i] - lambdaNm[i - 1])
  }
  return total
}

// ---------------------------------------------------------------------------

const cmfs = parseColourMatchingFunctions(await cached('cmfs.py', SOURCES.cmfs))
const solar = parseSolarSpectrum(await cached('astmg173.csv', SOURCES.solar))
const ozone = parseOzoneCrossSection(await cached('bruneton-demo.cc', SOURCES.ozone))

const cmfsOut = {
  source: 'CIE 1931 2° standard observer, via colour-science/colour (BSD-3-Clause)',
  url: SOURCES.cmfs,
  unit: 'sans dimension',
  ...cmfs,
}

const solarOut = {
  source: 'ASTM G173-03, colonne « extraterrestrial » (AM0, 1 UA), via pvlib/pvlib-python (BSD-3-Clause)',
  url: SOURCES.solar,
  unit: 'W/m²/nm',
  ...solar,
}

const ozoneOut = {
  source:
    'Sections efficaces d’absorption de l’ozone, IUP Bremen o3spectra2011 a 233 K, ' +
    'moyennees par intervalle de 10 nm, via ebruneton/precomputed_atmospheric_scattering (BSD-3-Clause)',
  url: SOURCES.ozone,
  unit: 'm²',
  ...ozone,
}

writeFileSync(join(OUT, 'cie1931.json'), `${JSON.stringify(cmfsOut)}\n`)
writeFileSync(join(OUT, 'solar-am0.json'), `${JSON.stringify(solarOut)}\n`)
writeFileSync(join(OUT, 'ozone-cross-section.json'), `${JSON.stringify(ozoneOut)}\n`)

// --- Controles de coherence a la generation --------------------------------
// Ils ne remplacent pas la suite de validation : ils attrapent une source amont
// qui aurait change de format ou de contenu, avant que le fichier ne soit
// commite.

const step = cmfs.lambdaNm[1] - cmfs.lambdaNm[0]
const integralY = integrate(cmfs.lambdaNm, cmfs.y)
const totalIrradiance = integrate(solar.lambdaNm, solar.irradiance)

console.log(`\nCIE 1931 2° : ${cmfs.lambdaNm.length} entrees, ${cmfs.lambdaNm[0]}–${cmfs.lambdaNm[cmfs.lambdaNm.length - 1]} nm, pas ${step} nm`)
console.log(`  ∫x̄ = ${integrate(cmfs.lambdaNm, cmfs.x).toFixed(3)}   ∫ȳ = ${integralY.toFixed(3)}   ∫z̄ = ${integrate(cmfs.lambdaNm, cmfs.z).toFixed(3)}`)
console.log(`  pic de ȳ a ${cmfs.lambdaNm[cmfs.y.indexOf(Math.max(...cmfs.y))]} nm (attendu 555 nm)`)

console.log(`\nSpectre solaire AM0 : ${solar.lambdaNm.length} entrees, ${solar.lambdaNm[0]}–${solar.lambdaNm[solar.lambdaNm.length - 1]} nm`)
const visible = integrate(
  solar.lambdaNm.filter((l) => l >= 360 && l <= 830),
  solar.lambdaNm.map((l, i) => [l, solar.irradiance[i]]).filter(([l]) => l >= 360 && l <= 830).map(([, v]) => v),
)
console.log(`  irradiance tabulee (280–4000 nm) = ${totalIrradiance.toFixed(1)} W/m²`)
console.log(`  dont visible (360–830 nm)        = ${visible.toFixed(1)} W/m² (${((visible / totalIrradiance) * 100).toFixed(1)} %)`)
console.log(`  manquant vs TSI 1361 W/m² : ${(1361 - totalIrradiance).toFixed(1)} W/m² (${(((1361 - totalIrradiance) / 1361) * 100).toFixed(2)} %) — IR lointain au-dela de 4 µm`)

const peakIndex = ozone.crossSection.indexOf(Math.max(...ozone.crossSection))
console.log(`
Ozone : ${ozone.lambdaNm.length} intervalles, ${ozone.lambdaNm[0]}–${ozone.lambdaNm[ozone.lambdaNm.length - 1]} nm`)
console.log(`  pic de la bande de Chappuis : ${ozone.crossSection[peakIndex].toExponential(3)} m² a ${ozone.lambdaNm[peakIndex]} nm`)

const problems = []
if (Math.abs(ozone.crossSection[peakIndex] - 5.019e-25) > 1e-26) problems.push(`pic d’ozone inattendu : ${ozone.crossSection[peakIndex].toExponential(3)} m²`)
if (ozone.lambdaNm[peakIndex] < 590 || ozone.lambdaNm[peakIndex] > 615) problems.push(`pic d’ozone mal place : ${ozone.lambdaNm[peakIndex]} nm`)
if (cmfs.lambdaNm[0] !== 360 || cmfs.lambdaNm[cmfs.lambdaNm.length - 1] !== 830) problems.push('domaine CIE inattendu')
if (step !== 1) problems.push(`pas CIE inattendu : ${step} nm`)
// L'integrale porte sur le seul domaine tabule (280–4000 nm) : elle vaut donc
// ~1348 W/m² et non la constante solaire, l'infrarouge lointain manquant a
// l'appel. Voir l'en-tete du module.
if (Math.abs(totalIrradiance - 1347.9) > 3) problems.push(`irradiance tabulee hors tolerance : ${totalIrradiance.toFixed(1)} W/m²`)
if (Math.abs(integralY - 106.857) > 0.5) problems.push(`∫ȳ hors tolerance : ${integralY.toFixed(3)}`)

if (problems.length) {
  console.error(`\nLa source amont ne correspond plus a ce qui est attendu :`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(`\nEcrit dans ${OUT} : cie1931.json, solar-am0.json, ozone-cross-section.json`)
