/**
 * Etape 0 — reconnaissance des sources externes.
 *
 * Sonde chaque API, enregistre un echantillon de reponse dans
 * `scripts/.cache/samples/` et resume la forme reelle des donnees. On code
 * ensuite contre ces echantillons, jamais contre une description.
 *
 * Attention : ce script ne teste **pas** le CORS — une requete Node l'ignore.
 * Le controle CORS se fait depuis le navigateur (`scripts/probe-cors.mjs`).
 *
 * Usage : node scripts/probe-sources.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'scripts', '.cache', 'samples')
mkdirSync(OUT, { recursive: true })

const UA = 'ciel-observation/0.1 (webapp astronomie, usage personnel)'

const SOURCES = [
  {
    id: 'celestrak-stations',
    label: 'CelesTrak — GP JSON, groupe stations',
    url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json',
    file: 'celestrak-stations.json',
    inspect: (text) => {
      const data = JSON.parse(text)
      const iss = data.find((o) => String(o.OBJECT_NAME ?? '').includes('ISS')) ?? data[0]
      return {
        'nombre d’objets': data.length,
        'champs': Object.keys(iss).join(', '),
        'exemple': `${iss.OBJECT_NAME} — n=${iss.MEAN_MOTION} tours/j, i=${iss.INCLINATION}°, epoque ${iss.EPOCH}`,
      }
    },
  },
  {
    id: 'meteo',
    label: 'Open-Meteo — pression et temperature',
    url: 'https://api.open-meteo.com/v1/forecast?latitude=48.8566&longitude=2.3522&current=surface_pressure,temperature_2m,pressure_msl',
    file: 'open-meteo.json',
    inspect: (text) => {
      const d = JSON.parse(text)
      return {
        'champs current': Object.keys(d.current ?? {}).join(', '),
        'unites': JSON.stringify(d.current_units ?? {}),
        'valeurs': JSON.stringify(d.current ?? {}),
      }
    },
  },
  {
    id: 'air-quality',
    label: 'Open-Meteo Air Quality — epaisseur optique aerosols',
    url: 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=48.8566&longitude=2.3522&current=aerosol_optical_depth&hourly=aerosol_optical_depth&forecast_days=1',
    file: 'open-meteo-air-quality.json',
    inspect: (text) => {
      const d = JSON.parse(text)
      const hourly = d.hourly?.aerosol_optical_depth ?? []
      return {
        'champs current': Object.keys(d.current ?? {}).join(', '),
        'valeur courante': JSON.stringify(d.current ?? {}),
        'echantillons horaires': `${hourly.length} valeurs, ex. ${hourly.slice(0, 4).join(', ')}`,
      }
    },
  },
  {
    id: 'sbdb-ceres',
    label: 'JPL SBDB — elements osculateurs de Ceres',
    url: 'https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Ceres&full-prec=true',
    file: 'sbdb-ceres.json',
    inspect: (text) => {
      const d = JSON.parse(text)
      const elements = d.orbit?.elements ?? []
      return {
        'objet': d.object?.fullname ?? '?',
        'epoque': d.orbit?.epoch ?? '?',
        'elements': elements.map((e) => `${e.name}=${e.value} ${e.units ?? ''}`.trim()).join(' | '),
        'magnitude': `H=${d.phys_par?.find?.((p) => p.name === 'H')?.value ?? '?'}`,
      }
    },
  },
  {
    id: 'opengc',
    label: 'OpenNGC — catalogue ciel profond (CSV, telecharge au build)',
    url: 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv',
    file: 'openngc-ngc.csv',
    inspect: (text) => {
      const lines = text.split('\n')
      return {
        'lignes': lines.length,
        'separateur': lines[0].includes(';') ? 'point-virgule' : 'virgule',
        'colonnes': lines[0].trim(),
        'premiere ligne': lines[1]?.trim().slice(0, 160),
      }
    },
  },
  {
    id: 'simbad',
    label: 'SIMBAD (CDS) — TAP synchrone, ADQL',
    // `basic` ne porte pas les magnitudes : elles vivent dans `allfluxes`.
    // La resolution d'un nom passe par `ident`, dont les identifiants sont
    // normalises (« M  31 » avec deux espaces) — d'ou le passage par la
    // fonction `id` plutot qu'une egalite litterale.
    url:
      'https://simbad.cds.unistra.fr/simbad/sim-tap/sync?request=doQuery&lang=adql&format=json&query=' +
      encodeURIComponent(
        "SELECT TOP 3 b.main_id, b.ra, b.dec, b.otype_txt, f.V " +
          'FROM basic AS b JOIN ident AS i ON i.oidref = b.oid LEFT JOIN allfluxes AS f ON f.oidref = b.oid ' +
          "WHERE i.id = 'M  31'",
      ),
    file: 'simbad-m31.json',
    inspect: (text) => {
      const d = JSON.parse(text)
      return {
        'colonnes': (d.metadata ?? []).map((m) => m.name).join(', '),
        'lignes': JSON.stringify(d.data ?? []),
      }
    },
  },
]

console.log('Sondage des sources externes\n')

const report = []
for (const source of SOURCES) {
  process.stdout.write(`${source.id.padEnd(20)} `)
  const started = Date.now()
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: AbortSignal.timeout(25_000),
    })
    const text = await res.text()
    const ms = Date.now() - started

    if (!res.ok) {
      console.log(`ECHEC HTTP ${res.status} (${ms} ms)`)
      // Le corps d'erreur porte souvent la vraie raison — message ADQL, quota…
      console.log(`  ${'corps'.padEnd(22)} ${text.replace(/\s+/g, ' ').slice(0, 300)}`)
      writeFileSync(join(OUT, `${source.id}-erreur.txt`), text)
      report.push({ id: source.id, ok: false, detail: `HTTP ${res.status}` })
      continue
    }

    writeFileSync(join(OUT, source.file), text)
    console.log(`OK ${res.status} — ${(text.length / 1024).toFixed(0)} Ko en ${ms} ms`)

    // En-tetes utiles : cache et politique d'origine croisee.
    const cors = res.headers.get('access-control-allow-origin')
    const cacheControl = res.headers.get('cache-control')
    console.log(`  ${'CORS'.padEnd(22)} ${cors ?? '(absent des en-tetes)'}`)
    if (cacheControl) console.log(`  ${'Cache-Control'.padEnd(22)} ${cacheControl}`)

    try {
      for (const [k, v] of Object.entries(source.inspect(text))) {
        console.log(`  ${k.padEnd(22)} ${String(v).slice(0, 220)}`)
      }
    } catch (err) {
      console.log(`  (analyse impossible : ${err.message})`)
    }
    report.push({ id: source.id, ok: true, cors, cacheControl })
  } catch (err) {
    console.log(`ECHEC ${err.name}: ${err.message}`)
    report.push({ id: source.id, ok: false, detail: `${err.name}: ${err.message}` })
  }
  console.log()
}

writeFileSync(join(OUT, '_rapport.json'), JSON.stringify(report, null, 2))
console.log(`Echantillons dans ${OUT}`)
console.log('Rappel : le CORS reste a verifier depuis le navigateur.')
