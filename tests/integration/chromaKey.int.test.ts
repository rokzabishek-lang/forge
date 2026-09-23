import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import {
  chromaDistance,
  despillPixel,
  keyAlpha,
  keyChroma,
  pixelChroma,
  type ChromaKey
} from '@shared/render/chromaKey'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, makeColour, pixelAt, saveFrame, writeNote } from './output'

/*
 * Chroma key (FIX.md B3), rendered and measured.
 *
 * First the model: render.chromaKey.ts writes ffmpeg's keying arithmetic down so
 * the preview's shader can key the same pixels. This runs ffmpeg's own
 * `chromakey` over patches of known colour and checks the model predicts every
 * alpha. Then the plan: a green-screen clip over a blue track keys to blue,
 * keeps its subject, keeps its own transparency, and loses its green fringe.
 */

const S = 32
const PATCHES = ['00ff00', '00e000', '20ff20', '40c040', '808080', 'ff0000', '0000ff', 'ffffff',
  '000000', '00ff80', '80ff00', '40a060', '2080ff', 'ffe0c0', '30b030', '00c800', '00b140', '10a050']
let dir = ''

beforeAll(async () => {
  dir = await outputDir('chroma-key')
  await writeNote(dir, [
    'Chroma key, rendered.',
    'keyed.png       a green screen with a red subject over a blue track: blue where the green was',
    'letterbox.png   the same clip letterboxed: the bars stay see-through',
    'despill.png     a green-spilled grey, despilled'
  ])
}, 120_000)

/** One row of patches through yuv420p and `vf`, read back as rawvideo. */
async function patches(vf: string, pixFmt: 'yuv420p' | 'yuva420p'): Promise<Buffer> {
  const draws = PATCHES.map((c, i) => `drawbox=x=${i * S}:y=0:w=${S}:h=${S}:color=0x${c}:t=fill`).join(',')
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${PATCHES.length * S}x${S}:d=1`,
      '-vf', `${draws},format=yuv420p,${vf}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', pixFmt, '-'],
    { encoding: 'buffer', maxBuffer: 1 << 24 }
  )
  return stdout as unknown as Buffer
}

describe('the keying model is ffmpeg’s arithmetic', () => {
  const W = PATCHES.length * S
  const centre = (i: number): number => i * S + S / 2

  it('reads a picture’s chroma the way the stream carries it', async () => {
    const yuv = await patches('null', 'yuv420p')
    const uAt = (x: number): number => yuv[W * S + (S / 4) * (W / 2) + Math.floor(x / 2)]
    const vAt = (x: number): number => yuv[W * S + (W / 2) * (S / 2) + (S / 4) * (W / 2) + Math.floor(x / 2)]
    PATCHES.forEach((hex, i) => {
      const [r, g, b] = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
      const [u, v] = pixelChroma(r, g, b)
      expect(Math.abs(u - uAt(centre(i))), `${hex} U`).toBeLessThanOrEqual(1)
      expect(Math.abs(v - vAt(centre(i))), `${hex} V`).toBeLessThanOrEqual(1)
    })
  }, 120_000)

  for (const [color, similarity, blend] of [['#00ff00', 0.1, 0], ['#00ff00', 0.1, 0.1], ['#00ff00', 0.2, 0.05], ['#00b140', 0.12, 0.08], ['#0000ff', 0.15, 0.1]] as const) {
    it(`predicts every alpha — key ${color}, similarity ${similarity}, blend ${blend}`, async () => {
      const out = await patches(`chromakey=color=0x${color.slice(1)}:similarity=${similarity}:blend=${blend}`, 'yuva420p')
      const alphaAt = (x: number): number => out[W * S + 2 * (W / 2) * (S / 2) + (S / 2) * W + x]
      const k = keyChroma(color)
      PATCHES.forEach((hex, i) => {
        const [r, g, b] = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
        const [u, v] = pixelChroma(r, g, b)
        const predicted = keyAlpha(chromaDistance(u, v, k), similarity, blend)
        // A level of chroma rounding moves a soft edge by a few steps of alpha.
        expect(Math.abs(predicted - alphaAt(centre(i))), `${hex}: model ${predicted}, ffmpeg ${alphaAt(centre(i))}`).toBeLessThanOrEqual(4)
      })
    }, 120_000)
  }
})

/* ------------------------------------------------------------ the plan */

