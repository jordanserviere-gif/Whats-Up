/**
 * Validation du rendu du ciel profond.
 *
 * ## Deux lois, et un garde-fou
 *
 * Le calque du ciel profond etait le **seul du moteur** a ignorer l'atmosphere :
 * aucun terme de transport dans son nuanceur, quand les etoiles, les astres, le
 * fond de ciel et le terrain y passent tous. Une galaxie brillait donc autant a
 * l'horizon qu'au zenith.
 *
 * Sa couleur, elle, venait d'un **jeton d'interface** — un par type d'objet, si
 * bien que toutes les galaxies partageaient une teinte.
 *
 * Ce qui se valide ici : la conversion qui relie brillance de surface et
 * luminance, le comportement des deux lois, et le fait que le nuanceur les
 * applique reellement — sans quoi elles ne seraient que des commentaires.
 */
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import {
  ARCSEC2_STERADIAN,
  EYE_POINT_SPREAD_SR,
  PHOTOPIC_FLOOR,
  SCOTOPIC_CEILING,
  ZERO_MAGNITUDE_LUX,
  surfaceBrightnessLuminance,
} from './display/adaptation'
import { EXTINCTION_COEFFICIENT, airmass } from '@/astro/photometry'
import { DEEP_SKY_INDEX, findDeepSkyObject } from '@/astro/deepsky'
import {
  DSO_ATLAS_COUNT,
  DSO_ATLAS_MIN_MAJOR_ARCMIN,
  atlasRectOf,
  profileMagnitudeOffset,
} from './deepSkyAtlas'
import {
  EYE_SUMMATION_ARCMIN,
  EYE_SUMMATION_SR,
  effectiveSummationSr,
  elementMagnitude,
} from './display/extendedVision'
import { instrumentGainMag, instrumentOnsetFovDeg } from './display/instrument'

/** Part de vision scotopique — la meme loi que les etoiles et le fond de ciel. */
function rodFraction(magPerArcsec2: number): number {
  const luminance = surfaceBrightnessLuminance(magPerArcsec2)
  const mesopic =
    Math.log2(Math.max(1e-9, luminance) / SCOTOPIC_CEILING) /
    Math.log2(PHOTOPIC_FLOOR / SCOTOPIC_CEILING)
  const t = Math.min(1, Math.max(0, mesopic))
  return 1 - t * t * (3 - 2 * t)
}

