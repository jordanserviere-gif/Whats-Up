/**
 * Turbulence optique — la constante de structure de l'indice.
 *
 * ## De quoi il s'agit
 *
 * L'air n'est pas homogene. Le brassage turbulent mele en permanence des
 * parcelles d'air a des temperatures legerement differentes, donc a des indices
 * de refraction legerement differents. Un front d'onde qui traverse ce milieu en
 * ressort froisse — et c'est **toute** l'origine du scintillement des etoiles,
 * du seeing des telescopes et du tremblement de l'air chaud au-dessus d'une
 * route.
 *
 * Rien de tout cela ne se peint : ce sont des consequences d'une seule grandeur
 * statistique.
 *
 * ## La fonction de structure
 *
 * La turbulence n'a pas d'echelle propre : c'est une cascade, de la grande
 * echelle ou l'energie entre a la petite echelle ou la viscosite la dissipe.
 * Kolmogorov montre qu'entre les deux — le **domaine inertiel** — la statistique
 * ne depend que de la separation :
 *
 *     D_n(r) = ⟨[n(x) − n(x+r)]²⟩ = C_n² · r^(2/3)
 *
 * `C_n²` est donc **definie** par cette relation, et son exposant 2/3 n'est pas
 * ajustable : il sort de l'analyse dimensionnelle de la cascade. Ses unites,
 * m^(−2/3), le rappellent.
 *
 * ## Le lien avec la temperature
 *
 * Ce ne sont pas les fluctuations d'indice qui existent en premier, ce sont
 * celles de **temperature**. L'indice suit :
 *
 *     n − 1 ≈ 79·10⁻⁶ · P/T          (P en hPa, T en K)
 *     dn/dT = −79·10⁻⁶ · P/T²
 *     C_n   = |dn/dT| · C_T
 *
 * La forme simplifiee de l'indice est celle qu'emploie toute la litterature de
 * la turbulence optique. Elle est **verifiable** : elle doit retomber sur
 * l'indice de Ciddor de la phase 10, calcule par un tout autre chemin. La suite
 * de validation mesure l'ecart, et il est de quelques pour mille.
 *
 * C'est ce qui rattache la turbulence au reste du moteur : `C_T²` est une
 * grandeur meteorologique, et `C_n²` n'en est que la traduction optique.
 *
 * ## Ce que le spectre ajoute
 *
 * La fonction de structure decrit la statistique dans l'espace ; son equivalent
 * en frequence spatiale est le **spectre de puissance**. Kolmogorov pur :
 *
 *     Φ_n(κ) = 0,033 · C_n² · κ^(−11/3)
 *
 * Il diverge aux deux bouts, ce qui est le signe qu'il extrapole la cascade
 * au-dela du domaine ou elle existe. Le spectre de **von Karman** la borne par
 * les deux echelles reelles : l'echelle externe `L₀`, ou l'energie entre, et
 * l'echelle interne `l₀`, ou la viscosite l'emporte.
 *
 * Reference : Tatarskii, V. I. (1971), *The Effects of the Turbulent Atmosphere
 * on Wave Propagation* ; Roddier, F. (1981), *The Effects of Atmospheric
 * Turbulence in Optical Astronomy*, Progress in Optics 19, 281–376.
 */

/**
 * Coefficient optique de la refractivite de l'air, K/hPa.
 *
 * `n − 1 = COEFFICIENT · P/T`. C'est la forme a un seul terme qu'emploie la
 * litterature de la turbulence, la ou la phase 10 en emploie une a une
 * quinzaine de constantes.
 *
 * ⚠️ **Elle ignore la dispersion et l'humidite.** Dans le visible et pour de
 * l'air ordinaire, l'ecart a Ciddor reste sous le pour cent — la validation le
 * mesure. Pour un calcul de precision, c'est `refraction/airIndex.ts` qu'il
 * faut ; ici, ce sont des **fluctuations** qu'on decrit, et leur amplitude
 * relative est connue bien moins finement que cela.
 */
export const OPTICAL_REFRACTIVITY_COEFFICIENT = 79e-6

/** Refractivite simplifiee, sans dimension. `pressurePa` en Pa, `temperatureK` en K. */
export const simpleRefractivity = (pressurePa: number, temperatureK: number): number =>
  (OPTICAL_REFRACTIVITY_COEFFICIENT * (pressurePa / 100)) / temperatureK

/**
 * Sensibilite de l'indice a la temperature, K⁻¹ — toujours negative.
 *
 * L'air chaud est moins dense, donc moins refringent : `dn/dT < 0`. C'est le
 * signe qui, retourne au ras d'une surface chaude, produit les mirages de la
 * phase 14 — et ici, ce qui traduit une fluctuation thermique en fluctuation
 * optique.
 */
