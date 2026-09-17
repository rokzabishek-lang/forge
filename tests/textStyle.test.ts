import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TEXT_STYLE,
  TEXT_STYLES,
  gradientVector,
  paintForLine,
  textStyleById
} from '@shared/render/textStyle'
import { CAPTION_MARGIN } from '@shared/captions/ass'

/*
 * The style library.
 *
 * A style is a recipe and a font is a face — the whole point of keeping them
 * apart is that any style works with any font, so nothing here may quietly
 * depend on a particular family being installed.
 */

describe('the library', () => {
  it('has a default that exists', () => {
    expect(textStyleById(DEFAULT_TEXT_STYLE)).not.toBeNull()
  })

  it('has unique ids', () => {
    const ids = TEXT_STYLES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every style a name and a reason to exist', () => {
    for (const style of TEXT_STYLES) {
      expect(style.name.length, style.id).toBeGreaterThan(0)
      expect(style.description.length, style.id).toBeGreaterThan(10)
    }
  })

  it('never hard-requires a font that may not be installed', () => {
    // A style naming a family it cannot guarantee would be broken on a machine
    // without it. Styles vary weight, slant and size; the face stays the user's.
    for (const style of TEXT_STYLES) {
      expect(style.base.font, style.id).toBeUndefined()
      expect(style.accent?.font, style.id).toBeUndefined()
    }
  })

  it('keeps every gradient stop inside the ramp', () => {
    for (const style of TEXT_STYLES) {
      for (const paint of [style.base, style.accent]) {
        if (!paint?.fill || paint.fill.kind !== 'gradient') continue
        expect(paint.fill.stops.length, style.id).toBeGreaterThan(1)
        for (const stop of paint.fill.stops) {
          expect(stop.at, `${style.id} ${stop.color}`).toBeGreaterThanOrEqual(0)
          expect(stop.at).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('keeps sizes and opacities sane', () => {
    for (const style of TEXT_STYLES) {
      for (const paint of [style.base, style.accent]) {
        if (!paint) continue
        if (paint.sizeScale !== undefined) {
          expect(paint.sizeScale, style.id).toBeGreaterThan(0.1)
          expect(paint.sizeScale, style.id).toBeLessThanOrEqual(2)
        }
        if (paint.glow) {
          expect(paint.glow.opacity, style.id).toBeGreaterThan(0)
          expect(paint.glow.opacity, style.id).toBeLessThanOrEqual(1)
        }
        if (paint.stroke) expect(paint.stroke.width, style.id).toBeLessThan(0.2)
      }
    }
  })

  it('unknown ids resolve to nothing rather than throwing', () => {
    expect(textStyleById('not-a-style')).toBeNull()
    expect(textStyleById(undefined)).toBeNull()
  })
})

describe('paintForLine', () => {
  const withAccent = TEXT_STYLES.find((s) => s.accent)!
  const plain = TEXT_STYLES.find((s) => !s.accent)!

  it('gives the first line the base', () => {
    expect(paintForLine(withAccent, 0)).toBe(withAccent.base)
  })

  it('layers the accent over the base, rather than replacing it', () => {
    // An accent that only changes the fill must keep the base's glow and
    // shadow; replacing wholesale would silently drop half the style.
    const style = {
      id: 'x',
      name: 'x',
      description: 'x',
      base: {
        fill: { kind: 'solid' as const, color: '#fff' },
        glow: { blur: 0.4, color: '#fff', opacity: 0.5 }
      },
      accent: { fill: { kind: 'solid' as const, color: '#f00' } }
    }
    const second = paintForLine(style, 1)
    expect(second.fill).toEqual({ kind: 'solid', color: '#f00' })
    expect(second.glow).toEqual({ blur: 0.4, color: '#fff', opacity: 0.5 })
  })

  it('treats every line the same when there is no accent', () => {
    expect(paintForLine(plain, 3)).toBe(plain.base)
  })
})

describe('gradientVector', () => {
  it('runs top to bottom at 90 degrees', () => {
    const v = gradientVector(90, 100, 40)
    expect(Math.abs(v.x0)).toBeLessThan(0.001)
    expect(v.y0).toBeCloseTo(-20, 3)
    expect(v.y1).toBeCloseTo(20, 3)
  })

  it('runs left to right at 0 degrees', () => {
    const v = gradientVector(0, 100, 40)
    expect(v.x0).toBeCloseTo(-50, 3)
    expect(v.x1).toBeCloseTo(50, 3)
    expect(Math.abs(v.y0)).toBeLessThan(0.001)
  })

  it('spans the box rather than collapsing on a thin line', () => {
    const v = gradientVector(90, 400, 2)
    expect(v.y1 - v.y0).toBeCloseTo(2, 3)
  })
})

describe('the subtitle boundary', () => {
  it('keeps a margin on both sides', () => {
    // Six percent each side, so a caption never reaches the frame edge — where
    // a phone paints its own interface.
    expect(CAPTION_MARGIN).toBeGreaterThan(0.02)
    expect(CAPTION_MARGIN).toBeLessThan(0.15)
    expect(1 - CAPTION_MARGIN * 2).toBeGreaterThan(0.6)
  })
})

/*
 * The primitives added after the reference packs were looked at again.
 *
 * The first pass had fill, stroke, shadow and glow, which covers the colourful
 * half of those images and none of the structural half: the stacked 3D title,
 * the block behind a caption, the red line through a word, the split "broken"
 * look, hollow type, and — most of all — a single WORD styled differently from
 * the rest of its line.
 */
describe('the second vocabulary', () => {
  const has = (pick: (s: (typeof TEXT_STYLES)[number]) => unknown): number =>
    TEXT_STYLES.filter((s) => pick(s)).length

  it('covers every look the reference set needed', () => {
    expect(has((s) => s.base.extrude), 'stacked 3D').toBeGreaterThan(0)
    expect(has((s) => s.base.box || s.accent?.box), 'highlight block').toBeGreaterThan(0)
    expect(has((s) => s.base.line || s.accent?.line), 'strike / underline').toBeGreaterThan(0)
    expect(has((s) => s.base.split), 'glitch split').toBeGreaterThan(0)
    expect(has((s) => s.base.fill.kind === 'none'), 'hollow').toBeGreaterThan(0)
    expect(has((s) => s.accentScope === 'lastWord'), 'per-word accent').toBeGreaterThan(0)
    expect(has((s) => s.accentScope === 'firstWord'), 'per-word accent').toBeGreaterThan(0)
  })

  it('never leaves a word-scoped accent to also repaint whole lines', () => {
    // Otherwise a two-line caption gets the accent twice — once on the line and
    // again on its last word — which is two styles fighting, not one style.
    for (const style of TEXT_STYLES) {
      if (style.accentScope !== 'lastWord' && style.accentScope !== 'firstWord') continue
      expect(paintForLine(style, 1), style.id).toBe(style.base)
    }
  })

  it('keeps an extrusion shallow enough to stay on the frame', () => {
    for (const style of TEXT_STYLES) {
      const e = style.base.extrude
      if (!e) continue
      expect(Math.abs(e.dx) * e.steps, style.id).toBeLessThan(0.25)
      expect(Math.abs(e.dy) * e.steps, style.id).toBeLessThan(0.25)
    }
  })

  it('gives hollow type an outline, or it would be invisible', () => {
    for (const style of TEXT_STYLES) {
      if (style.base.fill.kind !== 'none') continue
      expect(style.base.stroke?.width, style.id).toBeGreaterThan(0)
    }
  })

  it('has grown well past the first pass', () => {
    expect(TEXT_STYLES.length).toBeGreaterThanOrEqual(40)
  })
})
