import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BackSide,
  Matrix4,
  type PerspectiveCamera,
  Color,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  Texture,
  WebGLRenderTarget,
  type WebGLRenderer,
  ClampToEdgeWrapping,
  CustomBlending,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
} from 'three'
import { AERIAL_LUT_GLSL } from '@/atmosphere/lut/aerialPerspectiveLut'
import { CLOUD_PHASE_GLSL, dropletPhaseParameters } from '@/atmosphere/cloud/phase'
import { CLOUD_LAYER_GLSL, ICE_ASYMMETRY, VALUE_NOISE_VARIANCE, WATER_ASYMMETRY, structureSigma } from '@/atmosphere/cloud/cloudLayer'
import { EARTH_MEAN_RADIUS_M } from '@/atmosphere/core/units'
import { SEA_LEVEL_PRESSURE_PA, standardPressure } from '@/atmosphere/thermodynamics/standardAtmosphere'
import { loadScenario, type WeatherScenario } from '@/data-sources/weatherScenario'
import { useSkyStore } from '@/state/store'
import { aerialSkyReady, aerialTextures, aerialUniforms, applyAerialUniforms } from './useAerialLut'
import { SUN_TABLE_WIDTH, uploadField } from './cloudField'
import { requestCloudField } from './cloudWorkerClient'
import type { CloudSlab } from '@/atmosphere/cloud/cloudLayer'
import { eyeAltitudeM } from './terrain/elevationField'
import { GROUND_RADIUS } from './sceneMath'
import { DETAIL_PERIOD, STRUCTURE_PERIOD, cloudNoiseTextures } from './cloudNoise'

/**
 * Nappes nuageuses d'un scenario meteo, jusqu'a l'horizon.
 *
 * Un seul maillage, une sphere autour de l'observateur ; tout se passe dans le
 * nuanceur, rayon par rayon :
 *
 * 1. **Ou le rayon traverse chaque etage.** Intersection exacte avec les deux
 *    coquilles spheriques de la base et du sommet, lus dans la grille au point
 *    traverse — deux iterations, puisque la hauteur depend du point et le point
 *    de la hauteur. Un rayon rasant parcourt ainsi cent kilometres dans une
 *    nappe d'un kilometre, et un nuage au-dela de l'horizon geometrique reste
 *    visible juste sous lui, comme en vrai.
 * 2. **Combien il y a de nuage.** La couverture de la maille, et la structure
 *    sous-maille dont la fraction attendue lui est egale (`cloudLayer.ts`).
 * 3. **Comment il est eclaire.** Le Soleil vu *depuis le nuage* — hauteur
 *    locale, rougissement et ombre de la Terre a l'altitude du sommet —,
 *    attenue par les etages superieurs ; Eddington pour la lumiere diffusee
 *    plusieurs fois, la vraie fonction de phase pour la premiere diffusion. Le
 *    ciel au-dessus et le sol en dessous (rebonds sol-nuage compris) ajoutent
 *    leur part. Le cote eclaire est celui que le Soleil voit : apres son
 *    coucher, c'est le dessous des nuages qui s'allume.
 * 4. **Ce que l'air ajoute devant.** La perspective atmospherique jusqu'au
 *    nuage, lue dans la meme table que tout le reste.
 *
 * La composition se fait d'arriere en avant, en alpha premultiplie : le ciel,
 * les etoiles et le relief deja dessines sont attenues par la transmittance de
 * chaque nappe. La profondeur est ecrite par fragment, sur la meme loi que le
 * relief : un stratus a 50 km passe devant une montagne a 100 km, et derriere
 * une colline a 5 km.
 *
 * ## ⚠️ Ce qui n'est pas encore modelise
 *
 * - **Les avions** ne sont pas masques par les nuages : leur profondeur suit
 *   une autre loi que celle du relief. Ils passent toujours devant.
 * - **La nuit** : ni clair de Lune, ni halo urbain sur la base des nuages.
 * - **Les ombres des nuages** sur le sol et dans l'air.
 */

/** Echelle de la plus grande structure de chaque etage, km — au plus, pour l'etage bas. */
const STRUCTURE_SCALE_KM: [number, number, number] = [4, 3, 8]
/**
 * Periode de la plus grande structure de l'etage bas rapportee a l'epaisseur
 * du nuage. Les champs de cumulus mesures ont des cellules de largeur voisine
 * de leur epaisseur, espacees de deux a trois fois celle-ci.
 */
const CELL_TO_DEPTH = 3
/**
 * Portee du volume : l'etage bas est marche en volume jusqu'a 18 km, raccorde
 * a la nappe jusqu'a 26 km. Au-dela, un cumulus d'un kilometre sous-tend
 * moins de deux degres : sa forme ne se lit plus, sa couverture si.
 */
const VOLUME_BLEND_M: [number, number] = [18_000, 26_000]
/** Longueur marchee au plus, m : un rayon rasant ne traverse pas cent kilometres de volume. */
const VOLUME_MAX_PATH_M = 20_000
/** Albedo du sol sous les nuages, pour les rebonds sol-nuage. */
const GROUND_ALBEDO = 0.15
/** Diametre des gouttes pour la phase : 2 × 8 µm de rayon effectif. */
const DROPLET = dropletPhaseParameters(16)

/** Table du Soleil, calculee par le worker : ici, le seul televersement. */
function uploadSunTable(data: Uint16Array, previous: DataTexture | null): DataTexture {
  if (previous) {
    ;(previous.image.data as unknown as Uint16Array).set(data)
    previous.needsUpdate = true
    return previous
  }
  const t = new DataTexture(data.slice(), SUN_TABLE_WIDTH, 3, RGBAFormat, HalfFloatType)
  t.magFilter = LinearFilter
  t.minFilter = LinearFilter
  t.wrapS = ClampToEdgeWrapping
  t.wrapT = ClampToEdgeWrapping
  t.needsUpdate = true
  return t
}

function cloudUniforms() {
  return {
      ...aerialUniforms(),
      uFar: { value: null as DataTexture | null },
      uNear: { value: null as DataTexture | null },
      uSunTable: { value: null as DataTexture | null },
      uGrid: { value: new Vector3(9, 100, 6) },
      uObserverRadius: { value: EARTH_MEAN_RADIUS_M },
      uGroundAltitude: { value: 0 },
      uEyeAltitude: { value: 0 },
      uSkyAbove0: { value: new Vector3() },
      uSkyAbove1: { value: new Vector3() },
      uSkyAbove2: { value: new Vector3() },
      uDrift0: { value: new Vector2() },
      uDrift1: { value: new Vector2() },
      uDrift2: { value: new Vector2() },
      uScale: { value: new Vector3(...STRUCTURE_SCALE_KM) },
      uDroplet: { value: new Vector4(DROPLET.gHG, DROPLET.gD, DROPLET.alpha, DROPLET.wD) },
      uPixelAngle: { value: 1e-3 },
      uDetailKm: { value: 0.6 },
      uPass: { value: 0 },
      uStructure: { value: null as Texture | null },
      uDetail: { value: null as Texture | null },
  }
}

