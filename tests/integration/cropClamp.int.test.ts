import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * The crop that killed an export.
 *
 *   Invalid too big or non positive size for width '3210' or height '1808'
 *
 * `crop` is the one filter whose arguments are checked against the real stream,
 * and it refuses rather than clamps. Two separate things were wrong:
 *
 *  1. The dimensions were rounded to the NEAREST even number, and rounding an
 *     odd number to the nearest even one rounds it UP — so a 3209-wide source
 *     was asked for 3210. Half of all realistic source/aspect pairs did this.
 *
 *  2. Even with the arithmetic fixed, the clamp could only be measured against
 *     the size the app BELIEVED — and the probe never reads rotation metadata,
 *     a parallax clip arrives already scaled, and a re-exported file keeps the
 *     dimensions the project recorded.
 *
 * So the crop is emitted as expressions over `in_w`/`in_h`, measured from what
 * actually arrives. This test proves that by lying to the plan: the project
 * says the asset is far larger than the file really is, which is exactly the
 * shape of every disagreement above.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path

let dir = ''
let small = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-cropclamp-'))
  small = join(dir, 'small.png')
  // Deliberately odd, and far smaller than the project will claim.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=641x481', '-frames:v', '1', small])
}, 120_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

/** A project whose asset dimensions are a lie, as a rotated or stale one would be. */
function lying(crop: Clip['crop']): Project {
  const asset: MediaAsset = {
    id: 'a1',
    path: small,
    name: 'small.png',
    kind: 'image',
    durationFrames: 30,
    // The file is 641x481. The project believes otherwise.
    width: 3209,
    height: 1807,
    fps: 30,
    hasVideo: true,
    hasAudio: false,
    size: 0
  }
  const clip: Clip = {
    id: 'c1',
    assetId: 'a1',
    trackId: 'v1',
    start: 0,
    duration: 10,
    inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    crop
  }
  return {
    ...emptyProject(),
    settings: { width: 320, height: 240, fps: 10, sampleRate: 48000 },
    assets: [asset],
    clips: [clip]
  }
}

describe('a crop against a source that is not what the project thinks', () => {
  it('renders instead of dying, when the crop is far too big', async () => {
    /*
     * The exact failing shape: the project believes 3209x1807 and asks for the
     * whole of it, while the file on disk is 641x481. Before this fix that was
     * "Invalid too big or non positive size" and a dead export.
     */
    const out = join(dir, 'clamped.mp4')
    const plan = buildRenderPlan({
      project: lying({ x: 0, y: 0, width: 3000, height: 1700 }),
      outputPath: out
    })
    await expect(run(FFMPEG, plan.args, { maxBuffer: 32 * 1024 * 1024 })).resolves.toBeDefined()
  }, 120_000)

  it('renders when the crop starts outside the real frame', async () => {
    // x is inside the believed source and far outside the real one.
    const out = join(dir, 'offedge.mp4')
    const plan = buildRenderPlan({
      project: lying({ x: 2800, y: 1600, width: 200, height: 100 }),
      outputPath: out
    })
    await expect(run(FFMPEG, plan.args, { maxBuffer: 32 * 1024 * 1024 })).resolves.toBeDefined()
  }, 120_000)

  it('still crops honestly when the project is telling the truth', async () => {
    /*
     * Self-clamping must not become "never crop". With truthful dimensions the
     * requested rectangle is the one taken — checked by cropping the left half
     * of a two-colour picture and finding only the left colour in the output.
     */
    const bicolour = join(dir, 'halves.png')
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=640x480',
      '-vf', 'drawbox=x=0:y=0:w=320:h=480:color=red@1:t=fill,drawbox=x=320:y=0:w=320:h=480:color=blue@1:t=fill',
      '-frames:v', '1', bicolour])

    const asset: MediaAsset = {
      id: 'a1', path: bicolour, name: 'halves.png', kind: 'image', durationFrames: 30,
      width: 640, height: 480, fps: 30, hasVideo: true, hasAudio: false, size: 0
    }
    const clip: Clip = {
      id: 'c1', assetId: 'a1', trackId: 'v1', start: 0, duration: 10, inPoint: 0, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'cover' },
      color: { brightness: 0, contrast: 1, saturation: 1 },
      crop: { x: 0, y: 0, width: 320, height: 480 }
    }
    const out = join(dir, 'lefthalf.mp4')
    await run(
      FFMPEG,
      buildRenderPlan({
        project: {
          ...emptyProject(),
          settings: { width: 160, height: 240, fps: 10, sampleRate: 48000 },
          assets: [asset],
          clips: [clip]
        },
        outputPath: out
      }).args,
      { maxBuffer: 32 * 1024 * 1024 }
    )

    const { stdout } = await run(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-i', out, '-frames:v', '1',
       '-vf', 'crop=8:8:76:116', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 }
    )
    const px = stdout as unknown as Buffer
    // Red survived; blue was cropped away.
    expect(px[0]).toBeGreaterThan(120)
    expect(px[2]).toBeLessThan(80)
  }, 120_000)
})
