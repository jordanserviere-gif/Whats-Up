/**
 * Frontieres des territoires du mode photo, depuis OpenStreetMap.
 *
 * Chaque territoire est une relation OSM, dont polygons.openstreetmap.fr rend
 * le polygone assemble en GeoJSON. Les frontieres terrestres y sont au metre ;
 * en mer, le contour suit la limite des eaux territoriales — une marge toute
 * trouvee.
 *
 * Les anneaux sont simplifies (Douglas-Peucker, 1e-4°, une dizaine de metres),
 * quantifies au cent-millieme de degre et codes en differences, puis ecrits
 * dans `src/scene/photo/borders.json`.
 *
 * Donnees © contributeurs OpenStreetMap, licence ODbL.
 *
 * Usage : node scripts/build-borders.mjs
 */
import { writeFileSync } from 'node:fs'

/** Territoire → relations OSM. L'Andorre va a l'Espagne : le MDT05 la couvre. */
const TERRITORIES = {
  france: [1403916], // France metropolitaine, Corse comprise
  spain: [1311341, 9407], // Espagne, Andorre
  usa: [148838],
}
const TOLERANCE_DEG = 1e-4
const QUANTUM = 1e5

function douglasPeucker(pts, tol) {
  const n = pts.length
  if (n < 3) return pts
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, ay] = pts[a]
    const [bx, by] = pts[b]
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy)
    let best = -1
    let bi = -1
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]
      const d = len > 0 ? Math.abs(dy * (px - ax) - dx * (py - ay)) / len : Math.hypot(px - ax, py - ay)
      if (d > best) {
        best = d
        bi = i
      }
    }
    if (best > tol) {
      keep[bi] = 1
      stack.push([a, bi], [bi, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/** Un anneau ferme se coupe au point le plus eloigne du premier : chaque moitie est une polyligne ouverte. */
function simplifyRing(ring, tol) {
  const r = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring
  if (r.length < 4) return r
  const [x0, y0] = r[0]
  let far = 0
  r.forEach(([x, y], i) => {
    if (Math.hypot(x - x0, y - y0) > Math.hypot(r[far][0] - x0, r[far][1] - y0)) far = i
  })
  const a = douglasPeucker(r.slice(0, far + 1), tol)
  const b = douglasPeucker([...r.slice(far), r[0]], tol)
  return [...a.slice(0, -1), ...b.slice(0, -1)]
}

function encode(ring) {
  const out = []
  let px = 0
  let py = 0
  for (const [lon, lat] of ring) {
    const x = Math.round(lon * QUANTUM)
    const y = Math.round(lat * QUANTUM)
    out.push(x - px, y - py)
    px = x
    py = y
  }
  return out
}

const result = { source: '© contributeurs OpenStreetMap, ODbL', quantum: QUANTUM }
for (const [name, relations] of Object.entries(TERRITORIES)) {
  const rings = []
  for (const id of relations) {
    const res = await fetch(`https://polygons.openstreetmap.fr/get_geojson.py?id=${id}&params=0`)
    if (!res.ok) throw new Error(`relation ${id} : ${res.status}`)
    const json = await res.json()
    const geom = json.geometries ? json.geometries[0] : json
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
    // Exterieurs et trous ensemble : la lecture se fait en pair-impair.
    for (const poly of polys) for (const ring of poly) {
      const s = simplifyRing(ring, TOLERANCE_DEG)
      if (s.length >= 3) rings.push(encode(s))
    }
  }
  result[name] = rings
  console.log(name, rings.length, 'anneaux', rings.reduce((a, r) => a + r.length / 2, 0), 'points')
}
writeFileSync('src/scene/photo/borders.json', JSON.stringify(result))
