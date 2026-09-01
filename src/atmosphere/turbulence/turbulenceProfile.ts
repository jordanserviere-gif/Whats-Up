/**
 * Profil vertical de turbulence, et ce qu'on en tire.
 *
 * ## Le profil
 *
 * `C_n²` varie de plusieurs ordres de grandeur entre le sol et la stratosphere,
 * et la forme de cette variation decide de tout. Le modele de **Hufnagel-Valley**
 * la decrit par trois termes, qui sont trois mecanismes distincts :
 *
 * ```
 * C_n²(h) = 0,00594·(v/27)²·(10⁻⁵h)¹⁰·exp(−h/1000)   ← cisaillement du jet
 *         + 2,7·10⁻¹⁶·exp(−h/1500)                    ← troposphere libre
 *         + A·exp(−h/100)                             ← couche limite de surface
 * ```
 *
 * Le premier culmine vers dix kilometres : c'est le **courant-jet**, dont le
 * cisaillement melange l'air a la tropopause. Le troisieme decroit en cent
 * metres : c'est la couche de surface, chauffee par le sol, et c'est elle qui
 * domine de loin pres du sol.
 *
 * ## Pourquoi ce modele se valide lui-meme
 *
 * **HV 5/7** tire son nom de ce qu'il doit produire : `r₀ = 5 cm` et
 * `θ₀ = 7 µrad` a 500 nm au zenith. Ce ne sont pas des valeurs a comparer a une
 * table exterieure — ce sont les valeurs qui **definissent** le jeu de
 * parametres. Si les constantes sont mal recopiees, ces deux nombres ne tombent
 * pas.
 *
 * ## Les integrales
 *
 * Tout ce qui interesse l'observateur est un moment de `C_n²` le long de la
 * ligne de visee, et chacun pese l'altitude differemment :
 *
 * | Grandeur | Poids | Ce qu'elle gouverne |
 * | --- | --- | --- |
 * | `r₀` | `h⁰` | la finesse de l'image — le seeing |
 * | `θ₀` | `h^(5/3)` | sur quel angle la correction reste valable |
 * | scintillation | `h^(5/6)` | le clignotement des etoiles |
 * | `f_G` | `v^(5/3)` | a quelle vitesse tout cela change |
 *
 * C'est pourquoi une turbulence de sol degrade le seeing sans faire scintiller,
 * et une turbulence d'altitude fait scintiller sans forcement gonfler l'image :
 * les poids en altitude ne sont pas les memes.
 *
 * References : Hufnagel (1974) ; Valley (1980) ; Roddier, F. (1981), *The
 * Effects of Atmospheric Turbulence in Optical Astronomy*, Progress in Optics
 * 19, 281–376 ; Fried, D. L. (1966), JOSA 56, 1372.
 */

export interface HufnagelValleyOptions {
  /**
   * Vitesse du vent de haute altitude, m/s — la « vitesse pseudo-vent » du
   * modele, qui pilote le terme de jet.
   */
  highAltitudeWindMs?: number
  /** Valeur de `C_n²` au sol, m^(−2/3). */
  groundCn2?: number
}

/**
 * Jeu de parametres **HV 5/7**.
 *
 * `v = 21 m/s` et `A = 1,7·10⁻¹⁴` sont exactement ce qui donne `r₀ = 5 cm` et
 * `θ₀ = 7 µrad` a 500 nm — d'ou le nom du modele, et d'ou le fait qu'il se
 * valide lui-meme.
 */
export const HV57: Required<HufnagelValleyOptions> = {
  highAltitudeWindMs: 21,
  groundCn2: 1.7e-14,
}

/** `C_n²` a une altitude donnee, m^(−2/3). `altitudeM` au-dessus du sol. */
export function hufnagelValley(altitudeM: number, options: HufnagelValleyOptions = {}): number {
  const { highAltitudeWindMs = HV57.highAltitudeWindMs, groundCn2 = HV57.groundCn2 } = options
  const h = Math.max(0, altitudeM)
  const jet =
    0.00594 * (highAltitudeWindMs / 27) ** 2 * Math.pow(1e-5 * h, 10) * Math.exp(-h / 1000)
  const troposphere = 2.7e-16 * Math.exp(-h / 1500)
  const surface = groundCn2 * Math.exp(-h / 100)
  return jet + troposphere + surface
}

/**
 * Moment `∫ C_n²(h)·h^p dh`, en unites SI.
 *
 * L'integration se fait en `h = H·u²`, ce qui resserre les pas pres du sol.
 * C'est necessaire : le terme de surface decroit en cent metres, et un
 * echantillonnage uniforme sur vingt-cinq kilometres le manquerait entierement —
 * or c'est lui qui domine `r₀`.
 */
export function turbulenceMoment(
  power: number,
  profile: (altitudeM: number) => number = hufnagelValley,
  topAltitudeM = 25_000,
  steps = 20_000,
): number {
  let total = 0
  const scale = Math.sqrt(topAltitudeM)
  const du = scale / steps
  for (let i = 0; i < steps; i++) {
    const u = (i + 0.5) * du
    const h = u * u
    // `dh = 2u·du`
    total += profile(h) * Math.pow(h, power) * 2 * u * du
  }
  return total
}

const SEC = (zenithAngleDeg: number): number => 1 / Math.cos((zenithAngleDeg * Math.PI) / 180)

/**
 * Parametre de Fried `r₀`, en metres.
 *
 *     r₀ = [0,423 · k² · sec ζ · ∫C_n² dh]^(−3/5)
 *
 * C'est **la longueur de coherence du front d'onde** : le diametre sur lequel
 * l'atmosphere ne l'a pas encore froisse d'un radian. Un telescope plus petit
 * que `r₀` est limite par la diffraction ; un telescope plus grand ne gagne plus
 * en resolution, seulement en lumiere.
 *
 * `r₀` **ne depend pas de l'echelle externe** dans la theorie de Kolmogorov —
 * c'est ce qui permet de vivre avec l'incertitude sur celle-ci.
 */
