/**
 * Recupere les cartes de surface des corps du systeme solaire.
 *
 * Source : Solar System Scope, via Wikimedia Commons — licence CC BY 4.0.
 * L'attribution figure dans le README et dans le panneau « Reglages ».
 *
 * `Special:FilePath` sait redimensionner cote serveur : on demande directement
 * la largeur voulue plutot que de rapatrier des cartes 8k pour les reduire ici.
 *
 * Usage : npm run textures
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'textures')

const UA = 'ciel-observation/0.1 (webapp astronomie; contact via depot local)'
const filePath = (name, width) =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=${width}`

/**
 * La Lune est le seul corps qu'on resout vraiment a l'oeil : elle merite deux
 * fois plus de definition. Les geantes gazeuses n'ont pas de detail fin a
 * quelques secondes d'arc.
 */
const TEXTURES = [
  { out: 'mercury.jpg', file: 'Solarsystemscope_texture_2k_mercury.jpg', width: 1024 },
  { out: 'venus.jpg', file: 'Solarsystemscope_texture_2k_venus_atmosphere.jpg', width: 1024 },
  { out: 'moon.jpg', file: 'Solarsystemscope_texture_8k_moon.jpg', width: 2048 },
  { out: 'mars.jpg', file: 'Solarsystemscope_texture_2k_mars.jpg', width: 1024 },
  { out: 'jupiter.jpg', file: 'Solarsystemscope_texture_2k_jupiter.jpg', width: 1024 },
  { out: 'saturn.jpg', file: 'Solarsystemscope_texture_2k_saturn.jpg', width: 1024 },
  { out: 'saturn-ring.png', file: 'Solarsystemscope_texture_2k_saturn_ring_alpha.png', width: 1024 },
  { out: 'uranus.jpg', file: 'Solarsystemscope_texture_2k_uranus.jpg', width: 1024 },
  { out: 'neptune.jpg', file: 'Solarsystemscope_texture_2k_neptune.jpg', width: 1024 },
]

mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Wikimedia limite la generation de vignettes : un 429 est attendu si l'on
 * enchaine trop vite. On respecte `Retry-After` quand il est fourni, sinon on
 * double l'attente a chaque essai.
 */
async function download(url, attempts = 6) {
  let wait = 3000
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (res.ok) return Buffer.from(await res.arrayBuffer())
    if (res.status !== 429 && res.status !== 503) throw new Error(`HTTP ${res.status}`)
    const retryAfter = Number(res.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait
    process.stdout.write(`[${res.status}, nouvel essai dans ${Math.round(delay / 1000)} s] `)
    await sleep(delay)
    wait = Math.min(wait * 2, 60000)
  }
  throw new Error(`abandon apres ${attempts} essais`)
}

let total = 0
let downloaded = 0
for (const tex of TEXTURES) {
  const target = join(OUT, tex.out)
  if (existsSync(target)) {
    const size = statSync(target).size
    total += size
    console.log(`${tex.out.padEnd(18)} deja present (${Math.round(size / 1024)} Ko)`)
    continue
  }

  // Cadence volontairement lente : on ne telecharge ces cartes qu'une fois.
  if (downloaded > 0) await sleep(2500)
  process.stdout.write(`${tex.out.padEnd(18)} telechargement… `)
  try {
    const buffer = await download(filePath(tex.file, tex.width))
    writeFileSync(target, buffer)
    total += buffer.length
    downloaded++
    console.log(`${Math.round(buffer.length / 1024)} Ko`)
  } catch (err) {
    console.log(`ECHEC ${err.message}`)
    process.exitCode = 1
  }
}

console.log(`\n${TEXTURES.length} cartes, ${(total / 1024 / 1024).toFixed(1)} Mo dans public/textures/`)
console.log('Solar System Scope — CC BY 4.0 — https://www.solarsystemscope.com/textures/')
