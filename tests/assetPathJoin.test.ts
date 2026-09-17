import { describe, it, expect } from 'vitest'
import { win32, posix } from 'node:path'
import { assetPath, samePath } from '@shared/assetPath'

/*
 * The renderer has no `node:path`, so it joins asset paths by hand. The main
 * process uses `path.join`. If the two ever disagree, every string comparison
 * between a renderer-built path and a main-built one silently fails — which is
 * exactly what happened on Windows, where the hand-built path kept the forward
 * slashes and `path.join` did not.
 *
 * So the test is not "does assetPath look right"; it is "does assetPath agree
 * with the function on the other side of the IPC boundary". That comparison is
 * available on any platform, because `path.win32` is always there.
 */

describe('assetPath agrees with the path.join on the other side of the IPC', () => {
  const RELATIVES = [
    'sfx/fast_whoosh.wav',
    'stickers/color/svg/1F525.svg',
    'transitions/common/wipe_right_to_left.svg',
    'fonts/Inter.ttf',
    'single.png'
  ]

  it('matches path.win32.join for a drive-letter root', () => {
    const root = 'C:\\Users\\me\\AppData\\Local\\Programs\\forge\\resources\\assets'
    for (const rel of RELATIVES) {
      expect(assetPath(root, rel)).toBe(win32.join(root, rel))
    }
  })

  it('matches path.win32.join for a UNC root', () => {
    const root = '\\\\studio\\share\\forge\\assets'
    for (const rel of RELATIVES) {
      expect(assetPath(root, rel)).toBe(win32.join(root, rel))
    }
  })

  it('matches path.posix.join for a unix root', () => {
    const root = '/Applications/Forge.app/Contents/Resources/assets'
    for (const rel of RELATIVES) {
      expect(assetPath(root, rel)).toBe(posix.join(root, rel))
    }
  })

  it('decides from the root, so a backslash in a unix filename survives', () => {
    /*
     * The tempting implementation is `root.includes('\\') ? ... : ...`, which
     * would treat this perfectly legal macOS directory as a Windows path and
     * mangle everything under it. A drive letter or a UNC prefix is the only
     * thing that actually means Windows.
     */
    const root = '/Users/me/odd\\name/assets'
    expect(assetPath(root, 'sfx/a.wav')).toBe(posix.join(root, 'sfx/a.wav'))
    expect(assetPath(root, 'sfx/a.wav')).toContain('odd\\name')
  })

  it('does not double the separator when the root already ends in one', () => {
    expect(assetPath('/a/b/', 'c.wav')).toBe('/a/b/c.wav')
    expect(assetPath('C:\\a\\b\\', 'c.wav')).toBe('C:\\a\\b\\c.wav')
  })
})

describe('samePath', () => {
  it('sees through the separator, which is the whole point', () => {
    expect(samePath('C:\\a\\b\\c.wav', 'C:\\a\\b/c.wav')).toBe(true)
    expect(samePath('C:/a/b/c.wav', 'C:\\a\\b\\c.wav')).toBe(true)
    expect(samePath('/a/b/c.wav', '/a/b/c.wav')).toBe(true)
  })

  it('still tells different files apart', () => {
    expect(samePath('/a/b/c.wav', '/a/b/d.wav')).toBe(false)
    expect(samePath('C:\\a\\b.wav', 'C:\\a\\bb.wav')).toBe(false)
  })

  it('does NOT fold case, even though Windows would', () => {
    /*
     * Folding case would make Photo.jpg and photo.jpg one asset on macOS, where
     * they are two different files. That trades a duplicate entry for an
     * overwrite, which is the worse failure. Pinned so a future "fix" has to
     * argue with it first.
     */
    expect(samePath('/a/Photo.jpg', '/a/photo.jpg')).toBe(false)
  })

  it('dedups an audition against a dragged asset, the case that regressed', () => {
    // What the main process stored, and what the renderer built, for one file.
    const fromMain = win32.join('C:\\forge\\resources\\assets', 'sfx/whoosh.wav')
    const fromRenderer = assetPath('C:\\forge\\resources\\assets', 'sfx/whoosh.wav')
    expect(samePath(fromMain, fromRenderer)).toBe(true)
  })
})
