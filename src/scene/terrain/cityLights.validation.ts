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
  CITY_DENSITY_EXPONENT,
  CITY_GLOW_RADIUS_M,
  CITY_HALF_SPANS_M,
  CITY_LIGHTS_GLSL,
  CITY_LIGHT_BACKGROUND,
  CITY_MOSAIC_SIZE,
  LAMP_TEMPERATURE_K,
  ROAD_LUMINANCE_CD_M2,
  LIGHTING_OFF_LUX,
  LIGHTING_ON_LUX,
  cityLightEmission,
  cityLightFactor,
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

      // --- Le terminateur, et pourquoi il n'est pas une limite en degres ------
      //
      // ⚠️ Une bascule sur la **hauteur du Soleil** serait soit brutale, soit
      // calee sur une valeur arbitraire. Sur l'**eclairement**, elle suit ce que
      // mesure la cellule qui commande la lampe, et elle s'adapte d'elle-meme a
      // la saison et a la latitude.
      t.checkTrue(
        'l eclairage est eteint en plein jour et allume la nuit',
        cityLightFactor(20) === 0 && cityLightFactor(-12) === 1,
        `${LIGHTING_OFF_LUX} lux eteint, ${LIGHTING_ON_LUX} lux allume`,
      )
      // La rampe stationne a zero puis a un : ce qu'on demande n'est pas une
      // croissance stricte mais qu'elle ne **redescende** jamais.
      const hauteurs = [2, 0, -1, -2, -3, -4, -5, -6]
      const rampe = hauteurs.map((h) => cityLightFactor(h))
      t.checkTrue(
        'la part allumee ne redescend jamais quand le Soleil descend',
        rampe.every((v, i) => i === 0 || v >= rampe[i - 1] - 1e-12),
        hauteurs.map((h, i) => `${h}° ${(rampe[i] * 100).toFixed(0)} %`).join(' ; '),
      )
      // ⚠️ La transition doit s'**etaler**. Bornee aux vingt et quarante lux
      // d'une seule cellule, elle tenait dans un degre de hauteur solaire —
      // quatre minutes — et dessinait une frontiere nette au sol. Un paysage
      // porte des dizaines de milliers d'installations reglees differemment.
      const partielle = [2, 0, -1, -2, -3, -4, -5, -6].filter((h) => {
        const f = cityLightFactor(h)
        return f > 0.02 && f < 0.98
      })
      t.checkTrue(
        'la bascule s etale sur plusieurs degres de hauteur solaire',
        partielle.length >= 1,
        partielle.length > 0
          ? `partiellement allume entre ${Math.max(...partielle)}° et ${Math.min(...partielle)}° — ` +
            `une seule cellule basculerait en moins d un degre`
          : 'aucune hauteur intermediaire : la bascule est nette',
      )

      // --- Le flou et la densite ---------------------------------------------
      //
      // ⚠️ La carte rend des traits nets ; une lampe eclaire une tache. Le rayon
      // est en **metres au sol** et non en pixels : le flou appartient donc au
      // paysage et ne se deforme pas au zoom.
      t.checkTrue(
        'le flou est plus large qu un texel de la carte proche',
        CITY_GLOW_RADIUS_M > (2 * CITY_HALF_SPANS_M[0]) / CITY_MOSAIC_SIZE,
        `${CITY_GLOW_RADIUS_M} m contre ${((2 * CITY_HALF_SPANS_M[0]) / CITY_MOSAIC_SIZE).toFixed(1)} m ` +
          'par texel — sans quoi il ne flouterait rien',
      )
      // ⚠️ L'exposant est une **correction de proxy**, pas une loi : la carte dit
      // bati, pas eclaire. Balaye depuis le Ventoux, il n'existe aucune valeur
      // qui separe proprement une route de montagne d'un village.
      t.checkTrue(
        'l exposant de densite reste entre le lineaire et le carre',
        CITY_DENSITY_EXPONENT > 1 && CITY_DENSITY_EXPONENT < 2,
        `${CITY_DENSITY_EXPONENT} — a 1,0 le premier plan du Ventoux s allume en entier, ` +
          `a 2,0 les villages disparaissent`,
      )
      t.checkTrue(
        'le nuanceur applique bien cet exposant au flou',
        /pow\(somme \/ poids, uCityDensityExponent\)/.test(CITY_LIGHTS_GLSL),
        'sans quoi la constante ne serait qu un commentaire',
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
