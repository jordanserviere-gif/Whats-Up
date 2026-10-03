/**
 * Chef d'orchestre du mode photo, dans la scene.
 *
 * Il vit a l'interieur du `Canvas` parce que deux choses ne se trouvent que la :
 * la camera, dont il fige le cadrage exact, et le moteur de rendu, dont il
 * monte la definition le temps d'une image.
 *
 * ## Le deroule
 *
 * 1. `working` — le cadrage est fige ; le worker recoit une copie du relief
 *    courant et la vue, charge le relief fin, maille et ombre. Rien de cela ne
 *    touche le fil principal : l'apercu reste fluide.
 * 2. `capturing` — le maillage du worker remplace le maillage courant, la
 *    definition du rendu monte au facteur demande, et quelques images passent
 *    pour que le compositeur et l'eau se remettent a la nouvelle taille.
 * 3. L'image suivante est lue **dans la meme tache que son rendu** — juste apres
 *    le compositeur, qui rend en priorite 1 — et enregistree en PNG. Le tampon
 *    n'est pas conserve d'une image a l'autre : le lire plus tard rendrait du
 *    noir.
 */
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PerspectiveCamera, Vector3 } from 'three'
import { useSkyStore } from '@/state/store'
import { currentClipmap } from '../terrain/elevationSource'
import { nearFieldHeights } from '../terrain/nearField'
import { eyeAltitudeM, terrainPeakM } from '../terrain/elevationField'
import { effectiveEarthRadiusM } from '../terrain/ridgeField'
import { cachedHorizonDipDeg } from '../Globe'
import { farRangeM } from '../Terrain'
import { geometryFromResult, setPhotoGeometry } from './photoTerrain'
import type { PhotoJob, PhotoWorkerMessage } from './photoWorker'

const DEG = Math.PI / 180

/** Cote le plus long de la photo, pixels — au-dela, les tampons du GPU refusent. */
const MAX_SIDE_PX = 8192
/** Images laissees au compositeur et a l'eau pour se remettre a la nouvelle taille. */
const SETTLE_FRAMES = 8

const STEP_LABELS: Record<string, string> = {
  relief: 'Relief LiDAR',
  maillage: 'Maillage',
  ombres: 'Ombres',
}

let worker: Worker | null = null
const photoWorker = (): Worker =>
  (worker ??= new Worker(new URL('./photoWorker.ts', import.meta.url), { type: 'module' }))

