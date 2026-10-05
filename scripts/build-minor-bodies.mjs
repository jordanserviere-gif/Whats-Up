/**
 * Satellites et petits corps — donnees orbitales depuis le JPL.
 *
 * ## Satellites (Horizons, vecteurs planetocentriques ICRF)
 *
 * Une orbite par annee, de 1990 a 2060 : osculatrice au 1er janvier — plan,
 * excentricite, periapside, anomalie moyenne —, et un mouvement moyen **ajuste**
 * pour retomber exactement sur la position vraie un an plus tard. Les
 * resonances qui font osciller Mimas, Hyperion ou Encelade, et le Soleil qui
 * tire sur Himalia, sont ainsi suivis d'annee en annee.
 *
 * Le nombre de tours dans l'annee vient d'un mouvement moyen mesure sur vingt
 * ans — paliers de 10, 100, 1 000 et 7 300 jours, chacun levant l'ambiguite du
 * suivant. Les elements moyens publies n'y suffiraient pas : quatre decimales
 * sur la periode de Phobos, soit un jour de derive en vingt-cinq ans.
 *
 * La rotation de la ligne des apsides (periode publiee par le JPL) est gardee
 * pour les orbites un peu excentriques : en dix ans, celle d'Hyperion fait la
 * moitie d'un tour. La precession du plan est negligee : elle ne touche que des
 * satellites tres peu inclines, a la seconde d'arc.
 *
 * ## Planetes naines et asteroides (Horizons, vecteurs heliocentriques ICRF)
 *
 * Une table d'etats echelonnes — tous les 200 jours pour la ceinture
 * principale, que Jupiter perturbe, tous les 2 000 pour les transneptuniens —
 * de 1990 a 2070. Entre deux etats, un mouvement keplerien de cent jours au plus
 * suffit a la seconde d'arc : les perturbations sont deja dans la table.
 * Magnitude absolue, pente de phase et diametre viennent de la base SBDB.
 *
 * Ecrit `src/astro/data/minorBodies.json`.
 *
 * Usage : node scripts/build-minor-bodies.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api'
const SBDB = 'https://ssd-api.jpl.nasa.gov/sbdb.api'

/** Epoque de reference des satellites : JD TDB. */
const EPOCH_JD = 2461310.5 // 2026-10-01 00:00 TDB
const FIT_OFFSETS = [-10, -100, -1000, -7300]

/** GM des planetes centrales, km³/s² (JPL). */
const PARENT = {
  mars: { center: '500@499', gm: 42828.37 },
  jupiter: { center: '500@599', gm: 126686531.9 },
  saturn: { center: '500@699', gm: 37931206.2 },
  uranus: { center: '500@799', gm: 5793951.3 },
  neptune: { center: '500@899', gm: 6835099.5 },
  pluto: { center: '500@999', gm: 975.5 }, // Pluton et Charon ensemble
}

/**
 * Satellites : code Horizons, periode des apsides (annees, JPL « mean elements »,
 * 0 si l'orbite est circulaire ou la valeur sans objet).
 */
const MOONS = [
  ['phobos', 401, 'mars', 1.1],
  ['deimos', 402, 'mars', 0],
  ['amalthea', 505, 'jupiter', 0.196],
  ['thebe', 514, 'jupiter', 0],
  ['himalia', 506, 'jupiter', 187.4],
  ['elara', 507, 'jupiter', 0],
  ['mimas', 601, 'saturn', 0.493],
  ['enceladus', 602, 'saturn', 0],
  ['tethys', 603, 'saturn', 0],
  ['dione', 604, 'saturn', 0],
  ['rhea', 605, 'saturn', 0],
  ['titan', 606, 'saturn', 346.68],
  ['hyperion', 607, 'saturn', 20.843],
  ['iapetus', 608, 'saturn', 1662.9],
  ['phoebe', 609, 'saturn', 468.321],
  ['miranda', 705, 'uranus', 0],
  ['ariel', 701, 'uranus', 0],
  ['umbriel', 702, 'uranus', 0],
  ['titania', 703, 'uranus', 0],
  ['oberon', 704, 'uranus', 0],
  ['triton', 801, 'neptune', 0],
  ['nereid', 802, 'neptune', 7990.433],
  ['charon', 901, 'pluto', 0],
]

