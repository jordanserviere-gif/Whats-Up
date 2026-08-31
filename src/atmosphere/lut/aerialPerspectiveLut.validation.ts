/**
 * Validation de la perspective atmospherique.
 *
 * ## Ce qui doit etre vrai, et pourquoi
 *
 * Cette table est la premiere du moteur a etre lue par **trois materiaux
 * differents** — le fond de ciel, les corps du systeme solaire, les avions.
 * L'enjeu n'est donc pas seulement qu'elle soit juste, mais qu'elle soit
 * **la meme pour tous** : c'est ce qui fait qu'un astre bas se fond dans le ciel
 * qui l'entoure au lieu de s'en detacher par une couture.
 *
 * D'ou le controle central : la **tranche lointaine est le ciel**, au sens
 * numerique et non approche. Un astre est a l'infini, il lit donc exactement ce
 * que le fond de ciel lit a cote de lui.
 *
 * Les autres invariants sont ceux du transfert radiatif :
 *
 * - `T(0) = 1` et rien de diffuse a distance nulle — un objet colle a l'oeil est
 *   vu tel quel ;
 * - `T` decroit avec la distance, la diffusion cumulee croit ;
 * - `T` rougit quand la visee s'abaisse, parce que la section efficace de
 *   Rayleigh varie en λ⁻⁴ ;
 * - la transmittance verticale doit retomber sur celle que calcule le module de
 *   trajet oblique, par un tout autre chemin.
 */
import { suite, type SuiteResult } from '../validation/harness'
import { uniformSpectralGrid } from '../spectral/SpectralGrid'
import { CONTINENTAL_AEROSOL, aerosolOptics, aodFromTurbidity } from '../mie/aerosol'
import { ozoneCrossSectionOn } from '../absorption/ozone'
import { rayleighCrossSection } from '../rayleigh/rayleigh'
import { aerialPerspective, skyRadiance } from '../transport/singleScattering'
import { columnsToSpace } from '../transport/slantPath'
import { buildColumnLut } from './transmittanceLut'

import {
  AERIAL_LUT_DEPTH,
  AERIAL_LUT_HEIGHT,
  AERIAL_LUT_WIDTH,
  aerialW,
  AERIAL_HORIZON_ROW,
  aerialAltitudeDeg,
  aerialV,
  createAerialLut,
  fillAerialRows,
  measureMeanSkyLuminance,
  measureSkyIrradiance,
  sampleAerialLut,
} from './aerialPerspectiveLut'

const grid = uniformSpectralGrid(360, 830, 16)
const columnLut = buildColumnLut({ aerosolScaleHeightM: CONTINENTAL_AEROSOL.scaleHeightM })
const aerosols = aerosolOptics(grid, { ...CONTINENTAL_AEROSOL, aod550: aodFromTurbidity(1) })
const transport = { columnLut, aerosols }

const SUN_ALTITUDE = 20
const lut = createAerialLut()
fillAerialRows(lut, grid, SUN_ALTITUDE, 0, lut.height, transport)

