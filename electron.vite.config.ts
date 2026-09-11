import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')

/**
 * Stamped into the renderer so the UI can show which build is actually running.
 * Repeatedly debugging "the change did not land" when the change was fine but
 * the process was stale is worth one constant.
 */
const BUILD_STAMP = new Date().toISOString()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@shared': shared, '@': resolve(__dirname, 'src/renderer/src') }
    },
    plugins: [react(), tailwindcss()],
    define: { __BUILD_STAMP__: JSON.stringify(BUILD_STAMP) },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // Second entry: the offscreen graphics layer. Separate page, separate
          // bundle — it must not carry the editor's code or its CSP.
          graphics: resolve(__dirname, 'src/renderer/graphics.html')
        }
      }
    }
  }
})
