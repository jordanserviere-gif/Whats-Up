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
import { Vector3 } from 'three'

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
 * Longueur de trajet signifiant « jusqu'au bout de l'atmosphere » — plus grande
 * que toute traversee possible (le trajet le plus long, rasant, fait environ
 * 1 100 km), donc sans effet sur le bornage.
 */
export const ATMOSPHERE_PATH_FULL = 1e9

/**
 * Fonctions GLSL de diffusion, a inserer telles quelles dans un nuanceur de
 * fragment. `atmosphereScatter()` prend la direction de visee, la position de
 * l'observateur (repere centre sur la planete), la direction du Soleil, et
 * les parametres physiques ci-dessus ; elle renvoie une radiance — a passer
 * dans un tone mapping avant affichage, les valeurs depassant largement 1.
 *
 * Elle rend aussi, par `transmittance`, la fraction de lumiere survivant au
 * trajet. C'est la seconde moitie de l'equation du transfert radiatif :
 * `vu = objet × transmittance + diffuse`. La diffusion seule ne suffit pas —
 * ajoutee sans retirer ce qu'elle prend, elle ne fait qu'eclaircir un astre
 * qui devrait au contraire s'affaiblir et rougir en descendant sur l'horizon.
 * La grandeur ne coute rien : la boucle accumulait deja la profondeur optique
 * du rayon primaire pour attenuer sa propre diffusion, elle la jetait.
 *
 * `maxPath` borne le trajet, en metres, pour les objets *dans* l'atmosphere :
 * un avion a trente kilometres n'en traverse qu'une fraction. Passer
 * `ATMOSPHERE_PATH_FULL` pour tout ce qui est au-dela (astres, fond de ciel).
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

  vec3 atmosphereScatter(
    vec3 r, vec3 r0, vec3 pSun, float iSun,
    float rPlanet, float rAtmos,
    vec3 kRlh, float kMie, float shRlh, float shMie, float g,
    float maxPath, out vec3 transmittance
  ) {
    const int iSteps = 16;
    const int jSteps = 8;

    pSun = normalize(pSun);
    r = normalize(r);

    // Rien a traverser : l'objet est vu sans aucune atmosphere devant lui.
    transmittance = vec3(1.0);

    vec2 p = atmosphereRsi(r0, r, rAtmos);
    if (p.x > p.y) return vec3(0.0);
    p.y = min(p.y, atmosphereRsi(r0, r, rPlanet).x);
    // p.y - p.x est la corde traversant la couche atmospherique ; la marche
    // part de l'observateur (iTime = 0), qui est a l'origine du trajet.
    float iStepSize = min(p.y - p.x, maxPath) / float(iSteps);

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

      // Extinction deja accumulee a l'entree du pas, et celle que le pas ajoute.
      // Les deux servent a integrer la transmittance analytiquement plus bas.
      vec3 tauBefore = kRlh * iOdRlh + kMie * iOdMie;
      vec3 dTau = kRlh * odStepRlh + kMie * odStepMie;

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

      // Transmittance du trajet Soleil -> echantillon : constante sur le pas.
      vec3 attnSun = exp(-(kMie * jOdMie + kRlh * jOdRlh));

      // Transmittance du trajet echantillon -> observateur, integree
      // analytiquement sur toute la longueur du pas au lieu d'etre evaluee en
      // un point. A l'horizon, la corde fait onze cents kilometres pour seize
      // pas : des le premier, l'epaisseur optique d'un ciel charge depasse 8,
      // et l'evaluer ponctuellement ecrasait la contribution d'un facteur mille
      // — c'est ce qui noircissait l'horizon au lieu de le blanchir. La forme
      // (1 - e^-dTau) / dTau vaut 1 quand le pas est optiquement mince : le
      // resultat est donc inchange pour une atmosphere claire.
      vec3 stepTransmittance = exp(-tauBefore) * (1.0 - exp(-dTau)) / max(dTau, vec3(1e-7));

      vec3 attn = attnSun * stepTransmittance;
      totalRlh += odStepRlh * attn;
      totalMie += odStepMie * attn;
      iTime += iStepSize;
    }

    // Profondeur optique du seul rayon primaire, accumulee ci-dessus : c'est
    // exactement ce que l'observateur perd entre lui et le bout du trajet.
    transmittance = exp(-(kMie * iOdMie + kRlh * iOdRlh));

    return iSun * (pRlh * kRlh * totalRlh + pMie * kMie * totalMie);
  }

  /** Diffusion seule, sur toute la traversee — pour qui n'a que faire de l'extinction. */
  vec3 atmosphere(
    vec3 r, vec3 r0, vec3 pSun, float iSun,
    float rPlanet, float rAtmos,
    vec3 kRlh, float kMie, float shRlh, float shMie, float g
  ) {
    vec3 ignored;
    return atmosphereScatter(
      r, r0, pSun, iSun, rPlanet, rAtmos,
      kRlh, kMie, shRlh, shMie, g, ${ATMOSPHERE_PATH_FULL.toExponential()}, ignored
    );
  }
