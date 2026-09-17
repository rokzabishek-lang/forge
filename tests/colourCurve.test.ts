import { describe, it, expect } from 'vitest'
import {
  curveAt,
  applyCurves,
  curveArgument,
  curvesFilter,
  normaliseCurve,
  isIdentityCurve,
  isNeutralCurves,
  sampleCurves,
  IDENTITY,
  type CurvePoint
} from '@shared/render/colourCurve'

/** The probe curve: lifts the midpoint from 0.5 to 0.75. */
const LIFT: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0.75 },
  { x: 1, y: 1 }
]

describe('curveAt', () => {
  /*
   * The number that decides whether the preview can be trusted.
   *
   * ffmpeg interpolates with a natural cubic spline, not linearly. Rendering a
   * grey pixel through LIFT on the actual binary returned 0xEB — 235/255 =
   * 0.9216 — where a straight line between the key points would have given
   * 0.875. If this assertion ever fails, the preview and the export have
   * stopped agreeing.
   */
  it('matches the binary: a spline, not a straight line', () => {
    expect(curveAt(LIFT, 0.75)).toBeCloseTo(0.921875, 5)
    expect(curveAt(LIFT, 0.75)).not.toBeCloseTo(0.875, 2)
  })

  it('passes through every key point it was given', () => {
    for (const point of LIFT) expect(curveAt(LIFT, point.x)).toBeCloseTo(point.y, 6)
  })

  it('leaves everything alone on the identity', () => {
    for (const x of [0, 0.1, 0.37, 0.5, 0.92, 1]) {
      expect(curveAt(IDENTITY, x)).toBeCloseTo(x, 6)
    }
  })

  it('is a straight line through two arbitrary points', () => {
    // Two points cannot bend; a spline through them must stay linear.
    const line: CurvePoint[] = [
      { x: 0, y: 0.2 },
      { x: 1, y: 0.8 }
    ]
    expect(curveAt(line, 0.5)).toBeCloseTo(0.5, 6)
  })

  it('never leaves 0..1, however far the spline overshoots', () => {
    // A spline through steep points genuinely overshoots; clipping is what
    // ffmpeg does and what stops a highlight going negative.
    const steep: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 0.1, y: 0.95 },
      { x: 0.9, y: 0.05 },
      { x: 1, y: 1 }
    ]
    for (let i = 0; i <= 100; i++) {
      const v = curveAt(steep, i / 100)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('holds flat outside the points rather than extrapolating', () => {
    const partial: CurvePoint[] = [
      { x: 0.25, y: 0.4 },
      { x: 0.75, y: 0.6 }
    ]
    expect(curveAt(partial, 0)).toBeCloseTo(0.4, 6)
    expect(curveAt(partial, 1)).toBeCloseTo(0.6, 6)
  })
})

describe('normaliseCurve', () => {
  it('sorts and anchors both ends', () => {
    const curve = normaliseCurve([{ x: 0.6, y: 0.3 }])
    expect(curve[0].x).toBe(0)
    expect(curve[curve.length - 1].x).toBe(1)
  })

  it('keeps one output per input', () => {
    const curve = normaliseCurve([
      { x: 0.5, y: 0.2 },
      { x: 0.5, y: 0.9 }
    ])
    expect(curve.filter((p) => Math.abs(p.x - 0.5) < 1e-6)).toHaveLength(1)
  })

  it('clamps points dragged outside the box', () => {
    for (const p of normaliseCurve([{ x: -0.5, y: 2 }, { x: 1.4, y: -3 }])) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(1)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(1)
    }
  })

  it('gives the identity back for an empty curve', () => {
    expect(normaliseCurve([])).toEqual(IDENTITY)
  })
})

describe('applyCurves', () => {
  /*
   * Order, measured: a red curve on grey gave 0xC0. The same curve added as
   * master gave 0xEB — which is master evaluated at 0.75, not at 0.5. So the
   * per-channel curve runs first and master goes on top of its result.
   */
  it('applies the channel curve first and master on top', () => {
    const [r, g, b] = applyCurves({ r: LIFT, master: LIFT }, [0.5, 0.5, 0.5])
    expect(r).toBeCloseTo(0.921875, 4)
    expect(g).toBeCloseTo(0.75, 4)
    expect(b).toBeCloseTo(0.75, 4)
  })

  it('touches only the channel it was given', () => {
    const [r, g, b] = applyCurves({ r: LIFT }, [0.5, 0.5, 0.5])
    expect(r).toBeCloseTo(0.75, 4)
    expect(g).toBeCloseTo(0.5, 6)
    expect(b).toBeCloseTo(0.5, 6)
  })

  it('leaves a colour untouched with nothing set', () => {
    expect(applyCurves(undefined, [0.2, 0.5, 0.9])).toEqual([0.2, 0.5, 0.9])
    expect(applyCurves({ master: IDENTITY }, [0.2, 0.5, 0.9])).toEqual([0.2, 0.5, 0.9])
  })
})

describe('curvesFilter', () => {
  it('is null when nothing would change, so the render pays nothing', () => {
    expect(curvesFilter(undefined)).toBeNull()
    expect(curvesFilter({ master: IDENTITY, r: IDENTITY })).toBeNull()
  })

  it('writes the points in the format the filter parses', () => {
    expect(curveArgument(LIFT)).toBe('0.0000/0.0000 0.5000/0.7500 1.0000/1.0000')
  })

  it('names each channel the way ffmpeg does', () => {
    const filter = curvesFilter({ master: LIFT, r: LIFT, g: LIFT, b: LIFT })!
    expect(filter).toContain("master='")
    expect(filter).toContain("r='")
    expect(filter).toContain("g='")
    expect(filter).toContain("b='")
  })

  it('leaves out the channels that do nothing', () => {
    const filter = curvesFilter({ r: LIFT, g: IDENTITY })!
    expect(filter).toContain("r='")
    expect(filter).not.toContain("g='")
  })
})

describe('isIdentityCurve', () => {
  it('spots a curve that changes nothing', () => {
    expect(isIdentityCurve(undefined)).toBe(true)
    expect(isIdentityCurve([])).toBe(true)
    expect(isIdentityCurve(IDENTITY)).toBe(true)
    expect(isNeutralCurves({ master: IDENTITY, b: IDENTITY })).toBe(true)
  })

  it('spots one that does', () => {
    expect(isIdentityCurve(LIFT)).toBe(false)
    expect(isNeutralCurves({ master: IDENTITY, b: LIFT })).toBe(false)
  })
})

describe('sampleCurves', () => {
  it('builds a full 256-entry table', () => {
    expect(sampleCurves({ master: LIFT })).toHaveLength(256 * 4)
  })

  it('agrees with curveAt at every level', () => {
    // The GPU reads this table; if it drifts from the maths the preview lies.
    const table = sampleCurves({ master: LIFT })
    for (const i of [0, 64, 128, 191, 255]) {
      expect(table[i * 4]).toBe(Math.round(curveAt(LIFT, i / 255) * 255))
    }
  })

  it('is a straight ramp for the identity', () => {
    const table = sampleCurves(undefined)
    for (const i of [0, 100, 255]) expect(table[i * 4]).toBe(i)
  })
})
