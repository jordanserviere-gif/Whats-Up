/**
 * Baseline du moteur atmospherique : cout GPU mesure et sondes de rendu.
 *
 * Deux mesures, pour deux questions distinctes.
 *
 * ## 1. Cout GPU du noyau, isole
 *
 * Mesurer les images de l'application ne dit **rien** : le rendu est verrouille
 * au vsync et affiche 16,7 ms dans toutes les situations, quelle que soit la
 * marge reelle. On compile donc le noyau de diffusion seul dans un quad plein
 * ecran, hors de toute scene, et on chronometre des passes successives
 * synchronisees par `readPixels`.
 *
 * Le resultat est un **cout en nanosecondes par pixel**, comparable d'une phase
 * a l'autre et independant de la resolution. C'est le seul chiffre de
 * performance de ce projet sur lequel on puisse raisonner.
 *
 * Chaque phase qui ajoute une physique au GPU ajoute son noyau a `KERNELS` et
 * herite de la mesure.
 *
 * ## 2. Sondes de rendu
 *
 * Des couleurs relevees a des directions fixes, dans des scenarios fixes. Elles
 * servent de reference de non-regression : le moteur va etre refondu par
 * couches, et une derive de colorimetrie doit se voir en nombres, pas au
 * jugement sur une capture PNG.
 *
 * Usage : npm run atmo:baseline              (mesure et compare)
 *         npm run atmo:baseline -- --write   (ecrit la nouvelle reference)
 *
 * Le serveur de developpement doit tourner (`npm run dev -- --port 5199`), ou
 * `SHOOT_URL` doit pointer ailleurs.
 */
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'docs', 'atmosphere-baseline.json')
const BASE = process.env.SHOOT_URL ?? 'http://localhost:5199'
const WRITE = process.argv.includes('--write')

const PARIS = { name: 'Paris', latitude: 48.8566, longitude: 2.3522, elevation: 35 }

/**
 * Noyaux GPU mesures.
 *
 * `build` recoit le module `scene/atmosphere.ts` importe dans la page et rend
 * le corps du fragment shader. Le quad, la synchronisation et le chronometrage
 * sont communs : deux noyaux sont donc toujours comparables entre eux.
 */
const KERNELS = [
  {
    name: 'diffusion simple Rayleigh+Mie (16×8, moteur actuel)',
    phase: 'baseline',
    build: (m) => ({
      glsl: m.ATMOSPHERE_GLSL,
      body: `
        vec3 tr;
        vec3 c = atmosphereScatter(
          dir, vec3(0.0, ${m.PLANET_RADIUS_M.toFixed(1)}, 0.0), uSun, ${m.SUN_INTENSITY_REF.toFixed(1)},
          ${m.PLANET_RADIUS_M.toFixed(1)}, ${m.ATMOSPHERE_RADIUS_M.toFixed(1)},
          vec3(${m.RAYLEIGH_COEFFICIENTS.map((v) => v.toExponential()).join(',')}),
          ${m.MIE_COEFFICIENT.toExponential()},
          ${m.RAYLEIGH_SCALE_HEIGHT_M.toFixed(1)}, ${m.MIE_SCALE_HEIGHT_M.toFixed(1)}, ${m.MIE_G},
          1e9, tr);
        // \`tr\` entre dans le resultat pour que le compilateur ne puisse pas
        // eliminer le calcul de transmittance, qui fait partie du cout reel.
        frag = vec4(c * 0.3 + tr * 1e-6, 1.0);
      `,
    }),
  },
]

/** Directions sondees, en coordonnees horizontales relatives a l'azimut solaire. */
const PROBE_DIRECTIONS = [
  { name: 'zenith', dAz: 0, alt: 88 },
  { name: 'vers-soleil-30', dAz: 0, alt: 30 },
  { name: 'vers-soleil-horizon', dAz: 0, alt: 2 },
  { name: 'perpendiculaire-30', dAz: 90, alt: 30 },
  { name: 'antisoleil-30', dAz: 180, alt: 30 },
  { name: 'antisoleil-horizon', dAz: 180, alt: 2 },
]

