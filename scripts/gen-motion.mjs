/**
 * Genere src/styles/tokens/motion.css a partir du systeme de physique
 * Material 3 Expressive (MotionScheme.expressive de androidx.compose.material3).
 *
 * Chaque ressort (stiffness / dampingRatio, masse = 1) est echantillonne puis
 * exprime en CSS `linear()` — ce qui reproduit fidelement le rebond (overshoot)
 * des tokens « spatial », impossible avec une cubic-bezier.
 *
 * Usage : npm run motion
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'tokens')

/** MotionScheme.expressive() — androidx.compose.material3 */
const SPRINGS = {
  'spatial-fast': { stiffness: 800, damping: 0.6 },
  'spatial-default': { stiffness: 380, damping: 0.8 },
  'spatial-slow': { stiffness: 200, damping: 0.8 },
  'effects-fast': { stiffness: 3800, damping: 1.0 },
  'effects-default': { stiffness: 1600, damping: 1.0 },
  'effects-slow': { stiffness: 800, damping: 1.0 },
}

/** Reponse indicielle d'un ressort masse-unite, normalisee de 0 a 1. */
function springValue(t, stiffness, zeta) {
  const w = Math.sqrt(stiffness)
  if (zeta < 1) {
    const wd = w * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t))
  }
  return 1 - Math.exp(-w * t) * (1 + w * t)
}

/** Duree de stabilisation : |x - 1| durablement sous 0.1 %. */
function settleTime(stiffness, zeta) {
  const dt = 1 / 2000
  let stable = 0
  for (let t = dt; t < 6; t += dt) {
    if (Math.abs(springValue(t, stiffness, zeta) - 1) < 0.001) {
      stable += dt
      if (stable > 0.03) return t
    } else stable = 0
  }
  return 6
}

function toLinear(stiffness, zeta, duration, steps = 64) {
  const pts = []
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * duration
    pts.push(i === steps ? 1 : +springValue(t, stiffness, zeta).toFixed(4))
  }
  return `linear(${pts.join(', ')})`
}

const lines = [
  '/* GENERE PAR scripts/gen-motion.mjs — NE PAS EDITER A LA MAIN */',
  '/* Material 3 Expressive — systeme de mouvement physique (ressorts) */',
  '',
  ':root {',
]

for (const [name, { stiffness, damping }] of Object.entries(SPRINGS)) {
  const d = settleTime(stiffness, damping)
  const ms = Math.round(d * 1000)
  lines.push(`  /* ${name} — stiffness ${stiffness}, damping ${damping} */`)
  lines.push(`  --md-sys-motion-spring-${name}-duration: ${ms}ms;`)
  lines.push(`  --md-sys-motion-spring-${name}: ${toLinear(stiffness, damping, d)};`)
}

lines.push('')
lines.push('  /* Courbes standard M3 (transitions non regies par la physique) */')
lines.push('  --md-sys-motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);')
lines.push('  --md-sys-motion-easing-standard-accelerate: cubic-bezier(0.3, 0, 1, 1);')
lines.push('  --md-sys-motion-easing-standard-decelerate: cubic-bezier(0, 0, 0, 1);')
lines.push('  --md-sys-motion-easing-emphasized: cubic-bezier(0.2, 0, 0, 1);')
lines.push('  --md-sys-motion-easing-emphasized-accelerate: cubic-bezier(0.3, 0, 0.8, 0.15);')
lines.push('  --md-sys-motion-easing-emphasized-decelerate: cubic-bezier(0.05, 0.7, 0.1, 1);')
lines.push('  --md-sys-motion-easing-linear: linear;')
lines.push('')
lines.push('  --md-sys-motion-duration-short1: 50ms;')
lines.push('  --md-sys-motion-duration-short2: 100ms;')
lines.push('  --md-sys-motion-duration-short3: 150ms;')
lines.push('  --md-sys-motion-duration-short4: 200ms;')
lines.push('  --md-sys-motion-duration-medium1: 250ms;')
lines.push('  --md-sys-motion-duration-medium2: 300ms;')
lines.push('  --md-sys-motion-duration-medium3: 350ms;')
lines.push('  --md-sys-motion-duration-medium4: 400ms;')
lines.push('  --md-sys-motion-duration-long1: 450ms;')
lines.push('  --md-sys-motion-duration-long2: 500ms;')
lines.push('  --md-sys-motion-duration-long3: 550ms;')
lines.push('  --md-sys-motion-duration-long4: 600ms;')
lines.push('  --md-sys-motion-duration-extra-long1: 700ms;')
lines.push('  --md-sys-motion-duration-extra-long2: 800ms;')
lines.push('  --md-sys-motion-duration-extra-long3: 900ms;')
lines.push('  --md-sys-motion-duration-extra-long4: 1000ms;')
lines.push('}')
lines.push('')
lines.push('@media (prefers-reduced-motion: reduce) {')
lines.push('  :root {')
for (const name of Object.keys(SPRINGS)) {
  lines.push(`    --md-sys-motion-spring-${name}-duration: 1ms;`)
  lines.push(`    --md-sys-motion-spring-${name}: linear;`)
}
lines.push('  }')
lines.push('}')
lines.push('')

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'motion.css'), lines.join('\n'))
console.log('src/styles/tokens/motion.css genere')
for (const [name, s] of Object.entries(SPRINGS)) {
  console.log(`  ${name.padEnd(18)} ${Math.round(settleTime(s.stiffness, s.damping) * 1000)}ms`)
}
