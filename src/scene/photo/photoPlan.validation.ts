/**
 * Validation du mode photo.
 *
 * Ce qui se controle sans navigateur ni reseau : le rendu au pixel sur des
 * reliefs dont la reponse est connue — une plaine, un mur —, l'anticrenelage de
 * la crete, l'innocuite des majorants (ils ne doivent qu'accelerer), les
 * tuiles, la projection locale, et l'ombre par rayon avec sa penombre.
 */
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import { enuToGeodetic } from '../terrain/geodesy'
import { apparentElevationRad } from '../terrain/ridgeField'
import { SUN_SEMI_DIAMETER_DEG, sunVisibility, type PhotoView } from './photoPlan'
import { buildMaxGrid, marchColumns, photoFrame, toHalf, type PhotoFrame } from './photoRaster'
import { LocalProjector, quantizeTile, TileStore, TILE_POINTS, tileCellM, tileKey, tileLevelFor, tileSpanDeg } from './photoTiles'

const R = 7_500_000
const EYE = 100

const VIEW: PhotoView = { azimuthDeg: 0, altitudeDeg: -1, fovDeg: 10, aspect: 1.5, widthPx: 600, heightPx: 400 }

function march(sample: (e: number, n: number) => number, frame: PhotoFrame, margin = 50) {
  return marchColumns(sample, frame, {
    observerM: EYE,
    effectiveRadiusM: R,
    reachM: 60_000,
    fineStepAt: (d) => d * frame.step * 2.5,
    maxGrid: buildMaxGrid(sample, 60_000, () => margin),
  })
}