/** Scenarios : instants choisis pour couvrir toute la plage de hauteur solaire. */
const PROBE_SCENARIOS = [
  { name: 'midi', time: '2026-06-21T12:00:00Z' },
  { name: 'apres-midi', time: '2026-06-21T16:00:00Z' },
  { name: 'soleil-bas', time: '2026-06-21T18:45:00Z' },
  { name: 'coucher', time: '2026-06-21T19:52:00Z' },
  { name: 'crepuscule-civil', time: '2026-06-21T20:40:00Z' },
  { name: 'crepuscule-nautique', time: '2026-06-21T21:30:00Z' },
  { name: 'nuit', time: '2026-06-21T23:30:00Z' },
]

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-lcd-text'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })

const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))

try {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15_000 })
} catch {
  console.error(
    `Serveur injoignable sur ${BASE}.\n` +
      `Lancer « npm run dev -- --port 5199 » dans un autre terminal, ou definir SHOOT_URL.`,
  )
  await browser.close()
  process.exit(1)
}
await page.waitForTimeout(3000)

// Le chrome de l'interface masquerait une partie du ciel et retrecirait le
// canvas : on le retire avant toute sonde.
await page.addStyleTag({
  content: `.sky-hud,.timeline,.md-nav-rail,.md-side-panel,.sky-labels{display:none!important}
            *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}`,
})
await page.evaluate(() => window.__skyStore.setState({ panelOpen: false }))
await page.waitForTimeout(600)

// ---------------------------------------------------------------------------
// Environnement
// ---------------------------------------------------------------------------

const environment = await page.evaluate(() => {
  const c = document.querySelector('canvas')
  const gl = c && (c.getContext('webgl2') || c.getContext('webgl'))
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info')
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    webgl2: !!(c && c.getContext('webgl2')),
    colorBufferFloat: !!(gl && gl.getExtension('EXT_color_buffer_float')),
    floatLinear: !!(gl && gl.getExtension('OES_texture_float_linear')),
    max3DTexture: gl && gl.MAX_3D_TEXTURE_SIZE ? gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) : null,
    webgpuAvailable: 'gpu' in navigator,
    canvas: c ? { width: c.width, height: c.height } : null,
  }
})

// ---------------------------------------------------------------------------
// 1. Cout GPU des noyaux
// ---------------------------------------------------------------------------

