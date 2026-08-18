/**
 * Index de recherche des objets du ciel.
 *
 * Un seul vocabulaire couvre les quatre familles — corps du systeme solaire,
 * etoiles nommees, ciel profond, satellites — de sorte que la barre de recherche
 * et le pointage a la souris designent exactement les memes choses, sous les
 * memes identifiants. Sans cela, cliquer sur Vega et la chercher au clavier
 * meneraient a deux objets differents.
 */
import { BODIES } from './bodies'
import { NAMED_STARS, CONSTELLATIONS } from './catalog'
import { DEEP_SKY_INDEX } from './deepsky'
import type { Equatorial, OrbitalElements } from './types'

export type TargetKind = 'body' | 'star' | 'deepsky' | 'satellite' | 'constellation'

/**
 * Familles dont la position se lit dans un catalogue plutot que de se calculer :
 * elles partagent une meme fiche. Les corps du systeme solaire et les satellites
 * en sont exclus, puisqu'ils bougent.
 */
export type FixedKind = Extract<TargetKind, 'star' | 'deepsky' | 'constellation'>

const FIXED_KINDS: ReadonlySet<TargetKind> = new Set<TargetKind>(['star', 'deepsky', 'constellation'])

/** Garde de type : restreint une famille quelconque aux objets fixes. */
export const isFixedKind = (kind: TargetKind): kind is FixedKind => FIXED_KINDS.has(kind)

export interface SkyTarget {
  kind: TargetKind
  /** Identifiant stable, unique toutes familles confondues. */
  id: string
  name: string
  /** Complement de lecture : designation de Bayer, type d'objet, catalogue. */
  detail: string
  magnitude: number | null
  /**
   * Coordonnees equatoriales J2000, pour les objets fixes.
   * Les corps du systeme solaire et les satellites bougent : leur position est
   * calculee a la demande, donc nulle ici.
   */
  equatorialJ2000: Equatorial | null
  /** Indice dans le catalogue d'origine, pour retrouver la fiche complete. */
  catalogIndex?: number
}

/**
 * Repli du texte pour la comparaison : minuscules, sans accent ni ponctuation.
 * « Vénus », « venus » et « VENUS » doivent tomber sur la meme entree, et
 * « M 31 » sur « M31 ».
 */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    // `\p{M}` couvre toutes les marques combinantes : la decomposition NFD les
    // detache des lettres, il ne reste qu'a les retirer.
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function bodyTargets(): SkyTarget[] {
  return BODIES.map((b) => ({
    kind: 'body' as const,
    id: b.id,
    name: b.name,
    detail: b.id === 'sun' || b.id === 'moon' ? 'système solaire' : 'planète',
    magnitude: null,
    equatorialJ2000: null,
  }))
}

function starTargets(): SkyTarget[] {
  return NAMED_STARS.map((s) => ({
    kind: 'star' as const,
    id: `star-${s.index}`,
    name: s.name,
    detail: s.designation,
    magnitude: s.magnitude,
    equatorialJ2000: { ra: s.ra, dec: s.dec },
    catalogIndex: s.index,
  }))
}

function deepSkyTargets(): SkyTarget[] {
  return DEEP_SKY_INDEX.map((o) => ({
    kind: 'deepsky' as const,
    id: `dso-${o.index}`,
    name: o.messier > 0 ? `M${o.messier}` : o.id,
    detail: o.name ? `${o.typeLabel} · ${o.name}` : o.typeLabel,
    magnitude: Number.isFinite(o.magnitude) ? o.magnitude : null,
    equatorialJ2000: { ra: o.ra, dec: o.dec },
    catalogIndex: o.index,
  }))
}

function constellationTargets(): SkyTarget[] {
  return CONSTELLATIONS.map((c) => ({
    kind: 'constellation' as const,
    id: `const-${c.id}`,
    name: c.name,
    detail: 'constellation',
    magnitude: null,
    equatorialJ2000: { ra: c.labelRa, dec: c.labelDec },
  }))
}

/**
 * Coordonnees de catalogue d'un objet fixe, par famille et identifiant.
 *
 * Les identifiants sont ceux de l'index de recherche, donc aussi ceux du
 * pointage a la souris : un objet designe d'une facon se retrouve de l'autre.
 * Renvoie `null` pour les familles mobiles, dont la position se calcule.
 */
