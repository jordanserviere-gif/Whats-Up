/**
 * Theorie de Mie — diffusion par une sphere de taille quelconque.
 *
 * ## Pourquoi elle est necessaire
 *
 * Rayleigh suppose des diffuseurs tres petits devant la longueur d'onde. C'est
 * vrai d'une molecule d'air (0,3 nm contre 550), faux d'un aerosol (0,1 a 1 µm).
 * Quand la particule approche la longueur d'onde, la diffusion cesse d'etre
 * symetrique et cesse de dependre de λ⁻⁴ : elle devient fortement dirigee vers
 * l'avant et presque achromatique. C'est ce qui blanchit l'horizon et entoure le
 * Soleil d'un halo.
 *
 * ## L'algorithme
 *
 * Solution de Bohren & Huffman (*Absorption and Scattering of Light by Small
 * Particles*, 1983), chapitre 4 : developpement en harmoniques spheriques
 * vectorielles, dont les coefficients `aₙ` et `bₙ` portent toute la physique.
 *
 * Deux precautions numeriques, et elles ne sont pas optionnelles :
 *
 * - **La recurrence sur `Dₙ = ψ'ₙ/ψₙ` se fait vers le bas.** Vers le haut elle
 *   est instable : l'erreur d'arrondi croit exponentiellement avec l'ordre, et
 *   le resultat devient absurde des que la particule depasse quelques longueurs
 *   d'onde. On part donc d'un ordre tres eleve avec une valeur nulle, et on
 *   descend — la recurrence est alors contractante et oublie sa condition
 *   initiale.
 * - **Le nombre de termes suit `x + 4x^⅓ + 2`**, critere de Wiscombe. En
 *   dessous, la serie est tronquee avant d'avoir converge ; au-dessus, on paie
 *   des termes negligeables.
 *
 * ## Ce qui la valide sans aucune donnee exterieure
 *
 * Trois limites analytiques, et la meilleure des trois est une comparaison
 * **entre deux modules du moteur** : quand la particule devient tres petite,
 * Mie doit retrouver exactement la section efficace que le module Rayleigh
 * calcule par un tout autre chemin. Deux algorithmes independants, un seul
 * nombre.
 */

/** Nombre complexe, en representation cartesienne. */
export interface Complex {
  re: number
  im: number
}

const c = (re: number, im = 0): Complex => ({ re, im })
const cAdd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im })
const cSub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im })
const cMul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
})
const cDiv = (a: Complex, b: Complex): Complex => {
  const d = b.re * b.re + b.im * b.im
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }
}
const cScale = (a: Complex, k: number): Complex => ({ re: a.re * k, im: a.im * k })
const cConj = (a: Complex): Complex => ({ re: a.re, im: -a.im })
const cAbs2 = (a: Complex): number => a.re * a.re + a.im * a.im

export interface MieCoefficients {
  /** Coefficients `aₙ`, indices 1..nMax. */
  a: Complex[]
  /** Coefficients `bₙ`, indices 1..nMax. */
  b: Complex[]
  nMax: number
  /** Parametre de taille `x = 2πr/λ`. */
  x: number
}

/**
 * Coefficients de Mie pour un parametre de taille et un indice complexe.
 *
 * `m` est l'indice **relatif au milieu**, partie imaginaire positive pour un
 * materiau absorbant (convention `m = n − ik` avec `k > 0` ecrite ici
 * `{ re: n, im: k }`).
 */
export function mieCoefficients(x: number, m: Complex): MieCoefficients {
  if (!(x > 0)) return { a: [], b: [], nMax: 0, x }

  // Critere de Wiscombe : au-dela, les termes ne contribuent plus.
  const nMax = Math.max(1, Math.round(x + 4 * Math.cbrt(x) + 2))

  // Convention de Bohren & Huffman : `m = n + ik` avec `k ≥ 0` pour un
  // materiau absorbant, associee a `ξₙ = ψₙ − iχₙ` plus bas. Inverser ce signe
  // ne produit pas une erreur visible mais un albedo de diffusion simple
  // **superieur a 1** — c'est-a-dire une particule qui diffuserait plus de
  // lumiere qu'elle n'en intercepte.
  const mInner = c(m.re, Math.abs(m.im))
  const y = cScale(mInner, x)
  const yAbs = Math.sqrt(cAbs2(y))

  // Recurrence descendante sur Dₙ(y). Le point de depart est volontairement
  // tres au-dessus de nMax : la recurrence oublie sa condition initiale en
  // quelques dizaines de pas.
  const nStart = Math.round(Math.max(nMax, yAbs) + 16)
  const d: Complex[] = new Array(nStart + 1)
  d[nStart] = c(0, 0)
  for (let n = nStart; n > 0; n--) {
    const nOverY = cDiv(c(n), y)
    d[n - 1] = cSub(nOverY, cDiv(c(1), cAdd(d[n], nOverY)))
  }

  // Recurrences montantes sur ψ et χ, stables pour ces fonctions.
  let psiPrev = Math.cos(x)
  let psi = Math.sin(x)
  let chiPrev = -Math.sin(x)
  let chi = Math.cos(x)

  const a: Complex[] = new Array(nMax + 1)
  const b: Complex[] = new Array(nMax + 1)

  for (let n = 1; n <= nMax; n++) {
    const psiNext = ((2 * n - 1) / x) * psi - psiPrev
    const chiNext = ((2 * n - 1) / x) * chi - chiPrev

    const xiPrev = c(psi, -chi)
    const xi = c(psiNext, -chiNext)

    const dn = d[n]
    const nOverX = c(n / x)

    // aₙ = [(Dₙ/m + n/x)ψₙ − ψₙ₋₁] / [(Dₙ/m + n/x)ξₙ − ξₙ₋₁]
    const ta = cAdd(cDiv(dn, mInner), nOverX)
    a[n] = cDiv(cSub(cScale(ta, psiNext), c(psi)), cSub(cMul(ta, xi), xiPrev))

    // bₙ = [(m·Dₙ + n/x)ψₙ − ψₙ₋₁] / [(m·Dₙ + n/x)ξₙ − ξₙ₋₁]
    const tb = cAdd(cMul(mInner, dn), nOverX)
    b[n] = cDiv(cSub(cScale(tb, psiNext), c(psi)), cSub(cMul(tb, xi), xiPrev))

    psiPrev = psi
    psi = psiNext
    chiPrev = chi
    chi = chiNext
  }

  return { a, b, nMax, x }
}