/** Nappes, eclairage et volume : le meme code pour la carte et pour l'ecran. */
const CLOUD_SHADE_GLSL = /* glsl */ `
      ${AERIAL_LUT_GLSL}
      ${CLOUD_PHASE_GLSL}
      ${CLOUD_LAYER_GLSL}
      uniform sampler2D uFar;
      uniform sampler2D uNear;
      uniform sampler2D uSunTable;
      /** Points par cote, pas de la grille lointaine et de la proche, km. */
      uniform vec3 uGrid;
      uniform float uObserverRadius;
      uniform float uGroundAltitude;
      uniform float uEyeAltitude;
      uniform vec3 uSkyAbove0;
      uniform vec3 uSkyAbove1;
      uniform vec3 uSkyAbove2;
      uniform vec2 uDrift0;
      uniform vec2 uDrift1;
      uniform vec2 uDrift2;
      uniform vec3 uScale;
      uniform vec4 uDroplet;
      /** Angle sous-tendu par un pixel, rad. */
      uniform float uPixelAngle;
      /** Echelle du detail 3D, km. */
      uniform float uDetailKm;
      /** Indice de la passe d'accumulation en cours. */
      uniform float uPass;
      uniform sampler2D uStructure;
      uniform highp sampler3D uDetail;

      /**
       * Le champ de structure, lu dans sa texture precalculee — une lecture au
       * lieu de seize hachages. Meme filtrage au pixel que \`cloudStructure\` :
       * chaque octave est un canal, retire quand sa periode passe sous deux
       * pixels, et sa variance rendue en flou.
       */
      vec2 bakedStructure(vec2 p, float footprint) {
        vec4 o = texture2D(uStructure, p / ${STRUCTURE_PERIOD}.0);
        float sum = 0.0;
        float residual = 0.0;
        float scale = 1.0;
        for (int k = 0; k < 4; k++) {
          float w = pow(0.5, float(k));
          float keep = clamp(2.0 - 2.0 * footprint * scale, 0.0, 1.0);
          float v = k == 0 ? o.r : k == 1 ? o.g : k == 2 ? o.b : o.a;
          sum += keep * w * (v - 0.5);
          residual += (1.0 - keep * keep) * w * w;
          scale *= 2.0;
        }
        return vec2(sum, sqrt(residual * ${VALUE_NOISE_VARIANCE.toFixed(5)}));
      }
      uniform mat4 projectionMatrix;

      const float PI = 3.14159265;

      /** Une grille, etage \`k\`, au point (est, nord) km. */
      vec4 gridSample(sampler2D tex, float spacingKm, vec2 enKm, float k) {
        float n = uGrid.x;
        float half_ = (n - 1.0) * 0.5;
        vec2 ij = clamp(enKm / spacingKm + half_, vec2(0.0), vec2(n - 1.0));
        return texture2D(tex, vec2((ij.x + 0.5) / n, (k * n + ij.y + 0.5) / (3.0 * n)));
      }
      /** Grille proche au centre, lointaine au-dela, raccord entre 15 et 21 km. */
      vec4 fieldAt(vec2 enKm, float k) {
        vec4 far = gridSample(uFar, uGrid.y, enKm, k);
        float edge = max(abs(enKm.x), abs(enKm.y));
        if (edge > 21.0) return far;
        vec4 near = gridSample(uNear, uGrid.z, enKm, k);
        return mix(near, far, smoothstep(15.0, 21.0, edge));
      }

      /** Point (est, nord) km sous le point du rayon a la distance \`t\` m. */
      vec2 groundPoint(vec3 d, float t, out vec3 up) {
        vec3 p = d * t + vec3(0.0, uObserverRadius, 0.0);
        up = normalize(p);
        // atan2 plutot qu'acos : l'angle au centre d'un point a 5 km vaut
        // 8·10⁻⁴ rad, et son cosinus ne se distingue plus de 1 en simple precision.
        float s = uObserverRadius * atan(length(p.xz), p.y) * 1e-3;
        vec2 h = vec2(d.x, -d.z);
        float hl = length(h);
        return hl > 1e-6 ? s * h / hl : vec2(0.0);
      }

      /**
       * Distance a laquelle le rayon croise la coquille situee \`h\` m au-dessus
       * de l'oeil, en sortant (\`entering\` faux) ou en entrant. −1 si jamais.
       *
       * Forme stable : les rayons terrestres au carre valent 4·10¹³, et leur
       * difference — ce qui compte — se perdrait en simple precision. On resout
       * donc t² + 2·r₀μ·t − h(2r₀ + h) = 0 sans jamais former r².
       */
      float shellHit(float mu, float h, bool entering) {
        float B = uObserverRadius * mu;
        float C = -h * (2.0 * uObserverRadius + h);
        float disc = B * B - C;
        if (disc < 0.0) return -1.0;
        float q = -(B + (B >= 0.0 ? 1.0 : -1.0) * sqrt(disc));
        float r1 = q;
        float r2 = abs(q) > 1e-6 ? C / q : 0.0;
        float lo = min(r1, r2);
        float hi = max(r1, r2);
        float t = entering ? lo : hi;
        return t > 0.0 ? t : -1.0;
      }

      /** Segment [t0, t1] du rayon dans la nappe, base \`hb\` et sommet \`ht\` au-dessus de l'oeil, m. */
      vec2 slabSegment(float mu, float hb, float ht) {
        if (hb > 0.0) {
          float t0 = shellHit(mu, hb, false);
          return t0 < 0.0 ? vec2(-1.0) : vec2(t0, shellHit(mu, ht, false));
        }
        if (ht >= 0.0) {
          float down = mu < 0.0 ? shellHit(mu, hb, true) : -1.0;
          return vec2(0.0, down > 0.0 ? down : shellHit(mu, ht, false));
        }
        float t0 = mu < 0.0 ? shellHit(mu, ht, true) : -1.0;
        if (t0 < 0.0) return vec2(-1.0);
        float down = shellHit(mu, hb, true);
        return vec2(t0, down > 0.0 ? down : shellHit(mu, ht, false));
      }

      vec3 skyAbove(float k) { return k < 0.5 ? uSkyAbove0 : k < 1.5 ? uSkyAbove1 : uSkyAbove2; }
      vec2 drift(float k) { return k < 0.5 ? uDrift0 : k < 1.5 ? uDrift1 : uDrift2; }
      float scaleOf(float k) { return k < 0.5 ? uScale.x : k < 1.5 ? uScale.y : uScale.z; }

      // --- Volume de l'etage bas -------------------------------------------

      /**
       * Seuil de profondeur dans le champ, en ecarts-types, selon la hauteur
       * relative dans la nappe. Nul a mi-hauteur : la fraction occupee y vaut
       * exactement la couverture du modele. Il monte vers le sommet — seul le
       * coeur d'une cellule y parvient, d'ou les dômes — et juste au-dessus de
       * la base, qui reste plate.
       */
      float volumeThreshold(float h) {
        return 1.4 * pow(smoothstep(0.35, 1.0, h), 1.5) + 0.5 * (1.0 - smoothstep(0.0, 0.05, h));
      }

      /**
       * Extinction de l'etage bas au point a \`t\` m sur le rayon \`dir\` parti
       * de \`origin\` (m, relatif a l'oeil). \`detail\` : le bruit 3D ronge les bords.
       */
      float volumeExtinction(vec3 pos, float footprint, bool detail) {
        vec3 up;
        float t = length(pos);
        vec3 dir = t > 0.0 ? pos / t : vec3(0.0, 1.0, 0.0);
        vec2 en = groundPoint(dir, t, up);
        // Hauteur au-dessus de l'oeil, forme stable (pas de difference de rayons).
        float muP = dir.y;
        float hEye = t * muP + t * t * (1.0 - muP * muP) / (2.0 * uObserverRadius);
        vec4 f = fieldAt(en, 0.0);
        float thickness = max(1.0, f.z - f.y);
        float h = (uEyeAltitude + hEye - f.y) / thickness;
        if (h < 0.0 || h > 1.0 || f.x <= 0.001 || f.w < 0.0) return 0.0;
        vec2 p = (en - drift(0.0)) / scaleOf(0.0);
        // Profondeur dans la cellule, en ecarts-types : > 0 dans le nuage.
        vec2 st = bakedStructure(p, footprint);
        float sigmaFull = ${structureSigma().toFixed(5)};
        float inside = (sigmaFull * cloudNormalQuantile(f.x) - st.x) / sigmaFull;
        // Forme de base, douce sur un ecart-type : c'est l'enveloppe. Le
        // detail ne l'erode qu'ensuite, et seulement la ou elle est deja
        // faible — le coeur reste plein, les bords se decoupent (Schneider 2015).
        float base = smoothstep(volumeThreshold(h) - 0.12, volumeThreshold(h) + 0.9, inside);
        if (!detail || base <= 0.0) return base * f.w / thickness;
        vec3 q = vec3(en.x, (uEyeAltitude + hEye) * 1e-3, en.y) / uDetailKm;
        vec4 b = texture(uDetail, q / ${DETAIL_PERIOD}.0);
        vec4 e = texture(uDetail, q * 3.7 / ${DETAIL_PERIOD}.0 + 0.37);
        // Bourgeons en haut (octaves repliees), filaments en bas (les memes,
        // inversees) : la convection bourgeonne, la base s'effiloche.
        float billow = 0.5 * (1.0 - abs(2.0 * b.r - 1.0)) + 0.3 * (1.0 - abs(2.0 * b.g - 1.0)) + 0.2 * b.b;
        float wisp = 1.0 - billow;
        float n = mix(wisp, billow, smoothstep(0.0, 0.25, h));
        n = 0.7 * n + 0.3 * (0.5 * e.r + 0.3 * e.g + 0.2 * e.b);
        // Contraste : le bruit somme se tasse autour de 0,5 ; etire, il decoupe.
        float erosion = smoothstep(0.3, 0.7, n) * (0.55 + 0.3 * h);
        float density = clamp((base - erosion) / max(1e-3, 1.0 - erosion), 0.0, 1.0);
        return density * f.w / thickness;
      }

      /**
       * Marche du rayon dans l'etage bas, de \`t0\` a \`t1\` m.
       *
       * Diffusion : l'ombre vers le Soleil est echantillonnee dans un cone, puis la
       * diffusion multiple est approchee par trois ordres a extinction, phase
       * et poids reduits de moitie a chaque ordre (Wrenninge, Kulla & Lundqvist
       * 2015) — l'approximation des rendus de production, qui rend le
       * blanchiment des nuages epais qu'une diffusion simple assombrirait.
       * Lumiere du ciel et du sol : demi-spheres isotropes, attenuees par la
       * profondeur de nuage au-dessus et au-dessous, en diffusion (1 − g).
       *
       * x : transmittance ; yzw : radiance diffusee, avant exposition et air.
       */
      vec4 volumeMarch(vec3 d, float t0, float t1, vec3 sunDir, vec3 sun, vec3 sky, vec3 atGround, float footprint, float g) {
        // Deux regimes (Schneider 2015) : a grands pas sur la seule enveloppe
        // tant qu'on est hors du nuage ; des qu'elle est touchee, un pas en
        // arriere et des pas fins, a l'echelle du detail, avec le detail. Apres
        // huit echantillons vides, on repart a grands pas.
        float coarse = max(80.0, (t1 - t0) / 48.0);
        float fine = max(15.0, 200.0 * uDetailKm);
        // Decalage de depart : bruit a gradient entrelace, tourne du nombre d'or
        // a chaque passe — les passes accumulees couvrent tout le pas.
        float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + 0.618034 * uPass);
        float T = 1.0;
        vec3 L = vec3(0.0);
        float cosTheta = dot(d, sunDir);
        float phase0 = cloudDropletPhase(uDroplet, cosTheta);
        float phase1 = cloudHenyeyGreenstein(0.5 * g, cosTheta);
        float phase2 = cloudHenyeyGreenstein(0.25 * g, cosTheta);
        // Base orthonormee autour du Soleil, pour le cone d'echantillons d'ombre.
        vec3 sa = normalize(cross(sunDir, abs(sunDir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        vec3 sb = cross(sunDir, sa);
        float t = t0 + jitter * coarse;
        bool inCloud = false;
        int empty = 0;
        for (int s = 0; s < 256; s++) {
          if (t > t1 || T < 0.01) break;
          vec3 pos = d * t;
          if (!inCloud) {
            if (volumeExtinction(pos, footprint, false) > 0.0) {
              inCloud = true;
              empty = 0;
              t = max(t0, t - coarse) + jitter * fine;
            } else {
              t += coarse;
            }
            continue;
          }
          float sigma = volumeExtinction(pos, footprint, true);
          if (sigma <= 0.0) {
            if (++empty > 8) inCloud = false;
            t += fine;
            continue;
          }
          empty = 0;
          // Ombre : cinq echantillons dans un cone vers le Soleil, de 30 a 480 m,
          // avec le detail pres du point ; puis un lointain, a 1,5 km, sur la
          // seule enveloppe — la masse du nuage au-dessus.
          float shadowTau = 0.0;
          float along = 0.0;
          float ds = 30.0;
          for (int k = 0; k < 5; k++) {
            float a = 2.39996 * float(k) + 6.2831853 * jitter;
            vec3 offset = (sa * cos(a) + sb * sin(a)) * (0.18 * (along + 0.5 * ds));
            shadowTau += volumeExtinction(pos + sunDir * (along + 0.5 * ds) + offset, footprint, k < 3) * ds;
            along += ds;
            ds *= 2.0;
          }
          shadowTau += volumeExtinction(pos + sunDir * 1500.0, footprint, false) * 1000.0;
          // Profondeur jusqu'au sommet et a la base, estimee sur la verticale locale.
          vec3 up;
          vec2 en = groundPoint(normalize(pos), length(pos), up);
          vec4 f = fieldAt(en, 0.0);
          float muP = d.y;
          float z = uEyeAltitude + t * muP + t * t * (1.0 - muP * muP) / (2.0 * uObserverRadius);
          float tauUp = sigma * max(0.0, f.z - z);
          float tauDown = sigma * max(0.0, z - f.y);
          // Effet « powder » : pres de la surface eclairee, il y a peu de nuage
          // autour du point pour y renvoyer de la lumiere diffusee plusieurs
          // fois. Les ordres multiples y sont reduits ; la diffusion simple
          // non. D'ou les bords sombres d'un cumulus vu dos au Soleil.
          float powder = 1.0 - exp(-2.0 * shadowTau);
          vec3 direct = sun * (
            phase0 * exp(-shadowTau)
            + powder * (0.5 * phase1 * exp(-0.5 * shadowTau) + 0.25 * phase2 * exp(-0.25 * shadowTau)));
          vec3 ambient = 0.5 * (sky / PI) * exp(-(1.0 - g) * tauUp)
            + 0.5 * (${GROUND_ALBEDO} * atGround / PI) * exp(-(1.0 - g) * tauDown);
          vec3 S = sigma * (direct + ambient);
          float stepT = exp(-sigma * fine);
          L += T * (S - S * stepT) / sigma;
          T *= stepT;
          t += fine;
        }
        return vec4(T, L);
      }


      /**
       * Ce que les nappes mettent devant ce qui est derriere elles, dans la
       * direction \`d\` : radiance premultipliee (rgb) et opacite (a).
       */
      vec4 cloudShade(vec3 d) {
        float mu = d.y;
        vec3 sunDir = normalize(uAerialSunDir);

        // Le sol arrete le rayon : rien au-dela.
        float tGround = mu < 0.0 ? shellHit(mu, uGroundAltitude - uEyeAltitude, true) : -1.0;

        // Par etage : distance, transmittance, radiance deja attenuee par l'air.
        float dist[3];
        float trans[3];
        vec3 light[3];
        float cover[3];
        for (int i = 0; i < 3; i++) { dist[i] = -1.0; trans[i] = 1.0; light[i] = vec3(0.0); cover[i] = 0.0; }

        for (int i = 0; i < 3; i++) {
          float k = float(i);
          // Hauteur de depart : celle de l'aplomb, puis celle du point traverse.
          vec3 up;
          vec4 f = fieldAt(vec2(0.0), k);
          vec2 seg = vec2(-1.0);
          for (int it = 0; it < 2; it++) {
            seg = slabSegment(mu, f.y - uEyeAltitude, f.z - uEyeAltitude);
            if (seg.x < 0.0) break;
            f = fieldAt(groundPoint(d, 0.5 * (seg.x + seg.y), up), k);
          }
          if (seg.x < 0.0 || f.x <= 0.001) continue;
          seg = slabSegment(mu, f.y - uEyeAltitude, f.z - uEyeAltitude);
          if (seg.x < 0.0 || (tGround > 0.0 && tGround < seg.x)) continue;
          if (tGround > 0.0) seg.y = min(seg.y, tGround);

          float tMid = 0.5 * (seg.x + seg.y);
          vec2 en = groundPoint(d, tMid, up);
          bool ice = f.w < 0.0;
          float tau = abs(f.w);
          float thickness = max(1.0, f.z - f.y);

          // --- Couverture : structure sous-maille, filtree au pixel et le long du trajet.
          float scale = scaleOf(k);
          vec2 p = (en - drift(k)) / scale;
          float pathKm = (seg.y - seg.x) * length(d.xz) * 1e-3;
          // Empreinte du pixel au point traverse, en unites de bruit : analytique,
          // car \`fwidth\` n'est pas defini dans des branches divergentes.
          float pixelKm = uPixelAngle * tMid * 1e-3 / max(abs(dot(d, up)), 0.08);
          float footprint = max(pixelKm / scale, pathKm / scale);
          float m = cloudExpectedCover(f.x, bakedStructure(p, footprint));
          // Pres de l'observateur, le volume deborde du point milieu : on ne le saute pas.
          float w = i == 0 && !ice ? 1.0 - smoothstep(${VOLUME_BLEND_M[0]}.0, ${VOLUME_BLEND_M[1]}.0, seg.x) : 0.0;
          if (m < 1e-3 && w <= 0.0) continue;

          // Les coeurs de cellule sont plus epais que leurs bords : l'epaisseur
          // optique suit la profondeur dans le champ, de moyenne inchangee.
          {
            vec2 st = bakedStructure(p, footprint);
            float inside = (${structureSigma().toFixed(5)} * cloudNormalQuantile(f.x) - st.x) / ${structureSigma().toFixed(5)};
            tau *= f.x > 0.98 ? 1.0 : clamp(0.35 + 0.45 * inside, 0.2, 2.2);
          }
          float tauSlant = tau * (seg.y - seg.x) / thickness;
          float tc = 1.0 - m * (1.0 - exp(-tauSlant));

          // --- Eclairage au point traverse.
          float mu0 = dot(sunDir, up);
          float muV = dot(d, up);
          float g = ice ? ${ICE_ASYMMETRY.toFixed(3)} : ${WATER_ASYMMETRY.toFixed(3)};
          float muS = max(abs(mu0), 0.02);
          float sunAlt = degrees(asin(clamp(mu0, -1.0, 1.0)));
          vec3 sun = texture2D(uSunTable, vec2(
            (sqrt(clamp((sunAlt + 10.0) / 100.0, 0.0, 1.0)) * ${SUN_TABLE_WIDTH - 1}.0 + 0.5) / ${SUN_TABLE_WIDTH}.0,
            (k + 0.5) / 3.0)).rgb;
          vec3 sky = skyAbove(k);
          // Les etages superieurs font ecran, au meme point.
          for (int j = 0; j < 3; j++) {
            if (j <= i) continue;
            vec4 o = fieldAt(en, float(j));
            float to = abs(o.w);
            sun *= 1.0 - o.x * (1.0 - exp(-to / muS));
            sky *= 1.0 - o.x * (1.0 - exp(-to * 2.0));
          }

          vec3 edS = cloudEddington(tau, g, muS);
          vec3 edD = cloudEddington(tau, g, 0.5);
          vec3 direct = sun * muS * edS.z;
          vec3 viaCloud = sun * muS * edS.y + sky * (edD.y + edD.z);
          float bounce = ${GROUND_ALBEDO} * edD.x;
          vec3 atGround = (direct + viaCloud) / (1.0 - bounce);
          // Soleil au-dessus : le sommet reflechit, la base transmet. Dessous : l'inverse.
          bool sunAbove = mu0 > 0.0;
          vec3 litSide = sun * muS * edS.x + sky * edD.x;
          vec3 darkSide = viaCloud + bounce * (direct + viaCloud) / (1.0 - bounce);
          if (!sunAbove) { vec3 s = litSide; litSide = darkSide; darkSide = s; }
          bool viewerBelow = muV > 0.0;
          vec3 diffuse = (viewerBelow ? darkSide : litSide) / PI;
          if (!viewerBelow) diffuse += (edD.y + edD.z) * ${GROUND_ALBEDO} * atGround / PI;

          // Premiere diffusion, vraie phase ; retiree de la part diffuse.
          float cosTheta = dot(d, sunDir);
          float phase = ice ? cloudIcePhase(cosTheta) : cloudDropletPhase(uDroplet, cosTheta);
          float mv = max(abs(muV), 0.02);
          bool transmitted = viewerBelow == sunAbove;
          float single = transmitted
            ? (abs(muS - mv) < 1e-3 ? tau / mv * exp(-tau / mv) : muS / (muS - mv) * (exp(-tau / muS) - exp(-tau / mv)))
            : muS / (muS + mv) * (1.0 - exp(-tau * (1.0 / muS + 1.0 / mv)));
          vec3 firstOrder = sun * phase * single;
          float once = exp(-(1.0 - g) * tau);
          diffuse = max(vec3(0.0), diffuse - once * sun * muS * (1.0 - edS.z) * 0.5 / PI);

          vec3 airT;
          vec3 haze = aerialPerspective(d, tMid, airT);
          dist[i] = seg.x;
          trans[i] = tc;
          cover[i] = m * (1.0 - exp(-tauSlant));
          // Ce que la nappe met a la place de ce qui est derriere elle.
          light[i] = (1.0 - tc) * haze + airT * m * (diffuse + firstOrder) * uAerialExposure;

          // --- Pres de l'observateur, l'etage bas prend du volume.
          if (w > 0.0) {
            float t1 = min(seg.y, seg.x + ${VOLUME_MAX_PATH_M}.0);
            vec4 v = volumeMarch(d, seg.x, t1, sunDir, sun, sky, atGround, uPixelAngle * seg.x * 1e-3 / scaleOf(0.0), g);
            float tcV = v.x;
            vec3 lightV = (1.0 - tcV) * haze + airT * v.yzw * uAerialExposure;
            trans[i] = mix(tc, tcV, w);
            light[i] = mix(light[i], lightV, w);
            cover[i] = mix(cover[i], 1.0 - tcV, w);
          }
        }

        // Composition d'arriere en avant.
        float A = 1.0;
        vec3 B = vec3(0.0);
        float nearest = 1e12;
        for (int pass = 0; pass < 3; pass++) {
          float far_ = -1.0;
          int pick = -1;
          for (int i = 0; i < 3; i++) {
            if (dist[i] > far_) { far_ = dist[i]; pick = i; }
          }
          if (pick < 0) break;
          for (int i = 0; i < 3; i++) {
            if (i == pick) {
              B = trans[i] * B + light[i];
              A *= trans[i];
              if (cover[i] > 0.3) nearest = min(nearest, dist[i]);
              dist[i] = -1.0;
            }
          }
        }
        return vec4(B, 1.0 - A);
      }

      /**
       * Distance de la premiere nappe couverte dans la direction \`d\`, m —
       * sans structure ni volume : c'est seulement l'ordre avec le relief.
       */
      float cloudNearest(vec3 d) {
        float mu = d.y;
        float tGround = mu < 0.0 ? shellHit(mu, uGroundAltitude - uEyeAltitude, true) : -1.0;
        float nearest = 1e12;
        for (int i = 0; i < 3; i++) {
          float k = float(i);
          vec3 up;
          vec4 f = fieldAt(vec2(0.0), k);
          vec2 seg = vec2(-1.0);
          for (int it = 0; it < 2; it++) {
            seg = slabSegment(mu, f.y - uEyeAltitude, f.z - uEyeAltitude);
            if (seg.x < 0.0) break;
            f = fieldAt(groundPoint(d, 0.5 * (seg.x + seg.y), up), k);
          }
          if (seg.x < 0.0 || f.x < 0.05) continue;
          if (tGround > 0.0 && tGround < seg.x) continue;
          nearest = min(nearest, max(1.0, seg.x));
        }
        return nearest;
      }
`

