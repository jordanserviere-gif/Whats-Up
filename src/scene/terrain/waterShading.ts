import { CLIPMAP_SIZE } from './elevationClipmap'
import {
  LAKE_FETCH_M,
  LAKE_RRS,
  LAKE_WAVES,
  OCEAN_RRS,
  OCEAN_WAVES,
  WATER_IOR,
  coxMunkSlopeVariance,
  fetchLimitedSea,
  fullyDevelopedSea,
  waveTrains,
  type Wave,
} from '@/atmosphere/water/seaSurface'

/**
 * Eclairage de l'eau dans le nuanceur du relief — voir `seaSurface.ts` pour
 * la methode (Bruneton, Neyret & Holzschuch 2010) et ses references.
 *
 * Par fragment d'eau :
 * 1. **Normale** : les trains de vagues dont la longueur d'onde depasse
 *    quelques pixels inclinent la normale ; les autres ne restent qu'en
 *    dispersion des pentes. La variance totale est celle de Cox & Munk pour le
 *    vent du moment : ce que la normale ne porte plus, la statistique le porte.
 * 2. **Ciel reflechi** : lu dans la table du ciel dans la direction miroir, et
 *    floute sur la dispersion des pentes restante, pondere par Fresnel.
 * 3. **Soleil** : distribution gaussienne des pentes (Cox & Munk), Fresnel a
 *    l'angle de la micro-facette, masquage et ombrage de Smith — c'est eux qui
 *    font la bonne clarte d'une mer vue de tres loin, en rasant.
 * 4. **Lumiere montante** : ce qui ressort de l'eau, (1 − F) · Rrs · E.
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

/** Trains de vagues de l'ocean et d'un lac pour un etat de mer. */
export function seaWaves(state: SeaState): { ocean: Wave[]; lake: Wave[] } {
  const toward = (from: number) => (from + 180) % 360
  const wind = state.windSea ?? { ...fullyDevelopedSea(state.windMS), fromDeg: state.windFromDeg }
  const oceanWind = waveTrains({ hs: wind.hs, tp: wind.tp, towardDeg: toward(wind.fromDeg), spreading: 2 }, state.swell ? OCEAN_WAVES - 8 : OCEAN_WAVES, 11)
  const swell = state.swell
    ? waveTrains({ hs: state.swell.hs, tp: state.swell.tp, towardDeg: toward(state.swell.fromDeg), spreading: 12, gamma: 7 }, 8, 23)
    : []
  const lakeSea = fetchLimitedSea(state.windMS, LAKE_FETCH_M)
  const lake = waveTrains({ hs: lakeSea.hs, tp: lakeSea.tp, towardDeg: toward(state.windFromDeg), spreading: 2 }, LAKE_WAVES, 31)
  return { ocean: [...swell, ...oceanWind], lake }
}

/** Trains de vagues en uniformes : vec4 (dir est, dir nord, k, amplitude), vec2 (ω, phase). */
export function packWaves(waves: readonly Wave[], count: number): { a: Float32Array; b: Float32Array } {
  const a = new Float32Array(count * 4)
  const b = new Float32Array(count * 2)
  waves.slice(0, count).forEach((w, i) => {
    a.set([w.dirEast, w.dirNorth, w.k, w.amplitude], i * 4)
    b.set([w.omega, w.phase], i * 2)
  })
  return { a, b }
}

export const slopeVariance = (state: SeaState) => ({
  ocean: coxMunkSlopeVariance(state.windMS),
  // Sur un lac, meme vent : la rugosite capillaire ne depend que de lui.
  lake: coxMunkSlopeVariance(state.windMS),
})

