/**
 * Bruits 3D des nuages — la forme de base et son erosion.
 *
 * La recette est celle d'Horizon Zero Dawn (Schneider, SIGGRAPH 2015), reprise
 * depuis par la plupart des moteurs : un bruit de **Perlin-Worley** pour la
 * forme de base, et des **Worley** empiles pour l'eroder.
 *
 * - Le bruit de Worley (distance au point caracteristique le plus proche,
 *   inversee) dessine des **bulles arrondies** jointives : c'est la geometrie
 *   d'un cumulus, faite de thermiques qui bourgeonnent.
 * - Le Perlin seul donne des volutes molles ; « Perlin-Worley » le remappe par
 *   le Worley, ce qui garde sa continuite a grande echelle et lui donne des
 *   bords en bulles.
 *
 * Tout est **periodique** (les textures se repetent sans couture) et
 * **deterministe**. La distribution du bruit de base est mesuree sur la
 * texture elle-meme : le seuil qui couvre une fraction `C` de l'espace en est
 * tire exactement, et la couverture rendue est celle du modele, sans
 * hypothese sur la forme de la distribution.
 */

/** Hachage entier → [0, 1). */
function hash(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144665) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const mod = (a: number, n: number) => ((a % n) + n) % n
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

/** Gradient de Perlin periodique, [−1, 1] environ. */
function perlin(x: number, y: number, z: number, period: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const xf = x - xi
  const yf = y - yi
  const zf = z - zi
  let total = 0
  const u = fade(xf)
  const v = fade(yf)
  const w = fade(zf)
  for (let dz = 0; dz <= 1; dz++)
    for (let dy = 0; dy <= 1; dy++)
      for (let dx = 0; dx <= 1; dx++) {
        const cx = mod(xi + dx, period)
        const cy = mod(yi + dy, period)
        const cz = mod(zi + dz, period)
        // Gradient pseudo-aleatoire unitaire.
        const a = hash(cx, cy, cz, seed) * 2 * Math.PI
        const b = Math.acos(2 * hash(cx, cy, cz, seed + 1) - 1)
        const gx = Math.sin(b) * Math.cos(a)
        const gy = Math.sin(b) * Math.sin(a)
        const gz = Math.cos(b)
        const dot = gx * (xf - dx) + gy * (yf - dy) + gz * (zf - dz)
        const wx = dx ? u : 1 - u
        const wy = dy ? v : 1 - v
        const wz = dz ? w : 1 - w
        total += dot * wx * wy * wz
      }
  return total
}

/**
 * Worley periodique inverse et **lisse** : 1 au point caracteristique, 0 a une
 * maille de lui. La distance est un minimum doux (somme d'exponentielles,
 * Quilez) plutot que le minimum : le Worley ordinaire a des aretes vives aux
 * frontieres de ses cellules de Voronoi, qu'un seuil raide change en facettes
 * planes — des polyedres, pas des bourgeons.
 */
const SMOOTHNESS = 10
function worley(x: number, y: number, z: number, period: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  let sum = 0
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx
        const cy = yi + dy
        const cz = zi + dz
        const px = mod(cx, period)
        const py = mod(cy, period)
        const pz = mod(cz, period)
        const fx = cx + hash(px, py, pz, seed) - x
        const fy = cy + hash(px, py, pz, seed + 7) - y
        const fz = cz + hash(px, py, pz, seed + 13) - z
        sum += Math.exp(-SMOOTHNESS * Math.sqrt(fx * fx + fy * fy + fz * fz))
      }
  const distance = -Math.log(sum) / SMOOTHNESS
  return Math.max(0, 1 - Math.max(0, distance))
}

/**
 * Octaves de Worley, frequences f, 2f, 4f… jusqu'a `maxF` inclus. Le nuage
 * est une isosurface de ce bruit, prise a un seuil raide ; dans chaque texel,
 * l'interpolation trilineaire la dessine en selle, et une cellule de moins de
 * huit texels la change en blocs. D'ou la limite, a huit texels par cellule.
 */
function worleyFbm(x: number, y: number, z: number, f: number, seed: number, maxF: number): number {
  const weights = [0.625, 0.25, 0.125]
  let sum = 0
  let norm = 0
  for (let k = 0; k < 3 && f * 2 ** k <= maxF; k++) {
    const fk = f * 2 ** k
    sum += weights[k] * worley(x * fk, y * fk, z * fk, fk, seed + 101 * k)
    norm += weights[k]
  }
  return sum / norm
}