/**
 * Carte des directions : azimut en abscisse (0 au nord, vers l'est), hauteur
 * en ordonnee, de −12° a +90°. 4096 × 1152 texels, soit 0,09°. Un observateur
 * immobile qui ne fait que tourner la tete voit toujours les memes directions :
 * les nuages s'y calculent une fois, et l'ecran ne fait qu'une lecture.
 *
 * ## Deux cartes, et une construction silencieuse
 *
 * L'une est affichee, l'autre se construit. Changer d'heure lance la
 * construction d'une carte neuve pour le nouvel instant ; l'ancienne reste a
 * l'ecran, intacte, jusqu'a ce que la neuve ait sa premiere passe complete,
 * puis un fondu les echange. Rien ne bloque : le champ est calcule dans un
 * worker, et la marche sur la carte graphique est decoupee en bandes de
 * quelques lignes, a un rythme qui s'ajuste a la fluidite mesuree.
 *
 * ## L'accumulation
 *
 * Chaque texel est calcule en plusieurs passes, chacune avec un decalage de
 * depart different, et la carte en garde la somme : l'ecran divise par le
 * nombre de passes. Le bruit d'une marche a pas fixes se moyenne au lieu de
 * rester fige — c'est ce que les moteurs de jeu obtiennent par reprojection
 * temporelle, et qu'un observateur immobile obtient gratuitement.
 */
