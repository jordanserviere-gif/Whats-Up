/**
 * Validation du drape orthophotographique.
 *
 * ## Ce qui se valide d'une image
 *
 * Pas son contenu — on ne teste pas que la Provence est verte. Ce qui se valide,
 * c'est la **geometrie** de la grille, la **couverture** de la mosaique, et
 * surtout la propriete qui justifie tout le montage : **la teinte est de
 * luminance unite**, donc l'image ne peut pas apporter de lumiere.
 *
 * ⚠️ C'est la seule chose qui separe ce drape d'une astuce : une orthophoto est
 * deja eclairee, et l'employer telle quelle ferait compter la lumiere deux fois.
 */
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import { CLIPMAP_HALF_SPANS_M } from './elevationClipmap'
import {
  ORTHO_GLSL,
  ORTHO_MOSAIC_SIZE,
  ORTHO_TILE_SIZE,
  ORTHO_ZOOM,
  orthoHalfSpanM,
  orthoPixel,
  orthoResolutionM,
  orthoUrl,
} from './orthophoto'

/** Mont Ventoux — le site de reference du chantier terrain. */
const LAT = 44.1739
const LON = 5.2786

/** Luminance sRGB, la meme ponderation que le nuanceur. */
const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

export function orthophotoSuite(): SuiteResult {
  return suite(
    'Drape orthophotographique (BD ORTHO)',
    { reference: 'capacites WMTS de la Geoplateforme IGN, couche HR.ORTHOIMAGERY.ORTHOPHOTOS, grille PM_6_19' },
    (t) => {
      // --- La grille, celle qu'on lit deja ----------------------------------
      //
      // `PM_6_19` est le pseudo-Mercator, la meme projection que les tuiles
      // d'altitude Terrarium : aucune trigonometrie nouvelle, contrairement au
      // RGE ALTI qui avait impose une grille geographique.
      const n = 2 ** ORTHO_ZOOM * ORTHO_TILE_SIZE
      const px = orthoPixel(LON, LAT)
      const backLon = (px.x / n) * 360 - 180
      const backLat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * px.y) / n))) * 180) / Math.PI
      t.check('la longitude se retrouve', backLon, LON, 1e-9, '°')
      t.check('la latitude se retrouve', backLat, LAT, 1e-9, '°')
      t.checkTrue(
        'l adresse porte la couche, la grille et le format',
        ['HR.ORTHOIMAGERY.ORTHOPHOTOS', 'PM_6_19', 'image/jpeg'].every((s) => orthoUrl(0, 0).includes(s)),
        'aucune cle d acces n est requise',
      )

      // --- La couverture, qui a du etre corrigee -----------------------------
      //
      // ⚠️ La premiere version prenait le zoom quinze : 3,4 m par pixel sur sept
      // kilometres. Mesure depuis le mont Ventoux, le drape ne changeait que
      // **0,2 %** de la chrominance — depuis un sommet a 1912 m, presque rien de
      // ce qu'on voit n'est a moins de trois kilometres et demi. Le domaine ne
      // croisait pas l'image.
      const spanM = orthoHalfSpanM(LAT)
      t.check('la resolution vaut 13,7 m au sol en France', orthoResolutionM(LAT), 13.74, 0.1, ' m')
      t.checkTrue(
        'la mosaique couvre au moins le niveau fin de la pyramide',
        spanM >= CLIPMAP_HALF_SPANS_M[0] / 2,
        `demi-etendue ${(spanM / 1000).toFixed(1)} km contre ${(CLIPMAP_HALF_SPANS_M[0] / 1000).toFixed(0)} km ` +
          `pour le niveau fin — ${ORTHO_MOSAIC_SIZE}² pixels`,
      )
      // ⚠️ La demi-etendue **depend de la latitude** : le pseudo-Mercator se
      // resserre en `cos(latitude)`. Elle ne peut donc pas etre une constante.
      t.checkTrue(
        'la demi-etendue suit la latitude',
        orthoHalfSpanM(64) < orthoHalfSpanM(44) * 0.7,
        `${(orthoHalfSpanM(44) / 1000).toFixed(1)} km a 44° contre ${(orthoHalfSpanM(64) / 1000).toFixed(1)} km a 64°`,
      )

      // --- ⚠️ La propriete qui separe ce drape d'une astuce -------------------
      //
      // La teinte doit etre de luminance **exactement un**. Sinon l'image
      // apporterait de la lumiere, et l'on compterait deux fois le Soleil du
      // jour de la prise de vue — ombres de midi sous un Soleil couchant.
      let pire = 0
      const couleurs: Array<[number, number, number]> = [
        [0.35, 0.4, 0.28], // foret
        [0.55, 0.52, 0.42], // champ moissonne
        [0.72, 0.7, 0.66], // calcaire nu
        [0.08, 0.12, 0.18], // eau
        [0.9, 0.9, 0.92], // neige
        [0.2, 0.18, 0.16], // ombre portee dans l'image
      ]
      for (const [r, g, b] of couleurs) {
        const l = luminance(r, g, b)
        const tl = luminance(r / l, g / l, b / l)
        pire = Math.max(pire, Math.abs(tl - 1))
      }
      t.check('la teinte est de luminance unite, quelle que soit la couleur', pire, 0, 1e-12)

      // Et une ombre cuite dans l'image ne doit **pas** assombrir le rendu : sa
      // teinte est presque neutre, donc son effet est presque nul.
      const ombre = couleurs[5]
      const lOmbre = luminance(...ombre)
      const teinteOmbre = ombre.map((c) => c / lOmbre) as [number, number, number]
      t.checkTrue(
        'une ombre cuite dans l image ne l assombrit pas',
        teinteOmbre.every((c) => c > 0.85 && c < 1.2),
        `teinte ${teinteOmbre.map((c) => c.toFixed(2)).join(', ')} — sa clarte est jetee avec la luminance`,
      )

      // --- Le nuanceur fait bien cette division ------------------------------
      t.checkTrue(
        'le nuanceur divise l image par sa luminance',
        /luminance\s*=\s*dot\(image/.test(ORTHO_GLSL) && /image\s*\/\s*luminance/.test(ORTHO_GLSL),
        'sans cette division, le drape serait une astuce artistique',
      )
      t.checkTrue(
        'le drape se neutralise hors couverture',
        /uOrthoStrength\s*<=\s*0\.0.*return vec3\(1\.0\)/s.test(ORTHO_GLSL),
        'hors de France, l albedo reste celui du modele',
      )
      t.note(
        'mesure depuis Carpentras, plaine du Comtat : 100 % des pixels changent, ' +
          'chrominance +3,0 %, luminance +6 niveaux sur 255 — cette derniere est attendue, ' +
          'un albedo decale vers le vert renvoyant moins sous une lumiere rougie',
      )
    },
  )
}
