import { describe, it, expect } from 'vitest'
import {
  MAX_PARALLAX_AMOUNT,
  MOVES,
  PARALLAX_FILL_FRACTION,
  PARALLAX_FLOOR,
  motionSourceRect,
  planeAmount
} from '@shared/render/motion'
import { MOTION_MOVES, type Motion } from '@shared/timeline'

const W = 1000
const H = 600

const rectAt = (motion: Motion, p: number, t = 0): ReturnType<typeof motionSourceRect> =>
  motionSourceRect(motion, p, t, W, H)

describe('motionSourceRect', () => {
  it('covers every named move', () => {
    for (const move of MOTION_MOVES) expect(MOVES[move]).toBeDefined()
  })

  it('never leaves the source', () => {
    // A rectangle that runs off the edge renders as a black bar mid-move, and
    // only at the frames where it happens — which is exactly the kind of bug
    // that survives a spot check.
    for (const direction of MOTION_MOVES) {
      const motion: Motion = { kind: 'kenburns', direction, amount: 0.5 }
      for (const p of [0, 0.25, 0.5, 0.75, 1]) {
        const r = rectAt(motion, p)
        expect(r.sx).toBeGreaterThanOrEqual(-0.001)
        expect(r.sy).toBeGreaterThanOrEqual(-0.001)
        expect(r.sx + r.sw).toBeLessThanOrEqual(W + 0.001)
        expect(r.sy + r.sh).toBeLessThanOrEqual(H + 0.001)
      }
    }
  })

  it('tightens on a push and widens on a pull', () => {
    const push: Motion = { kind: 'kenburns', direction: 'in', amount: 0.3 }
    expect(rectAt(push, 1).sw).toBeLessThan(rectAt(push, 0).sw)

    const pull: Motion = { kind: 'kenburns', direction: 'out', amount: 0.3 }
    expect(rectAt(pull, 1).sw).toBeGreaterThan(rectAt(pull, 0).sw)
  })

  it('holds the zoom on a pan, so there is margin to pan into', () => {
    const pan: Motion = { kind: 'kenburns', direction: 'panRight', amount: 0.2 }
    const start = rectAt(pan, 0)
    const end = rectAt(pan, 1)
    // At zoom 1 the margin is zero and the move is silently a no-op.
    expect(start.sw).toBeCloseTo(end.sw, 6)
    expect(start.sw).toBeLessThan(W)
    expect(end.sx).toBeGreaterThan(start.sx)
  })

  it('pans each direction the way its name says', () => {
    const at = (direction: 'panLeft' | 'panUp' | 'panDown', p: number) =>
      rectAt({ kind: 'kenburns', direction, amount: 0.2 }, p)
    expect(at('panLeft', 1).sx).toBeLessThan(at('panLeft', 0).sx)
    expect(at('panUp', 1).sy).toBeLessThan(at('panUp', 0).sy)
    expect(at('panDown', 1).sy).toBeGreaterThan(at('panDown', 0).sy)
  })

  it('drifts while zooming on the compound moves', () => {
    const left: Motion = { kind: 'kenburns', direction: 'inLeft', amount: 0.3 }
    const centred: Motion = { kind: 'kenburns', direction: 'in', amount: 0.3 }
    // Same zoom, different centre.
    expect(rectAt(left, 1).sw).toBeCloseTo(rectAt(centred, 1).sw, 6)
    expect(rectAt(left, 1).sx).toBeLessThan(rectAt(centred, 1).sx)
  })

  it('oscillates on a shake, and repeats once per cycle', () => {
    const shake: Motion = { kind: 'shake', amount: 0.12, hz: 10 }
    const a = motionSourceRect(shake, 0, 0, W, H)
    const quarter = motionSourceRect(shake, 0, 0.025, W, H)
    const cycle = motionSourceRect(shake, 0, 0.1, W, H)
    expect(quarter.sx).not.toBeCloseTo(a.sx, 2)
    expect(cycle.sx).toBeCloseTo(a.sx, 4)
    // Held zoom throughout, so a shake never exposes an edge.
    expect(cycle.sw).toBeCloseTo(a.sw, 6)
  })

  it('clamps a runaway amount rather than leaving the frame', () => {
    const wild: Motion = { kind: 'kenburns', direction: 'in', amount: 40 }
    const r = rectAt(wild, 1)
    expect(r.sw).toBeGreaterThan(0)
    expect(r.sx + r.sw).toBeLessThanOrEqual(W + 0.001)
  })
})

describe('planeAmount', () => {
  it('gives the back plane a floor and the front the full move', () => {
    const modest = 0.1 // Below the cap, so nothing is clipped.
    expect(planeAmount(modest, 0)).toBeCloseTo(modest * PARALLAX_FLOOR, 6)
    expect(planeAmount(modest, 1)).toBeCloseTo(modest, 6)
  })

  it('caps the spread at what the baked fill band can cover', () => {
    // Past this the nearest plane slides off its own filled edge and exposes
    // the hole it exists to cover — so the motion slider may ask for more
    // travel than parallax is allowed to give.
    expect(planeAmount(0.5, 1)).toBeCloseTo(MAX_PARALLAX_AMOUNT, 6)
    expect(planeAmount(0.5, 1)).toBeLessThan(0.5)
  })

  it('keeps the widest spread inside the fill band it was derived from', () => {
    const spread = planeAmount(99, 1) - planeAmount(99, 0)
    // A point at the frame edge displaces by about half the spread.
    expect(spread / 2).toBeLessThanOrEqual(PARALLAX_FILL_FRACTION + 1e-9)
  })

  it('is monotonic in depth — that ratio is the whole effect', () => {
    let previous = -1
    for (const depth of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const value = planeAmount(0.2, depth)
      expect(value).toBeGreaterThan(previous)
      previous = value
    }
  })

  it('clamps depth rather than extrapolating past the front plane', () => {
    expect(planeAmount(0.2, 4)).toBeCloseTo(planeAmount(0.2, 1), 6)
    expect(planeAmount(0.2, -3)).toBeCloseTo(planeAmount(0.2, 0), 6)
  })

  it('separates the planes enough to read as depth, not as an uneven zoom', () => {
    // The first build used a 2.2x spread and looked like a wobbly Ken Burns.
    expect(planeAmount(0.1, 1) / planeAmount(0.1, 0)).toBeGreaterThan(3)
  })

  it('makes near planes travel visibly further than far ones', () => {
    const back = motionSourceRect(
      { kind: 'kenburns', direction: 'in', amount: 0.3 }, 1, 0, W, H, planeAmount(0.3, 0)
    )
    const front = motionSourceRect(
      { kind: 'kenburns', direction: 'in', amount: 0.3 }, 1, 0, W, H, planeAmount(0.3, 1)
    )
    // The front plane ends up showing less of itself, i.e. it zoomed further.
    expect(front.sw).toBeLessThan(back.sw)
  })
})