const CACHE_WIDTH = 4096
const CACHE_HEIGHT = 1152
const CACHE_MIN_ELEVATION_DEG = -12
/** Passes accumulees par carte. La premiere seule suffit a l'afficher. */
const CACHE_PASSES = 4
/** Lignes par image : bornes de la cadence adaptative, et cadence sous le loader. */
const ROWS_MIN = 4
const ROWS_MAX = 64
const ROWS_LOADING = 384
/** Au-dela de cet ecart entre l'instant affiche et l'instant simule, ms, la carte est refaite. */
const STALE_MS = 30_000
/** Au-dela de ce saut, ms, la construction en cours est abandonnee pour le nouvel instant. */
const RESTART_MS = 5 * 60_000
/** Duree du fondu entre deux cartes, ms. */
const FADE_MS = 500
/** Au-dela de cette vitesse du temps, les nuages sont retires : ils ne suivraient pas. */
const MAX_CLOUD_SPEED = 60
/**
 * Sous ce champ de vue, degres, le pixel de l'ecran devient plus fin que la
 * carte des directions (0,09°) : une carte alignee sur la vue prend le relais.
 */
const VIEW_MAX_FOV = 60
const drawingSize = new Vector2()
const rotationOnly = new Matrix4()
/** Couleur de fond du rendu, sauvee le temps d'effacer une carte. */
const clearColor = new Color()

