/**
 * Validation du champ proche — la source IGN et sa grille.
 *
 * Rien ici ne touche le reseau. Ce qui se valide, c'est la **geometrie** de la
 * grille geographique de l'IGN, le decodage de son format, et la composition
 * avec la pyramide mondiale. Le telechargement, lui, n'a rien a valider : il
 * rend des octets ou il n'en rend pas.
 *
 * La mesure qui a motive tout ceci, relevee sur la tuile du Ventoux, est
 * consignee dans l'en-tete de `rgeAlti.ts` : le denivele type entre points
 * voisins vaut 7,81 m a l'ecart de 27 m que donne la source mondiale, et
 * **1,01 m a 3,4 m**. Le relief a donc de la structure jusqu'en bas.
 */
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import {
  RGE_ALTI_TILE_SIZE,
  decodeBilTile,
  rgeAltiResolutionM,
  rgeAltiStepDeg,
  rgeAltiTile,
  rgeAltiUrl,
} from './rgeAlti'
import {
  NEAR_FIELD_HALF_SPAN_M,
  NEAR_FIELD_SIZE,
  NEAR_FIELD_STEP_M,
  NEAR_FIELD_UNIT_M,
  nearFieldWeight,
} from './nearField'

/** Mont Ventoux — le site de reference de tout le chantier terrain. */
const LAT = 44.1739
const LON = 5.2786