export const WATER_GLSL = /* glsl */ `
  uniform sampler2D uWater0;
  uniform sampler2D uWater1;
  uniform sampler2D uWater2;
  uniform vec3 uWaterHalfSpan;
  uniform float uWaterOn;
  uniform vec4 uOceanWaveA[${OCEAN_WAVES}];
  uniform vec2 uOceanWaveB[${OCEAN_WAVES}];
  uniform vec4 uLakeWaveA[${LAKE_WAVES}];
  uniform vec2 uLakeWaveB[${LAKE_WAVES}];
  uniform float uWaveTime;
  uniform float uOceanSlopeVar;
  uniform float uLakeSlopeVar;
  /** Angle d'un pixel, rad. */
  uniform float uWaterPixelAngle;

  const float WATER_IOR = ${WATER_IOR.toFixed(3)};
  const vec3 OCEAN_RRS = vec3(${OCEAN_RRS.map((v) => v.toFixed(5)).join(', ')});
  const vec3 LAKE_RRS = vec3(${LAKE_RRS.map((v) => v.toFixed(5)).join(', ')});

  vec2 waterLevel(sampler2D tex, float half_, vec2 en) {
    vec2 f = (en + half_) / (2.0 * half_) * ${CLIPMAP_SIZE - 1}.0;
    return texture2D(tex, (f + 0.5) / ${CLIPMAP_SIZE}.0).rg;
  }
  /** Eau, ocean — meme choix de niveau et meme frange que le relief. */
  vec2 waterAt(vec2 en) {
    if (uWaterOn < 0.5) return vec2(0.0);
    float reach = max(abs(en.x), abs(en.y));
    if (reach <= uWaterHalfSpan.x) {
      vec2 fine = waterLevel(uWater0, uWaterHalfSpan.x, en);
      float t = smoothstep(0.88, 1.0, reach / uWaterHalfSpan.x);
      return t > 0.0 ? mix(fine, waterLevel(uWater1, uWaterHalfSpan.y, en), t) : fine;
    }
    if (reach <= uWaterHalfSpan.y) {
      vec2 fine = waterLevel(uWater1, uWaterHalfSpan.y, en);
      float t = smoothstep(0.88, 1.0, reach / uWaterHalfSpan.y);
      return t > 0.0 ? mix(fine, waterLevel(uWater2, uWaterHalfSpan.z, en), t) : fine;
    }
    if (reach <= uWaterHalfSpan.z) return waterLevel(uWater2, uWaterHalfSpan.z, en);
    return vec2(0.0);
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

  /**
   * Pente resolue (x : dh/dest, y : dh/dnord) et variance qu'elle porte (z).
   * Un train n'est resolu que si sa longueur d'onde depasse plusieurs pixels :
   * sinon il ne ferait que scintiller, et sa pente est laissee a la statistique.
   */
  vec3 oceanSlope(vec2 en, float footprint) {
    vec3 s = vec3(0.0);
    for (int i = 0; i < ${OCEAN_WAVES}; i++) {
      vec4 a = uOceanWaveA[i];
      vec2 b = uOceanWaveB[i];
      if (a.w <= 0.0) continue;
      float keep = smoothstep(2.0 * footprint, 6.0 * footprint, 6.2831853 / a.z);
      if (keep <= 0.0) continue;
      float arg = a.z * dot(a.xy, en) - b.x * uWaveTime + b.y;
      s.xy += keep * a.w * a.z * a.xy * cos(arg);
      s.z += keep * keep * 0.5 * a.w * a.w * a.z * a.z;
    }
    return s;
  }
  vec3 lakeSlope(vec2 en, float footprint) {
    vec3 s = vec3(0.0);
    for (int i = 0; i < ${LAKE_WAVES}; i++) {
      vec4 a = uLakeWaveA[i];
      vec2 b = uLakeWaveB[i];
      if (a.w <= 0.0) continue;
      float keep = smoothstep(2.0 * footprint, 6.0 * footprint, 6.2831853 / a.z);
      if (keep <= 0.0) continue;
      float arg = a.z * dot(a.xy, en) - b.x * uWaveTime + b.y;
      s.xy += keep * a.w * a.z * a.xy * cos(arg);
      s.z += keep * keep * 0.5 * a.w * a.w * a.z * a.z;
    }
    return s;
  }

  /**
   * Radiance de la surface (non exposee) ; \`skyReflection\` recoit le ciel
   * reflechi, deja expose comme la table qui le fournit.
   */
  vec3 waterShade(vec3 viewDir, vec3 up, vec2 en, float range, bool ocean, vec3 sunIrr, vec3 skyIrr, vec3 sunDir, bool sunLit, out vec3 skyReflection) {
    vec3 v = -viewDir;
    float muUp = max(dot(v, up), 0.02);
    // Empreinte du pixel au sol, allongee en rasant.
    float footprint = uWaterPixelAngle * range / muUp;
    vec3 s = ocean ? oceanSlope(en, footprint) : lakeSlope(en, footprint);
    float total = ocean ? uOceanSlopeVar : uLakeSlopeVar;
    float sigma2 = max(total - s.z, 2e-4);
    vec3 n = normalize(up + vec3(-s.x, 0.0, s.y));
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

    // --- Soleil : Cox & Munk, Fresnel a la micro-facette, Smith.
    vec3 glint = vec3(0.0);
    float muL = dot(sunDir, n);
    vec3 halfSum = sunDir + v;
    if (sunLit && muL > 0.0 && dot(halfSum, halfSum) > 1e-8) {
      vec3 h = normalize(halfSum);
      float c = max(dot(h, n), 1e-3);
      float tan2 = (1.0 - c * c) / (c * c);
      float d = exp(-tan2 / sigma2) / (3.14159265 * sigma2 * c * c * c * c);
      float g = smithG1(muV, sigma2) * smithG1(muL, sigma2);
      glint = sunIrr * waterFresnel(dot(v, h)) * d * g / (4.0 * muV);
    }

    // --- Lumiere montante.
    vec3 down = sunIrr * max(dot(sunDir, up), 0.0) * (sunLit ? 1.0 : 0.0) + skyIrr;
    vec3 upwelling = (1.0 - F) * (ocean ? OCEAN_RRS : LAKE_RRS) * down;
    return glint + upwelling;
  }
`

