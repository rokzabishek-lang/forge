import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// js-yaml ships no types and is used only here, so the shape is declared at
// the point of use rather than adding a dependency for one function.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- no bundled type declarations
import { load } from 'js-yaml'

/*
 * The packaging config has to agree with the code, and nothing else checks it.
 *
 * Three places in `src/main` resolve a path that only exists because
 * `electron-builder.yml` puts something there. None of them can fail in
 * development — `app.isPackaged` is false, so every one takes the other branch
 * — and none of them is exercised by any other test. The first sign of a
 * mismatch is a user's install: an error dialog, an empty asset library, or a
 * sidecar that never starts.
 *
 * So this reads the real config and asserts the coupling. It is a cheap test
 * for an expensive failure, and it is the only thing standing between "someone
 * tidied the builder config" and "the app is inert on a machine we cannot see".
 */

const ROOT = resolve(__dirname, '..')

interface BuilderConfig {
  appId?: string
  productName?: string
  files?: string[]
  asarUnpack?: string[]
  extraResources?: { from: string; to: string; filter?: string[] }[]
  win?: { target?: unknown }
  mac?: { target?: unknown }
  nsis?: { oneClick?: boolean }
  publish?: unknown
}

const config = load(readFileSync(resolve(ROOT, 'electron-builder.yml'), 'utf8')) as BuilderConfig
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

describe('the packaged app can find its binaries', () => {
  it('unpacks both ffmpeg installers from the asar', () => {
    /*
     * `resolveBinary` in src/main/ffmpeg/paths.ts rewrites `app.asar` to
     * `app.asar.unpacked` for these two. Nothing can be EXECUTED from inside
     * an asar archive, so without the unpack rule `assertBinaries()` puts up
     * its dialog at startup and the app cannot process a single frame.
     */
    const unpack = (config.asarUnpack ?? []).join('\n')
    expect(unpack).toContain('@ffmpeg-installer')
    expect(unpack).toContain('@ffprobe-installer')
  })

  it('unpacks sharp, which has native bindings with the same problem', () => {
    const unpack = (config.asarUnpack ?? []).join('\n')
    expect(unpack).toContain('sharp')
  })

  it('keeps both installers as runtime dependencies', () => {
    // In devDependencies they would not be packaged at all, and the unpack
    // rule above would have nothing to unpack.
    expect(Object.keys(pkg.dependencies)).toContain('@ffmpeg-installer/ffmpeg')
    expect(Object.keys(pkg.dependencies)).toContain('@ffprobe-installer/ffprobe')
  })
})

describe('the packaged app can find its resources', () => {
  const resourceFor = (name: string): { from: string; to: string; filter?: string[] } | undefined =>
    (config.extraResources ?? []).find((r) => r.to === name)

  it('puts the asset library where scanAssets looks for it', () => {
    // assetsRoot() -> join(process.resourcesPath, 'assets')
    expect(resourceFor('assets')?.from).toBe('assets')
  })

  it('puts the sidecar beside the app, not inside the asar', () => {
    // sidecarDir() -> join(process.resourcesPath, 'sidecar'). Python cannot
    // import from inside an archive any more than ffmpeg can execute from one.
    expect(resourceFor('sidecar')?.from).toBe('sidecar')
  })

  it('leaves the virtualenv out — it is half a gigabyte and platform-specific', () => {
    const filter = (resourceFor('sidecar')?.filter ?? []).join('\n')
    expect(filter).toContain('!.venv')
    expect(filter).toMatch(/!.*__pycache__/)
  })

  it('leaves out the filename Windows cannot extract', () => {
    /*
     * `sidecar/:memory:.ses` is still on disk here — a test was once handed
     * ':memory:' as a database path. A colon is illegal in a Windows filename,
     * so an installer carrying it would fail to extract on the one platform it
     * is aimed at. It is gitignored, which is NOT the same as unpackaged.
     */
    const filter = (resourceFor('sidecar')?.filter ?? []).join('\n')
    expect(filter).toMatch(/!.*:memory:/)
  })

  it('ships the requirements files, so the sidecar can be set up after install', () => {
    // They are not excluded by any filter, and docs/SIDECAR.md tells the user
    // to pip install from them.
    const filter = (resourceFor('sidecar')?.filter ?? []).join('\n')
    expect(filter).not.toMatch(/!.*requirements/)
  })
})

describe('what the installer is', () => {
  it('builds an NSIS installer for Windows, not a portable exe', () => {
    // The app writes to userData — downloads, stems, the fetched yt-dlp — and
    // an installed app is the shape that has a sensible place for those.
    expect(JSON.stringify(config.win?.target)).toContain('nsis')
  })

  it('does not install with one click', () => {
    // A first install on a machine nobody has tested is exactly when someone
    // wants to see where it is going and be able to undo it.
    expect(config.nsis?.oneClick).toBe(false)
  })

  it('publishes nothing as a side effect of building', () => {
    expect(config.publish).toBeNull()
  })

  it('names the app and its id', () => {
    expect(config.appId).toMatch(/^[a-z0-9.-]+$/)
    expect(config.productName).toBeTruthy()
  })

  it('points at the entry electron-vite actually writes', () => {
    expect(pkg.main).toBe('./out/main/index.js')
    expect((config.files ?? []).some((f) => f.startsWith('out'))).toBe(true)
  })

  it('has both pack scripts, because each platform must build itself', () => {
    /*
     * `@ffmpeg-installer` ships the binary as an OPTIONAL dependency per
     * platform, so `npm ci` on a Mac installs only darwin-arm64 — packing
     * Windows from macOS yields an installer with NO ffmpeg in it. CI runs
     * each script on its own runner.
     */
    expect(pkg.scripts['pack:win']).toContain('--win')
    expect(pkg.scripts['pack:mac']).toContain('--mac')
  })
})
