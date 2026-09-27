/**
 * Niveau de chaque plan d'eau, mesure dans le relief lui-meme.
 *
 * L'ocean est a 0 m : le relief (SRTM, Terrarium) est une altitude au-dessus du
 * geoide, et la bathymetrie y est deja ecretee au niveau de la mer. Chaque lac
 * — composante connexe du masque — prend la **mediane** des altitudes de son
 * interieur, frange du rivage exclue : les modeles satellite aplanissent les
 * plans d'eau a leur surface, et la frange est la ou masque et relief se
 * decalent. Le niveau est ensuite propage de quelques cellules sur la terre,
 * pour que le filtrage du rivage ne melange pas un niveau avec zero.
 */
export function waterLevels(size: number, mask: Uint8Array, heights: Int16Array): Float32Array {
  const n = size * size
  const level = new Float32Array(n).fill(Number.NaN)
  const water = (i: number) => mask[2 * i] > 127
  const ocean = (i: number) => mask[2 * i + 1] > 127
  const label = new Int32Array(n).fill(-1)
  const queue = new Int32Array(n)
  const members: number[] = []
  for (let i = 0; i < n; i++) {
    if (ocean(i)) level[i] = 0
  }
  for (let seed = 0; seed < n; seed++) {
    if (!water(seed) || ocean(seed) || label[seed] >= 0) continue
    // Composante 4-connexe du lac.
    let head = 0
    let tail = 0
    queue[tail++] = seed
    label[seed] = seed
    members.length = 0
    while (head < tail) {
      const c = queue[head++]
      members.push(c)
      const x = c % size
      const y = (c - x) / size
      const push = (m: number) => {
        if (label[m] < 0 && water(m) && !ocean(m)) {
          label[m] = seed
          queue[tail++] = m
        }
      }
      if (x > 0) push(c - 1)
      if (x < size - 1) push(c + 1)
      if (y > 0) push(c - size)
      if (y < size - 1) push(c + size)
    }
    // Interieur : cellules dont les quatre voisines sont du meme lac.
    const inner: number[] = []
    for (const c of members) {
      const x = c % size
      const y = (c - x) / size
      if (x > 0 && x < size - 1 && y > 0 && y < size - 1 && label[c - 1] === seed && label[c + 1] === seed && label[c - size] === seed && label[c + size] === seed) inner.push(c)
    }
    const sample = inner.length >= 20 ? inner : members
    const hs = Int16Array.from(sample, (c) => heights[c]).sort()
    const median = hs[Math.floor(hs.length / 2)]
    for (const c of members) level[c] = median
  }
  // Propagation sur la terre voisine, par couches successives.
  let frontier: number[] = []
  for (let i = 0; i < n; i++) if (!Number.isNaN(level[i])) frontier.push(i)
  for (let ring = 0; ring < 6 && frontier.length; ring++) {
    const next: number[] = []
    for (const c of frontier) {
      const x = c % size
      const y = (c - x) / size
      const spread = (m: number) => {
        if (Number.isNaN(level[m])) {
          level[m] = level[c]
          next.push(m)
        }
      }
      if (x > 0) spread(c - 1)
      if (x < size - 1) spread(c + 1)
      if (y > 0) spread(c - size)
      if (y < size - 1) spread(c + size)
    }
    frontier = next
  }
  for (let i = 0; i < n; i++) if (Number.isNaN(level[i])) level[i] = 0
  return level
}

