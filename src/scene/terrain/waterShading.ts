import { CLIPMAP_SIZE } from './elevationClipmap'
import {
  FFT_SIZE,
  LAKE_CASCADES,
  LAKE_FETCH_M,
  LAKE_RRS,
  OCEAN_CASCADES,
  OCEAN_RRS,
  WATER_IOR,
  coxMunkSlopeVariance,
  fetchLimitedSea,
  fullyDevelopedSea,
  type SeaComponent,
} from '@/atmosphere/water/seaSurface'

/**
 * Eclairage de l'eau — voir `seaSurface.ts` pour la methode (Bruneton,
 * Neyret & Holzschuch 2010) et ses references, `oceanFft.ts` pour les vagues.
 *
 * Par fragment d'eau :
 * 1. **Normale** : les pentes des vagues, lues dans les textures des cascades
 *    au niveau de mip qui correspond au pixel. Ce que le mip a lisse — la
 *    variance `E[s²] − E[s]²` — passe dans la dispersion statistique, avec la
 *    part des pentes que les cascades ne portent pas du tout (capillaires) :
 *    la variance totale reste celle de Cox & Munk pour le vent du moment.
 * 2. **Ciel reflechi** : lu dans la table du ciel dans la direction miroir, et
 *    floute sur la dispersion restante, pondere par Fresnel.
 * 3. **Soleil et Lune** : pentes gaussiennes (Cox & Munk), Fresnel a l'angle
 *    de la micro-facette, masquage et ombrage de Smith.
 * 4. **Lumiere montante** : (1 − F) · Rrs · E.
 *
 * Le globe, au-dela du relief, n'a pas de vagues : il prend la seule partie
 * statistique (`WATER_COMMON_GLSL`), avec la variance totale.
 */

export interface SeaState {
  windMS: number
  /** Direction d'ou vient le vent, degres. */
  windFromDeg: number
  /** Mer du vent et houle, si une prevision existe. */
  windSea?: { hs: number; tp: number; fromDeg: number }
  swell?: { hs: number; tp: number; fromDeg: number }
}

export const DEFAULT_SEA_STATE: SeaState = { windMS: 5, windFromDeg: 270 }

const toward = (from: number) => (from + 180) % 360

/** Composantes spectrales de la mer : mer du vent (prevue, ou levee par le vent) et houle. */
export function oceanComponents(state: SeaState): SeaComponent[] {
  const wind = state.windSea ?? { ...fullyDevelopedSea(state.windMS), fromDeg: state.windFromDeg }
  const out: SeaComponent[] = [{ hs: wind.hs, tp: wind.tp, towardDeg: toward(wind.fromDeg), spreading: 2 }]
  if (state.swell) out.push({ hs: state.swell.hs, tp: state.swell.tp, towardDeg: toward(state.swell.fromDeg), spreading: 12, gamma: 7 })
  return out
}

/** Sur un lac : la mer du vent, limitee par la largeur du plan d'eau. */
export function lakeComponents(state: SeaState): SeaComponent[] {
  const sea = fetchLimitedSea(state.windMS, LAKE_FETCH_M)
  return [{ hs: sea.hs, tp: sea.tp, towardDeg: toward(state.windFromDeg), spreading: 2 }]
}

/** Variance totale des pentes : Cox & Munk, pour le vent du moment. */
export const totalSlopeVariance = (state: SeaState) => coxMunkSlopeVariance(state.windMS)

/**
 * Marge au-dessus du niveau de l'eau ou le sol reste de l'eau, m : l'erreur
 * verticale courante du relief satellite (SRTM, ±5 m). Puis fondu sur quelques
 * metres vers la terre.
 */
const SHORE_MARGIN_M = 4
const SHORE_BLEND_M = 4

