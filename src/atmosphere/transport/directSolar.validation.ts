/**
 * Validation du transport direct — phase 4.
 *
 * Deux ancres externes, et une comparaison croisee qui vaut mieux que les deux.
 *
 * 1. **La masse d'air** doit retrouver la formule de Pickering (2002) que
 *    `astro/photometry.ts` applique deja, par un chemin entierement different :
 *    ici une integration geometrique dans une atmosphere spherique, la-bas une
 *    formule empirique ajustee. Deux erreurs independantes ne se ressemblent
 *    pas.
 *
 * 2. **L'eclairement horizontal** doit retrouver les paliers en lux de
 *    `astro/photometry.ts`, tabules depuis la litterature des crepuscules — a
 *    ceci pres que ce module ne calcule que le **rayonnement direct**. Le
 *    deficit attendu aux faibles hauteurs mesure donc la part du ciel diffus,
 *    que la phase 5 apportera. **Un accord parfait a basse hauteur serait
 *    suspect**, pas rassurant.
 *
 * 3. Enfin, le rougissement doit **emerger** : aucune couleur n'est ecrite dans
 *    `directSolar.ts`, seule la longueur du trajet change. On verifie donc que
 *    la temperature de couleur chute de facon monotone avec la hauteur.
 */
import { airmass } from '@/astro/photometry'
import { suite, type SuiteResult } from '../validation/harness'
import { uniformSpectralGrid } from '../spectral/SpectralGrid'
import { correlatedColourTemperature, linearSrgbToXyz } from '../spectral/SpectralSensor'
import { molecularColumnAbove } from '../rayleigh/rayleigh'
import { ATMOSPHERE_TOP_M, pathLengthToTop, relativeAirmass, slantColumn, slantColumnFromAltitude } from './slantPath'
import { directSolar, sunDiscTint } from './directSolar'
import { HORIZON_MARGIN_DEG } from '../horizonMargin'

const grid = uniformSpectralGrid(360, 830, 64)
const rad = (deg: number) => (deg * Math.PI) / 180

export function slantPathSuite(): SuiteResult {
  return suite(
    'Trajet oblique en atmosphere spherique (phase 4)',
    { reference: 'masse d’air de Pickering (2002), via astro/photometry.ts' },
    (t) => {
      // --- Coherence avec la colonne verticale de la phase 3 ----------------
      t.checkRelative(
        'colonne zenithale = colonne verticale de la phase 3',
        slantColumn(0, 0),
        molecularColumnAbove(0, ATMOSPHERE_TOP_M),
        1e-3,
        ' m⁻²',
      )
      t.checkRelative('masse d’air au zenith', relativeAirmass(0), 1, 1e-12)

      // --- Longueur geometrique du trajet -----------------------------------
      t.checkRelative('trajet vertical jusqu’au sommet', pathLengthToTop(0), ATMOSPHERE_TOP_M, 1e-9, ' m')
      // A l'horizon, la corde jusqu'a 100 km fait environ 1133 km : c'est la
      // demi-corde d'un cercle de rayon 6471 km coupant celui de 6371 km.
      t.checkRelative('trajet rasant jusqu’au sommet', pathLengthToTop(rad(90)), 1_132_800, 1e-3, ' m')

      // --- Contre Pickering, par un chemin different -------------------------
      // Aux hauteurs moyennes les deux methodes doivent coincider de pres. Pres
      // de l'horizon l'ecart grandit : la formule de Pickering est ajustee sur
      // une atmosphere refractee, la notre est purement geometrique.
      for (const altitude of [90, 60, 45, 30, 20, 10]) {
        t.checkRelative(
          `masse d’air a ${altitude}° vs Pickering`,
          relativeAirmass(rad(90 - altitude)),
          airmass(altitude),
          altitude >= 20 ? 5e-3 : 3e-2,
        )
      }
      t.note(
        `masse d’air : ${[90, 60, 30, 10, 5, 1, 0]
          .map((a) => `${a}° → ${relativeAirmass(rad(90 - a)).toFixed(2)}`)
          .join(' · ')}`,
      )

      // --- Le plafond de l'horizon -------------------------------------------
      // La secante plan-parallele divergerait ; la geometrie spherique plafonne.
      const horizon = relativeAirmass(rad(90))
      t.checkTrue(
        'la masse d’air plafonne a l’horizon au lieu de diverger',
        horizon > 30 && horizon < 45,
        `${horizon.toFixed(2)} — la secante plan-parallele dirait l’infini ; ` +
          `Pickering donne ${airmass(0).toFixed(2)}`,
      )

      // --- Monotonie ---------------------------------------------------------
      const columns: number[] = []
      for (let a = 90; a >= 0; a -= 2) columns.push(slantColumnFromAltitude(a))
      t.checkMonotonic('la colonne croit quand le Soleil descend', columns, 'croissant')

      // --- Altitude de l'observateur -----------------------------------------
      t.checkTrue(
        'un observateur en altitude traverse moins d’air',
        slantColumn(0, 2877) < slantColumn(0, 0),
        `Pic du Midi : ${((1 - slantColumn(0, 2877) / slantColumn(0, 0)) * 100).toFixed(0)} % de colonne en moins`,
      )

      // --- Sous l'horizon ------------------------------------------------------
      t.checkTrue(
        'aucune lumiere directe sous l’horizon geometrique',
        slantColumnFromAltitude(-1) === Number.POSITIVE_INFINITY,
        'la refraction fera reapparaitre le Soleil sous l’horizon en phase 11',
      )

      // --- Convergence de l'integration ----------------------------------------
      // Le nombre de pas est un choix numerique : il doit etre justifie par une
      // mesure, pas par l'habitude.
      t.checkRelative(
        'convergence de l’integration rasante (4096 vs 16384 pas)',
        slantColumn(rad(90), 0, 4096),
        slantColumn(rad(90), 0, 16384),
        1e-5,
      )
    },
  )
}

