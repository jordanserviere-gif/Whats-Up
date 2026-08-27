/**
 * Validation des mirages.
 *
 * ## Ce qui se verifie sans reference exterieure
 *
 * Un mirage n'a pas de valeur publiee a laquelle se comparer : sa geometrie
 * depend entierement de la couche d'inversion qu'on lui donne, et celle-ci est
 * un modele. Ce qui se controle, ce sont donc des **proprietes de forme**, et
 * elles sont exigeantes.
 *
 * 1. **Le raccord.** La fonction de transfert coupe le trajet en deux : la
 *    couche, tracee ; le reste de l'atmosphere, lu dans la table de la phase 11.
 *    Le resultat doit etre **indifferent a l'endroit de la coupe**, et retomber
 *    sur la table directe quand il n'y a aucune inversion. C'est le controle qui
 *    attrape les erreurs de repere, et il en a attrape deux.
 *
 * 2. **La monotonie.** Sans inversion, viser plus haut c'est voir plus haut. Le
 *    mirage est **exactement** la perte de cette propriete.
 *
 * 3. **La resolution.** La couche d'inversion mesure quelques dizaines de
 *    centimetres. Un pas de marche qui ne la resout pas efface le mirage — et
 *    c'est un resultat physique, pas un defaut : un modele qui ne voit pas la
 *    couche ne peut pas en voir les consequences.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { sharedRefractionTable, trueFromTable } from '../refraction/refractionTable'
import { heatedPatch, sphericalField } from './AtmosphereField'
import { analyseMirage, buildMirageTransfer, type MirageTransferOptions } from './mirageTransfer'

const field = sphericalField(550)

/** Reglage convergé : voir la note de cout dans la doc de phase. */
const TRACE: MirageTransferOptions = {
  minStepM: 0.1,
  stepPerAltitude: 0.3,
  gradientStepM: 0.1,
  observerElevationM: 1.7,
}

const road = (excessK: number, thicknessM: number) =>
  heatedPatch(field, { distanceM: 300, radiusM: 2000, thicknessM, excessK, surfaceAltitudeM: 0 })

