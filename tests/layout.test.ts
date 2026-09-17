import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PIP,
  PIP_SPOTS,
  pipTransform,
  splitTransform,
  type PipShape,
  type SplitLayout
} from '@shared/render/layout'
import { clipBox } from '@shared/render/plan'
import type { Clip, Transform } from '@shared/timeline'

/*
 * Split screen and picture in picture.
 *
 * Both are arithmetic over the transform the renderer already understands, so
 * the only thing worth testing is where the boxes actually LAND — and the way
 * to test that is to push the transform through `clipBox`, which is the very
 * function the render plan and the preview both use. Asserting on the raw
 * numbers would only check the arithmetic against itself.
 */

const TALL = { width: 1080, height: 1920 }
const WIDE = { width: 1920, height: 1080 }

function boxOf(transform: Transform, canvas: { width: number; height: number }): ReturnType<typeof clipBox> {
  const clip = {
    id: 'c',
    assetId: 'a',
    trackId: 'v1',
    start: 0,
    duration: 30,
    inPoint: 0,
    volume: 1,
    transform,
    color: { brightness: 0, contrast: 1, saturation: 1 }
  } as Clip
  return clipBox(clip, canvas)
}

describe('split screen', () => {
  it('stacks two panels that exactly fill the frame', () => {
    const top = boxOf(splitTransform('rows', 0), TALL)
    const bottom = boxOf(splitTransform('rows', 1), TALL)

    expect(top.y).toBe(0)
    expect(top.height).toBe(960)
    // No gap and no overlap: the second starts where the first ends.
    expect(bottom.y).toBe(top.y + top.height)
    expect(bottom.y + bottom.height).toBe(TALL.height)
    // Both full width.
    expect(top.width).toBe(TALL.width)
    expect(bottom.width).toBe(TALL.width)
  })

  it('puts them side by side for columns', () => {
    const left = boxOf(splitTransform('columns', 0), WIDE)
    const right = boxOf(splitTransform('columns', 1), WIDE)

    expect(left.x).toBe(0)
    expect(right.x).toBe(left.x + left.width)
    expect(right.x + right.width).toBe(WIDE.width)
    expect(left.height).toBe(WIDE.height)
  })

  it('handles a three-way split with the middle one centred', () => {
    // The offset formula has to hold for any count, not just two.
    const boxes = [0, 1, 2].map((slot) => boxOf(splitTransform('rows', slot, 3), TALL))
    // Thirds do not divide exactly in binary, so the top edge lands on a
    // negative zero rather than a positive one. Both are 0 everywhere it
    // matters — JS prints it "0" and ffmpeg parses it as 0 — so the assertion
    // is about the edge, not about the sign of nothing.
    expect(boxes[0].y).toBeCloseTo(0, 6)
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].y).toBe(boxes[i - 1].y + boxes[i - 1].height)
    }
    expect(boxes[2].y + boxes[2].height).toBe(TALL.height)
  })

  it('fills each panel rather than letterboxing inside it', () => {
    // Without cover, a landscape shot in a half-height panel becomes a thin
    // band floating in black — the exact failure the film strip hit.
    expect(splitTransform('rows', 0).fit).toBe('cover')
    expect(splitTransform('columns', 1).fit).toBe('cover')
  })

  it('clamps a slot that does not exist rather than flying off the frame', () => {
    const box = boxOf(splitTransform('rows', 9, 2), TALL)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(TALL.height)
  })
})

describe('picture in picture', () => {
  const pip = (over: Partial<Parameters<typeof pipTransform>[0]> = {}): ReturnType<typeof clipBox> =>
    boxOf(pipTransform({ ...DEFAULT_PIP, canvas: TALL, ...over }), TALL)

  it('sits inside the frame in every corner', () => {
    for (const spot of PIP_SPOTS) {
      const box = pip({ spot })
      expect(box.x, spot).toBeGreaterThanOrEqual(0)
      expect(box.y, spot).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, spot).toBeLessThanOrEqual(TALL.width)
      expect(box.y + box.height, spot).toBeLessThanOrEqual(TALL.height)
    }
  })

  it('puts each corner where its name says', () => {
    const half = { x: TALL.width / 2, y: TALL.height / 2 }
    expect(pip({ spot: 'top-left' }).x).toBeLessThan(half.x)
    expect(pip({ spot: 'top-left' }).y).toBeLessThan(half.y)
    expect(pip({ spot: 'bottom-right' }).x).toBeGreaterThan(half.x)
    expect(pip({ spot: 'bottom-right' }).y).toBeGreaterThan(half.y)
    expect(pip({ spot: 'top-right' }).x).toBeGreaterThan(half.x)
    expect(pip({ spot: 'bottom-left' }).y).toBeGreaterThan(half.y)
  })

  it('centres the centre one on both axes', () => {
    const box = pip({ spot: 'centre' })
    expect(box.x + box.width / 2).toBeCloseTo(TALL.width / 2, 0)
    expect(box.y + box.height / 2).toBeCloseTo(TALL.height / 2, 0)
  })

  it('keeps the same gap from both edges it touches', () => {
    // A corner inset with an uneven gap looks like a mistake, and the gap is
    // given against the WIDTH, so the vertical one has to be converted.
    const box = pip({ spot: 'top-left', inset: 0.05 })
    const gap = 0.05 * TALL.width
    expect(box.x).toBeCloseTo(gap, 0)
    expect(box.y).toBeCloseTo(gap, 0)
  })

  it('makes a square actually square, in pixels', () => {
    // scaleY is measured against the HEIGHT, so 0.3 and 0.3 is a tall box in a
    // 9:16 frame — the conversion is the whole reason this shape exists.
    const box = pip({ shape: 'square', size: 0.3 })
    expect(box.width).toBeCloseTo(box.height, -1)
  })

  it('keeps the frame shape in proportion at any aspect', () => {
    const tall = boxOf(pipTransform({ ...DEFAULT_PIP, shape: 'frame', canvas: TALL }), TALL)
    const wide = boxOf(pipTransform({ ...DEFAULT_PIP, shape: 'frame', canvas: WIDE }), WIDE)
    expect(tall.width / tall.height).toBeCloseTo(TALL.width / TALL.height, 1)
    expect(wide.width / wide.height).toBeCloseTo(WIDE.width / WIDE.height, 1)
  })

  it('stays on the frame at absurd sizes', () => {
    for (const size of [0.001, 0.5, 5]) {
      for (const shape of ['frame', 'square', 'circle', 'portrait'] as PipShape[]) {
        const box = pip({ size, shape })
        expect(box.width, `${shape} @${size}`).toBeLessThanOrEqual(TALL.width)
        expect(box.height, `${shape} @${size}`).toBeLessThanOrEqual(TALL.height)
        expect(box.x, `${shape} @${size}`).toBeGreaterThanOrEqual(0)
        expect(box.y, `${shape} @${size}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('fills its box, so a wide source is not letterboxed into a small square', () => {
    expect(pipTransform({ ...DEFAULT_PIP, canvas: TALL }).fit).toBe('cover')
  })

  it('is small enough to be an inset rather than a second main picture', () => {
    const box = pip()
    expect(box.width / TALL.width).toBeLessThan(0.5)
  })
})

describe('the two layouts do not collide', () => {
  it('produce genuinely different boxes', () => {
    const split = boxOf(splitTransform('rows' as SplitLayout, 0), TALL)
    const inset = boxOf(pipTransform({ ...DEFAULT_PIP, canvas: TALL }), TALL)
    expect(split.width).not.toBe(inset.width)
    expect(split.height).not.toBe(inset.height)
  })
})
