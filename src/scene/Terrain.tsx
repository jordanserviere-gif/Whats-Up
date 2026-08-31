/**
 * Mode debug atmosphere — une chaine de montagnes comme banc de mesure.
 *
 * ## Ce qu'il sert a voir
 *
 * La table de perspective atmospherique est parametree en **distance**, sur
 * seize tranches. Jusqu'ici une seule servait : le fond de ciel lit la tranche a
 * l'infini, et les avions lisent une distance uniforme par appareil. Rien dans
 * la scene ne faisait varier la distance **a l'interieur d'une meme image**.
 *
 * Ce calque le fait, et de la facon la plus lisible possible : une chaine
 * rectiligne qui passe a quinze kilometres a l'est, longue de six cents. Tout y
 * est constant sauf la distance, qui va de 15 a 300 km continument. **Chaque
 * ecart d'aspect le long de la chaine est donc un effet de distance**, et rien
 * d'autre — pas un changement d'albedo, pas un changement d'eclairement.
 *
 * On y lit ensemble les trois choses que le moteur calcule :
 *
 * - l'**extinction** de Rayleigh, qui mange le contraste des cretes lointaines ;
 * - la **diffusion en avant**, qui les bleuit en ajoutant sa propre lumiere ;
 * - la **courbure de la Terre**, qui finit par avaler la chaine vers 244 km.
 *
 * ## L'eclairement est calcule, pas pose
 *
 *     L = (albedo/π)·(E_direct·cos θ + E_ciel·V_ciel)·T(d) + L_diffusee(d)
 *
 * Les deux eclairements viennent du moteur : `directSolar` pour le spectre
 * solaire transmis le long du trajet oblique reel, `measureSkyIrradiance` pour
 * ce que le ciel entier depose sur un plan — mesure **sur la table qui
 * s'affiche**, donc sur le meme ciel que celui qu'on voit.
 *
 * Les deux sortent du meme operateur `spectralToLinearSrgb` que la table
 * elle-meme. Leurs unites sont donc coherentes **par construction**, sans
 * facteur de raccord : la surface et le ciel qui l'eclaire traversent la meme
 * exposition. C'est ce qui fait de ce calque un banc et non une decoration — si
 * l'echelle radiometrique du moteur etait fausse, la chaine sortirait
 * visiblement trop claire ou trop sombre.
 *
 * ## Sa propre compression de profondeur
 *
 * `sceneDepth` ecrete sous le kilometre — elle est calibree pour des objets
 * ponctuels lointains, et un avion ne descend pas plus bas. Le terrain, lui, est
 * le seul objet de la scene a couvrir **trois decades de distance en continu**,
 * du premier plan a l'horizon. Il lui faut donc sa propre droite, de meme pente
 * mais ancree vingt metres devant l'observateur.
 *
 * Son point le plus lointain reste a 31 en profondeur de scene, bien en deca des
 * 42 de la Lune : l'ordre d'occultation avec le reste de la scene est preserve.
 *
 * ## ⚠️ Ce que ce calque ne modelise pas
 *
 * **Les ombres portees, et pas seulement sur la surface.** Seul l'auto-ombrage
 * du premier ordre existe, par le `max(0, N·L)` : une face opposee au Soleil est
 * sombre. Mais une vallee ne recoit pas l'ombre de la crete qui la domine.
 *
 * ⚠️ **Plus grave : l'air non plus n'est pas ombre.** La table de perspective
 * atmospherique est calculee pour une atmosphere **sans relief**, donc partout
 * eclairee par un Soleil que rien ne masque. Quand le Soleil se leve derriere la
 * chaine, l'air situe entre elle et l'observateur est dans son ombre — le
 * modele, lui, l'eclaire en plein, et le pic de diffusion avant de Mie y sature
 * a blanc. Ce n'est pas le disque qui traverse la montagne : c'est la brume
 * devant elle qui brille comme si la montagne n'existait pas.
 *
 * Le corriger demanderait de porter l'ombre du relief dans le transport, donc
 * une carte d'ombre echantillonnee le long de chaque pas de la marche.
 *
 * **Le facteur de vue du ciel** est l'approximation plane `(1 + N_y)/2`, sans
 * occlusion par le relief voisin. Le fond d'une vallee voit en realite moins de
 * ciel.
 *
 * **Le relief n'est pas un modele geologique** — bruit de valeur fractal a
 * graine fixe. C'est une surface de test ; ce qui est physique, c'est ce que
 * l'atmosphere en fait.
 */
