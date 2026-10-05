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
 *    pas du pixel, carte d'ombre fine. Puis un groupe de workers — autant que la
 *    machine a de coeurs, six au plus — rend le relief par bandes de colonnes,
 *    en plusieurs passes. Rien de cela ne touche le fil principal.
 * 2. `capturing` — des que la premiere passe est prete, le relief au pixel
 *    remplace le maillage courant et la definition du rendu monte au facteur
 *    demande. Chaque passe est affichee a son tour, et l'image lue **dans la
 *    meme tache que son rendu** — juste apres le compositeur, qui rend en
 *    priorite 1.
 * 3. La moyenne des passes est enregistree en PNG.
 *
 * ## L'anticrenelage
 *
 * Une passe n'echantillonne qu'un point par pixel : les cretes qui se masquent
 * l'une l'autre sortent en escalier. Les passes decalent la grille d'une
 * fraction de pixel — quatre points en grille tournee, comme le
 * sur-echantillonnage d'un rendu hors ligne — et leur moyenne lisse les bords
 * sans rien flouter. La memoire reste celle d'une seule passe.
 */
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PerspectiveCamera, Vector3, type DataTexture } from 'three'
import { useSkyStore } from '@/state/store'
import { currentClipmap } from '../terrain/elevationSource'
import { nearFieldHeights } from '../terrain/nearField'
import { eyeAltitudeM, terrainPeakM } from '../terrain/elevationField'
import { effectiveEarthRadiusM } from '../terrain/ridgeField'
import { cachedHorizonDipDeg } from '../Globe'
import { farRangeM } from '../Terrain'
import { makePhotoRender, photoShadowTexture, setPhotoRender } from './photoTerrain'
import type { PhotoFrame } from './photoRaster'
import type { BandJob, CurrentRelief, PhotoPhase, PhotoWorkerMessage, PrepareJob, RenderInit } from './photoWorker'

const DEG = Math.PI / 180

/**
 * Cote le plus long de la photo, pixels. La grille angulaire deborde un peu du
 * cadre et doit tenir dans une texture : on garde une marge sous la limite.
 */
const MAX_SIDE_PX = 8000
/** Images laissees au compositeur et a l'eau pour se remettre a la nouvelle taille. */
const SETTLE_FRAMES = 8
/** Images laissees a chaque passe suivante : le temps de charger sa texture. */
const PASS_SETTLE_FRAMES = 3
/** Points d'echantillonnage dans le pixel, en grille tournee — pixels. */
const JITTERS: Array<[number, number]> = [
  [-0.125, -0.375],
  [0.375, -0.125],
  [0.125, 0.375],
  [-0.375, 0.125],
]
/** Immobilite de la camera avant le prechargement des tuiles, secondes. */
const PREFETCH_STILL_S = 1.5
/** Bandes de colonnes par worker, chacune avec toutes ses passes : les colonnes de ciel ne coutent rien, il faut de quoi equilibrer. */
const BANDS_PER_WORKER = 12

const STEP_LABELS: Record<PhotoPhase, string> = {
  visibilite: 'Visibilité',
  relief: 'Relief haute résolution',
  rendu: 'Préparation',
  ombres: 'Rendu au pixel',
  imagerie: 'Imagerie du sol',
}

const newWorker = () => new Worker(new URL('./photoWorker.ts', import.meta.url), { type: 'module' })

/** Une passe prete a afficher. */
interface ReadyPass {
  frame: PhotoFrame
  jitter: [number, number]
  g: Uint16Array
  /** Teinte du sol au pixel, demi-flottants RGBA — `null` si l'imagerie a echoue. */
  imagery: Uint16Array | null
}

