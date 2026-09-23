import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { evalRelay, modelProxy } from './tests/eval/relay'

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
  plugins: [
    react(),
    tailwindcss(),
    /*
     * Serve the harness at `/`.
     *
     * The dev root is `src/renderer`, so without this `/` resolves to
     * index.html — the REAL app entry, whose fallback bridge has thirteen
     * inert methods. It renders, then dies on the first call to anything the
     * fallback does not stub, and the error it shows ("window.forge.<x> is not
     * a function") reads exactly like a bug in the harness bridge rather than
     * like the wrong page. That is a genuinely expensive ten minutes, and it is
     * paid by whoever next types the obvious URL.
     */
    {
      name: 'harness-at-root',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/' || req.url === '/index.html') req.url = '/harness.html'
          next()
        })
      }
    },
    /*
     * The Director eval's transport (tests/eval/relay.ts): a proxy to the model
     * server and a file endpoint scoped to tests/output/eval. The development
     * sandbox's shell cannot reach localhost; this server can.
     */
    evalRelay()
  ],
  define: { __BUILD_STAMP__: JSON.stringify('harness') },
  server: { port: 5199, strictPort: true, open: false, proxy: modelProxy }
})