const CACHE_GLSL = /* glsl */ `
  const float CACHE_MIN_ELEV = ${((CACHE_MIN_ELEVATION_DEG * Math.PI) / 180).toFixed(6)};
  vec3 cacheDirection(vec2 uv) {
    float az = uv.x * 6.28318531;
    float el = mix(CACHE_MIN_ELEV, 1.57079633, uv.y);
    return vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
  }
  vec2 cacheUv(vec3 d) {
    float az = atan(d.x, -d.z);
    float el = asin(clamp(d.y, -1.0, 1.0));
    return vec2(fract(az / 6.28318531), (el - CACHE_MIN_ELEV) / (1.57079633 - CACHE_MIN_ELEV));
  }
`

/** Remplissage : un quad plein ecran, une direction par texel, ajoutee a la somme. */
function cloudFillMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
    uniforms: cloudUniforms(),
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${CLOUD_SHADE_GLSL}
      ${CACHE_GLSL}
      varying vec2 vUv;
      void main() {
        gl_FragColor = cloudShade(cacheDirection(vUv));
      }
    `,
  })
}

/**
 * Carte de la vue, pour le zoom : le meme calcul, une direction par pixel de
 * l'ecran. Elle ne vaut que pour une visee et un champ donnes, et s'accumule
 * tant que la vue ne bouge pas.
 */
function cloudViewFillMaterial(): ShaderMaterial {
  const m = cloudFillMaterial()
  m.uniforms = { ...cloudUniforms(), uInvViewProj: { value: new Matrix4() } }
  m.fragmentShader = /* glsl */ `
    ${CLOUD_SHADE_GLSL}
    uniform mat4 uInvViewProj;
    varying vec2 vUv;
    void main() {
      vec4 w = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      gl_FragColor = cloudShade(normalize(w.xyz / w.w));
    }
  `
  return m
}

/** Affichage : les deux cartes normalisees et fondues, profondeur calee sur la premiere nappe. */
function cloudScreenMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: BackSide,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
    uniforms: {
      ...cloudUniforms(),
      uFront: { value: null as Texture | null },
      uBack: { value: null as Texture | null },
      uFrontPasses: { value: new Vector2(0, 0) },
      uBackPasses: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uExposureRatio: { value: new Vector2(1, 1) },
      uView: { value: null as Texture | null },
      uViewProj: { value: new Matrix4() },
      /** x : passes completes ; y : fraction de lignes de la suivante ; z : poids dans le fondu. */
      uViewPasses: { value: new Vector3(0, 0, 0) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vDir = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${CLOUD_SHADE_GLSL}
      ${CACHE_GLSL}
      uniform sampler2D uFront;
      uniform sampler2D uBack;
      /** x : passes completes de la carte affichee ; y : fraction des lignes deja faites de la suivante. */
      uniform vec2 uFrontPasses;
      uniform float uBackPasses;
      /** Poids de la carte affichee dans le fondu. */
      uniform float uFade;
      uniform float uOpacity;
      /** Exposition courante rapportee a celle de chaque carte (affichee, ancienne). */
      uniform vec2 uExposureRatio;
      uniform sampler2D uView;
      uniform mat4 uViewProj;
      uniform vec3 uViewPasses;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec2 uv = cacheUv(d);
        float nf = uFrontPasses.x + (uv.y < uFrontPasses.y ? 1.0 : 0.0);
        vec4 front = nf > 0.0 ? texture2D(uFront, uv) / nf : vec4(0.0);
        vec4 back = uBackPasses > 0.0 ? texture2D(uBack, uv) / uBackPasses : vec4(0.0);
        front.rgb *= uExposureRatio.x;
        back.rgb *= uExposureRatio.y;
        vec4 c = mix(back, front, uFade);
        // Carte de la vue, quand elle existe : meme instant que la carte affichee.
        if (uViewPasses.z > 0.0) {
          vec4 clipV = uViewProj * vec4(d, 1.0);
          vec2 vuv = clipV.xy / clipV.w * 0.5 + 0.5;
          float nv = uViewPasses.x + (vuv.y < uViewPasses.y ? 1.0 : 0.0);
          if (nv > 0.0) {
            vec4 view = texture2D(uView, vuv) / nv;
            view.rgb *= uExposureRatio.x;
            c = mix(c, view, uViewPasses.z * uFade);
          }
        }
        c *= uOpacity;
        if (c.a < 0.002) discard;
        // Profondeur : la loi du relief, pour que l'un masque l'autre juste.
        float nearest = cloudNearest(d);
        float depthR = 7.375 * log(max(0.5, min(nearest, 2e6)) / 0.5) / log(10.0) + 0.3;
        vec4 clip = projectionMatrix * viewMatrix * vec4(d * depthR, 1.0);
        gl_FragDepth = clamp(0.5 * clip.z / clip.w + 0.5, 0.0, 1.0);
        gl_FragColor = c;
      }
    `,
  })
}

