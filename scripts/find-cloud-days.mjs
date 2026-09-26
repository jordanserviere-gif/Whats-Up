/**
 * Cherche dans les archives Open-Meteo des journees reelles qui illustrent
 * chaque type de ciel — pour choisir les scenarios meteo figes de
 * `build-weather-scenario.mjs` sur de la donnee, pas au jugé.
 *
 * Source : Historical Forecast API, sorties archivees d'ICON. Pour chaque lieu,
 * une annee entiere en une requete, puis classement a une heure fixe (celle
 * du passage des satellites a orbite polaire, pour avoir une image de
 * reference du meme instant).
 *
 * Usage : node scripts/find-cloud-days.mjs [annee]
 */

const YEAR = Number(process.argv[2] ?? 2025)
const HOUR_UTC = 12

const PLACES = [
  { id: 'lyon', lat: 45.76, lon: 4.84 },
  { id: 'paris', lat: 48.85, lon: 2.35 },
  { id: 'brest', lat: 48.39, lon: -4.49 },
  { id: 'toulouse', lat: 43.6, lon: 1.44 },
]

/** Criteres par type de ciel, sur la couverture bas / moyen / haut (%), la CAPE (J/kg) et le code temps OMM. */
const KINDS = {
  clair: (h) => h.low < 3 && h.mid < 3 && h.high < 3 && h.dayMax < 10,
  cirrus: (h) => h.high > 60 && h.low < 5 && h.mid < 10,
  stratus: (h) => h.low > 95 && h.mid < 15 && h.high < 15,
  cumulus: (h) => h.low >= 15 && h.low <= 60 && h.mid < 15 && h.high < 15 && h.cape > 200,
  altocumulus: (h) => h.mid >= 30 && h.mid <= 85 && h.low < 5 && h.high < 30,
  orage: (h) => h.code >= 95 && h.cape > 1000,
  multicouche: (h) => h.low > 50 && h.mid > 50 && h.high > 50,
}

async function yearOf(place) {
  const fields = ['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'cape', 'weather_code']
  const url =
    `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    `&start_date=${YEAR}-01-01&end_date=${YEAR}-12-31&hourly=${fields.join(',')}&models=icon_seamless&timezone=UTC`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${place.id}: ${res.status} ${await res.text()}`)
  const h = (await res.json()).hourly
  const days = []
  for (let i = 0; i < h.time.length; i += 24) {
    const at = i + HOUR_UTC
    if (h.cloud_cover_low[at] == null) continue
    const total = (k) => h.cloud_cover_low[k] + h.cloud_cover_mid[k] + h.cloud_cover_high[k]
    let dayMax = 0
    for (let k = i + 9; k <= i + 17; k++) dayMax = Math.max(dayMax, total(k) ?? 0)
    days.push({
      date: h.time[i].slice(0, 10),
      low: h.cloud_cover_low[at],
      mid: h.cloud_cover_mid[at],
      high: h.cloud_cover_high[at],
      cape: h.cape[at] ?? 0,
      code: h.weather_code[at] ?? 0,
      dayMax,
    })
  }
  return days
}

for (const place of PLACES) {
  const days = await yearOf(place)
  console.log(`\n=== ${place.id} (${place.lat}, ${place.lon}) — ${days.length} jours, ${HOUR_UTC} h UTC`)
  for (const [kind, test] of Object.entries(KINDS)) {
    const hits = days.filter(test)
    const shown = hits.slice(0, 6).map((d) => `${d.date} [${d.low}/${d.mid}/${d.high}${d.cape > 200 ? ` cape ${Math.round(d.cape)}` : ''}]`)
    console.log(`  ${kind.padEnd(12)} ${String(hits.length).padStart(3)} j  ${shown.join('  ')}`)
  }
}
