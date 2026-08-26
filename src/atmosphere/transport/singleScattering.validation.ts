/**
 * Validation de la diffusion simple — phase 5.
 *
 * La cible avait ete **posee par la phase 4** : le Soleil direct seul rendait
 * 4,5 klx a 5° de hauteur contre 8,0 klx tabules par `astro/photometry.ts`, et
 * le deficit de 44 % devait etre exactement ce que le ciel diffus apporte.
 *
 * Trois familles de controles :
 *
 * 1. **Le bilan lumineux**, direct + diffus, confronte aux paliers publies. Il
 *    ne s'agit pas de faire coincider : l'ecart, avec son **signe**, mesure ce
 *    qui manque encore au modele.
 * 2. **Les structures emergentes** — ciel bleu au zenith, blanchiment vers
 *    l'horizon, minimum de luminance a 90° du Soleil, arche crepusculaire,
 *    ombre de la Terre. Aucune n'est ecrite nulle part ; elles doivent sortir
 *    de la geometrie et de λ⁻⁴.
 * 3. **La convergence des quadratures**, sans quoi les deux premieres ne
 *    veulent rien dire.
 */
import { solarIlluminance } from '@/astro/photometry'
import { suite, type SuiteResult } from '../validation/harness'
import { uniformSpectralGrid } from '../spectral/SpectralGrid'
import { directSolar } from './directSolar'
import { columnToSpace, diffuseHorizontalIlluminance, skyRadiance } from './singleScattering'

/** Seize bandes suffisent a une couleur, et gardent la suite executable. */
const grid = uniformSpectralGrid(360, 830, 16)

/** Point blanc D65, reference des ecarts de chromaticite. */
const WHITE = [0.3127, 0.329] as const
const distanceToWhite = (c: readonly [number, number]) => Math.hypot(c[0] - WHITE[0], c[1] - WHITE[1])

const HEMISPHERE = { zenithSamples: 16, azimuthSamples: 32 }

