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
  openngc: 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv',
}

/** Magnitude au-dela de laquelle on n'embarque plus d'objet du ciel profond. */
const DEEP_SKY_MAG_LIMIT = 12

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
  const iId = col('id')
  const iDist = col('dist')      // parsecs ; 100000 = sentinelle (parallaxe inconnue)
  const iAbsmag = col('absmag')  // magnitude absolue, deja reduite a 10 pc par HYG

  const ra = [], dec = [], mag = [], ci = [], absmag = []
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
    // Premiere ligne de HYG : le Soleil, seule entree a distance nulle et sans
    // position — ses coordonnees 0 h / 0° ne designent rien. Le garde precedent
    // le cherchait sans nom propre et a la magnitude zero ; il s'appelle « Sol »
    // et vaut -26,7, si bien qu'il passait, et qu'un astre de cette magnitude se
    // plantait sur le point vernal. Le Soleil vient des ephemerides : il n'a
    // rien a faire dans un catalogue d'etoiles fixes.
    if (f[iId] === '0') continue

    const idx = ra.length
    ra.push(+(r * 15).toFixed(5))   // -> degres
    dec.push(+d.toFixed(5))
    mag.push(+m.toFixed(2))
    const c = parseFloat(f[iCi])
    ci.push(Number.isFinite(c) ? +c.toFixed(2) : 0)

    // La sentinelle de distance (100000 pc) marque une parallaxe inconnue :
    // l'absmag que HYG en tire est sans valeur, on la tait plutot que
    // d'afficher une grandeur absolue fausse.
    const dist = parseFloat(f[iDist])
    const am = parseFloat(f[iAbsmag])
    absmag.push(Number.isFinite(am) && dist < 90000 ? +am.toFixed(2) : null)

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

  // Garde-fou : Sirius, la plus brillante des fixes, est a -1,46. Au-dela de
  // -2, c'est qu'un corps du systeme solaire s'est glisse dans le catalogue.
  const brightest = Math.min(...mag)
  if (brightest < -2) {
    const i = mag.indexOf(brightest)
    throw new Error(`magnitude ${brightest} dans stars.json : ${named.find((n) => n.i === i)?.n ?? `#${i}`}`)
  }

  const payload = { magLimit: MAG_LIMIT, epoch: 'J2000', count: ra.length, ra, dec, mag, ci, absmag, named }
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

/** « hh:mm:ss.ss » vers degres. */
function parseRa(text) {
  const [h, m, s] = text.split(':').map(Number)
  if (![h, m, s].every(Number.isFinite)) return null
  return (h + m / 60 + s / 3600) * 15
}

/** « ±dd:mm:ss.s » vers degres. */
function parseDec(text) {
  const sign = text.trim().startsWith('-') ? -1 : 1
  const [d, m, s] = text.replace(/^[+-]/, '').split(':').map(Number)
  if (![d, m, s].every(Number.isFinite)) return null
  return sign * (d + m / 60 + s / 3600)
}

/**
 * Types OpenNGC ecartes.
 *
 * `Dup` designe une entree en doublon d'une autre, `NonEx` un objet inexistant,
 * `*` et `**` des etoiles simples ou doubles — deja couvertes, et bien mieux,
 * par le catalogue HYG.
 */
const EXCLUDED_TYPES = new Set(['Dup', 'NonEx', '*', '**'])

/** Libelles francais des types conserves. */
const TYPE_LABELS = {
  G: 'galaxie',
  GPair: 'paire de galaxies',
  GTrpl: 'triplet de galaxies',
  GGroup: 'groupe de galaxies',
  GCl: 'amas globulaire',
  OCl: 'amas ouvert',
  'Cl+N': 'amas avec nébulosité',
  PN: 'nébuleuse planétaire',
  Neb: 'nébuleuse',
  HII: 'région HII',
  RfN: 'nébuleuse par réflexion',
  SNR: 'rémanent de supernova',
  EmN: 'nébuleuse en émission',
  DrkN: 'nébuleuse obscure',
  Nova: 'nova',
  Other: 'autre',
}

async function buildDeepSky() {
  const csv = await cached('openngc.csv', SOURCES.openngc)
  const lines = csv.split('\n')
  const head = lines[0].trim().split(';')
  const col = (name) => {
    const i = head.indexOf(name)
    if (i < 0) throw new Error(`colonne OpenNGC absente : ${name}`)
    return i
  }

  const iName = col('Name')
  const iType = col('Type')
  const iRa = col('RA')
  const iDec = col('Dec')
  const iMajor = col('MajAx')
  const iMinor = col('MinAx')
  const iAngle = col('PosAng')
  const iVmag = col('V-Mag')
  const iBmag = col('B-Mag')
  const iMessier = col('M')
  const iCommon = col('Common names')

  const typeNames = []
  const typeIndex = new Map()
  const out = { id: [], name: [], type: [], ra: [], dec: [], mag: [], major: [], minor: [], angle: [], messier: [] }

  for (let l = 1; l < lines.length; l++) {
    const row = lines[l]
    if (!row.trim()) continue
    // Pas de guillemets dans OpenNGC : un decoupage simple suffit.
    const f = row.split(';')

    const type = f[iType]?.trim()
    if (!type || EXCLUDED_TYPES.has(type)) continue

    const ra = parseRa(f[iRa] ?? '')
    const dec = parseDec(f[iDec] ?? '')
    if (ra === null || dec === null) continue

    // La magnitude visuelle prime ; a defaut la magnitude bleue, moins juste
    // pour l'oeil mais preferable a une absence de donnee.
    const v = Number.parseFloat(f[iVmag])
    const b = Number.parseFloat(f[iBmag])
    const mag = Number.isFinite(v) ? v : Number.isFinite(b) ? b : null
    if (mag === null || mag > DEEP_SKY_MAG_LIMIT) continue

    if (!typeIndex.has(type)) {
      typeIndex.set(type, typeNames.length)
      typeNames.push(type)
    }

    const major = Number.parseFloat(f[iMajor])
    const minor = Number.parseFloat(f[iMinor])
    const angle = Number.parseFloat(f[iAngle])
    const messier = Number.parseInt(f[iMessier], 10)
    // Plusieurs noms usuels possibles : on garde le premier, le plus courant.
    const common = (f[iCommon] ?? '').split(',')[0].trim()

    out.id.push(f[iName].trim())
    out.name.push(common)
    out.type.push(typeIndex.get(type))
    out.ra.push(+ra.toFixed(5))
    out.dec.push(+dec.toFixed(5))
    out.mag.push(+mag.toFixed(2))
    // Dimensions en minutes d'arc ; 0 = inconnu, l'objet sera rendu ponctuel.
    out.major.push(Number.isFinite(major) ? +major.toFixed(3) : 0)
    out.minor.push(Number.isFinite(minor) ? +minor.toFixed(3) : 0)
    out.angle.push(Number.isFinite(angle) ? Math.round(angle) : 0)
    out.messier.push(Number.isFinite(messier) ? messier : 0)
  }

  const payload = {
    epoch: 'J2000',
    magLimit: DEEP_SKY_MAG_LIMIT,
    count: out.id.length,
    typeNames,
    typeLabels: typeNames.map((t) => TYPE_LABELS[t] ?? t),
    ...out,
  }
  const json = JSON.stringify(payload)
  writeFileSync(join(OUT, 'deepsky.json'), json)

  const withSize = out.major.filter((m) => m > 0).length
  const messierCount = out.messier.filter((m) => m > 0).length
  console.log(
    `deepsky.json : ${payload.count} objets ≤ mag ${DEEP_SKY_MAG_LIMIT}, ` +
      `${withSize} avec dimensions, ${messierCount} Messier, ${typeNames.length} types, ` +
      `${(json.length / 1024).toFixed(0)} Ko`,
  )
}

await buildStars()
await buildConstellations()
await buildDeepSky()
console.log('catalogues generes dans src/data/')
