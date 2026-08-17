/**
 * Diffusion atmospherique reelle — Rayleigh (air) + Mie (aerosols), simple
 * diffusion, integree le long du rayon de visee et du rayon secondaire vers
 * le Soleil.
 *
 * Portage quasi litteral de `glsl-atmosphere` de Rye Terrell (wwwtyro),
 * domaine public (Unlicense) : https://github.com/wwwtyro/glsl-atmosphere
 * — lui-meme une implementation temps reel du modele de Sean O'Neil
 * (*Accurate Atmospheric Scattering*, GPU Gems 2, 2004). Seule differences
 * avec l'original : les coefficients de diffusion et les hauteurs d'echelle
 * sont passes en uniforms plutot qu'en constantes, pour pouvoir les piloter
 * plus tard depuis des donnees reelles (qualite de l'air, nebulosite).
 *
 * Ce n'est pas le modele a diffusion multiple de Bruneton (celui de
 * CesiumJS) : la simple diffusion ne restitue pas les degrades les plus
 * subtils du crepuscule (l'arche bleue, la ceinture de Venus). Elle capture
 * en revanche exactement ce qui manquait ici — la vraie forme et la vraie
 * couleur du halo solaire, integrees depuis la geometrie Terre-atmosphere,
 * plutot qu'un degrade peint a la main autour de l'azimut du Soleil.
 */

/** Rayon terrestre moyen, en metres — coherent avec `EARTH_RADIUS_KM` de `astro/coords.ts`. */
export const PLANET_RADIUS_M = 6_371_000
/**
 * Epaisseur de l'atmosphere retenue, en metres.
 *
 * Cent kilometres : la ligne de Karman, limite conventionnelle de
 * l'atmosphere sensible. Au-dela, la densite moleculaire est negligeable ;
 * en-deca, elle decroit en exponentielle (voir les hauteurs d'echelle) — la
 * quasi-totalite de la diffusion se joue dans les dix premiers kilometres.
 */
export const ATMOSPHERE_HEIGHT_M = 100_000
export const ATMOSPHERE_RADIUS_M = PLANET_RADIUS_M + ATMOSPHERE_HEIGHT_M

/**
 * Coefficients de diffusion Rayleigh (par metre), un par canal RGB.
 *
 * La diffusion Rayleigh croit en 1/λ⁴ : le bleu diffuse bien plus que le
 * rouge, d'ou le ciel bleu de jour et le Soleil rougi au crepuscule, quand
 * son trajet dans l'atmosphere s'allonge et que le bleu est diffuse hors de
 * la ligne de visee avant d'atteindre l'oeil. Valeurs standard pour l'air sec
 * au niveau de la mer.
 */
export const RAYLEIGH_COEFFICIENTS: [number, number, number] = [5.5e-6, 13.0e-6, 22.4e-6]
/** Hauteur d'echelle de la diffusion Rayleigh : l'air moleculaire s'eclaircit vite avec l'altitude. */
export const RAYLEIGH_SCALE_HEIGHT_M = 8_000

/**
 * Coefficient de diffusion Mie — aerosols (poussiere, humidite, pollution).
 *
 * C'est le levier naturel pour la qualite de l'air : plus d'aerosols, plus ce
 * coefficient (et sa hauteur d'echelle) montent, et plus l'horizon blanchit —
 * exactement l'effet d'une brume de pollution ou d'une atmosphere humide.
 */
export const MIE_COEFFICIENT = 21e-6
/** Hauteur d'echelle Mie : les aerosols restent bas, concentres pres du sol. */
export const MIE_SCALE_HEIGHT_M = 1_200
/** Asymetrie de la diffusion Mie (Henyey-Greenstein) : proche de 1, tres dirigee vers l'avant — le halo serre autour du Soleil. */
export const MIE_G = 0.758

