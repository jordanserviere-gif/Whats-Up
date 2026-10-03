/**
 * Chef d'orchestre du mode photo, dans la scene.
 *
 * Il vit a l'interieur du `Canvas` parce que deux choses ne se trouvent que la :
 * la camera, dont il fige le cadrage exact, et le moteur de rendu, dont il
 * monte la definition le temps d'une image.
 *
 * ## Le deroule
 *
 * 1. `working` — le cadrage est fige. Un worker prepare : visibilite, tuiles au
 *    pas du pixel, relief rendu au pixel, normales, carte d'ombre fine. Puis un
 *    groupe de workers — autant que la machine a de coeurs, six au plus — se
 *    partage les lignes de l'image pour les rayons d'ombre et la part de ciel.
 *    Rien de cela ne touche le fil principal.
 * 2. `capturing` — le relief au pixel remplace le maillage courant, la
 *    definition du rendu monte au facteur demande, et quelques images passent
 *    pour que le compositeur et l'eau se remettent a la nouvelle taille.
 * 3. L'image suivante est lue **dans la meme tache que son rendu** — juste apres
 *    le compositeur, qui rend en priorite 1 — et enregistree en PNG.
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
import { makePhotoRender, setPhotoRender } from './photoTerrain'
import type { CurrentRelief, PhotoPhase, PhotoWorkerMessage, PrepareJob, PrepareResult, ShadeJob } from './photoWorker'

const DEG = Math.PI / 180

/**
 * Cote le plus long de la photo, pixels. La grille angulaire deborde un peu du
 * cadre et doit tenir dans une texture : on garde une marge sous la limite.
 */
const MAX_SIDE_PX = 8000
/** Images laissees au compositeur et a l'eau pour se remettre a la nouvelle taille. */
const SETTLE_FRAMES = 8

const STEP_LABELS: Record<PhotoPhase, string> = {
  visibilite: 'Visibilité',
  relief: 'Relief LiDAR',
  rendu: 'Rendu du relief',
  ombres: 'Ombres et ciel',
}

const newWorker = () => new Worker(new URL('./photoWorker.ts', import.meta.url), { type: 'module' })

