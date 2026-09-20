import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_PAPER,
  PAPER_LOOKS,
  layoutClipping,
  layoutRansom,
  typedChars,
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
    /*
     * The invariant is "nothing degenerate", not a particular size. A tiny
     * frame legitimately gets tiny type; what it must never get is a zero or
     * a NaN, which is what renders as an invisible page nobody can debug.
     */
    const clip = layoutClipping(spec(), 0, 120, 90, measure)
    expect(clip.headline.fontPx).toBeGreaterThan(0)
    expect(Number.isFinite(clip.headline.fontPx)).toBe(true)
    expect(clip.bodyPx).toBeGreaterThan(0)
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

describe('a clip that draws itself', () => {
  /*
   * Guards the bug that made the preview permanently black.
   *
   * Text and clippings both paint from their spec onto a canvas in the
   * preview, and both exist on the timeline before their file does — on
   * purpose, so adding one is instant. The readiness gate said
   * `layer.clip.text ? true : elementReady(layer.element)`, so a paper clip
   * fell to the second branch and waited on an `<img>` pointing at a file
   * that had not been written. The layer was never ready, nothing drew, and
   * the timeline showed a clip over a black frame with no error anywhere.
   *
   * Asserted against the source because the failure is in the render loop's
   * readiness logic, and jsdom has no canvas, no image loading and no
   * `readyState` — a mounted test would report ready for everything and
   * certify the bug. The real check is driving the harness; this is the cheap
   * guard that fails the moment the branch forgets one of them.
   */
  const preview = readFileSync(
    resolve(__dirname, '../src/renderer/src/components/Preview.tsx'),
    'utf8'
  )

  it('lets both kinds past the readiness gate', () => {
    expect(preview).toMatch(/const drawsItself = \(layer: Layer\): boolean =>/)
    expect(preview).toMatch(/Boolean\(layer\.clip\.text \?\? layer\.clip\.paper\)/)
    expect(preview).toMatch(/drawsItself\(layer\) \? true : elementReady\(layer\.element\)/)
    // The old one-sided form must not come back.
    expect(preview).not.toMatch(/layer\.clip\.text \? true : elementReady/)
  })

  it('draws clippings live rather than from the baked file', () => {
    // The effect IS the cut from page to page, so a preview that waited for
    // the sequence would show one frozen page while the export played a run.
    expect(preview).toContain('paperPreviewCanvas')
    const paper = preview.indexOf('if (layer.clip.paper)')
    const text = preview.indexOf('if (layer.clip.text)')
    expect(paper).toBeGreaterThan(-1)
    expect(text).toBeGreaterThan(-1)
  })
})

describe('the shape of the paper', () => {
  /*
   * The bug this exists for: the box was "80% of the frame's width by 50% of
   * its height", so the paper's SHAPE was a side effect of the project's
   * aspect ratio. A 16:9 timeline got a 3:1 strip and there was no way to ask
   * for anything else; the same spec on 9:16 came out nearly square. A sheet
   * of paper has a shape. It does not change because you filmed in landscape.
   */
  const LANDSCAPE = { w: 1920, h: 1080 }
  const PORTRAIT = { w: 1080, h: 1920 }

  it('keeps its own shape whatever the frame is', () => {
    for (const shape of ['clip', 'page', 'column']) {
      const wide = layoutClipping(spec({ shape }), 0, LANDSCAPE.w, LANDSCAPE.h, measure)
      const tall = layoutClipping(spec({ shape }), 0, PORTRAIT.w, PORTRAIT.h, measure)
      const wideRatio = wide.box.w / wide.box.h
      const tallRatio = tall.box.w / tall.box.h
      expect(Math.abs(wideRatio - tallRatio)).toBeLessThan(0.15)
    }
  })

  it('gives a portrait page on a landscape timeline', () => {
    // The actual request: a document, not a strip, even at 16:9.
    const page = layoutClipping(spec({ shape: 'page' }), 0, LANDSCAPE.w, LANDSCAPE.h, measure)
    expect(page.box.h).toBeGreaterThan(page.box.w)
  })

  it('still gives a wide strip for a clipping', () => {
    const clip = layoutClipping(spec({ shape: 'clip' }), 0, PORTRAIT.w, PORTRAIT.h, measure)
    expect(clip.box.w).toBeGreaterThan(clip.box.h)
  })

  it('sets a column in one column and a page in two', () => {
    expect(layoutClipping(spec({ shape: 'column' }), 0, PORTRAIT.w, PORTRAIT.h, measure).columns)
      .toHaveLength(1)
    expect(layoutClipping(spec({ shape: 'page' }), 0, PORTRAIT.w, PORTRAIT.h, measure).columns)
      .toHaveLength(2)
  })

  it('never lets any shape leave the frame', () => {
    for (const shape of ['clip', 'page', 'column']) {
      for (const frame of [LANDSCAPE, PORTRAIT, { w: 1080, h: 1080 }]) {
        const clip = layoutClipping(spec({ shape, scale: 1.6 }), 0, frame.w, frame.h, measure)
        expect(clip.box.w).toBeLessThanOrEqual(frame.w)
        expect(clip.box.h).toBeLessThanOrEqual(frame.h)
      }
    }
  })

  it('leaves room for the story in every shape, on either orientation', () => {
    /*
     * The zero-rows failure wearing a different hat. A short wide shape with a
     * three-line headline filled the page exactly as a long headline once did,
     * and the columns came back with one row. The headline now has to fit the
     * height it was given, not just a line count.
     */
    for (const shape of ['clip', 'page', 'column']) {
      for (const frame of [LANDSCAPE, PORTRAIT]) {
        for (let i = 0; i < 4; i++) {
          const clip = layoutClipping(
            spec({ shape, keyword: 'EXTRAORDINARY' }), i, frame.w, frame.h, measure
          )
          const rows = clip.columns.map((c) => c.lines.length)
          expect(Math.min(...rows)).toBeGreaterThan(2)
        }
      }
    }
  })

  it('falls back to a clipping for an unknown shape', () => {
    const odd = layoutClipping(spec({ shape: 'nope' }), 0, PORTRAIT.w, PORTRAIT.h, measure)
    const clip = layoutClipping(spec({ shape: 'clip' }), 0, PORTRAIT.w, PORTRAIT.h, measure)
    expect(odd.box).toEqual(clip.box)
  })
})

