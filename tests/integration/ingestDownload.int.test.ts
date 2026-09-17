import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { downloadMedia, findCached, removePartials, type IngestTool } from '../../src/main/ingest/download'
import type { IngestRequest } from '@shared/ingest/args'

/*
 * The download path, end to end, against a fake yt-dlp.
 *
 * The real binary needs a network and cannot be fetched in CI. Everything
 * AROUND it can be exercised: the argv, the progress parse, the marked lines,
 * the kill on cancel, and the rule that a cancelled job leaves nothing behind.
 * `tests/fixtures/fake-yt-dlp.mjs` speaks yt-dlp's lines, driven by the very
 * arguments we build — so if the template or the prints change shape, this
 * fails here rather than in someone's first download.
 *
 * Runs through `process.execPath` so the fake is a real executable on Windows
 * too, which is where the kill and the cleanup have the most to prove.
 */

const FAKE = resolve(__dirname, '../fixtures/fake-yt-dlp.mjs')
const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

let dir = ''

function tool(env: Record<string, string> = {}): IngestTool {
  // The fake reads its knobs from the environment; hand them over per call by
  // wrapping node so different tests can behave differently.
  const assignments = Object.entries(env).map(([k, v]) => `process.env.${k}=${JSON.stringify(v)};`)
  return {
    command: process.execPath,
    prefixArgs: [
      '--input-type=module',
      '-e',
      `${assignments.join('')}await import(${JSON.stringify(FAKE)});`,
      '--'
    ]
  }
}

const request = (over: Partial<IngestRequest> = {}): IngestRequest => ({
  url: URL,
  kind: 'video',
  quality: '1080p',
  ...over
})

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-ingest-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

describe('a download through the fake yt-dlp', () => {
  it('finishes with the printed path, the title, and a full progress bar', async () => {
    const seen: number[] = []
    const speeds: (string | null)[] = []
    const dest = join(dir, 'ok')
    const handle = downloadMedia(request(), tool(), (p, s) => {
      seen.push(p)
      speeds.push(s)
    }, { destDir: dest })

    const outcome = await handle.promise

    expect(outcome.cached).toBe(false)
    expect(outcome.path).toBe(join(dest, 'dQw4w9WgXcQ.video-1080p.mp4'))
    // The title carries every character Windows forbids and none of them
    // reached the filename — the split the whole design rests on.
    expect(outcome.title).toBe('Fake | Title: "quoted"? *starred*')
    expect(outcome.path).not.toMatch(/[<>:"|?*]/)

    expect(seen.at(-1)).toBe(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    expect(speeds.some((s) => s === '2 KB/s')).toBe(true)

    // Nothing but the finished file is left.
    expect((await readdir(dest)).sort()).toEqual(['dQw4w9WgXcQ.video-1080p.mp4'])
  }, 60_000)

  it('reuses a finished file instead of spawning anything', async () => {
    const dest = join(dir, 'cached')
    await rm(dest, { recursive: true, force: true })
    await writeFile(join(dest, 'x').replace(/x$/, ''), '').catch(() => undefined)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, 'dQw4w9WgXcQ.video-720p.webm'), 'already here')

    let progressCalls = 0
    const handle = downloadMedia(
      request({ quality: '720p' }),
      // A command that cannot exist: if it were spawned, this test would fail.
      { command: join(dir, 'does-not-exist') },
      () => progressCalls++,
      { destDir: dest }
    )
    const outcome = await handle.promise
    expect(outcome.cached).toBe(true)
    expect(outcome.path).toBe(join(dest, 'dQw4w9WgXcQ.video-720p.webm'))
    expect(progressCalls).toBe(1)
  }, 30_000)

  it('does not mistake a partial or a fragment for a finished file', async () => {
    const dest = join(dir, 'partials')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, 'abc.video-1080p.f137.mp4'), 'fragment')
    await writeFile(join(dest, 'abc.video-1080p.mp4.part'), 'half')
    await writeFile(join(dest, 'abc.video-1080p.f140.m4a.ytdl'), 'sidecar')
    expect(await findCached(dest, 'abc.video-1080p')).toBeNull()

    await writeFile(join(dest, 'abc.video-1080p.mp4'), 'whole')
    expect(await findCached(dest, 'abc.video-1080p')).toBe(join(dest, 'abc.video-1080p.mp4'))
  })

  it('cancels by killing the process and leaves nothing behind', async () => {
    const dest = join(dir, 'cancel')
    let cancelledAt = -1
    let handle: ReturnType<typeof downloadMedia> | null = null
    handle = downloadMedia(
      request(),
      tool({ FAKE_STEPS: '40', FAKE_DELAY_MS: '100' }),
      (p) => {
        if (cancelledAt === -1 && p > 0) {
          cancelledAt = p
          handle?.cancel()
        }
      },
      { destDir: dest }
    )

    await expect(handle.promise).rejects.toMatchObject({ name: 'CancelledError' })
    expect(cancelledAt).toBeGreaterThan(0)
    expect(cancelledAt).toBeLessThan(0.5)

    // The rule from run.ts: "this job ended" means "there is nothing broken
    // left behind". The .part must already be gone when the promise settles.
    expect(await readdir(dest)).toEqual([])
  }, 60_000)

  it('reports yt-dlp’s own reason on failure, and cleans up', async () => {
    const dest = join(dir, 'fail')
    const handle = downloadMedia(request(), tool({ FAKE_FAIL: '1' }), () => undefined, { destDir: dest })
    await expect(handle.promise).rejects.toThrow(/Video unavailable\. This video is private/)
    expect(await readdir(dest)).toEqual([])
  }, 60_000)

  it('finds the file itself when yt-dlp does not print where it went', async () => {
    const dest = join(dir, 'noprint')
    const handle = downloadMedia(
      request({ quality: '480p' }),
      tool({ FAKE_NO_PRINT: '1', FAKE_EXT: 'mkv' }),
      () => undefined,
      { destDir: dest }
    )
    const outcome = await handle.promise
    expect(outcome.path).toBe(join(dest, 'dQw4w9WgXcQ.video-480p.mkv'))
  }, 60_000)

  it('removes only its own leftovers, never a sibling download', async () => {
    const dest = join(dir, 'siblings')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dest, { recursive: true })
    const mine = ['abc.video-1080p.mp4.part', 'abc.video-1080p.f137.mp4', 'abc.video-1080p.f140.m4a.ytdl', 'abc.video-1080p.temp.mp4']
    const theirs = ['abc.video-1080p.r60000-90000.mp4', 'abc.video-720p.mp4', 'abc.audio-m4a.m4a']
    for (const name of [...mine, ...theirs]) await writeFile(join(dest, name), 'x')

    await removePartials(dest, 'abc.video-1080p')

    expect((await readdir(dest)).sort()).toEqual([...theirs].sort())
  })
})
