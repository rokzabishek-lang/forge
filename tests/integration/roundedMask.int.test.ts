import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { maskExpression, type MaskShape } from '@shared/render/mask'

/*
 * Rounded corners, rendered.
 *
 * The picture-in-picture look depends on a rounded rectangle, which the mask
 * expression builds from the standard rounded-box distance: pull the radius in
 * from both half-extents, measure how far outside that inner box the point sits
 * on each axis, and take the length of the pair. Near a flat edge one term is
 * zero and the sides stay straight; only at a corner do both contribute.
 *
 * That relies on `max` being available inside `geq`, which is not documented
 * anywhere obvious. It was measured against the bundled binary before the code
 * was written, and this is that measurement kept.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const SIZE = 240

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-rounded-'))
}, 60_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

/** Render a mask shape to a greyscale frame and read single pixels from it. */
async function render(shape: MaskShape, name: string): Promise<(x: number, y: number) => Promise<number>> {
  const file = join(dir, `${name}.png`)
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=white:s=${SIZE}x${SIZE}:d=1`,
    '-vf', `format=gray,geq=lum='${maskExpression(shape)}'`,
    '-frames:v', '1', file])

  return async (x: number, y: number): Promise<number> => {
    const { stdout } = await run(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-i', file,
       '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 1024 }
    )
    return (stdout as unknown as Buffer)[0]
  }
}

/** A box covering most of the frame, as a picture-in-picture frame would. */
function box(radius: number): MaskShape {
  return {
    kind: 'rectangle',
    x: 0.5,
    y: 0.5,
    width: 0.4,
    height: 0.4,
    rotation: 0,
    radius,
    feather: 0.02,
    invert: false
  }
}

describe('a rounded rectangle mask', () => {
  it('keeps the middle and the flat edges, and cuts the corners', async () => {
    const at = await render(box(0.5), 'rounded')

    // Half-extent 0.4 of 240 = 96px, so the box spans 24..216.
    expect(await at(120, 120), 'centre').toBeGreaterThan(200)
    // Just inside the top edge, on the centre line: a flat edge, kept.
    expect(await at(120, 30), 'top edge').toBeGreaterThan(200)
    expect(await at(30, 120), 'left edge').toBeGreaterThan(200)
    // The corner of the bounding box, which the radius removes.
    expect(await at(28, 28), 'corner').toBeLessThan(40)
  })

  it('is a plain box when the radius is zero', async () => {
    // Every existing mask has no radius at all, and must be untouched by this.
    const at = await render(box(0), 'square')
    expect(await at(120, 120), 'centre').toBeGreaterThan(200)
    expect(await at(28, 28), 'corner').toBeGreaterThan(200)
  })

  it('cuts more as the radius grows', async () => {
    const gentle = await render(box(0.25), 'gentle')
    const heavy = await render(box(1), 'heavy')
    // A point near the corner survives a small radius and not a large one.
    expect(await gentle(40, 40)).toBeGreaterThan(await heavy(40, 40))
  })

  it('keeps the corners circular in a box that is not square', async () => {
    /*
     * The radius is a fraction of the SHORTER half-extent. Measured against
     * each axis separately it would stretch into an oval on a wide box, which
     * is exactly what a hand-rolled version gets wrong.
     */
    const wide: MaskShape = { ...box(1), width: 0.45, height: 0.15 }
    const at = await render(wide, 'wide')
    // Half-extents: 108 x 36, so the box spans x 12..228, y 84..156. With the
    // radius at a full 36, the ends are semicircles and the middle is flat.
    expect(await at(120, 120), 'centre').toBeGreaterThan(200)
    expect(await at(120, 88), 'top edge mid').toBeGreaterThan(200)
    // A corner of the bounding box is well outside the rounded end.
    expect(await at(16, 88), 'corner').toBeLessThan(40)
  })

  it('still respects invert, so a rounded hole works too', async () => {
    const at = await render({ ...box(0.5), invert: true }, 'hole')
    expect(await at(120, 120), 'centre').toBeLessThan(40)
    expect(await at(28, 28), 'corner').toBeGreaterThan(200)
  })
})