export const refractiveIndexTemperatureSensitivity = (
  pressurePa: number,
  temperatureK: number,
): number => -(OPTICAL_REFRACTIVITY_COEFFICIENT * (pressurePa / 100)) / (temperatureK * temperatureK)

/**
 * Constante de structure de l'indice, a partir de celle de la temperature.
 *
 *     C_n² = (dn/dT)² · C_T²
 *
 * `temperatureStructureConstant` est `C_T²`, en K²·m^(−2/3). Une valeur de
 * 0,1 pres du sol par beau temps donne `C_n² ≈ 10⁻¹³`, ce qui est l'ordre de
 * grandeur observe dans une couche limite diurne.
 */
export function refractiveStructureConstant(
  temperatureStructureConstant: number,
  pressurePa: number,
  temperatureK: number,
): number {
  const sensitivity = refractiveIndexTemperatureSensitivity(pressurePa, temperatureK)
  return sensitivity * sensitivity * temperatureStructureConstant
}

/**
 * Fonction de structure de l'indice, sans dimension.
 *
 *     D_n(r) = C_n² · r^(2/3)
 *
 * C'est la **definition** de `C_n²`, et l'exposant 2/3 n'est pas un parametre :
 * il sort de l'analyse dimensionnelle de la cascade de Kolmogorov.
 */
export const structureFunction = (cn2: number, separationM: number): number =>
  cn2 * Math.pow(Math.max(0, separationM), 2 / 3)

/** Constante du spectre de Kolmogorov, sans dimension. */
export const KOLMOGOROV_SPECTRUM_CONSTANT = 0.033

/**
 * Spectre de puissance de Kolmogorov, m³.
 *
 *     Φ_n(κ) = 0,033 · C_n² · κ^(−11/3)
 *
 * Il diverge en zero et ne s'amortit jamais : c'est le signe qu'il extrapole la
 * cascade au-dela du domaine ou elle existe reellement. Voir `vonKarmanSpectrum`.
 */
export const kolmogorovSpectrum = (cn2: number, kappaPerM: number): number =>
  KOLMOGOROV_SPECTRUM_CONSTANT * cn2 * Math.pow(kappaPerM, -11 / 3)

export interface TurbulenceScales {
  /** Echelle externe, m — ou l'energie entre dans la cascade. */
  outerScaleM: number
  /** Echelle interne, m — ou la viscosite la dissipe. */
  innerScaleM: number
}

/**
 * Echelles par defaut de l'atmosphere libre.
 *
 * ⚠️ **Valeurs plausibles, non mesurees.** L'echelle externe est la grandeur la
 * plus mal contrainte de toute la turbulence optique : les mesures vont de
 * quelques metres a plusieurs centaines selon le site, la methode et
 * l'altitude. Vingt-cinq metres est une valeur souvent retenue pour
 * l'atmosphere libre au-dessus d'un bon site.
 *
 * L'echelle interne, elle, est mieux cernee — quelques millimetres — parce
 * qu'elle est fixee par la viscosite de l'air et le taux de dissipation.
 *
 * L'effet de l'echelle externe sur le seeing est **faible** : `r₀` n'en depend
 * pas du tout dans la theorie de Kolmogorov, et les grandeurs qui en dependent
 * le font en puissance fractionnaire. C'est ce qui permet de vivre avec cette
 * incertitude.
 */
export const FREE_ATMOSPHERE_SCALES: TurbulenceScales = {
  outerScaleM: 25,
  innerScaleM: 0.005,
}

/**
 * Spectre de von Karman, m³.
 *
 *     Φ_n(κ) = 0,033 · C_n² · (κ² + κ₀²)^(−11/6) · exp(−κ²/κ_m²)
 *
 * avec `κ₀ = 2π/L₀` et `κ_m = 5,92/l₀`. Les deux bornes retirent au spectre de
 * Kolmogorov ses deux divergences, sans rien changer entre elles : dans le
 * domaine inertiel, les deux se confondent, ce que la validation verifie.
 *
 * Le `5,92` de `κ_m` est la constante d'usage de la coupure visqueuse — c'est
 * une convention de definition de `l₀`, pas une mesure.
 */
export function vonKarmanSpectrum(
  cn2: number,
  kappaPerM: number,
  scales: TurbulenceScales = FREE_ATMOSPHERE_SCALES,
): number {
  const kappa0 = (2 * Math.PI) / scales.outerScaleM
  const kappaM = 5.92 / scales.innerScaleM
  return (
    KOLMOGOROV_SPECTRUM_CONSTANT *
    cn2 *
    Math.pow(kappaPerM * kappaPerM + kappa0 * kappa0, -11 / 6) *
    Math.exp(-(kappaPerM * kappaPerM) / (kappaM * kappaM))
  )
}
