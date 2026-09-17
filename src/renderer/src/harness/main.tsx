import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../App'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { installHarnessBridge } from './bridge'
import { useEditor } from '../store'
import '../styles.css'

/**
 * The renderer, in a plain browser.
 *
 * Same App, same store, same components — only the bridge differs. Whatever the
 * harness shows about layout, panel logic or where an overlay lands is true of
 * the real app; whatever it shows about ffmpeg, the sidecar or exporting is not,
 * and those calls throw with a message saying so rather than faking a result.
 */
installHarnessBridge()

/*
 * The store, reachable from a driving script.
 *
 * Setting a scenario up by clicking through the panels tests the panels, which
 * is often not the thing under examination — and a scenario that takes fifteen
 * clicks is a scenario nobody checks twice. This is the same store the app uses;
 * only the harness hands out a reference to it.
 */
;(window as unknown as { forgeStore: typeof useEditor }).forgeStore = useEditor

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
