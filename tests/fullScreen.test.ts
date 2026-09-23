import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { escapeLeavesFullScreen } from '@shared/fullScreen'

/*
 * Full screen has a way out.
 *
 * Reported from the app: View → Toggle Full Screen went in and nothing came
 * out. Escape did nothing and there was no control for it; on Windows, full
 * screen also hides the menu bar the toggle lives in. The user had to quit.
 */

const key = (over: Partial<{ key: string; defaultPrevented: boolean; target: unknown }> = {}) => ({
  key: 'Escape',
  defaultPrevented: false,
  target: { tagName: 'DIV', isContentEditable: false },
  ...over
})

describe('Escape in full screen', () => {
  it('leaves full screen when nothing else wanted the key', () => {
    expect(escapeLeavesFullScreen(key(), true)).toBe(true)
    // The window itself, or no target at all, is still "nothing else".
    expect(escapeLeavesFullScreen(key({ target: null }), true)).toBe(true)
  })

  it('does nothing when the window is not full screen, or for any other key', () => {
    expect(escapeLeavesFullScreen(key(), false)).toBe(false)
    expect(escapeLeavesFullScreen(key({ key: 'Enter' }), true)).toBe(false)
  })

  it('leaves Escape to whatever used it first — a menu, a sheet, a picker', () => {
    expect(escapeLeavesFullScreen(key({ defaultPrevented: true }), true)).toBe(false)
  })

  it('never leaves full screen for an Escape typed into a field', () => {
    for (const tagName of ['INPUT', 'textarea', 'SELECT']) {
      expect(escapeLeavesFullScreen(key({ target: { tagName } }), true), tagName).toBe(false)
    }
    expect(escapeLeavesFullScreen(key({ target: { tagName: 'DIV', isContentEditable: true } }), true)).toBe(false)
  })
})

const source = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8')

describe('the way out is wired', () => {
  it('the main process tells the page, and can take the window out', () => {
    const main = source('src/main/index.ts')
    expect(main).toContain("mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('window:fullscreen', true))")
    expect(main).toContain("mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('window:fullscreen', false))")
    expect(main).toContain("ipcMain.on('window:exitFullScreen', () => mainWindow?.setFullScreen(false))")
    const preload = source('src/preload/index.ts')
    expect(preload).toContain("ipcRenderer.on('window:fullscreen', listener)")
    expect(preload).toContain("ipcRenderer.send('window:exitFullScreen')")
  })

  it('the page shows an Exit button while full screen, and asks to leave on Escape', () => {
    const app = source('src/renderer/src/App.tsx')
    expect(app).toContain('useEffect(() => window.forge.onFullScreen(setFullScreen), [])')
    expect(app).toMatch(/\{fullScreen && \(\s*<button\s*onClick=\{\(\) => window\.forge\.exitFullScreen\(\)\}/)
    expect(app).toContain('if (escapeLeavesFullScreen(e, true)) window.forge.exitFullScreen()')
  })

  it('the menu and the shortcuts sheet mark the Escape they used as handled', () => {
    // Otherwise closing either would also throw the window out of full screen.
    for (const file of ['src/renderer/src/components/ClipMenu.tsx', 'src/renderer/src/components/Shortcuts.tsx']) {
      expect(source(file), file).toMatch(/if \(e\.key === 'Escape'\) \{\s*\/\/[^\n]*\n\s*e\.preventDefault\(\)\s*\n\s*onClose\(\)/)
    }
  })
})