/** Masque, Fresnel, Smith, reflets et lumiere montante — commun au relief et au globe. */
export const WATER_COMMON_GLSL = /* glsl */ `
  uniform sampler2D uWater0;
  uniform sampler2D uWater1;
  uniform sampler2D uWater2;
  uniform vec3 uWaterHalfSpan;
  uniform float uWaterOn;
  uniform vec3 uMoonDirection;
  uniform vec3 uMoonIrradiance;

  const float WATER_IOR = ${WATER_IOR.toFixed(3)};
  const vec3 OCEAN_RRS = vec3(${OCEAN_RRS.map((v) => v.toFixed(5)).join(', ')});
  const vec3 LAKE_RRS = vec3(${LAKE_RRS.map((v) => v.toFixed(5)).join(', ')});

  /**
   * Eau, ocean, niveau de l'eau (m). Le niveau est code sur deux octets (pas
   * de 12,5 cm, −500 m a l'origine) ; 65 535 — « inconnu » — vaut 7 692 m, ce
   * qui revient a ne pas decouper l'eau par le relief.
   */
  vec3 waterLevel(sampler2D tex, float half_, vec2 en) {
    vec2 f = (en + half_) / (2.0 * half_) * ${CLIPMAP_SIZE - 1}.0;
    // La couverture se lit filtree : le trait de cote en sort anticrenele.
    vec4 m = textureLod(tex, (f + 0.5) / ${CLIPMAP_SIZE}.0, 0.0);
    // ⚠️ Le niveau, lui, se lit **au texel le plus proche**. Il est code sur
    // deux octets ; les melanger par le filtrage donnait le long des cotes des
    // niveaux sans rapport avec aucun des deux voisins — des pics.
    vec4 l = texelFetch(tex, ivec2(clamp(floor(f + 0.5), vec2(0.0), vec2(${CLIPMAP_SIZE - 1}.0))), 0);
    float q = floor(l.b * 255.0 + 0.5) * 256.0 + floor(l.a * 255.0 + 0.5);
    // ⚠️ Niveau inconnu — le relief n'est pas encore la pour decouper l'eau :
    // pas d'eau du tout. Lu comme un niveau, il valait 7 692 m, et toute la mer
    // se dressait en rideaux de sept kilometres le temps du chargement.
    if (q > 65534.5) return vec3(0.0);
    return vec3(m.rg, q / 8.0 - 500.0);
  }
  /** Eau, ocean, niveau — meme choix de niveau et meme frange que le relief. */
  vec3 waterAt(vec2 en) {
    if (uWaterOn < 0.5) return vec3(0.0, 0.0, 0.0);
    float reach = max(abs(en.x), abs(en.y));
    if (reach <= uWaterHalfSpan.x) {
      vec3 fine = waterLevel(uWater0, uWaterHalfSpan.x, en);
      float t = smoothstep(0.88, 1.0, reach / uWaterHalfSpan.x);
      return t > 0.0 ? mix(fine, waterLevel(uWater1, uWaterHalfSpan.y, en), t) : fine;
    }
    if (reach <= uWaterHalfSpan.y) {
      vec3 fine = waterLevel(uWater1, uWaterHalfSpan.y, en);
      float t = smoothstep(0.88, 1.0, reach / uWaterHalfSpan.y);
      return t > 0.0 ? mix(fine, waterLevel(uWater2, uWaterHalfSpan.z, en), t) : fine;
    }
    if (reach <= uWaterHalfSpan.z) return waterLevel(uWater2, uWaterHalfSpan.z, en);
    return vec3(0.0);
  }

  /**
   * Part d'eau d'un point du relief a l'altitude \`altitudeM\` : le masque dit
   * ou est l'eau, le relief dit si le sol y depasse. Au-dela du niveau plus
   * ${SHORE_MARGIN_M} m — l'erreur verticale courante du relief satellite —, c'est la
   * terre qui l'emporte, fondue sur ${SHORE_BLEND_M} m : le rivage suit alors les courbes
   * de niveau reelles, et l'eau ne monte plus sur les pentes.
   */
  float waterCover(vec3 w, float altitudeM) {
    return w.x * (1.0 - smoothstep(w.z + ${SHORE_MARGIN_M}.0, w.z + ${SHORE_MARGIN_M + SHORE_BLEND_M}.0, altitudeM));
  }

  float waterFresnel(float c) {
    c = clamp(c, 0.0, 1.0);
    float t2 = (1.0 - c * c) / (WATER_IOR * WATER_IOR);
    if (t2 >= 1.0) return 1.0;
    float ct = sqrt(1.0 - t2);
    float rs = (c - WATER_IOR * ct) / (c + WATER_IOR * ct);
    float rp = (WATER_IOR * c - ct) / (WATER_IOR * c + ct);
    return 0.5 * (rs * rs + rp * rp);
  }

  /** Masquage de Smith pour des pentes gaussiennes de variance totale \`sigma2\` (Walter et al. 2007). */
  float smithG1(float cosT, float sigma2) {
    float c = clamp(cosT, 1e-4, 0.9999);
    float a = c / (sqrt(sigma2) * sqrt(1.0 - c * c));
    float lambda = a < 1.6 ? (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a) : 0.0;
    return 1.0 / (1.0 + lambda);
  }

  /** Reflet d'un astre de direction \`l\` et d'eclairement \`irr\` — Cox & Munk, Fresnel, Smith. */
  vec3 waterGlint(vec3 l, vec3 irr, bool lit, vec3 v, vec3 n, float muV, float sigma2) {
    float muL = dot(l, n);
    vec3 halfSum = l + v;
    if (!lit || muL <= 0.0 || dot(halfSum, halfSum) <= 1e-8) return vec3(0.0);
    vec3 h = normalize(halfSum);
    float c = max(dot(h, n), 1e-3);
    float tan2 = (1.0 - c * c) / (c * c);
    float d = exp(-tan2 / sigma2) / (3.14159265 * sigma2 * c * c * c * c);
    float g = smithG1(muV, sigma2) * smithG1(muL, sigma2);
    return irr * waterFresnel(dot(v, h)) * d * g / (4.0 * muV);
  }

  /**
   * Lumiere d'une surface d'eau de normale \`n\` et de dispersion de pentes
   * \`sigma2\`, vue dans la direction \`viewDir\` (de l'oeil vers le point).
   * Rend la radiance non exposee ; \`skyReflection\` recoit le ciel reflechi,
   * deja expose comme la table qui le fournit.
   */
  vec3 waterLight(vec3 viewDir, vec3 up, vec3 n, float sigma2, bool ocean, vec3 sunIrr, vec3 skyIrr, vec3 sunDir, bool sunLit, out vec3 skyReflection) {
    vec3 v = -viewDir;
    float muV = max(dot(v, n), 1e-3);

    // --- Ciel reflechi, floute sur les pentes restantes.
    vec3 r = reflect(viewDir, n);
    vec3 t1 = normalize(cross(r, up) + vec3(1e-6, 0.0, 0.0));
    vec3 t2 = cross(t1, r);
    // La reflexion double l'angle de la pente : ecart-type des directions ≈ 2σ par axe.
    float spread = 2.0 * sqrt(0.5 * sigma2);
    vec3 sky = vec3(0.0);
    vec3 tr;
    // De pres, les vagues sont dans la normale et la dispersion restante est
    // faible : une seule lecture suffit. Cinq seulement la ou le flou se voit.
    int taps = spread < 0.03 ? 1 : 5;
    for (int k = 0; k < 5; k++) {
      if (k >= taps) break;
      vec2 o = k == 0 ? vec2(0.0) : k == 1 ? vec2(1.0, 0.0) : k == 2 ? vec2(-1.0, 0.0) : k == 3 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
      vec3 rr = normalize(r + spread * (o.x * t1 + o.y * t2));
      // Sous l'horizon, un rayon reflechi rencontrerait l'eau elle-meme : on le
      // garde au ras de l'horizon, la ou le ciel reflechi est le plus clair.
      rr.y = max(rr.y, 0.01);
      sky += aerialPerspectiveToSpace(normalize(rr), tr);
    }
    sky /= float(taps);
    // Fresnel moyen des facettes vues : en rasant, les facettes visibles sont
    // inclinees vers l'oeil d'environ l'ecart-type des pentes.
    float F = waterFresnel(clamp(muV + 0.7 * sqrt(sigma2) * (1.0 - muV), 0.0, 1.0));
    skyReflection = F * sky;

    // --- Soleil, puis Lune. La carte d'ombre est celle du Soleil ; la Lune
    // n'en a pas, elle eclaire toute l'eau qu'elle voit.
    vec3 glint = waterGlint(sunDir, sunIrr, sunLit, v, n, muV, sigma2);
    if (uMoonDirection.y > 0.0) glint += waterGlint(normalize(uMoonDirection), uMoonIrradiance, true, v, n, muV, sigma2);

    // --- Lumiere montante.
    vec3 down = sunIrr * max(dot(sunDir, up), 0.0) * (sunLit ? 1.0 : 0.0) + skyIrr
      + uMoonIrradiance * max(dot(uMoonDirection, up), 0.0);
    vec3 upwelling = (1.0 - F) * (ocean ? OCEAN_RRS : LAKE_RRS) * down;
    return glint + upwelling;
  }
`

