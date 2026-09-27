/**
 * Validation du niveau des plans d'eau.
 *
 * Un lac synthetique a 372 m, dont la frange du rivage porte les altitudes
 * fausses d'un relief mal recale (390 m), et un ocean : le lac doit sortir a
 * 372 m exactement, l'ocean a 0, et le niveau doit deborder de quelques
 * cellules sur la terre pour le filtrage du rivage.
 */
import { suite, type SuiteResult } from '@/atmosphere/validation/harness'
import { waterLevels } from './waterLevels'

export function waterLevelsSuite(): SuiteResult {
  return suite('Niveau des plans d’eau — mesure dans le relief', {}, (t) => {
    const size = 64
    const mask = new Uint8Array(size * size * 2)
    const heights = new Int16Array(size * size).fill(500)
    // Lac : carre 20..44 ; frange d'une cellule a 390 m, interieur a 372 m.
    for (let y = 20; y < 44; y++)
      for (let x = 20; x < 44; x++) {
        const i = y * size + x
        mask[2 * i] = 255
        heights[i] = x === 20 || x === 43 || y === 20 || y === 43 ? 390 : 372
      }
    // Ocean : bande du bas.
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x
        mask[2 * i] = 255
        mask[2 * i + 1] = 255
        heights[i] = 0
      }
    const level = waterLevels(size, mask, heights)
    t.check('lac : niveau = mediane de l’interieur, frange exclue', level[30 * size + 30], 372, 1e-9, ' m')
    t.check('lac : meme niveau sur sa frange', level[20 * size + 30], 372, 1e-9, ' m')
    t.check('ocean : 0 m', level[2 * size + 10], 0, 1e-9, ' m')
    t.check('niveau propage sur la terre voisine (3 cellules du lac)', level[30 * size + 17], 372, 1e-9, ' m')
  })
}
