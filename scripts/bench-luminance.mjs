/** Mesure du cout de la bande de luminance de la frise temporelle. */
import { skyLuminance } from '../src/astro/photometry.ts'

const loc = { name: 'Paris', latitude: 48.8566, longitude: 2.3522, elevation: 35 }
const start = Date.now()

for (let w = 0; w < 4; w++) {
  const t0 = performance.now()
  for (let i = 0; i <= 96; i++) skyLuminance(new Date(start + i * 900_000), loc)
  console.log(`bande de 96 echantillons : ${(performance.now() - t0).toFixed(1)} ms`)
}

const t1 = performance.now()
for (let i = 0; i < 300; i++) skyLuminance(new Date(start + i * 1000), loc)
console.log(`skyLuminance unitaire     : ${((performance.now() - t1) / 300).toFixed(3)} ms`)