export function nearFieldSuite(): SuiteResult {
  return suite(
    'Champ proche (RGE ALTI)',
    { reference: 'capacites WMTS de la Geoplateforme IGN, grille WGS84G_6_14, niveau 14' },
    (t) => {
      // --- La grille geographique -------------------------------------------
      //
      // Elle n'est pas celle de Terrarium : degres, pas Mercator. Un point tous
      // les 4,3·10⁻⁵ degres, ce qui donne une maille **non carree** et qui
      // s'etire vers le nord.
      const res = rgeAltiResolutionM(LAT)
      t.check('resolution en longitude au Ventoux', res.eastM, 3.43, 0.05, ' m')
      t.check('resolution en latitude au Ventoux', res.northM, 4.78, 0.05, ' m')
      t.checkTrue(
        'la maille se resserre en longitude vers le nord',
        rgeAltiResolutionM(60).eastM < rgeAltiResolutionM(20).eastM,
        `${rgeAltiResolutionM(60).eastM.toFixed(2)} m a 60° contre ` +
          `${rgeAltiResolutionM(20).eastM.toFixed(2)} m a 20°`,
      )

      // Un aller-retour : le point retrouve doit etre celui de depart, a la
      // fraction de cellule pres. C'est ce qui attrape une erreur de signe sur
      // la latitude, qui **descend** quand la ligne monte.
      const tile = rgeAltiTile(LON, LAT)
      const step = rgeAltiStepDeg()
      const back = {
        lon: (tile.col * RGE_ALTI_TILE_SIZE + tile.x) * step - 180,
        lat: 90 - (tile.row * RGE_ALTI_TILE_SIZE + tile.y) * step,
      }
      t.check('la longitude se retrouve', back.lon, LON, 1e-9, '°')
      t.check('la latitude se retrouve', back.lat, LAT, 1e-9, '°')
      t.checkTrue(
        'la position dans la tuile reste dans ses bornes',
        tile.x >= 0 && tile.x < RGE_ALTI_TILE_SIZE && tile.y >= 0 && tile.y < RGE_ALTI_TILE_SIZE,
        `tuile ${tile.col}/${tile.row}, position ${tile.x.toFixed(1)}, ${tile.y.toFixed(1)}`,
      )
      t.checkTrue(
        'l adresse porte la couche, la grille et le format',
        ['ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES', 'WGS84G_6_14', 'image/x-bil;bits=32'].every(
          (term) => rgeAltiUrl(tile.col, tile.row).includes(term),
        ),
        'aucune cle d acces n est requise',
      )

      // --- Le decodage --------------------------------------------------------
      //
      // ⚠️ Hors couverture, le service repond 404 avec un `ExceptionReport` de
      // cent trente-sept octets. C'est **le fonctionnement normal** partout hors
      // de France, et la taille suffit a le reconnaitre sans analyser du XML.
      const good = new ArrayBuffer(RGE_ALTI_TILE_SIZE * RGE_ALTI_TILE_SIZE * 4)
      new DataView(good).setFloat32(0, 1909.4, true)
      const decoded = decodeBilTile(good)
      t.checkTrue(
        'une tuile complete se decode',
        decoded !== null && decoded.length === RGE_ALTI_TILE_SIZE * RGE_ALTI_TILE_SIZE,
        `${decoded?.length ?? 0} valeurs, la premiere a ${decoded?.[0].toFixed(1) ?? '?'} m`,
      )
      t.checkTrue(
        'une reponse hors couverture est refusee',
        decodeBilTile(new ArrayBuffer(137)) === null,
        'les 137 octets de l ExceptionReport ne passent pas pour du relief',
      )

      // --- La grille locale ---------------------------------------------------
      //
      // Sa maille doit valoir celle de la source : plus large, on diluerait la
      // donnee ; plus fine, on interpolerait des tuiles deja telechargees.
      t.checkRelative('le pas de la grille suit celui de la source', NEAR_FIELD_STEP_M, res.eastM, 0.01)
      t.note(
        `${NEAR_FIELD_SIZE}² cellules sur ±${(NEAR_FIELD_HALF_SPAN_M / 1000).toFixed(1)} km — ` +
          `${NEAR_FIELD_STEP_M.toFixed(2)} m par cellule, huit megaoctets`,
      )

      // ⚠️ Le quart de metre, et non le metre. Le denivele type a 3,4 m vaut
      // 1,01 m : arrondir au metre detruirait la moitie de ce qu'on vient
      // chercher. Seize bits au quart de metre portent ±8191 m.
      t.checkTrue(
        'l unite de stockage est plus fine que le denivele type',
        NEAR_FIELD_UNIT_M <= 1.01 / 4,
        `${NEAR_FIELD_UNIT_M} m par unite, portee ±${(32767 * NEAR_FIELD_UNIT_M).toFixed(0)} m`,
      )

      // --- La composition avec la pyramide -----------------------------------
      //
      // Les deux sources ne donnent pas la meme altitude au meme point. Un
      // basculement franc dessinerait un anneau ; le poids doit donc partir de
      // un au coeur et atteindre zero au bord, sans marche.
      t.check('poids plein au centre', nearFieldWeight(0, 0), 1, 0)
      t.check('poids nul au bord', nearFieldWeight(NEAR_FIELD_HALF_SPAN_M, 0), 0, 0)
      t.check('poids nul au-dela', nearFieldWeight(2 * NEAR_FIELD_HALF_SPAN_M, 0), 0, 0)
      const ramp: number[] = []
      for (let i = 0; i <= 20; i++) ramp.push(nearFieldWeight((NEAR_FIELD_HALF_SPAN_M * i) / 20, 0))
      t.checkTrue(
        'le poids ne remonte jamais',
        ramp.every((v, i) => i === 0 || v <= ramp[i - 1] + 1e-12),
        `de ${ramp[0].toFixed(2)} a ${ramp[ramp.length - 1].toFixed(2)}`,
      )
      // Le domaine est un **carre** : la diagonale sort donc plus loin que la
      // cardinale, exactement comme pour la pyramide.
      t.checkTrue(
        'le poids se compte en distance de Tchebychev',
        nearFieldWeight(NEAR_FIELD_HALF_SPAN_M * 0.9, NEAR_FIELD_HALF_SPAN_M * 0.9) ===
          nearFieldWeight(NEAR_FIELD_HALF_SPAN_M * 0.9, 0),
        'le domaine stocke est un carre, et le fondu suit sa forme',
      )
    },
  )
}
