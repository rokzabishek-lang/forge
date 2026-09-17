import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import { buildRenderPlan } from '@shared/render/plan'
import { buildTimelineCaptions, escapeFilterPath } from '@shared/captions/timeline'
import { DEFAULT_CAPTION_STYLE } from '@shared/captions/style'
import { segmentIntoSentences, type Word } from '@shared/transcript'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const FFPROBE = ffprobeInstaller.path

let dir = ''
let source = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-caps-'))
  source = join(dir, 'src.mp4')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=#202830:size=1280x720:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source
  ])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function words(spec: [string, number, number][]): Word[] {
  return spec.map(([text, startMs, endMs], index) => ({ index, text, startMs, endMs, confidence: 0.9 }))
}

const SAMPLE = words([
  ['Forge', 0, 600], ['burns', 600, 1200], ['captions.', 1200, 1800],
  ['Word', 2000, 2500], ['by', 2500, 2800], ['word.', 2800, 3400]
])

function project(over: Partial<Clip> = {}): Project {
  const asset: MediaAsset = {
    id: 'a1', path: source, name: 'src.mp4', kind: 'video',
    durationFrames: 120, width: 1280, height: 720, fps: 30,
    hasVideo: true, hasAudio: true, size: 0
  }
  const clip: Clip = {
    id: 'c1', assetId: 'a1', trackId: 'v1', start: 0, duration: 120, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
  return {
    ...emptyProject(),
    assets: [asset],
    clips: [clip],
    transcripts: {
      a1: {
        assetId: 'a1',
        language: 'en',
        model: 'test',
        durationMs: 4000,
        words: SAMPLE,
        segments: segmentIntoSentences(SAMPLE)
      }
    }
  }
}

/** Mean luma — a proxy for "is anything drawn on this frame". */
async function meanLuma(file: string, atSeconds: number): Promise<number> {
  const frame = join(dir, `probe-${Math.random().toString(36).slice(2)}.png`)
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(atSeconds), '-i', file, '-frames:v', '1', frame
  ])
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-f', 'lavfi',
    `-i`, `movie=${frame.replace(/:/g, '\\:')},signalstats`,
    '-show_entries', 'frame_tags=lavfi.signalstats.YAVG',
    '-of', 'default=nw=1:nk=1'
  ])
  return Number(stdout.trim().split('\n')[0])
}

describe('caption burn-in', () => {
  it('escapes filter paths so colons and spaces survive', () => {
    expect(escapeFilterPath('/Users/me/my project/a.ass')).toBe('/Users/me/my project/a.ass')
    expect(escapeFilterPath('C:\\Users\\me\\a.ass')).toBe('C\\:/Users/me/a.ass')
    expect(escapeFilterPath("/tmp/it's.ass")).toBe("/tmp/it\\'s.ass")
  })

  it('maps source time to timeline time for a trimmed clip', () => {
    /*
     * This asserted 0:00:00.00 and described the setup, correctly, as "lands at
     * 1s of timeline" — a test that contradicted itself and passed, because the
     * builder walked a cursor of accumulated durations instead of reading
     * `clip.start`. The two are the same number only while every clip is packed
     * from zero; leave a gap and every caption after it drifts by its size.
     */
    const p = project({ inPoint: 60, start: 30, duration: 60 })
    const ass = buildTimelineCaptions(p, DEFAULT_CAPTION_STYLE, { width: 1080, height: 1920 })!

    expect(ass).toBeTruthy()
    // "Word" at 2000ms of source, read from 2000ms in, on a clip that sits at
    // frame 30 — one second in at 30fps.
    expect(ass).toContain('Dialogue: 0,0:00:01.00')
    // Words before the in-point must not appear at all.
    expect(ass).not.toContain('FORGE')
  })

  it('follows a clip that has been dragged later', () => {
    // The case the cursor could never get right: the same clip, moved.
    const near = buildTimelineCaptions(
      project({ inPoint: 60, start: 30, duration: 60 }),
      DEFAULT_CAPTION_STYLE,
      { width: 1080, height: 1920 }
    )!
    const far = buildTimelineCaptions(
      project({ inPoint: 60, start: 150, duration: 60 }),
      DEFAULT_CAPTION_STYLE,
      { width: 1080, height: 1920 }
    )!
    expect(near).toContain('Dialogue: 0,0:00:01.00')
    // 150 frames at 30fps = 5 seconds.
    expect(far).toContain('Dialogue: 0,0:00:05.00')
  })

  it('burns captions that visibly change the frame', async () => {
    const p = project()
    const canvas = { width: 720, height: 1280 }
    const ass = buildTimelineCaptions(p, DEFAULT_CAPTION_STYLE, canvas)!
    const assPath = join(dir, 'captions.ass')
    await writeFile(assPath, ass, 'utf8')
    expect((await stat(assPath)).size).toBeGreaterThan(200)

    const plain = join(dir, 'plain.mp4')
    const captioned = join(dir, 'captioned.mp4')

    await run(FFMPEG, buildRenderPlan({ project: p, outputPath: plain, canvas }).args, {
      maxBuffer: 16 * 1024 * 1024
    })
    await run(
      FFMPEG,
      buildRenderPlan({ project: p, outputPath: captioned, canvas, subtitlesPath: assPath }).args,
      { maxBuffer: 16 * 1024 * 1024 }
    )

    // The source is a flat colour, so any luma change is drawn text.
    const before = await meanLuma(plain, 0.8)
    const after = await meanLuma(captioned, 0.8)

    expect(Number.isFinite(before)).toBe(true)
    expect(Number.isFinite(after)).toBe(true)
    expect(after).toBeGreaterThan(before)
  }, 180_000)

  it('produces no subtitle filter when nothing is transcribed', () => {
    const bare = { ...project(), transcripts: {} }
    expect(buildTimelineCaptions(bare, DEFAULT_CAPTION_STYLE, { width: 1080, height: 1920 })).toBeNull()

    const args = buildRenderPlan({ project: bare, outputPath: '/o.mp4' }).args.join(' ')
    expect(args).not.toContain('subtitles=')
    expect(args).toContain('-map [vout]')
  })
})
