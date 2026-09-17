import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { stripCell } from '@shared/render/strips'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * Strips, rendered.
 *
 * The column and band layouts are grid cells and are already covered by the
 * grid's own integration tests. The diagonal is not: a band at an angle is a
 * rotated rectangle masked out of a full frame, and every number in it — the
 * angle, the spacing, the sideways offset — has so far only been checked
 * against the arithmetic that produced it.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path

const W = 240
const H = 426
const CANVAS = { width: W, height: H }
const ANGLE = 30

let dir = ''
let white = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-strips-'))
  white = join(dir, 'white.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=white:s=${W * 2}x${H * 2}`, '-frames:v', '1', white])
}, 120_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

const asset: MediaAsset = {
  id: 'photo',
  path: '',
  name: 'white.png',
  kind: 'image',
  durationFrames: 60,
  width: W * 2,
  height: H * 2,
  fps: 30,
  hasVideo: true,
  hasAudio: false,
  size: 0
}

function clipFor(slot: number, count: number): Clip {
  const cell = stripCell('diagonal', count, slot, { width: W * 2, height: H * 2 }, CANVAS, ANGLE)!
  return {
    id: `s${slot}`,
    assetId: 'photo',
    trackId: 'v1',
    start: 0,
    duration: 10,
    inPoint: 0,
    volume: 0,
    transform: cell.transform,
    color: { brightness: 0, contrast: 1, saturation: 1 },
    crop: cell.crop,
    mask: cell.mask
  }
}

async function frame(clips: Clip[], name: string): Promise<Buffer> {
  const project: Project = {
    ...emptyProject(),
    settings: { width: W, height: H, fps: 10, sampleRate: 48000 },
    assets: [{ ...asset, path: white }],
    clips
  }
  const out = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project, outputPath: out }).args, {
    maxBuffer: 64 * 1024 * 1024
  })
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-i', out, '-frames:v', '1',
     '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  )
  return stdout as unknown as Buffer
}

const lit = (buffer: Buffer, x: number, y: number): boolean => buffer[y * W + x] > 110

describe('a diagonal band', () => {
  it('renders at the angle it was asked for', async () => {
    const buffer = await frame([clipFor(2, 5)], 'band')

    /*
     * The band's edge, followed down the frame. A band at 30 degrees off
     * horizontal moves sideways by 1/tan(30) for every pixel down — so the
     * measured slope is the angle, and a band that came out level or vertical
     * would not be close.
     */
    const firstLit = (y: number): number => {
      for (let x = 0; x < W; x++) if (lit(buffer, x, y)) return x
      return -1
    }
    const samples: { y: number; x: number }[] = []
    for (let y = 40; y < H - 40; y += 20) {
      const x = firstLit(y)
      if (x > 0 && x < W - 1) samples.push({ y, x })
    }
    expect(samples.length).toBeGreaterThan(5)

    const first = samples[0]
    const last = samples[samples.length - 1]
    const slope = (last.x - first.x) / (last.y - first.y)
    const measured = (Math.atan2(1, Math.abs(slope)) * 180) / Math.PI
    expect(measured).toBeCloseTo(ANGLE, 0)
  }, 180_000)

  it('is a band and not the whole frame', async () => {
    const buffer = await frame([clipFor(2, 5)], 'one-of-five')
    let count = 0
    for (let i = 0; i < W * H; i++) if (buffer[i] > 110) count++
    const share = count / (W * H)
    // One of five bands: a fifth of the frame, give or take the ends that fall
    // outside it and the feather.
    expect(share).toBeGreaterThan(0.1)
    expect(share).toBeLessThan(0.3)
  }, 180_000)

  it('five bands together cover the frame with no stripe left out', async () => {
    const buffer = await frame([0, 1, 2, 3, 4].map((i) => clipFor(i, 5)), 'all-five')
    let dark = 0
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) if (!lit(buffer, x, y)) dark++
    }
    // The joins are feathered, so a few soft pixels are expected; a missing
    // band would be a fifth of the frame.
    expect(dark).toBeLessThan((W * H) / 40)
  }, 180_000)

  it('neighbouring bands sit next to each other, not on top of each other', async () => {
    const one = await frame([clipFor(1, 5)], 'band-1')
    const two = await frame([clipFor(2, 5)], 'band-2')
    let both = 0
    let either = 0
    for (let i = 0; i < W * H; i++) {
      const a = one[i] > 110
      const b = two[i] > 110
      if (a && b) both++
      if (a || b) either++
    }
    expect(either).toBeGreaterThan(W * H * 0.2)
    // A little overlap at the feathered join is fine; a band drawn in the same
    // place twice would be most of it.
    expect(both / either).toBeLessThan(0.08)
  }, 180_000)
})
