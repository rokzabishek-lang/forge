import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import type { GraphicsSpec } from '@shared/graphics/spec'

/**
 * Renders the graphics layer offscreen, one frame at a time.
 *
 * A hidden BrowserWindow is the whole trick: Electron already ships Chromium, so
 * the compositor, text engine, WebGL and easing are free. `capturePage().toBitmap()`
 * returns raw BGRA — no PNG encode/decode in the loop — which ffmpeg consumes
 * directly as rawvideo.
 */
export class FrameServer {
  private window: BrowserWindow | null = null
  private spec: GraphicsSpec | null = null

  async open(spec: GraphicsSpec): Promise<void> {
    await this.close()

    this.window = new BrowserWindow({
      width: spec.width,
      height: spec.height,
      show: false,
      // Without transparency the capture comes back on an opaque white page and
      // every composite is a white box over the video.
      transparent: true,
      frame: false,
      backgroundColor: '#00000000',
      useContentSize: true,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
        // The page is ours and renders no user input; disabling background
        // throttling keeps rAF running while the window is hidden, which it
        // otherwise would not.
        backgroundThrottling: false
      }
    })

    const url = process.env.ELECTRON_RENDERER_URL
      ? `${process.env.ELECTRON_RENDERER_URL}/graphics.html`
      : `file://${join(__dirname, '../renderer/graphics.html')}`

    await this.window.loadURL(url)
    await this.waitForPage()

    this.spec = spec
    await this.window.webContents.executeJavaScript(
      `window.forgeGraphics.setSpec(${JSON.stringify(spec)}); window.forgeGraphics.waitForFonts()`
    )
  }

  /** The module script may not have run when loadURL resolves. */
  private async waitForPage(deadlineMs = 10_000): Promise<void> {
    const contents = this.window?.webContents
    if (!contents) throw new Error('The graphics window is not open')

    const started = Date.now()
    for (;;) {
      const ready = await contents.executeJavaScript('Boolean(window.forgeGraphics?.ready)')
      if (ready) return
      if (Date.now() - started > deadlineMs) {
        throw new Error('The graphics layer did not finish loading')
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /** Raw BGRA for one frame, `width * height * 4` bytes. */
  async renderFrame(frame: number): Promise<Buffer> {
    const window = this.window
    if (!window || !this.spec) throw new Error('The frame server is not open')

    await window.webContents.executeJavaScript(`window.forgeGraphics.renderFrame(${frame})`)
    const image = await window.webContents.capturePage()
    return image.toBitmap()
  }

  get size(): { width: number; height: number } | null {
    return this.spec ? { width: this.spec.width, height: this.spec.height } : null
  }

  async close(): Promise<void> {
    const window = this.window
    this.window = null
    this.spec = null
    if (window && !window.isDestroyed()) window.destroy()
  }
}

/** Where the built graphics page lives, for diagnostics. */
export function graphicsPagePath(): string {
  return app.isPackaged
    ? join(__dirname, '../renderer/graphics.html')
    : (process.env.ELECTRON_RENDERER_URL ?? '') + '/graphics.html'
}
