import { describe, it, expect } from 'vitest'
import { keysFromStroke, MAX_DRAWN_KEYS, type Sample } from '@shared/render/curve'
import { valueAt } from '@shared/render/keyframes'

const DURATION = 120

/** Sample a shape at every frame, as a drawn stroke would arrive. */
function stroke(shape: (t: number) => number, frames = DURATION): Sample[] {
  return Array.from({ length: frames + 1 }, (_, frame) => ({
    frame,
    value: shape(frame / frames)
  }))
}

/** Largest gap between the drawn shape and what the keys reproduce. */
function worstError(keys: ReturnType<typeof keysFromStroke>, shape: (t: number) => number): number {
  let worst = 0
  for (let frame = 0; frame <= DURATION; frame++) {
    const got = valueAt(keys, frame, DURATION, 0)
    worst = Math.max(worst, Math.abs(got - shape(frame / DURATION)))
  }
  return worst
}

describe('keysFromStroke', () => {
  it('reduces a straight line to its two ends', () => {
    // Every sample in between is on the line, so none of them earns a key.
    const keys = keysFromStroke(stroke((t) => t), DURATION, 1)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toMatchObject({ frame: 0, value: 0 })
    expect(keys[1]).toMatchObject({ frame: DURATION, value: 1 })
  })

  it('keeps the bend in a curve', () => {
    const shape = (t: number): number => t * t
    const keys = keysFromStroke(stroke(shape), DURATION, 1)
    expect(keys.length).toBeGreaterThan(2)
    expect(worstError(keys, shape)).toBeLessThan(0.06)
  })

  it('keeps the corner in a shape that changes direction', () => {
    // Up then down. Simplifying this to a straight line would silently throw
    // away the whole instruction.
    const shape = (t: number): number => (t < 0.5 ? t * 2 : 2 - t * 2)
    const keys = keysFromStroke(stroke(shape), DURATION, 1)
    const peak = keys.reduce((a, b) => (a.value > b.value ? a : b))
    expect(peak.value).toBeGreaterThan(0.9)
    expect(peak.frame).toBeGreaterThan(DURATION * 0.4)
    expect(peak.frame).toBeLessThan(DURATION * 0.6)
  })

  it('follows a wave closely enough to be worth drawing', () => {
    const shape = (t: number): number => 0.5 + 0.5 * Math.sin(t * Math.PI * 2)
    expect(worstError(keysFromStroke(stroke(shape), DURATION, 1), shape)).toBeLessThan(0.08)
  })

  it('means the same thing whatever units the property uses', () => {
    /*
     * Tolerance is a fraction of the range, so rotation in degrees is simplified
     * as readily as opacity in 0..1 — otherwise a 360-wide property would keep
     * every sample and a 1-wide one would keep none.
     */
    const small = keysFromStroke(stroke((t) => t * t), DURATION, 1)
    const large = keysFromStroke(stroke((t) => t * t * 360), DURATION, 360)
    expect(Math.abs(small.length - large.length)).toBeLessThanOrEqual(1)
  })

  it('never returns more keys than a person could manage', () => {
    // A shaky hand on a noisy stroke must not produce ninety keyframes.
    const noisy = stroke((t) => 0.5 + 0.4 * Math.sin(t * 60) * Math.cos(t * 23))
    expect(keysFromStroke(noisy, DURATION, 1).length).toBeLessThanOrEqual(MAX_DRAWN_KEYS)
  })

  describe('awkward input', () => {
    it('gives nothing back for nothing', () => {
      expect(keysFromStroke([], DURATION, 1)).toEqual([])
    })

    it('treats a single touch as one key', () => {
      expect(keysFromStroke([{ frame: 30, value: 0.4 }], DURATION, 1)).toHaveLength(1)
    })

    it('sorts a stroke drawn right to left', () => {
      const keys = keysFromStroke(stroke((t) => t).reverse(), DURATION, 1)
      expect(keys[0].frame).toBeLessThan(keys[keys.length - 1].frame)
    })

    it('keeps one value per frame when the hand doubles back', () => {
      const wobbly: Sample[] = [
        { frame: 0, value: 0 },
        { frame: 10, value: 0.5 },
        { frame: 10, value: 0.7 },
        { frame: 20, value: 1 }
      ]
      const keys = keysFromStroke(wobbly, DURATION, 1)
      expect(new Set(keys.map((k) => k.frame)).size).toBe(keys.length)
    })

    it('clamps a stroke that ran off the ends of the clip', () => {
      const keys = keysFromStroke(
        [
          { frame: -50, value: 0 },
          { frame: DURATION + 90, value: 1 }
        ],
        DURATION,
        1
      )
      for (const key of keys) {
        expect(key.frame).toBeGreaterThanOrEqual(0)
        expect(key.frame).toBeLessThanOrEqual(DURATION)
      }
    })

    it('survives a very long stroke without blowing the stack', () => {
      // A fast pointer on a long drag is thousands of samples, and failing by
      // crashing mid-draw is not something anyone could interpret.
      const long = Array.from({ length: 20_000 }, (_, i) => ({
        frame: (i / 20_000) * DURATION,
        value: Math.sin(i / 300)
      }))
      expect(() => keysFromStroke(long, DURATION, 2)).not.toThrow()
    })
  })

  it('carries the easing onto every key it makes', () => {
    for (const key of keysFromStroke(stroke((t) => t * t), DURATION, 1, 'linear')) {
      expect(key.ease).toBe('linear')
    }
  })
})
