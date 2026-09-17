import { describe, it, expect } from 'vitest'
import { LOOKS, cubeFor, lookById, luma, sCurve, CUBE_SIZE, type Rgb } from '@shared/render/looks'
import { parseCube, sampleNearest } from '@shared/render/cube'

/*
 * The built-in looks.
 *
 * They exist because a LUT picker that only says "load a .cube" is useless to
 * anyone who does not already own LUTs. Being generated, they are also the one
 * place a colour bug would be silent — a look that clips or inverts still
 * produces a valid file.
 */

describe('LOOKS', () => {
  it('has a unique id for every look', () => {
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(LOOKS.length)
  })

  it('says what each one does, in words someone choosing would use', () => {
    for (const look of LOOKS) {
      expect(look.name.length).toBeGreaterThan(2)
      expect(look.description.length).toBeGreaterThan(10)
    }
  })

  it('never sends a colour outside the cube', () => {
    // A value past 1 is silently clipped by the render and looks like blown
    // highlights nobody asked for.
    for (const look of LOOKS) {
      for (let i = 0; i <= 8; i++) {
        for (const rgb of [
          [i / 8, 0, 0],
          [0, i / 8, 0],
          [0, 0, i / 8],
          [i / 8, i / 8, i / 8],
          [1, i / 8, 0]
        ] as Rgb[]) {
          for (const v of look.apply(rgb)) {
            expect(v).toBeGreaterThanOrEqual(0)
            expect(v).toBeLessThanOrEqual(1)
          }
        }
      }
    }
  })

  it('keeps black dark and white bright', () => {
    // A look that lifts black to mid-grey or crushes white is broken, whatever
    // it was aiming for.
    for (const look of LOOKS) {
      expect(luma(look.apply([0, 0, 0]))).toBeLessThan(0.2)
      expect(luma(look.apply([1, 1, 1]))).toBeGreaterThan(0.75)
    }
  })

  it('rises monotonically in luma, so no look inverts the picture', () => {
    for (const look of LOOKS) {
      let previous = -1
      for (let i = 0; i <= 16; i++) {
        const y = luma(look.apply([i / 16, i / 16, i / 16]))
        expect(y).toBeGreaterThanOrEqual(previous - 0.001)
        previous = y
      }
    }
  })

  it('actually changes the picture', () => {
    // A no-op look would be indistinguishable from the LUT failing to load.
    for (const look of LOOKS) {
      const before: Rgb = [0.6, 0.35, 0.25]
      const after = look.apply(before)
      const moved = after.some((v, i) => Math.abs(v - before[i]) > 0.01)
      expect(moved, `${look.id} does nothing`).toBe(true)
    }
  })

  describe('individual looks', () => {
    it('makes Noir actually grey', () => {
      const [r, g, b] = lookById('noir')!.apply([0.8, 0.2, 0.3])
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0.01)
    })

    it('lifts the blacks for Faded, which is the whole effect', () => {
      expect(luma(lookById('faded')!.apply([0, 0, 0]))).toBeGreaterThan(0.04)
    })

    it('cools the shadows and warms the highlights for Teal & Orange', () => {
      const shadow = lookById('teal-orange')!.apply([0.12, 0.12, 0.12])
      const highlight = lookById('teal-orange')!.apply([0.85, 0.85, 0.85])
      expect(shadow[2]).toBeGreaterThan(shadow[0])
      expect(highlight[0]).toBeGreaterThan(highlight[2])
    })

    it('drains colour for Bleach Bypass', () => {
      const before: Rgb = [0.9, 0.2, 0.2]
      const after = lookById('bleach-bypass')!.apply(before)
      const spread = (c: Rgb): number => Math.max(...c) - Math.min(...c)
      expect(spread(after)).toBeLessThan(spread(before))
    })
  })
})

describe('sCurve', () => {
  it('leaves the ends and the middle alone', () => {
    for (const amount of [0.3, -0.3, 1]) {
      expect(sCurve(0, amount)).toBeCloseTo(0, 5)
      expect(sCurve(1, amount)).toBeCloseTo(1, 5)
      expect(sCurve(0.5, amount)).toBeCloseTo(0.5, 5)
    }
  })

  it('darkens below the midpoint and lifts above it', () => {
    expect(sCurve(0.25, 0.5)).toBeLessThan(0.25)
    expect(sCurve(0.75, 0.5)).toBeGreaterThan(0.75)
  })

  it('does nothing at zero', () => {
    expect(sCurve(0.3, 0)).toBe(0.3)
  })
})

describe('cubeFor', () => {
  it('writes a file our own parser reads back', () => {
    // The generator and the reader are the two halves of the same contract.
    const lut = parseCube(cubeFor(lookById('noir')!, 5))
    expect(lut.size).toBe(5)
    expect(lut.title).toBe('Noir')
    expect(lut.data).toHaveLength(5 ** 3 * 3)
  })

  it('writes entries red-fastest, the order ffmpeg expects', () => {
    /*
     * The bug that would ship silently: a cube with the axes transposed still
     * loads, still looks plausible on greys, and is wrong on everything else.
     * Teal & Orange is asymmetric in red and blue, so it catches a transpose.
     */
    const look = lookById('teal-orange')!
    const lut = parseCube(cubeFor(look, 17))
    for (const probe of [
      [1, 0, 0],
      [0, 0, 1],
      [0.75, 0.5, 0.25]
    ] as Rgb[]) {
      const sampled = sampleNearest(lut, ...probe)
      const direct = look.apply(probe)
      for (let i = 0; i < 3; i++) expect(sampled[i]).toBeCloseTo(direct[i], 1)
    }
  })

  it('defaults to a resolution fine enough not to band', () => {
    expect(CUBE_SIZE).toBeGreaterThanOrEqual(17)
  })

  it('produces a file for every shipped look', () => {
    for (const look of LOOKS) {
      expect(() => parseCube(cubeFor(look, 9))).not.toThrow()
    }
  })
})
