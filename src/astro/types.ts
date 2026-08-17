/** Types partages par toute la couche astronomique. */

export interface GeoLocation {
  /** Latitude geodesique en degres, positive vers le nord. */
  latitude: number
  /** Longitude en degres, positive vers l'est. */
  longitude: number
  /** Altitude au-dessus du niveau de la mer, en metres. */
  elevation: number
  name: string
}

/** Coordonnees equatoriales. */
export interface Equatorial {
  /** Ascension droite en degres [0, 360). */
  ra: number
  /** Declinaison en degres [-90, 90]. */
  dec: number
}

/** Coordonnees horizontales locales. */
export interface Horizontal {
  /** Azimut en degres, 0 = nord, 90 = est. */
  azimuth: number
  /** Hauteur en degres au-dessus de l'horizon. */
  altitude: number
}

export type BodyId =
  | 'sun'
  | 'moon'
  | 'mercury'
  | 'venus'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune'
  | 'pluto'

/** Etat complet d'un corps a un instant et pour un lieu donnes. */
export interface BodyState {
  id: BodyId
  name: string
  equatorial: Equatorial
  horizontal: Horizontal
  /**
   * Position topocentrique en km, dans le repere equatorial de la date.
   * C'est elle qui porte la geometrie 3D reelle : distances, occultations,
   * direction d'eclairement.
   */
  positionEq: [number, number, number]
  /** Vecteur unitaire du corps vers le Soleil, meme repere. Oriente la phase. */
  sunDirectionEq: [number, number, number]
  /** Rayon physique du corps, en km. */
  radiusKm: number
  /** Magnitude visuelle apparente. */
  magnitude: number
  /** Distance a l'observateur en unites astronomiques. */
  distanceAu: number
  /** Distance a l'observateur en km. */
  distanceKm: number
  /** Diametre apparent en degres. */
  angularDiameter: number
  /** Fraction du disque eclairee, 0 a 1. */
  illumination: number
  /** Elongation par rapport au Soleil, en degres. */
  elongation: number
  /** Angle du limbe eclaire par rapport au zenith, en degres (phase). */
  brightLimbAngle: number
  /** Vrai si le corps est au-dessus de l'horizon geometrique. */
  visible: boolean
}

/** Evenements de lever, culmination et coucher pour une journee. */
export interface RiseSetInfo {
  rise: Date | null
  transit: Date | null
  set: Date | null
  /** Hauteur au passage au meridien, en degres. */
  transitAltitude: number | null
  /** Le corps ne se couche jamais / ne se leve jamais sur la periode. */
  circumpolar: boolean
  alwaysBelow: boolean
}

/**
 * Elements orbitaux au format OMM (norme CCSDS), tels que CelesTrak les publie.
 *
 * Les noms de champs sont repris tels quels : `json2satrec` de satellite.js les
 * attend sous cette forme exacte. Les publier ici plutot que dans la couche
 * reseau garde la dependance dans le bon sens — les sources de donnees
 * connaissent le domaine astronomique, l'inverse serait une inversion de couches.
 */
export interface GpElements {
  OBJECT_NAME: string
  OBJECT_ID: string
  EPOCH: string
  MEAN_MOTION: number
  ECCENTRICITY: number
  INCLINATION: number
  RA_OF_ASC_NODE: number
  ARG_OF_PERICENTER: number
  MEAN_ANOMALY: number
  NORAD_CAT_ID: number
  ELEMENT_SET_NO: number
  BSTAR: number
  MEAN_MOTION_DOT: number
  MEAN_MOTION_DDOT: number
  EPHEMERIS_TYPE?: number
  CLASSIFICATION_TYPE?: string
  REV_AT_EPOCH?: number
}

/** Provenance d'un jeu d'elements : saisie manuelle ou catalogue public. */
export type ElementSource = 'manuel' | 'celestrak'

/** Elements orbitaux keplerians classiques d'un satellite terrestre. */
export interface OrbitalElements {
  id: string
  name: string
  /** Demi-grand axe en km. */
  semiMajorAxisKm: number
  /** Excentricite, 0 a < 1. */
  eccentricity: number
  /** Inclinaison en degres. */
  inclination: number
  /** Longitude du noeud ascendant (RAAN) en degres. */
  raan: number
  /** Argument du perigee en degres. */
  argPerigee: number
  /** Anomalie moyenne a l'epoque, en degres. */
  meanAnomaly: number
  /** Instant de reference des elements (ISO). */
  epoch: string
  /** Prise en compte de l'aplatissement terrestre (derives seculaires J2). */
  useJ2: boolean
  /** Couleur d'affichage de la trace. */
  color: string
  /** Provenance des elements. Absent = saisie manuelle, par retrocompatibilite. */
  source?: ElementSource
  /**
   * Enregistrement OMM d'origine. Quand il est present, la propagation passe par
   * SGP4 plutot que par le modele keplerien : c'est la seule facon de retrouver
   * un satellite reel au bon endroit, la trainee atmospherique n'ayant pas de
   * place dans des elements osculateurs.
   */
  gp?: GpElements
  /** Identifiant NORAD, stable dans le temps. */
  noradId?: number
  /** Age des elements a la recuperation, en jours. Au-dela de trois, ils derivent. */
  epochAgeDays?: number
}

/** Position instantanee d'un satellite. */
export interface SatelliteState {
  /** Position geocentrique inertielle (ECI de la date), en km. */
  positionEci: [number, number, number]
  /** Vitesse inertielle en km/s. */
  velocityEci: [number, number, number]
  horizontal: Horizontal
  /** Distance observateur → satellite, en km. */
  rangeKm: number
  /** Vitesse radiale relative a l'observateur, en km/s. */
  rangeRateKm: number
  /** Altitude au-dessus de l'ellipsoide, en km. */
  altitudeKm: number
  /** Trace au sol. */
  latitude: number
  longitude: number
  /** Le satellite est-il eclaire par le Soleil (hors ombre terrestre) ? */
  sunlit: boolean
  /** Magnitude visuelle estimee (null si non observable). */
  magnitude: number | null
  time: Date
}

/** Un point echantillonne de la trace dans le ciel. */
export interface TrackPoint {
  time: Date
  azimuth: number
  altitude: number
  sunlit: boolean
  rangeKm: number
}

/** Passage au-dessus de l'horizon. */
export interface SatellitePass {
  start: Date
  peak: Date
  end: Date
  peakAltitude: number
  startAzimuth: number
  endAzimuth: number
  /** Le passage comporte au moins un instant ou le satellite est eclaire et le ciel sombre. */
  visible: boolean
  maxMagnitude: number | null
}
