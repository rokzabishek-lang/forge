import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { defaultMask, type Mask } from '@shared/render/mask'

/*
 * Masks, rendered.
 *
 * Three routes to "an effect only inside this shape" were measured before one
 * was chosen, and two of them are wrong in ways no unit test would ever show:
 * `overlay` onto a half-transparent source returns a fully opaque region, and
 * `maskedmerge` mangles chroma on subsampled input. These tests render real
 * frames and read the pixels, because that is the only thing that caught it.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const W = 160
const H = 120

let dir = ''
let red = ''
let stripes = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-mask-'))
  red = join(dir, 'red.png')
  stripes = join(dir, 'stripes.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:size=320x240:rate=1:duration=1',
    '-frames:v', '1', red])
  // Hard vertical bars: a blur has something unmistakable to average away.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:size=320x240:rate=1:duration=1',
    '-vf', "format=rgb24,geq=r='if(lt(mod(X,32),16),255,0)':g='0':b='0'",
    '-frames:v', '1', stripes])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function maskedProject(
  source: string,
  mask: Mask | undefined,
  color = { brightness: 0, contrast: 1, saturation: 1 }
): Project {
  const asset: MediaAsset = {
    id: 'img', path: source, name: 'src.png', kind: 'image', durationFrames: 12,
    width: 320, height: 240, fps: 12, hasVideo: true, hasAudio: false, size: 0
  }
  const clip: Clip = {
    id: 'c1', assetId: 'img', trackId: 'v1', start: 0, duration: 12, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'cover' },
    color,
    mask
  }
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: 12, sampleRate: 48000 },
    assets: [asset],
    clips: [clip]
  }
}

async function render(project: Project): Promise<string> {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.mp4`)
  const plan = buildRenderPlan({ project, outputPath: out })
  await run(FFMPEG, plan.args, { maxBuffer: 32 * 1024 * 1024 })
  return out
}

/** One pixel, as RGB. */
async function pixel(file: string, x: number, y: number): Promise<[number, number, number]> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-i', file,
     '-vf', `crop=2:2:${x}:${y}`, '-frames:v', '1',
     '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }
  )
  const b = stdout as unknown as Buffer
  return [b[0], b[1], b[2]]
}

/** The red channel straight across a row — flat means it has been blurred. */
async function rowSpread(file: string, y: number): Promise<number> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-i', file,
     // Two rows, not one: yuv420p subsamples chroma vertically, so an odd crop
     // height rounds down to zero and ffmpeg refuses the filter outright.
     '-vf', `crop=64:2:48:${y}`, '-frames:v', '1',
     '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }
  )
  const b = stdout as unknown as Buffer
  const reds: number[] = []
  for (let i = 0; i < 64 * 3; i += 3) reds.push(b[i])
  return Math.max(...reds) - Math.min(...reds)
}

