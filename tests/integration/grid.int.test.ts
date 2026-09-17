import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { DEFAULT_GRID, type GridSpec } from '@shared/render/grid'
import { gridClips, planGridSplit, type Arrival } from '@shared/automation/grid'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * The grid, rendered.
 *
 * Everything in tests/grid.test.ts checks the arithmetic against itself, which
 * is worth having and proves nothing about what comes out of ffmpeg. These
 * tests render real frames and look at the pixels, because the two questions
 * that matter cannot be answered any other way:
 *
 *  - do the pieces put the photograph back together, in the right places?
 *  - is there a seam?
 *
 * A one-pixel gap between two halves of the same picture is invisible in every
 * unit test and a black line down the middle of the frame on screen.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path

const W = 216
const H = 384
const CANVAS = { width: W, height: H }

let dir = ''
let quadrants = ''
let stripes = ''

/** Top-left red, top-right green, bottom-left blue, bottom-right white. */
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-grid-'))
  quadrants = join(dir, 'quadrants.png')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${W * 2}x${H * 2}`,
    '-vf',
    [
      `drawbox=x=0:y=0:w=${W}:h=${H}:color=red@1:t=fill`,
      `drawbox=x=${W}:y=0:w=${W}:h=${H}:color=lime@1:t=fill`,
      `drawbox=x=0:y=${H}:w=${W}:h=${H}:color=blue@1:t=fill`,
      `drawbox=x=${W}:y=${H}:w=${W}:h=${H}:color=white@1:t=fill`
    ].join(','),
    '-frames:v', '1', quadrants
  ])

  /*
   * A second fixture, with fine detail in it.
   *
   * Four flat colours cannot tell you whether a piece is showing the right part
   * of itself at the right size: squash a solid red rectangle and centre-crop
   * it and you still have solid red. A regularly striped picture can — count
   * the stripes and the magnification is not a matter of opinion. The first
   * version of the pop-in test used the flat fixture and passed against a
   * deliberately reintroduced bug.
   */
  stripes = join(dir, 'stripes.png')
  const bars = Array.from({ length: 24 }, (_, i) =>
    `drawbox=x=${i * 24}:y=0:w=12:h=${H * 2}:color=white@1:t=fill`
  ).join(',')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${W * 2}x${H * 2}`,
    '-vf', bars, '-frames:v', '1', stripes
  ])
}, 120_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

const asset: MediaAsset = {
  id: 'photo',
  path: '',
  name: 'quadrants.png',
  kind: 'image',
  durationFrames: 60,
  width: W * 2,
  height: H * 2,
  fps: 30,
  hasVideo: true,
  hasAudio: false,
  size: 0
}

function projectWith(clips: Clip[], picture = quadrants): Project {
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: 10, sampleRate: 48000 },
    assets: [{ ...asset, path: picture }],
    clips
  }
}

function spec(over: Partial<GridSpec> = {}): GridSpec {
  return { ...DEFAULT_GRID, ...over }
}

/**
 * Every cell of a grid, all present from frame zero.
 *
 * The arrival times are pulled out deliberately — when each piece lands is
 * tested on its own, and what is being asked here is whether the assembled
 * picture is right. Leaving the staggering in would mean the first rendered
 * frame holds one piece and nineteen empty slots, which is what it is supposed
 * to look like a quarter of a second in.
 */
function allAtOnce(gridSpec: GridSpec, arrival: Arrival = 'cut'): Clip[] {
  const pieces = planGridSplit({
    fps: 10,
    source: { width: W * 2, height: H * 2 },
    canvas: CANVAS,
    spec: gridSpec,
    order: 'rows',
    analysis: null,
    holdSeconds: 2
  })
  return gridClips(pieces, 'v1', 'photo', 10, arrival).map((clip) => ({
    ...clip,
    start: 0,
    duration: 20
  }))
}

/** One rendered frame, as raw RGB. `at` counts frames from the start. */
async function frame(
  clips: Clip[],
  name: string,
  at = 0,
  picture = quadrants
): Promise<Buffer> {
  const out = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project: projectWith(clips, picture), outputPath: out }).args, {
    maxBuffer: 64 * 1024 * 1024
  })
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-i', out,
     // `select` rather than `-ss`, which returns the first frame at or after a
     // timestamp and is a frame out either way at this frame rate.
     '-vf', `select='eq(n\\,${at})'`, '-frames:v', '1', '-vsync', '0',
     '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  )
  return stdout as unknown as Buffer
}