const kernels = {}
for (const kernel of KERNELS) {
  const result = await page.evaluate(
    async ({ source }) => {
      const module = await import('/src/scene/atmosphere.ts')
      // eslint-disable-next-line no-new-func
      const build = new Function(`return (${source})`)()
      const { glsl, body } = build(module)

      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })
      if (!gl) return { error: 'WebGL2 indisponible' }

      const vertex = `#version 300 es
        in vec2 p; out vec2 uv;
        void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`

      // Les directions balayent tout l'hemisphere visible : le cout depend
      // fortement de la hauteur (une visee rasante traverse onze cents
      // kilometres d'air), et ne mesurer que le zenith flatterait le resultat.
      const fragment = `#version 300 es
        precision highp float;
        ${glsl.replace(/\bvarying\b/g, 'in')}
        in vec2 uv; out vec4 frag;
        uniform vec3 uSun; uniform float uSeed;
        void main(){
          float az = uv.x * 6.2831853;
          float al = uv.y * 1.5707963 - 0.01 + uSeed * 1e-9;
          vec3 dir = normalize(vec3(cos(al) * sin(az), sin(al), -cos(al) * cos(az)));
          ${body}
        }`

      const compile = (type, src) => {
        const s = gl.createShader(type)
        gl.shaderSource(s, src)
        gl.compileShader(s)
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
        return s
      }

      let program
      try {
        program = gl.createProgram()
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex))
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment))
        gl.linkProgram(program)
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
      } catch (e) {
        return { error: String(e) }
      }

      gl.useProgram(program)
      const buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      const location = gl.getAttribLocation(program, 'p')
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
      gl.uniform3f(gl.getUniformLocation(program, 'uSun'), 0.3, 0.5, -0.8)
      const seed = gl.getUniformLocation(program, 'uSeed')

      const pixel = new Uint8Array(4)
      const run = (w, h, reps) => {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
        for (let i = 0; i < 4; i++) {
          gl.uniform1f(seed, i)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
        }
        // `readPixels` force la synchronisation : sans lui on ne mesurerait que
        // le temps d'empilement des commandes, pas le travail du GPU.
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)

        const t0 = performance.now()
        for (let i = 0; i < reps; i++) {
          gl.uniform1f(seed, i)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
        }
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        const elapsed = performance.now() - t0
        return { msPerPass: elapsed / reps, nsPerPixel: (elapsed * 1e6) / (reps * w * h) }
      }

      // Trois resolutions : si le cout par pixel reste constant, la passe est
      // limitee par le remplissage, ce qui autorise l'extrapolation.
      const measurements = {
        '1440x900': run(1440, 900, 24),
        '720x450': run(720, 450, 48),
        '360x225': run(360, 225, 96),
      }
      return { measurements }
    },
    { source: kernel.build.toString() },
  )

  if (result.error) {
    console.error(`Noyau « ${kernel.name} » : ${result.error}`)
    continue
  }

  const values = Object.values(result.measurements).map((m) => m.nsPerPixel)
  const spread = (Math.max(...values) - Math.min(...values)) / Math.max(...values)

  kernels[kernel.name] = {
    phase: kernel.phase,
    measurements: result.measurements,
    nsPerPixel: result.measurements['1440x900'].nsPerPixel,
    fillRateBound: spread < 0.5,
    // Extrapolations aux resolutions reellement rendues par l'application,
    // dont le `dpr` est plafonne a 2.
    projectedMs: {
      '1440x900@dpr1': (result.measurements['1440x900'].nsPerPixel * 1440 * 900) / 1e6,
      '1440x900@dpr2': (result.measurements['1440x900'].nsPerPixel * 2880 * 1800) / 1e6,
      '1920x1080@dpr2': (result.measurements['1440x900'].nsPerPixel * 3840 * 2160) / 1e6,
    },
  }
}

// ---------------------------------------------------------------------------
// 2. Sondes de rendu
// ---------------------------------------------------------------------------

/** Lit la couleur du canvas a des positions ecran, via une capture decodee dans la page. */
async function readPixels(points) {
  const b64 = (await page.screenshot()).toString('base64')
  return page.evaluate(
    async ({ b64, points }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
      const c = document.createElement('canvas')
      c.width = bitmap.width
      c.height = bitmap.height
      const ctx = c.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      const out = {}
      for (const p of points) {
        const d = ctx.getImageData(Math.round(p.x * bitmap.width), Math.round(p.y * bitmap.height), 1, 1).data
        out[p.name] = [d[0], d[1], d[2]]
      }
      return out
    },
    { b64, points },
  )
}

const probes = {}
for (const scenario of PROBE_SCENARIOS) {
  // Chaque direction est visee au centre de l'ecran : c'est la seule facon
  // d'echantillonner une direction du ciel sans dependre de la projection.
  const sunAzimuth = await page.evaluate(
    ({ time, location }) => {
      const store = window.__skyStore
      store.setState({ time: new Date(time).getTime(), live: false, playing: false, location, fov: 60 })
      return null
    },
    { time: scenario.time, location: PARIS },
  ).then(async () => {
    await page.waitForTimeout(400)
    return page.evaluate(() => window.__bodyStates?.find((b) => b.id === 'sun')?.horizontal ?? null)
  })

  if (!sunAzimuth) {
    console.error(`Scenario « ${scenario.name} » : ephemerides indisponibles.`)
    continue
  }

  const entry = { time: scenario.time, sunAltitude: sunAzimuth.altitude, directions: {} }

  for (const dir of PROBE_DIRECTIONS) {
    await page.evaluate(
      ({ az, alt }) => window.__skyStore.getState().lookAt(az, alt),
      { az: (sunAzimuth.azimuth + dir.dAz) % 360, alt: dir.alt },
    )
    // La camera rejoint sa cible avec amortissement : il faut la laisser poser.
    await page.waitForTimeout(1400)
    const read = await readPixels([{ name: 'centre', x: 0.5, y: 0.5 }])
    entry.directions[dir.name] = read.centre
  }

  probes[scenario.name] = entry
}

