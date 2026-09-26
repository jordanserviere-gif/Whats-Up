/**
 * Fige une journee meteo reelle dans le depot — un « scenario ».
 *
 * Pendant le developpement, les nuages et les trainees ne doivent dependre ni
 * du temps qu'il fait ni de la disponibilite d'une API : on rejoue des
 * journees archivees, toujours les memes, dont on sait qu'elles ont existe.
 *
 * ## Ce qui est archive
 *
 * La sortie d'ICON (via l'Historical Forecast API d'Open-Meteo) sur deux
 * grilles centrees sur le lieu :
 *
 * - **loin** : 9 × 9 points espaces de 100 km, ±400 km — jusqu'a l'horizon
 *   d'un cirrus vu du sol (~360 km pour 10 km d'altitude) ;
 * - **pres** : 9 × 9 points espaces de 6 km, ±24 km — la zone ou les nuages
 *   seront rendus en volume.
 *
 * A chaque point, les 24 heures de la journee, et sur 15 niveaux de pression
 * de 1000 a 150 hPa : temperature, humidite relative (sur eau, definition
 * ICON), fraction nuageuse, altitude geopotentielle et vent. Plus les champs
 * de surface (couverture par etage, CAPE, point de rosee…).
 *
 * Ce n'est pas une mesure directe du nuage : c'est l'etat de l'atmosphere
 * calcule par le modele a partir des observations. La verite de terrain est a
 * part : une image satellite du meme jour (VIIRS, NASA Worldview), rangee a
 * cote, sur l'emprise de la grille lointaine.
 *
 * Usage :
 *   node scripts/build-weather-scenario.mjs <id> <lat> <lon> <AAAA-MM-JJ> "<titre>"
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const [id, latArg, lonArg, date, ...titleWords] = process.argv.slice(2)
if (!id || !latArg || !lonArg || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  console.error('usage: node scripts/build-weather-scenario.mjs <id> <lat> <lon> <AAAA-MM-JJ> "<titre>"')
  process.exit(1)
}
const LAT = Number(latArg)
const LON = Number(lonArg)
const TITLE = titleWords.join(' ') || id
const OUT_DIR = 'public/scenarios'

const LEVELS_HPA = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150]
/** Champ Open-Meteo → [cle compacte, facteur de quantification]. */
const LEVEL_FIELDS = {
  temperature: ['t', 10], // 0,1 °C
  relative_humidity: ['rh', 1], // %
  cloud_cover: ['cc', 1], // %
  geopotential_height: ['z', 1], // m
  wind_speed: ['ws', 10], // 0,1 km/h
  wind_direction: ['wd', 1], // degres, d'ou vient le vent
}
const SURFACE_FIELDS = {
  cloud_cover: ['cct', 1],
  cloud_cover_low: ['ccl', 1],
  cloud_cover_mid: ['ccm', 1],
  cloud_cover_high: ['cch', 1],
  temperature_2m: ['t2', 10],
  dew_point_2m: ['td2', 10],
  surface_pressure: ['ps', 10], // 0,1 hPa
  cape: ['cape', 1],
  precipitation: ['rr', 10], // 0,1 mm
  weather_code: ['ww', 1],
}

const KM_PER_DEG_LAT = 111.195
function grid(n, spacingKm) {
  const points = []
  const half = (n - 1) / 2
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const northKm = (half - j) * spacingKm
      const eastKm = (i - half) * spacingKm
      const lat = LAT + northKm / KM_PER_DEG_LAT
      const lon = LON + eastKm / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))
      points.push({ lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, eastKm, northKm })
    }
  }
  return { n, spacingKm, points }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Une requete multi-points, avec attente si le quota a la minute est atteint. */
async function fetchPoints(points) {
  const hourly = [
    ...LEVELS_HPA.flatMap((p) => Object.keys(LEVEL_FIELDS).map((f) => `${f}_${p}hPa`)),
    ...Object.keys(SURFACE_FIELDS),
  ]
  const url =
    `https://historical-forecast-api.open-meteo.com/v1/forecast` +
    `?latitude=${points.map((p) => p.lat).join(',')}&longitude=${points.map((p) => p.lon).join(',')}` +
    `&start_date=${date}&end_date=${date}&hourly=${hourly.join(',')}&models=icon_seamless&timezone=UTC`
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url)
    if (res.ok) {
      const body = await res.json()
      return Array.isArray(body) ? body : [body]
    }
    const text = await res.text()
    if ((res.status === 429 || /limit/i.test(text)) && attempt < 6) {
      process.stdout.write(' (quota, pause 65 s)')
      await sleep(65_000)
      continue
    }
    throw new Error(`${res.status} ${text}`)
  }
}

