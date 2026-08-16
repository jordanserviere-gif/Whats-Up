/**
 * Etape 0 — controle CORS depuis un vrai navigateur.
 *
 * `curl` et `fetch` cote Node n'envoient pas d'en-tete `Origin` et ne sont pas
 * soumis a la politique d'origine croisee : ils donnent donc un faux positif
 * systematique. Seule une requete emise par une page servie par `npm run dev`
 * dit si la source est utilisable dans l'application.
 *
 * Le serveur de developpement doit tourner sur le port indique par SHOOT_URL
 * (defaut 5199).
 *
 * Usage : node scripts/probe-cors.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'scripts', '.cache', 'samples')
const BASE = process.env.SHOOT_URL ?? 'http://localhost:5199'
mkdirSync(OUT, { recursive: true })

const TARGETS = [
  {
    id: 'celestrak',
    label: 'CelesTrak — GP JSON',
    url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json',
  },
  {
    id: 'meteo',
    label: 'Open-Meteo — pression / temperature',
    url: 'https://api.open-meteo.com/v1/forecast?latitude=48.8566&longitude=2.3522&current=surface_pressure,temperature_2m',
  },
  {
    id: 'air-quality',
    label: 'Open-Meteo Air Quality — aerosols',
    url: 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=48.8566&longitude=2.3522&current=aerosol_optical_depth',
  },
  {
    id: 'sbdb',
    label: 'JPL SBDB',
    url: 'https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Ceres&full-prec=true',
  },
  // Bloquer l'etape 4 est une decision lourde : on controle deux autres points
  // d'entree du meme service avant de conclure que JPL n'ouvre pas ses API.
  {
    id: 'sbdb-query',
    label: 'JPL SBDB Query (variante)',
    url: 'https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=full_name,e,a,i&sb-kind=a&limit=2',
  },
  {
    id: 'horizons',
    label: 'JPL Horizons (variante)',
    url: 'https://ssd.jpl.nasa.gov/api/horizons.api?format=json&COMMAND=%27499%27&OBJ_DATA=%27NO%27&EPHEM_TYPE=%27OBSERVER%27&CENTER=%27500@399%27&START_TIME=%272026-08-17%27&STOP_TIME=%272026-08-18%27&STEP_SIZE=%271%20d%27',
  },
  {
    id: 'simbad',
    label: 'SIMBAD TAP',
    url:
      'https://simbad.cds.unistra.fr/simbad/sim-tap/sync?request=doQuery&lang=adql&format=json&query=' +
      encodeURIComponent("SELECT TOP 1 main_id, ra, dec FROM basic WHERE main_id = 'M  31'"),
  },
]

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(BASE, { waitUntil: 'domcontentloaded' })

console.log(`Controle CORS depuis ${BASE}\n`)

const results = []
for (const target of TARGETS) {
  const outcome = await page.evaluate(async (url) => {
    const started = performance.now()
    try {
      const res = await fetch(url, { mode: 'cors' })
      const text = await res.text()
      return { ok: res.ok, status: res.status, bytes: text.length, ms: Math.round(performance.now() - started) }
    } catch (err) {
      // Un blocage CORS se manifeste par un TypeError opaque : le navigateur ne
      // communique jamais le detail au script, par conception.
      return { ok: false, blocked: true, message: String(err), ms: Math.round(performance.now() - started) }
    }
  }, target.url)

  const verdict = outcome.blocked ? 'BLOQUE (CORS)' : outcome.ok ? 'OK' : `HTTP ${outcome.status}`
  console.log(`${target.id.padEnd(14)} ${verdict.padEnd(16)} ${outcome.bytes ? `${(outcome.bytes / 1024).toFixed(1)} Ko` : ''} ${outcome.ms} ms`)
  if (outcome.blocked) console.log(`  ${outcome.message}`)
  results.push({ ...target, ...outcome })
}

await browser.close()

writeFileSync(join(OUT, '_cors.json'), JSON.stringify(results, null, 2))
console.log(`\nRapport : ${join(OUT, '_cors.json')}`)

const blocked = results.filter((r) => r.blocked)
if (blocked.length) {
  console.log(`\n${blocked.length} source(s) bloquee(s) par CORS : ${blocked.map((b) => b.id).join(', ')}`)
  console.log('Conformement aux consignes, aucune ne sera contournee par un proxy.')
}