/** Une carte et ce qui a servi a la construire. */
interface CloudBuffer {
  target: WebGLRenderTarget
  far: DataTexture | null
  near: DataTexture | null
  sun: DataTexture | null
  /** Instant decrit, ms. */
  timeMs: number
  /**
   * Exposition de la construction. La carte garde une radiance exposee ;
   * l'ecran applique le rapport a l'exposition courante, pour que
   * l'adaptation de l'oeil ne demande pas de recalculer les nuages.
   */
  exposure: number
  /** Passes completes. */
  passes: number
  /** Etages a l'aplomb et vent : ce qui cale l'eclairage et la derive. */
  overhead: CloudSlab[]
  windMS: [number, number][]
}

function makeBuffer(): CloudBuffer {
  return {
    target: new WebGLRenderTarget(CACHE_WIDTH, CACHE_HEIGHT, {
      type: HalfFloatType,
      depthBuffer: false,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      wrapS: RepeatWrapping,
      wrapT: ClampToEdgeWrapping,
    }),
    far: null,
    near: null,
    sun: null,
    timeMs: Number.NaN,
    exposure: 1,
    passes: 0,
    overhead: [],
    windMS: [],
  }
}

function clearTarget(gl: WebGLRenderer, target: WebGLRenderTarget) {
  const previous = gl.getRenderTarget()
  const color = gl.getClearColor(clearColor)
  const alpha = gl.getClearAlpha()
  target.scissorTest = false
  gl.setRenderTarget(target)
  gl.setClearColor(0x000000, 0)
  gl.clear(true, false, false)
  gl.setClearColor(color, alpha)
  gl.setRenderTarget(previous)
}

/** Publie l'avancement dans le store, seulement quand il change visiblement. */
function publishProgress(progress: number | null, ready: boolean) {
  const s = useSkyStore.getState()
  const q = progress == null ? null : Math.round(progress * 50) / 50
  if (s.cloudProgress !== q || s.cloudsReady !== ready) useSkyStore.setState({ cloudProgress: q, cloudsReady: ready })
}

