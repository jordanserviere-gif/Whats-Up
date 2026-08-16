/**
 * Captures de controle du rendu.
 *
 * Chaque scenario fixe un instant, un lieu et une direction de visee, puis
 * enregistre une image. C'est le seul moyen de verifier ce qu'aucun test
 * numerique ne dit : que le Soleil est blanc, que la Lune montre bien sa face
 * visible, que l'atmosphere tient la route.
 *
 * Usage : node scripts/shoot.mjs [nom-du-scenario]
 */
import { chromium } from 'playwright'
import * as A from 'astronomy-engine'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'shots')
const BASE = process.env.SHOOT_URL ?? 'http://localhost:5199'

const PARIS = { name: 'Paris', latitude: 48.8566, longitude: 2.3522, elevation: 35 }
const REYKJAVIK = { name: 'Reykjavík', latitude: 64.1466, longitude: -21.9426, elevation: 40 }

const BODY_BY_NAME = {
  sun: A.Body.Sun,
  moon: A.Body.Moon,
  mercury: A.Body.Mercury,
  venus: A.Body.Venus,
  mars: A.Body.Mars,
  jupiter: A.Body.Jupiter,
  saturn: A.Body.Saturn,
  uranus: A.Body.Uranus,
  neptune: A.Body.Neptune,
}

/**
 * Cherche un instant ou une direction equatoriale fixe est haute dans le ciel,
 * et renvoie l'instant et la visee correspondante.
 *
 * Sert aux objets du ciel profond, qui ne sont pas des corps du systeme solaire
 * et n'ont donc pas d'entree dans `window.__bodyStates`.
 */
function findTimeForTarget(ra, dec, location, { from, minAltitude = 45, requireDark = true, stepHours = 1, maxDays = 400 }) {
  const observer = new A.Observer(location.latitude, location.longitude, location.elevation)
  const start = new Date(from).getTime()

  for (let ms = start; ms < start + maxDays * 86400_000; ms += stepHours * 3600_000) {
    const date = new Date(ms)
    // `Horizon` attend une ascension droite en heures.
    const hor = A.Horizon(date, observer, ra / 15, dec, 'normal')
    if (hor.altitude < minAltitude) continue

    if (requireDark) {
      const sunEq = A.Equator(A.Body.Sun, date, observer, true, true)
      const sunAlt = A.Horizon(date, observer, sunEq.ra, sunEq.dec, 'normal').altitude
      // Nuit astronomique, et Lune couchee : conditions d'observation reelles.
      if (sunAlt > -18) continue
      const moonEq = A.Equator(A.Body.Moon, date, observer, true, true)
      if (A.Horizon(date, observer, moonEq.ra, moonEq.dec, 'normal').altitude > 0) continue
    }
    return { time: date.toISOString(), az: hor.azimuth, alt: hor.altitude }
  }
  return null
}

/**
 * Cherche un instant qui satisfait les contraintes d'un scenario.
 *
 * Coder une date en dur condamne la capture a devenir fausse : un corps sous
 * l'horizon ne donne qu'une image noire, et une phase precise ne se retrouve
 * qu'a quelques jours pres. On laisse donc les ephemerides trouver le moment.
 */
function findTime(
  bodyId,
  location,
  { from, minAltitude = 20, illuminationBelow, illuminationAbove, requireDark = false, stepHours = 1, maxDays = 400 },
) {
  const body = BODY_BY_NAME[bodyId]
  const observer = new A.Observer(location.latitude, location.longitude, location.elevation)
  const stepMs = stepHours * 3600_000
  const start = new Date(from).getTime()

  for (let ms = start; ms < start + maxDays * 86400_000; ms += stepMs) {
    const date = new Date(ms)
    const eq = A.Equator(body, date, observer, true, true)
    const hor = A.Horizon(date, observer, eq.ra, eq.dec, 'normal')
    if (hor.altitude < minAltitude) continue

    // De jour, le voile atmospherique delave le disque : on ne peut plus juger
    // ni la texture ni l'orientation de la planete.
    if (requireDark) {
      const sunEq = A.Equator(A.Body.Sun, date, observer, true, true)
      if (A.Horizon(date, observer, sunEq.ra, sunEq.dec, 'normal').altitude > -12) continue
    }

    if (illuminationBelow !== undefined || illuminationAbove !== undefined) {
      const fraction = A.Illumination(body, date).phase_fraction
      if (illuminationBelow !== undefined && fraction > illuminationBelow) continue
      if (illuminationAbove !== undefined && fraction < illuminationAbove) continue
    }
    return date.toISOString()
  }
  return null
}

