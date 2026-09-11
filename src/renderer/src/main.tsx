import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

/**
 * If the preload script fails to load, every window.forge call throws and the
 * window goes blank with nothing useful in it. Install inert stubs so the UI
 * still renders and can say what went wrong.
 */
function installFallbackBridge(): void {
  if (window.forge) return
  const unavailable = (): never => {
    throw new Error('The app bridge did not load — restart Forge')
  }
  window.forge = {
    getPathForFile: () => '',
    probe: async () => ({ assets: [], failed: [] }),
    pickMedia: async () => [],
    startRender: unavailable,
    cancelRender: async () => undefined,
    listJobs: async () => [],
    clearFinished: async () => undefined,
    chooseExportPath: async () => null,
    saveProject: unavailable,
    openProject: async () => null,
    revealPath: async () => undefined,
    openPath: async () => undefined,
    onJobsChanged: () => () => undefined
  } as unknown as Window['forge']

  queueMicrotask(() => {
    console.warn('Forge: preload bridge unavailable; running without app services.')
  })
}

installFallbackBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
