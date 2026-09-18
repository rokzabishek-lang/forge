import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatFor } from '@shared/ingest/format'

/**
 * What the REAL yt-dlp picks, given our selector.
 *
 * Asserting the selector string only proves it is the string we wrote. The two
 * bugs this file exists for were both cases where the string looked entirely
 * reasonable and chose the wrong format — or no format at all:
 *
 *   1. A 4K request satisfied by a 1080p stream, because `/` is fallback-only.
 *   2. EVERY VERTICAL VIDEO refused, because `height<=1080` is false for a
 *      1080p reel, which is 1080 wide and 1920 tall.
 *
 * Neither is visible in the string. Both are obvious the moment yt-dlp is asked
 * to choose. `--load-info-json` runs its real format selection against a format
 * table we write, so this needs no network and no actual video.
 */

const run = promisify(execFile)
const YTDLP = process.env.FORGE_YTDLP ?? 'yt-dlp'

let dir = ''
let available = false

/** One format table, in yt-dlp's own shape. */
async function infoFile(
  name: string,
  formats: {
    format_id: string
    width: number | null
    height: number | null
    vcodec: string
    acodec: string
    ext?: string
  }[]
): Promise<string> {
  const path = join(dir, `${name}.json`)
  await writeFile(
    path,
    JSON.stringify({
      id: name,
      title: name,
      extractor: 'test',
      extractor_key: 'Test',
      webpage_url: `https://example.invalid/${name}`,
      _type: 'video',
      formats: formats.map((f) => ({
        ext: 'mp4',
        protocol: 'https',
        url: `https://example.invalid/${f.format_id}`,
        ...f
      }))
    })
  )
  return path
}

/** Which format id yt-dlp actually settles on, or the error it gives. */
async function chosen(info: string, quality: Parameters<typeof formatFor>[1]): Promise<string> {
  const format = formatFor('video', quality)
  const args = ['--load-info-json', info, '-f', format.selector]
  if (format.sort) args.push('-S', format.sort)
  args.push('--simulate', '--print', '%(format_id)s %(width)sx%(height)s')
  try {
    const { stdout } = await run(YTDLP, args)
    return stdout.trim().split('\n').pop() ?? ''
  } catch (err) {
    return `ERROR ${(err as { stderr?: string }).stderr?.trim().split('\n').pop() ?? err}`
  }
}

const AUDIO = { format_id: 'aac', width: null, height: null, vcodec: 'none', acodec: 'mp4a.40.2' }

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-ytdlp-'))
  try {
    await run(YTDLP, ['--version'])
    available = true
  } catch {
    available = false
  }
}, 60_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

/*
 * Skipped rather than failed where yt-dlp is not installed.
 *
 * It is fetched at runtime on a real machine and is not a build dependency, so
 * a developer without it should not see a red suite. CI has it via pip.
 */
const withYtDlp = (name: string, body: () => Promise<void>): void => {
  it(name, async () => {
    if (!available) return
    await body()
  }, 60_000)
}

describe('what yt-dlp actually chooses', () => {
  withYtDlp('gets a vertical video at the rung that was asked for', async () => {
    /*
     * The bug that made this file. `res` in a yt-dlp sort is the LOWER of
     * height and width, which is what "1080p" means for a reel. A height
     * filter is not: a 1080p reel is 1920 tall and fails it.
     */
    const vertical = await infoFile('vertical', [
      { format_id: 'v360', width: 360, height: 640, vcodec: 'avc1.4d401e', acodec: 'none' },
      { format_id: 'v720', width: 720, height: 1280, vcodec: 'avc1.4d401f', acodec: 'none' },
      { format_id: 'v1080', width: 1080, height: 1920, vcodec: 'avc1.640028', acodec: 'none' },
      AUDIO
    ])
    expect(await chosen(vertical, '1080p')).toBe('v1080+aac 1080x1920')
    expect(await chosen(vertical, '720p')).toBe('v720+aac 720x1280')
    expect(await chosen(vertical, '480p')).toBe('v360+aac 360x640')
  })

  withYtDlp('downloads a single pre-muxed stream, which is what most sites serve', async () => {
    // An Instagram reel: one already-merged file, vertical. Under the old
    // selector this was "Requested format is not available".
    const reel = await infoFile('reel', [
      { format_id: 'muxed', width: 720, height: 1280, vcodec: 'avc1.4d401f', acodec: 'mp4a.40.2' }
    ])
    expect(await chosen(reel, '1080p')).toBe('muxed 720x1280')
  })

  withYtDlp('still returns 4K for a 4K request, rather than the 1080p beneath it', async () => {
    /*
     * The FIRST bug. `/` is fallback-only, so an H.264-first chain was
     * satisfied by the 1080p avc1 stream and never looked at the 2160p vp9 one.
     * A sort cannot fall into that, and this is what proves the new shape did
     * not reintroduce it.
     */
    const ladder = await infoFile('ladder', [
      { format_id: 'h1080', width: 1920, height: 1080, vcodec: 'avc1.640028', acodec: 'none' },
      { format_id: 'v2160', width: 3840, height: 2160, vcodec: 'vp09.00.50.08', acodec: 'none' },
      AUDIO
    ])
    expect(await chosen(ladder, '2160p')).toBe('v2160+aac 3840x2160')
    expect(await chosen(ladder, '1080p')).toBe('h1080+aac 1920x1080')
  })

  withYtDlp('prefers H.264 over VP9 at the same size, without demanding it', async () => {
    // A preference, not a filter: ranked first where it exists, and a site
    // with nothing but VP9 still downloads.
    const both = await infoFile('both', [
      { format_id: 'vp9', width: 1920, height: 1080, vcodec: 'vp09.00.50.08', acodec: 'none' },
      { format_id: 'avc', width: 1920, height: 1080, vcodec: 'avc1.640028', acodec: 'none' },
      AUDIO
    ])
    expect(await chosen(both, '1080p')).toBe('avc+aac 1920x1080')

    const vp9Only = await infoFile('vp9only', [
      { format_id: 'vp9', width: 1920, height: 1080, vcodec: 'vp09.00.50.08', acodec: 'none' },
      AUDIO
    ])
    expect(await chosen(vp9Only, '1080p')).toBe('vp9+aac 1920x1080')
  })

  withYtDlp('refuses an AV1-only video rather than importing something unplayable', async () => {
    /*
     * The one case that should still fail. The Windows ffmpeg is a 2018
     * snapshot with no AV1 decoder, so an AV1 download would succeed and then
     * be unplayable and unexportable — a worse failure, and a much later one.
     */
    const av1 = await infoFile('av1', [
      { format_id: 'av01', width: 1920, height: 1080, vcodec: 'av01.0.12M.08', acodec: 'none' },
      AUDIO
    ])
    expect(await chosen(av1, '1080p')).toMatch(/ERROR/)
  })
})
