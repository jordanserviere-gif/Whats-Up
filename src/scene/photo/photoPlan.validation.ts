/**
 * Validation du mode photo.
 *
 * Ce qui se controle sans navigateur ni reseau : que les tranches suivent le
 * pixel sans jamais descendre sous la source ni crever leur plafond, que les
 * grilles se raccordent sans marche, que le maillage couvre le cadre, et que
 * l'ombre par rayon rend les cas dont la reponse est connue — Soleil haut sur
 * une plaine, mur face au Soleil, penombre a mi-disque.
 */
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import {
  BAND_MAX_SAMPLES,
  SOURCE_FLOOR_M,
  SUN_SEMI_DIAMETER_DEG,
  composeSampler,
  photoAzimuthHalfSpanDeg,
  photoBands,
  photoMeshPlan,
  photoPixelAngleRad,
  sectorBox,
  sunVisibility,
  type EnuGrid,
  type PhotoView,
} from './photoPlan'

const VIEW: PhotoView = { azimuthDeg: 90, altitudeDeg: -2, fovDeg: 50, aspect: 1.6, widthPx: 3200, heightPx: 2000 }
const R = 7_500_000

export function photoSuite(): SuiteResult {
  return suite('Mode photo — tranches, maillage, ombres', { reference: 'mesures du service WMS LiDAR HD, 2026-10-03' }, (t) => {
    const pa = photoPixelAngleRad(VIEW)
    const bands = photoBands(VIEW, 450_000)

    t.checkTrue(
      'les tranches couvrent du pied de l observateur a la portee',
      bands[0].nearM === 0 && bands[bands.length - 1].farM >= 450_000 - 1,
      `${bands.length} tranches, ${Math.round(bands[0].farM)} m a ${Math.round(bands[bands.length - 1].farM)} m`,
    )
    t.checkTrue(
      'aucune tranche ne descend sous le pas de la source',
      bands.every((b) => b.stepM >= SOURCE_FLOOR_M),
      bands.map((b) => b.stepM.toFixed(2)).join(' · ') + ' m',
    )
    t.checkTrue(
      'le pas grossit avec la distance',
      bands.every((b, i) => i === 0 || b.stepM >= bands[i - 1].stepM * 0.999),
    )
    t.checkTrue(
      'aucune tranche ne depasse son plafond d echantillons',
      bands.every((b) => {
        const n = ((b.box.eastMax - b.box.eastMin) / b.stepM) * ((b.box.northMax - b.box.northMin) / b.stepM)
        return n <= BAND_MAX_SAMPLES * 1.01
      }),
    )
    t.checkTrue(
      'le pas ne descend jamais sous ce que le pixel resout au bord proche',
      bands.every((b) => b.stepM >= Math.max(SOURCE_FLOOR_M, b.nearM * 1.08 * pa) * 0.999),
      `pixel ${((pa * 180) / Math.PI * 60).toFixed(2)}′`,
    )
    // A quatre cents kilometres, le pas reste a l'echelle du pixel — et non du
    // demi-metre.
    const far = bands[bands.length - 1]
    t.checkTrue('la tranche lointaine reste a l echelle du pixel', far.stepM > 50, `${far.stepM.toFixed(0)} m`)

    // Le secteur : un point du cadre doit tomber dans l'emprise de sa tranche.
    const half = photoAzimuthHalfSpanDeg(VIEW)
    const box = sectorBox(VIEW.azimuthDeg, half, 1000, 2000)
    const inside = [-1, 0, 1].every((s) => {
      const az = ((VIEW.azimuthDeg + s * half * 0.99) * Math.PI) / 180
      const e = 1500 * Math.sin(az)
      const n = 1500 * Math.cos(az)
      return e >= box.eastMin && e <= box.eastMax && n >= box.northMin && n <= box.northMax
    })
    t.checkTrue('le secteur contient les bords du cadre', inside, `demi-ouverture ${half.toFixed(1)}°`)

    // Raccord des grilles : une grille fine sur une plaine a 100 m, au-dessus
    // d'un repli a 0 m. Au coeur on lit la grille, hors d'elle le repli, et la
    // transition est continue.
    const grid: EnuGrid = { eastMin: -500, northMin: -500, stepM: 10, nx: 101, ny: 101, heights: new Float32Array(101 * 101).fill(100) }
    const sample = composeSampler([grid], () => 0)
    t.check('au coeur de la grille, sa valeur', sample(0, 0), 100, 1e-9, ' m')
    t.check('hors de la grille, le repli', sample(900, 0), 0, 1e-9, ' m')
    let maxJump = 0
    let prev = sample(400, 0)
    for (let e = 401; e <= 510; e++) {
      const h = sample(e, 0)
      maxJump = Math.max(maxJump, Math.abs(h - prev))
      prev = h
    }
    t.checkTrue('le fondu ne fait pas de marche', maxJump < 5, `saut maximal ${maxJump.toFixed(2)} m par metre`)

    // Maillage : il couvre le cadre et reste dans son budget.
    const plan = photoMeshPlan(VIEW, 450_000)
    t.checkTrue(
      'le maillage couvre le secteur du cadre',
      plan.azimuthsDeg[0] <= VIEW.azimuthDeg - half + 1e-6 && plan.azimuthsDeg[plan.azimuthsDeg.length - 1] >= VIEW.azimuthDeg + half - 1e-6,
    )
    t.checkTrue(
      'il reste sous dix millions de sommets',
      plan.azimuthsDeg.length * plan.distances.length < 10_000_000,
      `${plan.azimuthsDeg.length} × ${plan.distances.length}`,
    )

    // Ombres : trois cas a reponse connue.
    const flat = () => 0
    t.check('plaine, Soleil a 30° : pleine lumiere', sunVisibility(flat, 0, 0, 0, 30, 180, R, 0, 1), 1, 1e-9)
    // Un mur de mille metres a un kilometre vers le Soleil : il se dresse a 45°.
    const wall = (_e: number, n: number) => (n < -1000 ? 1000 : 0)
    t.check('mur a 45°, Soleil a 30° : ombre', sunVisibility(wall, 0, 0, 0, 30, 180, R, 1000, 1), 0, 1e-9)
    // Le meme mur, Soleil remontant de 43 a 47° : la lumiere doit arriver
    // progressivement — la penombre — et dans une fenetre etroite autour des 45°
    // de la crete. Le pas du rayon peut decaler la crete lue : la fenetre est
    // bornee a un degre et demi.
    const vis: Array<[number, number]> = []
    for (let a = 43; a <= 47.0001; a += 0.05) vis.push([a, sunVisibility(wall, 0, 0, 0, a, 180, R, 1000, 1)])
    const first = vis.find(([, v]) => v > 0)?.[0] ?? 99
    const full = vis.find(([, v]) => v >= 1)?.[0] ?? 99
    const partial = vis.filter(([, v]) => v > 0 && v < 1).length
    t.checkTrue(
      'Soleil franchissant la crete : penombre progressive, pres des 45°',
      partial >= 5 && first > 43.5 && full < 46.5 && full - first <= 2 * SUN_SEMI_DIAMETER_DEG + 0.1,
      `lumiere de ${first.toFixed(2)}° a ${full.toFixed(2)}°, ${partial} pas en penombre`,
    )
  })
}
