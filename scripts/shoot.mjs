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
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'shots')
const BASE = process.env.SHOOT_URL ?? 'http://localhost:5199'

const PARIS = { name: 'Paris', latitude: 48.8566, longitude: 2.3522, elevation: 35 }
const REYKJAVIK = { name: 'Reykjavík', latitude: 64.1466, longitude: -21.9426, elevation: 40 }

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
    name: '07-jupiter-disque',
    time: '2026-08-16T23:30:00Z',
    location: PARIS,
    follow: 'jupiter',
    fov: 0.4,
    note: 'bandes nuageuses resolues au tres petit champ',
  },
  {
    name: '08-saturne-anneaux',
    time: '2026-08-16T23:30:00Z',
    location: PARIS,
    follow: 'saturn',
    fov: 0.4,
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
    ({ time, location, az, alt, fov, follow, bloom, layers }) => {
      // Le store est expose sur `window` en developpement (voir main.tsx).
      const store = window.__skyStore
      store.setState({
        time: new Date(time).getTime(),
        live: false,
        playing: false,
        location,
        fov,
        panelOpen: false,
        layers: { ...store.getState().layers, constellationLabels: true, bloom: bloom !== false, ...layers },
      })
      if (!follow) store.getState().lookAt(az, alt)
      window.__followBody = follow ?? null
    },
    s,
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
