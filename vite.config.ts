import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves the page from /<repo>/
  base: process.env.ROCO_BASE ?? '/',
  plugins: [
    tailwindcss(),
    react(),
  ],
  build: {
    // three.js alone is ~700 kB; flag anything that grows well beyond that.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // Keep the 3D stack in its own cacheable chunk; app code changes far more often than three.js.
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three'
          if (id.includes('node_modules/urdf-loader/')) return 'urdf-loader'
        },
      },
    },
  },
})