/** Petits corps : identifiant SBDB, pas de la table en jours. */
const MINOR = [
  ['ceres', '1', 200],
  ['pallas', '2', 200],
  ['juno', '3', 200],
  ['vesta', '4', 200],
  ['hygiea', '10', 200],
  ['eris', '136199', 2000],
  ['haumea', '136108', 2000],
  ['makemake', '136472', 2000],
  ['gonggong', '225088', 2000],
  ['quaoar', '50000', 2000],
  ['sedna', '90377', 2000],
  ['orcus', '90482', 2000],
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function horizons(params) {
  const url = `${HORIZONS}?format=json&${new URLSearchParams({ MAKE_EPHEM: 'YES', OBJ_DATA: 'NO', CSV_FORMAT: 'YES', ...params })}`
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url)
    if (res.ok) {
      const json = await res.json()
      if (json.result?.includes('$$SOE')) return json.result
      throw new Error(`Horizons : ${json.result?.slice(0, 400) ?? json.error}`)
    }
    await sleep(1500 * (attempt + 1))
  }
  throw new Error(`Horizons ne repond pas : ${url}`)
}

/** Lignes CSV entre $$SOE et $$EOE : JD, x, y, z, vx, vy, vz. */
function vectors(result) {
  const body = result.slice(result.indexOf('$$SOE') + 5, result.indexOf('$$EOE'))
  return body
    .trim()
    .split('\n')
    .map((line) => line.split(',').map((s) => s.trim()))
    .map((c) => [Number(c[0]), ...c.slice(2, 8).map(Number)])
}

const sub = (a, b) => a.map((v, i) => v - b[i])
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const scale = (a, k) => a.map((v) => v * k)
const unit = (a) => scale(a, 1 / Math.hypot(...a))
const norm360 = (x) => ((x % 360) + 360) % 360
const DEG = Math.PI / 180

function trueToMean(nu, e) {
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2))
  return E - e * Math.sin(E)
}

/** Osculatrice d'un etat : demi-grand axe, excentricite, base du plan (p vers la periapside). */
function osculating(r, v, gm) {
  const h = cross(r, v)
  const rn = Math.hypot(...r)
  const eVec = sub(scale(cross(v, h), 1 / gm), scale(r, 1 / rn))
  const e = Math.hypot(...eVec)
  const a = 1 / (2 / rn - dot(v, v) / gm)
  const p = e > 1e-4 ? unit(eVec) : unit(r)
  const q = cross(unit(h), p)
  return { a, e, p, q }
}

/** Longitude moyenne d'une position dans un plan donne, apsides tournant de `omegaDot`. */
function meanLongitude(pos, orbit, omegaDot, dtDays) {
  const theta = Math.atan2(dot(pos, orbit.q), dot(pos, orbit.p))
  const w = omegaDot * dtDays * DEG
  return (trueToMean(theta - w, orbit.e) + w) / DEG
}

async function moonVectors(code, center, times) {
  const rows = vectors(
    await horizons({
      COMMAND: `'${code}'`,
      EPHEM_TYPE: 'VECTORS',
      CENTER: `'${center}'`,
      REF_PLANE: 'FRAME',
      REF_SYSTEM: 'ICRF',
      OUT_UNITS: 'KM-S',
      VEC_TABLE: '2',
      TLIST: times.map((t) => `'${t}'`).join(' '),
    }),
  )
  return (t) => {
    const r = rows.find((x) => Math.abs(x[0] - t) < 1e-4)
    if (!r) throw new Error(`pas d'etat a ${t}`)
    return { r: r.slice(1, 4), v: r.slice(4, 7) }
  }
}

/** Une orbite par annee, de 1990 a 2060 : chacune passe par la position vraie a ses deux bouts. */
const YEAR_START_JD = 2447892.5 // 1990-01-01
const YEAR_DAYS = 365.25
const YEARS = 70

/**
 * Satellites irreguliers : si loin de leur planete que le Soleil deforme leur
 * orbite en quelques mois. Une orbite par an ne les suit pas — Himalia s'en
 * ecartait d'une minute d'arc. Ils prennent une table d'etats tous les cent
 * jours, comme les asteroides, et un mouvement keplerien de cinquante jours au
 * plus entre deux.
 */
const IRREGULAR = new Set(['himalia', 'elara', 'phoebe', 'nereid'])
const IRREGULAR_STEP = 100

async function irregularMoon(id, code, parent) {
  const { center, gm } = PARENT[parent]
  const rows = vectors(
    await horizons({
      COMMAND: `'${code}'`,
      EPHEM_TYPE: 'VECTORS',
      CENTER: `'${center}'`,
      REF_PLANE: 'FRAME',
      REF_SYSTEM: 'ICRF',
      OUT_UNITS: 'KM-D',
      VEC_TABLE: '2',
      START_TIME: "'1990-01-01'",
      STOP_TIME: "'2060-01-01'",
      STEP_SIZE: `'${IRREGULAR_STEP} d'`,
    }),
  )
  console.log(id.padEnd(10), `${rows.length} etats`)
  return { id, parent, gm: gm * 86400 * 86400, step: IRREGULAR_STEP, states: rows.map((r) => r.map((x, i) => (i === 0 ? x : Number(x.toPrecision(10))))) }
}