/** `fov` en degres ; `az`/`alt` en degres ; `time` en ISO UTC. */
const SCENARIOS = [
  {
    name: '01-nuit-etoilee',
    time: '2026-08-16T22:30:00Z',
    location: PARIS,
    az: 180,
    alt: 35,
    fov: 70,
    note: 'ciel nocturne, constellations, magnitude limite haute',
  },
  // --- Ciel profond ---
  // M31 doit couvrir pres de trois degres, soit six fois la Lune. Si elle sort
  // ponctuelle, tout le rendu des objets etendus est faux.
  ...(() => {
    const m31 = findTimeForTarget(10.6848, 41.2688, PARIS, { from: '2026-09-01T00:00:00Z', minAltitude: 55 })
    if (!m31) return []
    return [
      {
        name: '11-m31-taille-reelle',
        time: m31.time,
        location: PARIS,
        az: m31.az,
        alt: m31.alt,
        fov: 12,
        note: 'M31 a sa taille reelle : environ 3°, un quart du champ',
      },
      {
        name: '12-ciel-profond-large',
        time: m31.time,
        location: PARIS,
        az: m31.az,
        alt: Math.max(20, m31.alt - 25),
        fov: 60,
        note: 'champ large : galaxies, amas et nebuleuses coexistent avec les etoiles',
      },
    ]
  })(),

  // Bisection du champ : a quel grossissement un disque planetaire cesse-t-il
  // d'etre rendu ? Un objet qui disparait en zoomant trahit un probleme de
  // troncature ou de precision, pas un defaut d'eclairage.
  ...[0.4, 0.2, 0.1, 0.05].map((fov) => ({
    name: `diag-saturne-fov-${String(fov).replace('.', '')}`,
    time: '2026-08-16T23:30:00Z',
    location: PARIS,
    follow: 'saturn',
    fov,
    note: `Saturne a ${fov}° de champ`,
  })),

  // Bisection : meme vue, un calque retire a chaque fois.
  ...[
    ['bloom', { bloom: false }],
    ['sol', { ground: false }],
    ['atmosphere', { atmosphere: false }],
    ['corps', { bodies: false }],
    ['satellites', { satellites: false, satelliteTracks: false }],
    ['etoiles', { stars: false, constellations: false }],
  ].map(([label, layers]) => ({
    name: `diag-nuit-sans-${label}`,
    time: '2026-08-16T22:30:00Z',
    location: PARIS,
    az: 180,
    alt: 35,
    fov: 70,
    layers,
    note: `temoin sans ${label}`,
  })),
  {
    name: '02-lune-face-visible',
    time: '2026-08-27T21:00:00Z',
    location: PARIS,
    follow: 'moon',
    fov: 1.2,
    note: 'la face visible doit montrer les mers sombres, pas la face cachee',
  },
  {
    name: '03-soleil-midi',
    time: '2026-06-21T12:00:00Z',
    location: PARIS,
    follow: 'sun',
    fov: 25,
    note: 'Soleil blanc et eblouissant, ciel bleu de Rayleigh',
  },
  {
    name: '03b-soleil-midi-sans-bloom',
    time: '2026-06-21T12:00:00Z',
    location: PARIS,
    follow: 'sun',
    fov: 25,
    bloom: false,
    note: 'temoin sans flou lumineux — isole l’effet du compositeur sur les couleurs',
  },
  {
    name: '03c-soleil-zoom',
    time: '2026-06-21T12:00:00Z',
    location: PARIS,
    follow: 'sun',
    fixedTime: true,
    fov: 1.5,
    note: 'disque solaire resolu : il doit etre blanc, plus clair que sa couronne',
  },
  {
    name: '03d-ciel-oppose-soleil',
    time: '2026-06-21T12:00:00Z',
    location: PARIS,
    az: 0,
    alt: 45,
    fov: 60,
    note: 'ciel de midi a l’oppose du Soleil : bleu franc, non delave',
  },
  {
    name: '04-coucher-soleil',
    time: '2026-08-16T19:15:00Z',
    location: PARIS,
    follow: 'sun',
    fixedTime: true,
    fov: 40,
    note: 'rougissement par extinction, degrade crepusculaire',
  },
  {
    name: '05-eclipse-totalite',
    time: '2026-08-12T17:49:00Z',
    location: REYKJAVIK,
    follow: 'sun',
    fixedTime: true,
    fov: 3,
    note: 'la Lune doit occulter le Soleil, le ciel s’assombrir',
  },
  {
    name: '06-eclipse-large',
    time: '2026-08-12T17:49:00Z',
    location: REYKJAVIK,
    follow: 'sun',
    fixedTime: true,
    fov: 60,
    note: 'ciel de totalite vu large : etoiles visibles en plein jour',
  },
  {
    // Le croissant de Venus est le controle le plus severe de l'eclairement :
    // une direction de lumiere fausse le retournerait sans rien casser d'autre.
    name: '09-venus-croissant',
    time: findTime('venus', PARIS, { from: '2026-01-01T00:00:00Z', minAltitude: 12, illuminationBelow: 0.22 }),
    location: PARIS,
    follow: 'venus',
    fixedTime: true,
    minAltitude: 10,
    fov: 0.3,
    note: 'Venus en croissant : la corne doit pointer a l’oppose du Soleil',
  },
  {
    name: '10-mars-gibbeuse',
    time: findTime('mars', PARIS, { from: '2026-01-01T00:00:00Z', minAltitude: 25, illuminationBelow: 0.93, requireDark: true }),
    location: PARIS,
    follow: 'mars',
    fixedTime: true,
    fov: 0.06,
    note: 'Mars gibbeuse : terminateur visible, calottes et Syrtis Major',
  },
  {
    name: '07-jupiter-disque',
    time: findTime('jupiter', PARIS, { from: '2026-08-01T00:00:00Z', minAltitude: 30, requireDark: true }),
    location: PARIS,
    follow: 'jupiter',
    fov: 0.05,
    note: 'bandes nuageuses resolues au tres petit champ',
  },
  {
    name: '08-saturne-anneaux',
    time: findTime('saturn', PARIS, { from: '2026-08-01T00:00:00Z', minAltitude: 30, requireDark: true }),
    location: PARIS,
    follow: 'saturn',
    fov: 0.05,
    note: 'anneaux inclines, division de Cassini',
  },
]

