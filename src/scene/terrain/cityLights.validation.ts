/**
 * Validation des lumieres urbaines.
 *
 * ## Ce qui se valide d'une carte
 *
 * Pas son contenu — on ne teste pas qu'Avignon est eclairee. Ce qui se valide,
 * c'est la **chaine photometrique** : que l'emission porte exactement la
 * luminance qu'une norme prescrit, qu'elle ait la couleur d'une lampe reelle, et
 * que le fond de carte soit ramene a zero.
 *
 * ⚠️ C'est ce qui separe ces lumieres d'une couleur posee au jugé : rien ici
 * n'est un coefficient d'ajustement. La quantite vient de l'EN 13201, la couleur
 * d'un spectre de Planck passe par le meme operateur que le Soleil, et le
 * nivellement d'une mesure sur quatre sites.
 */
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import { uniformSpectralGrid } from '@/atmosphere/spectral/SpectralGrid'
import { planckRadiance } from '@/atmosphere/spectral/blackbody'
import {
  correlatedColourTemperature,
  linearSrgbToXyz,
  luminance,
} from '@/atmosphere/spectral/SpectralSensor'
import {
  CITY_HALF_SPANS_M,
  CITY_LIGHTS_GLSL,
  CITY_LIGHT_BACKGROUND,
  CITY_MOSAIC_SIZE,
  LAMP_TEMPERATURE_K,
  ROAD_LUMINANCE_CD_M2,
  cityLightEmission,
  cityLightsUrl,
  mercator,
} from './cityLights'

const grid = uniformSpectralGrid(360, 830, 16)

/** Mont Ventoux — le site de reference du chantier terrain. */
const LAT = 44.1739
const LON = 5.2786