import { useEffect, useMemo, useState } from 'react'
import { useSkyStore } from '@/state/store'
import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  FloatType,
  LinearFilter,
  RedFormat,
  ShaderMaterial,
  Vector3,
} from 'three'
import { useFrame } from '@react-three/fiber'
import { AERIAL_LUT_GLSL } from '@/atmosphere/lut/aerialPerspectiveLut'
import { DISPLAY_TONEMAP_GLSL } from './display/tonemap'
import { aerialTextures, aerialUniforms, applyAerialUniforms } from './useAerialLut'
import { cachedHorizonDipDeg } from './Globe'
import { SHADOW_HALF_SPAN_M, SHADOW_SIZE, buildSunShadowMap } from './terrain/sunShadow'
import {
  SNOW_LINE_M,
  apparentElevationRad,
  effectiveEarthRadiusM,
  horizonRangeM,
} from './terrain/ridgeField'
import {
  eyeAltitudeM,
  groundAltitudeM,
  observerGroundM,
  terrainPeakM,
  terrainRevision,
} from './terrain/elevationField'
import { CLIPMAP_HALF_SPANS_M } from './terrain/elevationClipmap'
import { loadElevationAround } from './terrain/elevationSource'

/** Secteurs d'azimut du maillage. */
const AZIMUTH_STEPS = 512
/** Anneaux de distance, espaces en logarithme. */
const RANGE_STEPS = 208
/**
 * Distance du premier anneau, metres.
 *
 * ⚠️ **Vingt metres etait un reste du banc synthetique.** Sa plaine valait zero
 * et l'observateur la survolait de trente-cinq metres : a vingt metres, le sol
 * apparaissait deja soixante degres sous l'horizon, et le premier anneau
 * couvrait le nadir.
 *
 * Le relief reel a supprime cette hauteur. L'oeil repose desormais a
 * `EYE_HEIGHT_M` du sol, et a vingt metres celui-ci n'est plus qu'a **cinq
 * degres** sous l'horizon : tout l'hemisphere inferieur devenait un trou, ou
 * l'on voyait passer les constellations. Un demi-metre le referme jusqu'a
 * soixante-treize degres.
 *
 * ⚠️ **Ces trois nombres ont ete reduits sur une mesure fausse, puis retablis.**
 * Un banc rendait une seconde par image, et j'en avais conclu un cout de
 * remplissage. C'etait le **bridage de `requestAnimationFrame`** : un onglet sans
 * le focus est cadence a 1 Hz par le navigateur, et la comparaison opposait une
 * fenetre au premier plan a une fenetre en arriere-plan.
 *
 * Verifie depuis, focus rendu : **6,1 ms** avec le terrain, l'atmosphere et la
 * table doublee. Le cout n'existait pas.
 */
const NEAR_M = 0.5
/**
 * Distance du dernier anneau, metres.
 *
 * Un sommet de quatre mille metres rase l'horizon a 244 km ; mailler au-dela ne
 * montrerait plus rien. La marge porte la limite a la distance ou meme le
 * sommet le plus haut a disparu.
 */
/**
 * Jusqu'ou mailler, metres.
 *
 * Deux bornes, et la plus serree gagne.
 *
 * La premiere est **optique** : au-dela de la distance ou le plus haut sommet
 * connu rase l'horizon, il n'y a plus rien a voir.
 *
 * La seconde est celle de la **donnee**. Le maillage portait autrefois jusqu'a
 * six cent quatre-vingt-dix-sept kilometres depuis sept mille metres, alors que
 * la pyramide s'arrete a quatre cent cinquante : les anneaux au-dela retombaient
 * au niveau de la mer et dessinaient une **marche nette a l'horizon**. On ne
 * maille pas du terrain dont on ignore tout ; le globe prend le relais, et il y
 * est justement au niveau de la mer, comme la pyramide hors de son domaine.
 */
