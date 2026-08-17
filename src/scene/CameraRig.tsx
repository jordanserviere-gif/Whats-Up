import { useEffect, useRef } from 'react'
import { PerspectiveCamera, Vector3 } from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useSkyStore } from '@/state/store'
import { clamp } from '@/ui/utils'
import { lerpAngle, sceneToHorizontal, viewDirection } from './sceneMath'
import type { Horizontal } from '@/astro/types'

const COMMIT_INTERVAL_MS = 100

/** Bornes du champ de vision, en degres. */
export const MIN_FOV = 0.02
export const MAX_FOV = 110

/**
 * Deplacement, en pixels, au-dela duquel un geste cesse d'etre un clic.
 *
 * Sans ce seuil, tout balayage du ciel se terminerait par une selection : on
 * designerait un objet chaque fois qu'on tourne la tete. Six pixels laissent
 * passer le tremblement de la main sans absorber une intention de pointage.
 */
const CLICK_SLOP_PX = 6
/** Au-dela, le geste est une pose ou une hesitation, plus un clic. */
const CLICK_MAX_MS = 500

export interface PickRequest {
  /** Direction visee dans le repere de la scene, unitaire. */
  direction: [number, number, number]
  /** La meme, en coordonnees horizontales. */
  aim: Horizontal
  /** Rayon de recherche, proportionne au champ affiche. */
  toleranceDeg: number
}

/**
 * Pilotage de la camera : glisser pour balayer le ciel, molette pour zoomer.
 *
 * L'orientation vit dans une reference locale mise a jour a chaque image ; le
 * store n'est rafraichi qu'a 10 Hz, ce qui evite de reconstruire l'interface a
 * chaque pixel de deplacement.
 */
