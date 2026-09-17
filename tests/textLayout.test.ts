import { describe, it, expect } from 'vitest'
import { layoutText, centreFix } from '@shared/render/textLayout'
import { DEFAULT_TEXT, TITLE_SAFE, type TextSpec } from '@shared/timeline'

const W = 1080
const H = 1920
const spec = (over: Partial<TextSpec> = {}): TextSpec => ({ ...DEFAULT_TEXT, version: 1, ...over })

/*
 * One placement rule, three consumers: the baked PNG, the SVG, and the box you
 * drag on the picture. They each used to work it out separately, which is how
 * the editing box came to sit somewhere the export did not.
 */
describe('layoutText', () => {
  it('sizes type against the canvas height, so it survives a resolution change', () => {
    expect(layoutText(spec({ size: 0.1 }), W, H).fontPx).toBe(192)
    expect(layoutText(spec({ size: 0.1 }), 1920, 1080).fontPx).toBe(108)
  })

  it('keeps the block inside the title-safe area at every position', () => {
    for (const position of ['top', 'center', 'lower'] as const) {
      const layout = layoutText(spec({ position }), W, H)
      expect(layout.top).toBeGreaterThanOrEqual(0)
      expect(layout.top + layout.blockHeight).toBeLessThanOrEqual(H)
    }
  })

  it('puts `lower` below `center`, and `center` below `top`', () => {
    const top = layoutText(spec({ position: 'top' }), W, H).top
    const middle = layoutText(spec({ position: 'center' }), W, H).top
    const lower = layoutText(spec({ position: 'lower' }), W, H).top
    expect(top).toBeLessThan(middle)
    expect(middle).toBeLessThan(lower)
  })

  it('anchors left, centre and right where each name says', () => {
    expect(layoutText(spec({ align: 'left' }), W, H).x).toBe(Math.round(W * TITLE_SAFE))
    expect(layoutText(spec({ align: 'center' }), W, H).x).toBe(W / 2)
    expect(layoutText(spec({ align: 'right' }), W, H).x).toBe(W - Math.round(W * TITLE_SAFE))
  })

  it('moves by a fraction of the canvas when dragged', () => {
    const base = layoutText(spec(), W, H)
    const moved = layoutText(spec({ offsetX: 0.25, offsetY: -0.1 }), W, H)
    expect(moved.x - base.x).toBe(W * 0.25)
    expect(moved.firstBaseline - base.firstBaseline).toBe(Math.round(-H * 0.1))
  })

  it('grows the block with every line', () => {
    const one = layoutText(spec({ content: 'one' }), W, H)
    const three = layoutText(spec({ content: 'one\ntwo\nthree' }), W, H)
    expect(three.lines).toHaveLength(3)
    expect(three.blockHeight).toBe(one.blockHeight * 3)
  })

  it('converts tracking from per-em to pixels', () => {
    // Per-em, so it scales with the type rather than with the canvas.
    const layout = layoutText(spec({ tracking: 0.2, size: 0.1 }), W, H)
    expect(layout.tracking).toBeCloseTo(layout.fontPx * 0.2, 5)
  })

  it('reports no shadow when it is switched off, rather than a zero one', () => {
    expect(layoutText(spec({ shadow: 0 }), W, H).shadow).toBeNull()
    expect(layoutText(spec({ shadow: 0.5 }), W, H).shadow?.opacity).toBe(0.5)
  })

  it('has a top that matches the first baseline, so a CSS box lines up', () => {
    const layout = layoutText(spec(), W, H)
    expect(layout.firstBaseline - layout.top).toBeCloseTo(layout.fontPx * 0.82, 5)
  })
})

describe('centreFix', () => {
  it('nudges only centred text, by half a tracking unit', () => {
    // Letter spacing adds a trailing gap after the last glyph, which drags
    // centred text left by half of it.
    const centred = layoutText(spec({ align: 'center', tracking: 0.2 }), W, H)
    expect(centreFix(centred)).toBeCloseTo(centred.tracking / 2, 5)

    for (const align of ['left', 'right'] as const) {
      expect(centreFix(layoutText(spec({ align, tracking: 0.2 }), W, H))).toBe(0)
    }
  })
})