await browser.close()

// ---------------------------------------------------------------------------
// Rapport et comparaison
// ---------------------------------------------------------------------------

const report = {
  recordedAt: new Date().toISOString(),
  environment,
  kernels,
  probes,
  consoleErrors: [...new Set(errors)],
}

console.log(`\nEnvironnement : ${environment.renderer ?? 'inconnu'}`)
console.log(
  `WebGL2 ${environment.webgl2 ? 'oui' : 'non'} · float RT ${environment.colorBufferFloat ? 'oui' : 'non'} · ` +
    `texture 3D max ${environment.max3DTexture} · WebGPU ${environment.webgpuAvailable ? 'present' : 'absent'}`,
)

console.log('\n--- Cout GPU des noyaux ---')
for (const [name, k] of Object.entries(kernels)) {
  console.log(`\n${name}`)
  console.log(
    `  ${k.nsPerPixel.toFixed(2)} ns/pixel` +
      `${k.fillRateBound ? ' (limite par le remplissage : extrapolation valide)' : ' (NON lineaire en pixels — extrapolation douteuse)'}`,
  )
  for (const [target, ms] of Object.entries(k.projectedMs)) {
    const share = (ms / 16.67) * 100
    console.log(`  ${target.padEnd(18)} ${ms.toFixed(2).padStart(6)} ms  soit ${share.toFixed(0).padStart(3)} % d'une image a 60 Hz`)
  }
}

console.log('\n--- Sondes de rendu (RGB au centre de l’ecran) ---')
for (const [name, entry] of Object.entries(probes)) {
  console.log(`\n${name}  (Soleil a ${entry.sunAltitude.toFixed(1)}°)`)
  for (const [dir, rgb] of Object.entries(entry.directions)) {
    console.log(`  ${dir.padEnd(22)} ${rgb.map((v) => String(v).padStart(3)).join(' ')}`)
  }
}

if (errors.length) {
  console.log(`\n${errors.length} erreur(s) console :`)
  for (const e of [...new Set(errors)].slice(0, 5)) console.log(`  ${e}`)
}

// Comparaison a la reference committee, si elle existe.
let failures = 0
if (existsSync(BASELINE) && !WRITE) {
  const previous = JSON.parse(readFileSync(BASELINE, 'utf8'))
  console.log('\n--- Comparaison a la reference ---')
  console.log(`reference enregistree le ${previous.recordedAt}`)

  for (const [name, entry] of Object.entries(probes)) {
    const before = previous.probes?.[name]
    if (!before) continue
    for (const [dir, rgb] of Object.entries(entry.directions)) {
      const old = before.directions?.[dir]
      if (!old) continue
      const drift = Math.max(...rgb.map((v, i) => Math.abs(v - old[i])))
      // Deux niveaux sur 255 : au-dela, l'ecart depasse le bruit de rendu et
      // designe un vrai changement de colorimetrie.
      if (drift > 2) {
        failures++
        console.log(`  DERIVE ${name}/${dir} : ${old.join(',')} → ${rgb.join(',')} (max ${drift})`)
      }
    }
  }

  for (const [name, k] of Object.entries(kernels)) {
    const before = previous.kernels?.[name]
    if (!before) continue
    const ratio = k.nsPerPixel / before.nsPerPixel
    console.log(`  ${name} : ${before.nsPerPixel.toFixed(2)} → ${k.nsPerPixel.toFixed(2)} ns/px (×${ratio.toFixed(2)})`)
  }

  console.log(failures === 0 ? '\nAucune derive de colorimetrie.' : `\n${failures} derive(s) de colorimetrie.`)
} else {
  mkdirSync(dirname(BASELINE), { recursive: true })
  writeFileSync(BASELINE, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nReference ecrite dans ${BASELINE}`)
}

process.exit(failures === 0 ? 0 : 1)