export function friedParameter(
  lambdaNm = 500,
  zenithAngleDeg = 0,
  profile?: (altitudeM: number) => number,
): number {
  const k = (2 * Math.PI) / (lambdaNm * 1e-9)
  const integral = turbulenceMoment(0, profile)
  return Math.pow(0.423 * k * k * SEC(zenithAngleDeg) * integral, -3 / 5)
}

/**
 * Seeing, en radians — largeur a mi-hauteur de l'image d'une etoile.
 *
 *     FWHM = 0,98 · λ/r₀
 *
 * Le `0,98` est le facteur de forme de la tache de longue pose dans une
 * turbulence de Kolmogorov. Comme `r₀ ∝ λ^(6/5)`, le seeing varie en
 * `λ^(−1/5)` : **il s'ameliore vers l'infrarouge**, mais lentement.
 */
export const seeingRad = (
  lambdaNm = 500,
  zenithAngleDeg = 0,
  profile?: (altitudeM: number) => number,
): number => (0.98 * (lambdaNm * 1e-9)) / friedParameter(lambdaNm, zenithAngleDeg, profile)

/** Seeing en secondes d'arc — l'unite dans laquelle il se lit partout. */
export const seeingArcsec = (
  lambdaNm = 500,
  zenithAngleDeg = 0,
  profile?: (altitudeM: number) => number,
): number => seeingRad(lambdaNm, zenithAngleDeg, profile) * 206264.806

/**
 * Angle isoplanetique `θ₀`, en radians.
 *
 *     θ₀ = [2,914 · k² · sec^(8/3)ζ · ∫C_n²·h^(5/3) dh]^(−3/5)
 *
 * L'angle sur lequel deux etoiles traversent sensiblement la meme turbulence.
 * Son poids en `h^(5/3)` le rend **dominé par la haute altitude**, la ou `r₀`
 * l'est par le sol : deux grandeurs, deux couches responsables.
 */
export function isoplanaticAngleRad(
  lambdaNm = 500,
  zenithAngleDeg = 0,
  profile?: (altitudeM: number) => number,
): number {
  const k = (2 * Math.PI) / (lambdaNm * 1e-9)
  const integral = turbulenceMoment(5 / 3, profile)
  return Math.pow(2.914 * k * k * Math.pow(SEC(zenithAngleDeg), 8 / 3) * integral, -3 / 5)
}

/**
 * Indice de scintillation d'une source ponctuelle, sans dimension.
 *
 *     σ_I² = 2,24 · k^(7/6) · sec^(11/6)ζ · ∫C_n²·h^(5/6) dh
 *
 * **C'est le scintillement des etoiles**, et son poids en `h^(5/6)` dit
 * pourquoi : il vient de la haute atmosphere, pas du sol. C'est aussi pourquoi
 * les planetes scintillent peu — elles ne sont pas ponctuelles, et leur disque
 * moyenne les taches de lumiere avant qu'elles n'atteignent l'oeil.
 *
 * ⚠️ **Regime faible seulement.** Au-dela de `σ_I² ≈ 1`, la theorie de
 * perturbation qui donne cette expression cesse d'etre valable et l'indice
 * sature. La formule le signale mais ne le corrige pas.
 */
export function scintillationIndex(
  lambdaNm = 500,
  zenithAngleDeg = 0,
  profile?: (altitudeM: number) => number,
): number {
  const k = (2 * Math.PI) / (lambdaNm * 1e-9)
  const integral = turbulenceMoment(5 / 6, profile)
  return 2.24 * Math.pow(k, 7 / 6) * Math.pow(SEC(zenithAngleDeg), 11 / 6) * integral
}

/**
 * Profil de vent de Bufton, m/s — le compagnon usuel de Hufnagel-Valley.
 *
 *     v(h) = v_sol + 30·exp(−[(h − 9400)/4800]²)
 *
 * Le terme gaussien est le courant-jet, centre a 9,4 km. C'est ce profil qui
 * fixe la vitesse a laquelle la turbulence defile devant le telescope, donc les
 * echelles de **temps** — la ou `C_n²` ne fixe que les amplitudes.
 */
export const buftonWind = (altitudeM: number, groundWindMs = 5): number =>
  groundWindMs + 30 * Math.exp(-(((altitudeM - 9400) / 4800) ** 2))

/**
 * Frequence de Greenwood, Hz.
 *
 *     f_G = 2,31 · λ^(−6/5) · [∫C_n²·v^(5/3) dh]^(3/5)
 *
 * La bande passante qu'il faudrait a une optique adaptative pour suivre la
 * turbulence. Pour l'oeil, elle dit surtout **a quel rythme** l'image tremble :
 * quelques dizaines de hertz, ce qui est trop rapide pour etre suivi et se voit
 * donc comme un flou — sauf a l'oculaire, ou l'image « bout ».
 */
export function greenwoodFrequency(
  lambdaNm = 500,
  profile: (altitudeM: number) => number = hufnagelValley,
  wind: (altitudeM: number) => number = (h) => buftonWind(h),
  topAltitudeM = 25_000,
  steps = 20_000,
): number {
  let integral = 0
  const scale = Math.sqrt(topAltitudeM)
  const du = scale / steps
  for (let i = 0; i < steps; i++) {
    const u = (i + 0.5) * du
    const h = u * u
    integral += profile(h) * Math.pow(wind(h), 5 / 3) * 2 * u * du
  }
  return 2.31 * Math.pow(lambdaNm * 1e-9, -6 / 5) * Math.pow(integral, 3 / 5)
}