export function photoSuite(): SuiteResult {
  return suite('Mode photo — rendu au pixel, tuiles, ombres', { reference: 'reliefs synthetiques a reponse exacte' }, (t) => {
    const frame = photoFrame(VIEW)
    t.checkTrue(
      'la grille angulaire couvre le cadre',
      frame.cols * frame.step >= (2 * Math.atan(Math.tan(5 * (Math.PI / 180)) * 1.5)) && frame.rows * frame.step >= 10 * (Math.PI / 180),
      `${frame.cols} × ${frame.rows}`,
    )

    // --- Une plaine a zero, vue de cent metres : chaque ligne sous l'horizon
    // voit le sol a la distance ou sa hauteur apparente est atteinte.
    const flat = march(() => 0, frame)
    let worst = 0
    let checked = 0
    const c = Math.floor(frame.cols / 2)
    for (let r = 0; r < frame.rows; r++) {
      const d = flat.range[r * frame.cols + c]
      if (!(d > 50 && d < 50_000)) continue
      const el = frame.elMin + (r + 0.5) * frame.step
      const back = apparentElevationRad(d, 0, EYE, R)
      worst = Math.max(worst, Math.abs(back - el) / frame.step)
      checked++
    }
    t.checkTrue('plaine : chaque ligne retombe sur sa hauteur apparente', checked > 20 && worst < 0.6, `${checked} lignes, ecart max ${worst.toFixed(2)} ligne`)

    // --- Un mur de six cents metres a dix kilometres au nord : sa crete tombe
    // a 2,9°, dans le cadre.
    const wall = (_e: number, n: number) => (n > 10_000 ? 600 : 0)
    const gw = march(wall, frame, 700)
    const top = apparentElevationRad(10_000, 600, EYE, R)
    const rowTop = Math.floor((top - frame.elMin) / frame.step - 0.5)
    const below = gw.range[(rowTop - 2) * frame.cols + c]
    const above = gw.range[(rowTop + 3) * frame.cols + c]
    t.checkTrue('mur : sous la crete, le mur a dix kilometres', Math.abs((below ?? 0) - 10_000) < 200, `${(below ?? 0).toFixed(0)} m`)
    t.checkTrue('mur : au-dessus, le ciel', above === 0)
    let partial = 0
    for (let r = rowTop - 1; r <= rowTop + 2; r++) {
      const cov = gw.coverage[r * frame.cols + c]
      if (cov > 0 && cov < 1) partial++
    }
    t.checkTrue('la crete recoit une couverture partielle — l anticrenelage', partial === 1, `${partial} ligne(s) partielle(s)`)

    // --- Les majorants n'accelerent que : avec ou sans eux, meme image.
    const bumpy = (e: number, n: number) => 300 * Math.sin(e / 900) * Math.cos(n / 1300) + 200 + (n > 30_000 ? 800 : 0)
    const tight = march(bumpy, frame, 320)
    const loose = march(bumpy, frame, 1e6)
    let diff = 0
    for (let i = 0; i < tight.range.length; i++) if (Math.abs(tight.range[i] - loose.range[i]) > 1e-3 * Math.max(1, loose.range[i])) diff++
    t.check('les majorants ne changent aucun pixel', diff, 0, 0, ' pixels')

    // --- Tuiles.
    const heights = new Float32Array(TILE_POINTS * TILE_POINTS)
    for (let j = 0; j < TILE_POINTS; j++) for (let i = 0; i < TILE_POINTS; i++) heights[j * TILE_POINTS + i] = 1000 + i * 0.5 - j * 0.25
    const z = 12
    const x = 4200
    const y = 1100
    const tile = quantizeTile(z, x, y, heights)!
    const store = new TileStore()
    store.add(tile)
    const span = tileSpanDeg(z)
    const lon = x * span - 180 + span * (37.3 / 256)
    const lat = 90 - y * span - span * (91.6 / 256)
    const expected = 1000 + 37.3 * 0.5 - 91.6 * 0.25
    t.check('une tuile se relit au centieme de metre pres', store.sample(lat, lon), expected, 0.01, ' m')
    t.checkTrue('hors tuile, rien', Number.isNaN(store.sample(lat + 1, lon)))
    t.checkTrue('les niveaux se suivent', tileCellM(17) < 0.7 && tileCellM(17) > 0.5 && tileLevelFor(30, 17) === 12, `${tileCellM(17).toFixed(2)} m au niveau 17, niveau 12 pour 30 m`)
    t.checkTrue('les cles sont uniques', new Set([tileKey(17, 1, 2), tileKey(17, 2, 1), tileKey(16, 1, 2)]).size === 3)

    // --- Projection locale contre le probleme direct exact.
    const proj = new LocalProjector(44.17, 5.28, 560_000)
    const ll = { lat: 0, lon: 0 }
    let projErr = 0
    for (const [e, n] of [[0, 0], [1234, -567], [-210_000, 330_000], [500_000, 120_000]]) {
      proj.toLatLon(e, n, ll)
      const g = enuToGeodetic(44.17, 5.28, e, n)
      projErr = Math.max(projErr, Math.hypot((ll.lat - g.latitudeDeg) * 111_320, (ll.lon - g.longitudeDeg) * 111_320 * Math.cos(44.17 * (Math.PI / 180))))
    }
    t.checkTrue('la projection interpolee reste sous le metre jusqu a 520 km', projErr < 1, `${projErr.toFixed(3)} m`)

    // --- Demi-flottants.
    t.checkTrue('demi-flottants exacts sur les valeurs simples', toHalf(1) === 0x3c00 && toHalf(0.5) === 0x3800 && toHalf(-2) === 0xc000 && toHalf(0) === 0)

    // --- Ombres : trois cas a reponse connue.
    const plain = () => 0
    t.check('plaine, Soleil a 30° : pleine lumiere', sunVisibility(plain, 0, 0, 0, 30, 180, R, 0, 1), 1, 1e-9)
    const south = (_e: number, n: number) => (n < -1000 ? 1000 : 0)
    t.check('mur a 45°, Soleil a 30° : ombre', sunVisibility(south, 0, 0, 0, 30, 180, R, 1000, 1), 0, 1e-9)
    const vis: Array<[number, number]> = []
    for (let a = 43; a <= 47.0001; a += 0.05) vis.push([a, sunVisibility(south, 0, 0, 0, a, 180, R, 1000, 1)])
    const firstLit = vis.find(([, v]) => v > 0)?.[0] ?? 99
    const full = vis.find(([, v]) => v >= 1)?.[0] ?? 99
    const penumbra = vis.filter(([, v]) => v > 0 && v < 1).length
    t.checkTrue(
      'Soleil franchissant la crete : penombre progressive, pres des 45°',
      penumbra >= 5 && firstLit > 43.5 && full < 46.5 && full - firstLit <= 2 * SUN_SEMI_DIAMETER_DEG + 0.1,
      `lumiere de ${firstLit.toFixed(2)}° a ${full.toFixed(2)}°, ${penumbra} pas en penombre`,
    )
  })
}
