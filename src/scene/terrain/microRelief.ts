/**
 * Micro-relief du sol — une texture de normales, assumee artificielle.
 *
 * ## ⚠️ Ce que ce module est, et n'est pas
 *
 * **Le motif est invente.** Il ne decrit aucun terrain reel, et aucune bosse
 * qu'il produit n'existe. C'est une texture procedurale, au meme titre que le
 * relief simule de la Lune, et elle est ici pour une raison d'eclairage : sans
 * elle, une plaine lointaine rend un **aplat de lumiere** uniforme sur des
 * centaines de pixels, parce que sa normale y est rigoureusement constante.
 *
 * Ce qui n'est pas invente, c'est son **amplitude**. Pente efficace mesuree sur
 * des tuiles RGE ALTI a 3,4 metres :
 *
 * | site | pente efficace |
 * | --- | --- |
 * | Beauce, plaine cerealiere | 0,012 — 0,7° |
 * | Camargue, delta | 0,017 — 1,0° |
 * | Landes, plaine boisee | 0,017 — 1,0° |
 * | Vallee du Rhone | 0,087 — 5,0° |
 * | Mont Ventoux | 0,291 — 16,2° |
 *
 * Une plaine francaise vit donc entre un et cinq degres de pente efficace. La
 * valeur retenue tombe dans cet intervalle : le motif est faux, son ampleur est
 * plausible.
 *
 * ⚠️ Elle reste un **choix**, pas une deduction. Voir le registre.
 *
 * ## Le hachage, et pourquoi pas un sinus d'une somme
 *
 * ⚠️ `sin(127.1·x + 311.7·y)` est le hachage qu'on ecrit d'instinct, et il est
 * **correle le long des diagonales** : tous les points d'une droite
 * `127.1·x + 311.7·y = constante` recoivent la meme valeur. La premiere version
 * l'utilisait, et le sol se couvrait de hachures obliques bien visibles.
 *
 * ⚠️ La deuxieme n'etait pas meilleure. Un hachage concu pour des flottants
 * quelconques — melange des composantes puis repliement — se comporte mal sur
 * une **grille d'entiers** : les valeurs y prennent un ensemble restreint et la
 * structure revient. Mesure sur quarante mille noeuds : moyenne 0,374 au lieu
 * d'un demi, et correlation de **0,336** vers le nord.
 *
 * Le retenu est celui d'Inigo Quilez pour les treillis entiers, qui replie
 * chaque coordonnee separement avant de les multiplier. Mesure :
 *
 * | hachage | moyenne | pire correlation |
 * | --- | --- | --- |
 * | melange puis repliement | 0,374 | 0,336 |
 * | sinus d'une somme | 0,501 | 0,013 |
 * | **treillis entier** | **0,502** | **0,005** |
 *
 * ## La pente ne depend pas de l'echelle, et c'est ce qui rend l'extrapolation licite
 *
 * Sur la meme tuile du Ventoux, la pente efficace vaut 0,295 a 3,4 metres
 * d'ecart, 0,294 a 6,9, 0,290 a 13,7 et 0,285 a 27,4 : un exposant de Hurst de
 * **0,980**, soit une pente invariante d'echelle sur un facteur huit. Prolonger
 * la statistique sous la resolution du modele numerique n'invente donc pas une
 * loi — c'est la seule que la mesure autorise.
 *
 * ## La frequence suit le pixel, et c'est le point
 *
 * ⚠️ **Une texture a echelle fixe ne peut pas marcher ici.** Le terrain couvre
 * trois decades de distance : a cinquante metres une maille de dix metres est
 * enorme, a cent kilometres elle tombe sous le pixel et ne produit plus que du
 * crenelage.
 *
 * La maille du bruit suit donc l'**empreinte du pixel au sol**, lue par les
 * derivees d'ecran. Elle reste ainsi visible partout et ne crenele nulle part —
 * et c'est loin qu'elle sert le plus, la ou un pixel couvre justement les
 * quelques metres ou la rugosite a ete mesuree.
 *
 * ⚠️ **Mais la maille ne peut pas suivre l'empreinte continument.** La premiere
 * version le faisait, et le motif **nageait** : son echelle changeant avec la
 * distance, il se deformait des que la camera bougeait, comme une salissure
 * collee a l'ecran plutot qu'une texture posee sur le sol.
 *
 * Les echelles sont donc **quantifiees en octaves**, comme les niveaux d'un
 * mipmap : le motif est ancre dans le monde a un jeu discret de tailles, et l'on
 * ne fait que fondre d'une octave a la suivante. C'est le fondu qui bouge, plus
 * le motif.
 *
 * ## Normales seulement
 *
 * Aucun deplacement. La ligne d'horizon vient d'etre reparee ; une texture qui
 * souleverait la geometrie la casserait a nouveau.
 */