`

/**
 * Uniforms communs a tout materiau qui evalue la diffusion le long de sa
 * propre ligne de visee — silhouette d'avion, trainee, disque planetaire —
 * plutot que de recevoir une teinte globale approchee. Voir `SkyBackground`
 * pour l'unique source de verite sur l'exposition (`uAtmosphereExposure`),
 * partagee afin que tout le monde s'eteigne au meme rythme.
 */
export function atmosphereUniforms() {
  return {
    uSunDir: { value: new Vector3(0, 1, 0) },
    uSunIntensity: { value: SUN_INTENSITY_REF },
    uPlanetRadius: { value: PLANET_RADIUS_M },
    uAtmosphereRadius: { value: ATMOSPHERE_RADIUS_M },
    uRayleighCoeff: { value: new Vector3(...RAYLEIGH_COEFFICIENTS) },
    uMieCoeff: { value: MIE_COEFFICIENT },
    uRayleighScaleHeight: { value: RAYLEIGH_SCALE_HEIGHT_M },
    uMieScaleHeight: { value: MIE_SCALE_HEIGHT_M },
    uMieG: { value: MIE_G },
    /** Meme exposition que le fond de ciel — voir `SkyCanvas.tsx` — pour que la teinte du voile lui reste identique. */
    uAtmosphereExposure: { value: 0 },
  }
}

/**
 * Applique une charge en aerosols aux uniforms d'un materiau.
 *
 * Seule la concentration change ; la hauteur d'echelle reste fixe. C'est ce
 * qui donne a la brume son comportement caracteristique : concentree dans la
 * basse couche, elle se remarque surtout pres de l'horizon, ou la ligne de
 * visee traverse plusieurs dizaines de fois plus d'aerosols qu'au zenith, et
 * s'efface a mesure qu'on leve les yeux.
 *
 * La hauteur d'echelle suivait auparavant la charge en `sqrt(t)`. C'etait une
 * erreur : elle faisait monter les aerosols avec leur concentration, si bien
 * que l'epaisseur optique zenithale croissait en `t^1.5`. Mesure sur le ciel
 * rendu a midi, la blancheur du zenith passait de 0,10 a trouble x1 a 0,75 a
 * trouble x4, et celle de 35° de hauteur a 0,95 — le degrade s'aplatissait au
 * lieu de rester colle a l'horizon, et tout le dome virait au gris. Une
 * pollution de basse couche epaissit la brume ; elle ne souleve pas la couche
 * limite.
 *
 * Passer par cette fonction plutot que d'ecrire la ligne dans chaque materiau
 * est ce qui garantit que le voile d'un avion, celui d'une planete et le fond
 * de ciel ne peuvent pas decrire des atmospheres differentes.
 */
export function applyAerosolTurbidity(
  uniforms: { uMieCoeff: { value: number }; uMieScaleHeight: { value: number } },
  turbidity: number,
) {
  const t = Math.max(0.1, turbidity)
  uniforms.uMieCoeff.value = MIE_COEFFICIENT * t
  uniforms.uMieScaleHeight.value = MIE_SCALE_HEIGHT_M
}

/**
 * Concentration en particules fines des sites les plus purs, en µg/m³.
 *
 * Cerro Paranal, l'Atlantique central ou un sommet pyreneen par vent portant
 * tournent autour de 3 : c'est le plancher de l'air ambiant, et donc ce qui
 * doit correspondre au trouble 1 — le ciel « tres pur » du reglage.
 */
const PRISTINE_PM25 = 3

/**
 * Concentration d'un episode majeur — smog hivernal de Delhi, panache d'un
 * grand incendie. C'est elle qui doit saturer l'echelle, pas un jour de brume
 * ordinaire.
 */
const EXTREME_PM25 = 200

/** Trouble maximal du modele, egal a la borne haute du curseur manuel. */
const MAX_TURBIDITY = 6

/**
 * Exposant de la loi de puissance, entierement determine par les deux ancres
 * ci-dessus : il n'y a pas de constante ajustee a la main dans cette courbe.
 */
const TURBIDITY_EXPONENT = Math.log(MAX_TURBIDITY) / Math.log(EXTREME_PM25 / PRISTINE_PM25)

/**
 * Trouble atmospherique deduit de la charge en aerosols **de surface**.
 *
 * C'est le pont entre une vraie mesure de qualite de l'air — voir
 * `data-sources/airQuality.ts` — et le reglage manuel : les deux pilotent
 * exactement la meme paire d'uniforms, par `applyAerosolTurbidity`.
 *
 * Le pilotage se faisait auparavant par l'epaisseur optique totale (AOD a
 * 550 nm), et c'etait une erreur de modele. L'AOD integre **toute** la colonne
 * atmospherique, cirrus et poussieres de haute troposphere compris, alors que
 * `applyAerosolTurbidity` place ses aerosols dans une couche limite de 1,2 km
 * de hauteur d'echelle. Les deux grandeurs se decorrelent completement : au
 * Pic du Midi, sur dix jours, l'AOD est passee de 0,09 a 0,30 — un facteur
 * trois, soit un trouble de 1,5 a 3,3 — pendant que le PM2,5 restait entre
 * 2,1 et 2,9 µg/m³, c'est-a-dire un air parmi les plus purs mesurables. Le
 * ciel se voilait sans qu'aucun aerosol ne soit apparu autour de
 * l'observateur.
 *
 * Ce qui blanchit l'horizon et diffuse le Soleil pour qui regarde depuis le
 * sol, c'est la couche limite. On la mesure donc directement, par le PM2,5.
 *
 * Contrepartie assumee : une poussiere saharienne ou une fumee d'incendie qui
 * passe en altitude sans descendre n'est plus prise en compte. Elle ne l'etait
 * de toute facon pas correctement — elle etait modelisee comme une brume de
 * basse couche, ce qui donnait le mauvais profil vertical.
 *
 * L'echelle qui en sort, sur des mesures relevees le 23 aout 2026 :
 *
 * | site            | PM2,5 | trouble |
 * |-----------------|-------|---------|
 * | Cerro Paranal   |   3,2 |     1,0 |
 * | Paris           |   3,3 |     1,0 |
 * | Bruxelles       |   4,3 |     1,2 |
 * | Pic du Midi     |   6,3 |     1,4 |
 * | Montreal        |    10 |     1,7 |
 * | Delhi           |    73 |     3,9 |
 * | Pekin           |   106 |     4,6 |
 */
export function turbidityFromSurfaceAerosol(pm25: number): number {
  const ratio = Math.max(0.3, pm25) / PRISTINE_PM25
  return Math.min(MAX_TURBIDITY, Math.max(0.5, Math.pow(ratio, TURBIDITY_EXPONENT)))
}

export const ATMOSPHERE_UNIFORM_DECLARATIONS = /* glsl */ `
  uniform vec3 uSunDir;
  uniform float uSunIntensity;
  uniform float uPlanetRadius;
  uniform float uAtmosphereRadius;
  uniform vec3 uRayleighCoeff;
  uniform float uMieCoeff;
  uniform float uRayleighScaleHeight;
  uniform float uMieScaleHeight;
  uniform float uMieG;
  uniform float uAtmosphereExposure;
