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
 * A clip sticker on the timeline.
 *
 * H.264 4:2:0 cannot carry an alpha channel, so a keyed cut-out ships as a PAIR
 * — a colour video whose RGB still holds the green background, and a greyscale
 * matte holding the alpha. Get this wrong and the sticker renders as a green
 * rectangle sitting on the shot, which is exactly what it looks like when the
 * matte is ignored.
 *
 * The matte is on the ASSET, not the clip: it is a property of the file. The
 * existing `clip.matte` points at another clip on the timeline and is a
 * different feature.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const W = 160
const H = 120
const FPS = 10
const FRAMES = 10

let dir = ''
let background = ''
let colour = ''
let matte = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-sticker-'))
  background = join(dir, 'bg.png')
  colour = join(dir, 'colour.mp4')
  matte = join(dir, 'matte.mp4')

  // A blue background, so anything green that survives is unmistakable.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:size=160x120:rate=1:duration=1', '-frames:v', '1', background])

  /*
   * The colour half: red on the LEFT, green on the right — the shape of a real
   * sticker, where the subject is surrounded by the green that was keyed. If
   * the matte is dropped, that green reaches the output.
   */
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x00FE00:size=160x120:rate=10:duration=1',
    '-vf', 'drawbox=x=0:y=0:w=80:h=120:color=red:t=fill',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', colour])

  // The matte: white over the subject, black over the green.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:size=160x120:rate=10:duration=1',
    '-vf', 'drawbox=x=0:y=0:w=80:h=120:color=white:t=fill',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', matte])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function stickerAsset(): MediaAsset {
  return {
    id: 'sticker', path: colour, name: 'sticker', kind: 'video', durationFrames: FRAMES,
    width: 160, height: 120, fps: FPS, hasVideo: true, hasAudio: false, size: 0,
    matte
  }
}

function bgAsset(): MediaAsset {
  return {
    id: 'bg', path: background, name: 'bg', kind: 'image', durationFrames: FRAMES,
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

function stickerProject(): Project {
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: FPS, sampleRate: 48000 },
    assets: [bgAsset(), stickerAsset()],
    clips: [clip('c-bg', 'bg', 'v1'), clip('c-sticker', 'sticker', 'v2')]
  }
}

/** Mean R, G and B of a small patch, so a colour can be named rather than guessed. */
async function patch(file: string, x: number): Promise<{ r: number; g: number; b: number }> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', '0.3', '-i', file,
     '-vf', `crop=20:20:${x}:50`, '-frames:v', '1',
     '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }
  )
  const buffer = stdout as unknown as Buffer
  let r = 0, g = 0, b = 0
  const n = buffer.length / 3
  for (let i = 0; i < n; i++) { r += buffer[i * 3]; g += buffer[i * 3 + 1]; b += buffer[i * 3 + 2] }
  return { r: r / n, g: g / n, b: b / n }
}

describe('a clip sticker', () => {
  it('shows the subject and hides the green it was keyed from', async () => {
    const out = join(dir, 'sticker.mp4')
    const plan = buildRenderPlan({ project: stickerProject(), outputPath: out })
    await run(FFMPEG, plan.args, { maxBuffer: 32 * 1024 * 1024 })

    const subject = await patch(out, 20)
    const behind = await patch(out, 120)

    // Left: the sticker's red subject, over the blue background.
    expect(subject.r).toBeGreaterThan(140)
    expect(subject.g).toBeLessThan(80)

    /*
     * Right: the blue background, NOT the sticker's green.
     *
     * This is the assertion the whole feature rests on. Without the matte the
     * patch reads green (g high, b low) and the sticker is a coloured rectangle
     * pasted over the shot.
     */
    expect(behind.b).toBeGreaterThan(140)
    expect(behind.g).toBeLessThan(80)
  }, 120_000)

  it('feeds the matte through alphamerge as a grey stencil', () => {
    const graph = buildRenderPlan({ project: stickerProject(), outputPath: '/tmp/x.mp4' }).args.join(' ')
    expect(graph).toContain('alphamerge')
    expect(graph).toContain('format=gray')
    // The matte file is an INPUT, never something composited on its own: two
    // visible clips means two overlays, and a third would be the matte being
    // pasted over the very thing it is cutting out.
    expect(graph).toContain(`-i ${matte}`)
    expect(graph.match(/overlay=/g) ?? []).toHaveLength(2)
  })

  it('seeks the matte exactly like the colour it belongs to', () => {
    /*
     * A matte running at its own pace is a cut-out sliding off its subject,
     * which reads as a broken key rather than a timing bug. Trimmed in, both
     * streams have to start at the same instant.
     */
    const project = stickerProject()
    const trimmed: Project = {
      ...project,
      clips: [clip('c-bg', 'bg', 'v1'), clip('c-sticker', 'sticker', 'v2', { inPoint: 3, duration: 4 })]
    }
    const args = buildRenderPlan({ project: trimmed, outputPath: '/tmp/x.mp4' }).args
    // `-ss S -t T -i FILE`: from the `-i`, the flag is four back and its value
    // three back.
    const seeks = args
      .map((a, i) => (a === '-i' ? { file: args[i + 1], ss: args[i - 4] === '-ss' ? args[i - 3] : null } : null))
      .filter((x): x is { file: string; ss: string | null } => x !== null)
    const colourSeek = seeks.find((s) => s.file === colour)
    const matteSeek = seeks.find((s) => s.file === matte)
    expect(colourSeek?.ss).toBeTruthy()
    expect(matteSeek?.ss).toBe(colourSeek?.ss)
  })

  it('leaves an asset with no matte completely alone', () => {
    const project = stickerProject()
    const plain: Project = {
      ...project,
      assets: [bgAsset(), { ...stickerAsset(), matte: undefined }]
    }
    const graph = buildRenderPlan({ project: plain, outputPath: '/tmp/x.mp4' }).args.join(' ')
    expect(graph).not.toContain(matte)
    expect(graph).not.toContain('alphamerge')
  })
})
