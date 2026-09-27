/**
 * Carte de la Voie lactee.
 *
 * ## La source
 *
 * « Deep Star Maps 2020 » du NASA Goddard Scientific Visualization Studio
 * (svs.gsfc.nasa.gov/4851), couche **Milky Way background** : la carte du ciel
 * entier tiree de Gaia DR2, **sans** les etoiles Hipparcos et Tycho. C'est
 * exactement ce qu'il faut ici — les etoiles brillantes, le moteur les dessine
 * deja une par une depuis son catalogue ; il ne manque que la lueur de celles
 * qu'on ne resout pas. Domaine public (NASA), donnees Gaia ESA/Gaia/DPAC.
 *
 * L'EXR est en demi-flottants **lineaires** : ses valeurs sont proportionnelles
 * au flux. C'est la seule propriete dont on a besoin ; le niveau absolu, lui,
 * n'est pas fourni, et vient de l'ancrage ci-dessous.
 *
 * ## Orientation, mesuree
 *
 * `EXRLoader` rend les lignes de bas en haut (convention des textures) : la
 * premiere est la declinaison −90°. L'ascension droite croit vers la gauche et
 * vaut 0 au centre, comme sur toute carte du ciel vue de l'interieur. Verifie,
 * pas suppose : sous cette convention le plan galactique est vingt et une fois
 * plus brillant que les poles, les Nuages de Magellan et le nuage de l'Ecu
 * ressortent ; sous les trois autres le rapport tombe a 2 ou 8.
 *
 * ## L'ancrage
 *
 * La partie la plus brillante du ciel naturel sans Lune est la Voie lactee, a
 * **19,6 mag/arcsec²** soit 1 500 µcd/m² (NPS Night Skies, *Metrics Guide to
 * Night Skies*). Ce chiffre est celui du ciel **total** dans cette direction ;
 * on en retire le fond naturel — 21,8 mag/arcsec², la reference du moteur —
 * pour ne garder que la Voie lactee, qui ressort a 19,79. Il est affecte a la
 * case d'un degre la plus brillante de la carte.
 *
 * ⚠️ Un seul ancrage, et c'est assume : la carte etant lineaire, il fixe tout
 * le reste. Il est pris la ou la Voie lactee se voit, pas aux poles : la couche
 * omet les etoiles Tycho (jusqu'a la onzieme magnitude environ), qui pesent
 * surtout la ou le ciel est pauvre. Les poles sortent donc un peu trop sombres
 * — ce qui ne change rien a ce qu'on voit, ils sont sous le seuil de toute
 * facon.
 *
 * ## Le stockage : une magnitude, pas une intensite
 *
 * Comme l'atlas du ciel profond : l'octet porte la brillance de surface,
 * `mu = MU_BRIGHT + q·MU_STEP`, sur six magnitudes et demie. Pas de 0,025
 * magnitude, tres au-dessous de tout seuil perceptible.
 *
 * Sortie : public/textures/milky-way.png (2048×1024, equirectangulaire,
 * ascension droite croissante vers la droite a partir de 0, nord en haut) et
 * src/data/milky-way.json (etalonnage et couleur moyenne).
 *
 * Usage : node scripts/build-milky-way.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import { FloatType } from 'three'
import { writeRgbPng } from './fits.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'scripts', '.cache')
const SOURCE = 'https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_4k.exr'

/** Ciel naturel total dans la direction la plus brillante, mag/arcsec² (NPS). */
const BRIGHTEST_NATURAL_SKY = 19.6
/** Fond naturel sans Voie lactee — reference du moteur (`skySurfaceBrightness`). */
const NATURAL_BACKGROUND = 21.8
const ANCHOR_MU =
  -2.5 * Math.log10(Math.pow(10, -0.4 * BRIGHTEST_NATURAL_SKY) - Math.pow(10, -0.4 * NATURAL_BACKGROUND))

