import { describe, it, expect } from 'vitest'
import { classifyMask, maskMetrics } from '@shared/transitions/classify'

const SIZE = 32

/** Row-major grayscale built from a function of normalised x,y. */
function build(f: (x: number, y: number) => number): Uint8Array {
  const g = new Uint8Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      g[y * SIZE + x] = Math.max(0, Math.min(255, Math.round(f(x / (SIZE - 1), y / (SIZE - 1)) * 255)))
    }
  }
  return g
}

describe('classifyMask', () => {
  it('reads a left-to-right ramp as a right wipe', () => {
    expect(classifyMask(build((x) => x), SIZE)).toContain('wipe-right')
  })

  it('reads a right-to-left ramp as a left wipe', () => {
    expect(classifyMask(build((x) => 1 - x), SIZE)).toContain('wipe-left')
  })

  it('reads vertical ramps as up and down wipes', () => {
    expect(classifyMask(build((_x, y) => y), SIZE)).toContain('wipe-down')
    expect(classifyMask(build((_x, y) => 1 - y), SIZE)).toContain('wipe-up')
  })

  it('reads a bright centre as opening outward', () => {
    // Bright pixels flip first, so a bright middle opens from the middle.
    const tags = classifyMask(build((x, y) => 1 - Math.hypot(x - 0.5, y - 0.5) * 2), SIZE)
    expect(tags).toContain('iris-out')
  })

  it('reads a dark centre as closing inward', () => {
    expect(classifyMask(build((x, y) => Math.hypot(x - 0.5, y - 0.5) * 2), SIZE)).toContain('iris-in')
  })

  it('finds a grid of cells', () => {
    // 4x4 checker of bright blocks — 8 islands, the shape of a tile reveal.
    const tags = classifyMask(
      build((x, y) => ((Math.floor(x * 4) + Math.floor(y * 4)) % 2 === 0 ? 1 : 0)),
      SIZE
    )
    expect(tags.some((t) => t === 'grid' || t === 'blinds')).toBe(true)
  })

  it('tells a smooth ramp from a hard-edged one', () => {
    expect(classifyMask(build((x) => x), SIZE)).toContain('soft')
    expect(classifyMask(build((x) => (x < 0.5 ? 0 : 1)), SIZE)).toContain('hard')
  })

  it('does not call a plain ramp a grid', () => {
    // A ramp has exactly one bright region; calling it cellular would put every
    // wipe in the library under "grid" and make the tag useless.
    expect(maskMetrics(build((x) => x), SIZE).islands).toBeLessThan(3)
  })

  it('survives a blank mask without inventing a direction', () => {
    const tags = classifyMask(build(() => 0.5), SIZE)
    expect(tags).not.toContain('wipe-left')
    expect(tags).not.toContain('wipe-right')
    expect(tags).not.toContain('iris-in')
  })

  it('always says something about the edge', () => {
    for (const f of [(x: number) => x, () => 0.5, (x: number, y: number) => Math.hypot(x, y)]) {
      const tags = classifyMask(build(f), SIZE)
      expect(tags.some((t) => t === 'soft' || t === 'hard')).toBe(true)
    }
  })
})