const W = 320
const H = 180
const kind = ([r, g, b]: number[]): string =>
  b > 150 && r < 90 && g < 90 ? 'blue' : r > 150 && g < 90 && b < 90 ? 'red' : g > 120 && r < 90 && b < 110 ? 'green' : `${r},${g},${b}`

async function greenScreen(width: number, height: number, name: string): Promise<string> {
  const file = join(dir, name)
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x00b140:s=${width}x${height}:d=1`,
    '-vf', `drawbox=x=${width / 2 - 30}:y=${height / 2 - 30}:w=60:h=60:color=red:t=fill`, '-frames:v', '1', file
  ])
  return file
}

function project(screenPath: string, size: { w: number; h: number }, key: ChromaKey | undefined, blue: string): Project {
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
    assets: [asset('blue', blue, W, H, 'video'), asset('screen', screenPath, size.w, size.h, 'image')],
    clips: [clip('bg', 'blue', 'v1'), clip('top', 'screen', 'v2', key ? { key } : {})]
  }
}

async function render(p: Project, name: string): Promise<string> {
  const file = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: file }).args, { maxBuffer: 32 * 1024 * 1024 })
  await saveFrame(file, 0.2, join(dir, `${name}.png`))
  return file
}

const key: ChromaKey = { color: '#00b140', similarity: 0.12, blend: 0.08, despill: 0.6 }

describe('a keyed clip, rendered', () => {
  it('shows the track below where the screen was, and keeps its subject', async () => {
    const blue = await makeColour(join(dir, 'source-blue.mp4'), 'blue', { width: W, height: H }, 1, 30)
    const screen = await greenScreen(W, H, 'source-screen.png')
    const plain = await render(project(screen, { w: W, h: H }, undefined, blue), 'unkeyed')
    const keyed = await render(project(screen, { w: W, h: H }, key, blue), 'keyed')
    const at = (file: string, x: number, y: number): Promise<[number, number, number]> =>
      pixelAt(file, 0.2, x, y, { width: W, height: H })
    expect(kind(await at(plain, 20, 20))).toBe('green')
    expect(kind(await at(keyed, 20, 20))).toBe('blue')
    expect(kind(await at(keyed, W - 20, H - 20))).toBe('blue')
    expect(kind(await at(keyed, W / 2, H / 2))).toBe('red')
  }, 300_000)

  it('keeps a letterboxed clip’s bars see-through while keying', async () => {
    const blue = await makeColour(join(dir, 'source-blue-2.mp4'), 'blue', { width: W, height: H }, 1, 30)
    const narrow = await greenScreen(240, 180, 'source-screen-4x3.png')
    const keyed = await render(project(narrow, { w: 240, h: 180 }, key, blue), 'letterbox')
    expect(kind(await pixelAt(keyed, 0.2, 10, 90, { width: W, height: H }))).toBe('blue')
    expect(kind(await pixelAt(keyed, 0.2, W / 2, H / 2, { width: W, height: H }))).toBe('red')
  }, 300_000)

  it('takes the screen’s colour out of what is left, as the model says', async () => {
    // A warm grey with green spill, red and blue DIFFERENT so the mix between
    // them is measured too, and a narrow key so it is kept whole.
    const spill = join(dir, 'source-spill.png')
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x96a06e:s=${W}x${H}:d=1`, '-frames:v', '1', spill])
    const blue = await makeColour(join(dir, 'source-blue-3.mp4'), 'blue', { width: W, height: H }, 1, 30)
    const narrow: ChromaKey = { ...key, similarity: 0.05, blend: 0.02 }
    const before = await pixelAt(await render(project(spill, { w: W, h: H }, { ...narrow, despill: 0 }, blue), 'spill-kept'), 0.2, W / 2, H / 2, { width: W, height: H })
    const after = await pixelAt(await render(project(spill, { w: W, h: H }, { ...narrow, despill: 1 }, blue), 'despill'), 0.2, W / 2, H / 2, { width: W, height: H })
    // Red and blue really do differ here, or the mix is not being tested.
    expect(Math.abs(before[0] - before[2])).toBeGreaterThan(20)
    const want = despillPixel(before[0], before[1], before[2], { ...narrow, despill: 1 })
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(after[c] - want[c]), `channel ${'rgb'[c]}: got ${after[c]}, want ${want[c].toFixed(1)}`).toBeLessThanOrEqual(5)
    }
    expect(after[1]).toBeLessThan(before[1] - 5)
  }, 300_000)
})
