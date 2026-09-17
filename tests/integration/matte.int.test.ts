import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan, RenderError } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * Text as a window onto a picture.
 *
 * The trailer look: block letters with footage moving inside them. The mechanism
 * is alphamerge — the same filter the mask transitions use — with the shape
 * coming from a clip on the timeline rather than a file, so the word can be
 * retyped and the fill follows.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const W = 160
const H = 120
const FPS = 10
const FRAMES = 10

let dir = ''
let picture = ''
let shape = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-matte-'))
  picture = join(dir, 'white.png')
  shape = join(dir, 'shape.png')

  // A white picture, so anything that survives the matte is unmistakably lit.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=white:size=160x120:rate=1:duration=1', '-frames:v', '1', picture])

  // A shape that is white on the LEFT half and black on the right — asymmetric,
  // so an inverted or ignored matte is visible rather than plausible.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:size=160x120:rate=1:duration=1',
    '-vf', 'drawbox=x=0:y=0:w=80:h=120:color=white:t=fill', '-frames:v', '1', shape])
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

function matteProject(): Project {
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: FPS, sampleRate: 48000 },
    assets: [asset('pic', picture), asset('shape', shape)],
    clips: [
      clip('c-shape', 'shape', 'v1', { matteOnly: true }),
      clip('c-pic', 'pic', 'v2', { matte: { clipId: 'c-shape' } })
    ]
  }
}

/** Mean brightness of a column strip, so left and right can be compared. */
async function strips(file: string): Promise<{ left: number; right: number }> {
  const sample = async (x: number): Promise<number> => {
    const { stdout } = await run(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-ss', '0.3', '-i', file,
       '-vf', `crop=20:20:${x}:50`, '-frames:v', '1',
       '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }
    )
    const buffer = stdout as unknown as Buffer
    let total = 0
    for (const v of buffer) total += v
    return total / buffer.length
  }
  return { left: await sample(20), right: await sample(120) }
}

describe('matte', () => {
  it('shows the picture only where the shape is bright', async () => {
    const out = join(dir, 'matted.mp4')
    const plan = buildRenderPlan({ project: matteProject(), outputPath: out })
    await run(FFMPEG, plan.args, { maxBuffer: 32 * 1024 * 1024 })

    const { left, right } = await strips(out)
    // White picture through a left-white shape: lit on the left, black on the
    // right where the base canvas shows through.
    expect(left).toBeGreaterThan(180)
    expect(right).toBeLessThan(40)
  }, 120_000)

  it('never composites the shape itself', () => {
    const plan = buildRenderPlan({ project: matteProject(), outputPath: '/tmp/x.mp4' })
    const graph = plan.args.join(' ')
    // It becomes a grey mask and is consumed by alphamerge — it must not also be
    // drawn, or it would cover the very thing it is cutting out.
    expect(graph).toContain('alphamerge')
    expect(graph).toContain('format=gray')
    expect(graph.match(/overlay=/g) ?? []).toHaveLength(1)
  })

  it('still ends the chain at vmix when the shape is the last clip', () => {
    /*
     * The chain hands its output along and the LAST composited clip must produce
     * [vmix]. Skipping a matte shape means "last" is no longer the last index —
     * get that wrong and every clip after the skip silently vanishes.
     */
    const project = matteProject()
    const reordered: Project = {
      ...project,
      tracks: project.tracks,
      clips: [
        clip('c-pic', 'pic', 'v1', { matte: { clipId: 'c-shape' } }),
        clip('c-shape', 'shape', 'v2', { matteOnly: true })
      ]
    }
    const graph = buildRenderPlan({ project: reordered, outputPath: '/tmp/x.mp4' }).args.join(' ')
    expect(graph).toContain('[vmix]')
  })

  it('refuses a timeline that is nothing but shapes, rather than rendering black', () => {
    const project = matteProject()
    const onlyShapes: Project = {
      ...project,
      clips: [clip('c-shape', 'shape', 'v1', { matteOnly: true })]
    }
    expect(() => buildRenderPlan({ project: onlyShapes, outputPath: '/tmp/x.mp4' })).toThrow(
      RenderError
    )
  })

  it('leaves an ordinary timeline untouched', () => {
    const project = matteProject()
    const plain: Project = { ...project, clips: [clip('c-pic', 'pic', 'v1')] }
    const graph = buildRenderPlan({ project: plain, outputPath: '/tmp/x.mp4' }).args.join(' ')
    expect(graph).not.toContain('alphamerge')
  })
})