export function CameraRig({
  canvas,
  onPick,
}: {
  canvas: React.RefObject<HTMLElement>
  /** Appele quand un geste se revele etre un clic et non un balayage. */
  onPick?: (request: PickRequest) => void
}) {
  const { camera, gl } = useThree()
  // Le rappel change a chaque rendu du parent : on le garde dans une reference
  // pour ne pas reinstaller les ecouteurs de pointeur a chaque image.
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const azimuth = useRef(useSkyStore.getState().viewAzimuth)
  const altitude = useRef(useSkyStore.getState().viewAltitude)
  const targetAzimuth = useRef(azimuth.current)
  const targetAltitude = useRef(altitude.current)
  const fov = useRef(useSkyStore.getState().fov)
  const targetFov = useRef(fov.current)
  const lastCommit = useRef(0)
  const lookTarget = useRef<Vector3>(new Vector3())

  // Ordres venus de l'interface : recentrage et reglage du champ. Sans cette
  // souscription, `setFov` resterait sans effet — la reference locale ayant
  // pris la main sur la valeur du store des le premier rendu.
  useEffect(() => {
    return useSkyStore.subscribe((s, prev) => {
      if (s.lookAtTarget && s.lookAtTarget !== prev.lookAtTarget) {
        targetAzimuth.current = s.lookAtTarget.azimuth
        targetAltitude.current = clamp(s.lookAtTarget.altitude, -85, 85)
      }
      // On ne reagit qu'aux changements venus d'ailleurs : le rig publie
      // lui-meme le champ a 10 Hz, et se rattraperait sans cesse sinon.
      // Le seuil est relatif : un seuil fixe aurait interdit tout reglage sous
      // le demi-degre, la ou se joue justement l'observation planetaire.
      if (s.fov !== prev.fov && Math.abs(s.fov - fov.current) > Math.max(1e-3, fov.current * 0.05)) {
        targetFov.current = clamp(s.fov, MIN_FOV, MAX_FOV)
      }
    })
  }, [])

  useEffect(() => {
    const element = canvas.current ?? gl.domElement
    let dragging = false
    let lastX = 0
    let lastY = 0
    let pointerId: number | null = null
    // Origine du geste et distance parcourue : ce sont eux qui tranchent entre
    // un clic et un balayage, au relachement.
    let downX = 0
    let downY = 0
    let downTime = 0
    let travelled = 0

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      dragging = true
      pointerId = e.pointerId
      lastX = e.clientX
      lastY = e.clientY
      downX = e.clientX
      downY = e.clientY
      downTime = e.timeStamp
      travelled = 0
      element.setPointerCapture(e.pointerId)
      element.classList.add('is-dragging')
    }

    /**
     * Direction du ciel sous le pointeur.
     *
     * On projette le point de l'ecran dans le plan proche de la camera, puis on
     * en fait une direction depuis l'observateur — place a l'origine. C'est la
     * meme geometrie que celle du rendu, donc le pointage tombe exactement la ou
     * l'objet a ete dessine.
     */
    const directionAt = (clientX: number, clientY: number): [number, number, number] | null => {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      const ndc = new Vector3(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
        0.5,
      )
      ndc.unproject(camera)
      // La camera est a l'origine : le point deprojete est deja la direction.
      if (ndc.lengthSq() === 0) return null
      ndc.normalize()
      return [ndc.x, ndc.y, ndc.z]
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      travelled = Math.max(travelled, Math.hypot(e.clientX - downX, e.clientY - downY))
      // Le deplacement angulaire suit le champ de vision : le geste garde la
      // meme « prise » sur le ciel quel que soit le zoom.
      const scale = fov.current / 700
      targetAzimuth.current -= dx * scale
      targetAltitude.current = clamp(targetAltitude.current + dy * scale, -88, 88)
    }

    const endDrag = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      dragging = false
      pointerId = null
      element.classList.remove('is-dragging')

      // Geste bref et immobile : c'est un pointage, pas un balayage.
      if (e.type !== 'pointerup') return
      if (travelled > CLICK_SLOP_PX || e.timeStamp - downTime > CLICK_MAX_MS) return
      const pick = pickRef.current
      if (!pick) return
      const direction = directionAt(e.clientX, e.clientY)
      if (!direction) return
      // La tolerance suit le champ : au grand angle un degre est un pouce a bout
      // de bras, a fort grossissement il couvrirait tout l'ecran.
      const tolerance = clamp(fov.current * 0.035, 0.02, 2.5)
      pick({ direction, aim: sceneToHorizontal(direction), toleranceDeg: tolerance })
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // La borne basse descend a une minute d'arc : c'est le grossissement
      // auquel les anneaux de Saturne et les bandes de Jupiter se lisent
      // vraiment. Au-dela, la precision des flottants du nuanceur ferait
      // trembler le limbe.
      targetFov.current = clamp(targetFov.current * Math.exp(e.deltaY * 0.0012), MIN_FOV, MAX_FOV)
    }

    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('pointermove', onPointerMove)
    element.addEventListener('pointerup', endDrag)
    element.addEventListener('pointercancel', endDrag)
    element.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', endDrag)
      element.removeEventListener('pointercancel', endDrag)
      element.removeEventListener('wheel', onWheel)
    }
  }, [canvas, gl, camera])

  useFrame((_, delta) => {
    // Amortissement critique : suit le geste sans flotter.
    const k = 1 - Math.exp(-delta * 14)
    azimuth.current = lerpAngle(azimuth.current, targetAzimuth.current, k)
    altitude.current += (targetAltitude.current - altitude.current) * k
    fov.current += (targetFov.current - fov.current) * k

    const cam = camera as PerspectiveCamera
    const [x, y, z] = viewDirection(azimuth.current, altitude.current)
    lookTarget.current.set(x, y, z)
    cam.position.set(0, 0, 0)
    cam.lookAt(lookTarget.current)
    if (Math.abs(cam.fov - fov.current) > 0.001) {
      cam.fov = fov.current
      cam.updateProjectionMatrix()
    }

    const now = performance.now()
    if (now - lastCommit.current > COMMIT_INTERVAL_MS) {
      lastCommit.current = now
      const s = useSkyStore.getState()
      const az = ((azimuth.current % 360) + 360) % 360
      // Seuils proportionnels au champ : a fort grossissement, un dixieme de
      // degre d'ecart en visee est deja un demi-ecran.
      const angleThreshold = Math.max(1e-4, fov.current * 0.002)
      if (
        Math.abs(s.viewAzimuth - az) > angleThreshold ||
        Math.abs(s.viewAltitude - altitude.current) > angleThreshold ||
        Math.abs(s.fov - fov.current) > Math.max(1e-4, fov.current * 0.002)
      ) {
        useSkyStore.setState({ viewAzimuth: az, viewAltitude: altitude.current, fov: fov.current })
      }
    }
  })

  return null
}
