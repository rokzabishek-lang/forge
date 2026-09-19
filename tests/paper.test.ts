import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PAPER,
  PAPER_LOOKS,
  layoutClipping,
  paperFrameAt,
  paperFrames,
  paperLookById,
  clippingCount,
  MAX_CLIPPINGS,
  seeded,
  type Measure,
  type PaperSpec
} from '@shared/render/paper'

/*
 * A newspaper clipping, as measurements rather than as a picture.
 *
 * The reason this is worth testing without a canvas: a clipping is a dozen
 * interacting numbers, and every way of getting them wrong looks plausible.
 * A highlight one line too high is a highlight. Columns that overflow the page
 * are columns. The only way to know is to assert where things are.
 */

const W = 1080
const H = 1920

/**
 * A monospace measurer.
 *
 * Deterministic and independent of any font actually being installed, which is
 * the point — these assertions are about the layout arithmetic, not about
 * Playfair's metrics. Bold is a little wider, as it is in reality.
 */
const measure: Measure = (text, fontPx, _family, bold) =>
  text.length * fontPx * (bold ? 0.58 : 0.5)

const spec = (over: Partial<PaperSpec> = {}): PaperSpec => ({
  ...DEFAULT_PAPER,
  keyword: 'FORGE',
  ...over
})

describe('seeded', () => {
  it('gives the same run twice', () => {
    const a = Array.from({ length: 8 }, seeded(42))
    const b = Array.from({ length: 8 }, seeded(42))
    expect(a).toEqual(b)
  })

  it('gives different runs for different seeds', () => {
    expect(Array.from({ length: 8 }, seeded(1))).not.toEqual(Array.from({ length: 8 }, seeded(2)))
  })

  it('stays inside 0..1', () => {
    const rand = seeded(7)
    for (let i = 0; i < 500; i++) {
      const v = rand()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('layoutClipping', () => {
  it('is the same clipping every time for a given seed', () => {
    /*
     * Not a nicety. The preview and the export bake separately, so anything
     * random would put a different page on screen from the one in the file —
     * and re-baking after an unrelated edit would silently reshuffle every
     * page in the run.
     */
    const a = layoutClipping(spec(), 2, W, H, measure)
    const b = layoutClipping(spec(), 2, W, H, measure)
    expect(a).toEqual(b)
  })

  it('gives each clipping in a run its own page', () => {
    const first = layoutClipping(spec(), 0, W, H, measure)
    const second = layoutClipping(spec(), 1, W, H, measure)
    expect(second.masthead.text).not.toBe(first.masthead.text)
    expect(second.box).not.toEqual(first.box)
  })

  it('puts the highlight ON the keyword', () => {
    /*
     * The assertion the whole thing turns on. The marker has to cover the
     * keyword and roughly nothing else — a box over the wrong words still
     * looks deliberate, which is why nobody would notice it by eye.
     */
    const clip = layoutClipping(spec({ keyword: 'FORGE' }), 0, W, H, measure)
    expect(clip.highlight).not.toBeNull()
    const px = clip.headline.fontPx
    // Five characters, bold, at the headline size.
    expect(clip.highlight!.w).toBeCloseTo(5 * px * 0.58 + px * 0.08, 3)

    // And it sits on the line that actually carries the word.
    const carrier = clip.headline.lines.find((l) => l.text.includes('FORGE'))
    expect(carrier).toBeDefined()
    const centre = clip.highlight!.y + clip.highlight!.h / 2
    expect(Math.abs(centre - (carrier!.y - px * 0.29))).toBeLessThan(px * 0.1)
  })

  it('finds the keyword on a LATER line when the headline wraps', () => {
    /*
     * The bug this guards is specific: searching the joined headline finds the
     * right characters and the wrong line, so the highlight lands one row up
     * as soon as the headline is long enough to wrap. A long keyword forces
     * the wrap.
     */
    const clip = layoutClipping(spec({ keyword: 'EXTRAORDINARY' }), 0, W, H, measure)
    expect(clip.headline.lines.length).toBeGreaterThan(1)
    expect(clip.highlight).not.toBeNull()
    const carrier = clip.headline.lines.findIndex((l) => l.text.includes('EXTRAORDINARY'))
    expect(carrier).toBeGreaterThanOrEqual(0)
    const centre = clip.highlight!.y + clip.highlight!.h / 2
    // Nearest line to the highlight must BE the carrier, not the one above it.
    const distances = clip.headline.lines.map((l) => Math.abs(l.y - centre))
    expect(distances.indexOf(Math.min(...distances))).toBe(carrier)
  })

  it('reports no highlight rather than guessing one', () => {
    // An empty keyword cannot be found, and a box drawn anyway would be a
    // marker stripe across an arbitrary word.
    const clip = layoutClipping(spec({ keyword: '' }), 0, W, H, measure)
    expect(clip.highlight).toBeNull()
  })

  it('uppercases the keyword when the look uppercases the headline', () => {
    const clip = layoutClipping(spec({ keyword: 'forge', lookId: 'tabloid' }), 0, W, H, measure)
    expect(clip.look.uppercaseHeadline).toBe(true)
    expect(clip.headline.lines.every((l) => l.text === l.text.toUpperCase())).toBe(true)
    // …and still finds it, which a case-sensitive search after uppercasing
    // the headline would not.
    expect(clip.highlight).not.toBeNull()
  })

  it('keeps everything inside the page', () => {
    for (let i = 0; i < 6; i++) {
      const clip = layoutClipping(spec(), i, W, H, measure)
      const right = clip.box.x + clip.box.w
      const bottom = clip.box.y + clip.box.h
      for (const column of clip.columns) {
        expect(column.x).toBeGreaterThanOrEqual(clip.box.x)
        expect(column.x + column.w).toBeLessThanOrEqual(right + 0.5)
        for (const line of column.lines) {
          expect(line.y).toBeLessThanOrEqual(bottom)
          const last = line.words.at(-1)
          if (last) expect(last.x + last.w).toBeLessThanOrEqual(column.x + column.w + 1)
        }
      }
      for (const line of clip.headline.lines) expect(line.y).toBeLessThan(bottom)
    }
  })

  it('always leaves room for the story under the headline', () => {
    /*
     * The bug this is named after: the headline size was a fixed fraction of
     * the page, so a long one wrapped to six lines, ate the whole clipping,
     * and the body columns came out with ZERO rows. The page still looked
     * like a page — masthead, rules, a big headline — so a headline with no
     * story under it read as a design choice rather than as a layout failure.
     *
     * Checked across every look and several indices, because the headline
     * template and the face both change with them and the faces are not the
     * same width.
     */
    for (const look of PAPER_LOOKS) {
      for (let i = 0; i < 6; i++) {
        const clip = layoutClipping(
          spec({ lookId: look.id, keyword: 'EXTRAORDINARY' }),
          i,
          W,
          H,
          measure
        )
        expect(clip.headline.lines.length).toBeLessThanOrEqual(3)
        const rows = clip.columns.map((c) => c.lines.length)
        expect(Math.min(...rows)).toBeGreaterThan(2)
      }
    }
  })

  it('justifies every row but the last of a column', () => {
    const clip = layoutClipping(spec(), 0, W, H, measure)
    const column = clip.columns[0]
    expect(column.lines.length).toBeGreaterThan(2)
    const filled = column.lines[0]
    const last = filled.words.at(-1)!
    // A justified row reaches the far edge of its column.
    expect(last.x + last.w).toBeCloseTo(column.x + column.w, 0)
  })

  it('never stretches a single word across a column', () => {
    /*
     * Justification divides the slack between the gaps. With one word there
     * are no gaps, and dividing by zero puts a word at each edge of an empty
     * column — or NaN, depending on which way the arithmetic falls.
     */
    for (let i = 0; i < 6; i++) {
      const clip = layoutClipping(spec(), i, W, H, measure)
      for (const column of clip.columns) {
        for (const line of column.lines) {
          for (const word of line.words) {
            expect(Number.isFinite(word.x)).toBe(true)
            expect(Number.isFinite(word.w)).toBe(true)
          }
          if (line.words.length === 1) {
            expect(line.words[0].x).toBeCloseTo(column.x, 5)
          }
        }
      }
    }
  })

  it('lies askew, but does not spin', () => {
    for (let i = 0; i < 8; i++) {
      expect(Math.abs(layoutClipping(spec(), i, W, H, measure).rotation)).toBeLessThan(0.05)
    }
  })

  it('tears an edge all the way round', () => {
    const clip = layoutClipping(spec(), 0, W, H, measure)
    expect(clip.tear.length).toBeGreaterThan(40)
    for (const point of clip.tear) {
      expect(Number.isFinite(point.x)).toBe(true)
      expect(Number.isFinite(point.y)).toBe(true)
    }
  })

  it('survives a frame too small to hold a page', () => {
    const clip = layoutClipping(spec(), 0, 120, 90, measure)
    expect(clip.headline.fontPx).toBeGreaterThanOrEqual(10)
    for (const column of clip.columns) expect(Array.isArray(column.lines)).toBe(true)
  })
})

describe('the looks', () => {
  it('all name a face that ships in assets/fonts', () => {
    // Every family here is in the repo — Playfair Display, Georgia, Cinzel,
    // Alfa Slab One, Abril Fatface, Courier New. A look naming something we do
    // not ship falls back to the canvas default and quietly stops being a look.
    const shipped = new Set([
      'Cinzel', 'Playfair Display', 'Georgia', 'Alfa Slab One', 'Abril Fatface', 'Courier New'
    ])
    for (const look of PAPER_LOOKS) {
      for (const family of [look.masthead, look.headline, look.body]) {
        expect(shipped.has(family)).toBe(true)
      }
    }
  })

  it('falls back rather than returning nothing for an unknown id', () => {
    expect(paperLookById('nope')).toBe(PAPER_LOOKS[0])
    expect(paperLookById('tabloid').id).toBe('tabloid')
  })
})

describe('the run', () => {
  it('lasts one hold per clipping', () => {
    expect(paperFrames(spec({ holdFrames: 6, clippings: 5 }))).toBe(30)
  })

  it('cuts to the next clipping on the beat of the hold', () => {
    const s = spec({ holdFrames: 6, clippings: 3 })
    expect(paperFrameAt(s, 0).index).toBe(0)
    expect(paperFrameAt(s, 5).index).toBe(0)
    expect(paperFrameAt(s, 6).index).toBe(1)
    expect(paperFrameAt(s, 17).index).toBe(2)
  })

  it('holds the last clipping rather than running off the end', () => {
    const s = spec({ holdFrames: 6, clippings: 3 })
    expect(paperFrameAt(s, 999).index).toBe(2)
    expect(paperFrameAt(s, -5).index).toBe(0)
  })

  it('sweeps the marker on and then leaves it', () => {
    /*
     * The word has to be readable HIGHLIGHTED for a beat. A marker that sweeps
     * across the whole hold is a wipe, and the emphasis never lands.
     */
    const s = spec({ holdFrames: 10, clippings: 2 })
    expect(paperFrameAt(s, 0).sweep).toBe(0)
    expect(paperFrameAt(s, 2).sweep).toBeGreaterThan(0)
    expect(paperFrameAt(s, 2).sweep).toBeLessThan(1)
    expect(paperFrameAt(s, 5).sweep).toBe(1)
    expect(paperFrameAt(s, 9).sweep).toBe(1)
    // And it starts again on the next clipping.
    expect(paperFrameAt(s, 10).sweep).toBe(0)
  })
})

describe('the custom options', () => {
  it('changes nothing when none are set', () => {
    /*
     * The whole point of them being optional. A preset has to stay a preset
     * rather than quietly becoming a pile of defaults somebody has to keep in
     * step with the look it came from.
     */
    const plain = layoutClipping(spec(), 0, W, H, measure)
    const explicitlyNothing = layoutClipping(
      spec({ scale: undefined, distortion: undefined, texture: undefined }),
      0, W, H, measure
    )
    expect(explicitlyNothing).toEqual(plain)
    // Everything but the headline face, which rotates per page on purpose.
    const preset = paperLookById('newsprint')
    expect({ ...plain.look, headline: preset.headline }).toEqual(preset)
  })

  it('scales the page', () => {
    const small = layoutClipping(spec({ scale: 0.6 }), 0, W, H, measure)
    const big = layoutClipping(spec({ scale: 1.4 }), 0, W, H, measure)
    expect(big.box.w).toBeGreaterThan(small.box.w * 1.8)
    // …and never off the edge of the frame, however far the slider is pushed.
    const huge = layoutClipping(spec({ scale: 99 }), 0, W, H, measure)
    expect(huge.box.w).toBeLessThanOrEqual(W)
    expect(huge.box.h).toBeLessThanOrEqual(H)
  })

  it('takes the tilt and the tear to nothing at zero distortion', () => {
    const flat = layoutClipping(spec({ distortion: 0 }), 0, W, H, measure)
    // `Math.abs`, because `(rand() - 0.5) * 0` is -0 half the time and
    // Object.is separates -0 from +0. They rotate identically.
    expect(Math.abs(flat.rotation)).toBe(0)
    expect(flat.look.tear).toBe(0)
    // A zero tear is still a closed path, just a straight one.
    expect(flat.tear.length).toBeGreaterThan(40)
    const corners = flat.tear.filter((p) => Math.abs(p.y - flat.box.y) < 0.001)
    expect(corners.length).toBeGreaterThan(5)
  })

  it('carries the texture amount to the painter rather than the painter guessing', () => {
    expect(layoutClipping(spec({ texture: 0 }), 0, W, H, measure).texture).toBe(0)
    expect(layoutClipping(spec({ texture: 2 }), 0, W, H, measure).texture).toBe(2)
    expect(layoutClipping(spec(), 0, W, H, measure).texture).toBe(1)
  })

  it('overrides the colours without touching the rest of the look', () => {
    const clip = layoutClipping(
      spec({ highlight: '#ff00ff', paper: '#ffffff', ink: '#000000' }), 0, W, H, measure
    )
    expect(clip.look.highlight).toBe('#ff00ff')
    expect(clip.look.paper).toBe('#ffffff')
    // The face still comes from the look's own pool — a colour override must
    // not reach anything but the colours.
    expect(paperLookById('newsprint').headlineFaces).toContain(clip.look.headline)
    expect(clip.look.body).toBe(paperLookById('newsprint').body)
  })

  it('takes your own headline and masthead', () => {
    const clip = layoutClipping(
      spec({ headline: 'The %s effect is real', masthead: 'THE FORGE TIMES' }), 0, W, H, measure
    )
    expect(clip.masthead.text).toBe('THE FORGE TIMES')
    expect(clip.headline.lines.map((l) => l.text).join(' ')).toContain('effect is real')
    expect(clip.highlight).not.toBeNull()
  })

  it('still highlights when a custom headline forgets the placeholder', () => {
    /*
     * Typing a headline and leaving out `%s` is the obvious mistake, and the
     * failure it causes is invisible: the clipping renders perfectly and the
     * marker simply never appears, because there is nothing to mark. Appending
     * is the honest repair — visibly not quite what was typed, rather than a
     * feature quietly doing nothing.
     */
    const clip = layoutClipping(spec({ headline: 'Something happened' }), 0, W, H, measure)
    const text = clip.headline.lines.map((l) => l.text).join(' ')
    expect(text).toContain('Something happened')
    expect(text).toContain('FORGE')
    expect(clip.highlight).not.toBeNull()
  })

  it('ignores a blank custom headline rather than rendering an empty page', () => {
    /*
     * Whitespace is not a headline. Without trimming, "   " is truthy, so the
     * generated headline is skipped and the keyword gets appended to nothing —
     * the page renders with one lone word where the story should be. Asserting
     * "not empty" passes that, because the keyword IS there; the assertion has
     * to be that the rest of the headline survived.
     */
    const clip = layoutClipping(spec({ headline: '   ', masthead: '  ' }), 0, W, H, measure)
    const text = clip.headline.lines.map((l) => l.text).join(' ')
    const others = text.replace('FORGE', '').trim().split(/\s+/).filter(Boolean)
    expect(others.length).toBeGreaterThanOrEqual(3)
    expect(clip.masthead.text.trim().length).toBeGreaterThan(0)
  })

  it('refuses nonsense from a slider instead of drawing NaN', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const clip = layoutClipping(
        spec({ scale: bad, distortion: bad, texture: bad }), 0, W, H, measure
      )
      expect(Number.isFinite(clip.box.w)).toBe(true)
      expect(Number.isFinite(clip.box.h)).toBe(true)
      expect(Number.isFinite(clip.rotation)).toBe(true)
      expect(clip.texture).toBeGreaterThanOrEqual(0)
      expect(clip.box.w).toBeGreaterThan(0)
    }
  })
})

describe('a long run of clippings', () => {
  it('does not repeat the headline every other page', () => {
    /*
     * The bug: the headline was chosen with `(index * 3) % 6`, and 3 and 6
     * share a factor, so the walk visited 0, 3, 0, 3 … forever. A run of
     * thirty clippings had exactly TWO headlines in it. Nothing looked
     * broken — the pages simply repeated, which is the one thing a run of
     * clippings exists not to do.
     */
    const headlines = new Set<string>()
    const mastheads = new Set<string>()
    for (let i = 0; i < 12; i++) {
      const clip = layoutClipping(spec({ clippings: 12 }), i, W, H, measure)
      headlines.add(clip.headline.lines.map((l) => l.text).join(' '))
      mastheads.add(clip.masthead.text)
    }
    expect(headlines.size).toBeGreaterThanOrEqual(6)
    expect(mastheads.size).toBeGreaterThanOrEqual(6)
  })

  it('changes the headline face from page to page', () => {
    const faces = new Set<string>()
    for (let i = 0; i < 8; i++) faces.add(layoutClipping(spec(), i, W, H, measure).look.headline)
    expect(faces.size).toBeGreaterThan(1)
    // …but only to faces the look actually nominates, all of which ship.
    const allowed = new Set(paperLookById('newsprint').headlineFaces)
    for (const f of faces) expect(allowed.has(f)).toBe(true)
  })

  it('keeps a single-face look on its single face', () => {
    // `press` is one typewriter. Rotating it would make it a different look.
    for (let i = 0; i < 6; i++) {
      expect(layoutClipping(spec({ lookId: 'press' }), i, W, H, measure).look.headline)
        .toBe('Courier New')
    }
  })

  it('ripples rather than slideshows, by default', () => {
    // Twenty pages at five frames is a hook, not a slideshow.
    expect(DEFAULT_PAPER.clippings).toBeGreaterThanOrEqual(15)
    expect(paperFrames({ ...DEFAULT_PAPER, keyword: 'X' })).toBeLessThan(150)
  })

  it('caps the count rather than baking a thousand pages', () => {
    const mad = spec({ clippings: 9999 })
    expect(clippingCount(mad)).toBe(MAX_CLIPPINGS)
    expect(paperFrameAt(mad, 1e6).index).toBe(MAX_CLIPPINGS - 1)
  })

  it('survives a count of zero', () => {
    const none = spec({ clippings: 0 })
    expect(clippingCount(none)).toBe(1)
    expect(paperFrames(none)).toBeGreaterThan(0)
    expect(paperFrameAt(none, 0).index).toBe(0)
  })
})
