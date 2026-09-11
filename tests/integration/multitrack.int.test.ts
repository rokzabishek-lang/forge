import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path

const W = 320
const H = 240
let dir = ''
let blue = ''
let red = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-mt-'))
  blue = join(dir, 'blue.mp4')
  red = join(dir, 'red.mp4')
  // Two flat colours, so "which layer won" is unambiguous from one pixel.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=blue:size=${W}x${H}:rate=30:duration=4`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue])
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=red:size=${W}x${H}:rate=30:duration=4`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function asset(id: string, path: string): MediaAsset {
  return {
    id, path, name: id, kind: 'video', durationFrames: 120,
    width: W, height: H, fps: 30, hasVideo: true, hasAudio: false, size: 0
  }
}

function clip(over: Partial<Clip>): Clip {
  return {
    id: 'c', assetId: 'blue', trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

function twoVideoTracks(clips: Clip[]): Project {
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: 30, sampleRate: 48000 },
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
      { id: 'v2', kind: 'video', name: 'V2', muted: false, hidden: false, locked: false },
      { id: 'a1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false }
    ],
    assets: [asset('blue', blue), asset('red', red)],
    clips
  }
}

async function centrePixel(file: string, atSeconds: number): Promise<[number, number, number]> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(atSeconds), '-i', file,
     '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }
  )
  const buf = stdout as unknown as Buffer
  const i = ((H / 2) * W + W / 2) * 3
  return [buf[i], buf[i + 1], buf[i + 2]]
}

describe('multi-track rendering', () => {
  it('puts a higher track on top of a lower one', async () => {
    const out = join(dir, 'layered.mp4')
    const project = twoVideoTracks([
      clip({ id: 'bottom', assetId: 'blue', trackId: 'v1', start: 0, duration: 60 }),
      clip({ id: 'top', assetId: 'red', trackId: 'v2', start: 0, duration: 60 })
    ])

    await run(FFMPEG, buildRenderPlan({ project, outputPath: out }).args, {
      maxBuffer: 16 * 1024 * 1024
    })

    // v2 is above v1, so red must win.
    const [r, g, b] = await centrePixel(out, 1)
    expect(r).toBeGreaterThan(150)
    expect(b).toBeLessThan(80)
    expect(g).toBeLessThan(80)
  }, 180_000)

  it('reveals the lower track once the upper clip ends', async () => {
    const out = join(dir, 'reveal.mp4')
    const project = twoVideoTracks([
      clip({ id: 'bottom', assetId: 'blue', trackId: 'v1', start: 0, duration: 90 }),
      // Top clip covers only the first second.
      clip({ id: 'top', assetId: 'red', trackId: 'v2', start: 0, duration: 30 })
    ])

    await run(FFMPEG, buildRenderPlan({ project, outputPath: out }).args, {
      maxBuffer: 16 * 1024 * 1024
    })

    const early = await centrePixel(out, 0.5)
    const late = await centrePixel(out, 2.0)

    expect(early[0]).toBeGreaterThan(150) // red on top
    // If repeatlast were not disabled, red's last frame would be held forever.
    expect(late[2]).toBeGreaterThan(150) // blue revealed
    expect(late[0]).toBeLessThan(80)
  }, 180_000)

  it('renders a gap as black rather than pulling later clips earlier', async () => {
    const out = join(dir, 'gap.mp4')
    const project = twoVideoTracks([
      clip({ id: 'a', assetId: 'blue', trackId: 'v1', start: 0, duration: 30 }),
      // One-second hole, then a clip at 2s.
      clip({ id: 'b', assetId: 'red', trackId: 'v1', start: 60, duration: 30 })
    ])

    await run(FFMPEG, buildRenderPlan({ project, outputPath: out }).args, {
      maxBuffer: 16 * 1024 * 1024
    })

    const first = await centrePixel(out, 0.5)
    const hole = await centrePixel(out, 1.5)
    const second = await centrePixel(out, 2.5)

    expect(first[2]).toBeGreaterThan(150)
    // The gap must be black — not blue held, and not red arriving early.
    expect(hole[0] + hole[1] + hole[2]).toBeLessThan(60)
    expect(second[0]).toBeGreaterThan(150)
  }, 180_000)
})