mkdirSync(OUT, { recursive: true })

const only = process.argv[2]
const scenarios = only ? SCENARIOS.filter((s) => s.name.includes(only)) : SCENARIOS

/**
 * Rendu materiel par defaut. Le rasteriseur logiciel (SwiftShader) produisait
 * des halos rectangulaires sur les zones composees separement : impossible de
 * juger la scene avec. `SHOOT_SOFTWARE=1` permet d'y revenir si besoin.
 */
const softwareArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
const hardwareArgs = ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
const browser = await chromium.launch({
  args: [...(process.env.SHOOT_SOFTWARE ? softwareArgs : hardwareArgs), '--disable-lcd-text'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(BASE, { waitUntil: 'networkidle' })
// Laisse le temps aux cartes de surface d'arriver.
await page.waitForTimeout(4000)

/**
 * Etat de reference des calques, releve une fois au demarrage.
 *
 * Chaque scenario repart de cette base plutot que de l'etat courant : sans
 * cela, un scenario de diagnostic qui coupe un calque le laisserait coupe pour
 * tous les suivants, et l'on interpreterait une image noire comme un defaut de
 * rendu alors que l'objet a simplement ete masque deux scenarios plus tot.
 */
const BASE_LAYERS = await page.evaluate(() => ({ ...window.__skyStore.getState().layers }))

/**
 * Feuille de style de capture : masque le chrome et neutralise les fonds
 * translucides. Les `backdrop-filter` echantillonnent le canvas WebGL et, dans
 * un navigateur sans accelaration materielle, laissent des halos rectangulaires
 * qui n'ont rien a voir avec la scene. On veut juger le rendu, pas le compositeur.
 */
await page.addStyleTag({
  content: `
    .sky-hud, .timeline, .md-nav-rail, .md-side-panel, .sky-labels { visibility: hidden !important; }
    * { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
  `,
})

for (const s of scenarios) {
  await page.evaluate(
    ({ time, location, az, alt, fov, follow, bloom, layers, baseLayers }) => {
      // Le store est expose sur `window` en developpement (voir main.tsx).
      const store = window.__skyStore
      store.setState({
        time: new Date(time).getTime(),
        live: false,
        playing: false,
        location,
        fov,
        panelOpen: false,
        layers: { ...baseLayers, constellationLabels: true, bloom: bloom !== false, ...layers },
      })
      if (!follow) store.getState().lookAt(az, alt)
      window.__followBody = follow ?? null
    },
    { ...s, baseLayers: BASE_LAYERS },
  )

  // Une visee sur un corps demande ses ephemerides : on les lit apres le calcul.
  if (s.follow) {
    await page.waitForTimeout(400)
    // Un corps sous l'horizon ne donnerait qu'une image noire. On avance d'heure
    // en heure jusqu'a le trouver assez haut — sauf pour une eclipse, dont
    // l'instant est impose.
    const aim = await page.evaluate(
      async ({ id, minAltitude, fixedTime }) => {
        const store = window.__skyStore
        const read = () => window.__bodyStates?.find((b) => b.id === id)
        const wait = () => new Promise((r) => setTimeout(r, 260))

        for (let step = 0; step < (fixedTime ? 1 : 72); step++) {
          const body = read()
          if (!body) return null
          if (fixedTime || body.horizontal.altitude >= minAltitude) {
            return { az: body.horizontal.azimuth, alt: body.horizontal.altitude, time: store.getState().time }
          }
          store.setState({ time: store.getState().time + 3600_000 })
          await wait()
        }
        const body = read()
        return body ? { az: body.horizontal.azimuth, alt: body.horizontal.altitude, time: store.getState().time } : null
      },
      { id: s.follow, minAltitude: s.minAltitude ?? 25, fixedTime: Boolean(s.fixedTime) },
    )

    if (!aim) {
      console.log(`${s.name.padEnd(24)} IGNORE — ephemerides indisponibles`)
      continue
    }
    await page.evaluate(({ az, alt }) => window.__skyStore.getState().lookAt(az, alt), aim)
    s.resolvedTime = new Date(aim.time).toISOString().slice(0, 16).replace('T', ' ')
    s.resolvedAltitude = aim.alt
  }

  // La camera rejoint sa cible avec amortissement : on la laisse se poser.
  await page.waitForTimeout(2200)
  await page.screenshot({ path: join(OUT, `${s.name}.png`) })
  // Capture du canvas seul : elle isole le rendu 3D du compositing des
  // surfaces translucides de l'interface, qui peuvent introduire leurs
  // propres artefacts.
  // Controle de visee : si la camera n'est pas la ou on la croit, l'image est
  // noire pour une raison qui n'a rien a voir avec le rendu.
  const view = await page.evaluate(() => {
    const s = window.__skyStore.getState()
    return { az: s.viewAzimuth, alt: s.viewAltitude, fov: s.fov }
  })
  const when = s.resolvedTime ? ` [${s.resolvedTime} UTC, h=${s.resolvedAltitude.toFixed(0)}°]` : ''
  const aimed = s.follow
    ? ` visee ${view.az.toFixed(1)}°/${view.alt.toFixed(1)}° champ ${view.fov.toFixed(2)}°`
    : ''
  console.log(`${s.name.padEnd(24)} ${s.note}${when}${aimed}`)
}

await browser.close()

if (errors.length) {
  console.log(`\n${errors.length} erreur(s) console :`)
  for (const e of [...new Set(errors)].slice(0, 10)) console.log(`  ${e}`)
  process.exitCode = 1
} else {
  console.log('\nAucune erreur console.')
}
console.log(`Captures dans ${OUT}`)

