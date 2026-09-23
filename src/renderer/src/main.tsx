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
    encoders: async () => [],
    cancelRender: async () => undefined,
    listJobs: async () => [],
    clearFinished: async () => undefined,
    chooseExportPath: async () => null,
    saveProject: unavailable,
    openProject: async () => null,
    revealPath: async () => undefined,
    openPath: async () => undefined,
    onJobsChanged: () => () => undefined,
    /*
     * The ones the app calls while it is STARTING UP.
     *
     * The stubs above can throw because nothing calls them until a button is
     * pressed, by which time the warning is on screen. These are different:
     * the app reports its menu state and asks for its settings during the
     * first render, so a throw here takes the window down with a stack trace
     * instead of the message explaining that the bridge did not load.
     */
    getSettings: async () => ({}),
    setSetting: async () => ({}),
    autosaveProject: async () => null,
    recoveries: async () => [],
    recoverProject: async () => null,
    clearAutosave: async () => undefined,
    reportMenuState: () => undefined,
    rememberRecent: () => undefined,
    reportSaved: () => undefined,
    onMenuCommand: () => () => undefined,
    onMenuOpen: () => () => undefined,
    microphonePermission: async () => false,
    saveVoiceOver: unavailable
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