export function PhotoController({ sunAltitudeDeg, sunAzimuthDeg }: { sunAltitudeDeg: number; sunAzimuthDeg: number }) {
  const phase = useSkyStore((s) => s.photo.phase)
  const { camera, gl, size } = useThree()
  const setDpr = useThree((s) => s.setDpr)
  const setSize = useThree((s) => s.setSize)
  /**
   * Change la definition **et** previent le compositeur.
   *
   * ⚠️ Le compositeur ne recree ses tampons que quand la taille CSS change, pas
   * quand la definition change. Sans ce second appel, la photo etait rendue a
   * la definition de l'ecran puis agrandie : un fichier de 3 184 pixels qui n'en
   * contenait que 1 592.
   */
  const applyDpr = (dpr: number) => {
    setDpr(dpr)
    setSize(size.width, size.height)
  }

  const target = useRef<{ dpr: number; previousDpr: number } | null>(null)
  const settle = useRef(0)
  const sun = useRef({ sunAltitudeDeg, sunAzimuthDeg })
  sun.current = { sunAltitudeDeg, sunAzimuthDeg }

  // --- working : preparer, puis ombrer en parallele -----------------------------------
  useEffect(() => {
    if (phase !== 'working') return
    const store = useSkyStore.getState()
    const setPhoto = store.setPhoto
    const forward = new Vector3()
    camera.getWorldDirection(forward)
    const cam = camera as PerspectiveCamera

    const previousDpr = gl.getPixelRatio()
    const maxSide = Math.min(MAX_SIDE_PX, gl.capabilities.maxTextureSize - 64)
    const dpr = Math.min(previousDpr * store.photo.scale, maxSide / Math.max(size.width, size.height))
    target.current = { dpr, previousDpr }

    const clipmap = currentClipmap()
    const eyeM = eyeAltitudeM(store.location.elevation, store.elevationOffsetM)
    const effectiveRadiusM = effectiveEarthRadiusM(eyeM, cachedHorizonDipDeg(eyeM))
    const relief: CurrentRelief = {
      latitudeDeg: store.location.latitude,
      longitudeDeg: store.location.longitude,
      clipmap: (clipmap?.levels ?? []).map((l) => ({ halfSpanM: l.halfSpanM, stepM: l.stepM, heights: l.heightM, ready: l.ready })),
      near: nearFieldHeights(),
    }
    const job: PrepareJob = {
      ...relief,
      view: {
        azimuthDeg: Math.atan2(forward.x, -forward.z) / DEG,
        altitudeDeg: Math.asin(Math.max(-1, Math.min(1, forward.y))) / DEG,
        fovDeg: cam.fov,
        aspect: size.width / Math.max(1, size.height),
        widthPx: Math.round(size.width * dpr),
        heightPx: Math.round(size.height * dpr),
      },
      eyeM,
      effectiveRadiusM,
      reachM: farRangeM(eyeM, effectiveRadiusM),
      peakM: terrainPeakM(),
      sunAltitudeDeg: sun.current.sunAltitudeDeg,
      sunAzimuthDeg: sun.current.sunAzimuthDeg,
    }

    const poolSize = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1))
    const pool = [newWorker()]
    let alive = true
    const fail = (message: string) => {
      if (!alive) return
      setPhoto({ phase: 'preview', progress: null, message: `Échec : ${message}` })
    }

    const runShading = (prepared: PrepareResult) => {
      const { frame } = prepared
      const cols = frame.cols
      const g = new Uint16Array(cols * frame.rows * 8)
      while (pool.length < poolSize) pool.push(newWorker())
      const bands = pool.length
      const per = Math.ceil(frame.rows / bands)
      const progress = new Array<number>(bands).fill(0)
      let pending = 0
      pool.forEach((w, b) => {
        const rowStart = b * per
        const rowEnd = Math.min(frame.rows, rowStart + per)
        if (rowStart >= rowEnd) return
        pending++
        w.onmessage = (event: MessageEvent<PhotoWorkerMessage>) => {
          if (!alive) return
          const msg = event.data
          if (msg.type === 'progress') {
            progress[b] = msg.fraction
            setPhoto({ progress: { step: STEP_LABELS.ombres, fraction: progress.reduce((a, v) => a + v, 0) / bands, detail: `${bands} workers` } })
          } else if (msg.type === 'error') {
            fail(msg.message)
          } else if (msg.type === 'shaded') {
            g.set(msg.g, msg.rowStart * cols * 8)
            if (--pending === 0) {
              setPhotoRender(makePhotoRender(frame, g, prepared.shadow))
              settle.current = 0
              setPhoto({ phase: 'capturing', progress: { step: 'Rendu', fraction: 0 } })
            }
          }
        }
        const shade: ShadeJob = {
          ...relief,
          frame,
          range: prepared.range,
          altitude: prepared.altitude,
          coverage: prepared.coverage,
          normals: prepared.normals.slice(rowStart * cols * 3, rowEnd * cols * 3),
          rowStart,
          rowEnd,
          tiles: prepared.tiles,
          projector: prepared.projector,
          sunAltitudeDeg: job.sunAltitudeDeg,
          sunAzimuthDeg: job.sunAzimuthDeg,
          effectiveRadiusM,
          peakM: job.peakM,
        }
        w.postMessage({ type: 'shade', job: shade })
      })
    }

    pool[0].onmessage = (event: MessageEvent<PhotoWorkerMessage>) => {
      if (!alive) return
      const msg = event.data
      if (msg.type === 'progress') {
        setPhoto({ progress: { step: STEP_LABELS[msg.phase], fraction: msg.fraction, detail: msg.detail } })
      } else if (msg.type === 'error') {
        fail(msg.message)
      } else if (msg.type === 'prepared') {
        if (import.meta.env.DEV) console.info('[photo]', JSON.stringify(msg.stats), `${msg.frame.cols} × ${msg.frame.rows}`)
        runShading(msg)
      }
    }
    pool[0].postMessage({ type: 'prepare', job })

    return () => {
      alive = false
      // Annulation, ou fin du calcul : les workers sont rendus.
      pool.forEach((w) => w.terminate())
    }
    // Le cadrage est lu une fois, a l'entree dans la phase : c'est lui qu'on fige.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // --- capturing : monter la definition -----------------------------------------
  useEffect(() => {
    if (phase !== 'capturing' || !target.current) return
    applyDpr(target.current.dpr)
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
    applyDpr(t.previousDpr)
    setPhotoRender(null)
  }, 2)

  // Sortie du mode photo en plein travail : tout est rendu.
  useEffect(() => {
    if (phase !== 'off' && phase !== 'preview') return
    if (target.current && phase === 'off') {
      applyDpr(target.current.previousDpr)
      target.current = null
    }
    setPhotoRender(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  return null
}

function photoFileName(timeMs: number): string {
  const d = new Date(timeMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `whats-up-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`
}
