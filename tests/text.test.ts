import { describe, it, expect } from 'vitest'
import { buildTextSvg, buildSolidSvg, escapeXml } from '@shared/render/text'
import { DEFAULT_TEXT, TITLE_SAFE, type TextSpec } from '@shared/timeline'

const W = 1920
const H = 1080
const spec = (over: Partial<TextSpec> = {}): TextSpec => ({ ...DEFAULT_TEXT, version: 1, ...over })

/** Every y in the document, in order. */
const baselines = (svg: string): number[] =>
  [...svg.matchAll(/ y="(-?\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]))
const xs = (svg: string): number[] =>
  [...svg.matchAll(/<tspan x="(-?\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]))

describe('buildTextSvg', () => {
  it('sizes type against the canvas height, not in pixels', () => {
    // A title at 10% must be the same relative size on any canvas.
    expect(buildTextSvg(spec({ size: 0.1 }), W, H)).toContain('font-size="108"')
    expect(buildTextSvg(spec({ size: 0.1 }), 1080, 1920)).toContain('font-size="192"')
  })

  it('tracks letters, which is the whole cinematic lever', () => {
    // Verified against librsvg: letter-spacing really does widen the drawn span.
    const wide = buildTextSvg(spec({ tracking: 0.2, size: 0.1 }), W, H)
    expect(wide).toMatch(/letter-spacing="21\.\d+"/)
    expect(buildTextSvg(spec({ tracking: 0 }), W, H)).toContain('letter-spacing="0.00"')
  })

  it('uppercases when asked and leaves the text alone when not', () => {
    expect(buildTextSvg(spec({ content: 'hello', uppercase: true }), W, H)).toContain('HELLO')
    expect(buildTextSvg(spec({ content: 'hello', uppercase: false }), W, H)).toContain('hello')
  })

  it('uses a soft shadow rather than a hard stroke by default', () => {
    // The craft guidance is explicit that thick shadows and harsh strokes both
    // look poor, and a soft semi-transparent shadow is what lifts letters off
    // a busy background.
    const svg = buildTextSvg(spec(), W, H)
    expect(svg).toContain('feDropShadow')
    expect(svg).not.toContain('stroke-width')
  })

  it('omits the filter entirely at zero shadow', () => {
    expect(buildTextSvg(spec({ shadow: 0 }), W, H)).not.toContain('filter')
  })

  it('adds an outline only when asked', () => {
    const svg = buildTextSvg(spec({ stroke: 0.04 }), W, H)
    expect(svg).toContain('stroke-width')
    expect(svg).toContain('paint-order="stroke fill"')
  })

  it('keeps text inside the title-safe margin', () => {
    // SMPTE ST 2046-1: 90% of width and height, a 5% margin, since 2009.
    const left = xs(buildTextSvg(spec({ align: 'left' }), W, H))[0]
    const right = xs(buildTextSvg(spec({ align: 'right' }), W, H))[0]
    expect(left).toBe(Math.round(W * TITLE_SAFE))
    expect(right).toBe(W - Math.round(W * TITLE_SAFE))
  })

  it('places the block top, centre or lower third', () => {
    const top = baselines(buildTextSvg(spec({ position: 'top' }), W, H))[0]
    const centre = baselines(buildTextSvg(spec({ position: 'center' }), W, H))[0]
    const lower = baselines(buildTextSvg(spec({ position: 'lower' }), W, H))[0]
    expect(top).toBeLessThan(centre)
    expect(centre).toBeLessThan(lower)
    // Lower third stays off the very bottom edge.
    expect(lower).toBeLessThan(H - H * TITLE_SAFE + 1)
  })

  it('stacks multiple lines downward without overlapping', () => {
    const ys = baselines(buildTextSvg(spec({ content: 'one\ntwo\nthree' }), W, H))
    expect(ys.length).toBe(3)
    expect(ys[1] - ys[0]).toBeGreaterThan(0)
    expect(ys[1] - ys[0]).toBe(ys[2] - ys[1])
  })

  it('nudges centred text back by half a tracking unit', () => {
    // letter-spacing adds a trailing gap after the last glyph too, which drags
    // centred text left by half of it.
    const none = xs(buildTextSvg(spec({ tracking: 0 }), W, H))[0]
    const tracked = xs(buildTextSvg(spec({ tracking: 0.2 }), W, H))[0]
    expect(tracked).toBeGreaterThan(none)
  })

  it('survives an empty line rather than collapsing it', () => {
    expect(buildTextSvg(spec({ content: 'a\n\nb' }), W, H)).toMatch(/<tspan[^>]*> <\/tspan>/)
  })

  it('escapes characters that would break the document', () => {
    const svg = buildTextSvg(spec({ content: 'Tom & <Jerry>', uppercase: false }), W, H)
    expect(svg).toContain('Tom &amp; &lt;Jerry&gt;')
    expect(svg).not.toContain('<Jerry>')
  })

  it('does not default to pure white', () => {
    // #fff on a bright frame clips and the letterforms lose their edges.
    expect(DEFAULT_TEXT.color.toLowerCase()).not.toBe('#ffffff')
  })

  /*
   * Dragging text on the picture writes offsets. They have to move the drawn
   * PNG by the same fraction the overlay moved, or what you place is not what
   * renders.
   */
  describe('free positioning', () => {
    it('shifts by a fraction of the canvas, so it survives a resolution change', () => {
      const base = xs(buildTextSvg(spec(), W, H))[0]
      expect(xs(buildTextSvg(spec({ offsetX: 0.25 }), W, H))[0] - base).toBe(W * 0.25)

      const baseY = baselines(buildTextSvg(spec(), W, H))[0]
      expect(baselines(buildTextSvg(spec({ offsetY: -0.1 }), W, H))[0] - baseY).toBe(
        Math.round(-H * 0.1)
      )
    })

    it('leaves the anchored placement alone when nothing was dragged', () => {
      // Projects saved before free positioning have no offsets at all.
      const { offsetX: _x, offsetY: _y, ...legacy } = spec()
      expect(buildTextSvg(legacy as TextSpec, W, H)).toEqual(
        buildTextSvg(spec({ offsetX: 0, offsetY: 0 }), W, H)
      )
    })
  })
})

describe('buildSolidSvg', () => {
  it('fills the whole frame', () => {
    expect(buildSolidSvg('#112233', 1, W, H)).toContain('width="100%" height="100%"')
  })

  it('carries opacity so a card can be a wash', () => {
    expect(buildSolidSvg('#000', 0.4, W, H)).toContain('fill-opacity="0.400"')
  })

  it('clamps a nonsense opacity', () => {
    expect(buildSolidSvg('#000', 5, W, H)).toContain('fill-opacity="1.000"')
    expect(buildSolidSvg('#000', -2, W, H)).toContain('fill-opacity="0.000"')
  })
})

describe('escapeXml', () => {
  it('handles the characters that break SVG', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;')
  })
})