/**
 * Intensite de reference du Soleil dans le modele.
 *
 * Une constante de calibrage du modele, pas une grandeur physique en lux :
 * c'est elle, combinee aux coefficients ci-dessus et au tone mapping du
 * materiau, qui donne au ciel de midi son exposition correcte. L'eclat reel
 * (heure, eclipse) module l'exposition d'affichage, pas cette constante.
 */
export const SUN_INTENSITY_REF = 22

/**
 * Fonctions GLSL de diffusion, a inserer telles quelles dans un nuanceur de
 * fragment. `atmosphere()` prend la direction de visee, la position de
 * l'observateur (repere centre sur la planete), la direction du Soleil, et
 * les parametres physiques ci-dessus ; elle renvoie une radiance — a passer
 * dans un tone mapping avant affichage, les valeurs depassant largement 1.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
  vec2 atmosphereRsi(vec3 r0, vec3 rd, float sr) {
    // Intersection rayon-sphere, sphere centree a l'origine.
    // Pas d'intersection si le resultat.x > resultat.y.
    float a = dot(rd, rd);
    float b = 2.0 * dot(rd, r0);
    float c = dot(r0, r0) - (sr * sr);
    float d = (b * b) - 4.0 * a * c;
    if (d < 0.0) return vec2(1e5, -1e5);
    return vec2((-b - sqrt(d)) / (2.0 * a), (-b + sqrt(d)) / (2.0 * a));
  }

  vec3 atmosphere(
    vec3 r, vec3 r0, vec3 pSun, float iSun,
    float rPlanet, float rAtmos,
    vec3 kRlh, float kMie, float shRlh, float shMie, float g
  ) {
    const int iSteps = 16;
    const int jSteps = 8;

    pSun = normalize(pSun);
    r = normalize(r);

    vec2 p = atmosphereRsi(r0, r, rAtmos);
    if (p.x > p.y) return vec3(0.0);
    p.y = min(p.y, atmosphereRsi(r0, r, rPlanet).x);
    float iStepSize = (p.y - p.x) / float(iSteps);

    float iTime = 0.0;
    vec3 totalRlh = vec3(0.0);
    vec3 totalMie = vec3(0.0);
    float iOdRlh = 0.0;
    float iOdMie = 0.0;

    float mu = dot(r, pSun);
    float mumu = mu * mu;
    float gg = g * g;
    float pRlh = 3.0 / (16.0 * 3.141592) * (1.0 + mumu);
    float pMie = 3.0 / (8.0 * 3.141592) * ((1.0 - gg) * (mumu + 1.0)) / (pow(1.0 + gg - 2.0 * mu * g, 1.5) * (2.0 + gg));

    for (int i = 0; i < iSteps; i++) {
      vec3 iPos = r0 + r * (iTime + iStepSize * 0.5);
      float iHeight = length(iPos) - rPlanet;

      float odStepRlh = exp(-iHeight / shRlh) * iStepSize;
      float odStepMie = exp(-iHeight / shMie) * iStepSize;
      iOdRlh += odStepRlh;
      iOdMie += odStepMie;

      float jStepSize = atmosphereRsi(iPos, pSun, rAtmos).y / float(jSteps);
      float jTime = 0.0;
      float jOdRlh = 0.0;
      float jOdMie = 0.0;

      for (int j = 0; j < jSteps; j++) {
        vec3 jPos = iPos + pSun * (jTime + jStepSize * 0.5);
        float jHeight = length(jPos) - rPlanet;
        jOdRlh += exp(-jHeight / shRlh) * jStepSize;
        jOdMie += exp(-jHeight / shMie) * jStepSize;
        jTime += jStepSize;
      }

      vec3 attn = exp(-(kMie * (iOdMie + jOdMie) + kRlh * (iOdRlh + jOdRlh)));
      totalRlh += odStepRlh * attn;
      totalMie += odStepMie * attn;
      iTime += iStepSize;
    }

    return iSun * (pRlh * kRlh * totalRlh + pMie * kMie * totalMie);
  }
`