export function CloudLayer({
  observerElevationM,
  extraHeightM,
  sunDirection,
  skyExposure,
}: {
  observerElevationM: number
  extraHeightM: number
  sunDirection: readonly [number, number, number]
  skyExposure: number
}) {
  const scenarioId = useSkyStore((s) => s.weatherScenario?.id ?? null)
  const [scenario, setScenario] = useState<WeatherScenario | null>(null)
  useEffect(() => {
    let alive = true
    setScenario(null)
    if (scenarioId) void loadScenario(scenarioId).then((s) => alive && setScenario(s))
    return () => {
      alive = false
    }
  }, [scenarioId])

  const fill = useMemo(cloudFillMaterial, [])
  const viewFill = useMemo(cloudViewFillMaterial, [])
  const screen = useMemo(cloudScreenMaterial, [])
  const buffers = useMemo<[CloudBuffer, CloudBuffer]>(() => [makeBuffer(), makeBuffer()], [])
  const fillPass = useMemo(() => {
    const scene = new Scene()
    const quad = new Mesh(new PlaneGeometry(2, 2), fill)
    quad.frustumCulled = false
    scene.add(quad)
    return { scene, quad, camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1) }
  }, [fill])
  const view = useMemo(
    () => ({
      target: null as WebGLRenderTarget | null,
      key: '',
      passes: 0,
      row: 0,
      building: false,
      readyAt: -Infinity,
      viewProj: new Matrix4(),
    }),
    [],
  )
  useEffect(
    () => () => {
      for (const b of buffers) {
        b.target.dispose()
        b.far?.dispose()
        b.near?.dispose()
        b.sun?.dispose()
      }
      fill.dispose()
      viewFill.dispose()
      view.target?.dispose()
      screen.dispose()
      publishProgress(null, false)
    },
    [buffers, fill, viewFill, view, screen],
  )

  const mesh = useRef<Mesh>(null)
  const state = useRef({
    scenarioId: null as string | null,
    front: 0,
    /** Carte en construction, passe et ligne courantes. */
    build: null as { buffer: number; pass: number; row: number } | null,
    /** Instant demande au worker, ou null. */
    waitingFor: null as number | null,
    fadeStart: -Infinity,
    rows: 16,
    opacity: 0,
  })

  useFrame(({ gl, camera }, delta) => {
    const st = state.current
    const store = useSkyStore.getState()
    const u = fill.uniforms
    const su = screen.uniforms

    if (!scenario) {
      if (mesh.current) mesh.current.visible = false
      return
    }
    if (!u.uStructure.value) {
      const noise = cloudNoiseTextures(gl)
      u.uStructure.value = noise.structure
      u.uDetail.value = noise.detail
    }

    // Nouveau scenario : les deux cartes repartent de zero.
    if (st.scenarioId !== scenario.id) {
      st.scenarioId = scenario.id
      st.build = null
      st.waitingFor = null
      for (const b of buffers) {
        b.passes = 0
        b.timeMs = Number.NaN
        clearTarget(gl, b.target)
      }
    }

    // Avance rapide : les nuages s'effacent et ne se construisent plus.
    const hidden = store.playing && store.speed > MAX_CLOUD_SPEED
    st.opacity = Math.min(1, Math.max(0, st.opacity + (hidden ? -delta : delta) * 3))
    const time = store.time
    const front = buffers[st.front]

    if (!hidden) {
      // --- Faut-il une carte neuve ?
      const buildingFirstPass = st.build != null && st.build.buffer !== st.front
      const target = st.waitingFor ?? (buildingFirstPass ? buffers[st.build!.buffer].timeMs : front.timeMs)
      const stale = front.passes === 0 || !(Math.abs(time - front.timeMs) <= STALE_MS)
      const jumped = !(Math.abs(time - target) <= RESTART_MS)
      const fading = performance.now() - st.fadeStart < FADE_MS
      // Rien avant que l'atmosphere du lieu soit prete : la carte en garderait
      // un eclairage et une exposition nuls.
      const atmosphereReady = aerialSkyReady()
      if (atmosphereReady && (stale && st.waitingFor == null && !buildingFirstPass && !fading) || ((st.waitingFor != null || buildingFirstPass) && jumped)) {
        if (buildingFirstPass) st.build = null
        st.waitingFor = time
        const id = scenario.id
        void requestCloudField(id, time).then((r) => {
          if (st.scenarioId !== id) return
          const b = buffers[1 - st.front]
          b.far = uploadField(b.far, r.far, r.n)
          b.near = uploadField(b.near, r.near, r.n)
          b.sun = uploadSunTable(r.sunTable, b.sun)
          b.timeMs = r.timeMs
          b.passes = 0
          b.overhead = r.overhead
          b.windMS = r.windMS
          b.exposure = Number.NaN
          clearTarget(gl, b.target)
          st.waitingFor = null
          st.build = { buffer: 1 - st.front, pass: 0, row: 0 }
        })
      }

      // --- Une bande de la carte en construction.
      if (st.build) {
        const b = buffers[st.build.buffer]
        if (delta > 1 / 45) st.rows = Math.max(ROWS_MIN, Math.floor(st.rows * 0.8))
        else if (delta < 1 / 58) st.rows = Math.min(ROWS_MAX, st.rows + 1)
        const budget = store.sceneLoading ? ROWS_LOADING : st.rows
        const rows = Math.min(budget, CACHE_HEIGHT - st.build.row)

        u.uPixelAngle.value = Math.max((2 * Math.PI) / CACHE_WIDTH, ((90 - CACHE_MIN_ELEVATION_DEG) * Math.PI) / 180 / CACHE_HEIGHT)
        applyAerialUniforms(u as unknown as ReturnType<typeof aerialUniforms>, sunDirection, skyExposure)
        // Une seule exposition par carte, celle du debut de sa construction.
        if (!Number.isFinite(b.exposure)) b.exposure = u.uAerialExposure.value
        u.uAerialExposure.value = b.exposure
        applyBufferUniforms(u, b, scenario, observerElevationM, extraHeightM)
        u.uPass.value = st.build.pass

        const previousTarget = gl.getRenderTarget()
        const previousAutoClear = gl.autoClear
        b.target.scissor.set(0, st.build.row, CACHE_WIDTH, rows)
        b.target.scissorTest = true
        b.target.viewport.set(0, 0, CACHE_WIDTH, CACHE_HEIGHT)
        gl.autoClear = false
        gl.setRenderTarget(b.target)
        gl.render(fillPass.scene, fillPass.camera)
        gl.setRenderTarget(previousTarget)
        gl.autoClear = previousAutoClear

        st.build.row += rows
        if (st.build.row >= CACHE_HEIGHT) {
          st.build.pass++
          st.build.row = 0
          b.passes = st.build.pass
          // Premiere passe complete : la carte neuve passe a l'ecran, en fondu,
          // et la suite de l'accumulation s'y fait en place.
          if (st.build.buffer !== st.front) {
            st.front = st.build.buffer
            st.fadeStart = performance.now()
          }
          if (st.build.pass >= CACHE_PASSES) st.build = null
        }
      }
    }

    // --- Carte de la vue, quand on zoome au-dela de la finesse de la carte.
    const shownBuffer = buffers[st.front]
    const fov = (camera as PerspectiveCamera).fov ?? 90
    const size = gl.getDrawingBufferSize(drawingSize)
    const zoomed = fov < VIEW_MAX_FOV && shownBuffer.passes > 0 && !hidden
    if (zoomed) {
      camera.updateMatrixWorld()
      const q = camera.quaternion
      const key =
        [q.x, q.y, q.z, q.w].map((v) => v.toFixed(5)).join(':') +
        `:${fov.toFixed(3)}:${st.front}:${shownBuffer.timeMs}:${size.x}x${size.y}`
      if (key !== view.key) {
        view.key = key
        if (!view.target || view.target.width !== size.x || view.target.height !== size.y) {
          view.target?.dispose()
          view.target = new WebGLRenderTarget(size.x, size.y, {
            type: HalfFloatType,
            depthBuffer: false,
            magFilter: LinearFilter,
            minFilter: LinearFilter,
          })
        }
        clearTarget(gl, view.target)
        view.passes = 0
        view.row = 0
        view.building = true
        view.readyAt = -Infinity
        view.viewProj.multiplyMatrices(camera.projectionMatrix, rotationOnly.extractRotation(camera.matrixWorldInverse))
      }
      // La carte des directions d'abord : la vue ne se construit qu'une fois celle-ci a l'ecran.
      const firstPassPending = st.waitingFor != null || (st.build != null && st.build.buffer !== st.front)
      if (view.building && !firstPassPending && view.target) {
        const vu = viewFill.uniforms
        applyAerialUniforms(vu as unknown as ReturnType<typeof aerialUniforms>, sunDirection, skyExposure)
        vu.uAerialExposure.value = shownBuffer.exposure
        applyBufferUniforms(vu, shownBuffer, scenario, observerElevationM, extraHeightM)
        vu.uStructure.value = u.uStructure.value
        vu.uDetail.value = u.uDetail.value
        vu.uPixelAngle.value = (fov * Math.PI) / 180 / size.y
        vu.uPass.value = view.passes
        ;(vu.uInvViewProj.value as Matrix4).copy(view.viewProj).invert()
        const rows = Math.min(store.sceneLoading ? ROWS_LOADING : st.rows, size.y - view.row)
        const previousTarget = gl.getRenderTarget()
        const previousAutoClear = gl.autoClear
        view.target.scissor.set(0, view.row, size.x, rows)
        view.target.scissorTest = true
        view.target.viewport.set(0, 0, size.x, size.y)
        gl.autoClear = false
        fillPass.quad.material = viewFill
        gl.setRenderTarget(view.target)
        gl.render(fillPass.scene, fillPass.camera)
        fillPass.quad.material = fill
        gl.setRenderTarget(previousTarget)
        gl.autoClear = previousAutoClear
        view.row += rows
        if (view.row >= size.y) {
          view.row = 0
          view.passes++
          if (view.passes === 1) view.readyAt = performance.now()
          if (view.passes >= CACHE_PASSES) view.building = false
        }
      }
    } else if (view.key) {
      view.key = ''
      view.passes = 0
    }

    // --- Affichage.
    const shown = buffers[st.front]
    const old = buffers[1 - st.front]
    const refining = st.build != null && st.build.buffer === st.front
    su.uFront.value = shown.target.texture
    su.uBack.value = old.target.texture
    ;(su.uFrontPasses.value as Vector2).set(shown.passes, refining ? st.build!.row / CACHE_HEIGHT : 0)
    su.uFade.value = Math.min(1, (performance.now() - st.fadeStart) / FADE_MS)
    su.uBackPasses.value = su.uFade.value < 1 ? old.passes : 0
    su.uOpacity.value = st.opacity
    applyAerialUniforms(su as unknown as ReturnType<typeof aerialUniforms>, sunDirection, skyExposure)
    const exposure = su.uAerialExposure.value
    ;(su.uExposureRatio.value as Vector2).set(exposure / (shown.exposure || 1), exposure / (old.exposure || 1))
    if (shown.passes > 0) applyBufferUniforms(su, shown, scenario, observerElevationM, extraHeightM)
    const viewWeight = zoomed && view.passes > 0 ? Math.min(1, (performance.now() - view.readyAt) / FADE_MS) : 0
    su.uView.value = view.target?.texture ?? null
    ;(su.uViewProj.value as Matrix4).copy(view.viewProj)
    ;(su.uViewPasses.value as Vector3).set(
      view.passes,
      view.building ? view.row / Math.max(1, view.target?.height ?? 1) : 0,
      viewWeight,
    )
    if (mesh.current) mesh.current.visible = st.opacity > 0 && shown.passes > 0

    const firstPass = st.waitingFor != null || (st.build != null && st.build.buffer !== st.front)
    const progress = hidden || !firstPass ? null : st.build ? st.build.row / CACHE_HEIGHT : 0
    publishProgress(progress, shown.passes > 0)
    if (import.meta.env.DEV)
      (window as unknown as { __clouds: unknown }).__clouds = {
        front: st.front,
        passes: shown.passes,
        build: st.build && { ...st.build },
        view: { passes: view.passes, row: view.row, building: view.building, zoomed, weight: viewWeight },
        rows: st.rows,
      }
  })

  if (!scenario) return null
  return (
    <mesh ref={mesh} material={screen} renderOrder={27} frustumCulled={false} visible={false}>
      <sphereGeometry args={[GROUND_RADIUS * 0.9, 64, 32]} />
    </mesh>
  )
}

