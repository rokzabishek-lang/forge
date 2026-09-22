import { describe, it, expect } from 'vitest'
import {
  normaliseKeys,
  valueAt,
  keyframeExpression,
  hasKeys,
  anyKeys,
  PROPERTY_INFO,
  KEYED_PROPERTIES,
  type Keyframe
} from '@shared/render/keyframes'

const key = (frame: number, value: number, ease?: Keyframe['ease']): Keyframe => ({
  frame,
  value,
  ...(ease ? { ease } : {})
})

describe('normaliseKeys', () => {
  it('sorts by frame', () => {
    expect(normaliseKeys([key(30, 2), key(0, 1)], 60).map((k) => k.frame)).toEqual([0, 30])
  })

  it('keeps keys outside the clip where they are', () => {
    /*
     * This test used to assert the opposite — "clamps into the clip", on the
     * reasoning that a key past the end "would animate towards a value never
     * reached". That is exactly what SHOULD happen after a trim: the curve is
     * still heading for the key when the clip ends. Clamping squashed the key
     * onto the last frame, so a fade trimmed half-way arrived at its bottom
     * early. The test certified the distortion it was meant to prevent.
     */
    expect(normaliseKeys([key(-10, 1), key(999, 2)], 60).map((k) => k.frame)).toEqual([-10, 999])
  })

  it('evaluates the TRUE curve inside a clip whose keys run past its edges', () => {
    // A ramp from 0 at frame 0 to 1 at frame 100, seen through a clip only 50
    // frames long: at its last frame it is half-way, not at the top.
    const ramp = [key(0, 0), key(100, 1)]
    expect(valueAt(ramp, 50, 50, 0)).toBeCloseTo(0.5, 6)
    // And from the other side: keys before the clip still decide where it opens.
    expect(valueAt([key(-50, 0), key(50, 1)], 0, 50, 0)).toBeCloseTo(0.5, 6)
  })

  it('keeps the later of two keys at one frame', () => {
    // Two values at one instant is a contradiction, not an animation.
    const keys = normaliseKeys([key(10, 1), key(10, 5)], 60)
    expect(keys).toHaveLength(1)
    expect(keys[0].value).toBe(5)
  })

  it('does not mutate what it was given', () => {
    const original = [key(30, 2), key(0, 1)]
    normaliseKeys(original, 60)
    expect(original.map((k) => k.frame)).toEqual([30, 0])
  })
})

describe('valueAt', () => {
  const keys = [key(0, 0), key(60, 10)]

  it('interpolates linearly between keys', () => {
    expect(valueAt(keys, 0, 60, 0)).toBe(0)
    expect(valueAt(keys, 30, 60, 0)).toBeCloseTo(5)
    expect(valueAt(keys, 60, 60, 0)).toBe(10)
  })

  it('holds flat outside the keys rather than drifting', () => {
    const late = [key(20, 3), key(40, 7)]
    expect(valueAt(late, 0, 60, 99)).toBe(3)
    expect(valueAt(late, 60, 60, 99)).toBe(7)
  })

  it('falls back when there is nothing keyed', () => {
    expect(valueAt([], 10, 60, 1.5)).toBe(1.5)
  })

  it('treats a single key as a constant', () => {
    expect(valueAt([key(30, 4)], 0, 60, 99)).toBe(4)
    expect(valueAt([key(30, 4)], 60, 60, 99)).toBe(4)
  })

  describe('easing', () => {
    it('eases in and out with smooth, passing through the midpoint', () => {
      const smooth = [key(0, 0, 'smooth'), key(60, 10)]
      expect(valueAt(smooth, 30, 60, 0)).toBeCloseTo(5)
      // Slower at the start than linear.
      expect(valueAt(smooth, 15, 60, 0)).toBeLessThan(2.5)
      expect(valueAt(smooth, 45, 60, 0)).toBeGreaterThan(7.5)
    })

    it('does not move at all until the next key with hold', () => {
      const held = [key(0, 0, 'hold'), key(60, 10)]
      expect(valueAt(held, 30, 60, 0)).toBe(0)
      expect(valueAt(held, 59, 60, 0)).toBe(0)
      expect(valueAt(held, 60, 60, 0)).toBe(10)
    })
  })
})