describe('cut-out letters', () => {
  const ransom = (over: Partial<PaperSpec> = {}): ReturnType<typeof layoutRansom> =>
    layoutRansom(spec({ mode: 'letters', ...over }), 0, W, H, measure)

  it('makes one scrap per letter, in order', () => {
    const clip = ransom({ keyword: 'FORGE' })
    expect(clip.letters).toHaveLength(5)
    expect(clip.letters!.map((l) => l.char).join('')).toBe('FORGE')
    for (let i = 1; i < clip.letters!.length; i++) {
      expect(clip.letters![i].box.x).toBeGreaterThan(clip.letters![i - 1].box.x)
      expect(clip.letters![i].at).toBeGreaterThan(clip.letters![i - 1].at)
    }
  })

  it('never puts dark ink on dark paper', () => {
    /*
     * The bug this is named after, and it was visible the moment anyone
     * looked: `paper` and `ink` were rolled INDEPENDENTLY, each flipping to
     * the other colour 30% of the time. Dark-on-dark came up 21% and
     * light-on-light another 21%, so **42% of letters were invisible** — two
     * missing letters in every five-letter word. It read as a font failing to
     * load, not as a contrast bug.
     *
     * One roll now decides whether a scrap is inverted, and both colours
     * follow from it. Checked over many seeds because the old bug was
     * probabilistic and a single sample would have passed.
     */
    for (let seed = 1; seed < 40; seed++) {
      const clip = layoutRansom(
        spec({ mode: 'letters', keyword: 'ABCDEFGH', seed }), 0, W, H, measure
      )
      for (const letter of clip.letters!) {
        expect(letter.paper).not.toBe(letter.ink)
      }
    }
  })

  it('uses only faces the look nominates', () => {
    const allowed = new Set(paperLookById('newsprint').headlineFaces)
    for (const letter of ransom({ keyword: 'ADVERTISING' }).letters!) {
      expect(allowed.has(letter.face)).toBe(true)
    }
  })

  it('draws no page at all', () => {
    // Letters INSTEAD of a clipping, not as well as one — or the word lands
    // on top of a newspaper nobody asked for.
    const clip = ransom()
    expect(clip.columns).toHaveLength(0)
    expect(clip.headline.lines).toHaveLength(0)
    expect(clip.masthead.text).toBe('')
  })

  it('survives a keyword of spaces or nothing', () => {
    expect(ransom({ keyword: '' }).letters).toHaveLength(0)
    expect(ransom({ keyword: '   ' }).letters).toHaveLength(0)
    expect(ransom({ keyword: 'A B' }).letters).toHaveLength(2)
  })

  it('keeps a long word inside the frame', () => {
    const clip = ransom({ keyword: 'EXTRAORDINARILY' })
    const last = clip.letters!.at(-1)!
    expect(clip.letters![0].box.x).toBeGreaterThanOrEqual(0)
    expect(last.box.x + last.box.w).toBeLessThanOrEqual(W)
  })
})