/** Uniformes qui decrivent une carte : son champ, sa table du Soleil, sa derive, son observateur. */
function applyBufferUniforms(
  u: ShaderMaterial['uniforms'],
  b: CloudBuffer,
  scenario: WeatherScenario,
  observerElevationM: number,
  extraHeightM: number,
) {
  u.uFar.value = b.far
  u.uNear.value = b.near
  u.uSunTable.value = b.sun
  u.uGrid.value.set(scenario.grids.far.n, scenario.grids.far.spacingKm, scenario.grids.near.spacingKm)
  if (b.overhead.length === 3) {
    // Ciel au-dessus de chaque etage : la diffusion du ciel suit l'air qu'il reste au-dessus.
    const sky = aerialTextures.skyIrradiance
    const seconds = (b.timeMs - Date.parse(`${scenario.times[0]}Z`)) / 1000
    b.overhead.forEach((s, k) => {
      const f = standardPressure(s.topM) / SEA_LEVEL_PRESSURE_PA
      ;(u[`uSkyAbove${k}`].value as Vector3).set(sky[0] * f, sky[1] * f, sky[2] * f)
      // Derive des structures avec le vent de l'etage, depuis minuit du scenario.
      const [e, n] = b.windMS[k]
      ;(u[`uDrift${k}`].value as Vector2).set((e * seconds) / 1000, (n * seconds) / 1000)
    })
    // Taille des cellules de l'etage bas et de leur detail, tiree de l'epaisseur
    // a l'aplomb : un cumulus est a peu pres aussi large que haut, et leur
    // espacement vaut quelques fois leur taille. Une cellule de 4 km sur un
    // nuage de 300 m ferait une galette.
    const depthKm = Math.max(0.1, (b.overhead[0].topM - b.overhead[0].baseM) / 1000)
    u.uScale.value.x = Math.min(STRUCTURE_SCALE_KM[0], Math.max(0.8, CELL_TO_DEPTH * depthKm))
    u.uDetailKm.value = Math.min(0.6, Math.max(0.12, 0.45 * depthKm))
  }
  const eye = eyeAltitudeM(observerElevationM, extraHeightM)
  u.uObserverRadius.value = EARTH_MEAN_RADIUS_M + eye
  u.uEyeAltitude.value = eye
  // Le sol un peu sous le site : le relief reel le remplace de pres.
  u.uGroundAltitude.value = observerElevationM - 50
}