`

/**
 * Radiance atmospherique le long de `dir`, et transmittance associee.
 *
 * `hazeColorTo` rend les deux moities de l'equation du transfert : ce que
 * l'atmosphere ajoute (retour de la fonction) et ce qu'elle laisse passer
 * (`transmittance`). Un materiau qui n'utiliserait que la premiere ne ferait
 * qu'eclaircir son objet ; la seconde est ce qui le fait rougir et faiblir en
 * descendant vers l'horizon, comme n'importe quel astre reel.
 *
 * ## Radiance lineaire, non bornee
 *
 * La fonction rendait auparavant une couleur **deja passee au tone mapping et
 * ecretee a [0,1]**. C'etait le blocage structurel du rendu : aucune grandeur
 * physique ne survivait au fragment shader, et le produit
 * `couleur_affichage × transmittance` melangeait deux espaces — ce que le
 * commentaire d'alors reconnaissait comme une approximation.
 *
 * Elle rend desormais une **radiance lineaire**, dans les memes unites que
 * l'entree, sans borne superieure. La courbe d'affichage est appliquee une
 * seule fois, tout a la fin, par `scene/display/DisplayEffect`. Le produit
 * `radiance × transmittance` est alors exact, et non plus approche.
 *
 * `uAtmosphereExposure` reste applique ici : c'est encore une constante de
 * calibrage du modele, et elle disparaitra avec l'ancrage radiometrique de la
 * phase 4.
 */
export const ATMOSPHERE_HAZE_COLOR_FN = /* glsl */ `
  vec3 hazeColorTo(vec3 dir, float maxPath, out vec3 transmittance) {
    vec3 r0 = vec3(0.0, uPlanetRadius, 0.0);
    vec3 raw = atmosphereScatter(
      dir, r0, uSunDir, uSunIntensity,
      uPlanetRadius, uAtmosphereRadius,
      uRayleighCoeff, uMieCoeff, uRayleighScaleHeight, uMieScaleHeight, uMieG,
      maxPath, transmittance
    );
    return raw * uAtmosphereExposure;
  }

  /** Diffusion et extinction sur toute la traversee — pour un astre, hors de l'atmosphere. */
  vec3 hazeColorAlong(vec3 dir, out vec3 transmittance) {
    return hazeColorTo(dir, ${ATMOSPHERE_PATH_FULL.toExponential()}, transmittance);
  }

  /** Diffusion seule, sur toute la traversee — pour le fond de ciel, qui n'a rien derriere lui. */
  vec3 hazeColorAlong(vec3 dir) {
    vec3 ignored;
    return hazeColorAlong(dir, ignored);
  }
`
