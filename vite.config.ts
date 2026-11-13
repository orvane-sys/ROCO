import { createHash } from 'node:crypto'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The built page's Content Security Policy, as a <meta> tag (GitHub Pages and the launcher send no headers). The page runs only its
 * own scripts and the one inline theme script, by its hash, so an edit to that script cannot leave a stale hash. Meshopt decodes
 * the robot's meshes in WebAssembly ('wasm-unsafe-eval', not 'unsafe-eval'). It connects to itself and to the bridge, whose
 * address the user sets (ws: wss:), and reads imported files and makes downloads from blob: URLs. A meta tag cannot set
 * frame-ancestors. Development (npm run dev) has no policy: Vite's live reload needs inline code.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'roco-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        if (inline.length !== 1) throw new Error(`roco-csp: index.html has ${inline.length} inline scripts; the policy allows exactly one (the theme script)`)
        const hash = createHash('sha256').update(inline[0][1], 'utf8').digest('base64')
        const policy = [
          "default-src 'self'",
          `script-src 'self' 'sha256-${hash}' 'wasm-unsafe-eval'`,
          "style-src 'self'",
          "img-src 'self' data: blob:",
          "connect-src 'self' ws: wss: blob: data:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'none'",
        ].join('; ')
        const charset = '<meta charset="UTF-8" />'
        if (html.split(charset).length !== 2) throw new Error('roco-csp: index.html must have one <meta charset="UTF-8" />, the policy goes right after it')
        return html.replace(charset, `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`)
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves the page from /<repo>/
  base: process.env.ROCO_BASE ?? '/',
  plugins: [
    tailwindcss(),
    react(),
    contentSecurityPolicy(),
  ],
  build: {
    // three.js alone is ~700 kB; flag anything that grows well beyond that.
    chunkSizeWarningLimit: 800,
    // Bundling strips the notices the packages' licences ask us to pass on, so they ship as one file next to the page.
    license: { fileName: 'THIRD-PARTY-LICENSES.md' },
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