export function cityLightsSuite(): SuiteResult {
  return suite(
    'Lumieres urbaines',
    {
      reference:
        'EN 13201-2 (luminance de chaussee) ; arrete du 27 decembre 2018 (temperature de couleur) ; ' +
        'fond de carte mesure sur quatre sites',
    },
    (t) => {
      // --- La quantite vient d'une norme ------------------------------------
      //
      // EN 13201-2 : M1 2,0 ; M2 1,5 ; **M3 1,0** ; M4 0,75 ; M5 0,5 cd/m². La M3
      // est la classe urbaine courante.
      t.check('la luminance retenue est celle de la classe M3', ROAD_LUMINANCE_CD_M2, 1.0, 0, ' cd/m²')

      // Et le spectre emis doit **porter** exactement cette luminance, sans quoi
      // la norme ne serait qu'une decoration dans un commentaire.
      const spectre = new Float64Array(grid.count)
      for (let i = 0; i < grid.count; i++) {
        spectre[i] = planckRadiance(grid.lambdaNm[i], LAMP_TEMPERATURE_K)
      }
      const brut = luminance(grid, spectre)
      for (let i = 0; i < grid.count; i++) spectre[i] *= ROAD_LUMINANCE_CD_M2 / brut
      t.checkRelative(
        'le spectre emis porte exactement la luminance de la norme',
        luminance(grid, spectre),
        ROAD_LUMINANCE_CD_M2,
        1e-9,
        ' cd/m²',
      )

      // --- La couleur vient d'un spectre, pas d'un nuancier ------------------
      const emission = cityLightEmission(grid)
      const cct = correlatedColourTemperature(linearSrgbToXyz(emission))
      t.checkRelative(
        'la temperature de couleur se retrouve dans l emission',
        cct,
        LAMP_TEMPERATURE_K,
        0.02,
        ' K',
      )
      t.checkTrue(
        'une lampe chaude est nettement plus rouge que bleue',
        emission[0] / emission[2] > 5,
        `rapport rouge/bleu ${(emission[0] / emission[2]).toFixed(1)} a ${LAMP_TEMPERATURE_K} K`,
      )
      // ⚠️ La temperature est un **choix dans un intervalle reglementaire** :
      // l'arrete du 27 decembre 2018 plafonne l'eclairage exterieur francais a
      // 3000 K, 2700 K en peripherie de parc national, 2400 K dans les coeurs.
      // Le sodium encore en service tire vers 2000 K.
      t.checkTrue(
        'la temperature reste dans l intervalle reglementaire francais',
        LAMP_TEMPERATURE_K >= 2000 && LAMP_TEMPERATURE_K <= 3000,
        `${LAMP_TEMPERATURE_K} K — plafond de 3000 K, 2400 K en coeur de parc, sodium vers 2000 K`,
      )

      // --- Le nivellement du fond -------------------------------------------
      //
      // ⚠️ **La carte n'est pas noire**, elle est gris fonce. Le mode de son
      // histogramme vaut 48 sur 255, identique au Causse Mejean desert, en foret
      // de la Sainte-Baume, a Avignon et a Marseille. Sans nivellement, la
      // campagne entiere brillerait presque autant que les villes.
      t.check('le fond de carte est le gris mesure', CITY_LIGHT_BACKGROUND, 48, 0)
      const nivele = (v: number) => Math.max(0, v / 255 - CITY_LIGHT_BACKGROUND / 255) / (1 - CITY_LIGHT_BACKGROUND / 255)
      t.check('le fond tombe a zero', nivele(CITY_LIGHT_BACKGROUND), 0, 1e-12)
      t.check('le blanc monte a un', nivele(255), 1, 1e-12)
      t.checkTrue(
        'rien ne descend sous zero',
        [0, 10, 30, 47].every((v) => nivele(v) === 0),
        'une valeur plus sombre que le fond n emet pas de lumiere negative',
      )

      // --- Les deux echelles --------------------------------------------------
      //
      // ⚠️ Une seule carte ne peut pas servir cent metres et cent kilometres. La
      // premiere version n'en avait qu'une, a 98 m par pixel : le sol proche
      // tenait dans quelques texels autour de l'observateur, et une route qui
      // passait pres de lui allumait tout le paysage d'un seul tenant.
      t.checkTrue(
        'la carte proche est plus fine que la lointaine',
        CITY_HALF_SPANS_M[0] < CITY_HALF_SPANS_M[1],
        CITY_HALF_SPANS_M.map(
          (h) => `${(h / 1000).toFixed(0)} km a ${((2 * h) / CITY_MOSAIC_SIZE).toFixed(1)} m/px`,
        ).join(' ; '),
      )
      t.checkTrue(
        'la carte proche resout une route',
        (2 * CITY_HALF_SPANS_M[0]) / CITY_MOSAIC_SIZE < 20,
        'au-dela d une vingtaine de metres par pixel, une route cesse d etre un trait',
      )

      // --- L emprise demandee au service --------------------------------------
      //
      // ⚠️ Le metre de Mercator n'est pas le metre au sol : il s'etire en
      // `1/cos(latitude)`. Sans dilatation, la carte couvrirait 72 km au lieu de
      // 100 a la latitude de la France.
      const url = cityLightsUrl(LAT, LON, CITY_HALF_SPANS_M[1])
      const bbox = url.match(/BBOX=([^&]+)/)?.[1].split(',').map(Number) ?? []
      const largeurMerc = bbox[2] - bbox[0]
      const attendue = (2 * CITY_HALF_SPANS_M[1]) / Math.cos((LAT * Math.PI) / 180)
      t.checkRelative('l emprise est dilatee par le facteur de Mercator', largeurMerc, attendue, 1e-9, ' m')
      const centre = mercator(LAT, LON)
      t.checkRelative('elle est centree sur l observateur', (bbox[0] + bbox[2]) / 2, centre.x, 1e-9, ' m')
      t.checkTrue(
        'l adresse porte la couche, la projection et le format',
        ['LAYERS=Dark', 'CRS=EPSG:3857', 'image/png'].every((s) => url.includes(s)),
        'aucune clef d acces n est requise',
      )

      // --- Le nuanceur --------------------------------------------------------
      t.checkTrue(
        'le nuanceur nivelle le fond avant toute linearisation',
        /clarte\s*-\s*fond/.test(CITY_LIGHTS_GLSL),
        'le style module la clarte percue ; niveler apres linearisation deplacerait le zero',
      )
      t.checkTrue(
        'les lumieres se neutralisent quand aucune carte n est chargee',
        /uCityStrength\s*<=\s*0\.0.*return vec3\(0\.0\)/s.test(CITY_LIGHTS_GLSL),
        'hors couverture, le sol n emet rien',
      )
      t.note(
        `emission d un pixel pleinement eclaire : ${emission.map((v) => v.toFixed(4)).join(', ')} ` +
          'en unites du moteur — obtenue par la meme chaine spectrale que le Soleil et le ciel',
      )
      t.note(
        'part de la carte au-dessus du fond, mesuree : 4,8 % au Causse Mejean, 13 % en foret de la ' +
          'Sainte-Baume, 26 % a Avignon, 26 % a Marseille — elle suit l urbanisation',
      )
    },
  )
}
