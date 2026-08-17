import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // satellite.js reexporte un moteur SGP4 compile en WebAssembly que nous
      // n'appelons jamais. Sa variante multi-fils importe `node:worker_threads`
      // et s'ouvre sur une attente de premier niveau : Rollup refusait de
      // produire le paquet, et le prebundle du serveur de developpement echouait
      // de meme. On le remplace par un substitut qui leve.
      '#wasm-single-thread': fileURLToPath(new URL('./src/astro/sgp4-wasm-absent.ts', import.meta.url)),
      '#wasm-multi-thread': fileURLToPath(new URL('./src/astro/sgp4-wasm-absent.ts', import.meta.url)),
    },
  },
  optimizeDeps: {
    // Le prebundle des dependances a sa propre cible, independante de `build`,
    // et vaut es2020 par defaut. L'alignement sur es2022 evite qu'une syntaxe
    // moderne d'une dependance ne bloque le serveur de developpement alors que
    // la compilation, elle, passerait.
    esbuildOptions: { target: 'es2022' },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // Trois briques qui evoluent a des rythmes differents : le moteur 3D,
        // les ephemerides et le catalogue d'etoiles restent en cache entre deux
        // deploiements de l'interface.
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          astro: ['astronomy-engine'],
          catalog: ['./src/data/stars.json', './src/data/constellations.json', './src/data/deepsky.json'],
        },
      },
    },
  },
})
