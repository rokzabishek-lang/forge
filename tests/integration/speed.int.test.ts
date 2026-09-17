import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * Speed, rendered.
 *
 * The contract is one line — `source frames consumed = duration × speed`, and
 * the clip occupies `duration` on the timeline — but every part of it is a
 * separate chance to be wrong: the input trim, the retime, the frame-count
 * restore, and the audio stretch. These render real files and measure them.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const FFPROBE = ffprobeInstaller.path
const W = 160
const H = 120
const FPS = 30

let dir = ''
let clipFile = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-speed-'))
  clipFile = join(dir, 'src.mp4')
  // Eight seconds, so speeding up has somewhere to go.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=${FPS}:duration=8`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clipFile])
}, 300_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function spedProject(speed: number | undefined, durationFrames: number): Project {
  const asset: MediaAsset = {
    id: 'v', path: clipFile, name: 'src.mp4', kind: 'video', durationFrames: 8 * FPS,
    width: 320, height: 240, fps: FPS, hasVideo: true, hasAudio: true, size: 0
  }
  const clip: Clip = {
    id: 'c1', assetId: 'v', trackId: 'v1', start: 0, duration: durationFrames, inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'cover' },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    speed
  }
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: FPS, sampleRate: 48000 },
    assets: [asset],
    clips: [clip]
  }
}

async function renderDuration(project: Project): Promise<number> {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.mp4`)
  const plan = buildRenderPlan({ project, outputPath: out })
  await run(FFMPEG, plan.args, { maxBuffer: 32 * 1024 * 1024 })
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out
  ])
  return Number(stdout.trim())
}

describe('speed', () => {
  it('costs nothing at normal speed', () => {
    const plan = buildRenderPlan({ project: spedProject(undefined, 60), outputPath: '/x.mp4' })
    const graph = plan.args.join(' ')
    expect(graph).not.toContain('setpts=PTS/')
    expect(graph).not.toContain('atempo')
  })

  it('takes only as much source as it needs', () => {
    // Two seconds of timeline at half speed is one second of footage.
    const plan = buildRenderPlan({ project: spedProject(0.5, 2 * FPS), outputPath: '/x.mp4' })
    const i = plan.args.indexOf('-i')
    expect(plan.args[i - 1]).toBe('1.000000')
  })

  it('takes more source when speeding up', () => {
    const plan = buildRenderPlan({ project: spedProject(2, 2 * FPS), outputPath: '/x.mp4' })
    const i = plan.args.indexOf('-i')
    expect(plan.args[i - 1]).toBe('4.000000')
  })

  it('chains atempo below its accepted floor', () => {
    // Measured: atempo refuses anything under 0.5, so a quarter is two halvings.
    const plan = buildRenderPlan({ project: spedProject(0.25, 2 * FPS), outputPath: '/x.mp4' })
    const graph = plan.args.join(' ')
    expect(graph).toContain('atempo=0.5,atempo=0.5')
  })

  it('uses a single atempo when one is enough', () => {
    const graph = buildRenderPlan({
      project: spedProject(2, 2 * FPS), outputPath: '/x.mp4'
    }).args.join(' ')
    expect(graph).toContain('atempo=2')
    expect(graph).not.toContain('atempo=0.5')
  })

  it('leaves stills alone — a photograph has no rate', () => {
    const project = spedProject(0.5, 2 * FPS)
    project.assets[0] = { ...project.assets[0], kind: 'image', hasAudio: false }
    const graph = buildRenderPlan({ project, outputPath: '/x.mp4' }).args.join(' ')
    expect(graph).not.toContain('setpts=PTS/')
  })

  it('only interpolates when slowing down', () => {
    const fast = spedProject(2, 2 * FPS)
    fast.clips[0].smoothSlow = true
    expect(buildRenderPlan({ project: fast, outputPath: '/x.mp4' }).args.join(' '))
      .not.toContain('minterpolate')

    const slow = spedProject(0.5, 2 * FPS)
    slow.clips[0].smoothSlow = true
    expect(buildRenderPlan({ project: slow, outputPath: '/x.mp4' }).args.join(' '))
      .toContain('minterpolate')
  })

  /*
   * The assertions that matter: the clip occupies the time it says it does,
   * whatever speed it runs at. A retime that forgot to restore the frame count
   * would still produce a file — just a shorter one.
   */
  it('renders a slowed clip at its timeline length', async () => {
    const seconds = await renderDuration(spedProject(0.5, 4 * FPS))
    expect(Math.abs(seconds - 4), `expected ~4s, got ${seconds}`).toBeLessThan(0.35)
  }, 300_000)

  it('renders a quarter-speed clip at its timeline length', async () => {
    const seconds = await renderDuration(spedProject(0.25, 4 * FPS))
    expect(Math.abs(seconds - 4), `expected ~4s, got ${seconds}`).toBeLessThan(0.35)
  }, 300_000)

  it('renders a fast clip at its timeline length', async () => {
    const seconds = await renderDuration(spedProject(2, 2 * FPS))
    expect(Math.abs(seconds - 2), `expected ~2s, got ${seconds}`).toBeLessThan(0.35)
  }, 300_000)

  it('renders normal speed unchanged', async () => {
    const seconds = await renderDuration(spedProject(1, 3 * FPS))
    expect(Math.abs(seconds - 3), `expected ~3s, got ${seconds}`).toBeLessThan(0.35)
  }, 300_000)
})