const farRangeM = (observerElevationM: number, effectiveRadiusM: number): number =>
  Math.min(
    horizonRangeM(terrainPeakM() * 1.05, observerElevationM, effectiveRadiusM) * 1.15,
    CLIPMAP_HALF_SPANS_M[CLIPMAP_HALF_SPANS_M.length - 1],
  )

/** Profondeur de scene du premier anneau — au-dela du plan rapproche de 0,1. */
const TERRAIN_NEAR_DEPTH = 0.3
/** Meme pente que `sceneDepth` : une decade de distance vaut 7,375 de profondeur. */
const TERRAIN_DEPTH_SLOPE = 7.375

const terrainDepth = (distanceM: number): number =>
  TERRAIN_DEPTH_SLOPE * Math.log10(Math.max(NEAR_M, distanceM) / NEAR_M) + TERRAIN_NEAR_DEPTH

/**
 * Maillage radial centre sur l'observateur.
 *
 * Radial et non cartesien : la resolution qui compte est **angulaire**, et un
 * quadrillage au sol gaspillerait ses sommets au loin tout en manquant de
 * finesse pres de l'observateur. Les anneaux sont espaces en logarithme, ce qui
 * donne a chaque anneau la meme epaisseur apparente.
 */
function buildGeometry(observerElevationM: number): BufferGeometry {
  const vertexCount = AZIMUTH_STEPS * RANGE_STEPS
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const ranges = new Float32Array(vertexCount)
  const altitudes = new Float32Array(vertexCount)
  // Positions **physiques** (est, altitude, −nord), gardees le temps du calcul
  // des normales. Elles ne partent pas au GPU : la scene, elle, recoit les
  // positions comprimees en profondeur.
  const local = new Float64Array(vertexCount * 3)

  // Le meme horizon que le sol, par construction : la depression vient de
  // l'integrale du moteur, pas du coefficient de manuel.
  const effectiveRadiusM = effectiveEarthRadiusM(observerElevationM, cachedHorizonDipDeg(observerElevationM))
  const logNear = Math.log(NEAR_M)
  const logSpan = Math.log(farRangeM(observerElevationM, effectiveRadiusM)) - logNear

  for (let r = 0; r < RANGE_STEPS; r++) {
    const distanceM = Math.exp(logNear + (logSpan * r) / (RANGE_STEPS - 1))
    const depth = terrainDepth(distanceM)
    for (let a = 0; a < AZIMUTH_STEPS; a++) {
      const azimuth = (2 * Math.PI * a) / AZIMUTH_STEPS
      const sinAz = Math.sin(azimuth)
      const cosAz = Math.cos(azimuth)
      // +X vers l'est, −Z vers le nord : la convention de la scene.
      const eastM = distanceM * sinAz
      const northM = distanceM * cosAz

      const altitudeM = groundAltitudeM(eastM, northM)
      const elevation = apparentElevationRad(distanceM, altitudeM, observerElevationM, effectiveRadiusM)
      const cosEl = Math.cos(elevation)

      const i = r * AZIMUTH_STEPS + a
      positions[i * 3] = depth * cosEl * sinAz
      positions[i * 3 + 1] = depth * Math.sin(elevation)
      positions[i * 3 + 2] = -depth * cosEl * cosAz
      ranges[i] = distanceM
      altitudes[i] = altitudeM
      local[i * 3] = eastM
      local[i * 3 + 1] = altitudeM
      local[i * 3 + 2] = -northM
    }
  }

  // --- Normales, prises sur le maillage lui-meme ---------------------------
  //
  // ⚠️ **Un pas fixe de differences finies ne peut pas marcher ici.** La maille
  // s'etire d'un facteur quinze mille entre le premier anneau et le dernier :
  // un metre pres de l'observateur, quinze kilometres a trois cents. Un pas de
  // vingt-cinq metres, comme le faisait la premiere version, decrit donc au loin
  // un **micro-relief que la maille ne represente pas** — l'ombrage cessait
  // d'avoir un rapport avec la silhouette visible, et les versants s'eclairaient
  // sans lien avec la position du Soleil.
  //
  // La normale est donc celle de la facette reellement affichee : produit
  // vectoriel des deux tangentes du maillage, prises en **coordonnees
  // physiques** et non dans la scene, dont la profondeur logarithmique
  // fausserait toutes les pentes.
  for (let r = 0; r < RANGE_STEPS; r++) {
    for (let a = 0; a < AZIMUTH_STEPS; a++) {
      const i = r * AZIMUTH_STEPS + a
      const prevA = r * AZIMUTH_STEPS + ((a + AZIMUTH_STEPS - 1) % AZIMUTH_STEPS)
      const nextA = r * AZIMUTH_STEPS + ((a + 1) % AZIMUTH_STEPS)
      const prevR = Math.max(0, r - 1) * AZIMUTH_STEPS + a
      const nextR = Math.min(RANGE_STEPS - 1, r + 1) * AZIMUTH_STEPS + a

      const ax = local[nextA * 3] - local[prevA * 3]
      const ay = local[nextA * 3 + 1] - local[prevA * 3 + 1]
      const az = local[nextA * 3 + 2] - local[prevA * 3 + 2]
      const rx = local[nextR * 3] - local[prevR * 3]
      const ry = local[nextR * 3 + 1] - local[prevR * 3 + 1]
      const rz = local[nextR * 3 + 2] - local[prevR * 3 + 2]

      let nx = ay * rz - az * ry
      let ny = az * rx - ax * rz
      let nz = ax * ry - ay * rx
      // Le sens du produit depend de l'orientation des deux tangentes ; on
      // impose la seule qui ait un sens pour un terrain, celle qui regarde le
      // ciel.
      if (ny < 0) {
        nx = -nx
        ny = -ny
        nz = -nz
      }
      const len = Math.hypot(nx, ny, nz)
      const inv = len > 0 ? 1 / len : 0
      normals[i * 3] = nx * inv
      normals[i * 3 + 1] = len > 0 ? ny * inv : 1
      normals[i * 3 + 2] = nz * inv
    }
  }

  // Deux triangles par cellule ; l'azimut boucle, la distance non.
  const indices = new Uint32Array(AZIMUTH_STEPS * (RANGE_STEPS - 1) * 6)
  let k = 0
  for (let r = 0; r < RANGE_STEPS - 1; r++) {
    for (let a = 0; a < AZIMUTH_STEPS; a++) {
      const a1 = (a + 1) % AZIMUTH_STEPS
      const i00 = r * AZIMUTH_STEPS + a
      const i01 = r * AZIMUTH_STEPS + a1
      const i10 = (r + 1) * AZIMUTH_STEPS + a
      const i11 = (r + 1) * AZIMUTH_STEPS + a1
      indices[k++] = i00
      indices[k++] = i10
      indices[k++] = i11
      indices[k++] = i00
      indices[k++] = i11
      indices[k++] = i01
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setAttribute('range', new BufferAttribute(ranges, 1))
  geometry.setAttribute('altitude', new BufferAttribute(altitudes, 1))
  geometry.setIndex(new BufferAttribute(indices, 1))
  return geometry
}

function terrainMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    // Opaque par son alpha, transparent par sa file de rendu : le sol plat est
    // dessine juste avant, sans test de profondeur, et le terrain doit passer
    // apres lui. Meme contrainte que pour le sol et le fond de ciel.
    transparent: true,
    depthTest: true,
    depthWrite: true,
    // Depuis r152, un materiau transparent en DoubleSide est rendu en deux
    // passes — faces arriere puis faces avant — pour trier correctement les
    // surfaces translucides. Le terrain est opaque par son alpha : la seconde
    // passe ne ferait que doubler le travail sans rien changer a l image.
    //
    // Ce reglage a ete introduit pour une raison fausse (voir NEAR_M), mais il
    // reste juste pour celle-ci.
    forceSinglePass: true,
    // ⚠️ **L'observateur est a l'interieur du maillage**, pas devant lui : le
    // terrain l'entoure et descend sous ses pieds. En profondeur logarithmique,
    // les anneaux proches forment un cone tres resserre dont on voit la face
    // interne, et l'elimination des faces arriere les faisait disparaitre — le
    // sol s'arretait net a quelques centaines de metres, laissant un vide sous
    // l'horizon.
    side: DoubleSide,
    uniforms: {
      ...aerialUniforms(),
      /** Direction du Soleil dans le repere de la scene. */
      uSunDirection: { value: new Vector3(0, 1, 0) },
      /** Irradiance solaire directe transmise, sRGB lineaire — `directSolar`. */
      uSunIrradiance: { value: new Vector3() },
      /** Eclairement diffus du ciel sur un plan horizontal, mesure sur la table. */
      uSkyIrradiance: { value: new Vector3() },
      /** Altitude a laquelle la neige tient, metres. */
      uSnowLine: { value: SNOW_LINE_M },
      /** Carte d'ombre : altitude a laquelle le Soleil se leve, en chaque point. */
      uShadowMap: { value: null as DataTexture | null },
      /** Demi-etendue de la carte, metres. */
      uShadowHalfSpan: { value: SHADOW_HALF_SPAN_M },
      /** Altitude de l'observateur, metres. */
      uObserverAltitude: { value: 0 },
      /** Rayon terrestre effectif sous refraction, metres. */
      uEffectiveRadius: { value: 6_371_000 },
    },
    vertexShader: /* glsl */ `
      attribute float range;
      attribute float altitude;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vRange;
      varying float vAltitude;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormal = normalize(mat3(modelMatrix) * normal);
        vView = normalize(world.xyz);
        vRange = range;
        // L'altitude vient telle quelle du champ de relief. La reconstruire
        // depuis la position de scene serait possible — hauteur apparente fois
        // distance, plus la chute de courbure — mais fragile : la profondeur y
        // est logarithmique, et la moindre erreur de signe passerait inapercue.
        vAltitude = altitude;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${DISPLAY_TONEMAP_GLSL}
      ${AERIAL_LUT_GLSL}
      // Pas de la sommation par segments. Huit suffisent : la table ne porte que
      // seize tranches de distance, et un pas plus fin qu'elles ne ferait
      // qu'interpoler du vide.
      const int SHADOW_STEPS = 8;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vRange;
      varying float vAltitude;
      uniform vec3 uSunDirection;
      uniform vec3 uSunIrradiance;
      uniform vec3 uSkyIrradiance;
      uniform float uSnowLine;
      uniform sampler2D uShadowMap;
      uniform float uShadowHalfSpan;
      uniform float uObserverAltitude;
      uniform float uEffectiveRadius;

      /**
       * Altitude, en un point du plan, sous laquelle le Soleil est masque par le
       * relief. Hors du domaine cartographie, rien n'ombre.
       */
      float shadowHeightAt(float eastM, float northM) {
        vec2 uv = vec2(eastM, northM) / (2.0 * uShadowHalfSpan) + 0.5;
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -1e9;
        return texture2D(uShadowMap, uv).r;
      }

      /**
       * Le point situe a t metres le long de la visee voit-il le Soleil ?
       *
       * Sa position se reconstruit exactement comme le maillage a ete construit :
       * l'azimut porte par la direction, l'altitude par la hauteur apparente
       * moins la chute due a la courbure. Les deux doivent se correspondre, sans
       * quoi l'ombre glisserait sur le relief.
       */
      bool sunlitAt(vec3 dir, float t, float biasM) {
        float eastM = t * dir.x;
        float northM = -t * dir.z;
        float altitudeM = uObserverAltitude + t * dir.y - (t * t) / (2.0 * uEffectiveRadius);
        return altitudeM + biasM > shadowHeightAt(eastM, northM);
      }

      void main() {
        vec3 N = normalize(vNormal);

        // --- Albedo ---------------------------------------------------------
        //
        // Trois valeurs mesurees, pas trois couleurs choisies : vegetation
        // basse 0,12, roche nue 0,20, neige fraiche 0,80. Ce sont des albedos
        // de manuel, et c'est leur **rapport** qui fait l'image — une crete
        // enneigee est quatre fois plus claire que la roche qui la porte.
        //
        float altitudeM = vAltitude;
        float slope = 1.0 - N.y;

        vec3 grass = vec3(0.09, 0.13, 0.07);
        vec3 rock  = vec3(0.21, 0.19, 0.17);
        vec3 snow  = vec3(0.80, 0.81, 0.85);

        vec3 albedo = mix(grass, rock, smoothstep(400.0, 1500.0, altitudeM));
        // La limite des neiges est **franche** dans la nature : quelques
        // dizaines de metres separent le versant enneige du versant nu, parce
        // que c'est une isotherme. L'etaler sur neuf cents metres, comme le
        // faisait la premiere version, noyait toute la chaine dans du blanc.
        //
        // Elle ne tient pas non plus sur les parois raides : au-dela d'environ
        // quarante degres, la neige glisse et laisse la roche a nu. C'est ce qui
        // dessine les aretes sombres d'un sommet enneige.
        float snowCover = smoothstep(uSnowLine - 150.0, uSnowLine + 150.0, altitudeM)
                        * (1.0 - smoothstep(0.18, 0.38, slope));
        albedo = mix(albedo, snow, snowCover);

        // --- Eclairement ----------------------------------------------------
        //
        // Direct : le cosinus de l'angle d'incidence, et rien de plus. Diffus :
        // la part du ciel que voit la surface, approchee par son inclinaison.
        // Ombre **portee** : une vallee peut etre tournee vers le Soleil et
        // rester dans l'ombre de la crete qui la domine. Le biais vaut un demi
        // texel de la carte, sans quoi la surface s'ombrerait elle-meme.
        float cosIncidence = max(0.0, dot(N, normalize(uSunDirection)));
        if (!sunlitAt(vView, vRange, 300.0)) cosIncidence = 0.0;
        float skyView = 0.5 * (1.0 + N.y);
        vec3 irradiance = uSunIrradiance * cosIncidence + uSkyIrradiance * skyView;

        // Surface lambertienne : la radiance sortante vaut l'eclairement recu
        // divise par pi, quelle que soit la direction de sortie.
        vec3 outgoing = albedo * irradiance / 3.14159265;

        // --- Le trajet jusqu'a l'oeil ---------------------------------------
        //
        // L'equation du transfert, la meme que partout ailleurs dans le moteur :
        // ce que la surface emet, attenue par l'air, plus ce que l'air ajoute.
        //
        // ## L'air aussi est dans l'ombre de la montagne
        //
        // La table est construite pour une atmosphere **sans relief** : chaque
        // point d'air y est eclaire par un Soleil que rien ne masque. Soleil
        // levant derriere une chaine, la brume situee devant elle brillait donc
        // comme si la montagne n'existait pas.
        //
        // On ne corrige pas cela par un facteur : **c'est le domaine
        // d'integration qui change**. La diffusion etant lineaire le long du
        // rayon, la table donne d'elle-meme la contribution d'un segment :
        //
        //     L(a→b) vue de l'oeil  =  L(0→b) − L(0→a)
        //
        // Il suffit donc de **sommer les segments eclaires**, et de sauter les
        // autres. Aucune ombre n'est peinte : elle emerge de ce que le relief
        // retire a l'integrale.
        //
        // ## Un segment ombre n'est pas un segment absent
        //
        // Sauter purement les segments ombres serait sur-corriger : un point
        // prive de Soleil recoit encore la lumiere du **reste du ciel**, et
        // c'est elle qui rend les ombres bleues plutot que noires. Le solveur
        // publie donc, a cote du voile total, la meme integrale **privee de sa
        // source solaire** — voir \`aerialAmbient\`.
        //
        // Chaque segment prend alors l'une ou l'autre : ce n'est pas un facteur
        // d'attenuation, c'est un **changement de terme source**.
        vec3 transmittance;
        aerialPerspective(vView, vRange, transmittance);

        vec3 haze = vec3(0.0);
        vec3 previousTotal = vec3(0.0);
        vec3 previousAmbient = vec3(0.0);
        vec3 ignored;
        for (int i = 1; i <= SHADOW_STEPS; i++) {
          float t = vRange * float(i) / float(SHADOW_STEPS);
          vec3 total = aerialPerspective(vView, t, ignored);
          vec3 ambient = aerialAmbient(vView, t);
          // Le milieu du segment decide pour lui : c'est la quadrature du point
          // milieu, la meme que celle du solveur.
          float middle = vRange * (float(i) - 0.5) / float(SHADOW_STEPS);
          haze += sunlitAt(vView, middle, 0.0)
            ? total - previousTotal
            : ambient - previousAmbient;
          previousTotal = total;
          previousAmbient = ambient;
        }

        gl_FragColor = vec4(outgoing * transmittance * uAerialExposure + haze, 1.0);
      }
    `,
  })
}

