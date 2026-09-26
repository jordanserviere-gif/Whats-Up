/**
 * Phrases du loader. Aucune ne decrit ce qui se passe vraiment — les etapes
 * reelles sont affichees a part — : elles occupent l'attente.
 */
export const LOADER_PHRASES: readonly string[] = [
  'Acquisition des satellites…',
  'Randonnée vers le point d’intérêt…',
  'Nettoyage des jumelles…',
  'Réception d’un signal mystérieux…',
  'Recrutement des contrôleurs aériens…',
  'Dépoussiérage de la Voie lactée…',
  'Négociation avec les nuages…',
  'Réglage de la mise au point…',
  'Extinction des lampadaires du quartier…',
  'Alignement de l’étoile polaire…',
  'Préparation du thermos de café…',
  'Décompte des étoiles filantes…',
  'Calibrage du télescope…',
  'Consultation des éphémérides…',
  'Adaptation de l’œil à l’obscurité…',
  'Démêlage des constellations…',
]

/** Les phrases, dans un ordre neuf a chaque ouverture du loader. */
export function shuffledPhrases(): string[] {
  const out = [...LOADER_PHRASES]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
