import type { CloudWorkRequest, CloudWorkResult } from './cloudWorker'

/**
 * Acces au worker des nuages. Une seule demande compte a la fois : la plus
 * recente. Une reponse devenue perimee — l'heure a encore change entre-temps —
 * est ignoree plutot qu'annulee, le worker n'ayant pas de point d'arret.
 */
let worker: Worker | null = null
let nextId = 1
let latest = 0
const pending = new Map<number, (r: CloudWorkResult) => void>()

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./cloudWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<CloudWorkResult>) => {
    const resolve = pending.get(event.data.requestId)
    pending.delete(event.data.requestId)
    if (resolve && event.data.requestId === latest) resolve(event.data)
  }
  return worker
}

/** Champ et table du Soleil pour `timeMs`, ou jamais si une demande plus recente la remplace. */
export function requestCloudField(scenarioId: string, timeMs: number): Promise<CloudWorkResult> {
  const requestId = nextId++
  latest = requestId
  const message: CloudWorkRequest = { requestId, scenarioId, timeMs }
  return new Promise((resolve) => {
    pending.set(requestId, resolve)
    ensureWorker().postMessage(message)
  })
}