/** Cascades de vagues du relief : textures de pentes, lecture filtree LEADR. */
export const WATER_GLSL = /* glsl */ `
  ${WATER_COMMON_GLSL}
  uniform sampler2D uOceanSlope0;
  uniform sampler2D uOceanSlope1;
  uniform sampler2D uOceanSlope2;
  uniform sampler2D uLakeSlope0;
  uniform sampler2D uLakeSlope1;
  uniform vec3 uOceanCascadeM;
  uniform vec2 uLakeCascadeM;
  /** Variance des pentes que les cascades ne portent pas (capillaires). */
  uniform float uOceanResidual;
  uniform float uLakeResidual;
  /** Angle d'un pixel, rad. */
  uniform float uWaterPixelAngle;

  /**
   * Pente moyenne d'une cascade sur l'empreinte du pixel, et la variance que le
   * filtrage a lissee (ajoutee a \`variance\`). Coordonnee ramenee dans [0, 1[ :
   * la texture est periodique, et les grandes coordonnees perdraient la
   * precision sous le texel.
   */
  vec2 cascadeSlope(sampler2D tex, float sizeM, vec2 en, float footprint, inout float variance) {
    float texel = sizeM / ${FFT_SIZE}.0;
    float lod = max(0.0, log2(max(footprint, 1e-4) / texel));
    vec4 m = textureLod(tex, fract(en / sizeM), lod);
    variance += max(0.0, m.z - m.x * m.x) + max(0.0, m.w - m.y * m.y);
    return m.xy;
  }

  vec3 waterShade(vec3 viewDir, vec3 up, vec2 en, float range, bool ocean, vec3 sunIrr, vec3 skyIrr, vec3 sunDir, bool sunLit, out vec3 skyReflection) {
    float muUp = max(dot(-viewDir, up), 0.02);
    // Empreinte du pixel au sol, allongee en rasant.
    float footprint = uWaterPixelAngle * range / muUp;
    float variance = ocean ? uOceanResidual : uLakeResidual;
    vec2 s;
    if (ocean) {
      s = cascadeSlope(uOceanSlope0, uOceanCascadeM.x, en, footprint, variance)
        + cascadeSlope(uOceanSlope1, uOceanCascadeM.y, en, footprint, variance)
        + cascadeSlope(uOceanSlope2, uOceanCascadeM.z, en, footprint, variance);
    } else {
      s = cascadeSlope(uLakeSlope0, uLakeCascadeM.x, en, footprint, variance)
        + cascadeSlope(uLakeSlope1, uLakeCascadeM.y, en, footprint, variance);
    }
    float sigma2 = max(variance, 2e-4);
    vec3 n = normalize(up + vec3(-s.x, 0.0, s.y));
    return waterLight(viewDir, up, n, sigma2, ocean, sunIrr, skyIrr, sunDir, sunLit, skyReflection);
  }
`