export function aerialPerspectiveLutSuite(): SuiteResult {
  return suite('Perspective atmospherique', {}, (t) => {
    // --- La tranche lointaine est le ciel -----------------------------------
    // Le controle qui porte toute la phase. Mesure aux **noeuds exacts** de la
    // table, pour separer l'erreur de la marche de celle de l'interpolation :
    // hors noeuds l'ecart monte a 0,75 %, et c'est de l'interpolation
    // bilineaire, la meme que la table de ciel portait deja.
    let worstFar = 0
    let farWhere = ''
    // ⚠️ **A partir de l'horizon seulement.** Depuis que la table descend sous
    // l'horizon, sa moitie inferieure decrit un trajet qui se termine au sol :
    // ce n'est plus du ciel, et l'y comparer n'aurait pas de sens.
    for (let y = Math.ceil(AERIAL_HORIZON_ROW); y < lut.height; y += 3) {
      for (let x = 0; x < lut.width; x += 9) {
        const altitudeDeg = aerialAltitudeDeg(y / (lut.height - 1))
        const azimuthDeg = (180 * x) / (lut.width - 1)
        const sky = skyRadiance(grid, altitudeDeg, azimuthDeg, SUN_ALTITUDE, {
          ...transport,
          primarySteps: (AERIAL_LUT_DEPTH - 1) * 4,
        }).linearSrgb
        const i = (((lut.depth - 1) * lut.height + y) * lut.width + x) * 4
        for (let c = 0; c < 3; c++) {
          if (sky[c] <= 1e-9) continue
          const error = Math.abs(lut.scattered[i + c] - sky[c]) / sky[c]
          if (error > worstFar) {
            worstFar = error
            farWhere = `${altitudeDeg.toFixed(1)}°/${azimuthDeg.toFixed(0)}°`
          }
        }
      }
    }
    t.checkTrue(
      'la tranche lointaine est numeriquement le ciel',
      worstFar < 1e-6,
      `ecart relatif maximal ${worstFar.toExponential(2)} (${farWhere}) — ` +
        'c’est ce qui fait qu’un astre ne se detache pas du fond',
    )

    // --- Un objet colle a l'oeil est vu tel quel ----------------------------
    let worstZero = 0
    for (let y = 0; y < lut.height; y++) {
      for (let x = 0; x < lut.width; x++) {
        const i = (y * lut.width + x) * 4
        for (let c = 0; c < 3; c++) {
          worstZero = Math.max(worstZero, Math.abs(lut.transmittance[i + c] - 1), Math.abs(lut.scattered[i + c]))
        }
      }
    }
    t.check('a distance nulle, transmittance unite et rien de diffuse', worstZero, 0, 0)

    // --- Monotonie en distance ----------------------------------------------
    let risingT = 0
    let fallingScatter = 0
    let worstFall = 0
    let negativeScatter = 0
    let outOfRange = 0
    for (let y = 0; y < lut.height; y++) {
      for (let x = 0; x < lut.width; x++) {
        const previous = [1, 1, 1]
        const previousScatter = [0, 0, 0]
        for (let z = 0; z < lut.depth; z++) {
          const i = ((z * lut.height + y) * lut.width + x) * 4
          for (let c = 0; c < 3; c++) {
            const tr = lut.transmittance[i + c]
            const sc = lut.scattered[i + c]
            if (tr > previous[c] + 1e-7) risingT++
            if (sc < previousScatter[c] - 1e-7) {
              fallingScatter++
              const reference = Math.max(previousScatter[c], 1e-12)
              worstFall = Math.max(worstFall, (previousScatter[c] - sc) / reference)
            }
            if (sc < 0) negativeScatter++
            if (!(tr >= 0 && tr <= 1)) outOfRange++
            previous[c] = tr
            previousScatter[c] = sc
          }
        }
      }
    }
    t.check('la transmittance ne remonte jamais avec la distance', risingT, 0, 0)
    t.check('la diffusion cumulee ne devient jamais negative', negativeScatter, 0, 0)
    t.check('la transmittance reste dans [0, 1]', outOfRange, 0, 0)

    // La diffusion cumulee est monotone **sur le spectre** — elle accumule des
    // termes positifs — et c'est la que la physique l'impose. Sa projection en
    // sRGB ne l'herite pas : la primaire bleue a des lobes negatifs dans le
    // rouge, et une somme ponderee par une fonction qui change de signe peut
    // redescendre quand la lumiere ajoutee est rouge.
    //
    // Mesure : la baisse ne touche **que le bleu** — 1686 cas, aucun en rouge ni
    // en vert — et vaut au plus 7,2·10⁻³ sur une valeur de 25,8, soit 2,8·10⁻⁴.
    // Rien ne devient negatif.
    //
    // Contrairement a la transmittance, rien n'est corrige ici. La transmittance
    // est un **multiplicateur** : un signe negatif y inverserait le canal bleu de
    // l'objet, et l'artefact y atteignait 43 % en relatif. La diffusion est un
    // terme **additif**, toujours positif, dont l'artefact reste sous le
    // dix-millieme — et la tranche lointaine est validee au bit pres contre
    // `skyRadiance` juste au-dessus. La forcer abimerait le ciel pour rien.
    t.checkTrue(
      'l’artefact de projection sur la diffusion reste negligeable',
      worstFall < 1e-3,
      `baisse relative maximale ${worstFall.toExponential(2)} sur ${fallingScatter} cas, ` +
        'tous dans le canal bleu — la primaire bleue sRGB a des lobes negatifs',
    )

    // La monotonie exacte se verifie donc la ou elle est vraie : sur le spectre.
    const grazing = aerialPerspective(grid, 2, 0, SUN_ALTITUDE, {
      ...transport,
      slices: AERIAL_LUT_DEPTH,
      stepsPerSlice: 4,
    })
    let spectralFalls = 0
    for (let z = 1; z < AERIAL_LUT_DEPTH; z++) {
      for (let b = 0; b < grid.count; b++) {
        if (grazing.scattered[z * grid.count + b] < grazing.scattered[(z - 1) * grid.count + b]) {
          spectralFalls++
        }
      }
    }
    t.check('la diffusion cumulee est monotone bande par bande', spectralFalls, 0, 0)

    // --- Le rougissement de l'extinction ------------------------------------
    // Rayleigh varie en λ⁻⁴ : plus la visee est basse, plus le bleu est retire
    // avant le rouge. C'est ce qui rougit la Lune a son lever, et rien ne
    // l'ecrit nulle part.
    const far = (altitudeDeg: number) => sampleAerialLut(lut, altitudeDeg, 90, 1).transmittance
    const zenith = far(90)
    const low = far(2)
    t.checkTrue(
      'l’extinction rougit quand la visee s’abaisse',
      low[2] / low[0] < zenith[2] / zenith[0],
      `B/R vaut ${(zenith[2] / zenith[0]).toFixed(3)} au zenith contre ` +
        `${(low[2] / low[0]).toFixed(3)} a 2° — c’est la Lune rousse a son lever`,
    )
    t.checkTrue(
      'l’extinction croit quand la visee s’abaisse',
      low[1] < zenith[1] * 0.5,
      `transmittance verte ${zenith[1].toFixed(3)} au zenith contre ${low[1].toFixed(3)} a 2°`,
    )

    // --- La transmittance verticale, par un autre module ---------------------
    // Le module de trajet oblique calcule les memes colonnes par une marche
    // independante, avec un tout autre echantillonnage. Comparaison **sur les
    // spectres**, pour ne pas melanger l'erreur de transport et celle de la
    // reduction RGB.
    const vertical = aerialPerspective(grid, 90, 0, SUN_ALTITUDE, {
      ...transport,
      slices: AERIAL_LUT_DEPTH,
      stepsPerSlice: 4,
    })
    const columns = columnsToSpace(0, 1, 512, undefined, CONTINENTAL_AEROSOL.scaleHeightM)
    const ozoneSigma = ozoneCrossSectionOn(grid)
    let worstVertical = 0
    for (let b = 0; b < grid.count; b++) {
      const lambdaNm = (grid.edgesNm[b] + grid.edgesNm[b + 1]) / 2
      const tau =
        rayleighCrossSection(lambdaNm) * columns.air +
        ozoneSigma[b] * columns.ozone +
        aerosols.extinction[b] * columns.aerosolShape * aerosols.groundNumberDensity
      const expected = Math.exp(-tau)
      const actual = vertical.transmittance[(AERIAL_LUT_DEPTH - 1) * grid.count + b]
      worstVertical = Math.max(worstVertical, Math.abs(actual - expected) / expected)
    }
    t.checkTrue(
      'la transmittance verticale retombe sur le module de trajet oblique',
      worstVertical < 5e-3,
      `ecart relatif maximal ${worstVertical.toExponential(2)} sur les 16 bandes — ` +
        'deux marches independantes, un seul resultat',
    )

    // --- La quadrature est convergee ----------------------------------------
    // Quatre pas par tranche suffisent-ils ? Seize fois plus fin donne la
    // reference.
    const coarse = aerialPerspective(grid, 5, 90, SUN_ALTITUDE, {
      ...transport,
      slices: AERIAL_LUT_DEPTH,
      stepsPerSlice: 4,
    })
    const fine = aerialPerspective(grid, 5, 90, SUN_ALTITUDE, {
      ...transport,
      slices: AERIAL_LUT_DEPTH,
      stepsPerSlice: 64,
    })
    let worstQuadrature = 0
    for (let z = 1; z < AERIAL_LUT_DEPTH; z++) {
      for (let b = 0; b < grid.count; b++) {
        const i = z * grid.count + b
        if (fine.scattered[i] > 1e-12) {
          worstQuadrature = Math.max(
            worstQuadrature,
            Math.abs(coarse.scattered[i] - fine.scattered[i]) / fine.scattered[i],
          )
        }
      }
    }
    t.checkTrue(
      'quatre pas par tranche suffisent a la quadrature',
      worstQuadrature < 0.02,
      `ecart maximal a une marche seize fois plus fine : ${(worstQuadrature * 100).toFixed(2)} %`,
    )

    // --- Parametrisation de la distance -------------------------------------
    t.check('une distance nulle designe l’observateur', aerialW(0, 700_000), 0, 1e-12)
    t.check('une distance infinie designe la sortie', aerialW(Number.POSITIVE_INFINITY, 700_000), 1, 1e-12)
    t.check('le trajet total designe la sortie', aerialW(700_000, 700_000), 1, 1e-12)
    t.check('le quart du trajet tombe a mi-course en w', aerialW(175_000, 700_000), 0.5, 1e-12)

    // --- Le remplissage par tranches donne la meme table --------------------
    // C'est ce que fait le rendu, deux lignes par image.
    const sliced = createAerialLut()
    for (let row = 0; row < AERIAL_LUT_HEIGHT; row += 5) {
      fillAerialRows(sliced, grid, SUN_ALTITUDE, row, Math.min(AERIAL_LUT_HEIGHT, row + 5), transport)
    }
    let worstSlice = 0
    for (let i = 0; i < lut.scattered.length; i++) {
      worstSlice = Math.max(
        worstSlice,
        Math.abs(sliced.scattered[i] - lut.scattered[i]),
        Math.abs(sliced.transmittance[i] - lut.transmittance[i]),
      )
    }
    t.check('construction par tranches identique a la construction entiere', worstSlice, 0, 0)

    // --- L'eclairement diffus du ciel ----------------------------------------
    //
    // Il sert a **eclairer une surface**, ce que le moteur ne savait pas faire :
    // il connaissait la radiance du ciel dans une direction, pas ce que le ciel
    // entier depose sur un plan. C'est la moitie de l'eclairement d'un paysage,
    // et la totalite a l'ombre.
    //
    // L'invariant qui le porte : un ciel de radiance **uniforme** `L` doit
    // rendre exactement `π·L`. C'est la valeur de l'integrale de `cosθ` sur
    // l'hemisphere, et elle ne depend d'aucun detail du modele — seulement de
    // la ponderation. Une erreur de jacobien, ou l'oubli du cosinus, la
    // manquerait aussitot.
    const uniform = createAerialLut()
    const UNIFORM_RADIANCE = 3.7
    for (let i = 0; i < uniform.scattered.length; i++) uniform.scattered[i] = UNIFORM_RADIANCE
    const flat = measureSkyIrradiance(uniform)
    for (let c = 0; c < 3; c++) {
      t.checkRelative(
        `un ciel uniforme rend π·L — canal ${'RVB'[c]}`,
        flat[c],
        Math.PI * UNIFORM_RADIANCE,
        0.02,
      )
    }

    // Et sur le vrai ciel, l'eclairement doit rester **sous** `π·L_moyen` :
    // le ciel est plus brillant pres de l'horizon, ou le cosinus le retient.
    // C'est le sens meme de la distinction entre les deux mesures.
    const irradiance = measureSkyIrradiance(lut)
    const luminance = measureMeanSkyLuminance(lut)
    const irradianceLux =
      683 * (0.2126 * irradiance[0] + 0.7152 * irradiance[1] + 0.0722 * irradiance[2])
    t.checkTrue(
      'l’eclairement du vrai ciel reste sous π fois sa luminance moyenne',
      irradianceLux < Math.PI * luminance && irradianceLux > 0.5 * Math.PI * luminance,
      `${irradianceLux.toFixed(0)} lx contre ${(Math.PI * luminance).toFixed(0)} qu'un ciel ` +
        'uniforme donnerait — l’ecart est la part que le cosinus retire a l’horizon, ' +
        'la ou le ciel est justement le plus brillant',
    )
    t.checkTrue(
      'et il est plus bleu que blanc',
      irradiance[2] > irradiance[0],
      `R ${irradiance[0].toFixed(2)} · B ${irradiance[2].toFixed(2)} — c'est pourquoi une ombre ` +
        'au soleil est bleue : elle n’est eclairee que par le ciel',
    )

    // --- La moitie sous l'horizon --------------------------------------------
    //
    // Elle n'existait pas : le nuanceur ecretait toute visee descendante a la
    // ligne rasante. Sans consequence tant que rien ne vivait sous l'horizon,
    // faux des qu'une surface s'y trouve — le rayon rasant de la table ne
    // rencontre **jamais** le sol, quand le vrai s'y arrete.
    t.checkRelative('la ligne d’horizon tombe sur un texel', AERIAL_HORIZON_ROW % 1, 0, 1e-12)
    t.checkRelative('et elle porte exactement zero degre', aerialAltitudeDeg(0.5), 0, 1e-12)
    t.checkRelative('le bas de la table vise le nadir', aerialAltitudeDeg(0), -90, 1e-12)
    t.checkRelative('le haut vise le zenith', aerialAltitudeDeg(1), 90, 1e-12)

    // La parametrisation doit se refermer sur elle-meme, sinon le nuanceur et le
    // remplissage designeraient des directions differentes.
    let worstRound = 0
    for (const a of [-90, -60, -12, -1.5, -0.2, 0, 0.2, 1.5, 12, 60, 90]) {
      worstRound = Math.max(worstRound, Math.abs(aerialAltitudeDeg(aerialV(a)) - a))
    }
    t.checkTrue(
      'l’aller-retour hauteur → coordonnee → hauteur se referme',
      worstRound < 1e-9,
      `ecart maximal ${worstRound.toExponential(2)}° sur onze hauteurs, des deux cotes`,
    )

    // La resolution **au-dessus** de l'horizon ne doit pas avoir ete divisee
    // pour financer la moitie basse : c'est tout l'objet du nombre impair de
    // lignes.
    t.check(
      'la resolution au-dessus de l’horizon est intacte',
      lut.height - 1 - AERIAL_HORIZON_ROW,
      32,
      0,
    )

    // Le fait qui justifie toute la manoeuvre : sous l'horizon, le trajet est
    // **borne par le sol**, donc court — et la transmittance a mi-course y reste
    // bien plus haute que sur une visee rasante, qui traverse des centaines de
    // kilometres d'air.
    const rasant = sampleAerialLut(lut, 0, 90, 0.5)
    const descendant = sampleAerialLut(lut, -20, 90, 0.5)
    t.checkTrue(
      'sous l’horizon le trajet est borne par le sol, donc bien plus transparent',
      descendant.transmittance[1] > rasant.transmittance[1] * 1.5,
      `transmittance verte a mi-course : ${descendant.transmittance[1].toFixed(3)} a −20° ` +
        `contre ${rasant.transmittance[1].toFixed(3)} au ras — l’ecretage donnait la seconde ` +
        'aux deux',
    )

    // --- Dimensions ----------------------------------------------------------
    t.check('largeur de la table', lut.width, AERIAL_LUT_WIDTH, 0)
    t.check('hauteur d’une tranche', lut.height, AERIAL_LUT_HEIGHT, 0)
    t.check('nombre de tranches', lut.depth, AERIAL_LUT_DEPTH, 0)
  })
}