function pixel(buffer: Buffer, x: number, y: number): [number, number, number] {
  const i = (y * W + x) * 3
  return [buffer[i], buffer[i + 1], buffer[i + 2]]
}

/** Which of the four source colours a pixel is closest to. */
function nameOf([r, g, b]: [number, number, number]): string {
  const bright = (v: number): boolean => v > 110
  if (bright(r) && bright(g) && bright(b)) return 'white'
  if (bright(r)) return 'red'
  if (bright(g)) return 'green'
  if (bright(b)) return 'blue'
  return 'black'
}

describe('a photograph diced into a grid', () => {
  it('puts the quadrants back where they came from', async () => {
    const buffer = await frame(allAtOnce(spec({ rows: 2, cols: 2 })), 'square')
    expect(nameOf(pixel(buffer, W * 0.25, H * 0.25))).toBe('red')
    expect(nameOf(pixel(buffer, W * 0.75, H * 0.25))).toBe('green')
    expect(nameOf(pixel(buffer, W * 0.25, H * 0.75))).toBe('blue')
    expect(nameOf(pixel(buffer, W * 0.75, H * 0.75))).toBe('white')
  }, 180_000)

  it('leaves no seam where two pieces meet', async () => {
    const buffer = await frame(allAtOnce(spec({ rows: 2, cols: 2 })), 'seam')
    /*
     * Straight down the join, and straight across it. A gap of a single pixel
     * shows as the black canvas behind, which is a colour none of the four
     * quadrants are.
     */
    for (let y = 4; y < H - 4; y++) {
      for (const x of [W / 2 - 1, W / 2, W / 2 + 1]) {
        expect(nameOf(pixel(buffer, x, y))).not.toBe('black')
      }
    }
    for (let x = 4; x < W - 4; x++) {
      for (const y of [H / 2 - 1, H / 2, H / 2 + 1]) {
        expect(nameOf(pixel(buffer, x, y))).not.toBe('black')
      }
    }
  }, 180_000)

  it('fills the frame with twenty pieces as completely as with one', async () => {
    const buffer = await frame(allAtOnce(spec({ rows: 5, cols: 4 })), 'twenty')
    let black = 0
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        if (nameOf(pixel(buffer, x, y)) === 'black') black++
      }
    }
    // Some softening at the joins is fine; a missing piece is not.
    expect(black).toBeLessThan((W * H) / 400)
  }, 180_000)

  it('a wavy cut interlocks — no gap along the join', async () => {
    const wavy = spec({ rows: 2, cols: 2, shape: 'wave', waveDepth: 0.35, waveCycles: 3 })
    const buffer = await frame(allAtOnce(wavy), 'wave')

    let black = 0
    for (let y = 3; y < H - 3; y++) {
      for (let x = 3; x < W - 3; x++) {
        if (nameOf(pixel(buffer, x, y)) === 'black') black++
      }
    }
    expect(black).toBeLessThan((W * H) / 200)
  }, 180_000)

  it('and the wavy cut is genuinely wavy, not a straight line in disguise', async () => {
    /*
     * ONE piece, against the empty canvas.
     *
     * Looking for the boundary in the finished grid is the obvious test and the
     * wrong one: a wavy piece is cropped WIDER than its slot — that headroom is
     * what gives the crest somewhere to land — so each piece carries a strip of
     * its neighbour's content under the mask. Hunting for a colour change then
     * finds the photograph's own edge, sitting straight where the picture put
     * it, and reports that the wave is flat. It cost a round to notice.
     *
     * Against black there is no such ambiguity: the last lit pixel in a row IS
     * the cut.
     */
    const wavy = spec({ rows: 1, cols: 2, shape: 'wave', waveDepth: 0.35, waveCycles: 3 })
    const buffer = await frame(allAtOnce(wavy).slice(0, 1), 'wavecheck')

    const edges: number[] = []
    for (let y = 8; y < H - 8; y += 8) {
      for (let x = W - 1; x >= 0; x--) {
        if (nameOf(pixel(buffer, x, y)) !== 'black') {
          edges.push(x)
          break
        }
      }
    }
    expect(edges.length).toBeGreaterThan(40)
    const spread = Math.max(...edges) - Math.min(...edges)
    // Three cycles of a wave a third of a cell deep: tens of pixels, not one.
    expect(spread).toBeGreaterThan(W * 0.12)
    // And it comes back — a wave, not a diagonal.
    expect(edges[0]).toBeCloseTo(edges[Math.round(H / 3 / 8)], -1)
  }, 180_000)

  it('shows the same picture once a pop-in has landed as a snap-in does', async () => {
    /*
     * The arrival the app SHIPS as its default, which is the one that shipped
     * broken. A pop-in carries zoom keyframes, and `zoomKeyframeFilter` used to
     * size zoompan from the whole photograph even though it runs after the crop
     * — so every piece was squashed into the file's aspect and centre-cropped,
     * showing about 40% of itself at two and a half times the right size. On
     * every frame, not only during the animation.
     *
     * Every other test here builds with 'cut', which emits no zoom at all, and
     * that is exactly why nothing caught it. The frame sampled is the last one,
     * long after the ~1-frame pop has settled, so the two must be identical.
     */
    const square = spec({ rows: 2, cols: 2 })
    const snap = await frame(allAtOnce(square, 'cut'), 'arrive-cut', 19, stripes)
    const pop = await frame(allAtOnce(square, 'pop'), 'arrive-pop', 19, stripes)

    /** How many times a row crosses from dark to light — the magnification. */
    const edges = (buffer: Buffer, y: number, from: number, to: number): number => {
      let count = 0
      for (let x = from + 1; x < to; x++) {
        const lit = pixel(buffer, x, y)[0] > 110
        const was = pixel(buffer, x - 1, y)[0] > 110
        if (lit && !was) count++
      }
      return count
    }
    // Every piece, not only one: a wrong scale shows on all of them.
    for (const y of [H * 0.25, H * 0.75]) {
      for (const [from, to] of [
        [0, W / 2],
        [W / 2, W]
      ]) {
        expect(edges(pop, Math.round(y), from, to)).toBe(edges(snap, Math.round(y), from, to))
      }
    }

    let differing = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (Math.abs(pixel(pop, x, y)[0] - pixel(snap, x, y)[0]) > 40) differing++
      }
    }
    expect(differing).toBeLessThan((W * H) / 50)
  }, 240_000)

  it('circles leave the corners of each cell empty', async () => {
    const buffer = await frame(allAtOnce(spec({ rows: 2, cols: 2, shape: 'circle' })), 'circle')
    // Middle of each cell: the picture. Corner of the frame: outside the circle.
    expect(nameOf(pixel(buffer, W * 0.25, H * 0.25))).toBe('red')
    expect(nameOf(pixel(buffer, 2, 2))).toBe('black')
    expect(nameOf(pixel(buffer, W - 3, 2))).toBe('black')
  }, 180_000)
})

