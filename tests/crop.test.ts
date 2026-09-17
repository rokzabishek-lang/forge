import { describe, it, expect } from 'vitest'
import { evenDown, safeCrop } from '@shared/render/crop'

/*
 * A crop may only ever shrink.
 *
 * `crop` is the one filter whose arguments ffmpeg checks against the real
 * stream, and it kills the render rather than clamping:
 *
 *   Invalid too big or non positive size for width '3210' or height '1808'
 *
 * That was a user's export. The dimensions were being rounded to the NEAREST
 * even number, and rounding an odd number to the nearest even one rounds it up
 * — so a 3209-wide source was asked for 3210 pixels. Reproduced exactly against
 * the bundled binary, and it was not rare: half of all realistic source sizes
 * crossed with the three aspect ratios produced a crop reaching outside the
 * frame.
 */

describe('evenDown', () => {
  it('never rounds up', () => {
    // The whole bug in one assertion.
    expect(evenDown(3209)).toBe(3208)
    expect(evenDown(1807)).toBe(1806)
    expect(evenDown(1081)).toBe(1080)
  })

  it('leaves an even number alone', () => {
    expect(evenDown(1920)).toBe(1920)
    expect(evenDown(2)).toBe(2)
  })

  it('never goes below two, which is the smallest valid dimension', () => {
    expect(evenDown(1)).toBe(2)
    expect(evenDown(0)).toBe(2)
    expect(evenDown(-40)).toBe(2)
  })
})

describe('safeCrop', () => {
  const source = { width: 1920, height: 1080 }

  it('shrinks an odd crop instead of growing it', () => {
    expect(safeCrop({ x: 0, y: 0, width: 1001, height: 601 }, source)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 600
    })
  })

  it('refuses to ask for more than the source has', () => {
    const crop = safeCrop({ x: 0, y: 0, width: 4000, height: 4000 }, source)
    // A crop covering the whole frame is not a crop at all.
    expect(crop).toBeNull()
  })

  it('slides a rectangle back inside rather than shrinking it', () => {
    /*
     * The first version of this pinned the corner and took whatever width was
     * left, which turned this 400x400 crop into a 120x80 sliver — a different
     * shape from the one the user framed. The size is their choice; only the
     * position may move.
     */
    const crop = safeCrop({ x: 1800, y: 1000, width: 400, height: 400 }, source)!
    expect(crop.width).toBe(400)
    expect(crop.height).toBe(400)
    expect(crop.x + crop.width).toBe(source.width)
    expect(crop.y + crop.height).toBe(source.height)
  })

  it('only shrinks when the rectangle itself is bigger than the source', () => {
    const crop = safeCrop({ x: 0, y: 0, width: 4000, height: 500 }, source)!
    expect(crop.width).toBe(1920)
    // The axis that fitted is left exactly as asked.
    expect(crop.height).toBe(500)
  })

  it('brings a negative origin back to zero', () => {
    const crop = safeCrop({ x: -200, y: -50, width: 400, height: 400 }, source)!
    expect(crop.x).toBe(0)
    expect(crop.y).toBe(0)
  })

  it('emits nothing for a crop that covers the whole frame', () => {
    // A filter that changes nothing still costs a pass over every pixel of
    // every frame, so the right answer is not to emit it.
    expect(safeCrop({ x: 0, y: 0, width: 1920, height: 1080 }, source)).toBeNull()
    // And the same when the source itself is odd: 1919x1079 evens down to the
    // whole usable frame.
    expect(safeCrop({ x: 0, y: 0, width: 1919, height: 1079 }, { width: 1919, height: 1079 }))
      .toBeNull()
  })

  it('gives up rather than guess when the source size is unknown', () => {
    expect(safeCrop({ x: 0, y: 0, width: 100, height: 100 }, null)).toBeNull()
    expect(safeCrop({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull()
  })

  it('always returns something ffmpeg will accept', () => {
    /*
     * The property that matters, swept rather than sampled: over every
     * combination of awkward sizes and origins, the result is even, positive,
     * and inside the frame — or it is null.
     */
    const sizes = [2, 3, 101, 640, 1079, 1080, 1919, 1920, 3209, 3210]
    const origins = [-500, -1, 0, 1, 17, 1000, 5000]
    for (const sw of sizes) {
      for (const sh of sizes) {
        for (const x of origins) {
          for (const w of sizes) {
            const crop = safeCrop({ x, y: x, width: w, height: w }, { width: sw, height: sh })
            if (!crop) continue
            const where = `src ${sw}x${sh} crop ${w}@${x}`
            expect(crop.width % 2, where).toBe(0)
            expect(crop.height % 2, where).toBe(0)
            expect(crop.width, where).toBeGreaterThanOrEqual(2)
            expect(crop.height, where).toBeGreaterThanOrEqual(2)
            expect(crop.x, where).toBeGreaterThanOrEqual(0)
            expect(crop.y, where).toBeGreaterThanOrEqual(0)
            expect(crop.x + crop.width, where).toBeLessThanOrEqual(sw)
            expect(crop.y + crop.height, where).toBeLessThanOrEqual(sh)
          }
        }
      }
    }
  })

  it('handles the exact case that killed a user export', () => {
    // A 3209x1807 source asked for 3210x1808 and the render died.
    const crop = safeCrop({ x: 0, y: 0, width: 3209, height: 1807 }, { width: 3209, height: 1807 })
    expect(crop).toBeNull()
    const trimmed = safeCrop({ x: 0, y: 0, width: 3209, height: 1000 }, { width: 3209, height: 1807 })!
    expect(trimmed.width).toBe(3208)
    expect(trimmed.width).toBeLessThanOrEqual(3209)
  })
})