export function fixedEquatorialJ2000(kind: TargetKind, id: string): Equatorial | null {
  if (kind === 'star') {
    const star = NAMED_STARS.find((s) => `star-${s.index}` === id)
    return star ? { ra: star.ra, dec: star.dec } : null
  }
  if (kind === 'deepsky') {
    const o = DEEP_SKY_INDEX.find((x) => `dso-${x.index}` === id)
    return o ? { ra: o.ra, dec: o.dec } : null
  }
  if (kind === 'constellation') {
    const c = CONSTELLATIONS.find((x) => `const-${x.id}` === id)
    return c ? { ra: c.labelRa, dec: c.labelDec } : null
  }
  return null
}

/** Cible correspondant a un satellite defini ou recupere. */
export function satelliteTarget(el: OrbitalElements): SkyTarget {
  return {
    kind: 'satellite',
    id: el.id,
    name: el.name,
    detail: el.noradId ? `NORAD ${el.noradId}` : 'orbite saisie',
    magnitude: null,
    equatorialJ2000: null,
  }
}

interface IndexedTarget {
  target: SkyTarget
  /** Champs replies sur lesquels porte la comparaison. */
  keys: string[]
}

function indexTarget(target: SkyTarget): IndexedTarget {
  const keys = [foldText(target.name), foldText(target.detail)]
  // Un objet Messier se cherche aussi par son numero NGC, et inversement.
  if (target.kind === 'deepsky') {
    const o = DEEP_SKY_INDEX[target.catalogIndex ?? -1]
    if (o) {
      keys.push(foldText(o.id))
      if (o.messier > 0) keys.push(`m${o.messier}`)
      if (o.name) keys.push(foldText(o.name))
    }
  }
  return { target, keys: keys.filter((k) => k.length > 0) }
}

let staticIndex: IndexedTarget[] | null = null

/** Index des objets fixes du catalogue, construit une seule fois. */
function catalogIndex(): IndexedTarget[] {
  if (!staticIndex) {
    staticIndex = [...bodyTargets(), ...starTargets(), ...deepSkyTargets(), ...constellationTargets()].map(indexTarget)
  }
  return staticIndex
}


/**
 * Index des cibles mobiles, memorise sur l'identite du tableau recu.
 *
 * Le catalogue de satellites compte plusieurs milliers d'entrees et ne change
 * qu'au renouvellement des elements. Le reindexer a chaque frappe reviendrait a
 * replier quatre mille chaines par touche, pour un resultat identique.
 */
const extraIndexCache = new WeakMap<object, IndexedTarget[]>()

function indexExtra(extra: readonly SkyTarget[]): IndexedTarget[] {
  const cached = extraIndexCache.get(extra)
  if (cached) return cached
  const built = extra.map(indexTarget)
  extraIndexCache.set(extra, built)
  return built
}

/**
 * Qualite d'une correspondance, du meilleur au pire.
 * Une valeur negative signifie « pas de correspondance ».
 */
function matchRank(keys: string[], query: string): number {
  let best = -1
  for (const key of keys) {
    let rank = -1
    if (key === query) rank = 4
    else if (key.startsWith(query)) rank = 3
    else if (key.includes(` ${query}`)) rank = 2
    else if (key.includes(query)) rank = 1
    if (rank > best) best = rank
  }
  return best
}

/** Priorite de famille a correspondance egale : ce que l'observateur vise le plus souvent. */
const KIND_WEIGHT: Record<TargetKind, number> = {
  body: 0,
  satellite: 1,
  star: 2,
  deepsky: 3,
  constellation: 4,
}

export interface SearchOptions {
  /** Cibles mobiles a joindre a l'index : satellites definis et recuperes. */
  extra?: readonly SkyTarget[]
  limit?: number
}

/**
 * Recherche textuelle. Le classement suit d'abord la qualite de la
 * correspondance, puis la famille, puis l'eclat : a nom egal, l'objet le plus
 * brillant est celui qu'on cherchait.
 */
export function searchTargets(query: string, options: SearchOptions = {}): SkyTarget[] {
  const q = foldText(query)
  if (q.length === 0) return []

  const limit = options.limit ?? 12
  const entries = options.extra?.length
    ? [...catalogIndex(), ...indexExtra(options.extra)]
    : catalogIndex()

  const scored: Array<{ target: SkyTarget; rank: number }> = []
  for (const entry of entries) {
    const rank = matchRank(entry.keys, q)
    if (rank >= 0) scored.push({ target: entry.target, rank })
  }

  scored.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank
    const kind = KIND_WEIGHT[a.target.kind] - KIND_WEIGHT[b.target.kind]
    if (kind !== 0) return kind
    const ma = a.target.magnitude ?? 99
    const mb = b.target.magnitude ?? 99
    if (ma !== mb) return ma - mb
    return a.target.name.localeCompare(b.target.name, 'fr')
  })

  return scored.slice(0, limit).map((s) => s.target)
}
