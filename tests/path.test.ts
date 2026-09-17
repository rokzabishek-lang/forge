import { describe, it, expect } from 'vitest'
import { PATH_PRESETS, normalisePath, pathAt, pathExpression, presetById } from '@shared/render/path'

const P = (frame: number, x: number, y = 0): { frame: number; x: number; y: number } => ({ frame, x, y })

describe('normalisePath', () => {
  it('sorts by frame', () => {
    expect(normalisePath([P(30, 1), P(0, 0)], 60).map((p) => p.frame)).toEqual([0, 30])
  })

  it('keeps the later value when two land on one frame', () => {
    // Two positions at one instant is not a move, it is a contradiction.
    expect(normalisePath([P(10, 0.2), P(10, 0.8)], 60)).toEqual([P(10, 0.8)])
  })

  it('clamps waypoints into the clip', () => {
    const points = normalisePath([P(-20, 0), P(900, 1)], 60)
    expect(points[0].frame).toBe(0)
    expect(points[1].frame).toBe(60)
  })
})

describe('pathAt', () => {
  const path = [P(0, -1), P(60, 1)]

  it('interpolates linearly between waypoints', () => {
    expect(pathAt(path, 30, 60)!.x).toBeCloseTo(0, 6)
    expect(pathAt(path, 15, 60)!.x).toBeCloseTo(-0.5, 6)
  })

  it('holds before the first and after the last', () => {
    expect(pathAt(path, -5, 60)!.x).toBe(-1)
    expect(pathAt(path, 999, 60)!.x).toBe(1)
  })

  it('handles a single waypoint as a fixed offset', () => {
    expect(pathAt([P(10, 0.4)], 0, 60)!.x).toBe(0.4)
    expect(pathAt([P(10, 0.4)], 59, 60)!.x).toBe(0.4)
  })

  it('returns null for an empty path', () => {
    expect(pathAt([], 0, 60)).toBeNull()
  })
})

describe('pathExpression', () => {
  const options = { durationFrames: 60, fps: 30, startSeconds: 0, scale: 500, offset: 100 }

  it('is a constant for a single waypoint', () => {
    expect(pathExpression([P(0, 0.5)], 'x', options)).toBe('350.00')
  })

  it('interpolates between waypoints in timeline seconds', () => {
    const e = pathExpression([P(0, -1), P(60, 1)], 'x', options)
    // -1 -> offset 100 + (-1*500) = -400; +1 -> 600. Over t=0..2s.
    expect(e).toContain('-400.00')
    expect(e).toContain('1000.00')
    expect(e).toContain('2.0000')
  })

  it('offsets by where the clip sits on the timeline', () => {
    // A path is written in clip time; overlay's t is timeline time.
    const e = pathExpression([P(0, 0), P(30, 1)], 'x', { ...options, startSeconds: 5 })
    expect(e).toContain('5.0000')
    expect(e).toContain('6.0000')
  })

  it('clamps inside each segment so a late frame cannot overshoot', () => {
    expect(pathExpression([P(0, 0), P(30, 1)], 'x', options)).toContain('min(1,max(0,')
  })

  it('falls back to the resting offset with no waypoints', () => {
    expect(pathExpression([], 'x', options)).toBe('100.00')
  })

  it('survives two waypoints on the same frame without dividing by zero', () => {
    const e = pathExpression([P(10, 0), P(10, 1)], 'x', options)
    expect(e).not.toContain('NaN')
    expect(e).not.toContain('Infinity')
  })
})

describe('PATH_PRESETS', () => {
  it('every preset spans the clip it is built for', () => {
    for (const preset of PATH_PRESETS) {
      const points = preset.build(90)
      expect(points.length).toBeGreaterThanOrEqual(2)
      expect(points[0].frame).toBe(0)
      expect(points[points.length - 1].frame).toBe(89)
    }
  })

  it('survives a one-frame clip without an invalid path', () => {
    for (const preset of PATH_PRESETS) {
      const points = normalisePath(preset.build(1), 1)
      expect(points.every((p) => Number.isFinite(p.frame) && p.frame >= 0)).toBe(true)
      expect(points.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('entrances start off-frame and land at rest', () => {
    for (const id of ['in-left', 'in-right', 'in-top', 'in-bottom']) {
      const points = presetById(id)!.build(60)
      const first = points[0]
      const last = points[points.length - 1]
      expect(Math.max(Math.abs(first.x), Math.abs(first.y))).toBeGreaterThan(1)
      expect(Math.abs(last.x) + Math.abs(last.y)).toBeCloseTo(0, 6)
    }
  })

  it('exits do the reverse', () => {
    for (const id of ['out-left', 'out-right']) {
      const points = presetById(id)!.build(60)
      expect(Math.abs(points[0].x)).toBeCloseTo(0, 6)
      expect(Math.abs(points[points.length - 1].x)).toBeGreaterThan(1)
    }
  })

  it('keeps a drift small enough to read as a breath', () => {
    const points = presetById('drift-up')!.build(60)
    expect(Math.abs(points[0].y)).toBeLessThan(0.2)
  })
})