async function moon([id, code, parent, apsisYears]) {
  if (IRREGULAR.has(id)) return irregularMoon(id, code, parent)
  const { center, gm } = PARENT[parent]
  // 1. Mouvement moyen sur vingt ans, affine palier apres palier : il leve
  //    l'ambiguite des tours sur chaque annee.
  const ref = await moonVectors(code, center, [EPOCH_JD, ...FIT_OFFSETS.map((o) => EPOCH_JD + o)])
  const r0 = ref(EPOCH_JD)
  const orbit0 = osculating(r0.r, r0.v, gm)
  const omegaDot = apsisYears > 0 && orbit0.e > 0.005 ? 360 / (apsisYears * 365.25) : 0
  const L0 = meanLongitude(r0.r, orbit0, omegaDot, 0)
  let n = (Math.sqrt(gm / orbit0.a ** 3) * 86400) / DEG
  for (const off of FIT_OFFSETS) {
    const measured = meanLongitude(ref(EPOCH_JD + off).r, orbit0, omegaDot, off) - L0
    n = (measured + 360 * Math.round((n * off - measured) / 360)) / off
  }
  // 2. Les annees : orbite osculatrice au debut, mouvement moyen qui retombe
  //    exactement sur la position vraie a la fin.
  const times = Array.from({ length: YEARS + 1 }, (_, k) => YEAR_START_JD + k * YEAR_DAYS)
  const at = await moonVectors(code, center, times)
  const epochs = []
  for (let k = 0; k < YEARS; k++) {
    const s0 = at(times[k])
    const orbit = osculating(s0.r, s0.v, gm)
    const La = meanLongitude(s0.r, orbit, omegaDot, 0)
    const Lb = meanLongitude(at(times[k + 1]).r, orbit, omegaDot, YEAR_DAYS)
    const measured = Lb - La
    const nk = (measured + 360 * Math.round((n * YEAR_DAYS - measured) / 360)) / YEAR_DAYS
    const round = (x) => Number(x.toPrecision(10))
    epochs.push([orbit.a, orbit.e, ...orbit.p, ...orbit.q, norm360(La), nk].map(round))
  }
  console.log(id.padEnd(10), `a ${orbit0.a.toFixed(0)} km`, `e ${orbit0.e.toFixed(4)}`, `P ${(360 / n).toFixed(5)} j`)
  return { id, parent, omegaDot, start: YEAR_START_JD, step: YEAR_DAYS, epochs }
}

async function minor([id, sstr, step]) {
  const rows = vectors(
    await horizons({
      COMMAND: `'${sstr};'`,
      EPHEM_TYPE: 'VECTORS',
      CENTER: "'500@10'",
      REF_PLANE: 'FRAME',
      REF_SYSTEM: 'ICRF',
      OUT_UNITS: 'AU-D',
      VEC_TABLE: '2',
      START_TIME: "'1990-01-01'",
      STOP_TIME: "'2070-01-01'",
      STEP_SIZE: `'${step} d'`,
    }),
  )
  const sb = await (await fetch(`${SBDB}?sstr=${sstr}&phys-par=1`)).json()
  const phys = Object.fromEntries((sb.phys_par ?? []).map((x) => [x.name, Number(x.value)]))
  console.log(id.padEnd(10), sb.object?.fullname, `H ${phys.H}`, `G ${phys.G ?? '—'}`, `D ${phys.diameter ?? '—'} km`, `${rows.length} etats`)
  return {
    id,
    name: sb.object?.fullname,
    H: phys.H,
    G: Number.isFinite(phys.G) ? phys.G : 0.15,
    diameterKm: Number.isFinite(phys.diameter) ? phys.diameter : null,
    step,
    states: rows.map((r) => r.map((x, i) => (i === 0 ? x : Number(x.toPrecision(12))))),
  }
}

const out = { source: 'JPL Horizons et SBDB', moons: [], minor: [] }
for (const m of MOONS) {
  out.moons.push(await moon(m))
  await sleep(300)
}
for (const m of MINOR) {
  out.minor.push(await minor(m))
  await sleep(300)
}
mkdirSync('src/astro/data', { recursive: true })
writeFileSync('src/astro/data/minorBodies.json', JSON.stringify(out))
