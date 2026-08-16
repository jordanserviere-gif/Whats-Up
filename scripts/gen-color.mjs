/**
 * Genere src/styles/tokens/color.css : l'integralite des roles de couleur
 * Material 3 (schema « Expressive ») derives d'une couleur source, en clair
 * et en sombre, plus les paliers de contraste medium / high.
 *
 * Usage : npm run color
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  Hct,
  SchemeVibrant,
  MaterialDynamicColors,
  hexFromArgb,
  argbFromHex,
} from '@material/material-color-utilities'

// Ce script est bundle par esbuild avant execution (le paquet material-color-utilities
// publie des imports ESM sans extension) : on se repere donc sur la racine du projet.
const OUT = join(process.cwd(), 'src', 'styles', 'tokens')

/** Couleur source : le bleu-indigo d'un ciel astronomique juste apres le crepuscule. */
const SOURCE = '#4C6FFF'

/** camelCase -> kebab-case, convention des tokens --md-sys-color-*. */
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

const ROLES = Object.getOwnPropertyNames(MaterialDynamicColors).filter((k) => {
  const v = MaterialDynamicColors[k]
  return v && typeof v === 'object' && typeof v.getArgb === 'function'
})

// SchemeVibrant conserve la teinte source pour le primaire (SchemeExpressive la fait
// pivoter fortement) tout en produisant des accents secondaires/tertiaires tres satures :
// c'est le variant qui sert le mieux une interface Expressive sur fond de ciel nocturne.
function scheme(dark, contrast) {
  const s = new SchemeVibrant(Hct.fromInt(argbFromHex(SOURCE)), dark, contrast)
  const out = []
  for (const role of ROLES.sort()) {
    out.push(`  --md-sys-color-${kebab(role)}: ${hexFromArgb(MaterialDynamicColors[role].getArgb(s))};`)
  }
  return out.join('\n')
}

const blocks = []
blocks.push('/* GENERE PAR scripts/gen-color.mjs — NE PAS EDITER A LA MAIN */')
blocks.push(`/* Material 3 — SchemeVibrant, source ${SOURCE} */`)
blocks.push('')
blocks.push('/* Clair = base ; le theme sombre est le defaut applicatif (voir base.css). */')
blocks.push(`:root {\n${scheme(false, 0)}\n}`)
blocks.push('')
blocks.push(`:root[data-theme='dark'] {\n${scheme(true, 0)}\n}`)
blocks.push('')
blocks.push(`:root[data-contrast='medium'] {\n${scheme(false, 0.5)}\n}`)
blocks.push(`:root[data-contrast='medium'][data-theme='dark'] {\n${scheme(true, 0.5)}\n}`)
blocks.push('')
blocks.push(`:root[data-contrast='high'] {\n${scheme(false, 1)}\n}`)
blocks.push(`:root[data-contrast='high'][data-theme='dark'] {\n${scheme(true, 1)}\n}`)
blocks.push('')

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'color.css'), blocks.join('\n'))
console.log(`src/styles/tokens/color.css genere — ${ROLES.length} roles x 6 variantes`)