export function mirageSuite(): SuiteResult {
  return suite('Mirages', {}, (t) => {
    // --- 1. Le raccord est indifferent a l'endroit de la coupe ---------------
    const ground = sharedRefractionTable(2)
    const readAt = (transfer: ReturnType<typeof buildMirageTransfer>, targetDeg: number) => {
      let best = 0
      for (let i = 0; i < transfer.apparentDeg.length; i++) {
        if (Math.abs(transfer.apparentDeg[i] - targetDeg) < Math.abs(transfer.apparentDeg[best] - targetDeg)) {
          best = i
        }
      }
      return { apparent: transfer.apparentDeg[best], source: transfer.sourceDeg[best] }
    }

    const byTop = [8, 20, 60].map((layerTopM) =>
      buildMirageTransfer(field, {
        ...TRACE,
        layerTopM,
        count: 25,
        minApparentDeg: -0.3,
        maxApparentDeg: 0.2,
      }),
    )

    let worstHandoff = 0
    for (const transfer of byTop) {
      for (const target of [0.1, 0]) {
        const { apparent, source } = readAt(transfer, target)
        if (!Number.isFinite(source)) continue
        worstHandoff = Math.max(worstHandoff, Math.abs(source - trueFromTable(ground, apparent)) * 3600)
      }
    }
    t.checkTrue(
      'sans inversion, le trace retombe sur la table de refraction',
      worstHandoff < 15,
      `ecart maximal ${worstHandoff.toFixed(2)}″ — le residu est celui du profil tabule (2,4″) ` +
        'et de la sensibilite du rayon rasant',
    )

    const sources = byTop.map((transfer) => readAt(transfer, 0.1).source)
    const spread = (Math.max(...sources) - Math.min(...sources)) * 3600
    t.checkTrue(
      'et le resultat ne depend pas du sommet de couche choisi',
      spread < 5,
      `${spread.toFixed(2)}″ de dispersion entre des sommets de 8, 20 et 60 m — ` +
        'oublier la rotation de la verticale locale la portait a 650″',
    )

    // --- 2. Sans inversion : monotone, une seule image -----------------------
    const plain = buildMirageTransfer(field, {
      ...TRACE,
      layerTopM: 20,
      count: 41,
      minApparentDeg: -0.35,
      maxApparentDeg: 0.25,
    })
    const plainAnalysis = analyseMirage(plain)
    t.checkTrue(
      'une atmosphere sans inversion ne produit qu’une image',
      !plainAnalysis.multivalued && plainAnalysis.maxImages === 1,
      `${plainAnalysis.maxImages} image, fonction de transfert croissante — ` +
        'aucun mirage ne peut en sortir',
    )
    t.check('et aucune image inversee', plainAnalysis.invertedSpanDeg, 0, 0, '°')

    // --- 3. Avec inversion : la fonction cesse d'etre monotone ---------------
    const warm = buildMirageTransfer(road(20, 0.8), {
      ...TRACE,
      layerTopM: 20,
      count: 41,
      minApparentDeg: -0.35,
      maxApparentDeg: 0.25,
    })
    const warmAnalysis = analyseMirage(warm)
    t.checkTrue(
      'une couche surchauffee dedouble l’image',
      warmAnalysis.multivalued && warmAnalysis.maxImages >= 2,
      `${warmAnalysis.maxImages} images pour 20 K sur 80 cm — deux visees differentes ramenent ` +
        'la meme portion de ciel, dont une a l’envers',
    )
    t.checkTrue(
      'l’image inversee a une epaisseur du bon ordre',
      warmAnalysis.invertedSpanDeg > 0.1 && warmAnalysis.invertedSpanDeg < 0.6,
      `${warmAnalysis.invertedSpanDeg.toFixed(3)}° — a comparer au demi-degre du disque solaire, ` +
        'ce qui place le regime dans celui du Soleil « vase etrusque »',
    )
    t.checkTrue(
      'des visees sous l’horizon rendent du ciel au lieu du sol',
      warmAnalysis.turningBandDeg !== null && warmAnalysis.turningBandDeg[0] < -0.1,
      `bande de ${warmAnalysis.turningBandDeg?.[0].toFixed(3)}° a ` +
        `${warmAnalysis.turningBandDeg?.[1].toFixed(3)}° — c’est la « flaque d’eau » sur une route seche, ` +
        'qui est en realite l’image du ciel',
    )

    // La fonction passe par un minimum : c'est la ligne de fuite du mirage, et
    // sa forme en V est la signature du phenomene.
    let minimumIndex = -1
    for (let i = 0; i < warm.sourceDeg.length; i++) {
      if (!Number.isFinite(warm.sourceDeg[i])) continue
      if (minimumIndex < 0 || warm.sourceDeg[i] < warm.sourceDeg[minimumIndex]) minimumIndex = i
    }
    t.checkTrue(
      'la fonction de transfert passe par un minimum interieur',
      minimumIndex > 0 && minimumIndex < warm.sourceDeg.length - 1,
      `minimum a ${warm.apparentDeg[minimumIndex].toFixed(3)}° de visee — la ligne de fuite, ` +
        'ou les deux images se rejoignent',
    )

    // --- 4. Plus l'inversion est forte, plus le mirage est haut --------------
    const hot = buildMirageTransfer(road(50, 0.5), {
      ...TRACE,
      layerTopM: 20,
      count: 41,
      minApparentDeg: -0.5,
      maxApparentDeg: 0.25,
    })
    const hotAnalysis = analyseMirage(hot)
    t.checkTrue(
      'une inversion plus forte elargit l’image inversee',
      hotAnalysis.invertedSpanDeg > warmAnalysis.invertedSpanDeg,
      `${warmAnalysis.invertedSpanDeg.toFixed(3)}° a 20 K contre ` +
        `${hotAnalysis.invertedSpanDeg.toFixed(3)}° a 50 K`,
    )

    // --- 5. Un exces nul rend l'atmosphere standard --------------------------
    const nullExcess = buildMirageTransfer(road(0, 0.8), {
      ...TRACE,
      layerTopM: 20,
      count: 21,
      minApparentDeg: -0.3,
      maxApparentDeg: 0.2,
    })
    const nullAnalysis = analyseMirage(nullExcess)
    t.checkTrue(
      'une couche d’exces nul ne produit aucun mirage',
      !nullAnalysis.multivalued,
      'la perturbation doit disparaitre exactement, sans quoi son amplitude ne voudrait rien dire',
    )

    // --- 6. Le pas doit resoudre la couche -----------------------------------
    // Ce n'est pas un defaut numerique a masquer : un modele qui ne voit pas la
    // couche ne peut pas en voir les consequences. Le controle existe pour que
    // le reglage ne derive pas silencieusement vers l'aveuglement.
    const blind = buildMirageTransfer(road(20, 0.8), {
      ...TRACE,
      minStepM: 3,
      gradientStepM: 3,
      layerTopM: 20,
      count: 21,
      minApparentDeg: -0.35,
      maxApparentDeg: 0.25,
    })
    t.checkTrue(
      'un pas plus grand que la couche efface le mirage',
      !analyseMirage(blind).multivalued,
      'un pas de 3 m ne resout pas une couche de 80 cm — et le mirage disparait, ' +
        'ce qui est le comportement correct d’un modele aveugle a sa cause',
    )
  })
}