const OUT_W = 2048
const OUT_H = 1024
const MU_BRIGHT = 19
const MU_STEP = 0.025
const MU_FAINT = MU_BRIGHT + 255 * MU_STEP

const file = join(CACHE, process.env.MW_SOURCE ?? 'milkyway_2020_4k.exr')
if (!existsSync(file)) {
  mkdirSync(CACHE, { recursive: true })
  console.log('telechargement milkyway_2020_4k.exr…')
  const res = await fetch(SOURCE)
  if (!res.ok) throw new Error(`${SOURCE} -> HTTP ${res.status}`)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}
const buf = readFileSync(file)
const loader = new EXRLoader()
loader.setDataType(FloatType)
const exr = loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
const W = exr.width
const H = exr.height
const C = exr.data.length / (W * H)
const src = exr.data

// Remise dans la convention de sortie : ligne 0 au nord, ascension droite
// croissante vers la droite a partir de 0.
const lum = new Float32Array(W * H)
const rgb = new Float32Array(W * H * 3)
for (let y = 0; y < H; y++) {
  const sy = H - 1 - y
  for (let x = 0; x < W; x++) {
    // RA(x_src) = (W/2 − x_src)/W · 360  ⇒  x_src = W/2 − x (modulo W).
    const sx = (((W / 2 - 1 - x) % W) + W) % W
    const i = (sy * W + sx) * C
    const o = y * W + x
    rgb[o * 3] = src[i]
    rgb[o * 3 + 1] = src[i + 1]
    rgb[o * 3 + 2] = src[i + 2]
    lum[o] = 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2]
  }
}

// --- Etoiles residuelles -----------------------------------------------------
//
// ⚠️ **Seules les etoiles que le catalogue dessine deja doivent partir.** Les
// autres sont la Voie lactee elle-meme : aux poles galactiques, le fond n'est
// fait que d'etoiles Gaia isolees sur du noir. Un premier jet ramenait a la
// mediane locale tout pixel quatre fois au-dessus d'elle — la mediane y etant
// presque nulle, il effacait l'essentiel du flux, et les poles sortaient deux
// magnitudes trop sombres.
//
// Le seuil est donc un flux, pas un rapport : l'exces sur la mediane doit
// valoir au moins celui d'une etoile de magnitude STAR_CUT tombee dans un seul
// pixel. Il se calcule apres l'ancrage, que ce retrait ne touche pas — le
// nuage du Sagittaire est une nappe lisse.
const STAR_CUT = Number(process.env.STAR_CUT ?? 8)
function removeStars(zeroPoint) {
  const cleaned = Float32Array.from(lum)
  const win = new Float32Array(25)
  // Aire d'un pixel a l'equateur, secondes d'arc carrees : le cas le plus
  // defavorable, ou un pixel est le plus grand.
  const pixelArcsec2 = ((360 / W) * 3600) * ((180 / H) * 3600)
  const starFlux = Math.pow(10, -0.4 * (STAR_CUT + 2.5 * Math.log10(pixelArcsec2) - zeroPoint))
  let replaced = 0
  for (let y = 2; y < H - 2; y++) {
    for (let x = 0; x < W; x++) {
      let k = 0
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) win[k++] = lum[(y + dy) * W + ((x + dx + W) % W)]
      win.sort()
      const median = win[12]
      const i = y * W + x
      if (lum[i] - median > starFlux) {
        const f = median / lum[i]
        cleaned[i] = median
        rgb[i * 3] *= f
        rgb[i * 3 + 1] *= f
        rgb[i * 3 + 2] *= f
        replaced++
      }
    }
  }
  return { cleaned, replaced }
}

