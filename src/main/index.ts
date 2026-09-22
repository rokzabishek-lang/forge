import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { applyMenu, EMPTY_MENU_STATE, type MenuState } from './menu'
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

/**
 * What the renderer last told us about itself.
 *
 * The menu's enabled states and the close guard both read it. Held here rather
 * than asked for on demand because a menu is rebuilt on every change and an IPC
 * round-trip per rebuild would make the menu bar lag behind the editor.
 */
let menuState: MenuState = EMPTY_MENU_STATE
let recentProjects: string[] = []
/** True once the close guard has had its answer, so it does not ask twice. */
let closing = false

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
   * Do not let the window take an hour of work with it.
   *
   * There was no `close` handler at all, so closing the window discarded
   * everything since the last manual save with no prompt of any kind. This
   * asks the renderer whether there is anything to lose, and only then asks
   * the person.
   *
   * `closing` guards the second pass: answering "Save" or "Don't save" ends in
   * `close()` being called again, and without the flag that would ask a second
   * time — forever.
   */
  mainWindow.on('close', (event) => {
    if (closing || !menuState.dirty) return
    event.preventDefault()
    void (async () => {
      const window = mainWindow
      if (!window) return
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'Save this project before closing?',
        detail: 'Your changes since the last save will be lost otherwise.'
      })
      if (response === 2) return
      if (response === 0) {
        /*
         * Wait for the save to finish before closing.
         *
         * The renderer owns the project and the save is asynchronous, so
         * closing on the reply alone would race the write — and the one time
         * that race is lost is the one time it matters.
         */
        const saved = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 20_000)
          ipcMain.once('project:saved', (_e, ok: boolean) => {
            clearTimeout(timer)
            resolve(ok)
          })
          window.webContents.send('menu:command', 'save')
        })
        // A refused dialog or a failed write is a reason to stay open, not a
        // reason to close and hope.
        if (!saved) return
      }
      closing = true
      window.close()
    })()
  })

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

  /*
   * The renderer tells us what it can do; the menu reflects it.
   *
   * Rebuilt rather than mutated: Electron's menu items are immutable once
   * built, and rebuilding a menu of this size is cheap next to anything else
   * that happens when a selection changes.
   */
  ipcMain.on('menu:state', (_e, next: MenuState) => {
    menuState = { ...EMPTY_MENU_STATE, ...next }
    applyMenu(mainWindow, menuState, recentProjects)
  })

  ipcMain.on('menu:recent', (_e, path: string) => {
    if (typeof path !== 'string' || path.length === 0) return
    recentProjects = [path, ...recentProjects.filter((p) => p !== path)].slice(0, 10)
    applyMenu(mainWindow, menuState, recentProjects)
  })

  applyMenu(mainWindow, menuState, recentProjects)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  /*
   * Quitting is the same question as closing, asked from somewhere else.
   *
   * Without this, Cmd+Q walked straight past the close guard — the window's
   * `close` handler does not run for a quit that has already been accepted —
   * so the one gesture people use to leave an app was the one that lost their
   * work. Routed through the window's own guard so there is one dialog and one
   * answer.
   */
  if (!closing && menuState.dirty && mainWindow) {
    event.preventDefault()
    mainWindow.close()
    return
  }
  // Closing stdin lets Python finish in-flight work and exit cleanly.
  stopSidecar()
})
