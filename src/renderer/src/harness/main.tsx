import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../App'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { installHarnessBridge } from './bridge'
import { installEvalRelay } from './evalRelay'
import { useEditor } from '../store'
import { useCatalog } from '../catalog'
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

/* The Director eval's relay — tests/eval/relay.ts says why the harness carries it. */
installEvalRelay()

/*
 * The store, reachable from a driving script.
 *
 * Setting a scenario up by clicking through the panels tests the panels, which
 * is often not the thing under examination — and a scenario that takes fifteen
 * clicks is a scenario nobody checks twice. This is the same store the app uses;
 * only the harness hands out a reference to it.
 */
;(window as unknown as { forgeStore: typeof useEditor }).forgeStore = useEditor

/*
 * The catalog too, for the same reason and one more.
 *
 * The asset library is the one thing the harness genuinely cannot have — the
 * bridge returns an empty transition list, because those 405 masks are files on
 * a disk the browser cannot reach. So the only way to drive a luma wipe here is
 * to put one in by hand, pointing at a mask the dev server will serve. Without
 * this the entire wipe path — 405 of the 413 transitions — is unreachable in
 * the one place it can be watched running.
 */
;(window as unknown as { forgeCatalog: typeof useCatalog }).forgeCatalog = useCatalog

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
