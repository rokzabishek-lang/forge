import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { escapeFilterPath } from '@shared/captions/timeline'

/*
 * Paths inside a filtergraph, tested against the real parser.
 *
 * This exists because of a bug that could not happen on the machine it was
 * written on. A path in a filter argument goes through two parsers, and a
 * colon escaped with ONE backslash — the form every example shows — silently
 * loses everything before it. On macOS nothing precedes the first colon, so
 * nothing was lost. On Windows that is the drive letter, and every export
 * touching a subtitle file, a LUT or a look died with "No such file".
 *
 * macOS allows a colon in a filename, so the drive-letter case IS reproducible
 * here — which is the whole point of this file. It fails on a Mac if the
 * escaping regresses, rather than waiting for CI to reach Windows.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path

/*
 * Windows will not create a file whose name contains any of  < > : " | ? *  —
 * the same rule that made `sidecar/:memory:.ses` impossible to check out, which
 * is how this project met it in the first place. So the colon cases below
 * cannot be BUILT on a Windows runner, and attempting to throws EINVAL out of
 * mkdir before ffmpeg is ever reached.
 *
 * Skipping them there costs no coverage, and that is the joke of it: on Windows
 * every path in this file is `C:\Users\RUNNER~1\...`, so every remaining case is
 * already a drive-letter case. The colon is untestable on the one platform that
 * cannot avoid it. `drivePrefixed` below asserts exactly that, so the skip can
 * never quietly become "this file tests nothing on Windows".
 */
const onWindows = platform === 'win32'

/** A 2x2x2 identity LUT: the smallest thing lut3d will actually load. */
const CUBE = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'forge-filterpath-'))
}, 60_000)

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

/** A LUT inside a directory whose name contains `awkward`. */
async function lutIn(awkward: string): Promise<string> {
  const dir = join(root, `x${awkward}y`)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'l.cube')
  await writeFile(file, CUBE, 'utf8')
  return file
}

/** Does ffmpeg actually open it? Resolves on success, rejects with stderr. */
async function loads(file: string): Promise<void> {
  await run(FFMPEG, [
    '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=gray:s=32x32:d=1',
    '-vf', `lut3d=${escapeFilterPath(file)}`,
    '-frames:v', '1', '-f', 'null', '-'
  ])
}

describe('a path inside a filtergraph', () => {
  it.skipIf(onWindows)('survives a colon — the Windows drive letter, in every export', async () => {
    /*
     * THE case. A Windows path is `C:\Users\…`, which this normalises to
     * `C:/Users/…`; if the colon is under-escaped the `C` is eaten and ffmpeg
     * looks for `/Users/…`, which exists on macOS and never on Windows.
     */
    await expect(loads(await lutIn(':'))).resolves.toBeUndefined()
  }, 60_000)

  it.runIf(onWindows)('gets its colon from the drive letter instead', async () => {
    /*
     * The other half of the skip above, and the reason it is safe. Every path
     * here begins `C:` on Windows, so the case that cannot be constructed is
     * the case that cannot be escaped either. This asserts that rather than
     * assuming it — if a runner ever hands us a UNC path (`\\server\share`)
     * there is no drive letter, this fails loudly, and the colon goes back to
     * being tested only on the Mac.
     */
    const file = await lutIn('-drive-')
    expect(file).toMatch(/^[A-Za-z]:/)
    await expect(loads(file)).resolves.toBeUndefined()
  }, 60_000)

  it('survives the separators the graph itself uses', async () => {
    for (const ch of [',', '[', ']', ';']) {
      await expect(loads(await lutIn(ch))).resolves.toBeUndefined()
    }
  }, 120_000)

  it('survives an equals sign', async () => {
    await expect(loads(await lutIn('='))).resolves.toBeUndefined()
  }, 60_000)

  it('survives an apostrophe — O’Brien has a home directory too', async () => {
    await expect(loads(await lutIn("'"))).resolves.toBeUndefined()
  }, 60_000)

  it('survives a space, which is the common case and always worked', async () => {
    await expect(loads(await lutIn(' '))).resolves.toBeUndefined()
  }, 60_000)

  it('survives all of them at once', async () => {
    // The colon drops out on Windows because the directory cannot hold one —
    // and is supplied by the drive letter on the front of the very same path.
    await expect(loads(await lutIn(onWindows ? ",;[]='" : ",;[]:='"))).resolves.toBeUndefined()
  }, 60_000)

  it('escapes each character to the depth the parser needs', () => {
    /*
     * The counts, pinned. They are not uniform and they are not guessable —
     * each was found by rendering a real file at such a path and seeing which
     * form loaded. A future tidy-up that "simplifies" them to one backslash
     * each puts the Windows bug straight back.
     */
    expect(escapeFilterPath('C:/a.ass')).toBe('C\\\\:/a.ass')
    expect(escapeFilterPath('/a=b/c.ass')).toBe('/a\\\\=b/c.ass')
    expect(escapeFilterPath("/a'b/c.ass")).toBe("/a\\\\\\'b/c.ass")
    expect(escapeFilterPath('/a,b/c.ass')).toBe('/a\\,b/c.ass')
    expect(escapeFilterPath('/a[b]/c.ass')).toBe('/a\\[b\\]/c.ass')
    // Backslashes become forward slashes first: ffmpeg takes them on Windows.
    expect(escapeFilterPath('C:\\Users\\x\\c.ass')).toBe('C\\\\:/Users/x/c.ass')
  })
})
