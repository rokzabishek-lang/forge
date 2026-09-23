import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { defaultMask, type Mask } from '@shared/render/mask'
import { emptyProject, splitClip, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import type { KeyframeTracks } from '@shared/render/keyframes'
import { FFMPEG, run, outputDir, makeColour, pixelAt, saveFrame, writeNote } from './output'

/*
 * A mask that moves (FIX.md B3), rendered.
 *
 * The mask's centre and size are keyframe tracks of the clip. The export
 * compiles them into the mask's `geq` as curves of `T`, the clip's own
 * seconds. Each check reads the picture at known frames and asks where the
 * shape is.
 */

const W = 320
const H = 180
const FPS = 30
let dir = ''
const src: Record<string, string> = {}

beforeAll(async () => {
  dir = await outputDir('mask-keyframes')
  src.red = await makeColour(join(dir, 'source-red.mp4'), 'red', { width: W, height: H }, 3, FPS)
  src.blue = await makeColour(join(dir, 'source-blue.mp4'), 'blue', { width: W, height: H }, 3, FPS)
  await writeNote(dir, [
    'A blue clip over a red track, shown only inside a moving mask.',
    'move-start.png / move-end.png   the window slides from the left quarter to the right quarter',
    'late-start.png                  the same move on a clip that starts half a second in: it starts from the left',
    'iris-start.png / iris-end.png   an ellipse opening from a dot to most of the frame',
    'split-right.png                 the right half of a split clip: its window starts where the whole clip was',
    'drop-end.png                    a band keyed from the top to the bottom',
    'soft-end.png                    a soft iris: its edge softens in proportion as it opens'
  ])
}, 120_000)

/** A hard-edged window, a strip down the frame. */
const window: Mask = {
  ...defaultMask('reveal'),
  shape: { ...defaultMask('reveal').shape, kind: 'rectangle', x: 0.5, y: 0.5, width: 0.12, height: 0.5, feather: 0 }
}

function project(over: Partial<Clip>): Project {
  const asset = (id: string, path: string): MediaAsset => ({
    id, path, name: id, kind: 'video', durationFrames: 90, width: W, height: H, fps: FPS,
    hasVideo: true, hasAudio: false, size: 1
  })
  const clip = (id: string, assetId: string, trackId: string, o: Partial<Clip> = {}): Clip => ({
    id, assetId, trackId, start: 0, duration: 30, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }, ...o
  })
  return {
    ...emptyProject(),
    settings: { ...emptyProject().settings, width: W, height: H, fps: FPS },
    assets: [asset('red', src.red), asset('blue', src.blue)],
    clips: [clip('bg', 'red', 'v1', { duration: 60 }), clip('top', 'blue', 'v2', { mask: window, ...over })]
  }
}

const slide: KeyframeTracks = { maskX: [{ frame: 0, value: 0.25 }, { frame: 29, value: 0.75 }] }

const kind = ([r, g, b]: number[]): string =>
  r > 180 && g < 60 && b < 60 ? 'red' : b > 180 && r < 60 && g < 60 ? 'blue' : `${r},${g},${b}`

async function render(p: Project, name: string): Promise<string> {
  const file = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: file }).args, { maxBuffer: 32 * 1024 * 1024 })
  return file
}

/**
 * Frame `n` of the timeline.
 *
 * A quarter of a frame BEFORE it, because `-ss` hands back the first frame at
 * or after the time asked: the middle of a clip's last frame is past it, and
 * came back as the track underneath.
 */
const at = async (file: string, frame: number, x: number): Promise<string> =>
  kind(await pixelAt(file, Math.max(0, (frame - 0.25) / FPS), x, H / 2, { width: W, height: H }))

