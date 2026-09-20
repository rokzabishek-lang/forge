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

## Shapes, and why they are ratios

The box used to be "80% of the frame's width by 50% of its height", which made
**the paper's shape a side effect of the project's aspect ratio**: a 16:9
timeline could only ever produce a 3:1 strip, and the same spec on 9:16 came
out nearly square. A sheet of paper has a shape. It does not change because
you filmed in landscape.

`SHAPES` holds fixed width÷height ratios, fitted inside the frame and then
scaled — `clip` (a torn strip), `page` (a portrait document) and `column` (a
narrow cutting, one column, good over a vertical reel).

Two consequences fell out of it, both the *same* bug in new clothes:

**Type is sized off the WIDTH, capped by the height.** Derived from the page
height, a tall page got enormous type and a wide strip got tiny type — because
height is not what a line of text has to fit into.

**The headline has to fit its allotted height, not just a line count.** Three
lines at a width-derived size filled a short wide page completely and the body
columns came back with one row. That is the zero-rows failure from §"Three
bugs" for the third time, which is why `fitHeadline` now shrinks on *both*
conditions.

## Two modes

**`page`** — a clipping, as described above.

**`letters`** — the keyword as ransom-note cut-outs and nothing else: every
letter its own scrap, its own typeface, its own tear and tilt, landing one
after another. The clipping run stripped to its point, which is what makes it
work over busy footage where a page of body text is only noise.

**The contrast bug is worth keeping.** `paper` and `ink` were rolled
*independently*, each flipping to the other colour 30% of the time — so
dark-on-dark came up 21% and light-on-light another 21%, and **42% of letters
were invisible.** Two missing letters in every five-letter word, reading as a
font that failed to load. One roll now decides whether a scrap is inverted and
both colours follow. The test sweeps forty seeds, because the old bug was
probabilistic and one sample would have passed.

## Typewriter

`reveal: 'type'` reveals the headline a character at a time with a caret,
counted across the *whole* headline rather than per line, so the caret walks
off the end of one line onto the start of the next the way a typewriter does.

Two details that matter more than they look:

- **The marker waits until the word is fully typed.** A highlighter sweeping
  across characters that are not there yet gives the whole effect away.
- **Typing finishes at 66% of the hold**, not at the cut. Typing right to the
  cut means the finished line is never actually seen, which reads as the
  effect being broken rather than as being fast.

Pairs naturally with the `press` look, which is Courier.

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

## How to use it

**Media tab → `+ Newspaper clippings`.** It lands on a track above whatever is
there, because the alpha is the point. Select it and the Inspector has the
word, the four looks, Pages and Frames-each, and a **Customise** section for
size, tilt & tear, texture, your own headline and masthead, the marker colour,
and *Shuffle the pages* for a different stack at the same settings.

Changing Pages or Frames-each **retimes the clip**. Otherwise asking for forty
pages plays twenty and stops, which reads as the count being ignored rather
than the clip being too short — the failure would show up somewhere other than
the control that caused it.

| file | what |
|---|---|
| `src/renderer/src/paperCanvas.ts` | live preview + the sequence bake |
| `src/renderer/src/components/PaperPanel.tsx` | the controls |
| `clip.paper` | the spec, beside `clip.text` and `clip.solid` |

**Fonts are loaded as a set, not per page.** The face changes from clipping to
clipping, so loading lazily would bake the first pages in a fallback and the
later ones correctly — a run that drifts into focus, which reads as a bug in
the effect rather than a loading order.

### The gate that made the preview black

Text and clippings both draw themselves, and both exist on the timeline before
their file does. The preview's readiness check said:

```ts
layer.clip.text ? true : elementReady(layer.element)
```

so a paper clip fell to the second branch and waited on an `<img>` pointing at
a sequence that had not been written. The layer was never ready, nothing drew,
and the timeline showed a clip over a **black frame with no error anywhere**.
It is now `drawsItself(layer)`, covering both, and `tests/paper.test.ts`
asserts the branch against the source — jsdom has no canvas, no image loading
and no `readyState`, so a mounted test would report ready for everything and
certify the bug.

## Not done yet

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