describe('keyframeExpression', () => {
  const options = { durationFrames: 60, fps: 30, startSeconds: 0, fallback: 1 }

  it('is a plain number when nothing is keyed', () => {
    expect(keyframeExpression([], options)).toBe('1.0000')
  })

  it('is a plain number for a single key', () => {
    expect(keyframeExpression([key(30, 2)], options)).toBe('2.0000')
  })

  it('brackets every segment with the time it ends', () => {
    const expression = keyframeExpression([key(0, 1), key(60, 2)], options)
    expect(expression).toContain('if(lt(t,')
    // The clip is 60 frames at 30fps, so the last segment ends at t=2.
    expect(expression).toContain('2.0000)')
  })

  /*
   * The expression and the preview must agree.
   *
   * They are two implementations of one animation — the renderer evaluates the
   * string, the preview calls valueAt — and a drift between them is invisible
   * until an export comes back different from what was on screen.
   */
  it('agrees with valueAt at every sampled frame', () => {
    for (const keys of [
      [key(0, 1), key(60, 3)],
      [key(0, 1, 'smooth'), key(60, 3)],
      [key(0, 1, 'hold'), key(30, 3), key(60, 1)],
      [key(10, 0), key(20, 1), key(50, 0.25)]
    ]) {
      const expression = keyframeExpression(keys, options)
      for (let frame = 0; frame <= 60; frame += 3) {
        const fromExpression = evaluate(expression, frame / 30)
        const fromPreview = valueAt(keys, frame, 60, 1)
        expect(fromExpression).toBeCloseTo(fromPreview, 3)
      }
    }
  })

  it('offsets by where the clip sits on the timeline', () => {
    // `t` is timeline seconds, not clip seconds.
    const shifted = keyframeExpression([key(0, 1), key(60, 2)], { ...options, startSeconds: 5 })
    expect(evaluate(shifted, 5)).toBeCloseTo(1)
    expect(evaluate(shifted, 7)).toBeCloseTo(2)
  })

  it('maps values into the filter units', () => {
    // Alpha is 0..1 to the user and 0..255 to geq.
    const expression = keyframeExpression([key(0, 0), key(60, 1)], {
      ...options,
      transform: (v) => v * 255,
      precision: 1
    })
    expect(evaluate(expression, 2)).toBeCloseTo(255, 0)
  })
})

describe('hasKeys', () => {
  it('needs two keys — one is a value, not an animation', () => {
    expect(hasKeys({ zoom: [key(0, 1)] }, 'zoom')).toBe(false)
    expect(hasKeys({ zoom: [key(0, 1), key(30, 2)] }, 'zoom')).toBe(true)
  })

  it('is false for an absent track', () => {
    expect(hasKeys(undefined, 'opacity')).toBe(false)
    expect(anyKeys(undefined)).toBe(false)
  })

  it('spots any animated property', () => {
    expect(anyKeys({ rotation: [key(0, 0), key(10, 90)] })).toBe(true)
  })
})

describe('PROPERTY_INFO', () => {
  it('describes every property that can be keyed', () => {
    for (const property of KEYED_PROPERTIES) {
      const info = PROPERTY_INFO[property]
      expect(info.label.length).toBeGreaterThan(2)
      expect(info.neutral).toBeGreaterThanOrEqual(info.min)
      expect(info.neutral).toBeLessThanOrEqual(info.max)
    }
  })

  it('does not offer scale, which ffmpeg cannot animate', () => {
    // Measured: scale with eval=frame re-evaluates but does not follow its
    // expression. Offering it would be offering something wrong.
    expect(KEYED_PROPERTIES).not.toContain('scale')
  })
})

/**
 * A tiny evaluator for the subset of ffmpeg expression syntax this module emits:
 * if(), lt(), min(), max(), t, and arithmetic. Enough to check the renderer and
 * the preview compute the same curve.
 */
function evaluate(expression: string, t: number): number {
  const js = expression
    .replace(/\bif\(/g, 'IF(')
    .replace(/\blt\(/g, 'LT(')
    .replace(/\bmin\(/g, 'Math.min(')
    .replace(/\bmax\(/g, 'Math.max(')
    .replace(/\bt\b/g, String(t))
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'IF',
    'LT',
    `return ${js}`
  ) as (IF: (c: number, a: number, b: number) => number, LT: (a: number, b: number) => number) => number
  return fn(
    (condition, whenTrue, whenFalse) => (condition ? whenTrue : whenFalse),
    (a, b) => (a < b ? 1 : 0)
  )
}
