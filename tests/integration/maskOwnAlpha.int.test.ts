import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { defaultMask, type Mask } from '@shared/render/mask'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, makeColour, pixelAt, saveFrame, writeNote } from './output'

/*
 * A mask keeps the clip's own transparency.
 *
 * The shapes were multiplied into one stencil and `alphamerge` put it on the
 * clip — REPLACING its alpha. So a clip's own see-through parts went solid
 * inside any mask: the bars a fit leaves round a picture that does not fill
 * its box came out black over the track below, and a transparent PNG went
 * opaque. The clip's own alpha is the first shape now; everything multiplies
 * into it.
 */

const W = 320
const H = 180
let dir = ''
const src: Record<string, string> = {}

beforeAll(async () => {
  dir = await outputDir('mask-own-alpha')
  src.red = await makeColour(join(dir, 'source-red.mp4'), 'red', { width: W, height: H }, 1, 30)
  // 4:3 into a 16:9 canvas: fitted with transparent bars either side.
  src.blue = await makeColour(join(dir, 'source-blue-4x3.mp4'), 'blue', { width: 240, height: 180 }, 1, 30)
  // A PNG that is blue on its left half and fully transparent on its right.
  src.png = join(dir, 'source-half-transparent.png')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=blue@1:s=${W}x${H}:d=1,format=rgba`,
    '-vf', `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,${W / 2}),255,0)'`,
    '-frames:v', '1', src.png
  ])
  await writeNote(dir, [
    'A clip with a reveal mask over a red track: its own transparency must survive the mask.',
    'letterbox.png   a 4:3 blue clip in 16:9 — the side bars stay red (see-through), not black',
    'png.png         a half-transparent PNG — its transparent half stays red'
  ])
}, 120_000)

function project(top: { id: string; path: string; w: number; h: number; kind: MediaAsset['kind'] }, mask: Mask | undefined): Project {
  const asset = (id: string, path: string, w: number, h: number, kind: MediaAsset['kind']): MediaAsset => ({
    id, path, name: id, kind, durationFrames: 30, width: w, height: h, fps: kind === 'video' ? 30 : null,
    hasVideo: true, hasAudio: false, size: 1
  })
  const clip = (id: string, assetId: string, trackId: string, over: Partial<Clip> = {}): Clip => ({
    id, assetId, trackId, start: 0, duration: 15, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }, ...over
  })
  return {
    ...emptyProject(),
    settings: { ...emptyProject().settings, width: W, height: H, fps: 30 },
    assets: [asset('red', src.red, W, H, 'video'), asset(top.id, top.path, top.w, top.h, top.kind)],
    clips: [clip('bg', 'red', 'v1'), clip('top', top.id, 'v2', mask ? { mask } : {})]
  }
}

/** A reveal mask covering the whole frame: inside it, nothing about alpha should change. */
const everywhere: Mask = { ...defaultMask('reveal'), shape: { ...defaultMask('reveal').shape, kind: 'rectangle', x: 0.5, y: 0.5, width: 0.5, height: 0.5, feather: 0 } }

const kind = ([r, g, b]: number[]): string =>
  r > 180 && g < 60 && b < 60 ? 'red' : b > 180 && r < 60 && g < 60 ? 'blue' : r < 30 && g < 30 && b < 30 ? 'black' : `${r},${g},${b}`

async function render(p: Project, name: string): Promise<string> {
  const file = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: file }).args, { maxBuffer: 32 * 1024 * 1024 })
  await saveFrame(file, 0.2, join(dir, `${name}.png`))
  return file
}

describe('a mask keeps the clip’s own transparency', () => {
  it('a letterboxed clip’s bars stay see-through inside the mask', async () => {
    const top = { id: 'blue', path: src.blue, w: 240, h: 180, kind: 'video' as const }
    const plain = await render(project(top, undefined), 'letterbox-no-mask')
    const masked = await render(project(top, everywhere), 'letterbox')
    const at = async (file: string, x: number): Promise<string> => kind(await pixelAt(file, 0.2, x, 90, { width: W, height: H }))
    // Without the mask, the bar shows the red track below — the reference.
    expect(await at(plain, 10)).toBe('red')
    // With a mask that covers it, it must STILL be red — it was black.
    expect(await at(masked, 10)).toBe('red')
    expect(await at(masked, W - 10)).toBe('red')
    expect(await at(masked, W / 2)).toBe('blue')
  }, 300_000)

  it('a transparent PNG stays transparent inside the mask', async () => {
    const top = { id: 'png', path: src.png, w: W, h: H, kind: 'image' as const }
    const masked = await render(project(top, everywhere), 'png')
    expect(kind(await pixelAt(masked, 0.2, 40, 90, { width: W, height: H }))).toBe('blue')
    expect(kind(await pixelAt(masked, 0.2, W - 40, 90, { width: W, height: H }))).toBe('red')
  }, 300_000)
})
