/**
 * Constantes physiques fondamentales, en unites SI strictes.
 *
 * Toute constante porte sa source. Aucune valeur de cette liste n'a ete
 * ajustee pour un resultat visuel : c'est la regle du moteur, et c'est ici
 * qu'elle se joue en premier.
 *
 * Depuis la revision du SI de 2019, plusieurs de ces valeurs sont **exactes
 * par definition** — elles ne portent plus d'incertitude. C'est signale au cas
 * par cas, parce que la difference compte : une constante exacte ne doit jamais
 * etre « affinee », une constante mesuree peut l'etre.
 */

// ---------------------------------------------------------------------------
// Constantes universelles — SI 2019, exactes par definition
// ---------------------------------------------------------------------------

/** Constante de Boltzmann, J/K. Exacte par definition (SI 2019). */
export const BOLTZMANN = 1.380649e-23

/** Nombre d'Avogadro, mol⁻¹. Exact par definition (SI 2019). */
export const AVOGADRO = 6.02214076e23

/** Constante des gaz parfaits, J/(mol·K). Produit exact `AVOGADRO × BOLTZMANN`. */
export const GAS_CONSTANT = AVOGADRO * BOLTZMANN

/** Vitesse de la lumiere dans le vide, m/s. Exacte par definition. */
export const SPEED_OF_LIGHT = 299_792_458

/** Constante de Planck, J·s. Exacte par definition (SI 2019). */
export const PLANCK = 6.62607015e-34

// ---------------------------------------------------------------------------
// Constantes de l'atmosphere standard — US Standard Atmosphere 1976
// ---------------------------------------------------------------------------

/**
 * Constante des gaz **telle que definie par l'US Standard Atmosphere 1976**,
 * J/(mol·K).
 *
 * Elle vaut 8,31432 et **ne coincide pas** avec `GAS_CONSTANT` (8,314462618…).
 * L'ecart est de 2·10⁻⁵ en relatif — negligeable physiquement, mais pas
 * numeriquement : les tables publiees de l'US1976 ont ete calculees avec cette
 * valeur-la. Utiliser la constante moderne decale la pression de quelques
 * pascals a 80 km et fait echouer une validation au serre contre les tables.
 *
 * On garde donc les deux, chacune a sa place : `US1976_GAS_CONSTANT` pour
 * reproduire le modele standard, `GAS_CONSTANT` pour toute physique reelle.
 * Ce n'est pas une incoherence, c'est la difference entre un modele normatif
 * et une constante de la nature.
 */
export const US1976_GAS_CONSTANT = 8.31432

/**
 * Acceleration de la pesanteur de reference, m/s².
 *
 * Valeur conventionnelle exacte, adoptee par la 3ᵉ CGPM (1901). C'est elle qui
 * definit l'altitude geopotentielle (voir `standardAtmosphere.ts`) : dans ce
 * systeme de coordonnees, `g` est constante par construction, et toute la
 * variation reelle de la pesanteur avec l'altitude est absorbee par la
 * transformation geometrique → geopotentielle.
 */
export const STANDARD_GRAVITY = 9.80665

/**
 * Masse molaire moyenne de l'air sec, kg/mol.
 *
 * US1976, valeur au niveau de la mer. Le modele la tient pour **constante
 * jusqu'a 86 km** d'altitude geopotentielle : en dessous de la turbopause, le
 * brassage homogeneise la composition, et c'est cette homogeneite qui autorise
 * le traitement en gaz unique.
 */
export const DRY_AIR_MOLAR_MASS = 0.0289644

/** Masse molaire de la vapeur d'eau, kg/mol. */
export const WATER_MOLAR_MASS = 0.01801528

/**
 * Rayon terrestre effectif de l'US1976, m.
 *
 * **Ce n'est pas un rayon geometrique.** C'est le rayon qui rend exacte la
 * conversion entre altitude geometrique et geopotentielle a la latitude ou la
 * pesanteur vaut `STANDARD_GRAVITY` (environ 45,5°). Il ne doit jamais servir a
 * une intersection rayon-sphere ni a une position — voir `units.ts`, qui
 * recense les trois rayons terrestres du projet et leur usage respectif.
 */
export const US1976_EARTH_RADIUS = 6_356_766

// ---------------------------------------------------------------------------
// Composition de l'air sec
// ---------------------------------------------------------------------------

/**
 * Fraction molaire de CO₂ de l'air sec.
 *
 * **Valeur d'entree, pas une constante de la nature.** L'US1976 fige 314 ppm,
 * qui etait la valeur de l'epoque ; la teneur reelle depasse aujourd'hui
 * 420 ppm et continue de croitre. Elle intervient dans la masse molaire et,
 * surtout, dans l'indice de refraction de l'air (Ciddor, phase 10).
 *
 * On retient une valeur contemporaine par defaut, en la marquant comme
 * parametre : c'est un degre de liberte de `AtmosphereState`, pas une constante.
 */
export const DEFAULT_CO2_MOLE_FRACTION = 420e-6

// ---------------------------------------------------------------------------
// Rayonnement solaire
// ---------------------------------------------------------------------------

/**
 * Constante solaire — irradiance totale au sommet de l'atmosphere a 1 UA,
 * W/m².
 *
 * Valeur nominale de reference (« total solar irradiance », moyenne du cycle
 * solaire). Elle sert **uniquement de controle d'integration** : le moteur
 * transportera un spectre `L(λ)`, et l'integrale de ce spectre sur toutes les
 * longueurs d'onde devra retrouver cette valeur. C'est un test, pas une entree.
 *
 * Le spectre lui-meme n'est pas encore present dans le depot — voir phase 2 et
 * la liste des donnees a acquerir dans `docs/atmosphere-engine.md`.
 */
export const SOLAR_CONSTANT = 1361

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

/** Zero Celsius, en kelvins. Exact par definition. */
export const CELSIUS_ZERO = 273.15

/** Nanometres vers metres. */
export const NM_TO_M = 1e-9

/** Metres vers nanometres. */
export const M_TO_NM = 1e9