/**
 * La meme eau, cote sommets : les vagues assez longues pour le maillage
 * soulevent vraiment la surface — la houle ondule, l'horizon aussi quand on est
 * en mer. Seules les longueurs d'onde de plusieurs mailles deplacent la
 * geometrie ; la normale, elle, reste calculee par fragment a partir des memes
 * trains (voir \`waterShade\`), exacte pour la surface deplacee. Le deplacement
 * est **vertical** : la position au sol du fragment ne bouge pas, et la phase
 * des vagues qu'il lit reste celle du sommet.
 */
export const WATER_VERTEX_GLSL = /* glsl */ `
  uniform sampler2D uWater0;
  uniform sampler2D uWater1;
  uniform sampler2D uWater2;
  uniform vec3 uWaterHalfSpan;
  uniform float uWaterOn;
  uniform vec4 uOceanWaveA[${OCEAN_WAVES}];
  uniform vec2 uOceanWaveB[${OCEAN_WAVES}];
  uniform vec4 uLakeWaveA[${LAKE_WAVES}];
  uniform vec2 uLakeWaveB[${LAKE_WAVES}];
  uniform float uWaveTime;
  uniform float uWaterPixelAngle;

  vec2 waterLevelV(sampler2D tex, float half_, vec2 en) {
    vec2 f = (en + half_) / (2.0 * half_) * ${CLIPMAP_SIZE - 1}.0;
    return textureLod(tex, (f + 0.5) / ${CLIPMAP_SIZE}.0, 0.0).rg;
  }
  vec2 waterAtV(vec2 en) {
    if (uWaterOn < 0.5) return vec2(0.0);
    float reach = max(abs(en.x), abs(en.y));
    if (reach <= uWaterHalfSpan.x) return waterLevelV(uWater0, uWaterHalfSpan.x, en);
    if (reach <= uWaterHalfSpan.y) return waterLevelV(uWater1, uWaterHalfSpan.y, en);
    if (reach <= uWaterHalfSpan.z) return waterLevelV(uWater2, uWaterHalfSpan.z, en);
    return vec2(0.0);
  }
  /** Elevation des vagues que le maillage resout, m. \`spacing\` : maille estimee, m. */
  float waveHeight(vec2 en, float spacing, bool ocean) {
    float h = 0.0;
    if (ocean) {
      for (int i = 0; i < ${OCEAN_WAVES}; i++) {
        vec4 a = uOceanWaveA[i];
        if (a.w <= 0.0) continue;
        float keep = smoothstep(2.0 * spacing, 6.0 * spacing, 6.2831853 / a.z);
        h += keep * a.w * sin(a.z * dot(a.xy, en) - uOceanWaveB[i].x * uWaveTime + uOceanWaveB[i].y);
      }
    } else {
      for (int i = 0; i < ${LAKE_WAVES}; i++) {
        vec4 a = uLakeWaveA[i];
        if (a.w <= 0.0) continue;
        float keep = smoothstep(2.0 * spacing, 6.0 * spacing, 6.2831853 / a.z);
        h += keep * a.w * sin(a.z * dot(a.xy, en) - uLakeWaveB[i].x * uWaveTime + uLakeWaveB[i].y);
      }
    }
    return h;
  }
`
