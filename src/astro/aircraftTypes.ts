/**
 * Geometrie des types d'appareils — envergure et position des reacteurs.
 *
 * L'ADS-B donne le designateur de type OACI (`A388`, `B738`…) et une categorie
 * d'emission (`A3`, `A5`…). La categorie est une classe de **masse** : un
 * A330 et un 747 sont tous deux « A5 ». Elle ne dit ni le nombre de
 * reacteurs, ni l'envergure. D'ou cette table, indexee par le designateur, et
 * la categorie seulement en repli.
 *
 * Ce qu'elle sert : le nombre et l'ecartement des panaches d'une trainee, et
 * l'ecartement des tourbillons de bout d'aile qui les enroulent — un
 * quadrireacteur trace quatre trainees, puis deux, puis une. Elle portera aussi
 * la famille de modele 3D.
 *
 * Positions des reacteurs : distance a l'axe du fuselage, en metres, lues sur
 * les plans publies par les constructeurs — a quelques dizaines de centimetres
 * pres, ce qui est sans effet sur une trainee de cent metres de large.
 */

export interface AircraftLayout {
  /** Envergure, m. */
  spanM: number
  /** Position laterale de chaque reacteur, m ; negative a gauche. */
  enginesYM: readonly number[]
}

const twin = (spanM: number, y: number): AircraftLayout => ({ spanM, enginesYM: [-y, y] })
const quad = (spanM: number, inner: number, outer: number): AircraftLayout => ({
  spanM,
  enginesYM: [-outer, -inner, inner, outer],
})
const trijet = (spanM: number, y: number): AircraftLayout => ({ spanM, enginesYM: [-y, 0, y] })

const TABLE: Record<string, AircraftLayout> = {}
const add = (codes: string, layout: AircraftLayout) => {
  for (const code of codes.split(' ')) TABLE[code] = layout
}

// --- Quadrireacteurs -------------------------------------------------------
add('A388', quad(79.8, 14.5, 25.5))
add('B741 B742 B743 B744 B74S', quad(64.4, 12, 21))
add('B748', quad(68.4, 12.5, 22))
add('A342 A343', quad(60.3, 10.7, 19.5))
add('A345 A346', quad(63.5, 11.3, 20.3))
add('A124', quad(73.3, 13, 23))
add('A400', quad(42.4, 7.2, 13.5))
add('C17', quad(51.8, 9.5, 16.5))
add('B461 B462 B463 RJ70 RJ85 RJ1H', quad(26.3, 4, 6.8))

// --- Trireacteurs ----------------------------------------------------------
add('MD11 DC10', trijet(51.7, 10.4))
add('F900 FA7X FA8X', trijet(26, 2))

// --- Biréacteurs gros-porteurs --------------------------------------------
add('A332 A333', twin(60.3, 9.4))
add('A338 A339', twin(64, 9.4))
add('A359 A35K', twin(64.8, 9.9))
add('B772 B77L B77W B778 B779 B77F', twin(64.8, 9.7))
add('B788 B789 B78X', twin(60.1, 9.5))
add('B762 B763 B764', twin(50, 7.8))
add('A306 A30B A310', twin(44.8, 7.9))

// --- Biréacteurs monocouloirs ----------------------------------------------
add('A318 A319 A320 A321 A19N A20N A21N', twin(35, 5.75))
add('B731 B732 B733 B734 B735 B736 B737 B738 B739 B37M B38M B39M B3XM', twin(35, 4.95))
add('BCS1 BCS3', twin(35.1, 5.2))
add('B752 B753', twin(38, 6.6))
add('E170 E175 E75L E75S E190 E195 E290 E295', twin(28.7, 4.4))
add('MD81 MD82 MD83 MD87 MD88 MD90 B712', twin(32.9, 2.6))
add('CRJ2 CRJ7 CRJ9 CRJX', twin(24.9, 2.3))
add('SU95', twin(27.8, 4.3))

// --- Turbopropulseurs ------------------------------------------------------
add('AT43 AT45 AT72 AT75 AT76', twin(27.1, 4.1))
add('DH8A DH8B DH8C DH8D', twin(28.4, 4.1))

// --- Aviation d'affaires ---------------------------------------------------
add('GLF4 GLF5 GLF6 GL5T GL7T GLEX', twin(30, 2.3))
add('C56X C68A C700 CL30 CL35 CL60 E55P E545 LJ45 LJ75 F2TH FA50 C25A C25B C525 PC24', twin(20, 1.8))

/** Repli par categorie d'emission ADS-B : la silhouette la plus probable a cette masse. */
const BY_CATEGORY: Record<string, AircraftLayout> = {
  A1: { spanM: 11, enginesYM: [0] },
  A2: twin(20, 1.8),
  A3: twin(35, 5.5),
  A4: twin(38, 6.6),
  A5: twin(62, 9.6),
  A6: twin(12, 1),
}

/** Faute de tout : un monocouloir, le cas le plus frequent du ciel. */
export const DEFAULT_LAYOUT: AircraftLayout = twin(35, 5.5)

export function aircraftLayout(typeCode: string | null, category: string | null): AircraftLayout {
  return (typeCode && TABLE[typeCode.toUpperCase()]) || (category && BY_CATEGORY[category]) || DEFAULT_LAYOUT
}

/**
 * Ecartement des tourbillons de bout d'aile, m : `b₀ = (π/4)·envergure` pour
 * une portance a repartition elliptique. C'est entre eux que les panaches se
 * retrouvent enroules.
 */
export const vortexSpacingM = (layout: AircraftLayout): number => (Math.PI / 4) * layout.spanM
