import { app, BrowserWindow, dialog, protocol, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { registerMediaProtocol } from './mediaProtocol'
import { assertBinaries } from './ffmpeg/paths'
import { startSidecar, stopSidecar, type SidecarStatus } from './sidecar/service'

let mainWindow: BrowserWindow | null = null

/**
 * Local media cannot be loaded as file:// from the renderer's origin. A privileged
 * scheme fixes that — and `stream: true` is what gives us HTTP range requests,
 * without which seeking in a <video> element does not work at all.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'forge-media',
    /*
     * corsEnabled, or the GPU grade cannot see the picture.
     *
     * WebGL refuses a texture from an element that was not fetched with CORS
     * approval, so the preview elements ask for it — and without this flag
     * Chromium fails that request outright rather than consulting the
     * Access-Control-Allow-Origin header the handler already sends. The result
     * was every image failing to load at all: a black preview with the audio
     * still playing.
     */
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  /*
   * Say something when the renderer dies or stops responding.
   *
   * Without these a crashed or wedged renderer is just a window that stopped
   * repainting: no error, no log, nothing to report — which is indistinguishable
   * from the app working slowly, and impossible to debug from a description.
   */
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[forge] renderer gone: ${details.reason} (exit ${details.exitCode})`)
    dialog.showErrorBox(
      'Forge stopped responding',
      `The window crashed (${details.reason}). Your project was not saved automatically.\n\n` +
        'Reopen the app and use Cmd+S early next time.'
    )
  })

  mainWindow.on('unresponsive', () => {
    console.error('[forge] renderer is unresponsive — still working, or stuck')
  })
  mainWindow.on('responsive', () => {
    console.error('[forge] renderer responsive again')
  })

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    // A preload that throws leaves window.forge undefined, so every IPC call in
    // the UI fails at once and the app looks frozen rather than broken.
    console.error(`[forge] preload failed (${preloadPath}):`, error)
    dialog.showErrorBox('Forge could not start', `The preload script failed:\n\n${error.message}`)
  })

  // In dev, open the inspector: an exception in the renderer is otherwise
  // invisible from outside the window.
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerMediaProtocol()
  registerIpc(() => mainWindow)
  createWindow()

  const binaries = assertBinaries()
  if (!binaries.ok) {
    dialog.showErrorBox('Forge cannot start its media engine', binaries.message)
  }

  // Deliberately not awaited: the editor must be fully usable whether or not
  // the AI sidecar ever comes up.
  startSidecar((status: SidecarStatus) => {
    mainWindow?.webContents.send('sidecar:status', status)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Closing stdin lets Python finish in-flight work and exit cleanly.
  stopSidecar()
})
