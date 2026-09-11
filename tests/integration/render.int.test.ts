import { describe, it, expect, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type MediaAsset, type Clip } from '@shared/timeline'

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const FFPROBE = ffprobeInstaller.path

let dir = ''
let source = ''

async function probe(path: string): Promise<Record<string, unknown>> {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path
  ])
  return JSON.parse(stdout)
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-render-'))
  source = join(dir, 'source.mp4')
  // 10s of 1920x1080 @30fps colour bars with a tone, so crops are visibly wrong
  // if the filter order is wrong and duration maths is checkable.
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    source
  ])
}, 120_000)

function asset(): MediaAsset {
  return {
    id: 'a1', path: source, name: 'source.mp4', kind: 'video',
    durationFrames: 300, width: 1920, height: 1080, fps: 30,
    hasVideo: true, hasAudio: true, size: 0
  }
}

function clip(over: Partial<Clip>): Clip {
  return {
    id: 'c', assetId: 'a1', trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

describe('render plan produces a real file', () => {
  it('concatenates two trimmed clips to the exact expected duration', async () => {
    const out = join(dir, 'concat.mp4')
    const plan = buildRenderPlan({
      project: {
        ...emptyProject(),
        assets: [asset()],
        clips: [
          clip({ id: 'a', start: 0, duration: 60, inPoint: 30 }),
          clip({ id: 'b', start: 60, duration: 30, inPoint: 150 })
        ]
      },
      outputPath: out
    })

    await run(FFMPEG, plan.args, { maxBuffer: 16 * 1024 * 1024 })

    const info = await probe(out)
    const duration = Number((info.format as { duration: string }).duration)
    // 90 frames at 30fps = 3s. Allow a frame of container rounding.
    expect(duration).toBeGreaterThan(2.9)
    expect(duration).toBeLessThan(3.2)

    const streams = info.streams as { codec_type: string; width?: number; height?: number }[]
    const video = streams.find((s) => s.codec_type === 'video')!
    expect(video.width).toBe(1920)
    expect(video.height).toBe(1080)
    expect(streams.some((s) => s.codec_type === 'audio')).toBe(true)
  }, 120_000)

  it('crops to a vertical reframe and pads to a 9:16 canvas', async () => {
    const out = join(dir, 'vertical.mp4')
    const plan = buildRenderPlan({
      project: {
        ...emptyProject(),
        assets: [asset()],
        clips: [clip({ crop: { x: 420, y: 0, width: 1080, height: 1080 } })]
      },
      outputPath: out,
      canvas: { width: 1080, height: 1920 }
    })

    await run(FFMPEG, plan.args, { maxBuffer: 16 * 1024 * 1024 })

    const info = await probe(out)
    const video = (info.streams as { codec_type: string; width?: number; height?: number }[])
      .find((s) => s.codec_type === 'video')!
    expect(video.width).toBe(1080)
    expect(video.height).toBe(1920)
  }, 120_000)

  it('renders a still image for its full clip duration', async () => {
    const still = join(dir, 'still.png')
    await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:size=1920x1080', '-frames:v', '1', still
    ])

    const out = join(dir, 'still.mp4')
    const plan = buildRenderPlan({
      project: {
        ...emptyProject(),
        assets: [{ ...asset(), id: 'img', path: still, kind: 'image', hasAudio: false, durationFrames: 1 }],
        clips: [clip({ assetId: 'img', duration: 45 })]
      },
      outputPath: out
    })

    await run(FFMPEG, plan.args, { maxBuffer: 16 * 1024 * 1024 })

    const info = await probe(out)
    const duration = Number((info.format as { duration: string }).duration)
    // 45 frames at 30fps = 1.5s.
    expect(duration).toBeGreaterThan(1.4)
    expect(duration).toBeLessThan(1.7)
  }, 120_000)
})