/**
 * Pente efficace donnee au micro-relief.
 *
 * ⚠️ **Choisie**, dans l'intervalle mesure des plaines francaises — 0,012 en
 * Beauce, 0,087 dans la vallee du Rhone. Assez pour que la lumiere cesse d'etre
 * uniforme, assez peu pour qu'une plaine ne devienne pas un eboulis.
 */
export const MICRO_SLOPE_RMS = 0.06

/**
 * Nombre de mailles du bruit dans une empreinte de pixel.
 *
 * Quatre : en dessous, le motif approche la frequence de Nyquist de l'ecran et
 * scintille des que la camera bouge ; au-dessus, il devient si lisse qu'il ne
 * casse plus rien.
 */
export const MICRO_CELLS_PER_FOOTPRINT = 4

/**
 * Ecart-type du gradient du bruit a deux octaves, mesure numeriquement.
 *
 * Il sert a **normaliser** : sans lui, `MICRO_SLOPE_RMS` ne serait pas une pente
 * mais un coefficient sans signification. Sa valeur est relevee par la
 * validation sur un million de points, avec la meme fonction que le nuanceur.
 */
export const MICRO_GRADIENT_RMS = 0.5493

/**
 * Bruit de valeur bidimensionnel et son gradient analytique.
 *
 * Miroir exact de la fonction GLSL ci-dessous. Il existe pour que la
 * normalisation et l'amplitude soient **mesurables hors du navigateur** : un
 * nuanceur ne se valide pas, une fonction pure si.
 */
export function microNoise(x: number, y: number): { value: number; dx: number; dy: number } {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const dux = 6 * fx * (1 - fx)
  const duy = 6 * fy * (1 - fy)
  const a = microHash(ix, iy)
  const b = microHash(ix + 1, iy)
  const c = microHash(ix, iy + 1)
  const d = microHash(ix + 1, iy + 1)
  const k1 = b - a
  const k2 = c - a
  const k3 = a - b - c + d
  return {
    value: a + k1 * ux + k2 * uy + k3 * ux * uy,
    dx: dux * (k1 + k3 * uy),
    dy: duy * (k2 + k3 * ux),
  }
}

/** Gradient du bruit a deux octaves, la seconde a demi-amplitude. */
export function microGradient(x: number, y: number): { dx: number; dy: number } {
  const a = microNoise(x, y)
  const b = microNoise(x * 2.03, y * 2.03)
  return { dx: a.dx + 0.5 * b.dx * 2.03, dy: a.dy + 0.5 * b.dy * 2.03 }
}

const fract = (v: number) => v - Math.floor(v)

/**
 * Valeur pseudo-aleatoire d'un noeud de la grille, dans [0, 1[.
 *
 * ⚠️ Ni un sinus d'une combinaison lineaire — constant le long d'une famille de
 * droites — ni un hachage a melange de composantes, qui se degrade sur une
 * grille d'entiers. Celui-ci replie chaque coordonnee separement avant de les
 * multiplier, ce qui tient sur un treillis. Voir l'en-tete pour les mesures.
 */
export function microHash(ix: number, iy: number): number {
  const x = 50 * fract(ix * 0.3183099 + 0.71)
  const y = 50 * fract(iy * 0.3183099 + 0.113)
  return fract(x * y * (x + y))
}

/**
 * Perturbation de normale, a inclure dans un nuanceur de fragment.
 *
 * Attend `vRange` et `vView` — la distance et la direction de visee — et rend
 * une normale perturbee. Le repere est celui de la scene : `+X` est, `+Y`
 * zenith, `−Z` nord.
 */
