import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The whole install path, end to end, with no network and no electron.
 *
 * Every piece of this was unit-tested and the PATH THROUGH THEM had never once
 * been run: build an archive, serve it, fetch it, verify it, unpack it, and
 * find what it contained in the catalog. The bug that hid in exactly that gap —
 * `installPack` writing to `<root>/<id>/fonts` while `scanAssets` only ever
 * looked at `<root>/fonts` — passed every test in the suite, because no test
 * crossed the seam.
 *
 * It builds with `scripts/build-pack.mjs` rather than a tar written here, so
 * what the builder produces and what the installer accepts are checked against
 * each other rather than both against a third idea of tar.
 *
 * `fetch` is stubbed rather than a local server started. The archive still
 * arrives as a streamed body with a content-length, so the reader loop and the
 * progress arithmetic are the real ones — but nothing binds a port, which a
 * sandbox or a Windows runner's firewall can refuse, and "does node:http
 * listen" was never the question.
 */

const run = promisify(execFile)

const URL_OK = 'https://packs.test/library.tar.gz'
const URL_MISSING = 'https://packs.test/gone.tar.gz'

let userData = ''
let source = ''
let archive = ''
let sha256 = ''
let bytes = 0

/** Imported after FORGE_TEST_USERDATA is set, since the stub reads it live. */
let packs: typeof import('../../src/main/assets/packs')
let scan: typeof import('../../src/main/assets/scan')

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'forge-userdata-'))
  process.env.FORGE_TEST_USERDATA = userData
  packs = await import('../../src/main/assets/packs')
  scan = await import('../../src/main/assets/scan')

  source = await mkdtemp(join(tmpdir(), 'forge-packsrc-'))
  await mkdir(join(source, 'fonts'), { recursive: true })
  await mkdir(join(source, 'transitions', 'extra'), { recursive: true })
  await writeFile(join(source, 'fonts', 'BebasNeue-Regular.ttf'), 'FONTBYTES')
  await writeFile(join(source, 'transitions', 'extra', 'wipe 01.jpg'), 'MASKBYTES')

  archive = join(source, '..', `${crypto.randomUUID()}.tar.gz`)
  await run(process.execPath, ['scripts/build-pack.mjs', source, archive], {
    cwd: join(import.meta.dirname, '..', '..')
  })

  const built = await readFile(archive)
  sha256 = createHash('sha256').update(built).digest('hex')
  bytes = built.length

  vi.stubGlobal('fetch', async (input: string) => {
    if (String(input) !== URL_OK) return new Response(null, { status: 404 })
    // In several chunks, so the streaming reader is actually streaming and the
    // progress callback fires more than once.
    const size = Math.ceil(built.length / 4)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < built.length; at += size) {
          controller.enqueue(new Uint8Array(built.subarray(at, at + size)))
        }
        controller.close()
      }
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/gzip', 'content-length': String(built.length) }
    })
  })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  delete process.env.FORGE_TEST_USERDATA
  for (const dir of [userData, source]) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
  await rm(archive, { force: true }).catch(() => undefined)
})

const pack = () => ({
  id: 'library',
  name: 'Asset library',
  summary: 'fonts and transitions',
  group: 'library' as const,
  version: 1,
  url: URL_OK,
  sha256,
  bytes
})

describe('installing a pack the builder made', () => {
  it('fetches, verifies, unpacks, and leaves a receipt', async () => {
    const progress: (number | null)[] = []
    const listing = await packs.installPack(pack(), {
      onProgress: (value) => progress.push(value)
    })

    expect(listing.state).toEqual({ kind: 'installed', version: 1 })
    expect(await packs.installedVersion('library')).toBe(1)

    const root = packs.packRoot()
    expect(await readFile(join(root, 'library', 'fonts', 'BebasNeue-Regular.ttf'), 'utf8')).toBe(
      'FONTBYTES'
    )
    // The space in the name is legal and must survive; it is the trailing one
    // Windows forbids.
    expect(
      await readFile(join(root, 'library', 'transitions', 'extra', 'wipe 01.jpg'), 'utf8')
    ).toBe('MASKBYTES')

    // Something moved, and it ended at 1 rather than stopping short.
    expect(progress.length).toBeGreaterThan(1)
    expect(progress.at(-1)).toBe(1)
  })

  it('shows up in the catalog, which is the only reason any of it matters', async () => {
    /*
     * The seam the original bug lived in. A pack can download, verify, unpack
     * and write a receipt perfectly, and if the scanner does not look one
     * directory down the user sees "Nothing here." and a working app looks
     * broken.
     */
    const catalog = await scan.scanAssets(packs.packRoot())
    expect(catalog.entries.map((e) => e.file).sort()).toEqual([
      'library/fonts/BebasNeue-Regular.ttf',
      'library/transitions/extra/wipe 01.jpg'
    ])
  })

  it('points the assets root at the pack once something is installed', async () => {
    delete process.env.FORGE_ASSETS_DIR
    expect(await packs.refreshPacksInstalled()).toBe(true)
    expect(scan.assetsRoot()).toBe(packs.packRoot())
  })

  it('leaves nothing behind but the pack and its receipts', async () => {
    /*
     * Asserting the whole directory, not that one known staging path is absent
     * — which would have passed just as well if staging were renamed and then
     * leaked. Unpacking goes into a staging folder and is swapped in at the
     * end, and anything left over beside the pack is a half-install that the
     * catalog would scan as a second copy.
     */
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(packs.packRoot())).sort()).toEqual(['.packs', 'library'])
  })
})

describe('when the archive is not what was published', () => {
  it('refuses on the checksum and installs nothing', async () => {
    const before = await readFile(
      join(packs.packRoot(), 'library', 'fonts', 'BebasNeue-Regular.ttf'),
      'utf8'
    )

    await expect(
      packs.installPack({ ...pack(), sha256: 'b'.repeat(64), version: 2 })
    ).rejects.toThrow(/checksum/i)

    /*
     * The order is the whole design: verified before a single file is written.
     * A pack that arrives altered must leave the working library alone, which
     * is the difference between "try again" and "reinstall the app".
     */
    expect(
      await readFile(join(packs.packRoot(), 'library', 'fonts', 'BebasNeue-Regular.ttf'), 'utf8')
    ).toBe(before)
    expect(await packs.installedVersion('library')).toBe(1)
  })

  it('reports a missing file as a failure rather than writing an empty pack', async () => {
    await expect(packs.installPack({ ...pack(), url: URL_MISSING })).rejects.toThrow(
      /404/
    )
  })
})

describe('removing a pack', () => {
  it('takes the files and the receipt, and the catalog goes quiet', async () => {
    await packs.removePack('library')
    expect(await packs.installedVersion('library')).toBeNull()
    expect((await scan.scanAssets(packs.packRoot())).entries).toEqual([])
    // Nothing installed: the root falls back to what shipped with the build.
    expect(await packs.refreshPacksInstalled()).toBe(false)
  })
})
