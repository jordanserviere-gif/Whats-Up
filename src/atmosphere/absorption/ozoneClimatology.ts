/**
 * Colonne d'ozone — variation avec la latitude et la saison.
 *
 * ## Pourquoi une constante ne suffit pas
 *
 * Le moteur emploie 300 unites Dobson depuis la phase 7. C'est la moyenne
 * globale, et elle est fausse presque partout : la colonne reelle va de **240 DU
 * sous les tropiques a plus de 430 DU aux hautes latitudes au printemps**, soit
 * un facteur deux.
 *
 * Cela se voit. L'ozone est ce qui rend le crepuscule **bleu** (bande de
 * Chappuis, phase 7) : sa quantite decide de la profondeur de ce bleu, et donc
 * de la couleur du ciel une demi-heure apres le coucher du Soleil. Un
 * observateur norvegien en avril et un observateur equatorial ne voient pas le
 * meme crepuscule, et c'est en grande partie pour cette raison.
 *
 * ## La structure, qui n'est pas de moi
 *
 * Trois faits d'observation gouvernent la distribution, et ils sont solides :
 *
 * 1. **La colonne croit vers les poles.** L'ozone se forme surtout au-dessus des
 *    tropiques, ou le rayonnement ultraviolet est le plus intense, mais la
 *    circulation de Brewer-Dobson la transporte vers les hautes latitudes ou
 *    elle s'accumule.
 * 2. **Elle culmine au printemps**, pour la meme raison : le transport hivernal
 *    accumule, et la photochimie estivale detruit.
 * 3. **Elle ne varie presque pas a l'equateur**, ou la circulation exporte en
 *    permanence ce qui s'y forme.
 *
 * ## ⚠️ La parametrisation, en revanche, est de moi
 *
 * Les trois coefficients ci-dessous ne viennent d'aucune publication : ils sont
 * choisis pour que le modele reproduise les **bornes observees** — 240 DU sous
 * les tropiques, 430 aux hautes latitudes nordiques au printemps — et la forme
 * qualitative ci-dessus. C'est une interpolation entre des faits connus, pas une
 * climatologie.
 *
 * **La reference a adopter est van Heuklon, T. K. (1979)**, *Estimating
 * atmospheric ozone for solar radiation models*, Solar Energy 22, 63–68 : elle
 * donne la colonne en fonction de la latitude, de la longitude et du jour de
 * l'annee, et elle est le standard des modeles de rayonnement solaire. La
 * brancher ne demanderait aucun changement de structure — seulement les bons
 * coefficients, verifies sur la publication.
 *
 * ## ⚠️ Ce que le modele ne fait pas
 *
 * **Le trou d'ozone antarctique** n'est pas represente. C'est un phenomene
 * anthropique, saisonnier et d'amplitude variable d'une decennie a l'autre : il
 * fait tomber la colonne sous 150 DU au-dessus de l'Antarctique entre septembre
 * et novembre. Le modeliser demanderait une chronologie, pas une formule, et
 * l'inventer serait pire que de l'omettre.
 *
 * La dependance en **longitude** est egalement absente : l'ozone suit les ondes
 * planetaires, et la colonne peut varier de plusieurs dizaines d'unites entre
 * deux meridiens a meme latitude.
 */

/** Colonne moyenne globale, DU — la valeur que le moteur employait seule. */
export const GLOBAL_MEAN_OZONE_DU = 300

/**
 * Colonne minimale, sous les tropiques, DU.
 *
 * ⚠️ Coefficient d'interpolation, cale sur les bornes observees. Voir l'en-tete.
 */
const TROPICAL_BASE_DU = 245

/** Croissance vers les poles, DU. ⚠️ Idem. */
const POLAR_INCREASE_DU = 95

/** Amplitude saisonniere aux poles, DU. ⚠️ Idem. */
const SEASONAL_AMPLITUDE_DU = 75

/** Jour de l'annee du maximum printanier, hemisphere nord. */
const NORTHERN_PEAK_DAY = 80

/** Jour de l'annee, de 0 a 365. */
export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1)
  return (date.getTime() - start) / 86_400_000
}

/**
 * Colonne d'ozone pour un lieu et une date, en unites Dobson.
 *
 * `sin²(latitude)` porte la dependance en latitude : nulle a l'equateur,
 * maximale aux poles, et **symetrique** — c'est ce qui fait que les deux
 * hemispheres se ressemblent, au trou antarctique pres.
 *
 * Le decalage saisonnier de six mois entre hemispheres n'est pas un cas
 * particulier : c'est le meme sinus, decale d'une demi-annee.
 */
export function ozoneColumnDu(latitudeDeg: number, date: Date): number {
  const latitude = (latitudeDeg * Math.PI) / 180
  const weight = Math.sin(latitude) ** 2

  const base = TROPICAL_BASE_DU + POLAR_INCREASE_DU * weight
  const amplitude = SEASONAL_AMPLITUDE_DU * weight

  // Le maximum tombe au printemps de chaque hemisphere : demi-annee de decalage
  // au sud, ce qui s'ecrit comme un simple dephasage.
  const peakDay = latitudeDeg >= 0 ? NORTHERN_PEAK_DAY : NORTHERN_PEAK_DAY + 182.6
  const phase = (2 * Math.PI * (dayOfYear(date) - peakDay)) / 365.25

  return base + amplitude * Math.cos(phase)
}
