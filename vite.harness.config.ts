import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Serves the renderer as an ordinary web page.
 *
 * No Electron, no preload, no main process — see src/renderer/src/harness. It
 * exists so the interface can be opened and clicked without building and
 * launching the app, which is the one thing that cannot be done from outside
 * the machine it runs on.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  plugins: [react(), tailwindcss()],
  define: { __BUILD_STAMP__: JSON.stringify('harness') },
  server: { port: 5199, strictPort: true, open: false }
})
