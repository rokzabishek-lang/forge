import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import type { KeyframeTracks } from '@shared/render/keyframes'

/*
 * Keyframes, rendered.
 *
 * Each property goes through a different filter and each one was verified
 * against the binary before being offered — rotate takes an expression of `t`,
 * geq exposes `T` on the alpha plane, zoompan counts `on`. These render real
 * frames and read them back, because an animation that compiles is not the same
 * as an animation that moves.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const W = 160
const H = 120
const FPS = 15
const FRAMES = 30

let dir = ''
let still = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-keys-'))
  still = join(dir, 'grid.png')
  // A pattern, not a flat colour: a zoom is only measurable if the picture has
  // detail that changes size.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1:duration=1', '-frames:v', '1', still])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function keyedProject(keyframes: KeyframeTracks, start = 0): Project {
  const asset: MediaAsset = {
    id: 'img', path: still, name: 'grid.png', kind: 'image', durationFrames: FRAMES,
    width: 320, height: 240, fps: FPS, hasVideo: true, hasAudio: false, size: 0
  }
  const clip: Clip = {
    id: 'c1', assetId: 'img', trackId: 'v1', start, duration: FRAMES, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'cover' },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    keyframes
  }
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: FPS, sampleRate: 48000 },
    assets: [asset],
    clips: [clip]
  }
}

async function render(keyframes: KeyframeTracks, start = 0): Promise<string> {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.mp4`)
  const plan = buildRenderPlan({ project: keyedProject(keyframes, start), outputPath: out })
  await run(FFMPEG, plan.args, { maxBuffer: 32 * 1024 * 1024 })
  return out
}

/** One frame as raw grey bytes. */
async function frameAt(file: string, seconds: number): Promise<Buffer> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file,
     '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }
  )
  return stdout as unknown as Buffer
}

/** Mean absolute difference, 0 = identical. */
function difference(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let total = 0
  for (let i = 0; i < n; i++) total += Math.abs(a[i] - b[i])
  return total / n
}

function mean(buffer: Buffer): number {
  let total = 0
  for (const v of buffer) total += v
  return total / buffer.length
}

describe('keyframes', () => {
  it('emits nothing extra for a clip with no keys', () => {
    const plan = buildRenderPlan({ project: keyedProject({}), outputPath: '/tmp/x.mp4' })
    const graph = plan.args.join(' ')
    // geq is expensive; it must never appear for a clip that does not animate.
    expect(graph).not.toContain('geq=')
  })

  it('ignores a single key, which is a value and not an animation', () => {
    const plan = buildRenderPlan({
      project: keyedProject({ opacity: [{ frame: 0, value: 0.5 }] }),
      outputPath: '/tmp/x.mp4'
    })
    expect(plan.args.join(' ')).not.toContain('geq=')
  })

  it('fades opacity over the clip', async () => {
    const out = await render({ opacity: [{ frame: 0, value: 0 }, { frame: FRAMES, value: 1 }] })
    const start = mean(await frameAt(out, 0.1))
    const end = mean(await frameAt(out, 1.8))
    // Against a black base, rising alpha is a brightening frame.
    expect(end).toBeGreaterThan(start + 10)
  }, 120_000)

  it('holds opacity flat until the next key when told to', async () => {
    const out = await render({
      opacity: [
        { frame: 0, value: 0, ease: 'hold' },
        { frame: FRAMES - 1, value: 1 }
      ]
    })
    // Nothing should appear until the very end.
    expect(mean(await frameAt(out, 0.1))).toBeLessThan(4)
    expect(mean(await frameAt(out, 1.0))).toBeLessThan(4)
  }, 120_000)

  it('turns the picture over the clip', async () => {
    const out = await render({ rotation: [{ frame: 0, value: 0 }, { frame: FRAMES, value: 45 }] })
    const start = await frameAt(out, 0.1)
    const end = await frameAt(out, 1.8)
    expect(difference(start, end)).toBeGreaterThan(8)
  }, 120_000)

  it('zooms into the picture over the clip', async () => {
    const out = await render({ zoom: [{ frame: 0, value: 1 }, { frame: FRAMES, value: 2 }] })
    const start = await frameAt(out, 0.1)
    const end = await frameAt(out, 1.8)
    expect(difference(start, end)).toBeGreaterThan(8)
  }, 120_000)

  /*
   * The one that would have shipped silently.
   *
   * rotate, geq and zoompan all run BEFORE setpts, so they see source
   * timestamps starting at zero rather than timeline time. Writing the curve
   * against the clip's timeline position worked perfectly for the first clip and
   * froze every clip after it — which nothing but a clip that starts late would
   * ever catch.
   */
  it('animates a clip that does not start at zero', async () => {
    const start = FPS // one second in
    const out = await render(
      { opacity: [{ frame: 0, value: 0 }, { frame: FRAMES, value: 1 }] },
      start
    )
    const early = mean(await frameAt(out, 1.1))
    const late = mean(await frameAt(out, 2.8))
    expect(late).toBeGreaterThan(early + 10)
  }, 120_000)

  it('animates two properties on one clip without either being dropped', async () => {
    // They go through different filters, so it is genuinely possible for one to
    // silently win.
    const out = await render({
      opacity: [{ frame: 0, value: 0.2 }, { frame: FRAMES, value: 1 }],
      rotation: [{ frame: 0, value: 0 }, { frame: FRAMES, value: 30 }]
    })
    const start = await frameAt(out, 0.1)
    const end = await frameAt(out, 1.8)
    expect(mean(end)).toBeGreaterThan(mean(start))
    expect(difference(start, end)).toBeGreaterThan(8)
  }, 120_000)
})
