import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type ColorAdjust, type MediaAsset, type Project } from '@shared/timeline'
import type { ChromaKey } from '@shared/render/chromaKey'
import { FFMPEG, run, outputDir, makeColour, pixelAt, saveFrame, writeNote, keyScale } from './output'

/*
 * A grade keeps the clip's own transparency.
 *
 * ffmpeg's `eq` takes no format with an alpha plane, so ffmpeg converts in
 * front of it and every transparent pixel came out opaque — measured: alpha 0
 * in, 255 out. Brightness, contrast or saturation on a clip that does not fill
 * its box turned the see-through bars black over the track below, a sticker
 * became its rectangle, and a keyed clip lost its bars the same way. White
 * balance (colorchannelmixer), curves, looks and despill all keep alpha; only
 * `eq` did not.
 *
 * Two more in the same family, found while measuring it: a keyframed opacity
 * wrote its value OVER the clip's alpha instead of multiplying into it, and a
 * keyed clip that was turned failed the whole export — its key was a late
 * stencil the size of the box, meeting a picture already grown by the turn.
 */

const W = 320
const H = 180
let dir = ''
const src: Record<string, string> = {}

beforeAll(async () => {
  dir = await outputDir('grade-alpha')
  src.red = await makeColour(join(dir, 'source-red.mp4'), 'red', { width: W, height: H }, 1, 30)
  // 4:3 into a 16:9 canvas: fitted with transparent bars either side.
  src.blue = await makeColour(join(dir, 'source-blue-4x3.mp4'), 'blue', { width: 240, height: 180 }, 1, 30)
  // Blue on its left half, fully transparent on its right.
  src.png = join(dir, 'source-half-transparent.png')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=blue@1:s=${W}x${H}:d=1,format=rgba`,
    '-vf', `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,${W / 2}),255,0)'`,
    '-frames:v', '1', src.png
  ])
  // A 4:3 green screen with a white subject — keyed AND graded.
  src.screen = join(dir, 'source-screen-4x3.png')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00b140:s=240x180:d=1',
    '-vf', 'drawbox=x=90:y=60:w=60:h=60:color=white:t=fill', '-frames:v', '1', src.screen
  ])
  await writeNote(dir, [
    'Graded clips over a red track: their own transparency must survive the grade.',
    'letterbox.png   a 4:3 blue clip, brightened — the side bars stay red, not black',
    'png.png         a half-transparent PNG with contrast — its transparent half stays red',
    'keyed.png       a keyed, brightened 4:3 screen — red where the screen and the bars were',
    'fade.png        a 4:3 clip at a keyframed 50% — the bars stay red, the middle is half blue',
    'turned.png      a keyed screen, shrunk and turned 10° — it renders, keyed, subject kept'
  ])
}, 120_000)

type Top = { id: string; path: string; w: number; h: number; kind: MediaAsset['kind'] }

function project(top: Top, color: ColorAdjust, key?: ChromaKey, over: Partial<Clip> = {}): Project {
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
    clips: [clip('bg', 'red', 'v1'), clip('top', top.id, 'v2', { color, ...(key ? { key } : {}), ...over })]
  }
}

const kind = ([r, g, b]: number[]): string =>
  r > 180 && g < 60 && b < 60 ? 'red'
    : b > 180 && r < 70 && g < 70 ? 'blue'
      : r > 200 && g > 200 && b > 200 ? 'white'
        : r < 30 && g < 30 && b < 30 ? 'black'
          : `${r},${g},${b}`

async function render(p: Project, name: string): Promise<string> {
  const file = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: file, keyScale: await keyScale() }).args, { maxBuffer: 32 * 1024 * 1024 })
  await saveFrame(file, 0.2, join(dir, `${name}.png`))
  return file
}

const at = async (file: string, x: number, y = H / 2): Promise<string> =>
  kind(await pixelAt(file, 0.2, x, y, { width: W, height: H }))

describe('a grade keeps the clip’s own transparency', () => {
  it('a brightened letterboxed clip’s bars stay see-through', async () => {
    const top = { id: 'blue', path: src.blue, w: 240, h: 180, kind: 'video' as const }
    const graded = await render(project(top, { brightness: 0.1, contrast: 1, saturation: 1 }), 'letterbox')
    expect(await at(graded, 10)).toBe('red')
    expect(await at(graded, W - 10)).toBe('red')
    expect(await at(graded, W / 2)).toBe('blue')
  }, 300_000)

  it('a transparent PNG with contrast and saturation stays transparent', async () => {
    const top = { id: 'png', path: src.png, w: W, h: H, kind: 'image' as const }
    const graded = await render(project(top, { brightness: 0, contrast: 1.2, saturation: 1.3 }), 'png')
    expect(await at(graded, 40)).toBe('blue')
    expect(await at(graded, W - 40)).toBe('red')
  }, 300_000)

  it('a keyed, graded clip loses its screen AND keeps its bars', async () => {
    const top = { id: 'screen', path: src.screen, w: 240, h: 180, kind: 'image' as const }
    const key: ChromaKey = { color: '#00b140', similarity: 0.12, blend: 0.08, despill: 0.6 }
    const keyed = await render(project(top, { brightness: 0.05, contrast: 1.1, saturation: 1, temperature: 0.3 }, key), 'keyed')
    expect(await at(keyed, 10)).toBe('red') // the bar
    expect(await at(keyed, 60)).toBe('red') // the screen
    expect(await at(keyed, W / 2)).toBe('white') // the subject
  }, 300_000)
})

describe('and so do an opacity keyframe and a turn', () => {
  const neutral: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1 }

  it('a keyframed opacity multiplies into the clip’s alpha — the bars stay see-through', async () => {
    const top = { id: 'blue', path: src.blue, w: 240, h: 180, kind: 'video' as const }
    // Keyframed, so it takes the geq path; held at half so the mix can be read.
    const keyframes = { opacity: [{ frame: 0, value: 0.5 }, { frame: 14, value: 0.5 }] } as Clip['keyframes']
    const faded = await render(project(top, neutral, undefined, { keyframes }), 'fade')
    expect(await at(faded, 10)).toBe('red')
    expect(await at(faded, W - 10)).toBe('red')
    // And the fade itself still applies: half blue over red.
    const [r, g, b] = await pixelAt(faded, 0.2, W / 2, H / 2, { width: W, height: H })
    expect(r, `${r},${g},${b}`).toBeGreaterThan(95)
    expect(r).toBeLessThan(160)
    expect(b).toBeGreaterThan(95)
    expect(b).toBeLessThan(160)
  }, 300_000)

  it('a keyed clip can be turned: it renders, keyed, with its subject', async () => {
    const top = { id: 'screen', path: src.screen, w: 240, h: 180, kind: 'image' as const }
    const key: ChromaKey = { color: '#00b140', similarity: 0.12, blend: 0.08, despill: 0.6 }
    const turned = await render(
      project(top, neutral, key, { transform: { x: 0, y: 0, scale: 0.9, rotation: 10, opacity: 1 } }),
      'turned'
    )
    expect(await at(turned, 60)).toBe('red') // the screen
    expect(await at(turned, 10)).toBe('red') // outside the turned box
    expect(await at(turned, W / 2)).toBe('white') // the subject
  }, 300_000)
})