/**
 * Ecrit un nombre comme litteral flottant GLSL.
 *
 * ⚠️ **Sans cela le nuanceur casse en silence.** JavaScript rend `0.0` comme
 * `"0"`, et GLSL refuse d'affecter un entier a un `float` : le fragment ne
 * compile plus, et le terrain disparait. Le defaut n'apparait que pour les
 * valeurs entieres — donc jamais pendant qu'on regle, toujours quand on met la
 * constante a zero pour comparer.
 */
const glslFloat = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v))

export const MICRO_RELIEF_GLSL = /* glsl */ `
  const float MICRO_SLOPE_RMS = ${glslFloat(MICRO_SLOPE_RMS)};
  const float MICRO_CELLS_PER_FOOTPRINT = ${glslFloat(MICRO_CELLS_PER_FOOTPRINT)};
  const float MICRO_GRADIENT_RMS = ${glslFloat(MICRO_GRADIENT_RMS)};

  // ⚠️ Ni un sinus d'une somme — constant le long d'une famille de droites, il
  // couvre le sol de hachures obliques — ni un hachage a melange de
  // composantes, qui se degrade sur une grille d'entiers. Celui-ci replie
  // chaque coordonnee separement : correlation mesuree a 0,005.
  float microHash(vec2 i) {
    vec2 p = 50.0 * fract(i * 0.3183099 + vec2(0.71, 0.113));
    return fract(p.x * p.y * (p.x + p.y));
  }

  // Bruit de valeur et gradient analytique — le gradient est ce qu'on cherche,
  // la valeur ne sert qu'a le construire.
  vec3 microNoised(vec2 x) {
    vec2 i = floor(x);
    vec2 f = fract(x);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 du = 6.0 * f * (1.0 - f);
    float a = microHash(i);
    float b = microHash(i + vec2(1.0, 0.0));
    float c = microHash(i + vec2(0.0, 1.0));
    float d = microHash(i + vec2(1.0, 1.0));
    float k1 = b - a;
    float k2 = c - a;
    float k3 = a - b - c + d;
    return vec3(
      a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
      du.x * (k1 + k3 * u.y),
      du.y * (k2 + k3 * u.x)
    );
  }

  /** Gradient a deux octaves, pour une taille de maille donnee. */
  vec2 microGradientAt(vec2 ground, float cellM) {
    vec2 q = ground / cellM;
    vec3 n1 = microNoised(q);
    vec3 n2 = microNoised(q * 2.03);
    return n1.yz + 0.5 * n2.yz * 2.03;
  }

  /**
   * Ajoute le micro-relief a une normale de terrain.
   *
   * ⚠️ Le motif est invente ; seule son amplitude est ancree sur une mesure.
   */
  vec3 microRelief(vec3 N, vec3 dir, float rangeM) {
    // Position au sol, reconstruite comme partout ailleurs dans ce nuanceur.
    vec2 ground = vec2(rangeM * dir.x, -rangeM * dir.z);

    // Empreinte du pixel au sol. On prend la plus grande des deux derivees :
    // en visee rasante l'empreinte est tres allongee, et se caler sur la petite
    // ferait creneler dans l'autre direction.
    vec2 fw = fwidth(ground);
    float footprintM = max(max(fw.x, fw.y), 1e-3);

    // ⚠️ **Echelles quantifiees en octaves.** Une maille qui suivrait l'empreinte
    // continument ferait nager le motif : son echelle changeant avec la
    // distance, il se deformerait a chaque mouvement de camera. Ancre a des
    // tailles discretes, il ne fait plus que se fondre d'une octave a l'autre.
    float lod = log2(footprintM * MICRO_CELLS_PER_FOOTPRINT);
    float base = floor(lod);
    float blend = lod - base;
    vec2 gLo = microGradientAt(ground, exp2(base));
    vec2 gHi = microGradientAt(ground, exp2(base + 1.0));
    vec2 gradient = mix(gLo, gHi, blend);

    // La normale d'un champ de hauteur est (−dh/de, 1, dh/dn) : on passe donc
    // par les pentes plutot que de tourner la normale a l'aveugle, ce qui
    // garderait mal l'orientation pres de l'horizontale.
    vec2 slope = vec2(-N.x, N.z) / max(N.y, 1e-3);
    slope += gradient * (MICRO_SLOPE_RMS / MICRO_GRADIENT_RMS);
    return normalize(vec3(-slope.x, 1.0, slope.y));
  }
`
