import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAssetFile } from '../src/main/assets/scan'

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-paths-'))
  await writeFile(join(dir, 'generated.png'), 'x')
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

describe('resolveAssetFile', () => {
  /*
   * Every attempt to place text, a colour card or a title failed with
   * "ENOENT: no such file or directory, stat".
   *
   * `join` does not treat an absolute second argument as absolute — it
   * concatenates — so an absolute path to generated artwork was being glued
   * onto the end of the assets root.
   */
  it('returns an absolute path untouched', () => {
    const absolute = join(dir, 'generated.png')
    expect(resolveAssetFile(absolute)).toBe(absolute)
  })

  it('does not glue an absolute path onto the assets root', () => {
    const absolute = join(dir, 'generated.png')
    const resolved = resolveAssetFile(absolute)
    // The bug produced /assets/root/Users/.../generated.png
    expect(resolved.indexOf(dir)).toBe(0)
    expect(resolved.lastIndexOf(dir)).toBe(0)
  })

  // The relative branch is not covered here: it calls assetsRoot(), which needs
  // Electron's app.getPath and cannot run outside the main process. The bug was
  // entirely in the absolute branch.
})
