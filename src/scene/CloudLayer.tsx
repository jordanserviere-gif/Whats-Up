import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BackSide,
  ClampToEdgeWrapping,
  CustomBlending,
  DataTexture,
  DataUtils,
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
import { CLOUD_LAYER_GLSL, ICE_ASYMMETRY, WATER_ASYMMETRY } from '@/atmosphere/cloud/cloudLayer'
import { EARTH_MEAN_RADIUS_M } from '@/atmosphere/core/units'
import { SEA_LEVEL_PRESSURE_PA, standardPressure } from '@/atmosphere/thermodynamics/standardAtmosphere'
import { loadScenario, type WeatherScenario } from '@/data-sources/weatherScenario'
import { useSkyStore } from '@/state/store'
import { aerialTextures, aerialUniforms, applyAerialUniforms } from './useAerialLut'
import { sunIrradianceAtAltitude } from './contrailLighting'
import { buildCloudField, type CloudFieldFrame } from './cloudField'
import { eyeAltitudeM } from './terrain/elevationField'
import { GROUND_RADIUS } from './sceneMath'

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

/** Echelle de la plus grande structure de chaque etage, km. */
const STRUCTURE_SCALE_KM: [number, number, number] = [4, 3, 8]
/** Albedo du sol sous les nuages, pour les rebonds sol-nuage. */
const GROUND_ALBEDO = 0.15
/** Diametre des gouttes pour la phase : 2 × 8 µm de rayon effectif. */
const DROPLET = dropletPhaseParameters(16)

/** Table du Soleil vu d'un etage : hauteur locale de −10 a 90°, resserree pres de l'horizon. */
const SUN_TABLE_WIDTH = 64
const sunTableAltitude = (u: number) => -10 + 100 * u * u

function sunTable(heightsM: number[], previous: DataTexture | null): DataTexture {
  const data = new Uint16Array(SUN_TABLE_WIDTH * 3 * 4)
  heightsM.forEach((h, k) => {
    for (let i = 0; i < SUN_TABLE_WIDTH; i++) {
      const rgb = sunIrradianceAtAltitude(sunTableAltitude(i / (SUN_TABLE_WIDTH - 1)), h)
      const o = (k * SUN_TABLE_WIDTH + i) * 4
      data[o] = DataUtils.toHalfFloat(rgb[0])
      data[o + 1] = DataUtils.toHalfFloat(rgb[1])
      data[o + 2] = DataUtils.toHalfFloat(rgb[2])
      data[o + 3] = DataUtils.toHalfFloat(1)
    }
  })
  if (previous) {
    ;(previous.image.data as unknown as Uint16Array).set(data)
    previous.needsUpdate = true
    return previous
  }
  const t = new DataTexture(data, SUN_TABLE_WIDTH, 3, RGBAFormat, HalfFloatType)
  t.magFilter = LinearFilter
  t.minFilter = LinearFilter
  t.wrapS = ClampToEdgeWrapping
  t.wrapT = ClampToEdgeWrapping
  t.needsUpdate = true
  return t
}

function cloudMaterial(): ShaderMaterial {
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
      ${AERIAL_LUT_GLSL}
      ${CLOUD_PHASE_GLSL}
      ${CLOUD_LAYER_GLSL}
      varying vec3 vDir;
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

      void main() {
        vec3 d = normalize(vDir);
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
          float footprint = max(length(fwidth(p)), pathKm / scale);
          float m = cloudExpectedCover(f.x, cloudStructure(p, footprint));
          if (m < 1e-3) continue;

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
        if (A > 0.999) discard;
        if (nearest > 1e11) {
          for (int i = 0; i < 3; i++) if (trans[i] < 1.0) nearest = min(nearest, max(1.0, dist[i]));
        }

        // Profondeur : la loi du relief, pour que l'un masque l'autre juste.
        float depthR = 7.375 * log(max(0.5, nearest) / 0.5) / log(10.0) + 0.3;
        vec4 clip = projectionMatrix * viewMatrix * vec4(d * depthR, 1.0);
        gl_FragDepth = clamp(0.5 * clip.z / clip.w + 0.5, 0.0, 1.0);
        gl_FragColor = vec4(B, 1.0 - A);
      }
    `,
  })
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

  const material = useMemo(cloudMaterial, [])
  const field = useRef<CloudFieldFrame | null>(null)
  const fieldKey = useRef('')
  const tableKey = useRef('')
  const table = useRef<DataTexture | null>(null)

  useFrame(() => {
    if (!scenario) return
    const u = material.uniforms
    applyAerialUniforms(u as unknown as ReturnType<typeof aerialUniforms>, sunDirection, skyExposure)
    const time = useSkyStore.getState().time

    // Le champ change a la minute : le modele est horaire, l'interpolation lisse.
    const key = `${scenario.id}:${Math.floor(time / 60_000)}`
    if (key !== fieldKey.current) {
      fieldKey.current = key
      field.current = buildCloudField(scenario, time, field.current)
      u.uFar.value = field.current.far
      u.uNear.value = field.current.near
      u.uGrid.value.set(scenario.grids.far.n, scenario.grids.far.spacingKm, scenario.grids.near.spacingKm)
    }
    const frame = field.current
    if (!frame) return

    // Tables du Soleil a l'altitude du sommet de chaque etage, a 250 m pres.
    const tops = frame.overhead.map((s) => Math.round(s.topM / 250) * 250)
    const tk = tops.join(':')
    if (tk !== tableKey.current) {
      tableKey.current = tk
      table.current = sunTable(tops, table.current)
      u.uSunTable.value = table.current
    }

    // Ciel au-dessus de chaque etage : la diffusion du ciel suit l'air qu'il reste au-dessus.
    const sky = aerialTextures.skyIrradiance
    frame.overhead.forEach((s, k) => {
      const f = standardPressure(s.topM) / SEA_LEVEL_PRESSURE_PA
      ;(u[`uSkyAbove${k}`].value as Vector3).set(sky[0] * f, sky[1] * f, sky[2] * f)
      // Derive des structures avec le vent de l'etage, depuis minuit du scenario.
      const seconds = (time - Date.parse(`${scenario.times[0]}Z`)) / 1000
      const [e, n] = frame.windMS[k]
      ;(u[`uDrift${k}`].value as Vector2).set((e * seconds) / 1000, (n * seconds) / 1000)
    })

    const eye = eyeAltitudeM(observerElevationM, extraHeightM)
    u.uObserverRadius.value = EARTH_MEAN_RADIUS_M + eye
    u.uEyeAltitude.value = eye
    // Le sol un peu sous le site : le relief reel le remplace de pres.
    u.uGroundAltitude.value = observerElevationM - 50
  })

  if (!scenario) return null
  return (
    <mesh material={material} renderOrder={27} frustumCulled={false}>
      <sphereGeometry args={[GROUND_RADIUS * 0.9, 64, 32]} />
    </mesh>
  )
}