const remap = (v: number, lo: number, hi: number, a: number, b: number) => a + ((v - lo) / (hi - lo)) * (b - a)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Taille des textures. */
export const BASE_NOISE_SIZE = 64
export const DETAIL_NOISE_SIZE = 32
/** Frequence de base de la forme : mailles de Perlin et de Worley par periode de texture. */
const BASE_FREQUENCY = 4

/**
 * Forme de base en un point de [0, 1)³ : Perlin (fbm 3 octaves) remappe par
 * un Worley de meme frequence, puis erode par le fbm de Worley des octaves
 * superieures — la formule d'Horizon.
 */
/** Frequence la plus haute que la texture de forme resout, mailles par periode. */
const BASE_MAX_FREQUENCY = BASE_NOISE_SIZE / 8
export function baseShape(x: number, y: number, z: number): number {
  const f = BASE_FREQUENCY
  const p = (0.5 * perlin(x * f, y * f, z * f, f, 1) + 0.25 * perlin(x * 2 * f, y * 2 * f, z * 2 * f, 2 * f, 2)) / 0.75
  const perlin01 = clamp01(p * 0.9 + 0.5)
  const w = worleyFbm(x, y, z, f, 11, BASE_MAX_FREQUENCY)
  const perlinWorley = clamp01(remap(perlin01, 0, 1, w, 1))
  const low = worleyFbm(x, y, z, 2 * f, 31, BASE_MAX_FREQUENCY)
  return clamp01(remap(perlinWorley, low - 1, 1, 0, 1))
}

/** Erosion : fbm de Worley, [0, 1], limite aussi a quatre texels par cellule. */
export function detailShape(x: number, y: number, z: number): number {
  return worleyFbm(x, y, z, 2, 51, DETAIL_NOISE_SIZE / 8)
}

/**
 * Etire un champ sur [0, 1] entre ses quantiles 0,5 % et 99,5 % avant de le
 * ranger en octets : la forme de base se tasse entre 0,7 et 0,9, et n'aurait
 * sinon qu'une cinquantaine de niveaux utiles.
 */
function quantize(values: Float32Array): Uint8Array {
  const sorted = Float32Array.from(values).sort()
  const lo = sorted[Math.floor(sorted.length * 0.005)]
  const hi = sorted[Math.floor(sorted.length * 0.995)]
  const out = new Uint8Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = Math.round(255 * clamp01((values[i] - lo) / Math.max(1e-6, hi - lo)))
  return out
}

/** Texture de forme, octets, `size³` (x le plus rapide). */
export function bakeBaseNoise(size = BASE_NOISE_SIZE): Uint8Array {
  const out = new Float32Array(size * size * size)
  let i = 0
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) out[i++] = baseShape((x + 0.5) / size, (y + 0.5) / size, (z + 0.5) / size)
  return quantize(out)
}

export function bakeDetailNoise(size = DETAIL_NOISE_SIZE): Uint8Array {
  const out = new Float32Array(size * size * size)
  let i = 0
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) out[i++] = detailShape((x + 0.5) / size, (y + 0.5) / size, (z + 0.5) / size)
  return quantize(out)
}

/** Nombre d'entrees de la table de couverture, C = 0, 1/N, …, 1. */
export const COVERAGE_TABLE_SIZE = 33

/**
 * Pour chaque couverture C de la table : le seuil θ tel qu'une fraction C
 * des voxels depasse θ, et la moyenne de `(n − θ)/(1 − θ)` sur ces voxels —
 * qui sert a garder l'epaisseur optique moyenne du modele dans le nuage.
 */
export function coverageTable(base: Uint8Array): { threshold: Float32Array; meanDensity: Float32Array } {
  const sorted = Float32Array.from(base, (v) => v / 255).sort()
  const n = sorted.length
  const threshold = new Float32Array(COVERAGE_TABLE_SIZE)
  const meanDensity = new Float32Array(COVERAGE_TABLE_SIZE)
  for (let k = 0; k < COVERAGE_TABLE_SIZE; k++) {
    const c = k / (COVERAGE_TABLE_SIZE - 1)
    const index = Math.min(n - 1, Math.max(0, Math.floor((1 - c) * n)))
    const theta = c >= 1 ? 0 : c <= 0 ? 1 : sorted[index]
    threshold[k] = theta
    let sum = 0
    let count = 0
    for (let i = index; i < n; i++) {
      sum += (sorted[i] - theta) / Math.max(1e-3, 1 - theta)
      count++
    }
    meanDensity[k] = count > 0 ? Math.max(0.05, sum / count) : 1
  }
  return { threshold, meanDensity }
}
