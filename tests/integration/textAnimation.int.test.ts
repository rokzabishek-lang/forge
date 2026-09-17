import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * Animated text, end to end.
 *
 * The editor bakes only the frames that MOVE — about a third of a second of a
 * three-second caption — and the render is expected to read them as a sequence
 * and then hold the last one for the rest of the clip. Two things can go wrong
 * silently and neither shows up in the filter string: the first frame can be
 * skipped (image2 numbers from 1 by default, and these are numbered from 0), and
 * the movement can REPEAT instead of settling, which looks like a stutter rather
 * than an error.
 *
 * So this renders real pixels and looks at them. The sequence is four flat
 * frames, each a step brighter than the last, which turns "which frame am I
 * looking at" into a question about one number.
 */

/** Grey levels for frames 0..3, measured back out of the render as 47/109/173/253. */
const LEVELS = ['0x303030', '0x707070', '0xb0b0b0', '0xffffff']

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const W = 160
const H = 120
const FPS = 10
/** Four frames of movement — 0.4s — inside a three-second clip. */
const MOVING = 4
const DURATION = 30

let dir = ''
let pattern = ''
let still = ''

/**
 * Mean luminance of the middle of a frame at a moment.
 *
 * `-ss` before `-i` hands back the first frame at or AFTER the timestamp, not
 * the one on screen at it — so every moment sampled here is exactly on a frame
 * boundary, and 0.25 would be the frame at 0.3 rather than the one at 0.2.
 */
async function brightness(file: string, at: number): Promise<number> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', file,
     '-frames:v', '1', '-vf', 'crop=40:40:60:40',
     '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }
  )
  const buffer = stdout as unknown as Buffer
  let total = 0
  for (const v of buffer) total += v
  return total / buffer.length
}

async function seconds(file: string): Promise<number> {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', file, '-f', 'null', '-'], {
    encoding: 'utf8'
  }).catch((err: { stderr?: string }) => ({ stderr: err.stderr ?? '' }))
  const match = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(stderr))
  if (!match) throw new Error(`no duration in: ${String(stderr).slice(-400)}`)
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-textanim-'))
  const seq = join(dir, 'caption.seq')
  await mkdir(seq, { recursive: true })
  pattern = join(seq, '%05d.png')
  still = join(dir, 'caption.png')

  // A step per frame, so every frame is individually identifiable. Four frames
  // that merely differed from the last would not catch the first one going
  // missing, which is the failure this exists to catch.
  for (let frame = 0; frame < MOVING; frame++) {
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${LEVELS[frame]}:size=${W}x${H}:rate=1:duration=1`,
      '-frames:v', '1', join(seq, `${String(frame).padStart(5, '0')}.png`)])
  }
  // The settled still, which is what `path` points at.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=white:size=${W}x${H}:rate=1:duration=1`,
    '-frames:v', '1', still])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function animatedProject(over: Partial<MediaAsset> = {}): Project {
  const asset: MediaAsset = {
    id: 'caption',
    path: still,
    name: 'caption',
    kind: 'image',
    durationFrames: DURATION,
    width: W,
    height: H,
    fps: FPS,
    hasVideo: true,
    hasAudio: false,
    size: 0,
    frames: { pattern, count: MOVING },
    ...over
  }
  const clip: Clip = {
    id: 'c-caption',
    assetId: 'caption',
    trackId: 'v1',
    start: 0,
    duration: DURATION,
    inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'cover' },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: FPS, sampleRate: 48000 },
    assets: [asset],
    clips: [clip]
  }
}

describe('a baked animation', () => {
  let out = ''

  beforeAll(async () => {
    out = join(dir, 'animated.mp4')
    const plan = buildRenderPlan({ project: animatedProject(), outputPath: out })
    await run(FFMPEG, plan.args, { maxBuffer: 32 * 1024 * 1024 })
  }, 180_000)

  it('starts at the first baked frame, not the second', async () => {
    // Numbered from zero, and image2 looks for 1 unless told otherwise. If the
    // first frame were skipped this would be the second step, 109.
    expect(await brightness(out, 0)).toBeLessThan(80)
  })

  it('plays the frames in order, one per frame of the timeline', async () => {
    const steps = [
      await brightness(out, 0.0),
      await brightness(out, 0.1),
      await brightness(out, 0.2),
      await brightness(out, 0.3)
    ]
    // Strictly increasing: no frame dropped, repeated or reordered.
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i], `frame ${i} after ${steps[i - 1]}`).toBeGreaterThan(steps[i - 1] + 30)
    }
  })

  it('settles on the last frame and stays there', async () => {
    // Past the movement, every moment must look the same. A sequence that
    // LOOPED instead of holding would be dark again here, which reads on screen
    // as a stutter rather than as a bug.
    for (const at of [0.4, 1.5, 2.9]) {
      expect(await brightness(out, at), `at ${at}s`).toBeGreaterThan(200)
    }
  })

  it('runs for the clip, not for the movement', async () => {
    // Without the hold the whole caption would be 0.4s long.
    expect(await seconds(out)).toBeCloseTo(DURATION / FPS, 1)
  })

  it('falls back to the still when nothing was baked', async () => {
    // A clip whose animation was turned off: the asset keeps its PNG, and the
    // render must go back to looping it rather than looking for a folder that
    // has been deleted.
    const plain = animatedProject({ frames: undefined })
    const file = join(dir, 'plain.mp4')
    await run(FFMPEG, buildRenderPlan({ project: plain, outputPath: file }).args, {
      maxBuffer: 32 * 1024 * 1024
    })
    expect(await brightness(file, 0.05)).toBeGreaterThan(200)
    expect(await seconds(file)).toBeCloseTo(DURATION / FPS, 1)
  }, 120_000)
})
