/**
 * Champ de relief du mode debug — une chaine rectiligne, et rien d'autre.
 *
 * ## Pourquoi une chaine droite plutot qu'un massif
 *
 * Le moteur n'avait, jusqu'ici, **aucune surface a distance finie**. Le ciel est
 * a l'infini, les astres aussi, le sol est une calotte sans profondeur. La table
 * de perspective atmospherique est pourtant parametree en distance sur seize
 * tranches — et seule la tranche `w = 1` servait.
 *
 * Une chaine rectiligne qui passe a quinze kilometres a l'est est le banc le
 * plus severe qu'on puisse lui opposer, parce qu'elle fait varier **la seule
 * distance** en gardant tout le reste constant :
 *
 * - meme altitude de crete, meme albedo, meme profil, d'un bout a l'autre ;
 * - la distance passe de 15 km au point le plus proche a 300 km aux extremites,
 *   continument, sans saut ni raccord ;
 * - donc tout ecart d'aspect le long de la chaine **est** un effet de distance,
 *   et rien d'autre.
 *
 * On y lit d'un coup d'oeil ce que le moteur fait de la distance : l'extinction
 * de Rayleigh qui mange le contraste, la diffusion en avant qui bleuit les
 * cretes, et la courbure de la Terre qui finit par avaler la chaine.
 *
 * ## Ce que la geometrie donne gratuitement
 *
 * | Distance | Ce qu'on voit |
 * | --- | --- |
 * | 15 km | la base, a peine sous l'horizon apparent |
 * | 100 km | le sommet a +1,9°, la base noyee par la courbure |
 * | 244 km | le sommet **atteint** l'horizon |
 * | au-dela | plus rien |
 *
 * Ces nombres ne sont ecrits nulle part : ils sortent de `d²/2R` et du rayon
 * effectif de la refraction. La chaine disparait parce que la Terre est ronde.
 *
 * ## Le relief lui-meme
 *
 * Bruit de valeur fractal, six octaves, interpolation en `smoothstep` et graine
 * fixe : **le meme relief a chaque lancement**. Un banc de mesure dont la
 * geometrie changerait d'une session a l'autre ne servirait a rien.
 *
 * Ce n'est pas un modele de formation des reliefs, et ne pretend pas l'etre :
 * c'est une surface de test. Ce qui est physique ici, c'est ce que
 * l'atmosphere en fait.
 */

/** Demi-longueur de la chaine, metres — au-dela, la courbure l'a deja avalee. */
export const RIDGE_HALF_LENGTH_M = 300_000

/** Distance de l'axe de la chaine a l'observateur, metres, vers l'est. */
export const RIDGE_EAST_OFFSET_M = 15_000

/** Altitude de crete visee, metres. */
export const RIDGE_PEAK_M = 4_000

/** Demi-largeur du massif, metres : la chaine a une epaisseur, pas un fil. */
export const RIDGE_HALF_WIDTH_M = 9_000

/** Altitude a laquelle la neige tient, metres — ligne d'equilibre glaciaire aux latitudes moyennes. */
export const SNOW_LINE_M = 2_800

/**
 * Rayon terrestre **effectif** sous refraction, deduit d'une depression mesuree.
 *
 * La refraction courbe les rayons dans le meme sens que la surface : tout se
 * passe comme si la Terre etait plus grande. Le manuel de geodesie pose
 * `k = 1/7`, soit un rayon majore d'un septieme.
 *
 * ⚠️ **Le moteur, lui, integre le vrai profil d'indice, et il n'est pas
 * d'accord.** `horizonDipDeg` suit la branche descendante du rayon dans un
 * profil de Ciddor et rend 0,1731° a trente-cinq metres, la ou `k = 1/7` en
 * donne 0,1758 — un rayon effectif de 1,204 R contre 1,167, soit **3,1 %
 * d'ecart**.
 *
 * Trois millimes de degre, c'est un pixel a fort zoom : exactement la couture
 * qu'on voyait entre le bord du sol, place par le moteur, et l'horizon du
 * terrain, place par le manuel. Deux modeles d'horizon dans la meme image, et
 * c'est precisement ce que l'unicite de la table de refraction interdit
 * ailleurs dans ce projet.
 *
 * Le rayon effectif se **deduit donc de la depression mesuree**, par inversion
 * de `dip = √(2h/R_eff)`. Il n'est plus une constante mais une propriete du
 * site, et le terrain partage desormais son horizon avec le reste du moteur, par
 * construction.
 */
export function effectiveEarthRadiusM(observerElevationM: number, horizonDipDeg: number): number {
  const h = Math.max(1e-3, observerElevationM)
  const dipRad = (horizonDipDeg * Math.PI) / 180
  if (!(dipRad > 0)) return (6_371_000 * 7) / 6
  return (2 * h) / (dipRad * dipRad)
}

// ---------------------------------------------------------------------------
// Bruit
// ---------------------------------------------------------------------------

/** Haché entier — deterministe, sans etat, et le meme sur toute machine. */
function hash2(ix: number, iy: number): number {
  let h = (ix * 374_761_393 + iy * 668_265_263) | 0
  h = (h ^ (h >>> 13)) * 1_274_126_177
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296
}

/** Bruit de valeur, interpole en `smoothstep` pour que la derivee soit continue. */
function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy)
  const b = hash2(ix + 1, iy)
  const c = hash2(ix, iy + 1)
  const d = hash2(ix + 1, iy + 1)
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy
}

