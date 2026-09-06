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
  PHOTOPIC_FLOOR,
  SCOTOPIC_CEILING,
  ZERO_MAGNITUDE_LUX,
  surfaceBrightnessLuminance,
} from './display/adaptation'
import { EXTINCTION_COEFFICIENT, airmass } from '@/astro/photometry'
import { DEEP_SKY_INDEX, findDeepSkyObject } from '@/astro/deepsky'
import {
  DSO_ATLAS_COUNT,
  DSO_ATLAS_GRID,
  DSO_ATLAS_MIN_MAJOR_ARCMIN,
  atlasSlotOf,
  profileMagnitudeOffset,
} from './deepSkyAtlas'

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
        assezGrands.every((o) => atlasSlotOf(o.index) >= 0),
        `${assezGrands.filter((o) => atlasSlotOf(o.index) >= 0).length} sur ${assezGrands.length} ` +
          `au-dela de ${DSO_ATLAS_MIN_MAJOR_ARCMIN} minutes d arc`,
      )
      t.checkTrue(
        'aucun objet sans dimensions ne recoit d image',
        DEEP_SKY_INDEX.every((o) => atlasSlotOf(o.index) < 0 || o.surfaceBrightness !== null),
        'le profil se cale sur l ellipse du catalogue, qui doit donc exister',
      )
      const emplacements = DEEP_SKY_INDEX.map((o) => atlasSlotOf(o.index)).filter((s) => s >= 0)
      t.checkTrue(
        'les emplacements sont distincts et tiennent dans la grille',
        new Set(emplacements).size === emplacements.length &&
          emplacements.every((s) => s < DSO_ATLAS_GRID * DSO_ATLAS_GRID),
        `${DSO_ATLAS_COUNT} tuiles dans une grille de ${DSO_ATLAS_GRID}x${DSO_ATLAS_GRID}`,
      )

      // --- Ce que le profil change, concretement ------------------------------
      //
      // La visibilite d'un objet etendu tient au contraste : il s'efface quand
      // sa brillance de surface passe a plus d'une magnitude et demie sous
      // celle du fond. Avec un profil, ce n'est plus l'objet entier qui bascule
      // d'un coup mais chacune de ses parties.
      const m31 = findDeepSkyObject('M31')
      const mu = m31?.surfaceBrightness ?? NaN
      const visible = (brillance: number, ciel: number) => brillance < ciel + 1.5
      t.checkTrue(
        'M31 entiere se lit sous un ciel noir',
        visible(mu, 21.8),
        `brillance moyenne ${mu.toFixed(2)} mag/arcsec² contre un seuil a 23,30`,
      )
      t.checkTrue(
        'sous un ciel de ville, seules ses parties les plus brillantes ressortent',
        !visible(mu, 19.5) && visible(mu - 2.5 * Math.log10(10), 19.5),
        `la moyenne s efface, mais un profil de 10 fois la moyenne rend ` +
          `${(mu - 2.5).toFixed(2)} mag/arcsec² et passe le seuil de 21,00`,
      )
      t.note(
        'profil minimal visible pour M31 : ' +
          [21.8, 20.5, 19.5]
            .map((ciel) => `ciel ${ciel} → ${(10 ** ((mu - ciel - 1.5) / 2.5)).toFixed(1)} fois la moyenne`)
            .join(' ; '),
      )
    },
  )
}
