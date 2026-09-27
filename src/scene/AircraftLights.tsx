import { useEffect, useMemo } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, ShaderMaterial, Sphere, Vector3 } from 'three'
import { useFrame } from '@react-three/fiber'
import { extrapolatedGeodetic, geodeticToHorizontal, type AircraftState } from '@/astro/aircraft'
import { aircraftLayout } from '@/astro/aircraftTypes'
import {
  POINT_BASE_SIZE_PX,
  extinctionMagnitudes,
  pointIntensity,
  pointSizePixels,
} from '@/astro/photometry'
import { ZERO_MAGNITUDE_LUX } from './display/adaptation'
import { limitShift, type SkyGlow } from './display/skyGlowGradient'
import { DISPLAY_TONEMAP_GLSL } from './display/tonemap'
import { horizontalToScene, sceneDepth, sceneRadiusForBody } from './sceneMath'
import { airmass } from '@/astro/photometry'
import type { GeoLocation } from '@/astro/types'

/**
 * Les feux d'un avion.
 *
 * ## Ce qu'on voit d'un avion la nuit
 *
 * Rien de sa silhouette : il ne renvoie plus de lumiere. On voit ses feux, et
 * ce sont eux qui disent qu'un point qui glisse est un avion et non un
 * satellite — un feu rouge a gauche, un vert a droite, un blanc a la queue, un
 * eclat rouge qui bat une fois par seconde et, sur les avions de ligne, les
 * doubles eclats blancs des bouts d'aile.
 *
 * ## Leur eclat n'est pas choisi
 *
 * Les intensites sont les **minimums reglementaires** (CS-25 / FAR 25.1391 a
 * 25.1401) : 40 cd pour les feux de position, 20 cd pour le feu de queue, 400
 * cd effectives pour l'anticollision. Un feu reel fait souvent mieux ; ce sont
 * donc des bornes basses, pas des valeurs flatteuses.
 *
 * Une intensite a une distance donne un eclairement a l'oeil, `E = I/d²`, et
 * cet eclairement une magnitude par la meme constante que les etoiles —
 * `ZERO_MAGNITUDE_LUX`. Un eclat anticollision a dix kilometres vaut ainsi
 * −0,5 : autant que les plus brillantes etoiles. Un feu de position, 2,0.
 *
 * Le feu passe ensuite par la loi des sources ponctuelles, a la magnitude
 * limite du moment et du lieu. Le jour, il se noie de lui-meme : rien ne
 * l'eteint explicitement.
 *
 * ## L'extinction : une partie de l'atmosphere seulement
 *
 * La lumiere d'un avion ne traverse que l'air situe sous lui. On retient la
 * fraction de la colonne d'une atmosphere exponentielle de 8,4 km d'echelle,
 * `1 − e^(−h/H)`. Et la magnitude limite, qui porte deja l'extinction du
 * zenith pour les etoiles, est comparee a une magnitude **a l'oeil** : on lui
 * rajoute donc cette extinction du zenith.
 *
 * ## ⚠️ Ce que ce module suppose
 *
 * **Des feux isotropes.** Un feu de position n'eclaire que son secteur — le
 * rouge vers l'avant et la gauche, le vert vers l'avant et la droite, le blanc
 * vers l'arriere. Vu de dessous, ce qui est le cas le plus frequent, les trois
 * sont visibles ; ce module ne masque aucun secteur.
 *
 * **Une cadence type.** 60 eclats par minute pour le rouge, un double eclat
 * blanc toutes les 1,2 s, dans la plage reglementaire de 40 a 100. La phase
 * est tiree de l'identifiant de l'avion, pour que deux avions ne battent pas a
 * l'unisson.
 */

/** Intensites minimales reglementaires, candelas. */
const NAV_CD = 40
const TAIL_CD = 20
const ANTI_COLLISION_CD = 400

/** Echelle de hauteur de l'atmosphere, km — pour la part de colonne sous l'avion. */
const SCALE_HEIGHT_KM = 8.4