export interface MieEfficiencies {
  /** Efficacite d'extinction, sans dimension — section efficace / section geometrique. */
  qExt: number
  /** Efficacite de diffusion. */
  qSca: number
  /** Efficacite d'absorption : `qExt − qSca`. */
  qAbs: number
  /** Albedo de diffusion simple : `qSca / qExt`. Vaut 1 pour un diffuseur pur. */
  singleScatteringAlbedo: number
  /** Facteur d'asymetrie `⟨cos θ⟩`. Zero pour une diffusion symetrique, tend vers 1 vers l'avant. */
  asymmetry: number
}

/** Efficacites de Mie a partir des coefficients. */
export function mieEfficiencies(coefficients: MieCoefficients): MieEfficiencies {
  const { a, b, nMax, x } = coefficients
  if (nMax === 0) {
    return { qExt: 0, qSca: 0, qAbs: 0, singleScatteringAlbedo: 1, asymmetry: 0 }
  }

  let ext = 0
  let sca = 0
  let asym = 0

  for (let n = 1; n <= nMax; n++) {
    const w = 2 * n + 1
    ext += w * (a[n].re + b[n].re)
    sca += w * (cAbs2(a[n]) + cAbs2(b[n]))

    // Terme croise avec l'ordre suivant, qui porte l'asymetrie.
    if (n < nMax) {
      asym +=
        ((n * (n + 2)) / (n + 1)) *
        (cMul(a[n], cConj(a[n + 1])).re + cMul(b[n], cConj(b[n + 1])).re)
    }
    asym += (w / (n * (n + 1))) * cMul(a[n], cConj(b[n])).re
  }

  const qExt = (2 / (x * x)) * ext
  const qSca = (2 / (x * x)) * sca
  const asymmetry = qSca > 0 ? (4 / (x * x) / qSca) * asym : 0

  return {
    qExt,
    qSca,
    qAbs: Math.max(0, qExt - qSca),
    singleScatteringAlbedo: qExt > 0 ? qSca / qExt : 1,
    asymmetry,
  }
}

/**
 * Fonction de phase de Mie, sr⁻¹, pour un angle de diffusion donne.
 *
 *     p(θ) = (|S₁|² + |S₂|²) / (2π x² Q_sca)
 *
 * Normalisee : son integrale sur la sphere vaut 1. Contrairement a Rayleigh,
 * elle n'a **aucune forme analytique simple** — d'ou l'interet de la tabuler
 * une fois plutot que de la reevaluer.
 */
export function miePhaseFunction(coefficients: MieCoefficients, cosTheta: number, qSca: number): number {
  const { a, b, nMax, x } = coefficients
  if (nMax === 0 || !(qSca > 0)) return 0

  const mu = Math.max(-1, Math.min(1, cosTheta))
  let s1 = c(0, 0)
  let s2 = c(0, 0)

  // Recurrences sur les fonctions angulaires πₙ et τₙ.
  let piPrev = 0
  let pi = 1

  for (let n = 1; n <= nMax; n++) {
    const tau = n * mu * pi - (n + 1) * piPrev
    const w = (2 * n + 1) / (n * (n + 1))

    s1 = cAdd(s1, cScale(cAdd(cScale(a[n], pi), cScale(b[n], tau)), w))
    s2 = cAdd(s2, cScale(cAdd(cScale(a[n], tau), cScale(b[n], pi)), w))

    const piNext = ((2 * n + 1) / n) * mu * pi - ((n + 1) / n) * piPrev
    piPrev = pi
    pi = piNext
  }

  return (cAbs2(s1) + cAbs2(s2)) / (2 * Math.PI * x * x * qSca)
}

/**
 * Limite de Rayleigh de l'efficacite de diffusion.
 *
 *     Q_sca → (8/3) x⁴ |(m² − 1)/(m² + 2)|²
 *
 * Presente pour la validation : c'est vers elle que le calcul complet doit
 * converger quand la particule devient petite, et l'ecart mesure dit a partir
 * de quelle taille Rayleigh cesse d'etre suffisant.
 */
export function rayleighLimitQSca(x: number, m: Complex): number {
  const m2 = cMul(m, m)
  const ratio = cDiv(cSub(m2, c(1)), cAdd(m2, c(2)))
  return (8 / 3) * Math.pow(x, 4) * cAbs2(ratio)
}

/** Parametre de taille `x = 2πr/λ`, avec `r` et `λ` dans la meme unite. */
export const sizeParameter = (radiusM: number, lambdaNm: number): number =>
  (2 * Math.PI * radiusM) / (lambdaNm * 1e-9)