export function Terrain({
  observerElevationM,
  extraHeightM,
  latitudeDeg,
  longitudeDeg,
  sunDirection,
  sunIrradiance,
  sunAltitudeDeg,
  sunAzimuthDeg,
  skyExposure,
}: {
  observerElevationM: number
  /** Hauteur de l'observateur au-dessus du sol, m. */
  extraHeightM: number
  /** Site autour duquel le relief est charge. */
  latitudeDeg: number
  longitudeDeg: number
  sunDirection: readonly [number, number, number]
  sunIrradiance: readonly [number, number, number]
  /** Hauteur du Soleil, degres — elle seule fixe la longueur des ombres. */
  sunAltitudeDeg: number
  /** Azimut du Soleil, degres — il en fixe la direction. */
  sunAzimuthDeg: number
  skyExposure: number
}) {
  // L'altitude de l'observateur est quantifiee : elle ne bouge qu'au changement
  // de site, et reconstruire cent mille sommets pour un metre n'aurait pas de
  // sens.
  // L'altitude qui compte pour la **geometrie** est celle de l'oeil, pas celle
  // du site : elle repose sur le relief charge, et bouge donc avec lui.
  const eyeM = eyeAltitudeM(observerElevationM, extraHeightM)

  // ⚠️ **Cette altitude ne doit surtout pas etre arrondie.**
  //
  // Le maillage etait autrefois reconstruit sur une altitude quantifiee a dix
  // metres, ce qui evitait cent mille sommets pour un metre de deplacement. Le
  // banc le supportait : l'oeil flottait trente-cinq metres au-dessus d'une
  // plaine a zero, et dix metres d'erreur n'y changeaient rien.
  //
  // Avec le relief reel, l'oeil ne domine le sol que de `EYE_HEIGHT_M`. Arrondir
  // l'enfonce sous la surface une fois sur deux — et le maillage **se
  // retourne** : le sol qui devrait etre sous l'horizon passe au-dessus, la
  // scene se remplit d'un dome sombre et l'hemisphere inferieur se vide.
  //
  // L'arrondi ne sert donc plus qu'a decider **quand** reconstruire ; la
  // geometrie, elle, recoit la valeur exacte.
  //
  // ⚠️ Il porte bien sur l'**oeil**, hauteur ajoutee comprise. Le faire porter
  // sur la seule altitude du site laissait le maillage inchange quand on montait
  // de six kilometres : on planait au-dessus des sommets tout en les voyant
  // encore se dresser au-dessus de l'horizon.
  const elevationKey = Math.round(eyeM)
  /**
   * Revision du relief.
   *
   * Les niveaux de la pyramide arrivent l'un apres l'autre : le maillage
   * construit avant leur arrivee decrit une mer plate, et il faut le refaire a
   * chaque palier. La revision est la cle qui le declenche — sans elle, le
   * premier maillage resterait affiche indefiniment.
   */
  const [revision, setRevision] = useState(terrainRevision)

  const setTerrainProgress = useSkyStore((s) => s.setTerrainProgress)
  const setLocation = useSkyStore((s) => s.setLocation)

  useEffect(() => {
    let alive = true
    void loadElevationAround(latitudeDeg, longitudeDeg, (progress) => {
      if (!alive) return
      setTerrainProgress(progress)
      setRevision(terrainRevision())

      // L'altitude du sol est une **propriete du terrain**, que le modele
      // numerique connait mieux que n'importe quelle saisie. On la publie donc
      // des qu'on la connait : sans cela, choisir un sommet sur la carte
      // laisserait le panneau afficher l'altitude du lieu precedent, et
      // l'utilisateur n'aurait aucun moyen de savoir a quelle hauteur il se
      // trouve reellement.
      //
      // Le seuil du metre evite la boucle : la valeur publiee revient par les
      // proprietes, et sans lui chaque passage en declencherait un autre.
      const ground = observerGroundM()
      const state = useSkyStore.getState()
      if (Math.abs(ground - state.location.elevation) > 1) {
        setLocation({ ...state.location, elevation: Math.round(ground) })
      }
    })
    return () => {
      alive = false
    }
  }, [latitudeDeg, longitudeDeg, setTerrainProgress, setLocation])

  const geometry = useMemo(
    () => buildGeometry(eyeM),
    // `revision` ne sert pas au calcul : elle dit seulement que le relief
    // echantillonne par `buildGeometry` a change sous nos pieds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [elevationKey, revision],
  )
  const material = useMemo(() => terrainMaterial(), [])

  /**
   * Carte d'ombre, refaite quand le Soleil a sensiblement bouge.
   *
   * Le pas de quantification est **une consequence, pas un confort** : l'ombre
   * d'un sommet de quatre mille metres s'allonge de 4000/tan(a), soit cinq
   * kilometres pour un vingtieme de degre quand le Soleil est a deux degres.
   * C'est la ou les ombres sont les plus longues qu'il faut suivre le plus
   * finement, et le pas est donc pris **proportionnel a la tangente**.
   */
  const shadowKey = useMemo(() => {
    const step = Math.max(0.02, Math.min(1, Math.tan((Math.max(0.2, sunAltitudeDeg) * Math.PI) / 180) * 2))
    return `${Math.round(sunAltitudeDeg / step)}:${Math.round(sunAzimuthDeg / 2)}:${elevationKey}:${revision}`
  }, [sunAltitudeDeg, sunAzimuthDeg, elevationKey, revision])

  const shadowTexture = useMemo(() => {
    const effectiveRadiusM = effectiveEarthRadiusM(eyeM, cachedHorizonDipDeg(eyeM))
    const map = buildSunShadowMap(sunAltitudeDeg, sunAzimuthDeg, effectiveRadiusM)
    // Un canal rouge flottant : c'est une **altitude en metres**, pas une
    // couleur, et elle depasse largement l'intervalle [0,1].
    // Copie explicite : le typage de three attend un tampon non partage.
    const data = new Float32Array(map.height)
    const texture = new DataTexture(data, SHADOW_SIZE, SHADOW_SIZE, RedFormat, FloatType)
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.wrapS = ClampToEdgeWrapping
    texture.wrapT = ClampToEdgeWrapping
    texture.generateMipmaps = false
    texture.needsUpdate = true
    return texture
    // `shadowKey` porte la quantification ; les hauteurs brutes changeraient a
    // chaque image sans rien apporter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shadowKey])

  useEffect(() => () => shadowTexture.dispose(), [shadowTexture])

  useFrame(() => {
    const u = material.uniforms
    applyAerialUniforms(u as unknown as ReturnType<typeof aerialUniforms>, sunDirection, skyExposure)
    ;(u.uSunDirection.value as Vector3).set(sunDirection[0], sunDirection[1], sunDirection[2])
    ;(u.uSunIrradiance.value as Vector3).set(sunIrradiance[0], sunIrradiance[1], sunIrradiance[2])
    u.uShadowMap.value = shadowTexture
    // L'oeil, encore : le nuanceur reconstruit la position d'un point de la
    // visee, et doit partir d'ou part reellement le regard.
    u.uObserverAltitude.value = eyeM
    u.uEffectiveRadius.value = effectiveEarthRadiusM(eyeM, cachedHorizonDipDeg(eyeM))
    const sky = aerialTextures.skyIrradiance
    ;(u.uSkyIrradiance.value as Vector3).set(sky[0], sky[1], sky[2])
  })

  // Apres le sol plat, qui ne teste pas la profondeur : le terrain le recouvre
  // dans tout le secteur qu'il occupe, et son propre tampon de profondeur fait
  // le reste — une crete proche masque une crete lointaine sans qu'on ait rien
  // a trier.
  return <mesh geometry={geometry} material={material} renderOrder={26} frustumCulled={false} />
}
