import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Motion, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, saveFrame, writeNote } from './output'

/*
 * A camera move must not change the SHAPE of the picture.
 *
 * The move runs at a working size capped for speed — and the cap was 2560 wide
 * by 1440 tall, applied to each side on its own. A phone photo is portrait, and
 * a portrait photo in a vertical reel wants to be taller than 1440, so its
 * height was cut to 1440 and its width was not: a 3024×4032 photo went into the
 * move at 1304×1440, 21 % too wide, and came out stretched. Every Ken Burns on
 * a tall photo in a 9:16 reel — the wedding reel — exported distorted, while
 * the preview (which does not go through this path) showed it right.
 *
 * The same cap would have made every 4K move soft: a 2160-wide canvas fed from
 * a working picture at most 2560×1440.
 *
 * Measured with a white square on black: whatever the move, frame 0 is at zoom
 * 1, so the square must come out square and the size it is with no move at all.
 */

let dir = ''
let portrait = ''
let landscape = ''

/** A photo-sized frame, black, with a white square in the middle. */
async function photoWithSquare(file: string, width: number, height: number, side: number): Promise<string> {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=1`,
    '-vf', `drawbox=x=${(width - side) / 2}:y=${(height - side) / 2}:w=${side}:h=${side}:color=white:t=fill`,
    '-frames:v', '1', file
  ])
  return file
}

beforeAll(async () => {
  dir = await outputDir('motion-aspect')
  portrait = await photoWithSquare(join(dir, 'source-portrait.png'), 3024, 4032, 1200)
  landscape = await photoWithSquare(join(dir, 'source-landscape.png'), 4032, 3024, 1200)
  await writeNote(dir, [
    'A camera move must not change the shape of the picture.',
    '',
    'Each render is a photo with a white square, first frame saved as a PNG.',
    'The square must be square, and the size it is with no move at all.',
    '',
    'portrait-still-9x16.png    a 3024x4032 photo in a 1080x1920 reel, no move',
    'portrait-kenburns-9x16.png the same with a Ken Burns — was 21% too wide',
    'portrait-kenburns-4k.png   the same at 2160x3840',
    'landscape-kenburns-16x9.png a 4032x3024 photo in 1920x1080, the control'
  ])
}, 180_000)

function photoProject(path: string, width: number, height: number, canvas: { width: number; height: number }, motion?: Motion): Project {
  const asset: MediaAsset = {
    id: 'img', path, name: 'photo.png', kind: 'image', durationFrames: 30,
    width, height, fps: null, hasVideo: true, hasAudio: false, size: 1
  }
  const clip: Clip = {
    id: 'c', assetId: 'img', trackId: 'v1', start: 0, duration: 30, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...(motion ? { motion } : {})
  }
  return {
    ...emptyProject(),
    settings: { width: canvas.width, height: canvas.height, fps: 30, sampleRate: 48000 },
    assets: [asset],
    clips: [clip]
  }
}

/** The white square's bounding box in the first frame. */
async function squareIn(project: Project, name: string): Promise<{ width: number; height: number }> {
  const file = join(dir, `${name}.mp4`)
  const { width, height } = project.settings
  await run(FFMPEG, buildRenderPlan({ project, outputPath: file }).args, { maxBuffer: 32 * 1024 * 1024 })
  await saveFrame(file, 0, join(dir, `${name}.png`))
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  )
  const frame = stdout as unknown as Buffer
  let left = width, right = -1, top = height, bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (frame[y * width + x] > 128) {
        left = Math.min(left, x); right = Math.max(right, x)
        top = Math.min(top, y); bottom = Math.max(bottom, y)
      }
    }
  }
  return { width: right - left + 1, height: bottom - top + 1 }
}

const kenBurns: Motion = { kind: 'kenburns', direction: 'in', amount: 0.15 }

describe('a camera move keeps the picture’s shape', () => {
  it('a tall photo in a vertical reel stays in proportion', async () => {
    const reel = { width: 1080, height: 1920 }
    const still = await squareIn(photoProject(portrait, 3024, 4032, reel), 'portrait-still-9x16')
    const moving = await squareIn(photoProject(portrait, 3024, 4032, reel, kenBurns), 'portrait-kenburns-9x16')

    // Contain-fit: 3024 wide into 1080, so the 1200 px square is ~429 px.
    expect(Math.abs(still.width - 429)).toBeLessThan(6)
    // Square, within a pixel or two of scaling.
    expect(Math.abs(moving.width / moving.height - 1)).toBeLessThan(0.02)
    // And the size it is with no move — frame 0 is zoom 1.
    expect(Math.abs(moving.width - still.width) / still.width).toBeLessThan(0.02)
    expect(Math.abs(moving.height - still.height) / still.height).toBeLessThan(0.02)
  }, 300_000)

  it('keeps its shape and its size at 4K', async () => {
    const reel4k = { width: 2160, height: 3840 }
    const moving = await squareIn(photoProject(portrait, 3024, 4032, reel4k, kenBurns), 'portrait-kenburns-4k')
    // 3024 into 2160: the square is ~857 px — not a 1440-high picture upscaled.
    expect(Math.abs(moving.width / moving.height - 1)).toBeLessThan(0.02)
    expect(Math.abs(moving.width - 857) / 857).toBeLessThan(0.02)
  }, 300_000)

  it('a wide photo in a wide frame, the control', async () => {
    const wide = { width: 1920, height: 1080 }
    const moving = await squareIn(photoProject(landscape, 4032, 3024, wide, kenBurns), 'landscape-kenburns-16x9')
    // 3024 tall into 1080: the square is ~429 px.
    expect(Math.abs(moving.width / moving.height - 1)).toBeLessThan(0.02)
    expect(Math.abs(moving.height - 429) / 429).toBeLessThan(0.02)
  }, 300_000)
})
