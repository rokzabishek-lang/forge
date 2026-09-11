import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { compositeGraphics, CompositeError } from '../../src/main/graphics/compositor'

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path

const W = 320
const H = 240
const FPS = 10
const FRAMES = 20

let dir = ''
let source = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-comp-'))
  source = join(dir, 'base.mp4')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:size=${W}x${H}:rate=${FPS}:duration=2`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source
  ])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

/** A fully transparent BGRA frame with an opaque coloured block in the middle. */
function frameWithBlock(b: number, g: number, r: number, opaque = true): Buffer {
  const buffer = Buffer.alloc(W * H * 4, 0)
  for (let y = H / 4; y < (H * 3) / 4; y++) {
    for (let x = W / 4; x < (W * 3) / 4; x++) {
      const i = (y * W + x) * 4
      buffer[i] = b
      buffer[i + 1] = g
      buffer[i + 2] = r
      buffer[i + 3] = opaque ? 255 : 0
    }
  }
  return buffer
}

/**
 * Decode one whole frame as raw RGB and index into it.
 *
 * Reading a single pixel with ffmpeg's crop filter is fragile — literal 1x1
 * dimensions get mis-parsed — and decoding the full frame lets several pixels be
 * sampled from exactly the same moment.
 */
async function frameRgb(file: string, atSeconds: number): Promise<Buffer> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(atSeconds), '-i', file,
     '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }
  )
  return stdout as unknown as Buffer
}

function at(frame: Buffer, x: number, y: number): [number, number, number] {
  const i = (y * W + x) * 3
  return [frame[i], frame[i + 1], frame[i + 2]]
}

async function pixel(file: string, atSeconds: number, x: number, y: number): Promise<[number, number, number]> {
  return at(await frameRgb(file, atSeconds), x, y)
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

describe('compositeGraphics', () => {
  it('overlays opaque graphics onto the video', async () => {
    const out = join(dir, 'red.mp4')
    // BGRA: blue=0, green=0, red=255.
    const frame = frameWithBlock(0, 0, 255)

    await compositeGraphics({
      videoPath: source, outputPath: out,
      width: W, height: H, fps: FPS, durationFrames: FRAMES,
      produceFrame: async () => frame,
      ffmpegPath: FFMPEG, preset: 'ultrafast'
    }).promise

    expect(await exists(out)).toBe(true)

    // Centre must be red; a corner must stay black where alpha was zero.
    const [cr, cg, cb] = await pixel(out, 0.5, W / 2, H / 2)
    expect(cr).toBeGreaterThan(180)
    expect(cg).toBeLessThan(60)
    expect(cb).toBeLessThan(60)

    const [er, eg, eb] = await pixel(out, 0.5, 4, 4)
    expect(er + eg + eb).toBeLessThan(40)
  }, 180_000)

  it('respects the alpha channel — transparent graphics leave the video alone', async () => {
    const out = join(dir, 'clear.mp4')
    const frame = frameWithBlock(0, 0, 255, false)

    await compositeGraphics({
      videoPath: source, outputPath: out,
      width: W, height: H, fps: FPS, durationFrames: FRAMES,
      produceFrame: async () => frame,
      ffmpegPath: FFMPEG, preset: 'ultrafast'
    }).promise

    // Alpha 0 everywhere: the centre must stay black, not turn red.
    const [r, g, b] = await pixel(out, 0.5, W / 2, H / 2)
    expect(r + g + b).toBeLessThan(40)
  }, 180_000)

  it('treats frames as BGRA, not RGBA', async () => {
    const out = join(dir, 'blue.mp4')
    // BGRA with blue=255 must come out BLUE. If the byte order were misread as
    // RGBA this renders red, which looks like a colour-management bug.
    const frame = frameWithBlock(255, 0, 0)

    await compositeGraphics({
      videoPath: source, outputPath: out,
      width: W, height: H, fps: FPS, durationFrames: FRAMES,
      produceFrame: async () => frame,
      ffmpegPath: FFMPEG, preset: 'ultrafast'
    }).promise

    const [r, g, b] = await pixel(out, 0.5, W / 2, H / 2)
    expect(b).toBeGreaterThan(180)
    expect(r).toBeLessThan(60)
    expect(g).toBeLessThan(60)
  }, 180_000)

  it('animates — later frames can differ from earlier ones', async () => {
    const out = join(dir, 'anim.mp4')
    const red = frameWithBlock(0, 0, 255)
    const green = frameWithBlock(0, 255, 0)

    await compositeGraphics({
      videoPath: source, outputPath: out,
      width: W, height: H, fps: FPS, durationFrames: FRAMES,
      produceFrame: async (n) => (n < FRAMES / 2 ? red : green),
      ffmpegPath: FFMPEG, preset: 'ultrafast'
    }).promise

    const [r1] = await pixel(out, 0.2, W / 2, H / 2)
    const [, g2] = await pixel(out, 1.5, W / 2, H / 2)
    expect(r1).toBeGreaterThan(180)
    expect(g2).toBeGreaterThan(150)
  }, 180_000)

  it('reports progress monotonically to 1', async () => {
    const seen: number[] = []
    await compositeGraphics({
      videoPath: source, outputPath: join(dir, 'prog.mp4'),
      width: W, height: H, fps: FPS, durationFrames: FRAMES,
      produceFrame: async () => frameWithBlock(0, 0, 255),
      onProgress: (p) => seen.push(p),
      ffmpegPath: FFMPEG, preset: 'ultrafast'
    }).promise

    expect(seen.at(-1)).toBe(1)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  }, 180_000)

  it('rejects a frame of the wrong size instead of producing garbage', async () => {
    const out = join(dir, 'bad.mp4')
    const handle = compositeGraphics({
      videoPath: source, outputPath: out,
      width: W, height: H, fps: FPS, durationFrames: FRAMES,
      produceFrame: async () => Buffer.alloc(10),
      ffmpegPath: FFMPEG, preset: 'ultrafast'
    })
    // A short buffer would silently desynchronise every subsequent frame.
    await expect(handle.promise).rejects.toThrow(/expected .* BGRA/)
  }, 180_000)

  it('stops producing frames once ffmpeg has consumed all it needs', async () => {
    // overlay's shortest=1 ends with the 2s base video, i.e. 20 frames. Asking
    // for 5000 must not render 5000 — each frame is expensive at tier 2.
    let produced = 0
    await compositeGraphics({
      videoPath: source, outputPath: join(dir, 'short.mp4'),
      width: W, height: H, fps: FPS, durationFrames: 5000,
      produceFrame: async () => {
        produced++
        return frameWithBlock(0, 0, 255)
      },
      ffmpegPath: FFMPEG, preset: 'ultrafast'
    }).promise

    expect(produced).toBeLessThan(500)
  }, 180_000)

  it('cancels and removes the partial output', async () => {
    // A long base video, so there is real work to interrupt.
    const longBase = join(dir, 'long.mp4')
    await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=black:size=${W}x${H}:rate=${FPS}:duration=90`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', longBase
    ])

    const out = join(dir, 'cancelled.mp4')
    const handle = compositeGraphics({
      videoPath: longBase, outputPath: out,
      width: W, height: H, fps: FPS, durationFrames: 900,
      produceFrame: async () => frameWithBlock(0, 0, 255),
      ffmpegPath: FFMPEG, preset: 'veryslow'
    })
    setTimeout(() => handle.cancel(), 500)

    await expect(handle.promise).rejects.toBeInstanceOf(CompositeError)
    expect(await exists(out)).toBe(false)
  }, 180_000)
})
