import { useEffect, useRef } from 'react'
import { PerspectiveCamera, Vector3 } from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useSkyStore } from '@/state/store'
import { clamp } from '@/ui/utils'
import { lerpAngle, viewDirection } from './sceneMath'

const COMMIT_INTERVAL_MS = 100

/**
 * Pilotage de la camera : glisser pour balayer le ciel, molette pour zoomer.
 *
 * L'orientation vit dans une reference locale mise a jour a chaque image ; le
 * store n'est rafraichi qu'a 10 Hz, ce qui evite de reconstruire l'interface a
 * chaque pixel de deplacement.
 */
export function CameraRig({ canvas }: { canvas: React.RefObject<HTMLElement> }) {
  const { camera, gl } = useThree()
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
      if (s.fov !== prev.fov && Math.abs(s.fov - fov.current) > 0.2) {
        targetFov.current = clamp(s.fov, 0.15, 110)
      }
    })
  }, [])

  useEffect(() => {
    const element = canvas.current ?? gl.domElement
    let dragging = false
    let lastX = 0
    let lastY = 0
    let pointerId: number | null = null

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      dragging = true
      pointerId = e.pointerId
      lastX = e.clientX
      lastY = e.clientY
      element.setPointerCapture(e.pointerId)
      element.classList.add('is-dragging')
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
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
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // La borne basse descend sous le degre : c'est a ce grossissement que les
      // disques planetaires se resolvent vraiment.
      targetFov.current = clamp(targetFov.current * Math.exp(e.deltaY * 0.0012), 0.15, 110)
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
  }, [canvas, gl])

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
      if (Math.abs(s.viewAzimuth - az) > 0.05 || Math.abs(s.viewAltitude - altitude.current) > 0.05 || Math.abs(s.fov - fov.current) > 0.05) {
        useSkyStore.setState({ viewAzimuth: az, viewAltitude: altitude.current, fov: fov.current })
      }
    }
  })

  return null
}