export function singleScatteringSuite(): SuiteResult {
  return suite(
    'Diffusion simple (phase 5)',
    { reference: 'paliers en lux de astro/photometry.ts ; equation du transfert' },
    (t) => {
      // --- LA cible posee par la phase 4 -----------------------------------
      const directAt5 = directSolar(grid, 5).horizontalIlluminanceLux
      const diffuseAt5 = diffuseHorizontalIlluminance(grid, 5, HEMISPHERE)
      const totalAt5 = directAt5 + diffuseAt5
      t.checkRelative('eclairement global a 5° vs photometry.ts', totalAt5, 8000, 0.2, ' lx')
      t.checkTrue(
        'le deficit de 44 % de la phase 4 est comble par le ciel',
        diffuseAt5 > 2500,
        `direct ${(directAt5 / 1000).toFixed(2)} klx + diffus ${(diffuseAt5 / 1000).toFixed(2)} klx = ` +
          `${(totalAt5 / 1000).toFixed(2)} klx contre 8,0 publies`,
      )

      // --- Le bilan complet, et le signe de l'ecart -------------------------
      // A Soleil haut, le total doit **depasser** legerement : il manque
      // l'ozone et les aerosols, qui ne font que retirer de la lumiere. Un
      // accord parfait signalerait deux erreurs qui se compensent.
      for (const h of [90, 45]) {
        const total = directSolar(grid, h).horizontalIlluminanceLux + diffuseHorizontalIlluminance(grid, h, HEMISPHERE)
        const published = solarIlluminance(h)
        const excess = total / published - 1
        t.checkTrue(
          `depassement attendu a ${h}° : il manque de l’extinction`,
          excess > 0 && excess < 0.15,
          `${(total / 1000).toFixed(1)} klx contre ${(published / 1000).toFixed(0)} publies (+${(excess * 100).toFixed(0)} %) — ` +
            `c’est ce que les phases 6 et 7 devront retirer`,
        )
      }

      const summary = [90, 45, 20, 10, 5].map((h) => {
        const direct = directSolar(grid, h).horizontalIlluminanceLux
        const diffuse = diffuseHorizontalIlluminance(grid, h, HEMISPHERE)
        return `${h}° → ${((direct + diffuse) / 1000).toFixed(1)}/${(solarIlluminance(h) / 1000).toFixed(1)} klx`
      })
      t.note(`global calcule / publie : ${summary.join(' · ')}`)

      // --- Le ciel est bleu, sans qu'aucun bleu ne soit ecrit ---------------
      const zenith = skyRadiance(grid, 88, 90, 60)
      t.checkTrue(
        'le zenith est bleu',
        zenith.chromaticity[0] < 0.27 && zenith.chromaticity[1] < 0.28,
        `chromaticite (${zenith.chromaticity.map((v) => v.toFixed(3)).join(', ')}) contre ` +
          `(${WHITE.join(', ')}) pour le blanc — aucune couleur n’est ecrite dans le solveur`,
      )
      t.checkTrue(
        'le zenith diffuse plus de bleu que de rouge',
        zenith.linearSrgb[2] > 2 * zenith.linearSrgb[0],
        `B/R = ${(zenith.linearSrgb[2] / zenith.linearSrgb[0]).toFixed(2)}`,
      )

      // --- L'horizon blanchit ------------------------------------------------
      // Emergence pure : la colonne s'allonge, l'auto-extinction rattrape le
      // gain de diffuseurs dans le bleu avant de le faire dans le rouge, et la
      // couleur remonte vers le blanc. Rien n'est ecrit pour cela.
      const low = skyRadiance(grid, 2, 90, 45)
      const high = skyRadiance(grid, 88, 90, 45)
      t.checkTrue(
        'le ciel blanchit vers l’horizon',
        distanceToWhite(low.chromaticity) < distanceToWhite(high.chromaticity),
        `zenith (${high.chromaticity.map((v) => v.toFixed(3)).join(', ')}) → ` +
          `horizon (${low.chromaticity.map((v) => v.toFixed(3)).join(', ')})`,
      )
      t.checkTrue(
        'l’horizon est plus lumineux que le zenith',
        low.luminanceCdPerM2 > high.luminanceCdPerM2,
        `${high.luminanceCdPerM2.toFixed(0)} cd/m² au zenith, ${low.luminanceCdPerM2.toFixed(0)} a 2°`,
      )

      const gradient: number[] = []
      for (const alt of [88, 60, 45, 30, 20, 10, 5, 2]) {
        gradient.push(skyRadiance(grid, alt, 90, 45).luminanceCdPerM2)
      }
      t.checkMonotonic('la luminance croit du zenith vers l’horizon', gradient, 'croissant')

      // --- La fonction de phase se lit dans le ciel --------------------------
      // Rayleigh varie en (1 + cos²θ) : minimum a 90° du Soleil, remontee des
      // deux cotes. C'est la signature de la phase, visible sans instrument.
      const towardSun = skyRadiance(grid, 20, 0, 45).luminanceCdPerM2
      const perpendicular = skyRadiance(grid, 20, 90, 45).luminanceCdPerM2
      const awayFromSun = skyRadiance(grid, 20, 180, 45).luminanceCdPerM2
      t.checkTrue(
        'minimum de luminance a 90° du Soleil',
        perpendicular < towardSun && perpendicular < awayFromSun,
        `vers le Soleil ${towardSun.toFixed(0)} · perpendiculaire ${perpendicular.toFixed(0)} · ` +
          `oppose ${awayFromSun.toFixed(0)} cd/m² — la forme en (1 + cos²θ)`,
      )

      // --- Le crepuscule, et l'ombre de la Terre ------------------------------
      // Rien n'a ete ecrit sur le crepuscule. Il existe parce qu'un point haut
      // dans l'atmosphere voit encore le Soleil quand l'observateur ne le voit
      // plus, et le test d'ombre du rayon secondaire suffit a le produire.
      const duskLow = skyRadiance(grid, 2, 0, -4)
      const duskZenith = skyRadiance(grid, 88, 0, -4)
      const duskOpposite = skyRadiance(grid, 2, 180, -4)

      t.checkTrue(
        'le crepuscule existe apres le coucher',
        duskLow.luminanceCdPerM2 > 100,
        `${duskLow.luminanceCdPerM2.toFixed(0)} cd/m² a 2° vers le Soleil, Soleil a −4° — ` +
          `le rendu actuel ne produit rien du tout dans ce regime`,
      )
      t.checkTrue(
        'l’arche crepusculaire : brillante vers le Soleil, sombre a l’oppose',
        duskLow.luminanceCdPerM2 > duskZenith.luminanceCdPerM2 &&
          duskZenith.luminanceCdPerM2 > duskOpposite.luminanceCdPerM2,
        `vers le Soleil ${duskLow.luminanceCdPerM2.toFixed(1)} · zenith ${duskZenith.luminanceCdPerM2.toFixed(1)} · ` +
          `oppose ${duskOpposite.luminanceCdPerM2.toFixed(2)} cd/m²`,
      )
      t.check(
        'ombre de la Terre : luminance nulle a l’horizon oppose',
        duskOpposite.luminanceCdPerM2,
        0,
        1e-12,
        ' cd/m²',
      )
      t.checkTrue(
        'le crepuscule rougit pres de l’horizon',
        duskLow.chromaticity[0] > duskZenith.chromaticity[0] + 0.1,
        `horizon (${duskLow.chromaticity.map((v) => v.toFixed(3)).join(', ')}) contre ` +
          `zenith (${duskZenith.chromaticity.map((v) => v.toFixed(3)).join(', ')})`,
      )

      const decay: number[] = []
      for (const h of [2, 0, -2, -4, -6, -9, -12]) decay.push(skyRadiance(grid, 10, 0, h).luminanceCdPerM2)
      t.checkMonotonic('le crepuscule s’eteint quand le Soleil s’enfonce', decay, 'decroissant')
      t.note(
        `luminance a 10° vers le Soleil : ${[0, -4, -6, -12]
          .map((h) => `${h}° → ${skyRadiance(grid, 10, 0, h).luminanceCdPerM2.toExponential(2)}`)
          .join(' · ')} cd/m²`,
      )

      // --- Ce que le crepuscule dit de ce qui manque ---------------------------
      // Sous l'horizon, le modele est **trop clair**. Deux manques agissent en
      // sens contraire : la diffusion multiple ajouterait de la lumiere, et
      // l'absorption par l'ozone en retirerait. Le signe de l'ecart dit donc
      // lequel domine — et c'est l'absorption, ce qui recoupe le resultat
      // classique de Hulburt (1953) : le bleu du ciel crepusculaire est un
      // effet de la bande de Chappuis de l'ozone, pas de Rayleigh.
      const twilightExcess = [0, -2, -4].map((h) => {
        const total = diffuseHorizontalIlluminance(grid, h, HEMISPHERE)
        return total / solarIlluminance(h)
      })
      t.checkTrue(
        'le crepuscule est trop clair — l’absence d’ozone domine',
        twilightExcess.every((r) => r > 1.3),
        `rapports calcule/publie : ${twilightExcess.map((r) => r.toFixed(1)).join(' · ')} a 0°, −2°, −4° — ` +
          `la diffusion multiple manquante eclaircirait encore : c’est donc l’absorption qui manque le plus (phase 7)`,
      )

      // Le zenith crepusculaire devrait etre **bleu** dans la realite, et il ne
      // l'est pas ici. C'est la meme cause, et la mesure de ce que la phase 7
      // devra produire.
      t.checkTrue(
        'le zenith crepusculaire n’est pas encore bleu — ozone manquant',
        distanceToWhite(duskZenith.chromaticity) < 0.05,
        `chromaticite (${duskZenith.chromaticity.map((v) => v.toFixed(3)).join(', ')}), quasi blanche ; ` +
          `le ciel crepusculaire reel est franchement bleu, par la bande de Chappuis`,
      )

      // --- Geometrie -----------------------------------------------------------
      t.check(
        'aucune radiance quand la visee rencontre le sol',
        skyRadiance(grid, -5, 0, 45).luminanceCdPerM2,
        0,
        1e-12,
        ' cd/m²',
      )
      t.check('colonne nulle depuis le sommet de l’atmosphere', columnToSpace(100_000, 1), 0, 1e-6, ' m⁻²')
      t.checkTrue(
        'colonne infinie vers un Soleil sous l’horizon local',
        columnToSpace(0, -0.5) === Number.POSITIVE_INFINITY,
      )
      t.checkTrue(
        'un rayon rasant depuis 50 km echappe a la Terre',
        Number.isFinite(columnToSpace(50_000, -0.05)),
        'c’est cette geometrie qui eclaire le ciel apres le coucher',
      )

      // --- Conservation ---------------------------------------------------------
      // Le ciel ne peut pas rendre plus de lumiere que le faisceau n'en perd.
      // 133,1 klx est l'eclairement hors atmosphere etabli en phase 2.
      const removed = 133_100 - directSolar(grid, 90).horizontalIlluminanceLux
      const diffuse90 = diffuseHorizontalIlluminance(grid, 90, HEMISPHERE)
      t.checkTrue(
        'le ciel rend moins que ce que le faisceau perd',
        diffuse90 < removed,
        `${(diffuse90 / 1000).toFixed(2)} klx diffuses contre ${(removed / 1000).toFixed(2)} klx retires du faisceau ` +
          `(${((diffuse90 / removed) * 100).toFixed(0)} %) — le reste repart vers l’espace ou est rediffuse`,
      )

      // --- Convergence des quadratures ------------------------------------------
      const coarse = skyRadiance(grid, 10, 45, 30, { primarySteps: 48, secondarySteps: 128 })
      const fine = skyRadiance(grid, 10, 45, 30, { primarySteps: 192, secondarySteps: 512 })
      t.checkRelative(
        'convergence du marcheur de rayons (48×128 vs 192×512)',
        coarse.luminanceCdPerM2,
        fine.luminanceCdPerM2,
        5e-3,
      )

      const coarseHemisphere = diffuseHorizontalIlluminance(grid, 30, { zenithSamples: 16, azimuthSamples: 32 })
      const fineHemisphere = diffuseHorizontalIlluminance(grid, 30, { zenithSamples: 32, azimuthSamples: 64 })
      t.checkRelative(
        'convergence de l’integration hemispherique (16×32 vs 32×64)',
        coarseHemisphere,
        fineHemisphere,
        2e-2,
      )
    },
  )
}