/** Cadences, secondes. */
const BEACON_PERIOD_S = 1.0
const BEACON_ON_S = 0.12
const STROBE_PERIOD_S = 1.2
const STROBE_ON_S = 0.05
const STROBE_GAP_S = 0.15

/** Couleurs d'affichage des feux : rouge et vert aviation, blanc. */
const RED: [number, number, number] = [1, 0.16, 0.1]
const GREEN: [number, number, number] = [0.25, 1, 0.5]
const WHITE: [number, number, number] = [1, 1, 1]

/** Feux par avion : position gauche et droite, queue, anticollision, deux eclats. */
const LIGHTS_PER_AIRCRAFT = 6

const hashPhase = (hex: string): number => {
  let h = 2166136261
  for (let i = 0; i < hex.length; i++) h = Math.imul(h ^ hex.charCodeAt(i), 16777619)
  return ((h >>> 0) % 10_000) / 10_000
}

/** Magnitude d'un feu d'intensite `cd` a `rangeKm`, sans atmosphere. */
const lightMagnitude = (cd: number, rangeKm: number): number =>
  -2.5 * Math.log10(cd / (rangeKm * 1000) ** 2 / ZERO_MAGNITUDE_LUX)

export function AircraftLights({
  states,
  location,
  limitingMagnitude,
  aerosolTurbidity,
  skyGlow,
}: {
  states: readonly AircraftState[]
  location: GeoLocation
  limitingMagnitude: number
  aerosolTurbidity: number
  skyGlow: SkyGlow
}) {
  const capacity = Math.max(1, states.length * LIGHTS_PER_AIRCRAFT)
  const geometry = useMemo(() => {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(capacity * 3), 3))
    geo.setAttribute('lightColor', new BufferAttribute(new Float32Array(capacity * 3), 3))
    geo.setAttribute('lightIntensity', new BufferAttribute(new Float32Array(capacity), 1))
    geo.setAttribute('lightSize', new BufferAttribute(new Float32Array(capacity), 1))
    geo.setDrawRange(0, 0)
    geo.boundingSphere = new Sphere(new Vector3(), 1e6)
    return geo
  }, [capacity])
  useEffect(() => () => geometry.dispose(), [geometry])

  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: { uPixelRatio: { value: 1 } },
        vertexShader: /* glsl */ `
          attribute vec3 lightColor;
          attribute float lightIntensity;
          attribute float lightSize;
          varying vec3 vColor;
          varying float vIntensity;
          uniform float uPixelRatio;
          void main() {
            vColor = lightColor;
            vIntensity = lightIntensity;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = clamp(lightSize * uPixelRatio, 1.5 * uPixelRatio, 40.0);
          }
        `,
        fragmentShader: /* glsl */ `
          ${DISPLAY_TONEMAP_GLSL}
          varying vec3 vColor;
          varying float vIntensity;
          void main() {
            if (vIntensity < 0.004) discard;
            vec2 d = gl_PointCoord - vec2(0.5);
            float r = length(d) * 2.0;
            float alpha = (exp(-r * r * 7.0) + exp(-r * r * 2.0) * 0.25) * vIntensity;
            if (alpha < 0.004) discard;
            gl_FragColor = vec4(radianceFromDisplay(vColor), min(1.0, alpha));
          }
        `,
      }),
    [],
  )
  useEffect(() => () => material.dispose(), [material])

  useFrame(() => {
    material.uniforms.uPixelRatio.value = Math.min(2, window.devicePixelRatio)
    const pos = geometry.getAttribute('position') as BufferAttribute
    const col = geometry.getAttribute('lightColor') as BufferAttribute
    const inten = geometry.getAttribute('lightIntensity') as BufferAttribute
    const size = geometry.getAttribute('lightSize') as BufferAttribute
    // Temps reel : un feu bat a sa cadence, quelle que soit la vitesse du ciel.
    const t = performance.now() / 1000
    const k = extinctionMagnitudes(90, aerosolTurbidity, location.elevation)
    let n = 0

    const push = (p: Vector3, colour: readonly number[], magnitude: number, limit: number) => {
      if (n >= capacity) return
      const i = pointIntensity(magnitude, limit)
      if (i < 0.004) return
      pos.setXYZ(n, p.x, p.y, p.z)
      col.setXYZ(n, colour[0], colour[1], colour[2])
      inten.setX(n, i)
      size.setX(n, pointSizePixels(magnitude, limit) || POINT_BASE_SIZE_PX)
      n++
    }

    const centre = new Vector3()
    const right = new Vector3()
    const forward = new Vector3()
    const p = new Vector3()

    for (const s of states) {
      const geo = extrapolatedGeodetic(s, Date.now())
      const { horizontal, rangeKm } = geodeticToHorizontal(geo.latitude, geo.longitude, geo.altitudeKm, location)
      if (horizontal.altitude <= -1 || rangeKm <= 0) continue

      // Extinction de la seule colonne sous l'avion, comparee a une limite
      // ramenee a l'oeil — voir l'en-tete.
      const column = 1 - Math.exp(-Math.max(0, geo.altitudeKm) / SCALE_HEIGHT_KM)
      const extinction = extinctionMagnitudes(horizontal.altitude, aerosolTurbidity, location.elevation) * column
      const x = airmass(horizontal.altitude, location.elevation)
      const limit = limitingMagnitude + k - limitShift(horizontal.altitude, x, k, skyGlow)

      const depth = sceneDepth(rangeKm)
      const [cx, cy, cz] = horizontalToScene(horizontal, depth)
      centre.set(cx, cy, cz)
      // Le nez suit la route vraie ; nord = −Z, est = +X dans la scene.
      const track = ((s.trackDeg ?? 0) * Math.PI) / 180
      forward.set(Math.sin(track), 0, -Math.cos(track))
      right.set(Math.cos(track), 0, Math.sin(track))
      const layout = aircraftLayout(s.typeCode, s.category)
      const halfSpan = sceneRadiusForBody(layout.spanM / 2000, rangeKm)

      const nav = lightMagnitude(NAV_CD, rangeKm) + extinction
      const tail = lightMagnitude(TAIL_CD, rangeKm) + extinction
      const flash = lightMagnitude(ANTI_COLLISION_CD, rangeKm) + extinction

      // Position : rouge a babord (gauche), vert a tribord, blanc a la queue.
      push(p.copy(centre).addScaledVector(right, -halfSpan), RED, nav, limit)
      push(p.copy(centre).addScaledVector(right, halfSpan), GREEN, nav, limit)
      push(p.copy(centre).addScaledVector(forward, -halfSpan * 0.9), WHITE, tail, limit)

      const phase = hashPhase(s.hex)
      // Anticollision rouge, sur le fuselage.
      const beacon = (t / BEACON_PERIOD_S + phase) % 1
      if (beacon * BEACON_PERIOD_S < BEACON_ON_S) push(p.copy(centre), RED, flash, limit)
      // Double eclat blanc des bouts d'aile — pas sur les avions legers, qui
      // n'en ont souvent qu'un, ni sur les helicopteres.
      if (layout.family !== 'light' && layout.family !== 'helicopter') {
        const strobe = ((t / STROBE_PERIOD_S + phase * 0.7) % 1) * STROBE_PERIOD_S
        const on = strobe < STROBE_ON_S || (strobe > STROBE_GAP_S && strobe < STROBE_GAP_S + STROBE_ON_S)
        if (on) {
          push(p.copy(centre).addScaledVector(right, -halfSpan), WHITE, flash, limit)
          push(p.copy(centre).addScaledVector(right, halfSpan), WHITE, flash, limit)
        }
      }
    }

    geometry.setDrawRange(0, n)
    pos.needsUpdate = true
    col.needsUpdate = true
    inten.needsUpdate = true
    size.needsUpdate = true
  })

  return <points geometry={geometry} material={material} renderOrder={13} frustumCulled={false} />
}