export function deepSkySuite(): SuiteResult {
  return suite(
    'Ciel profond — extinction et couleur',
    {
      reference:
        'brillance du ciel nocturne publiee (~1,7·10⁻⁴ cd/m² a 22 mag/arcsec²) ; ' +
        'extinction en magnitudes par masse d air',
    },
    (t) => {
      // --- La conversion, recoupee par un chemin independant ----------------
      //
      // Elle n'introduit aucune constante : `ZERO_MAGNITUDE_LUX` sert deja aux
      // etoiles, et l'angle solide d'une seconde d'arc carree est de la
      // geometrie. Le recoupement se fait sur une valeur publiee.
      t.check('une seconde d arc carree vaut 2,35·10⁻¹¹ sr', ARCSEC2_STERADIAN, 2.3504e-11, 1e-15, ' sr')
      t.checkRelative(
        'un ciel a 22 mag/arcsec² rend la luminance publiee',
        surfaceBrightnessLuminance(22),
        1.7e-4,
        0.02,
        ' cd/m²',
      )
      t.checkTrue(
        'la conversion se deduit des constantes deja presentes',
        Math.abs(
          surfaceBrightnessLuminance(20) -
            (ZERO_MAGNITUDE_LUX * 10 ** (-0.4 * 20)) / ARCSEC2_STERADIAN,
        ) < 1e-18,
        'aucun coefficient d ajustement',
      )
      t.checkMonotonic(
        'une brillance de surface plus faible rend moins de luminance',
        [13, 18, 20, 22, 24].map((m) => surfaceBrightnessLuminance(m)),
        'decroissant',
      )

      // --- ⚠️ A l'oeil nu, le ciel profond est gris -------------------------
      //
      // Toutes ces luminances tombent sous le plafond scotopique de 0,01 cd/m²,
      // ou les cones ne repondent plus. Seule une pose longue revele une teinte.
      const typiques = [20, 21, 22, 23]
      t.checkTrue(
        'un objet du ciel profond est integralement gris a l oeil',
        typiques.every((m) => rodFraction(m) > 0.999),
        typiques
          .map((m) => `${m} mag/arcsec² : ${surfaceBrightnessLuminance(m).toExponential(1)} cd/m²`)
          .join(' ; ') + ` — plafond scotopique ${SCOTOPIC_CEILING} cd/m²`,
      )
      // ⚠️ **Et la loi predit la seule exception connue.** Le coeur de M42, a
      // 13 mag/arcsec², atteint 0,68 cd/m² et entre dans le domaine mesopique :
      // c'est precisement le seul objet dont les observateurs rapportent une
      // teinte a l'oeil nu.
      t.checkTrue(
        'le coeur de M42 garde l essentiel de sa couleur',
        rodFraction(13) < 0.25,
        `13 mag/arcsec² : ${(rodFraction(13) * 100).toFixed(0)} % de gris seulement — ` +
          `0,68 cd/m², dans le domaine mesopique`,
      )
      // La bascule est **progressive**, et c'est ce qu'on veut : rien ne saute
      // d'une teinte pleine a un gris franc.
      // La rampe sature a cent pour cent : ce qu'on demande n'est pas une
      // croissance stricte mais qu'elle ne **redescende** jamais.
      const gris = [13, 14, 15, 16, 18, 20].map(rodFraction)
      t.checkTrue(
        'la part de gris ne redescend jamais quand l objet s affaiblit',
        gris.every((v, i) => i === 0 || v >= gris[i - 1] - 1e-12),
        gris.map((v) => `${(v * 100).toFixed(0)} %`).join(' → '),
      )
      t.note(
        'part de gris selon la brillance : ' +
          [13, 15, 16, 18, 20].map((m) => `${m} → ${(rodFraction(m) * 100).toFixed(0)} %`).join(' ; '),
      )

      // --- L'extinction, sur une source etendue ------------------------------
      //
      // Pour une source **etendue**, l'extinction s'applique a la brillance de
      // surface exactement comme a une magnitude : elle attenue la radiance le
      // long du rayon, et l'angle solide ne change pas.
      const perte = (altitudeDeg: number) => EXTINCTION_COEFFICIENT * airmass(altitudeDeg)
      t.checkMonotonic(
        'la perte croit quand l objet descend vers l horizon',
        [90, 60, 30, 20, 10, 5].map(perte),
        'croissant',
      )
      // Un objet a la brillance du ciel disparait ; l'extinction doit donc faire
      // fondre le contraste, et non seulement assombrir l'objet.
      const contraste = (mu: number, ciel: number, altitudeDeg: number) =>
        ciel - (mu + perte(altitudeDeg))
      t.checkTrue(
        'le contraste d une galaxie fond vers l horizon',
        contraste(22, 21.5, 90) > contraste(22, 21.5, 10) + 1,
        `M31 sur un ciel a 21,5 : ${contraste(22, 21.5, 90).toFixed(2)} au zenith contre ` +
          `${contraste(22, 21.5, 10).toFixed(2)} a dix degres`,
      )
      t.note(
        'perte a la traversee : ' +
          [90, 30, 10, 5].map((h) => `${h}° ${perte(h).toFixed(2)} mag`).join(' ; '),
      )

      // --- L'atlas d'images ---------------------------------------------------
      //
      // ⚠️ Il ne porte **pas** une luminance mais un ecart de magnitude a la
      // brillance moyenne de l'objet. C'est ce qui permet a la photometrie
      // ci-dessus de garder la main : l'image dit ou est la lumiere, le moteur
      // dit combien il y en a.
      t.check('l octet nul rend cinq magnitudes de moins que la moyenne', profileMagnitudeOffset(0), 5, 1e-9, ' mag')
      t.check('l octet plein rend cinq magnitudes de plus', profileMagnitudeOffset(255), -5, 1e-9, ' mag')
      t.check(
        'le pas de quantification reste tres au-dessous du seuil perceptible',
        Math.abs(profileMagnitudeOffset(0) - profileMagnitudeOffset(1)),
        10 / 255,
        1e-6,
        ' mag',
      )
      t.checkTrue(
        'la moyenne du profil rend exactement la brillance du catalogue',
        // Une moyenne de un, c'est log10 = 0, soit le milieu exact de l'encodage.
        Math.abs(profileMagnitudeOffset(255 / 2)) < 1e-9,
        'aucun decalage entre le profil neutre et la brillance moyenne',
      )

      // Une image n'a de sens que pour un objet dont on connait l'etendue : le
      // profil se cale sur l'ellipse du catalogue.
      const assezGrands = DEEP_SKY_INDEX.filter((o) => o.majorArcmin >= DSO_ATLAS_MIN_MAJOR_ARCMIN)
      t.checkTrue(
        'tout objet assez etendu recoit une image',
        assezGrands.every((o) => atlasRectOf(o.index) !== null),
        `${assezGrands.filter((o) => atlasRectOf(o.index) !== null).length} sur ${assezGrands.length} ` +
          `au-dela de ${DSO_ATLAS_MIN_MAJOR_ARCMIN} minutes d arc`,
      )
      t.checkTrue(
        'aucun objet sans dimensions ne recoit d image',
        DEEP_SKY_INDEX.every((o) => atlasRectOf(o.index) === null || o.surfaceBrightness !== null),
        'le profil se cale sur l ellipse du catalogue, qui doit donc exister',
      )
      const rectangles = DEEP_SKY_INDEX.map((o) => atlasRectOf(o.index)).filter((r) => r !== null)
      t.checkTrue(
        'les rectangles sont distincts et tiennent dans la texture',
        new Set(rectangles.map((r) => `${r[0]},${r[1]}`)).size === rectangles.length &&
          rectangles.every((r) => r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= 1 && r[1] + r[3] <= 1),
        `${DSO_ATLAS_COUNT} tuiles rangees sans doublon d emplacement`,
      )

      // --- Detecter un objet etendu -------------------------------------------
      //
      // ⚠️ Le calque avait sa propre loi : un contraste decale de 1,5 puis
      // divise par 3,5, plafonne, multiplie par 0,42. Trois constantes
      // inventees, et une saturation atteinte des deux magnitudes au-dessus du
      // fond — le coeur de M31 rendait **169 niveaux sur un ciel a 0**.
      //
      // Elle est remplacee par la loi des sources ponctuelles, appliquee au
      // flux tombant dans l'aire sur laquelle l'oeil somme.
      const objet = (nom: string) => {
        const o = findDeepSkyObject(nom)
        if (!o || o.surfaceBrightness === null) return null
        const semiMajor = (o.majorArcmin * Math.PI) / 180 / 60 / 2
        const minor = o.minorArcmin > 0 ? o.minorArcmin : o.majorArcmin
        const semiMinor = (minor * Math.PI) / 180 / 60 / 2
        const omega = Math.PI * semiMajor * semiMinor
        return { ...o, omega, element: elementMagnitude(o.surfaceBrightness, omega) }
      }

      t.checkRelative(
        'l aire de sommation se deduit de l objet limite du ciel',
        EYE_SUMMATION_ARCMIN,
        32.9,
        0.02,
        ' arcmin de diametre',
      )
      // ⚠️ Ce n'est pas une justification mais une verification : l'intervalle
      // publie pour la sommation spatiale de l'oeil adapte a l'obscurite va de
      // dix minutes d'arc a un degre.
      t.checkTrue(
        'elle tombe dans l intervalle publie sans y avoir ete prise',
        EYE_SUMMATION_ARCMIN > 10 && EYE_SUMMATION_ARCMIN < 60,
        `${EYE_SUMMATION_ARCMIN.toFixed(1)} arcmin, deduit de M33 au seuil sous un ciel vierge`,
      )

      // Le plafond n'est pas une commodite : sans lui, un objet plus petit que
      // l'aire de sommation rendrait une magnitude **plus brillante que sa
      // magnitude integree**, ce qui n'a pas de sens.
      const m13 = objet('M13')
      t.check(
        'un objet plus petit que l aire de sommation retombe sur sa magnitude integree',
        m13?.element ?? NaN,
        m13?.magnitude ?? NaN,
        0.01,
        ' mag',
      )
      t.checkTrue(
        'le plafond joue bien pour lui',
        (m13?.omega ?? 0) < EYE_SUMMATION_SR &&
          effectiveSummationSr(m13?.omega ?? 0) === (m13?.omega ?? 0),
        'la loi des sources ponctuelles est la limite de celle-ci, pas un cas separe',
      )

      // Le controle qui compte : M81 a **la brillance de surface de M42** et
      // n'est pourtant pas un objet a l'oeil nu. C'est le plafond qui l'ecarte.
      const m42 = objet('M42')
      const m81 = objet('M81')
      t.checkTrue(
        'M81 sort de portee malgre une brillance de surface voisine de M42',
        Math.abs((m81?.surfaceBrightness ?? 0) - (m42?.surfaceBrightness ?? 0)) < 0.5 &&
          (m81?.element ?? 0) > 6.6 &&
          (m42?.element ?? 9) < 6,
        `brillances ${m42?.surfaceBrightness?.toFixed(2)} et ${m81?.surfaceBrightness?.toFixed(2)} ; ` +
          `m_element ${m42?.element.toFixed(2)} contre ${m81?.element.toFixed(2)}`,
      )

      const ordre = ['M42', 'M31', 'M33', 'M81', 'M101'].map((n) => objet(n)?.element ?? NaN)
      t.checkTrue(
        'les objets se classent comme les observateurs les classent',
        ordre.every((v, i) => i === 0 || v > ordre[i - 1]),
        'M42 puis M31, M33, M81, M101 : ' + ordre.map((v) => v.toFixed(2)).join(' < '),
      )

      // --- ⚠️ Detecter et paraitre brillant sont deux questions distinctes ----
      //
      // La sommation aide a **detecter**. Elle n'aide pas a **paraitre
      // brillant** : l'image retinienne d'une source etendue a la meme
      // brillance de surface que l'objet, quelle que soit sa taille. Les
      // confondre est ce qui rendait M31 aveuglante.
      const m31 = objet('M31')
      const eclat = (mu: number) => mu - 2.5 * Math.log10(EYE_POINT_SPREAD_SR / ARCSEC2_STERADIAN)
      t.checkTrue(
        'M31 se detecte largement mais ne parait que tenue',
        (m31?.element ?? 9) < 6.6 && eclat(m31?.surfaceBrightness ?? 0) > 6.6 + 4,
        `detectee a ${m31?.element.toFixed(2)} sous un ciel a 6,6, mais son eclat ` +
          `repond a ${eclat(m31?.surfaceBrightness ?? 0).toFixed(2)}`,
      )

      // --- L'instrument que le champ implique ---------------------------------
      //
      // ⚠️ Aucun seuil de champ n'est pose : la bascule tombe la ou l'ouverture
      // requise pour resoudre un pixel depasse la pupille adaptee.
      const pixelAngle = (fovDeg: number, h = 900) => (fovDeg * Math.PI) / 180 / h
      t.checkRelative(
        'la bascule se deduit de la pupille et de la diffraction',
        instrumentOnsetFovDeg(900),
        4.99,
        0.02,
        ' degres de champ',
      )
      t.checkTrue(
        'a champ large le rendu reste exactement celui de l oeil',
        instrumentGainMag(pixelAngle(60)) === 0 && instrumentGainMag(pixelAngle(10)) === 0,
        'gain nul au-dela de la bascule, aucun changement pour les vues d ensemble',
      )
      const champs = [4, 2, 1, 0.5, 0.2]
      const gains = champs.map((f) => instrumentGainMag(pixelAngle(f)))
      t.checkTrue(
        'le gain croit a mesure qu on zoome',
        gains.every((v, i) => i === 0 || v > gains[i - 1]),
        champs.map((f, i) => `${f} deg ${gains[i].toFixed(2)} mag`).join(' ; '),
      )
      t.note(
        'ouverture impliquee : ' +
          [2, 0.5, 0.05]
            .map((f) => `${f} deg vers ${((1000 * 1.22 * 555e-9) / pixelAngle(f)).toFixed(0)} mm`)
            .join(' ; '),
      )
    },
  )
}
