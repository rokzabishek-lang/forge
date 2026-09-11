import { app, BrowserWindow, dialog, net, protocol, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
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
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

function registerMediaProtocol(): void {
  protocol.handle('forge-media', async (request) => {
    // The path travels as a query parameter so Windows drive letters and
    // backslashes never have to survive URL path encoding.
    const target = new URL(request.url).searchParams.get('p')
    if (!target) return new Response('Missing path', { status: 400 })

    const response = await net.fetch(pathToFileURL(target).toString(), {
      bypassCustomProtocolHandlers: true
    })

    // Fonts are ALWAYS fetched in CORS mode, unlike images and video. Without an
    // allow-origin header every FontFace.load() fails with an opaque "network
    // error" even though the file is served fine — which is exactly what it did.
    const headers = new Headers(response.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin')

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  })
}

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