describe('a mask that moves', () => {
  it('slides where its keys say, frame by frame', async () => {
    const file = await render(project({ keyframes: slide }), 'move')
    await saveFrame(file, 0.5 / FPS, join(dir, 'move-start.png'))
    await saveFrame(file, 28.5 / FPS, join(dir, 'move-end.png'))
    // Frame 0: centred at a quarter (x=80).
    expect(await at(file, 0, 80)).toBe('blue')
    expect(await at(file, 0, 240)).toBe('red')
    // Half-way: centred on the middle.
    expect(await at(file, 15, 160)).toBe('blue')
    expect(await at(file, 15, 80)).toBe('red')
    // The end: three quarters across.
    expect(await at(file, 29, 240)).toBe('blue')
    expect(await at(file, 29, 80)).toBe('red')
  }, 300_000)

  it('runs on the clip’s own time, not the timeline’s', async () => {
    // Half a second into the edit and a second into its file: the move still
    // begins at the clip's first frame.
    const file = await render(project({ keyframes: slide, start: 15, inPoint: 30 }), 'late')
    await saveFrame(file, 15.5 / FPS, join(dir, 'late-start.png'))
    expect(await at(file, 15, 80)).toBe('blue')
    expect(await at(file, 15, 240)).toBe('red')
    expect(await at(file, 44, 240)).toBe('blue')
  }, 300_000)

  it('grows: an iris opening from a dot', async () => {
    const iris: Mask = { ...window, shape: { ...window.shape, kind: 'ellipse', width: 0.02, height: 0.02 } }
    const keyframes: KeyframeTracks = {
      maskWidth: [{ frame: 0, value: 0.02 }, { frame: 29, value: 0.45 }],
      maskHeight: [{ frame: 0, value: 0.02 }, { frame: 29, value: 0.45 }]
    }
    const file = await render(project({ mask: iris, keyframes }), 'iris')
    await saveFrame(file, 0.5 / FPS, join(dir, 'iris-start.png'))
    await saveFrame(file, 28.5 / FPS, join(dir, 'iris-end.png'))
    expect(await at(file, 0, 160)).toBe('blue')
    expect(await at(file, 0, 200)).toBe('red')
    expect(await at(file, 29, 200)).toBe('blue')
  }, 300_000)

  it('moves up and down as well as across', async () => {
    const band: Mask = { ...window, shape: { ...window.shape, width: 0.5, height: 0.1 } }
    const keyframes: KeyframeTracks = { maskY: [{ frame: 0, value: 0.2 }, { frame: 29, value: 0.8 }] }
    const file = await render(project({ mask: band, keyframes }), 'drop')
    await saveFrame(file, 28.5 / FPS, join(dir, 'drop-end.png'))
    const atY = async (frame: number, y: number): Promise<string> =>
      kind(await pixelAt(file, Math.max(0, (frame - 0.25) / FPS), W / 2, y, { width: W, height: H }))
    expect(await atY(0, 36)).toBe('blue')
    expect(await atY(0, 144)).toBe('red')
    expect(await atY(29, 144)).toBe('blue')
    expect(await atY(29, 36)).toBe('red')
  }, 300_000)

  it('a soft edge scales with the size it is keyed to', async () => {
    // Feather is a fraction of the radius: as the iris opens, its soft band
    // widens with it. Half-way out from the centre of the open iris is inside
    // the soft band, so the blue is only part-way over the red there.
    const soft: Mask = { ...window, shape: { ...window.shape, kind: 'ellipse', width: 0.02, height: 0.02, feather: 0.6 } }
    const keyframes: KeyframeTracks = {
      maskWidth: [{ frame: 0, value: 0.02 }, { frame: 29, value: 0.4 }],
      maskHeight: [{ frame: 0, value: 0.02 }, { frame: 29, value: 0.4 }]
    }
    const file = await render(project({ mask: soft, keyframes }), 'soft')
    await saveFrame(file, 28.5 / FPS, join(dir, 'soft-end.png'))
    // 0.4·W = 128 px of half-width; 0.7 of the radius out is in the soft band.
    const [r, , b] = await pixelAt(file, 28.75 / FPS, W / 2 + Math.round(0.7 * 128), H / 2, { width: W, height: H })
    expect(r, `r ${r} b ${b}`).toBeGreaterThan(40)
    expect(b, `r ${r} b ${b}`).toBeGreaterThan(40)
  }, 300_000)

  it('the right half of a split starts where the whole clip had got to', async () => {
    const whole = project({ keyframes: slide }).clips[1]
    const [, right] = splitClip(whole, 15)!
    const p = project({})
    const file = await render({ ...p, clips: [p.clips[0], right] }, 'split')
    await saveFrame(file, 15.5 / FPS, join(dir, 'split-right.png'))
    // At the cut the window is in the middle, not back at the left quarter.
    expect(await at(file, 15, 160)).toBe('blue')
    expect(await at(file, 15, 80)).toBe('red')
    expect(await at(file, 29, 240)).toBe('blue')
  }, 300_000)
})