export function PhotoController({ sunAltitudeDeg, sunAzimuthDeg }: { sunAltitudeDeg: number; sunAzimuthDeg: number }) {
  const phase = useSkyStore((s) => s.photo.phase)
  const { camera, gl, size } = useThree()
  const setDpr = useThree((s) => s.setDpr)

  /** Definition de rendu retenue pour la photo, et celle a restaurer. */
  const target = useRef<{ dpr: number; previousDpr: number; widthPx: number; heightPx: number } | null>(null)
  const settle = useRef(0)
  const sun = useRef({ sunAltitudeDeg, sunAzimuthDeg })
  sun.current = { sunAltitudeDeg, sunAzimuthDeg }

  // --- working : lancer le worker --------------------------------------------
  useEffect(() => {
    if (phase !== 'working') return
    const store = useSkyStore.getState()
    const forward = new Vector3()
    camera.getWorldDirection(forward)
    const cam = camera as PerspectiveCamera

    const previousDpr = gl.getPixelRatio()
    const maxSide = Math.min(MAX_SIDE_PX, gl.capabilities.maxTextureSize)
    const wanted = previousDpr * store.photo.scale
    const dpr = Math.min(wanted, maxSide / Math.max(size.width, size.height))
    const widthPx = Math.round(size.width * dpr)
    const heightPx = Math.round(size.height * dpr)
    target.current = { dpr, previousDpr, widthPx, heightPx }

    const clipmap = currentClipmap()
    const eyeM = eyeAltitudeM(store.location.elevation, store.elevationOffsetM)
    const effectiveRadiusM = effectiveEarthRadiusM(eyeM, cachedHorizonDipDeg(eyeM))
    const job: PhotoJob = {
      view: {
        azimuthDeg: Math.atan2(forward.x, -forward.z) / DEG,
        altitudeDeg: Math.asin(Math.max(-1, Math.min(1, forward.y))) / DEG,
        fovDeg: cam.fov,
        aspect: size.width / Math.max(1, size.height),
        widthPx,
        heightPx,
      },
      latitudeDeg: store.location.latitude,
      longitudeDeg: store.location.longitude,
      eyeM,
      effectiveRadiusM,
      reachM: farRangeM(eyeM, effectiveRadiusM),
      peakM: terrainPeakM(),
      sunAltitudeDeg: sun.current.sunAltitudeDeg,
      sunAzimuthDeg: sun.current.sunAzimuthDeg,
      // Copiees par le clonage du message : le relief courant reste intact ici.
      clipmap: (clipmap?.levels ?? []).map((l) => ({
        halfSpanM: l.halfSpanM,
        stepM: l.stepM,
        heights: l.heightM,
        ready: l.ready,
      })),
      near: nearFieldHeights(),
    }

    const w = photoWorker()
    let alive = true
    w.onmessage = (event: MessageEvent<PhotoWorkerMessage>) => {
      if (!alive) return
      const msg = event.data
      const setPhoto = useSkyStore.getState().setPhoto
      if (msg.type === 'progress') {
        setPhoto({ progress: { step: STEP_LABELS[msg.phase] ?? msg.phase, fraction: msg.fraction, detail: msg.detail } })
      } else if (msg.type === 'error') {
        setPhoto({ phase: 'preview', progress: null, message: `Échec : ${msg.message}` })
      } else {
        if (import.meta.env.DEV) console.info('[photo]', msg.stats)
        setPhotoGeometry(geometryFromResult(msg))
        settle.current = 0
        setPhoto({ phase: 'capturing', progress: { step: 'Rendu', fraction: 0 } })
      }
    }
    w.postMessage({ type: 'start', job })
    return () => {
      alive = false
      // Annulation : le worker abandonne ses requetes et ses calculs.
      if (useSkyStore.getState().photo.phase !== 'capturing') w.postMessage({ type: 'cancel' })
    }
    // Le cadrage est lu une fois, a l'entree dans la phase : c'est lui qu'on fige.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // --- capturing : monter la definition -----------------------------------------
  useEffect(() => {
    if (phase !== 'capturing' || !target.current) return
    setDpr(target.current.dpr)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // --- capturing : lire l'image juste apres le compositeur ---------------------------
  useFrame(() => {
    if (useSkyStore.getState().photo.phase !== 'capturing' || !target.current) return
    settle.current++
    if (settle.current < SETTLE_FRAMES) {
      useSkyStore.getState().setPhoto({ progress: { step: 'Rendu', fraction: settle.current / SETTLE_FRAMES } })
      return
    }
    const t = target.current
    target.current = null
    const canvas = gl.domElement
    // La taille est lue maintenant : la definition retombe avant que l'image soit encodee.
    const shotWidth = canvas.width
    const shotHeight = canvas.height
    const name = photoFileName(useSkyStore.getState().time)
    // Lu ici, dans la tache meme du rendu : voir l'en-tete.
    canvas.toBlob((blob) => {
      const store = useSkyStore.getState()
      if (blob) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      }
      store.setPhoto({
        phase: 'preview',
        progress: null,
        message: blob ? `Photo enregistrée — ${shotWidth} × ${shotHeight}` : 'Échec de l’enregistrement',
      })
    }, 'image/png')
    setDpr(t.previousDpr)
    setPhotoGeometry(null)
  }, 2)

  // Sortie du mode photo en plein travail : tout est rendu.
  useEffect(() => {
    if (phase !== 'off') return
    if (target.current) {
      setDpr(target.current.previousDpr)
      target.current = null
    }
    setPhotoGeometry(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  return null
}

function photoFileName(timeMs: number): string {
  const d = new Date(timeMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `whats-up-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`
}