/** Une photo en cours, du cadrage fige a l'enregistrement. */
interface Session {
  dpr: number
  previousDpr: number
  pool: Worker[]
  shadow: DataTexture | null
  shadowHalfSpanM: number
  /** Passes rendues, pas encore affichees. */
  ready: ReadyPass[]
  /** Passe affichee, et images ecoulees depuis. */
  showing: boolean
  settle: number
  /** Somme des images lues, par canal. */
  sum: Uint32Array | null
  width: number
  height: number
  captured: number
  /** Le dpr est-il deja monte ? */
  raised: boolean
  dispose: () => void
}

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

  const session = useRef<Session | null>(null)

  /** La tache de preparation, pour le cadrage courant : la photo et le prechargement la construisent pareil. */
  const buildJob = () => {
    const store = useSkyStore.getState()
    const forward = new Vector3()
    camera.getWorldDirection(forward)
    const cam = camera as PerspectiveCamera
    const previousDpr = gl.getPixelRatio()
    const maxSide = Math.min(MAX_SIDE_PX, gl.capabilities.maxTextureSize - 64)
    const dpr = Math.min(previousDpr * store.photo.scale, maxSide / Math.max(size.width, size.height))
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
    return { job, relief, dpr, previousDpr }
  }

  // --- preview : precharger les tuiles du cadre ---------------------------------------
  //
  // Le telechargement des tuiles est le plus long de la photo, et il ne depend
  // que du cadrage. Des que la camera s'arrete, un worker charge les tuiles du
  // cadre dans le cache ; au declic, la preparation les y retrouve. Si la camera
  // repart, il s'arrete — les tuiles deja venues restent en cache.
  const prefetch = useRef<{ worker: Worker | null; key: string; still: number; done: string }>({ worker: null, key: '', still: 0, done: '' })
  const stopPrefetch = () => {
    prefetch.current.worker?.terminate()
    prefetch.current.worker = null
  }
  useFrame((state) => {
    const p = prefetch.current
    const store = useSkyStore.getState()
    if (store.photo.phase !== 'preview') {
      if (p.worker && store.photo.phase !== 'working') stopPrefetch()
      return
    }
    const cam = camera as PerspectiveCamera
    const e = camera.matrixWorld.elements
    const key = `${e[8].toFixed(4)},${e[9].toFixed(4)},${e[10].toFixed(4)},${cam.fov.toFixed(3)},${size.width}x${size.height},${store.photo.scale},${store.location.latitude},${store.location.longitude}`
    const now = state.clock.elapsedTime
    if (key !== p.key) {
      p.key = key
      p.still = now
      stopPrefetch()
      return
    }
    if (p.worker || p.done === key || now - p.still < PREFETCH_STILL_S) return
    const worker = newWorker()
    p.worker = worker
    worker.onmessage = (event: MessageEvent<PhotoWorkerMessage>) => {
      if (event.data.type !== 'prefetched' && event.data.type !== 'error') return
      if (prefetch.current.worker === worker) {
        prefetch.current.done = key
        stopPrefetch()
      }
    }
    worker.postMessage({ type: 'prepare', job: { ...buildJob().job, prefetch: true } })
  })
  const sun = useRef({ sunAltitudeDeg, sunAzimuthDeg })
  sun.current = { sunAltitudeDeg, sunAzimuthDeg }

  // --- Fin de session : annulation, ou photo enregistree ------------------------------
  const endSession = (restore: boolean) => {
    const s = session.current
    if (!s) return
    session.current = null
    s.dispose()
    if (restore && s.raised) applyDpr(s.previousDpr)
    setPhotoRender(null)
    s.shadow?.dispose()
  }

  // --- working : preparer, puis rendre les passes en parallele -----------------------
  useEffect(() => {
    if (phase === 'off' || phase === 'preview') {
      endSession(true)
      return
    }
    if (phase !== 'working' || session.current) return
    stopPrefetch()
    const store = useSkyStore.getState()
    const setPhoto = store.setPhoto
    const { job, relief, dpr, previousDpr } = buildJob()

    const poolSize = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1))
    let alive = true
    const s: Session = {
      dpr,
      previousDpr,
      pool: [newWorker()],
      shadow: null,
      shadowHalfSpanM: 0,
      ready: [],
      showing: false,
      settle: 0,
      sum: null,
      width: 0,
      height: 0,
      captured: 0,
      raised: false,
      dispose: () => {
        alive = false
        s.pool.forEach((w) => w.terminate())
      },
    }
    session.current = s
    const fail = (message: string) => {
      if (!alive) return
      setPhoto({ phase: 'preview', progress: null, message: `Échec : ${message}` })
    }

    // --- L'imagerie du sol, au pixel : un worker a part, qui garde ses tuiles ---
    const imageryWorker = newWorker()
    const disposeRender = s.dispose
    s.dispose = () => {
      disposeRender()
      imageryWorker.terminate()
    }
    const waitingImagery = new Map<number, ReadyPass>()
    let first = true
    const release = (pass: number, imagery: Uint16Array | null) => {
      const ready = waitingImagery.get(pass)
      if (!ready) return
      waitingImagery.delete(pass)
      ready.imagery = imagery
      s.ready.push(ready)
      if (first) {
        first = false
        setPhoto({ phase: 'capturing' })
      }
    }
    let imageryFailed = false
    imageryWorker.onmessage = (event: MessageEvent<PhotoWorkerMessage>) => {
      if (!alive) return
      const msg = event.data
      if (msg.type === 'progress') {
        setPhoto({ progress: { step: STEP_LABELS[msg.phase], fraction: msg.fraction, detail: msg.detail } })
      } else if (msg.type === 'imagery') {
        release(msg.pass, msg.data)
      } else if (msg.type === 'error') {
        // Sans imagerie, la photo se fait quand meme : le sol garde l'albedo du modele.
        console.warn('[photo] imagerie :', msg.message)
        imageryFailed = true
        for (const pass of [...waitingImagery.keys()]) release(pass, null)
      }
    }

    const render = (init: RenderInit) => {
      const { frame } = init
      imageryWorker.postMessage({ type: 'imageryInit', projector: init.projector })
      while (s.pool.length < poolSize) s.pool.push(newWorker())
      // Une bande porte toutes ses passes : la premiere y fait reference, et les
      // suivantes en reprennent l'ombre et le ciel hors des bords.
      const bandCount = s.pool.length * BANDS_PER_WORKER
      const per = Math.ceil(frame.cols / bandCount)
      const queue: BandJob[] = []
      for (let c = 0; c < frame.cols; c += per) queue.push({ jitters: JITTERS, colStart: c, colEnd: Math.min(frame.cols, c + per) })
      const total = queue.length * JITTERS.length
      const passes = JITTERS.map(() => ({ g: new Uint16Array(0), left: queue.length }))
      let done = 0
      let exact = 0

      const feed = (w: Worker) => {
        const next = queue.shift()
        if (next) w.postMessage({ type: 'band', job: next })
      }
      for (const w of s.pool) {
        w.onmessage = (event: MessageEvent<PhotoWorkerMessage>) => {
          if (!alive) return
          const msg = event.data
          if (msg.type === 'error') return fail(msg.message)
          if (msg.type !== 'band') return
          if (msg.pass === JITTERS.length - 1) feed(w)
          if (msg.pass > 0) exact += msg.exact
          const p = passes[msg.pass]
          if (p.g.length === 0) p.g = new Uint16Array(frame.cols * frame.rows * 8)
          // La bande arrive en lignes de sa propre largeur : on la range ligne
          // par ligne dans l'image entiere.
          const width = msg.colEnd - msg.colStart
          for (let r = 0; r < frame.rows; r++) {
            p.g.set(msg.g.subarray(r * width * 8, (r + 1) * width * 8), (r * frame.cols + msg.colStart) * 8)
          }
          done++
          // L'avancement des workers reste l'information utile pendant la
          // capture : les passes suivantes se calculent encore.
          setPhoto({
            progress: { step: STEP_LABELS.ombres, fraction: done / total, detail: `passe ${Math.min(JITTERS.length, msg.pass + 1)} / ${JITTERS.length}` },
          })
          if (--p.left === 0) {
            const [jx, jy] = JITTERS[msg.pass]
            const ready: ReadyPass = {
              frame: { ...frame, uMin: frame.uMin + jx * frame.step, vMin: frame.vMin + jy * frame.step },
              jitter: [jx, jy],
              g: p.g,
              imagery: null,
            }
            p.g = new Uint16Array(0)
            // L'imagerie de la passe se calcule a part ; la passe ne s'affiche
            // qu'avec elle. Le tampon part en copie : il sert encore ici.
            waitingImagery.set(msg.pass, ready)
            if (imageryFailed) release(msg.pass, null)
            else imageryWorker.postMessage({ type: 'imagery', pass: msg.pass, g: ready.g, frame: ready.frame })
            if (import.meta.env.DEV && done === total) {
              console.info('[photo] calcul exact sur', `${((100 * exact) / ((total / JITTERS.length) * (JITTERS.length - 1))).toFixed(1)} %`, 'des pixels des passes suivantes')
            }

          }
        }
        w.postMessage({ type: 'init', init })
        feed(w)
      }
    }

    s.pool[0].onmessage = (event: MessageEvent<PhotoWorkerMessage>) => {
      if (!alive) return
      const msg = event.data
      if (msg.type === 'progress') {
        setPhoto({ progress: { step: STEP_LABELS[msg.phase], fraction: msg.fraction, detail: msg.detail } })
      } else if (msg.type === 'error') {
        fail(msg.message)
      } else if (msg.type === 'prepared') {
        if (import.meta.env.DEV) console.info('[photo]', JSON.stringify(msg.stats), `${msg.frame.cols} × ${msg.frame.rows}`)
        s.shadow = photoShadowTexture(msg.shadow)
        s.shadowHalfSpanM = msg.shadow.halfSpanM
        render({
          ...relief,
          frame: msg.frame,
          tiles: msg.tiles,
          projector: msg.projector,
          maxGrid: msg.maxGrid,
          eyeM: job.eyeM,
          reachM: job.reachM,
          sunAltitudeDeg: job.sunAltitudeDeg,
          sunAzimuthDeg: job.sunAzimuthDeg,
          effectiveRadiusM: job.effectiveRadiusM,
          peakM: job.peakM,
        })
      }
    }
    s.pool[0].postMessage({ type: 'prepare', job })
    // Le cadrage est lu une fois, a l'entree dans la phase : c'est lui qu'on fige.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // Demontage : tout est rendu.
  useEffect(
    () => () => {
      endSession(true)
      stopPrefetch()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // --- capturing : afficher chaque passe, la lire juste apres le compositeur -----------
  useFrame(() => {
    const s = session.current
    if (!s || useSkyStore.getState().photo.phase !== 'capturing') return
    const store = useSkyStore.getState()

    if (!s.showing) {
      const next = s.ready.shift()
      if (!next || !s.shadow) return
      setPhotoRender(makePhotoRender(next.frame, next.jitter, next.g, next.imagery, s.shadow, s.shadowHalfSpanM))
      if (!s.raised) {
        s.raised = true
        applyDpr(s.dpr)
      }
      s.showing = true
      s.settle = 0
      return
    }
    s.settle++
    const need = s.captured === 0 ? SETTLE_FRAMES : PASS_SETTLE_FRAMES
    if (s.settle < need) return

    // Lu ici, dans la tache meme du rendu : voir l'en-tete.
    const canvas = gl.domElement
    if (!s.sum) {
      s.width = canvas.width
      s.height = canvas.height
      s.sum = new Uint32Array(s.width * s.height * 4)
    }
    if (canvas.width !== s.width || canvas.height !== s.height) {
      store.setPhoto({ phase: 'preview', progress: null, message: 'Échec : la taille du rendu a changé' })
      return
    }
    const reader = document.createElement('canvas')
    reader.width = s.width
    reader.height = s.height
    const ctx = reader.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.drawImage(canvas, 0, 0)
    const px = ctx.getImageData(0, 0, s.width, s.height).data
    const sum = s.sum
    for (let i = 0; i < px.length; i++) sum[i] += px[i]
    s.captured++
    s.showing = false
    if (s.captured < JITTERS.length) return

    // --- La moyenne, enregistree.
    const out = ctx.createImageData(s.width, s.height)
    const n = s.captured
    for (let i = 0; i < sum.length; i++) out.data[i] = Math.round(sum[i] / n)
    ctx.putImageData(out, 0, 0)
    const shotWidth = s.width
    const shotHeight = s.height
    const name = photoFileName(store.time)
    endSession(true)
    reader.toBlob((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      }
      useSkyStore.getState().setPhoto({
        phase: 'preview',
        progress: null,
        message: blob ? `Photo enregistrée — ${shotWidth} × ${shotHeight}` : 'Échec de l’enregistrement',
      })
    }, 'image/png')
  }, 2)

  return null
}

function photoFileName(timeMs: number): string {
  const d = new Date(timeMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `whats-up-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`
}