/**
 * La meme eau, cote sommets : les cascades dont les vagues sont plus longues
 * que la maille soulevent vraiment la surface. Seules les deux plus grandes
 * servent — la plus fine (5 m) est bien en deca de toute maille. Le
 * deplacement est **vertical** : la position au sol du fragment ne bouge pas,
 * et les pentes qu'il lit sont celles du sommet.
 */
export const WATER_VERTEX_GLSL = /* glsl */ `
  uniform sampler2D uWater0;
  uniform sampler2D uWater1;
  uniform sampler2D uWater2;
  uniform vec3 uWaterHalfSpan;
  uniform float uWaterOn;
  uniform sampler2D uOceanHeight0;
  uniform sampler2D uOceanHeight1;
  uniform sampler2D uLakeHeight0;
  uniform vec3 uOceanCascadeM;
  uniform vec2 uLakeCascadeM;
  uniform float uWaterPixelAngle;

  vec3 waterLevelV(sampler2D tex, float half_, vec2 en) {
    vec2 f = (en + half_) / (2.0 * half_) * ${CLIPMAP_SIZE - 1}.0;
    // La couverture se lit filtree : le trait de cote en sort anticrenele.
    vec4 m = textureLod(tex, (f + 0.5) / ${CLIPMAP_SIZE}.0, 0.0);
    // ⚠️ Le niveau, lui, se lit **au texel le plus proche**. Il est code sur
    // deux octets ; les melanger par le filtrage donnait le long des cotes des
    // niveaux sans rapport avec aucun des deux voisins — des pics.
    vec4 l = texelFetch(tex, ivec2(clamp(floor(f + 0.5), vec2(0.0), vec2(${CLIPMAP_SIZE - 1}.0))), 0);
    float q = floor(l.b * 255.0 + 0.5) * 256.0 + floor(l.a * 255.0 + 0.5);
    // ⚠️ Niveau inconnu — le relief n'est pas encore la pour decouper l'eau :
    // pas d'eau du tout. Lu comme un niveau, il valait 7 692 m, et toute la mer
    // se dressait en rideaux de sept kilometres le temps du chargement.
    if (q > 65534.5) return vec3(0.0);
    return vec3(m.rg, q / 8.0 - 500.0);
  }
  vec3 waterAtV(vec2 en) {
    if (uWaterOn < 0.5) return vec3(0.0);
    float reach = max(abs(en.x), abs(en.y));
    if (reach <= uWaterHalfSpan.x) return waterLevelV(uWater0, uWaterHalfSpan.x, en);
    if (reach <= uWaterHalfSpan.y) return waterLevelV(uWater1, uWaterHalfSpan.y, en);
    if (reach <= uWaterHalfSpan.z) return waterLevelV(uWater2, uWaterHalfSpan.z, en);
    return vec3(0.0);
  }
  float waterCoverV(vec3 w, float altitudeM) {
    return w.x * (1.0 - smoothstep(w.z + ${SHORE_MARGIN_M}.0, w.z + ${SHORE_MARGIN_M + SHORE_BLEND_M}.0, altitudeM));
  }
  float cascadeHeight(sampler2D tex, float sizeM, vec2 en, float spacing) {
    float lod = max(0.0, log2(max(spacing, 1e-3) / (sizeM / ${FFT_SIZE}.0)));
    return textureLod(tex, fract(en / sizeM), lod).r;
  }
  /** Elevation des vagues que la maille resout, m ; spacing : maille estimee, m. */
  float waveHeight(vec2 en, float spacing, bool ocean) {
    return ocean
      ? cascadeHeight(uOceanHeight0, uOceanCascadeM.x, en, spacing) + cascadeHeight(uOceanHeight1, uOceanCascadeM.y, en, spacing)
      : cascadeHeight(uLakeHeight0, uLakeCascadeM.x, en, spacing);
  }
`

export { OCEAN_CASCADES, LAKE_CASCADES }
