# Paper animation — newspaper clippings

The look paperanimation.ai sells: a keyword highlighted across a run of torn
newsprint clippings that cut frame to frame. A hook device — the word lands,
the paper cuts, the word lands again.

## Why this one, and not the others

That site ships four styles. They are not the same size of job:

| style | what it needs | status |
|---|---|---|
| **Newspaper Highlight** | text rendering | **built** |
| Magazine Letters | text rendering, per-glyph | cheap, not started |
| Press Coverage | text rendering | falls out of the above |
| Paper Fold | **AI background removal** + a fold warp | needs RVM or similar in the sidecar |

The first three are type on a page, and type on a page is one of the most
developed parts of this app already. Paper Fold is the odd one out: it needs a
matting model, which is sheet ⑩ territory.

**Every typeface it uses already ships** in `assets/fonts` — Playfair Display
and Georgia for the serif work, Cinzel for a masthead, Alfa Slab One and Abril
Fatface for a tabloid shout, Courier New for a press release. Nothing was
added.

## Where it lives

| file | what |
|---|---|
| `src/shared/render/paper.ts` | **where everything goes.** Pure, no canvas |
| `src/shared/render/paperPaint.ts` | **ink only.** Torn shape, fibre, creases, marker |
| `tests/paper.test.ts` | 31 assertions about the measurements |

The split is sharper here than for a caption, and deliberately. A clipping is a
dozen interacting measurements and **every way of getting them wrong looks
plausible**: a highlight one line too high is still a highlight, columns that
overflow are still columns. Asserting "the marker covers the keyword and
nothing else" without a canvas is the only way to know.

The layout takes an injected `Measure`, so tests use a monospace stand-in and
the app passes one backed by a real 2D context. That is what keeps justified
columns testable.

## Three bugs worth keeping

**The headline ate the page.** Its size was a fixed fraction of the page
height, so a long one wrapped to six lines and the body columns came out with
**zero rows**. The page still had a masthead, rules and a big headline, so a
headline with no story under it read as a design choice. `fitHeadline` now
steps the size down until it fits three lines.

**The body size came from the page, not the column.** Three words fitted a
line, so justification stretched `report said a` across the whole column and
the block read as a ransom note. Newspapers run 25–35 characters a line, which
is a statement about the *column*. **Every test passed while this was wrong** —
it is only visible by looking at it. A line that broke early is also no longer
justified, because stretching three words to the edges is worse than a ragged
right.

**The painter re-derived a layout number.** The layout moved to a column-based
body size and the painter kept the page-based one, so every column rendered as
overlapping mush. The size is now carried on the `Clipping`. A painter that
recomputes a layout number is a second source of truth for it — the same thing
`textLayout.ts` exists to prevent.

## The custom half

Optional, and absent means the preset. A spec that sets none of them is
byte-identical to the one before they existed, which is what keeps a preset a
preset rather than a pile of defaults to keep in step.

| option | effect |
|---|---|
| `scale` | how much of the frame the page fills, clamped so it cannot leave it |
| `distortion` | tilt and tear together; `0` is a clean rectangle, square on |
| `texture` | fibre and creases; `0` is flat colour |
| `highlight`, `paper`, `ink` | colours, overriding the look |
| `headline`, `masthead` | your own words |

A custom headline that forgets `%s` still gets the keyword **appended**, rather
than silently rendering a clipping with nothing to highlight. That is the
obvious mistake to make and its failure is invisible: the page renders
perfectly and the marker simply never appears.

Every slider value goes through `amount()`, which rejects NaN and infinities
rather than letting them reach the geometry.

## The ripple

The effect is a RUN of pages, not one page: the word landing over and over on
a different paper each time. Twenty at five frames each by default, capped at
forty. Five read as a slideshow.

What makes a long run work is that the pages differ. Each one picks its own
masthead, headline template and **headline face** from the look's own pool —
all of which already ship. A run in one face is the same page thirty times
with the words moved.

**The walk has to be coprime with the list.** The headline was chosen with
`(index * 3) % 6`, and 3 and 6 share a factor, so it visited 0, 3, 0, 3 …
forever: a run of thirty clippings contained exactly **two** headlines.
Nothing looked broken — the pages just repeated, which is the one thing a
ripple exists not to do. `pick()` now steps by the first stride coprime with
the length.

## Not done yet

**It is not wired into the app.** The layout and the painter are finished and
tested; there is no way to create one from the UI and nothing bakes it. The
rails exist and are the right ones — `bakeTextSequence` in
`src/renderer/src/textCanvas.ts` already calls a painter once per frame and
writes numbered PNGs with alpha, which is exactly what a paper run needs, and
means it composites over footage with no green screen anywhere.

**Real paper photographs**, in two forms worth keeping apart:

- as **texture** — unprinted newsprint and torn-paper shots drawn inside the
  torn path in place of the flat colour and the procedural fibre. Small: the
  clip path already exists, so an image gets the torn shape for free. We keep
  drawing all the type.
- as **pages** — a genuine clipping with its own printed columns, where only
  the highlighted keyword is overlaid. The most authentic, and the most work:
  every image needs to say where its headline is, or the marker lands on the
  wrong words. Per-image metadata, a curated pack, the sticker pipeline again.

The procedural page is worth having under both. It is what fills in with no
pack installed, and it is the part assets cannot supply: thirty pages with
different headlines, faces and column breaks.

Also open: Magazine Letters (per-glyph, same machinery), and hyphenation —
without it a narrow column occasionally still leaves a sparse line.
