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
 * `build` recoit le module designe par `modulePath` — importe dans la page — et
 * rend le corps du fragment shader. Le quad, la synchronisation et le
 * chronometrage sont communs : deux noyaux sont donc toujours comparables entre
 * eux.
 *
 * `setup` est facultatif : c'est la source d'une fonction `(gl, program)`
 * executee apres l'edition de liens, pour les noyaux qui ont besoin de
 * textures. Elle est passee en texte parce que tout ceci s'execute dans la
 * page, pas ici.
 */
const KERNELS = [
  {
    name: 'diffusion simple Rayleigh+Mie (16×8, ancien noyau analytique)',
    phase: 'baseline',
    modulePath: '/src/scene/atmosphere.ts',
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
  {
    // Depuis la phase 9, plus aucun materiau n'appelle le noyau ci-dessus : le
    // fond de ciel, les corps et les avions echantillonnent tous la table de
    // perspective atmospherique. C'est **ce noyau-ci** qui tourne reellement, et
    // le precedent n'est conserve que comme point de comparaison historique.
    name: 'lecture de la table de perspective atmospherique (phase 9)',
    phase: '9',
    modulePath: '/src/atmosphere/lut/aerialPerspectiveLut.ts',
    build: (m) => ({
      // Les materiaux sont en GLSL ES 1.00, ou `texture2D` est la bonne
      // fonction ; le banc compile en 3.00, ou elle s'appelle `texture`.
      glsl: m.AERIAL_LUT_GLSL.replace(/texture2D\(/g, 'texture('),
      body: `
        // Deux lectures : un astre a l'infini et un objet a distance finie.
        // C'est ce que fait une image reelle, ou le ciel et les objets tapent
        // dans la meme table.
        vec3 tFar;
        vec3 far = aerialPerspectiveToSpace(dir, tFar);
        vec3 tNear;
        vec3 near = aerialPerspective(dir, 40000.0 + uSeed, tNear);
        frag = vec4(far + near * 1e-3 + (tFar + tNear) * 1e-6, 1.0);
      `,
      setup: `(gl, program) => {
        const W = 64, ROWS = 512;
        // Contenu plausible plutot que nul : une texture uniforme pourrait
        // flatter le cout d'echantillonnage sur certains pilotes.
        const data = new Float32Array(W * ROWS * 4);
        for (let i = 0; i < data.length; i += 4) {
          const t = (i / 4) / (W * ROWS);
          data[i] = t * 12.0; data[i + 1] = t * 9.0; data[i + 2] = t * 20.0; data[i + 3] = 0;
        }
        const make = (unit) => {
          const tex = gl.createTexture();
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, ROWS, 0, gl.RGBA, gl.FLOAT, data);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          return tex;
        };
        make(2); make(3);
        gl.uniform1i(gl.getUniformLocation(program, 'uAerialScattered'), 2);
        gl.uniform1i(gl.getUniformLocation(program, 'uAerialTransmittance'), 3);
        gl.uniform3f(gl.getUniformLocation(program, 'uAerialSize'), W, 32, 16);
        gl.uniform3f(gl.getUniformLocation(program, 'uAerialSunDir'), 0.3, 0.5, -0.8);
        gl.uniform1f(gl.getUniformLocation(program, 'uAerialExposure'), 1.0);
        gl.uniform1f(gl.getUniformLocation(program, 'uAerialObserverRadius'), 6371000.0);
        gl.uniform1f(gl.getUniformLocation(program, 'uAerialTopRadius'), 6471000.0);
      }`,
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

// ---------------------------------------------------------------------------
// 1. Cout GPU des noyaux — AVANT toute mise en route de l'application
// ---------------------------------------------------------------------------
//
// L'ordre n'est pas cosmetique. Mesure alors que l'onglet de la scene tournait,
// la passe additionnait au noyau tout ce que l'application rend par ailleurs a
// soixante images par seconde : le chiffre variait de 30 % d'une execution a
// l'autre sans que le GLSL mesure ait change d'un caractere. Le banc s'execute
// donc en premier, dans une page vierge, avant que l'application ne soit
// chargee.

/**
 * Page vierge, servie depuis l'origine du serveur de developpement.
 *
 * **Le banc doit tourner sans l'application.** Mesure dans l'onglet de la
 * scene, il additionnait au noyau le cout de tout ce que l'application rend par
 * ailleurs, a soixante images par seconde. Le chiffre montait alors avec la
 * charge du rendu au lieu de decrire le noyau — c'est ce qui a produit une
 * derive apparente de 79 % lors du passage a la chaine lineaire, alors que le
 * code GLSL mesure n'avait pas change d'un caractere.
 *
 * L'origine doit rester celle du serveur pour que `import('/src/…')` passe par
 * la transformation de Vite ; on intercepte donc une URL du serveur plutot que
 * d'utiliser `about:blank`.
 */
const bench = await browser.newPage()
await bench.route('**/__bench.html', (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>bench</title>' }),
)
await bench.goto(`${BASE}/__bench.html`)

// ---------------------------------------------------------------------------
// Environnement
// ---------------------------------------------------------------------------

const environment = await bench.evaluate(() => {
  // Canvas jetable : la page du banc n'en contient aucun, et les capacites du
  // contexte ne dependent pas de qui l'a cree.
  const c = document.createElement('canvas')
  const gl = c.getContext('webgl2') || c.getContext('webgl')
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info')
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    webgl2: !!c.getContext('webgl2'),
    colorBufferFloat: !!(gl && gl.getExtension('EXT_color_buffer_float')),
    floatLinear: !!(gl && gl.getExtension('OES_texture_float_linear')),
    max3DTexture: gl && gl.MAX_3D_TEXTURE_SIZE ? gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) : null,
    webgpuAvailable: 'gpu' in navigator,
  }
})

const kernels = {}
for (const kernel of KERNELS) {
  const result = await bench.evaluate(
    async ({ source, modulePath }) => {
      const module = await import(modulePath)
      // eslint-disable-next-line no-new-func
      const build = new Function(`return (${source})`)()
      const { glsl, body, setup } = build(module)

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
      if (setup) {
        // eslint-disable-next-line no-new-func
        new Function(`return (${setup})`)()(gl, program)
      }
      const seed = gl.getUniformLocation(program, 'uSeed')

      const pixel = new Uint8Array(4)

      /**
       * Un lot de passes, synchronise a la fin.
       *
       * `readPixels` force la synchronisation : sans lui on ne mesurerait que le
       * temps d'empilement des commandes, pas le travail du GPU.
       */
      const drawBatch = (reps) => {
        for (let i = 0; i < reps; i++) {
          gl.uniform1f(seed, i)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
        }
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      }

      /**
       * Mesure d'un noyau a une resolution donnee.
       *
       * Trois precautions, et chacune corrige un defaut constate :
       *
       * 1. **Chauffe au temps, pas au nombre de passes.** Un GPU au repos tourne
       *    a frequence reduite et met des centaines de millisecondes a monter.
       *    Quatre passes de chauffe mesuraient donc la montee en frequence
       *    autant que le noyau — d'ou des ecarts de 40 % entre deux executions
       *    du meme code.
       * 2. **Plusieurs echantillons, et la mediane.** Un echantillon unique est
       *    a la merci d'une preemption du compositeur ou du ramasse-miettes.
       * 3. **Nombre de passes calibre**, pour que chaque echantillon dure assez
       *    longtemps devant la resolution de `performance.now()`.
       *
       * La dispersion est **rendue avec la mesure** : un chiffre de performance
       * sans son incertitude ne permet pas de juger une regression.
       */
      const run = (w, h, { warmupMs = 400, samples = 9, targetSampleMs = 25 } = {}) => {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)

        let reps = 8
        const warmStart = performance.now()
        while (performance.now() - warmStart < warmupMs) drawBatch(reps)

        // Calibrage sur une passe chaude.
        const probeStart = performance.now()
        drawBatch(reps)
        const probeMs = Math.max(0.05, performance.now() - probeStart)
        reps = Math.max(4, Math.min(4096, Math.ceil((reps * targetSampleMs) / probeMs)))

        const values = []
        for (let s = 0; s < samples; s++) {
          const start = performance.now()
          drawBatch(reps)
          values.push(((performance.now() - start) * 1e6) / (reps * w * h))
        }
        values.sort((a, b) => a - b)

        const median = values[values.length >> 1]
        return {
          nsPerPixel: median,
          minNsPerPixel: values[0],
          maxNsPerPixel: values[values.length - 1],
          // Dispersion relative a la mediane : au-dela de quelques pour cent, la
          // mesure ne permet pas de conclure sur une variation du meme ordre.
          spread: (values[values.length - 1] - values[0]) / median,
          msPerPass: (median * reps * w * h) / 1e6 / reps,
          reps,
          samples,
        }
      }

      // Trois resolutions : si le cout par pixel reste constant, la passe est
      // limitee par le remplissage, ce qui autorise l'extrapolation.
      const measurements = {
        '1440x900': run(1440, 900),
        '720x450': run(720, 450),
        '360x225': run(360, 225),
      }
      return { measurements }
    },
    { source: kernel.build.toString(), modulePath: kernel.modulePath },
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
    spread: result.measurements['1440x900'].spread,
    samples: result.measurements['1440x900'].samples,
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
// L'application : chargee seulement une fois le banc termine.
// ---------------------------------------------------------------------------

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

/**
 * Sonde du disque solaire.
 *
 * Le Soleil est la seule surface de la scene dont la valeur depasse largement
 * le blanc : c'est donc elle qui revele si la chaine d'affichage conserve son
 * ecretage et son debordement en halo. Aucune sonde de ciel ne peut le dire —
 * elles echantillonnent toutes des valeurs sous le blanc.
 */
async function probeSunDisc(time) {
  const aim = await page.evaluate(
    ({ location, time }) => {
      const store = window.__skyStore
      store.setState({
        time: new Date(time).getTime(),
        live: false,
        playing: false,
        location,
        fov: 0.6,
      })
      return null
    },
    { location: PARIS, time },
  ).then(async () => {
    await page.waitForTimeout(500)
    return page.evaluate(() => window.__bodyStates?.find((b) => b.id === 'sun')?.horizontal ?? null)
  })

  if (!aim) return null
  await page.evaluate(({ azimuth, altitude }) => window.__skyStore.getState().lookAt(azimuth, altitude), aim)
  // Le champ passe de 60° a 0,6° : la camera a une constante de temps, il faut
  // lui laisser franchir les deux ordres de grandeur avant de lire un pixel.
  await page.waitForTimeout(2600)

  return readPixels([
    { name: 'centre-disque', x: 0.5, y: 0.5 },
    { name: 'limbe', x: 0.5, y: 0.34 },
    { name: 'couronne', x: 0.5, y: 0.12 },
  ])
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

// Deux hauteurs solaires : haute, ou le disque doit rester ecrete au blanc, et
// rasante, ou l'extinction spectrale doit le rougir et l'attenuer. La seconde
// est la seule qui teste reellement le transport direct de la phase 4 — a midi
// la colonne est si courte que n'importe quel modele donnerait du blanc.
for (const [name, time] of [
  ['disque-solaire', '2026-06-21T12:00:00Z'],
  ['disque-solaire-rasant', '2026-06-21T19:40:00Z'],
]) {
  const disc = await probeSunDisc(time)
  if (disc) probes[name] = { time, sunAltitude: null, directions: disc }
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
    `  ${k.nsPerPixel.toFixed(2)} ns/pixel  ±${(k.spread * 100).toFixed(1)} % sur ${k.samples} echantillons` +
      `${k.fillRateBound ? '  (limite par le remplissage : extrapolation valide)' : '  (NON lineaire en pixels — extrapolation douteuse)'}`,
  )
  for (const [target, ms] of Object.entries(k.projectedMs)) {
    const share = (ms / 16.67) * 100
    console.log(`  ${target.padEnd(18)} ${ms.toFixed(2).padStart(6)} ms  soit ${share.toFixed(0).padStart(3)} % d'une image a 60 Hz`)
  }
}

console.log('\n--- Sondes de rendu (RGB au centre de l’ecran) ---')
for (const [name, entry] of Object.entries(probes)) {
  // La sonde du disque solaire n'a pas de hauteur associee : elle vise le
  // Soleil, elle ne decrit pas une direction du ciel a un instant donne.
  const when = entry.sunAltitude === null ? '' : `  (Soleil a ${entry.sunAltitude.toFixed(1)}°)`
  console.log(`\n${name}${when}`)
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
    // Une variation inferieure a la dispersion des deux mesures n'est pas une
    // variation : la signaler comme telle serait du bruit presente en resultat.
    const noise = Math.max(k.spread ?? 0, before.spread ?? 0)
    const verdict = Math.abs(ratio - 1) <= noise ? 'dans le bruit' : `×${ratio.toFixed(2)}`
    console.log(
      `  ${name} : ${before.nsPerPixel.toFixed(2)} → ${k.nsPerPixel.toFixed(2)} ns/px ` +
        `(${verdict}, dispersion ±${(noise * 100).toFixed(1)} %)`,
    )
  }

  console.log(failures === 0 ? '\nAucune derive de colorimetrie.' : `\n${failures} derive(s) de colorimetrie.`)
} else {
  mkdirSync(dirname(BASELINE), { recursive: true })
  writeFileSync(BASELINE, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nReference ecrite dans ${BASELINE}`)
}

process.exit(failures === 0 ? 0 : 1)