describe('a turned clip', () => {
  it('keeps its corners instead of having them cut off', async () => {
    const turned: Clip = {
      id: 'c1',
      assetId: 'photo',
      trackId: 'v1',
      start: 0,
      duration: 10,
      inPoint: 0,
      volume: 1,
      // A square box, so the diagonal is unmistakably longer than the side.
      transform: { x: 0, y: 0, scale: 0.5, scaleY: 0.5 * (W / H), rotation: 45, opacity: 1, fit: 'cover' },
      color: { brightness: 0, contrast: 1, saturation: 1 },
      crop: { x: 0, y: 0, width: W, height: W }
    }
    const buffer = await frame([turned], 'turned')

    // The widest row of a turned square is its diagonal, through the middle.
    let widest = 0
    for (let y = 1; y < H - 1; y++) {
      let run = 0
      for (let x = 0; x < W; x++) {
        if (nameOf(pixel(buffer, x, y)) !== 'black') run++
      }
      widest = Math.max(widest, run)
    }
    const side = 0.5 * W
    // Cut off, this would be the side itself. Whole, it is the diagonal.
    expect(widest).toBeGreaterThan(side * 1.25)
    expect(widest).toBeLessThan(side * 1.55)
  }, 180_000)

  it('still draws its mask at the right size, and turns the shape with it', async () => {
    /*
     * Growing the frame to keep a turned clip's corners broke every shape in
     * the renderer, because they are all sized against the clip's BOX: a mask's
     * `geq` reads the stream's own W and H, a luma wipe is scaled to the box,
     * and `alphamerge` refuses two streams of different sizes outright. Turning
     * the clip first made the stream bigger than all of them.
     *
     * Rotating AFTER the shape is applied fixes the size and gets the picture
     * right as well: the shape turns with the photograph, which is what a
     * canvas rotation does in the preview.
     */
    const base = {
      id: 'c1',
      assetId: 'photo',
      trackId: 'v1',
      start: 0,
      duration: 10,
      inPoint: 0,
      volume: 1,
      color: { brightness: 0, contrast: 1, saturation: 1 },
      crop: { x: 0, y: 0, width: W, height: W },
      // A wide, short rectangle — unmistakable once it has been turned, and a
      // shape whose size cannot be confused with the frame's.
      mask: {
        mode: 'reveal' as const,
        blur: 0,
        shape: {
          kind: 'rectangle' as const,
          x: 0.5,
          y: 0.5,
          width: 0.45,
          height: 0.12,
          rotation: 0,
          feather: 0.02,
          invert: false
        }
      }
    }
    const transform = {
      x: 0,
      y: 0,
      scale: 0.8,
      scaleY: 0.8 * (W / H),
      opacity: 1,
      fit: 'cover' as const
    }

    const lit = (buffer: Buffer): { count: number; wide: number; tall: number } => {
      let count = 0
      let minX = W
      let maxX = -1
      let minY = H
      let maxY = -1
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (nameOf(pixel(buffer, x, y)) !== 'black') {
            count++
            minX = Math.min(minX, x)
            maxX = Math.max(maxX, x)
            minY = Math.min(minY, y)
            maxY = Math.max(maxY, y)
          }
        }
      }
      return { count, wide: maxX - minX, tall: maxY - minY }
    }

    const upright = lit(await frame([{ ...base, transform: { ...transform, rotation: 0 } }], 'mask-flat'))
    const turned = lit(await frame([{ ...base, transform: { ...transform, rotation: 90 } }], 'mask-turned'))

    // It rendered at all — before the fix this was an alphamerge size mismatch.
    expect(upright.count).toBeGreaterThan(200)
    // The same shape, so the same amount of picture survives the mask.
    expect(turned.count / upright.count).toBeGreaterThan(0.85)
    expect(turned.count / upright.count).toBeLessThan(1.15)
    // Turned a quarter turn, the wide bar is now the tall one.
    expect(upright.wide).toBeGreaterThan(upright.tall * 2)
    expect(turned.tall).toBeGreaterThan(turned.wide * 2)
  }, 240_000)

  it('leaves the turned clip centred where an upright one would be', async () => {
    const base = {
      id: 'c1',
      assetId: 'photo',
      trackId: 'v1',
      start: 0,
      duration: 10,
      inPoint: 0,
      volume: 1,
      color: { brightness: 0, contrast: 1, saturation: 1 },
      crop: { x: 0, y: 0, width: W, height: W }
    }
    // Off to one side, so a mistaken offset shows up as a shifted middle.
    const transform = { x: 0.4, y: -0.3, scale: 0.4, scaleY: 0.4 * (W / H), opacity: 1, fit: 'cover' as const }

    const centreOf = (buffer: Buffer): { x: number; y: number } => {
      let sx = 0
      let sy = 0
      let n = 0
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (nameOf(pixel(buffer, x, y)) !== 'black') {
            sx += x
            sy += y
            n++
          }
        }
      }
      return { x: sx / Math.max(1, n), y: sy / Math.max(1, n) }
    }

    const upright = centreOf(await frame([{ ...base, transform: { ...transform, rotation: 0 } }], 'upright'))
    const spun = centreOf(await frame([{ ...base, transform: { ...transform, rotation: 30 } }], 'spun'))

    /*
     * Within a pixel. The centroid is taken over thresholded pixels, and a
     * turned rectangle covers its edge pixels partially in a way an upright one
     * does not, so the two never agree to the last decimal. A missing offset
     * would be out by half the growth — tens of pixels, not fractions of one.
     */
    expect(Math.abs(spun.x - upright.x)).toBeLessThan(1.5)
    expect(Math.abs(spun.y - upright.y)).toBeLessThan(1.5)
  }, 180_000)
})
