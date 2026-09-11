import { describe, it, expect } from 'vitest'
import {
  valueAt,
  applyEasing,
  transformAt,
  layersAt,
  layerVisibleAt,
  popIn,
  IDENTITY_TRANSFORM,
  type GraphicsSpec,
  type TextLayer
} from '@shared/graphics/spec'

function text(over: Partial<TextLayer> = {}): TextLayer {
  return {
    id: 't1', kind: 'text', text: 'Forge',
    startFrame: 0, endFrame: 30,
    fontFamily: 'Anton', fontSize: 80, color: '#fff',
    anchorX: 0.5, anchorY: 0.5, align: 'center',
    transform: IDENTITY_TRANSFORM,
    ...over
  }
}

describe('valueAt', () => {
  it('returns constants unchanged', () => {
    expect(valueAt(42, 0)).toBe(42)
    expect(valueAt(42, 999)).toBe(42)
  })

  it('interpolates linearly between keyframes', () => {
    const keys = [{ frame: 0, value: 0 }, { frame: 10, value: 100 }]
    expect(valueAt(keys, 0)).toBe(0)
    expect(valueAt(keys, 5)).toBe(50)
    expect(valueAt(keys, 10)).toBe(100)
  })

  it('holds the first and last values outside the keyframe range', () => {
    const keys = [{ frame: 10, value: 5 }, { frame: 20, value: 15 }]
    // A property must always be defined; undefined silently collapses a layer.
    expect(valueAt(keys, 0)).toBe(5)
    expect(valueAt(keys, 999)).toBe(15)
  })

  it('walks multi-segment keyframes', () => {
    const keys = [
      { frame: 0, value: 0 },
      { frame: 10, value: 100 },
      { frame: 20, value: 50 }
    ]
    expect(valueAt(keys, 15)).toBe(75)
  })

  it('survives degenerate input', () => {
    expect(valueAt([], 5)).toBe(0)
    expect(valueAt([{ frame: 3, value: 7 }], 99)).toBe(7)
    // At or before the first keyframe the first value holds, duplicates included.
    expect(valueAt([{ frame: 5, value: 1 }, { frame: 5, value: 9 }], 5)).toBe(1)
    // A zero-length segment mid-sequence must step, not divide by zero.
    const stepped = [
      { frame: 0, value: 0 },
      { frame: 10, value: 1 },
      { frame: 10, value: 5 },
      { frame: 20, value: 9 }
    ]
    expect(Number.isFinite(valueAt(stepped, 10))).toBe(true)
    expect(valueAt(stepped, 10)).toBe(1)
    expect(valueAt(stepped, 15)).toBeCloseTo(7, 5)
  })

  it('is deterministic — the same frame always yields the same value', () => {
    const keys = [{ frame: 0, value: 0 }, { frame: 24, value: 1, easing: 'backOut' as const }]
    const first = Array.from({ length: 25 }, (_, f) => valueAt(keys, f))
    const second = Array.from({ length: 25 }, (_, f) => valueAt(keys, f))
    expect(first).toEqual(second)
  })
})

describe('applyEasing', () => {
  it('pins both ends for every curve', () => {
    for (const easing of ['linear', 'easeIn', 'easeOut', 'easeInOut', 'backOut'] as const) {
      expect(applyEasing(0, easing)).toBeCloseTo(0, 5)
      expect(applyEasing(1, easing)).toBeCloseTo(1, 5)
    }
  })

  it('clamps input outside 0..1', () => {
    expect(applyEasing(-3, 'linear')).toBe(0)
    expect(applyEasing(7, 'linear')).toBe(1)
  })

  it('overshoots for backOut, which is what makes the pop read', () => {
    const peak = Math.max(...Array.from({ length: 99 }, (_, i) => applyEasing(i / 98, 'backOut')))
    expect(peak).toBeGreaterThan(1)
  })
})

describe('layer visibility', () => {
  it('treats the end frame as exclusive', () => {
    const layer = text({ startFrame: 10, endFrame: 20 })
    expect(layerVisibleAt(layer, 9)).toBe(false)
    expect(layerVisibleAt(layer, 10)).toBe(true)
    expect(layerVisibleAt(layer, 19)).toBe(true)
    expect(layerVisibleAt(layer, 20)).toBe(false)
  })

  it('selects only the layers live at a frame', () => {
    const spec: GraphicsSpec = {
      width: 1080, height: 1920, fps: 30, durationFrames: 90,
      layers: [
        text({ id: 'a', startFrame: 0, endFrame: 30 }),
        text({ id: 'b', startFrame: 30, endFrame: 60 })
      ]
    }
    expect(layersAt(spec, 15).map((l) => l.id)).toEqual(['a'])
    expect(layersAt(spec, 45).map((l) => l.id)).toEqual(['b'])
    expect(layersAt(spec, 75)).toHaveLength(0)
  })
})

describe('transformAt', () => {
  it('resolves every property', () => {
    const t = transformAt(popIn(0, 6), 0)
    expect(t.scale).toBeCloseTo(0.6, 5)
    expect(t.opacity).toBe(0)
    expect(t.x).toBe(0)
  })

  it('settles a pop-in to rest', () => {
    const t = transformAt(popIn(0, 6), 30)
    expect(t.scale).toBeCloseTo(1, 5)
    expect(t.opacity).toBe(1)
  })

  it('offsets a pop-in to the layer start frame', () => {
    const t = transformAt(popIn(100, 6), 100)
    expect(t.scale).toBeCloseTo(0.6, 5)
  })
})