/**
 * Etire une valeur de bruit sur tout l'intervalle [0, 1].
 *
 * ⚠️ **Sans cela, la chaine n'atteint jamais son altitude nominale.** Une somme
 * d'octaves ne visite pas [0, 1] : ses extremes exigent que **toutes** les
 * octaves soient simultanement au maximum, ce qui n'arrive pratiquement jamais.
 * Sa plage utile est d'environ [0,30 ; 0,75], et la mesure le confirmait — une
 * crete nominale de 4 000 m culminait a 2 735.
 */
const stretch = (x: number): number => Math.max(0, Math.min(1, (x - 0.3) / 0.45))

/** Somme d'octaves, chacune deux fois plus fine et deux fois plus faible. */
function fbm(x: number, y: number, octaves = 6): number {
  let sum = 0
  let amplitude = 1
  let total = 0
  let fx = x
  let fy = y
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise(fx, fy)
    total += amplitude
    amplitude *= 0.5
    fx *= 2.03
    fy *= 2.03
  }
  return sum / total
}

// ---------------------------------------------------------------------------
// Le relief
// ---------------------------------------------------------------------------

/**
 * Altitude du sol, metres, en un point du plan local.
 *
 * `eastM` compte vers l'est, `northM` vers le nord, l'observateur a l'origine.
 *
 * Le profil transversal est une cloche en cosinus surelevee : la chaine monte de
 * ses deux pieds vers sa crete, et le bruit ne fait que la deformer. Sans elle,
 * un bruit seul donnerait un plateau accidente, pas une chaine.
 */
export function ridgeAltitudeM(eastM: number, northM: number): number {
  // Position transversale, normalisee : 0 sur l'axe, 1 aux pieds.
  const across = Math.abs(eastM - RIDGE_EAST_OFFSET_M) / RIDGE_HALF_WIDTH_M
  if (across >= 1) return 0

  // Cloche transversale, nulle et de derivee nulle aux pieds. L'exposant 1,5
  // resserre les pieds sans effiler la crete : au carre, la chaine devenait une
  // lame, et le relief se lisait mal.
  const profile = Math.pow(0.5 * (1 + Math.cos(Math.PI * across)), 1.5)

  // Deux echelles : le relief des sommets, et une ondulation lente qui fait que
  // toutes les cretes n'ont pas la meme hauteur — sans quoi la chaine serait un
  // mur, et l'oeil ne la lirait pas comme un relief.
  const ridges = stretch(fbm(northM / 9_000, eastM / 9_000))
  const swell = stretch(fbm(northM / 55_000 + 41.7, eastM / 55_000 + 13.1, 3))

  // Le bruit creuse plutot qu'il n'ajoute : la crete atteint son altitude
  // nominale la ou le bruit est maximal, et jamais au-dela.
  const relief = 0.3 + 0.7 * (0.45 * ridges + 0.55 * swell)
  return RIDGE_PEAK_M * profile * relief
}

/**
 * Hauteur **apparente** d'un point du sol, radians.
 *
 * C'est ici que la Terre devient ronde. Un point a la distance `d` et a
 * l'altitude `z` est vu, depuis un observateur a la hauteur `h`, sous l'angle :
 *
 *     (z − h)/d − d/(2·R_eff)
 *
 * Le premier terme est la geometrie, le second l'abaissement du a la courbure.
 * C'est ce second terme, et lui seul, qui fait qu'une chaine de quatre mille
 * metres cesse d'etre visible au-dela de deux cent quarante-quatre kilometres.
 *
 * `effectiveRadiusM` vient de `effectiveEarthRadiusM`, donc de la depression que
 * le moteur mesure : le terrain et le sol partagent le meme horizon.
 *
 * ⚠️ **L'arc tangente n'est pas une precaution de style.** Le rapport de la
 * denivelee a la distance est une tangente, pas un angle : les confondre est sans consequence au loin
 * — quatre secondes d'arc d'ecart a cent kilometres — mais devient absurde au
 * pied de l'observateur, ou le rapport depasse l'unite. A vingt metres d'un oeil
 * pose a trente-cinq, il vaut −1,75 : pris pour un angle, cela fait cent degres
 * sous l'horizon, le cosinus change de signe et le point se projette **a
 * l'azimut oppose**. Le maillage se retourne, et les anneaux proches barrent
 * l'ecran d'une nappe qui n'existe pas.
 *
 * Le second terme, lui, reste une approximation petit-angle assumee : il vaut
 * 0,02 radian a trois cents kilometres.
 */
export function apparentElevationRad(
  distanceM: number,
  altitudeM: number,
  observerM: number,
  effectiveRadiusM: number,
): number {
  const d = Math.max(1, distanceM)
  return Math.atan((altitudeM - observerM) / d) - d / (2 * effectiveRadiusM)
}

/**
 * Distance a laquelle un sommet d'altitude donnee rase l'horizon, metres.
 *
 * Sert a dimensionner le maillage : inutile de mailler au-dela.
 */
export const horizonRangeM = (altitudeM: number, observerM: number, effectiveRadiusM: number): number =>
  Math.sqrt(2 * effectiveRadiusM * Math.max(0, altitudeM)) +
  Math.sqrt(2 * effectiveRadiusM * Math.max(0, observerM))
