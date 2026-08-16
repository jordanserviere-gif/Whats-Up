import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
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
          catalog: ['./src/data/stars.json', './src/data/constellations.json'],
        },
      },
    },
  },
})
