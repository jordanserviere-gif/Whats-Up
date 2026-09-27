/// <reference lib="webworker" />
import { DataUtils } from 'three'
import { loadScenario } from '@/data-sources/weatherScenario'
import { SUN_TABLE_WIDTH, computeCloudField, sunTableAltitude, type CloudFieldData } from './cloudField'
import { sunIrradianceAtAltitude } from './contrailLighting'
import { bakeBaseNoise, bakeDetailNoise, coverageTable } from '@/atmosphere/cloud/cloudNoise3d'

/**
 * Le calcul des nuages cote processeur, hors du fil principal.
 *
 * Deux travaux, tous deux trop longs pour une image : le champ de nappes d'un
 * scenario a un instant — un panache convectif par point de grille et par
 * heure encadrante — et la table du Soleil vu depuis chaque etage, soixante-
 * quatre integrations spectrales le long du trajet par etage. Le fil principal
 * ne recoit que des tableaux prets a televerser, transferes sans copie.
 */

export interface CloudWorkRequest {
  requestId: number
  scenarioId: string
  timeMs: number
}

export interface CloudWorkResult extends CloudFieldData {
  requestId: number
  /** Table du Soleil, demi-flottants RGBA, SUN_TABLE_WIDTH × 3. */
  sunTable: Uint16Array
  /** Sommets arrondis qui ont servi a la table, m. */
  sunTableTopsM: number[]
  /** Bruits 3D et leur table de couverture — joints a la premiere reponse seulement. */
  noise?: CloudNoise
}

export interface CloudNoise {
  base: Uint8Array
  detail: Uint8Array
  threshold: Float32Array
  meanDensity: Float32Array
}

/** Genere une fois : une seconde environ, hors du fil principal. */
let noiseSent = false
function bakeNoise(): CloudNoise {
  const base = bakeBaseNoise()
  const { threshold, meanDensity } = coverageTable(base)
  return { base, detail: bakeDetailNoise(), threshold, meanDensity }
}

function sunTable(topsM: number[]): Uint16Array {
  const data = new Uint16Array(SUN_TABLE_WIDTH * 3 * 4)
  topsM.forEach((h, k) => {
    for (let i = 0; i < SUN_TABLE_WIDTH; i++) {
      const rgb = sunIrradianceAtAltitude(sunTableAltitude(i / (SUN_TABLE_WIDTH - 1)), h)
      const o = (k * SUN_TABLE_WIDTH + i) * 4
      data[o] = DataUtils.toHalfFloat(rgb[0])
      data[o + 1] = DataUtils.toHalfFloat(rgb[1])
      data[o + 2] = DataUtils.toHalfFloat(rgb[2])
      data[o + 3] = DataUtils.toHalfFloat(1)
    }
  })
  return data
}

const scope = self as unknown as DedicatedWorkerGlobalScope
scope.onmessage = async (event: MessageEvent<CloudWorkRequest>) => {
  const { requestId, scenarioId, timeMs } = event.data
  const scenario = await loadScenario(scenarioId)
  const field = computeCloudField(scenario, timeMs)
  // Sommets a 250 m pres : au-dela, la table ne change pas visiblement.
  const tops = field.overhead.map((s) => Math.round(s.topM / 250) * 250)
  const result: CloudWorkResult = { ...field, requestId, sunTable: sunTable(tops), sunTableTopsM: tops }
  const transfer: ArrayBuffer[] = [result.far.buffer as ArrayBuffer, result.near.buffer as ArrayBuffer, result.sunTable.buffer as ArrayBuffer]
  if (!noiseSent) {
    result.noise = bakeNoise()
    transfer.push(result.noise.base.buffer as ArrayBuffer, result.noise.detail.buffer as ArrayBuffer)
    noiseSent = true
  }
  scope.postMessage(result, transfer)
}
