import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { outputDir } from './output'

/*
 * Adjustment layers.
 *
 * Resolve's shape: the track position decides which layers are graded, the
 * horizontal duration decides when. These render real frames and read them back,
 * because "the grade applied" and "the grade applied to the right frames" are
 * different claims.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const W = 160
const H = 120
const FPS = 10
const FRAMES = 40

let dir = ''
let grey = ''
let blank = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-adjust-'))
  grey = join(dir, 'grey.png')
  blank = join(dir, 'blank.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=gray:size=160x120:rate=1:duration=1', '-frames:v', '1', grey])
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black@0.0:size=16x16:rate=1:duration=1',
    '-frames:v', '1', blank])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function asset(id: string, path: string): MediaAsset {
  return {
    id, path, name: id, kind: 'image', durationFrames: FRAMES,
    width: 160, height: 120, fps: FPS, hasVideo: true, hasAudio: false, size: 0
  }
}

function clip(id: string, assetId: string, trackId: string, extra: Partial<Clip> = {}): Clip {
  return {
    id, assetId, trackId, start: 0, duration: FRAMES, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'cover' },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...extra
  }
}

/** A grey picture on V1 with an adjustment layer over part of it on V2. */
function adjustedProject(over: Partial<Clip>): Project {
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: FPS, sampleRate: 48000 },
    assets: [asset('grey', grey), asset('blank', blank)],
    clips: [
      clip('c-under', 'grey', 'v1'),
      clip('c-adjust', 'blank', 'v2', { adjustment: true, ...over })
    ]
  }
}

async function meanAt(file: string, seconds: number): Promise<number> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file,
     '-vf', 'crop=40:40:60:40', '-frames:v', '1',
     '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }
  )
  const buffer = stdout as unknown as Buffer
  let total = 0
  for (const v of buffer) total += v
  return total / buffer.length
}

async function render(project: Project): Promise<string> {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project, outputPath: out }).args, {
    maxBuffer: 32 * 1024 * 1024
  })
  return out
}

describe('adjustment layers', () => {
  it('grades the track below it', async () => {
    const plain = await render({
      ...adjustedProject({}),
      clips: [clip('c-under', 'grey', 'v1')]
    })
    const lifted = await render(
      adjustedProject({ color: { brightness: 0.4, contrast: 1, saturation: 1 } })
    )
    expect(await meanAt(lifted, 1)).toBeGreaterThan((await meanAt(plain, 1)) + 15)
  }, 120_000)

  it('applies only for the frames it covers', async () => {
    /*
     * The half that makes it an editing tool rather than a global setting: the
     * horizontal position is the scope in time.
     */
    const project = adjustedProject({
      start: 20,
      duration: 20,
      color: { brightness: 0.4, contrast: 1, saturation: 1 }
    })
    const out = await render(project)
    const before = await meanAt(out, 1.0) // frame 10, outside
    const during = await meanAt(out, 3.0) // frame 30, inside
    expect(during).toBeGreaterThan(before + 15)
  }, 120_000)

  it('is never drawn itself', () => {
    const graph = buildRenderPlan({
      project: adjustedProject({ color: { brightness: 0.4, contrast: 1, saturation: 1 } }),
      outputPath: '/tmp/x.mp4'
    }).args.join(' ')
    // One overlay, for the picture. The layer grades rather than composites.
    expect(graph.match(/overlay=/g) ?? []).toHaveLength(1)
    expect(graph).toContain('enable=')
  })

  it('hands the chain along even with nothing set on it', () => {
    // A layer just dropped on the timeline must not break the render.
    const graph = buildRenderPlan({
      project: adjustedProject({}),
      outputPath: '/tmp/x.mp4'
    }).args.join(' ')
    expect(graph).toContain('[vmix]')
  })

  it('ends the chain at vmix when the layer is the topmost clip', () => {
    const graph = buildRenderPlan({
      project: adjustedProject({ color: { brightness: 0.2, contrast: 1, saturation: 1 } }),
      outputPath: '/tmp/x.mp4'
    }).args.join(' ')
    expect(graph).toContain('[vmix]')
  })

  it('renders with a look on it, at full strength and part strength', async () => {
    /*
     * The graph test below only ever READ the string, and the string was
     * fine — but a copy of the look was also being built on the layer's own
     * never-drawn picture and left unconnected, and ffmpeg refuses a graph
     * with a loose end. A Grade layer with a look could not export at all.
     */
    const cube = join(dir, 'white.cube')
    // Every colour to white: unmistakable in the mean.
    await writeFile(cube, `LUT_3D_SIZE 2\n${'1 1 1\n'.repeat(8)}`)
    const out = await outputDir('adjustment-look')
    const plain = await render({ ...adjustedProject({}), clips: [clip('c-under', 'grey', 'v1')] })
    for (const intensity of [1, 0.5]) {
      const file = join(out, `look-${intensity}.mp4`)
      await run(FFMPEG, buildRenderPlan({
        project: adjustedProject({
          color: { brightness: 0, contrast: 1, saturation: 1, lut: { file: cube, intensity } },
          // A key a project may carry although the Inspector never offers one
          // here: it must not build loose ends on the layer's picture either.
          key: { color: '#00b140', similarity: 0.12, blend: 0.08, despill: 0.6 }
        }),
        outputPath: file
      }).args, { maxBuffer: 32 * 1024 * 1024 })
      expect(await meanAt(file, 1), `intensity ${intensity}`).toBeGreaterThan((await meanAt(plain, 1)) + 30)
    }
  }, 120_000)

  it('carries a LUT as well as the sliders', () => {
    const graph = buildRenderPlan({
      project: adjustedProject({
        color: {
          brightness: 0,
          contrast: 1,
          saturation: 1,
          lut: { file: join(dir, 'x.cube'), intensity: 0.5 }
        }
      }),
      outputPath: '/tmp/x.mp4'
    }).args.join(' ')
    expect(graph).toContain('lut3d')
    expect(graph).toContain('blend=')
  })
})