export function directSolarSuite(): SuiteResult {
  return suite(
    'Soleil direct et extinction (phase 4)',
    { reference: 'Beer-Lambert ; paliers en lux de astro/photometry.ts' },
    (t) => {
      const zenith = directSolar(grid, 90)

      // --- Zenith : on doit retrouver la phase 3 ------------------------------
      t.checkTrue(
        'eclairement au zenith coherent avec la phase 3',
        zenith.horizontalIlluminanceLux > 115_000 && zenith.horizontalIlluminanceLux < 126_000,
        `${(zenith.horizontalIlluminanceLux / 1000).toFixed(1)} klx — ` +
          `paliers de photometry.ts : 120 klx`,
      )

      // --- Les paliers de photometry.ts, par un chemin independant -----------
      // `E_horizontal = E_normal · sin(hauteur)` : les paliers publies sont des
      // eclairements horizontaux, la projection est donc indispensable.
      const anchors: ReadonlyArray<readonly [number, number]> = [
        [90, 120_000],
        [45, 82_000],
        [20, 34_000],
      ]
      for (const [altitude, published] of anchors) {
        const computed = directSolar(grid, altitude).horizontalIlluminanceLux
        t.checkRelative(`eclairement horizontal a ${altitude}° vs photometry.ts`, computed, published, 0.06, ' lx')
      }

      // A basse hauteur, le direct seul ne suffit plus : le ciel diffus prend le
      // relais. Le deficit est donc **attendu**, et sa taille mesure ce que la
      // phase 5 devra apporter.
      for (const [altitude, published] of [[5, 8000], [10, 15_000]] as const) {
        const computed = directSolar(grid, altitude).horizontalIlluminanceLux
        t.checkTrue(
          `deficit attendu a ${altitude}° : le direct seul ne suffit pas`,
          computed < published,
          `direct ${(computed / 1000).toFixed(1)} klx contre ${(published / 1000).toFixed(0)} klx publies — ` +
            `il manque ${(100 * (1 - computed / published)).toFixed(0)} % que la phase 5 devra apporter en diffus`,
        )
      }
      t.note(
        `eclairement horizontal direct : ${[90, 45, 20, 10, 5, 2]
          .map((a) => `${a}° → ${(directSolar(grid, a).horizontalIlluminanceLux / 1000).toFixed(1)} klx`)
          .join(' · ')}`,
      )

      // --- L'emergence : le Soleil rougit sans qu'on le lui demande ----------
      const temperatures: number[] = []
      for (let a = 90; a >= 1; a -= 1) temperatures.push(correlatedColourTemperature(directSolar(grid, a).xyz))
      t.checkMonotonic('la temperature de couleur baisse quand le Soleil descend', temperatures, 'decroissant')

      const cctZenith = correlatedColourTemperature(zenith.xyz)
      const cctLow = correlatedColourTemperature(directSolar(grid, 2).xyz)
      t.checkTrue(
        'le Soleil rougit fortement pres de l’horizon',
        cctLow < cctZenith - 1000,
        `${cctZenith.toFixed(0)} K au zenith → ${cctLow.toFixed(0)} K a 2° — ` +
          `aucune couleur n’est ecrite dans le modele, seul le trajet s’allonge`,
      )
      t.note(
        `temperature de couleur : ${[90, 30, 10, 5, 2, 1]
          .map((a) => `${a}° → ${correlatedColourTemperature(directSolar(grid, a).xyz).toFixed(0)} K`)
          .join(' · ')}`,
      )

      // Le rapport rouge/bleu doit croitre de facon monotone : c'est la forme
      // la plus directe de « le bleu part en premier ».
      const redBlue: number[] = []
      for (let a = 90; a >= 2; a -= 2) {
        const rgb = directSolar(grid, a).linearSrgb
        redBlue.push(rgb[0] / Math.max(1e-12, rgb[2]))
      }
      t.checkMonotonic('le rapport rouge/bleu croit quand le Soleil descend', redBlue, 'croissant')

      // --- Extinction monotone -------------------------------------------------
      const normal: number[] = []
      for (let a = 90; a >= 1; a -= 1) normal.push(directSolar(grid, a).normalIlluminanceLux)
      t.checkMonotonic('l’eclairement normal decroit quand le Soleil descend', normal, 'decroissant')

      t.check('aucune lumiere directe sous l’horizon', directSolar(grid, -1).normalIlluminanceLux, 0, 1e-12, ' lx')

      // --- La teinte du disque, elle, ne s'effondre pas a la frontiere ---------
      //
      // `directSolar` a raison de rendre zero : c'est un eclairement, et le
      // Soleil couche n'eclaire plus. Mais la **teinte du disque** en heritait
      // une chute a pic — la colonne rectiligne devient infinie des la hauteur
      // zero — et le disque s'eteignait d'un coup au lieu de se coucher.
      //
      // Or un Soleil de hauteur vraie −0,3° est encore entierement visible, la
      // refraction valant 0,57°. Le modele droit se trompe precisement la ou la
      // courbure compte, et la colonne est desormais bornee au rayon tangent.
      //
      // C'est le controle qui manquait.
      const tintLuma = (a: number) => {
        const [r, g, b] = sunDiscTint(grid, a)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      // Les deux limites de part et d'autre de la frontiere, prises assez pres
      // pour que la variation propre de la teinte — rapide a l'horizon, 5 % par
      // vingtieme de degre — ne masque pas la marche qu'on cherche. Avant, la
      // limite par la gauche valait **zero** : l'ecart etait de 100 %.
      t.checkRelative(
        'la teinte du disque traverse l’horizon sans marche',
        tintLuma(-0.001),
        tintLuma(0.001),
        0.01,
      )
      t.checkTrue(
        'et elle continue de faiblir dans la marge, au lieu de s’annuler',
        tintLuma(-1) > 0 && tintLuma(-1) < tintLuma(-0.05),
        `${tintLuma(-0.05).toExponential(2)} juste sous l’horizon, ${tintLuma(-1).toExponential(2)} ` +
          'a un degre — la colonne bornee au rayon tangent, pas une colonne infinie',
      )
      t.checkMonotonic(
        'la decroissance dans la marge est monotone',
        [0.2, 0, -0.5, -1, -2, -2.9].map(tintLuma),
        'decroissant',
      )
      t.check(
        'et au-dela de la marge le disque est eteint',
        tintLuma(-HORIZON_MARGIN_DEG - 0.01),
        0,
        0,
      )

      // --- Altitude de l'observateur --------------------------------------------
      t.checkTrue(
        'le Soleil est plus brillant en altitude',
        directSolar(grid, 30, { observerElevationM: 2877 }).normalIlluminanceLux >
          directSolar(grid, 30).normalIlluminanceLux,
        `a 30° : ${(directSolar(grid, 30).normalIlluminanceLux / 1000).toFixed(1)} klx au niveau de la mer, ` +
          `${(directSolar(grid, 30, { observerElevationM: 2877 }).normalIlluminanceLux / 1000).toFixed(1)} klx au Pic du Midi`,
      )

      // --- Excentricite de l'orbite ----------------------------------------------
      t.checkRelative(
        'perihelie / aphelie',
        directSolar(grid, 90, { distanceAu: 0.98329 }).normalIlluminanceLux /
          directSolar(grid, 90, { distanceAu: 1.01671 }).normalIlluminanceLux,
        1.0691,
        1e-3,
      )

      // --- La teinte livree au rendu ----------------------------------------------
      const tintZenith = sunDiscTint(grid, 90)
      // Passer par la matrice plutot que par des coefficients de luma recopies :
      // arrondis a quatre decimales, ils laissent un residu de 1,7·10⁻⁵ qui n'a
      // rien a voir avec la grandeur mesuree.
      // Tolerance a 10⁻⁶ et non 10⁻¹² : le detour XYZ → sRGB → XYZ passe par deux
      // matrices donnees a sept decimales, et leur produit n'est l'identite qu'a
      // cette precision-la. C'est la meme raison qui fixe la tolerance du
      // controle d'inversion dans la suite du capteur.
      t.checkRelative('teinte normalisee : luma unite au zenith', linearSrgbToXyz(tintZenith)[1], 1, 1e-6)
      t.checkTrue(
        'meme au zenith le Soleil est deja legerement chaud',
        tintZenith[0] > tintZenith[2],
        `R ${tintZenith[0].toFixed(3)} · V ${tintZenith[1].toFixed(3)} · B ${tintZenith[2].toFixed(3)} — ` +
          `une masse d’air suffit a retirer du bleu`,
      )
      const tintLow = sunDiscTint(grid, 3)
      t.checkTrue(
        'a 3° la teinte est fortement rouge et tres attenuee',
        tintLow[0] > 4 * tintLow[2] && tintLow[0] < tintZenith[0],
        `R ${tintLow[0].toFixed(3)} · V ${tintLow[1].toFixed(3)} · B ${tintLow[2].toFixed(3)}`,
      )

      // --- Conservation ------------------------------------------------------------
      // La transmittance ne peut ni depasser 1 ni etre negative : c'est une
      // fraction de lumiere survivante.
      for (const a of [90, 30, 5, 0]) {
        const tr = directSolar(grid, a).transmittance
        t.checkTrue(
          `transmittance dans [0, 1] a ${a}°`,
          Array.from(tr).every((v) => v >= 0 && v <= 1),
        )
      }
      t.checkTrue(
        'la transmittance est toujours plus faible dans le bleu',
        [90, 45, 10].every((a) => {
          const tr = directSolar(grid, a).transmittance
          return tr[2] < tr[grid.count - 3]
        }),
      )

      const irradianceRatio = zenith.irradianceWPerM2 / directSolar(grid, 90).irradianceWPerM2
      t.checkRelative('reproductibilite du calcul', irradianceRatio, 1, 1e-15)
      t.note(
        `irradiance visible transmise au zenith : ${zenith.irradianceWPerM2.toFixed(1)} W/m² ` +
          `sur ${(zenith.irradianceWPerM2 / zenith.transmittance[grid.count >> 1]).toFixed(0)} W/m² incidents`,
      )
    },
  )
}
