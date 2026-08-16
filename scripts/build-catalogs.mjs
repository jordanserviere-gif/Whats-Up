/**
 * Genere les catalogues embarques dans src/data/ :
 *  - stars.json         : etoiles jusqu'a la magnitude MAG_LIMIT (HYG v4.1)
 *  - constellations.json: lignes + frontieres simplifiees (d3-celestial)
 *
 * Usage : npm run data
 * Les fichiers generes sont commites : l'app n'a besoin d'aucun reseau a l'execution.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'scripts', '.cache')
const OUT = join(ROOT, 'src', 'data')
const MAG_LIMIT = 6.0

const SOURCES = {
  hyg: 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv',
  lines: 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json',
  names: 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.json',
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
  console.log(`${(text.length / 1e6).toFixed(1)} Mo`)
  return text
}

/** CSV -> lignes de champs, en respectant les guillemets. */
function parseCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

async function buildStars() {
  const csv = await cached('hyg.csv', SOURCES.hyg)
  const lines = csv.split('\n')
  const head = parseCsvLine(lines[0])
  const col = (n) => {
    const i = head.indexOf(n)
    if (i < 0) throw new Error(`colonne HYG absente : ${n}`)
    return i
  }
  const iRa = col('ra')          // heures, J2000
  const iDec = col('dec')        // degres, J2000
  const iMag = col('mag')
  const iCi = col('ci')          // indice de couleur B-V
  const iProper = col('proper')
  const iBayer = col('bayer')
  const iFlam = col('flam')
  const iCon = col('con')
  const iHip = col('hip')

  const ra = [], dec = [], mag = [], ci = []
  const named = []

  for (let l = 1; l < lines.length; l++) {
    const line = lines[l]
    if (!line) continue
    const f = parseCsvLine(line)
    const m = parseFloat(f[iMag])
    if (!Number.isFinite(m) || m > MAG_LIMIT) continue
    const r = parseFloat(f[iRa])
    const d = parseFloat(f[iDec])
    if (!Number.isFinite(r) || !Number.isFinite(d)) continue
    if (f[iHip] === '' && f[iProper] === '' && parseFloat(f[iMag]) === 0 && r === 0) continue // ligne Soleil

    const idx = ra.length
    ra.push(+(r * 15).toFixed(5))   // -> degres
    dec.push(+d.toFixed(5))
    mag.push(+m.toFixed(2))
    const c = parseFloat(f[iCi])
    ci.push(Number.isFinite(c) ? +c.toFixed(2) : 0)

    const proper = f[iProper]?.trim()
    if (proper) {
      const bayer = f[iBayer]?.trim()
      const flam = f[iFlam]?.trim()
      named.push({
        i: idx,
        n: proper,
        d: [bayer, flam, f[iCon]?.trim()].filter(Boolean).join(' '),
      })
    }
  }

  const payload = { magLimit: MAG_LIMIT, epoch: 'J2000', count: ra.length, ra, dec, mag, ci, named }
  writeFileSync(join(OUT, 'stars.json'), JSON.stringify(payload))
  console.log(`stars.json : ${ra.length} etoiles, ${named.length} nommees`)
}

async function buildConstellations() {
  const linesGeo = JSON.parse(await cached('lines.json', SOURCES.lines))
  const namesGeo = JSON.parse(await cached('names.json', SOURCES.names))

  const labels = new Map()
  for (const f of namesGeo.features) {
    const p = f.properties ?? {}
    const [lon, lat] = f.geometry.coordinates
    labels.set(p.id, { id: p.id, name: p.name, ra: (lon + 360) % 360, dec: lat })
  }

  const constellations = []
  for (const f of linesGeo.features) {
    const id = f.properties?.id ?? f.id
    // MultiLineString de coordonnees [lon(-180..180) = RA, lat = Dec] en J2000
    const segs = (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]).map(
      (seg) => seg.map(([lon, lat]) => [+(((lon + 360) % 360).toFixed(4)), +lat.toFixed(4)]),
    )
    const label = labels.get(id)
    constellations.push({
      id,
      name: label?.name ?? id,
      ra: label?.ra ?? segs[0]?.[0]?.[0] ?? 0,
      dec: label?.dec ?? segs[0]?.[0]?.[1] ?? 0,
      segs,
    })
  }

  writeFileSync(join(OUT, 'constellations.json'), JSON.stringify({ epoch: 'J2000', constellations }))
  console.log(`constellations.json : ${constellations.length} figures`)
}

await buildStars()
await buildConstellations()
console.log('catalogues generes dans src/data/')
