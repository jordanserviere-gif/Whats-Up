import { useEffect, useState } from 'react'
import { BufferGeometry, FrontSide, Mesh, ShaderMaterial, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { AircraftFamily } from '@/astro/aircraftTypes'
import { AERIAL_LUT_GLSL } from '@/atmosphere/lut/aerialPerspectiveLut'
import { aerialUniforms } from './useAerialLut'

/**
 * Modeles 3D des avions — un par famille de forme, mis a l'echelle de chaque
 * type par la table `aircraftTypes.ts`.
 *
 * ## Convention des fichiers
 *
 * glTF binaire, nez vers +Z, dessus vers +Y, aile droite vers −X, origine au
 * centre de l'appareil, echelle reelle en metres. Un seul materiau, couleurs
 * par sommet. Des noeuds vides nommes `light_*`, `beacon_*`, `strobe_*`
 * marquent les feux. C'est la meme convention que la silhouette plate : le
 * modele se pose et s'oriente exactement comme elle.
 *
 * ## Ce que fait le chargement
 *
 * Toutes les parties sont fusionnees en une geometrie, dans le repere de
 * l'avion : un appel de dessin par appareil. Les normales sont **recalculees
 * avec un angle de cassure de 30°** : un sommet partage entre extrados et
 * intrados, au bord d'une aile mince, recevait sinon une normale moyennee de
 * cote, et l'ombrage s'y trompait. C'est une garde, pas une retouche : un
 * fichier deja correct n'en est pas change.
 */

/** Familles pour lesquelles un modele existe. Les autres gardent la silhouette. */
const MODEL_URLS: Partial<Record<AircraftFamily, string>> = {
  'narrowbody-twin': '/models/narrowbody-twin.glb',
  'widebody-twin': '/models/widebody-twin.glb',
}

/** Angle de cassure des normales, radians. */
const CREASE_ANGLE = (30 * Math.PI) / 180

export interface AircraftModel {
  geometry: BufferGeometry
  /** Envergure du modele tel que fourni, m — la mise a l'echelle part d'elle. */
  nativeSpanM: number
  /** Position des feux dans le repere du modele, m, par nom de noeud. */
  lights: Record<string, Vector3>
}

const cache = new Map<AircraftFamily, Promise<AircraftModel | null>>()

function load(family: AircraftFamily): Promise<AircraftModel | null> {
  const hit = cache.get(family)
  if (hit) return hit
  const url = MODEL_URLS[family]
  const promise = url
    ? new GLTFLoader()
        .loadAsync(url)
        .then((gltf) => {
          gltf.scene.updateMatrixWorld(true)
          const parts: BufferGeometry[] = []
          const lights: Record<string, Vector3> = {}
          gltf.scene.traverse((o) => {
            if (o instanceof Mesh) {
              const g = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld)
              // Attributs communs a toutes les parties : sans eux, la fusion echoue.
              for (const name of Object.keys(g.attributes)) {
                if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name)
              }
              parts.push(g.index ? g.toNonIndexed() : g)
            } else if (/^(light|beacon|strobe)_/.test(o.name)) {
              lights[o.name] = new Vector3().setFromMatrixPosition(o.matrixWorld)
            }
          })
          const merged = mergeGeometries(parts)
          if (!merged) return null
          const geometry = toCreasedNormals(merged, CREASE_ANGLE)
          geometry.computeBoundingBox()
          const box = geometry.boundingBox!
          return { geometry, nativeSpanM: box.max.x - box.min.x, lights }
        })
        .catch(() => null)
    : Promise.resolve(null)
  cache.set(family, promise)
  return promise
}

/** Le modele d'une famille, ou `null` s'il n'existe pas ou n'est pas encore charge. */
export function useAircraftModel(family: AircraftFamily): AircraftModel | null {
  const [model, setModel] = useState<AircraftModel | null>(null)
  useEffect(() => {
    let alive = true
    void load(family).then((m) => {
      if (alive) setModel(m)
    })
    return () => {
      alive = false
    }
  }, [family])
  return model
}

/**
 * Materiau des modeles — eclaire comme la trainee, la ou est l'avion.
 *
 * Surface lambertienne d'albedo egal a la couleur du sommet : le Soleil
 * **a l'altitude de vol** (rougi, ou eteint par l'ombre de la Terre), plus la
 * lumiere diffuse du ciel et du sol, puis la perspective atmospherique jusqu'a
 * l'oeil. Un avion a onze kilometres reste ainsi eclaire et rose apres le
 * coucher, comme sa trainee.
 */
export function aircraftModelMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    // File transparente pour garder l'ordre de dessin des avions, mais
    // profondeur ecrite : l'aile doit masquer le fuselage, et inversement.
    transparent: true,
    depthWrite: true,
    depthTest: true,
    side: FrontSide,
    vertexColors: true,
    uniforms: {
      uSunIrradiance: { value: new Vector3() },
      uAmbientRadiance: { value: new Vector3() },
      uRangeM: { value: 0 },
      ...aerialUniforms(),
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vAlbedo;
      void main() {
        // Echelle uniforme : la matrice du modele transporte les normales.
        vNormal = normalize(mat3(modelMatrix) * normal);
        vView = normalize((modelMatrix * vec4(position, 1.0)).xyz);
        vAlbedo = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${AERIAL_LUT_GLSL}
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vAlbedo;
      uniform vec3 uSunIrradiance;
      uniform vec3 uAmbientRadiance;
      uniform float uRangeM;
      void main() {
        vec3 n = normalize(vNormal);
        float cosSun = max(0.0, dot(n, normalize(uAerialSunDir)));
        // Lambert : radiance = albedo · (E☉ cos θ / π + radiance diffuse moyenne).
        vec3 outgoing = vAlbedo * (uSunIrradiance * cosSun / 3.14159265 + uAmbientRadiance);
        vec3 transmittance;
        vec3 haze = aerialPerspective(normalize(vView), uRangeM, transmittance);
        gl_FragColor = vec4(outgoing * uAerialExposure * transmittance + haze, 1.0);
      }
    `,
  })
}