// --- Reduction a 2048×1024, en moyenne de flux --------------------------------
const fx = W / OUT_W
const fy = H / OUT_H
function downsample(plane, stride = 1, offset = 0) {
  const out = new Float64Array(OUT_W * OUT_H)
  for (let y = 0; y < OUT_H; y++) {
    for (let x = 0; x < OUT_W; x++) {
      let s = 0
      for (let j = 0; j < fy; j++) for (let i = 0; i < fx; i++) s += plane[((y * fy + j) * W + x * fx + i) * stride + offset]
      out[y * OUT_W + x] = s / (fx * fy)
    }
  }
  return out
}

// --- Ancrage : la case d'un degre la plus brillante ---------------------------
const R = Math.round(OUT_W / 360 / 2) // demi-cote d'environ un demi-degre
const boxMean = (map, x0, y0) => {
  let s = 0
  let n = 0
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { s += map[(y0 + dy) * OUT_W + ((x0 + dx + OUT_W) % OUT_W)]; n++ }
  return s / n
}
function anchor(map) {
  let peak = 0
  let at = [0, 0]
  for (let y = R + OUT_H / 8; y < OUT_H - R - OUT_H / 8; y++) {
    for (let x = 0; x < OUT_W; x++) {
      const v = boxMean(map, x, y)
      if (v > peak) { peak = v; at = [x, y] }
    }
  }
  return { zeroPoint: ANCHOR_MU + 2.5 * Math.log10(peak), at }
}

// Premier ancrage sur la carte brute, pour chiffrer le seuil de retrait ; le
// second, definitif, sur la carte nettoyee.
const provisional = anchor(downsample(lum))
const { cleaned, replaced } = removeStars(provisional.zeroPoint)
const flux = downsample(cleaned)
const { zeroPoint, at: peakAt } = anchor(flux)
const muOf = (f) => (f > 0 ? zeroPoint - 2.5 * Math.log10(f) : Infinity)

// --- La couleur ----------------------------------------------------------------
//
// Comme Stellarium : la Voie lactee garde la teinte que ses etoiles lui donnent
// — le bulbe plus chaud, les bras plus bleus. Elle est lissee sur un degre,
// ponderee par le flux : un pixel faible n'a qu'une poignee d'etoiles, et sa
// couleur ne serait que du bruit.
//
// Stockee en rapports logarithmiques au vert, `log2(R/V)` et `log2(B/V)`, sur
// ±CHROMA_RANGE : la luminance reste dans le canal rouge, intacte.
const CHROMA_RANGE = 1.5
const planeR = downsample(rgb, 3, 0)
const planeG = downsample(rgb, 3, 1)
const planeB = downsample(rgb, 3, 2)
const C_R = Math.round(OUT_W / 360)
function smooth(plane) {
  // Deux passes de boite separables, horizontale puis verticale.
  const tmp = new Float64Array(plane.length)
  const out = new Float64Array(plane.length)
  for (let y = 0; y < OUT_H; y++) for (let x = 0; x < OUT_W; x++) {
    let s = 0
    for (let d = -C_R; d <= C_R; d++) s += plane[y * OUT_W + ((x + d + OUT_W) % OUT_W)]
    tmp[y * OUT_W + x] = s
  }
  for (let y = 0; y < OUT_H; y++) for (let x = 0; x < OUT_W; x++) {
    let s = 0
    for (let d = -C_R; d <= C_R; d++) s += tmp[Math.min(OUT_H - 1, Math.max(0, y + d)) * OUT_W + x]
    out[y * OUT_W + x] = s
  }
  return out
}
const sR = smooth(planeR)
const sG = smooth(planeG)
const sB = smooth(planeB)

const pixels = new Uint8Array(OUT_W * OUT_H * 3)
const encodeChroma = (ratio) =>
  Math.round(Math.min(255, Math.max(0, ((Math.log2(Math.max(1e-6, ratio)) / CHROMA_RANGE) * 0.5 + 0.5) * 255)))