describe('typedChars', () => {
  it('types nothing at the start and everything by the settle point', () => {
    expect(typedChars(20, 0)).toBe(0)
    expect(typedChars(20, 0.33)).toBeGreaterThan(0)
    expect(typedChars(20, 0.33)).toBeLessThan(20)
    expect(typedChars(20, 0.66)).toBe(20)
  })

  it('leaves the finished line readable before the cut', () => {
    /*
     * Typing right up to the cut means the last character is never seen
     * before the page changes, which reads as the effect being broken rather
     * than as being too fast. Everything after `settle` holds.
     */
    expect(typedChars(20, 0.7)).toBe(20)
    expect(typedChars(20, 1)).toBe(20)
  })

  it('never overruns or goes negative', () => {
    expect(typedChars(20, 99)).toBe(20)
    expect(typedChars(20, -1)).toBe(0)
    expect(typedChars(0, 0.5)).toBe(0)
    expect(typedChars(20, Number.NaN)).toBe(0)
  })
})

describe('a clip that is DRAWN at the canvas size', () => {
  /*
   * Four bugs, one cause: `paper` missing from a list of generated kinds.
   *
   * Text, colour cards and titles are all authored AT the canvas size, so each
   * one appears in three lists — the preview's readiness gate, the aspect
   * change's "do not auto-reframe this" skip, and the rebake. Clippings were
   * added to none of them, and it produced four failures that looked entirely
   * unrelated:
   *
   *   - the preview was permanently black
   *   - changing 16:9 to 9:16 showed one cropped corner of the old page
   *   - each page's timing drifted between the preview and the file
   *   - the export failed with "no such file or directory"
   *
   * Asserted against the source because all three are decisions inside
   * functions with no return value worth checking, and because the cost of
   * getting it wrong is four bugs in four different places.
   */
  const store = readFileSync(resolve(__dirname, '../src/renderer/src/store.ts'), 'utf8')

  it('is not auto-reframed when the aspect changes', () => {
    /*
     * The comment above this line in `setAspect` describes the exact failure —
     * "a crop solved against the new one took a sub-rectangle of it" — and it
     * was written before clippings existed to suffer it.
     */
    expect(store).toMatch(
      /if \(c\.text \|\| c\.solid \|\| c\.title \|\| c\.paper\) return \{ \.\.\.c, crop: undefined \}/
    )
  })

  it('is redrawn at the new canvas size', () => {
    expect(store).toMatch(
      /filter\(\(c\) => c\.text \|\| c\.solid \|\| c\.title \|\| c\.paper\)/
    )
    // …and the rebake has to actually bake it, not just select it.
    expect(store).toContain('bakePaperSequence(')
  })

  it('bakes bounded by the clip, so the preview and the file agree', () => {
    /*
     * The preview draws `playhead - clip.start` directly. A sequence of any
     * other length drifts against that, which is what made each page's timing
     * differ between the screen and the export.
     */
    const at = store.indexOf('bakePaperSequence(')
    expect(at).toBeGreaterThan(-1)
    expect(store.slice(at, at + 200)).toContain('clip.duration')
  })

  it('repoints the asset size, not only the path', () => {
    // Everything that measures against an asset's dimensions — the crop
    // solver, the camera move's pre-scale — works from the stored number, so
    // a rebake that changes the file and not the record is worse than none.
    const at = store.indexOf('bakePaperSequence(')
    const block = store.slice(at, at + 700)
    /*
     * Matched as one ordered shape, not as three separate substrings.
     * `width,` also appears in the `bakePaperSequence(...)` arguments a few
     * lines above, so a loose `toContain` passed happily with the repoint
     * deleted — the assertion was reading the call, not the thing it claims
     * to check.
     */
    expect(block).toMatch(
      /path: sequence\.pattern\.replace\([^)]*\),\s*\n\s*width,\s*\n\s*height,\s*\n\s*frames: \{ pattern:/
    )
  })

  it('repoints the asset size on EVERY rebake path, not just the first', () => {
    /*
     * There are two of them, and only one was checked.
     *
     * The assertion above takes `indexOf`, which finds `rebakeGenerated` and
     * stops. `rebakePaper` — the one behind every control in the Paper panel —
     * updated the path and the frames and left the dimensions alone, so after
     * an aspect change the pages were redrawn at the new canvas while the
     * asset still claimed the old one. Reported from the app: a clipping that
     * was right when it was made and small ever after.
     *
     * An aspect change fires `rebakeGenerated` as `void`, so the two can land
     * in either order. Requiring both to leave the same asset is what makes
     * the order stop mattering.
     */
    const sites = [...store.matchAll(/bakePaperSequence\(/g)].map((m) => m.index ?? 0)
    expect(sites.length).toBeGreaterThanOrEqual(2)

    for (const at of sites) {
      const block = store.slice(at, at + 900)
      expect(
        /\bwidth,\s*\n\s*height,\s*\n\s*frames: \{ pattern:/.test(block),
        `the rebake at index ${at} writes frames without repointing width/height`
      ).toBe(true)
    }
  })
})
