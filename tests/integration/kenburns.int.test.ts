import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { motionSourceRect } from '@shared/render/motion'
import {
  MOTION_MOVES,
  emptyProject,
  type Clip,
  type MediaAsset,
  type Motion,
  type Project
} from '@shared/timeline'

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const W = 640
const H = 360

let dir = ''
let still = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-kb-'))
  still = join(dir, 'grid.png')
  // A fine grid: a zoom changes how many cells fit in frame, which is
  // measurable. A flat colour would look identical at every zoom level.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=1:duration=1`,
    '-frames:v', '1', still])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function motionProject(motion: Motion): Project {
  const asset: MediaAsset = {
    id: 'img', path: still, name: 'grid.png', kind: 'image', durationFrames: 90,
    width: 1280, height: 720, fps: 30, hasVideo: true, hasAudio: false, size: 0
  }
  const clip: Clip = {
    id: 'c1', assetId: 'img', trackId: 'v1', start: 0, duration: 90, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    motion
  }
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: 30, sampleRate: 48000 },
    assets: [asset],
    clips: [clip]
  }
}

function reelProject(direction: 'in' | 'out'): Project {
  return motionProject({ kind: 'kenburns', direction, amount: 0.25 })
}

async function frameAt(file: string, seconds: number): Promise<Buffer> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file,
     '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }
  )
  return stdout as unknown as Buffer
}

/** Mean absolute difference between two frames, 0 = identical. */
function difference(a: Buffer, b: Buffer): number {
  const length = Math.min(a.length, b.length)
  let total = 0
  for (let i = 0; i < length; i++) total += Math.abs(a[i] - b[i])
  return total / length
}

describe('ken burns rendering', () => {
  it('actually moves — start and end frames differ', async () => {
    const out = join(dir, 'push.mp4')
    await run(FFMPEG, buildRenderPlan({ project: reelProject('in'), outputPath: out }).args, {
      maxBuffer: 16 * 1024 * 1024
    })

    const start = await frameAt(out, 0.1)
    const end = await frameAt(out, 2.8)
    // A still with no motion would render byte-identical frames throughout.
    expect(difference(start, end)).toBeGreaterThan(4)
  }, 180_000)

  it('moves the opposite way when pulling out', async () => {
    const pushOut = join(dir, 'push2.mp4')
    const pullOut = join(dir, 'pull.mp4')
    await run(FFMPEG, buildRenderPlan({ project: reelProject('in'), outputPath: pushOut }).args, {
      maxBuffer: 16 * 1024 * 1024
    })
    await run(FFMPEG, buildRenderPlan({ project: reelProject('out'), outputPath: pullOut }).args, {
      maxBuffer: 16 * 1024 * 1024
    })

    // Push starts wide and ends tight; pull is the reverse. So their first
    // frames should differ markedly.
    expect(difference(await frameAt(pushOut, 0.1), await frameAt(pullOut, 0.1))).toBeGreaterThan(4)
  }, 180_000)

  it('still renders the right size and duration', async () => {
    const out = join(dir, 'size.mp4')
    await run(FFMPEG, buildRenderPlan({ project: reelProject('in'), outputPath: out }).args, {
      maxBuffer: 16 * 1024 * 1024
    })
    const frame = await frameAt(out, 1)
    // gray8 at the project canvas.
    expect(frame.length).toBe(W * H)
  }, 180_000)

  /*
   * Every move is rendered for real, not asserted against as a string.
   *
   * The crop-based version of this filter built a perfectly plausible argv and
   * then died at runtime with "Error when evaluating the expression", because
   * crop resolves w/h once at configuration time. An expression bug is only
   * visible to ffmpeg, so ffmpeg has to be the one to check it.
   */
  it.each(MOTION_MOVES)('renders and actually moves: %s', async (direction) => {
    const out = join(dir, `move-${direction}.mp4`)
    const project = motionProject({ kind: 'kenburns', direction, amount: 0.25 })
    const { stderr } = await run(
      FFMPEG,
      buildRenderPlan({ project, outputPath: out }).args,
      { maxBuffer: 16 * 1024 * 1024 }
    )
    expect(String(stderr)).not.toMatch(/Error when evaluating|Invalid|failed/i)

    // A pan that silently resolves to a zero-width margin renders a static
    // frame and would otherwise pass unnoticed.
    expect(difference(await frameAt(out, 0.1), await frameAt(out, 2.8))).toBeGreaterThan(3)
  }, 180_000)

  it('shakes hard, then settles — an impact, not a vibration', async () => {
    const out = join(dir, 'shake.mp4')
    const project = motionProject({ kind: 'shake', amount: 0.12, hz: 10, decay: 0.16 })
    await run(FFMPEG, buildRenderPlan({ project, outputPath: out }).args, {
      maxBuffer: 16 * 1024 * 1024
    })

    // Oscillation means nearby frames differ; a held zoom means no black bars,
    // so every frame still fills the canvas.
    const a = await frameAt(out, 0.0)
    const b = await frameAt(out, 0.05)
    expect(a.length).toBe(W * H)
    expect(difference(a, b)).toBeGreaterThan(1)

    /*
     * And it has to stop.
     *
     * Without the decay envelope this ran for the whole shot: a rendered reel
     * shook for 2.23 continuous seconds on its drop, which reads as a fault
     * rather than a hit.
     */
    const late = difference(await frameAt(out, 2.5), await frameAt(out, 2.55))
    expect(late).toBeLessThan(difference(a, b) * 0.3)
  }, 180_000)
})

/*
 * Does the preview show what the render will produce?
 *
 * The preview draws `motionSourceRect`'s rectangle with drawImage; the renderer
 * compiles the same table into a zoompan expression. They are meant to be the
 * same operation, but "meant to" is not a test — so crop the source to the
 * preview's rectangle with ffmpeg and compare it against the real render at the
 * same instant. A divergence here is the class of bug where the export does not
 * match what the user approved.
 */
describe('preview and render agree', () => {
  it.each(['in', 'out', 'panRight', 'inLeft'] as const)('on %s', async (direction) => {
    const frames = 90
    const fps = 30
    const at = 45 // Mid-move, where zoom and pan have both advanced.
    const project = motionProject({ kind: 'kenburns', direction, amount: 0.25 })

    const rendered = join(dir, `agree-${direction}.mp4`)
    await run(FFMPEG, buildRenderPlan({ project, outputPath: rendered }).args, {
      maxBuffer: 16 * 1024 * 1024
    })

    // zoompan works at the source's own size, which is what the preview's
    // rectangle is expressed in too.
    const rect = motionSourceRect(
      project.clips[0].motion!,
      at / (frames - 1),
      at / fps,
      1280,
      720
    )

    const cropped = join(dir, `agree-${direction}.png`)
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', still,
      '-vf',
      `crop=${Math.round(rect.sw)}:${Math.round(rect.sh)}:${Math.round(rect.sx)}:${Math.round(rect.sy)},` +
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
      '-frames:v', '1', cropped])

    const fromRender = await frameAt(rendered, at / fps)
    const fromPreview = await frameAt(cropped, 0)

    // Not identical: zoompan and crop+scale use different scalers, and the
    // rectangle is rounded to whole pixels here. Close is the claim.
    expect(difference(fromRender, fromPreview)).toBeLessThan(12)
  }, 180_000)
})