describe('masks', () => {
  it('costs nothing when there is no mask', () => {
    const plan = buildRenderPlan({ project: maskedProject(red, undefined), outputPath: '/x.mp4' })
    const graph = plan.args.join(' ')
    expect(graph).not.toContain('gblur')
    expect(graph).not.toContain('alphaextract')
  })

  it('costs nothing when the blur amount is zero', () => {
    const mask = { ...defaultMask('blur'), blur: 0 }
    const plan = buildRenderPlan({ project: maskedProject(red, mask), outputPath: '/x.mp4' })
    expect(plan.args.join(' ')).not.toContain('gblur')
  })

  describe('reveal', () => {
    it('keeps the picture inside the shape and drops it outside', async () => {
      const mask: Mask = {
        ...defaultMask('reveal'),
        shape: { ...defaultMask().shape, width: 0.3, height: 0.3, feather: 0.05 }
      }
      const file = await render(maskedProject(red, mask))
      const [insideR] = await pixel(file, W / 2, H / 2)
      const [outsideR, outsideG, outsideB] = await pixel(file, 4, 4)
      expect(insideR).toBeGreaterThan(180)
      // Outside falls through to the black canvas underneath.
      expect(outsideR + outsideG + outsideB).toBeLessThan(60)
    }, 180_000)

    it('inverts, so the shape becomes the hole', async () => {
      const mask: Mask = {
        ...defaultMask('reveal'),
        shape: { ...defaultMask().shape, width: 0.3, height: 0.3, feather: 0.05, invert: true }
      }
      const file = await render(maskedProject(red, mask))
      const [centreR, centreG, centreB] = await pixel(file, W / 2, H / 2)
      const [cornerR] = await pixel(file, 4, 4)
      expect(centreR + centreG + centreB).toBeLessThan(60)
      expect(cornerR).toBeGreaterThan(180)
    }, 180_000)
  })

  /*
   * The mask belongs to the clip, not to the frame.
   *
   * By the time a mask is applied the clip has been fitted to its BOX, and a
   * picture-in-picture's box is smaller than the canvas. A mask built at canvas
   * size is the wrong size for every one of them — it either covers the whole
   * PiP or fails the graph outright on a size mismatch. This is that case.
   */
  it('sizes itself to a picture-in-picture, not to the canvas', async () => {
    const project = maskedProject(red, {
      ...defaultMask('reveal'),
      shape: { ...defaultMask().shape, width: 0.3, height: 0.3, feather: 0.05 }
    })
    // Half scale: an 80x60 box in the middle of a 160x120 canvas.
    project.clips[0].transform = { ...project.clips[0].transform, scale: 0.5, scaleY: 0.5 }
    const file = await render(project)

    const [centreR] = await pixel(file, W / 2, H / 2)
    // Inside the PiP but outside the shape: the ellipse is 30% of the BOX, so
    // it reaches x=56..104. At x=46 we are still on the clip and must be clear.
    const [edgeR, edgeG, edgeB] = await pixel(file, 46, H / 2)
    expect(centreR).toBeGreaterThan(180)
    expect(edgeR + edgeG + edgeB, 'the shape should not cover the whole PiP').toBeLessThan(60)
  }, 180_000)

  describe('blur', () => {
    /*
     * The bars are 16 source pixels wide, 8 on the canvas. Inside the shape a
     * blur flattens them; outside they have to stay as sharp as they arrived,
     * or the mask is not confining anything.
     */
    it('flattens detail inside the shape and leaves it alone outside', async () => {
      const mask: Mask = {
        ...defaultMask('blur'),
        blur: 40,
        shape: { ...defaultMask().shape, width: 0.35, height: 0.35, feather: 0.1 }
      }
      const file = await render(maskedProject(stripes, mask))
      const inside = await rowSpread(file, Math.round(H / 2))
      const outside = await rowSpread(file, 4)
      expect(outside, `bars outside should survive, spread was ${outside}`).toBeGreaterThan(120)
      expect(inside, `bars inside should be blurred away, spread was ${inside}`).toBeLessThan(60)
    }, 180_000)

    it('over the whole picture, blurs everywhere without drawing a shape — the Director’s backdrop, ten times cheaper', async () => {
      const mask: Mask = {
        ...defaultMask('blur'),
        blur: 40,
        // The default shape is an ellipse; only an upright, hard rectangle over everything is "the whole picture".
        shape: { ...defaultMask().shape, kind: 'rectangle', x: 0.5, y: 0.5, width: 0.5, height: 0.5, feather: 0, rotation: 0, invert: false }
      }
      const project = maskedProject(stripes, mask)
      const graph = buildRenderPlan({ project, outputPath: '/x.mp4' }).args.join(' ')
      expect(graph).toContain('gblur')
      expect(graph).not.toContain('geq=')
      const file = await render(project)
      expect(await rowSpread(file, Math.round(H / 2))).toBeLessThan(60)
      expect(await rowSpread(file, 4)).toBeLessThan(60)
      // Feathered, turned, inverted or short of an edge, the shape is drawn as ever.
      for (const shape of [{ feather: 0.1 }, { rotation: 10 }, { invert: true }, { width: 0.45 }]) {
        const shaped = buildRenderPlan({ project: maskedProject(stripes, { ...mask, shape: { ...mask.shape, ...shape } }), outputPath: '/x.mp4' }).args.join(' ')
        expect(shaped, JSON.stringify(shape)).toContain('geq=')
      }
    }, 180_000)

    it('inverted, blurs the background and keeps the middle sharp', async () => {
      const mask: Mask = {
        ...defaultMask('blur'),
        blur: 40,
        shape: { ...defaultMask().shape, width: 0.35, height: 0.35, feather: 0.1, invert: true }
      }
      const file = await render(maskedProject(stripes, mask))
      const inside = await rowSpread(file, Math.round(H / 2))
      const outside = await rowSpread(file, 4)
      expect(inside).toBeGreaterThan(120)
      expect(outside).toBeLessThan(60)
    }, 180_000)
  })

  describe('grade', () => {
    /*
     * The Power Window: the clip's own colour controls, confined to a region.
     * The grade has to come OUT of the main chain to do this — if it were still
     * applied to the whole picture the corner would be grey too.
     */
    it('applies the clip colour only inside the shape', async () => {
      const mask: Mask = {
        ...defaultMask('grade'),
        shape: { ...defaultMask().shape, width: 0.3, height: 0.3, feather: 0.05 }
      }
      const file = await render(
        maskedProject(red, mask, { brightness: 0, contrast: 1, saturation: 0 })
      )
      const [inR, inG, inB] = await pixel(file, W / 2, H / 2)
      const [outR, , outB] = await pixel(file, 4, 4)
      // Inside: desaturated, so the channels converge.
      expect(Math.max(inR, inG, inB) - Math.min(inR, inG, inB)).toBeLessThan(24)
      // Outside: still red, untouched.
      expect(outR).toBeGreaterThan(180)
      expect(outB).toBeLessThan(70)
    }, 180_000)
  })
})