async function fill(g) {
  const fields = {}
  const elevationM = []
  let times = null
  const BATCH = 9
  for (let k = 0; k < g.points.length; k += BATCH) {
    process.stdout.write(`\r  points ${k + 1}–${Math.min(k + BATCH, g.points.length)} / ${g.points.length}`)
    const batch = await fetchPoints(g.points.slice(k, k + BATCH))
    for (const r of batch) {
      times ??= r.hourly.time
      elevationM.push(Math.round(r.elevation))
      const put = (key, scale, values) => {
        fields[key] ??= []
        fields[key].push(values.map((v) => (v == null ? null : Math.round(v * scale))))
      }
      for (const p of LEVELS_HPA) {
        for (const [f, [key, scale]] of Object.entries(LEVEL_FIELDS)) put(`${key}${p}`, scale, r.hourly[`${f}_${p}hPa`])
      }
      for (const [f, [key, scale]] of Object.entries(SURFACE_FIELDS)) put(key, scale, r.hourly[f])
    }
  }
  process.stdout.write('\n')
  // Stockage [champ][point][heure] : chaque serie horaire d'un point est contigue.
  return {
    n: g.n,
    spacingKm: g.spacingKm,
    points: g.points.map((p, i) => [p.lat, p.lon, elevationM[i]]),
    fields,
    times,
  }
}

/** Image satellite de reference, emprise de la grille lointaine. */
async function satellite(far) {
  const lats = far.points.map((p) => p.lat)
  const lons = far.points.map((p) => p.lon)
  const bbox = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)].map((v) => v.toFixed(3)).join(',')
  const layer = 'VIIRS_NOAA20_CorrectedReflectance_TrueColor'
  const url =
    `https://wvs.earthdata.nasa.gov/api/v1/snapshot?REQUEST=GetSnapshot&TIME=${date}&BBOX=${bbox}` +
    `&CRS=EPSG:4326&LAYERS=${layer},Coastlines_15m&FORMAT=image/jpeg&WIDTH=1024&HEIGHT=1024`
  const res = await fetch(url)
  if (!res.ok || !/image/.test(res.headers.get('content-type') ?? '')) return null
  await writeFile(`${OUT_DIR}/${id}.jpg`, Buffer.from(await res.arrayBuffer()))
  return { file: `${id}.jpg`, layer, bbox, note: 'NOAA-20 passe vers 13 h 30 heure solaire locale' }
}

await mkdir(OUT_DIR, { recursive: true })
console.log(`scenario ${id} — ${LAT}, ${LON}, ${date}`)
const farGrid = grid(9, 100)
console.log(' grille lointaine')
const far = await fill(farGrid)
console.log(' grille proche')
const near = await fill(grid(9, 6))
const times = far.times
delete far.times
delete near.times
const reference = await satellite(farGrid)
console.log(reference ? ` image satellite : ${reference.file}` : ' image satellite indisponible')

const scenario = {
  id,
  title: TITLE,
  location: { latitude: LAT, longitude: LON },
  date,
  source: 'Open-Meteo Historical Forecast API, modele ICON (icon_seamless)',
  fetchedAt: new Date().toISOString(),
  times,
  levelsHPa: LEVELS_HPA,
  quantization: Object.fromEntries([...Object.values(LEVEL_FIELDS), ...Object.values(SURFACE_FIELDS)].map(([k, s]) => [k, 1 / s])),
  grids: { far, near },
  reference,
}
await writeFile(`${OUT_DIR}/${id}.json`, JSON.stringify(scenario))

// Catalogue : un index des scenarios, pour le selecteur de l'appli.
const indexPath = `${OUT_DIR}/index.json`
const index = existsSync(indexPath) ? JSON.parse(await readFile(indexPath, 'utf8')) : []
const entry = { id, title: TITLE, date, latitude: LAT, longitude: LON }
const at = index.findIndex((e) => e.id === id)
if (at >= 0) index[at] = entry
else index.push(entry)
await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n')
console.log(` ecrit ${OUT_DIR}/${id}.json`)
