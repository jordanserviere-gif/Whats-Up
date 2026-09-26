/**
 * Confronte chaque scenario meteo a l'image satellite du meme jour.
 *
 * La question : la couverture nuageuse qu'ICON a archivee — celle que les
 * nuages rendent — est-elle celle que le satellite a vue ? Pour chaque maille
 * de la grille lointaine, on mesure la fraction de pixels nuageux de l'image
 * VIIRS sur ±6 km autour du point — le support d'une valeur ICON — et on la compare a la couverture totale d'ICON a l'heure du
 * passage (NOAA-20 : 13 h 30 heure solaire locale).
 *
 * Le masque est volontairement simple — un pixel est nuage s'il est clair et
 * peu sature — et il a deux faiblesses connues : la **neige** passe pour du
 * nuage (Alpes, Pyrenees en hiver), et un **cirrus mince** sur fond sombre lui
 * echappe. On les signale plutot que de les corriger.
 *
 * Le decodage JPEG se fait dans Chromium (Playwright), faute de bibliotheque
 * d'image dans le depot.
 *
 * Usage : node scripts/compare-scenario-satellite.mjs [id…]
 * Sortie : tableau par scenario, et `shots/compare-<id>.png` (image, masque,
 * ICON cote a cote).
 */
import { chromium } from 'playwright'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const DIR = 'public/scenarios'
const index = JSON.parse(await readFile(join(DIR, 'index.json'), 'utf8'))
const wanted = process.argv.slice(2)
const entries = index.filter((e) => wanted.length === 0 || wanted.includes(e.id))
await mkdir('shots', { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 560 } })

for (const entry of entries) {
  const s = JSON.parse(await readFile(join(DIR, `${entry.id}.json`), 'utf8'))
  if (!s.reference) {
    console.log(`${entry.id} : pas d'image de reference`)
    continue
  }
  const g = s.grids.far
  const overpassUtc = 13.5 - entry.longitude / 15
  const h0 = Math.floor(overpassUtc)
  const f = overpassUtc - h0
  const icon = g.fields.cct.map((series) => (series[h0] * (1 - f) + series[h0 + 1] * f) / 100)
  const jpg = (await readFile(join(DIR, s.reference.file))).toString('base64')
  const [south, west, north, east] = s.reference.bbox.split(',').map(Number)

  const result = await page.evaluate(
    async ({ jpg, points, n, spacingKm, bbox, icon, SUPPORT_HALF_KM }) => {
      const img = new Image()
      img.src = `data:image/jpeg;base64,${jpg}`
      await img.decode()
      const W = img.naturalWidth
      const H = img.naturalHeight
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const px = ctx.getImageData(0, 0, W, H).data
      const cloudy = (i) => {
        const r = px[i], gg = px[i + 1], b = px[i + 2]
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b)
        return mn > 140 && mx - mn < 45
      }
      const [south, west, north, east] = bbox
      const sat = []
      for (let k = 0; k < n * n; k++) {
        const [lat, lon] = points[k]
        // Support d'ICON au point : une maille de ~7 km, pas la maille de 100 km de la grille.
        const dLat = SUPPORT_HALF_KM / 111.195
        const dLon = dLat / Math.cos((lat * Math.PI) / 180)
        const x0 = Math.floor(((lon - dLon - west) / (east - west)) * W)
        const x1 = Math.ceil(((lon + dLon - west) / (east - west)) * W)
        const y0 = Math.floor(((north - (lat + dLat)) / (north - south)) * H)
        const y1 = Math.ceil(((north - (lat - dLat)) / (north - south)) * H)
        let hit = 0, tot = 0
        for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
          for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
            const i = (y * W + x) * 4
            // Pixel noir : hors fauchee du satellite.
            if (px[i] + px[i + 1] + px[i + 2] < 6) continue
            tot++
            if (cloudy(i)) hit++
          }
        sat.push(tot > 20 ? hit / tot : null)
      }
      // Planche : image, masque, grille ICON, grille satellite.
      const board = document.createElement('canvas')
      board.width = 1600
      board.height = 560
      const b = board.getContext('2d')
      b.fillStyle = '#111'
      b.fillRect(0, 0, 1600, 560)
      b.drawImage(img, 10, 40, 380, 380)
      const mask = ctx.createImageData(W, H)
      for (let i = 0; i < px.length; i += 4) {
        const v = cloudy(i) ? 255 : 30
        mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = v
        mask.data[i + 3] = 255
      }
      ctx.putImageData(mask, 0, 0)
      b.drawImage(c, 400, 40, 380, 380)
      const cell = 380 / n
      const drawGrid = (vals, x) => {
        for (let k = 0; k < n * n; k++) {
          const v = vals[k]
          const i = k % n, j = Math.floor(k / n)
          b.fillStyle = v == null ? '#400' : `rgb(${Math.round(v * 255)},${Math.round(v * 255)},${Math.round(v * 255)})`
          b.fillRect(x + i * cell, 40 + j * cell, cell - 1, cell - 1)
        }
      }
      drawGrid(icon, 800)
      drawGrid(sat, 1200)
      b.fillStyle = '#ddd'
      b.font = '16px sans-serif'
      b.fillText('VIIRS', 10, 28)
      b.fillText('masque nuage', 400, 28)
      b.fillText('ICON, couverture totale', 800, 28)
      b.fillText('VIIRS, fraction par maille', 1200, 28)
      return { sat, board: board.toDataURL('image/png').split(',')[1] }
    },
    { jpg, points: g.points, n: g.n, spacingKm: g.spacingKm, bbox: [south, west, north, east], icon, SUPPORT_HALF_KM: 6 },
  )

  const pairs = icon.map((v, k) => [v, result.sat[k]]).filter(([, b]) => b != null)
  const mae = pairs.reduce((a, [x, y]) => a + Math.abs(x - y), 0) / pairs.length
  const mx = pairs.reduce((a, [x]) => a + x, 0) / pairs.length
  const my = pairs.reduce((a, [, y]) => a + y, 0) / pairs.length
  let sxy = 0, sxx = 0, syy = 0
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my)
    sxx += (x - mx) ** 2
    syy += (y - my) ** 2
  }
  const r = sxy / Math.sqrt(sxx * syy || 1)
  // Accord binaire : maille « plutot couverte » (> 50 %) des deux cotes.
  const agree = pairs.filter(([x, y]) => (x > 0.5) === (y > 0.5)).length / pairs.length
  console.log(
    `${entry.id.padEnd(18)} ${pairs.length} mailles  ICON ${(mx * 100).toFixed(0)} %  VIIRS ${(my * 100).toFixed(0)} %  ` +
      `ecart moyen ${(mae * 100).toFixed(0)} pts  correlation ${r.toFixed(2)}  accord couvert/degage ${(agree * 100).toFixed(0)} %`,
  )
  await (await import('node:fs/promises')).writeFile(`shots/compare-${entry.id}.png`, Buffer.from(result.board, 'base64'))
}
await browser.close()
