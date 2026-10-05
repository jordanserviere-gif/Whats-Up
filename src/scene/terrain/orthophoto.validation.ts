/**
 * Validation du drape d'imagerie.
 *
 * ## Ce qui se valide d'une image
 *
 * Pas son contenu — on ne teste pas que la Provence est verte. Ce qui se valide,
 * c'est la **geometrie** de la grille, la **couverture** de l'atlas, et surtout
 * la propriete qui justifie tout le montage : **le detail retire l'eclairage de
 * la prise de vue**. Sur une image dont l'ombrage varie lentement, il rend le
 * dessin du sol, de moyenne un, sans le degrade.
 *
 * ⚠️ C'est la seule chose qui separe ce drape d'une astuce : une orthophoto est
 * deja eclairee, et l'employer telle quelle ferait compter la lumiere deux fois.
 */
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import { CLIPMAP_HALF_SPANS_M } from './elevationClipmap'
import { ORTHO_GLSL, ORTHO_LEVELS, ORTHO_MOSAIC_SIZE, ORTHO_TILE_SIZE, ORTHO_ZOOM, orthoHalfSpanM, orthoLevelZoom, orthoPixel, orthoResolutionM } from './orthophoto'

/** Mont Ventoux — le site de reference du chantier terrain. */
const LAT = 44.1739
const LON = 5.2786

/** Luminance sRGB, la meme ponderation que le nuanceur. */
const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

export function orthophotoSuite(): SuiteResult {
  return suite(
    'Drape d imagerie (BD ORTHO, PNOA, NAIP, Sentinel-2)',
    { reference: 'grille pseudo-Mercator du web ; separation eclairage / dessin par l echelle' },
    (t) => {
      // --- La grille, celle qu'on lit deja ----------------------------------
      const n = 2 ** ORTHO_ZOOM * ORTHO_TILE_SIZE
      const px = orthoPixel(LON, LAT)
      const backLon = (px.x / n) * 360 - 180
      const backLat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * px.y) / n))) * 180) / Math.PI
      t.check('la longitude se retrouve', backLon, LON, 1e-9, '°')
      t.check('la latitude se retrouve', backLat, LAT, 1e-9, '°')

      // --- L'atlas : quatre etages, du metre a la centaine de kilometres -------
      //
      // ⚠️ La premiere version, une seule mosaique au zoom quinze, ne couvrait
      // que sept kilometres : depuis le mont Ventoux, presque rien de ce qu'on
      // voit n'y tombait. Les etages emboites couvrent le pied du sommet au
      // metre, et l'horizon de la pyramide d'altitudes.
      t.check('l etage fin vaut 3,4 m au sol au Ventoux', orthoResolutionM(LAT), 3.43, 0.05, ' m')
      t.checkTrue('chaque etage est quatre fois plus large', orthoHalfSpanM(LAT, 1) / orthoHalfSpanM(LAT, 0) === 4 && orthoLevelZoom(ORTHO_LEVELS - 1) === ORTHO_ZOOM - 6)
      const widest = orthoHalfSpanM(LAT, ORTHO_LEVELS - 1)
      t.checkTrue(
        'l etage large couvre le niveau moyen de la pyramide',
        widest >= CLIPMAP_HALF_SPANS_M[1],
        `${(widest / 1000).toFixed(0)} km contre ${(CLIPMAP_HALF_SPANS_M[1] / 1000).toFixed(0)} km — ${ORTHO_MOSAIC_SIZE}² pixels par etage`,
      )
      t.checkTrue(
        'la demi-etendue suit la latitude',
        orthoHalfSpanM(64) < orthoHalfSpanM(44) * 0.7,
        `${(orthoHalfSpanM(44) / 1000).toFixed(1)} km a 44° contre ${(orthoHalfSpanM(64) / 1000).toFixed(1)} km a 64°`,
      )

      // --- ⚠️ La propriete qui separe ce drape d'une astuce -------------------
      //
      // Une image synthetique : un dessin fin (des parcelles, periode cinq
      // pixels) sous un ombrage de versant qui double d'un bord a l'autre. Le
      // detail — luminance rapportee a sa version floutee sur seize pixels —
      // doit rendre le dessin et perdre le degrade.
      const N = 512
      const lum = new Float64Array(N)
      for (let i = 0; i < N; i++) lum[i] = (1 + 0.3 * Math.sin((2 * Math.PI * i) / 5)) * (0.4 + (0.4 * i) / N)
      const blur = new Float64Array(N)
      for (let i = 0; i < N; i++) {
        let sum = 0
        let count = 0
        for (let k = i - 8; k < i + 8; k++) if (k >= 0 && k < N) (sum += lum[k]), count++
        blur[i] = sum / count
      }
      const detail = Array.from(lum, (l, i) => l / blur[i])
      const third = (a: number, b: number) => detail.slice(a, b).reduce((x, y) => x + y, 0) / (b - a)
      const thirds = [third(20, 170), third(170, 340), third(340, 490)]
      t.checkTrue(
        'le detail perd l ombrage du versant : meme moyenne d un bord a l autre',
        Math.max(...thirds) - Math.min(...thirds) < 0.01 && Math.abs(thirds[1] - 1) < 0.01,
        `moyennes ${thirds.map((x) => x.toFixed(3)).join(' / ')} — l image, elle, doublait`,
      )
      const swing = Math.max(...detail.slice(20, 490)) - Math.min(...detail.slice(20, 490))
      t.checkTrue('et garde le dessin fin', swing > 0.4, `amplitude ${swing.toFixed(2)} pour 0,6 dessinee`)

      // La teinte reste de luminance unite : la couleur ne porte pas de lumiere.
      let worst = 0
      for (const [r, g, b] of [
        [0.35, 0.4, 0.28],
        [0.72, 0.7, 0.66],
        [0.08, 0.12, 0.18],
        [0.2, 0.18, 0.16],
      ]) {
        const l = luminance(r, g, b)
        worst = Math.max(worst, Math.abs(luminance(r / l, g / l, b / l) - 1))
      }
      t.check('la teinte est de luminance unite, quelle que soit la couleur', worst, 0, 1e-12)

      // --- Le nuanceur fait bien ces divisions --------------------------------
      t.checkTrue(
        'le nuanceur divise par la luminance, et la luminance par sa version floutee',
        /image\s*\/\s*luminance/.test(ORTHO_GLSL) && /luminance\s*\/\s*broadLuminance/.test(ORTHO_GLSL),
        'sans ces divisions, le drape serait une astuce artistique',
      )
      t.checkTrue(
        'le drape se neutralise avant l arrivee de l imagerie',
        /uOrthoStrength\s*<=\s*0\.0.*return vec3\(1\.0\)/s.test(ORTHO_GLSL),
      )
    },
  )
}