for (let i = 0; i < OUT_W * OUT_H; i++) {
  const mu = muOf(flux[i])
  pixels[i * 3] = Math.round(Math.min(255, Math.max(0, (mu - MU_BRIGHT) / MU_STEP)))
  const g = Math.max(1e-12, sG[i])
  pixels[i * 3 + 1] = encodeChroma(sR[i] / g)
  pixels[i * 3 + 2] = encodeChroma(sB[i] / g)
}

// --- Quelques reperes, pour lire le resultat ----------------------------------
const D = Math.PI / 180
const pole = [Math.cos(27.12825 * D) * Math.cos(192.85948 * D), Math.cos(27.12825 * D) * Math.sin(192.85948 * D), Math.sin(27.12825 * D)]
let polar = 0, polarW = 0
for (let y = 0; y < OUT_H; y++) {
  const dec = (90 - ((y + 0.5) / OUT_H) * 180) * D
  for (let x = 0; x < OUT_W; x++) {
    const ra = ((x + 0.5) / OUT_W) * 360 * D
    const sinb = Math.cos(dec) * Math.cos(ra) * pole[0] + Math.cos(dec) * Math.sin(ra) * pole[1] + Math.sin(dec) * pole[2]
    if (Math.abs(sinb) > Math.sin(70 * D)) { polar += flux[y * OUT_W + x] * Math.cos(dec); polarW += Math.cos(dec) }
  }
}
const at = (raDeg, decDeg) =>
  +muOf(boxMean(flux, Math.floor((raDeg / 360) * OUT_W) % OUT_W, Math.floor(((90 - decDeg) / 180) * OUT_H))).toFixed(2)
const landmarks = {
  'nuage de l Ecu': at(280.5, -6),
  'grand nuage du Sagittaire': at(270.5, -29.5),
  'Cygne': at(305, 40),
  'Carene': at(160, -60),
  'Grand Nuage de Magellan': at(80.9, -69.8),
  'anticentre': at(86.4, 28.9),
  'poles galactiques (|b| > 70°)': +muOf(polar / polarW).toFixed(2),
}

mkdirSync(join(ROOT, 'public/textures'), { recursive: true })
const png = writeRgbPng(pixels, OUT_W, OUT_H)
writeFileSync(join(ROOT, 'public/textures/milky-way.png'), png)
writeFileSync(
  join(ROOT, 'src/data/milky-way.json'),
  JSON.stringify(
    {
      source: 'NASA/GSFC Scientific Visualization Studio, Deep Star Maps 2020 (svs.gsfc.nasa.gov/4851) ; Gaia DR2 ESA/Gaia/DPAC',
      width: OUT_W,
      height: OUT_H,
      muBright: MU_BRIGHT,
      muStep: MU_STEP,
      chromaRange: CHROMA_RANGE,
      // Empreinte du PNG, ajoutee a son URL : un navigateur qui garde une
      // version precedente en cache la lirait avec le decodage de la nouvelle.
      // Une carte en niveaux de gris lue comme RVB sortait verte.
      hash: createHash('sha1').update(png).digest('hex').slice(0, 10),
      anchorMu: +ANCHOR_MU.toFixed(3),
      starCut: STAR_CUT,
      landmarks,
    },
    null,
    2,
  ) + '\n',
)
const peakRa = ((peakAt[0] + 0.5) / OUT_W) * 360
const peakDec = 90 - ((peakAt[1] + 0.5) / OUT_H) * 180
console.log(`etoiles plus brillantes que ${STAR_CUT} retirees : ${replaced} pixels`)
console.log(`ancrage ${ANCHOR_MU.toFixed(2)} mag/arcsec² sur la case la plus brillante, RA ${peakRa.toFixed(1)}° Dec ${peakDec.toFixed(1)}°`)
console.log(`plage codee ${MU_BRIGHT}–${MU_FAINT.toFixed(2)}`)
console.log(landmarks)
console.log(`public/textures/milky-way.png : ${(png.length / 1024).toFixed(0)} Ko`)
