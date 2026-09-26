# Effects — grading, keyframes, mattes, adjustment layers

What the renderer can and cannot do, and how each was established. Everything
here was measured against the bundled binary rather than inferred from
documentation, because several of these filters advertise a capability they do
not have.

---

## 1. What ffmpeg can actually animate

The single most expensive thing to rediscover. Each row was tested by rendering
frames and reading the pixels back.

| Property | Filter | Works? | Notes |
|---|---|---|---|
| Position | `overlay` `x`/`y` | **Yes** | Expressions in `t`. The motion path has always used this. |
| Rotation | `rotate=a='…'` | **Yes** | Expression in `t`. |
| Opacity | `geq` on the alpha plane | **Yes** | The only filter here that exposes time to a per-pixel expression. Expensive. |
| Zoom | `zoompan` `z` | **Yes** | Counts output frames in `on`, not seconds. |
| **Size** | `scale` with `eval=frame` | **NO** | Re-evaluates and does **not** follow its expression. Asked for 192px→495px, got a constant 138px. |
| **Crop w/h** | `crop` | **NO** | Resolves `w`/`h` once at configuration. Same trap. |
| **Volume** | `volume` with `eval=frame` | **Yes** | Genuinely follows its expression, unlike `scale` above. Measured on a 4s tone with `if(lt(t,2),1,0.25)`: second half came back **12.0 dB** down, which is 0.25× to within rounding. This is what the drawn volume envelope compiles to. |

`eval=frame` is therefore **not** a property of the build — it is a property of
each filter. `scale` accepts it and ignores it; `volume` accepts it and honours
it. Neither can be inferred from the other, so each one has to be measured.

The envelope's `t` is **clip-relative**, because `adelay` sits after `volume` in
the audio chain: at that point the stream starts at zero whatever the clip's
position on the timeline. A test whose clip started at frame 0 could not tell
that apart from timeline time and passed against a deliberately wrong time
base — the test now starts a clip a second in.

So animated *size* does not exist. A punch-in is expressed as a zoom into the
picture, which is what it wants to be anyway — and the UI says "Zoom", not
"Size", so it does not promise something that cannot export.

### Two traps inside the working ones

**`geq` calls time `T`, not `t`.** With a lowercase `t` the parser reports
`Unknown function in 't,2.0000)...` — it reads `t(` as a call to an undefined
function, and the entire graph refuses to build.

**Everything before `setpts` sees clip-relative time.** `rotate`, `geq` and
`zoompan` all run earlier in the chain than `setpts=PTS-STARTPTS+offset`, so
their frames still carry source timestamps starting at zero. Writing a curve
against the clip's *timeline* position works perfectly for the first clip on a
timeline and freezes every clip after it. Only a clip that starts late catches
this, so there is a test for exactly that.

---

## 2. Grading

`ColorAdjust` existed on every clip from the first commit and was read by
nothing — no `eq`, no preview filter. It is now real.

The three sliders were chosen to **be** ffmpeg's `eq` parameters, so there is no
conversion to get wrong: brightness is an offset around 0, contrast and
saturation are multipliers around 1. The neutral state is therefore also the
identity, and an ungraded clip costs no filter at all.

### LUTs

`.cube` is what every grading tool exports and what ffmpeg reads directly.

**`lut3d` has no mix or intensity option** — checked against the binary, not
assumed. Anything short of full strength needs the graded and ungraded pictures
blended, and a blend takes two inputs, which makes it a sub-graph rather than
another link in a chain.

Alpha is held at full through that blend (`c3_opacity=1`). Without it a
half-strength look would also make a sticker half-transparent. Measured on a
40%-alpha source, the alpha comes out `0x66` either way.

**`blend`'s opacity weights its FIRST input** — measured: red first, blue
second, `all_mode=normal` at 0.8 gives `rgb(202, 0, 47)`, at 0.2
`rgb(49, 0, 202)`. The first input is the ungraded copy (it has to be: a
`blend` disabled by `enable` passes its first input through, which is how an
adjustment layer stops outside its span), so its opacity is `1 − intensity`.
Until 24 Sept 2026 it was `intensity`, and every partial look exported
inverted — 0.8 came out at 0.2, and the preview, which mixes the right way
round, disagreed with every export. **Every render check used 0.5**, the one
value at which a mix and its inverse are the same picture. Found by the
`spine@2` render check, whose recipe look is 0.75. Test partial strengths at
an asymmetric value.

Seven looks ship generated rather than licensed — lift/gamma/gain, an S-curve,
split-toning — written out as ordinary `.cube` files. There is therefore one
kind of LUT in the product: a file with a path. A look the user loads goes down
the identical path, and nothing has to know which is which.

### The preview has to run the same maths

Canvas 2D cannot do a 3D LUT, and its `filter` property cannot express `eq` —
CSS `brightness` is a multiplier where ffmpeg's is an offset. Approximating with
CSS filters would put a different picture on screen from the one that exports,
which is worse than showing nothing. So the preview runs the actual formulas on
the GPU: RGB→YUV, `eq`, YUV→RGB, then a 3D LUT texture.

**CORS is not optional for this.** WebGL refuses a texture from an element that
was not fetched with CORS approval. `forge-media://` needed `corsEnabled: true`
in `registerSchemesAsPrivileged` *and* `crossOrigin` on the elements — with only
the second, every image failed to load at all and the preview went black while
the audio kept playing. The elements now fall back to a plain load if the CORS
one ever fails: a preview that cannot show a grade is a small problem, a black
preview is not.

---

## 3. Mattes — text as a window

The trailer look: block letters with footage moving inside them.

`alphamerge`, the same filter the mask transitions use, with the shape coming
from a clip on the timeline rather than a file in the library — so the word can
be retyped and the fill follows it.

A clip marked `matteOnly` is never composited; it becomes a greyscale mask at
canvas size and another clip's `matte` points at it. The shape stays an ordinary
clip: visible, selectable, editable.

**The trap:** the overlay chain hands its output along and the *last* composited
clip must produce `[vmix]`. Skipping a matte shape means "last" is no longer the
last index, and getting that wrong silently drops every clip after the skip.
There is a test for a timeline whose final clip is a shape.

---

## 4. Adjustment layers

Resolve's shape, and the elegant part is that one object carries two meanings on
two axes: **track position decides which layers are included, horizontal
duration decides when.**

It falls out of the compositing order almost for free. At the point an
adjustment layer is reached, `current` already holds every lower track
composited together — so the layer is simply a filter on that stream, gated with
`enable='between(t,start,end)'`. Both `eq` and `lut3d` support the timeline
`enable` option; a disabled `blend` passes its first input through untouched,
which is the ungraded copy.

The layer is backed by a transparent card so it is an ordinary clip — draggable,
trimmable, selectable — rather than a special case the timeline has to know
about.

In the preview they are flushed **in track order, interleaved with the layers**,
not applied to the finished frame. Grading at the end would wrongly catch a title
sitting above the adjustment layer, which is exactly where titles usually sit.

---

## 5. Text rasterisation moved to the renderer

Text used to be an SVG through sharp, which uses librsvg, which resolves fonts
through fontconfig.

**It has one face and ignores the family entirely.** `font-family="Anton"`,
`"sans-serif"` and a deliberately bogus name produced byte-identical output —
the same ink count to the pixel — at every setting of `FONTCONFIG_FILE` and
`FONTCONFIG_PATH`. Choosing a font could never have worked through that path.

So text is drawn in the renderer, where the catalogue's fonts are already loaded
as `FontFace` objects built from bytes, and only the finished pixels go to the
main process to be written. Placement lives in one shared `layoutText` used by
the baked PNG, the SVG and the on-picture editing box, so the box you drag cannot
sit somewhere the export does not.

---

## 6. Generated artwork and the canvas size

Text, colour cards and titles are authored **at** the canvas size. Auto-reframing
them is therefore always wrong: solving a crop for a PNG that is still the old
aspect takes a sub-rectangle of the words, cutting them off and shoving them out
of frame.

They are excluded from auto-reframe and re-baked at the new size when the aspect
changes.

---

## 7. Masks — a shape, and a verb

The research question was "what belongs in a Photoshop-style toolbox?", and the
answer both Resolve and CapCut give is: not a paint toolbox. Resolve calls it a
**Power Window**, CapCut calls it a **Mask**, and neither lets you push pixels
around frame by frame. What people actually want is to *confine* something —
blur this face, darken that corner, warm only the sky — for the length of a shot.

So a mask here is a region plus a verb, never a brush stroke:

| Mode | What it does |
| --- | --- |
| `reveal` | show the clip only inside the shape |
| `blur` | blur inside the shape — invert it and the background goes soft |
| `grade` | the clip's own colour applies only inside the shape |

Shapes are `rectangle`, `ellipse` and `linear` (a half-plane, for a horizon),
each with position, size, rotation, feather and invert.

### The shape is sized off the stream, not the canvas

`maskExpression` writes every length against geq's own `W` and `H` rather than
baking in a pixel count. Two separate reasons, both measured:

1. **Subsampling.** geq runs once per plane and a subsampled format's chroma
   planes are half size, so an expression in absolute pixels draws a half-scale
   shape in the corner of those planes. A centred circle came back as a
   washed-out smear — the luma said "inside" where the chroma said "outside".
2. **Picture-in-picture.** By the time the mask is applied the clip has been
   fitted to its **box**, which equals the canvas only when the clip fills the
   frame. A canvas-sized mask is wrong for every PiP. Sizing off the stream makes
   the mask a property of the clip, so it travels with a PiP that is moved.

The shape stream itself is a `split` of the clip's own stream rather than a
generated `color` source, so it is always exactly the size of the thing it masks.

### Three routes were measured; two are wrong

Confining an effect to a region means combining two pictures by a per-pixel mask.

- **`overlay` straight onto the original — WRONG.** With a half-transparent
  source, the region under the overlay came back **fully opaque**. A sticker with
  a blurred patch would have grown a solid rectangle nobody asked for.
- **`maskedmerge` — WRONG on subsampled input.** It merges plane by plane, so a
  grey mask becomes neutral chroma (128) and blends the colour 50/50 everywhere:
  red over blue came back magenta.
- **Strip the alpha, merge opaque copies, put the alpha back — EXACT.** Both
  sides of a feathered edge matched to the byte.

That last one is what ships:

```
[in]split[keep][work]
[keep]format=yuva420p,alphaextract[alpha]
[work]format=yuv420p,split[plain][affect]
[affect]<gblur | eq,curves | lut3d>[done]
[done][shape]alphamerge[cut]
[plain]format=yuva420p[base]
[base][cut]overlay=0:0:format=auto,format=yuv420p[merged]
[merged][alpha]alphamerge[out]
```

### One alphamerge, never two

`alphamerge` **replaces** alpha rather than multiplying into it, so a second one
silently discards the first. A matted clip that was also revealed by a luma wipe
lost its matte, despite a comment promising the two "multiply". Every shape —
the matte clip's luma, a reveal mask, a wipe — is now multiplied into one stencil
and applied once.

For the same reason, opacity and a transition's fade move **after** the mask on a
masked clip: they write alpha, and the shape landing on top would erase them.

### Preview and export agree

Canvas blurs alpha along with colour, so a text card grew a soft halo out past
its own edges while ffmpeg — which blurs the colour planes and restores the
clip's own alpha — would not have. Caught in the harness at a large radius. The
preview now multiplies the blurred copy back by the source's alpha. For opaque
media, which is what this tool is for, both are a plain blur.

---

## 8. Live text, and what an always-on draw loop was hiding

Typing used to cost a full-canvas PNG encode, an IPC transfer, a disk write and a
re-decode on every pause, and **adding** a text clip additionally spawned
`ffprobe` to ask the finished file how big it was — a question whose answer was
already known, because a text card is exactly the size of the canvas.

Text, colour cards and titles are now drawn **live** in the preview from their
spec, through the same shared `layoutText`. The PNGs are written once, on the way
to an export, where they are the only place they have ever been needed.

The preview draw loop also called `draw()` on **every** animation frame
regardless of whether anything had changed — sixty full composites a second, for
ever, while the app sat on a still frame. It now repaints only when the picture
could have changed, or while playing.

That loop was covering for missing wiring, and removing it exposed three things
that had never been connected:

- an `<img>` or `<video>` finishing its decode — React does not re-render for it
- `seeked` on a paused video — scrubbing changes the picture with no state change
- a font arriving after first paint, now that text is drawn live

All three now mark the canvas dirty. `repaint()` sets that flag **itself** rather
than relying on a re-render: `draw` is memoised over the project, the playhead
and the view settings, and none of those move when a LUT finishes loading.

---

## 9. Speed — slow motion and fast motion

The biggest single gap for short-form. A held beat in slow motion and a whip
through the boring part are the two edits that most reliably separate a reel
that plays from one that gets scrolled past.

The model is the one every editor uses: **the source range stays put and the
clip's length changes.** Half speed makes a two-second clip four seconds long
and shows exactly the same footage.

```
source frames consumed = duration × speed
timeline frames occupied = duration
```

That is why changing speed rewrites `duration` rather than `inPoint`, and why
the input is trimmed with `-t duration × speed` — asking for the full timeline
length would both waste a decode and run past the end of the shot.

### Speed is a self-contained prefix

`setpts=PTS/S,fps=N`, at the very front of the clip's chain.

`setpts` re-times without changing the frame count, so on its own a slowed clip
is the same frames spread thinner — a stream claiming 30fps while delivering 7.
The `fps` filter immediately after restores the count, and **everything
downstream then sees a perfectly ordinary clip of exactly `duration` frames**.
That matters: motion, rotation, opacity keyframes and the transitions all read
clip-relative time, and any of them seeing a half-rate stream would have drifted.

At speed 1 nothing is emitted at all, so every existing project produces a
byte-identical graph.

### atempo has a floor, measured

`[0.5 - 100]`. A tempo of 0.4 is refused outright — *"Value 0.400000 for
parameter 'tempo' out of range"* — so quarter speed is **two halvings chained**,
not one filter. `atempoChain` keeps every link inside the range and multiplies
back to the speed asked for, which is a property the tests check across the
whole range rather than at a few points.

Tempo runs **before** `adelay`: the stretch belongs to the clip, the delay places
the stretched result on the timeline. The other order would scale the offset too
and slide every slowed clip out of sync.

### Smooth slow motion costs 41×

`minterpolate` invents the in-between frames instead of repeating them. Measured
at 1080x1920, eight seconds of output:

| | time |
| --- | --- |
| plain `setpts` | **0.67s** |
| `minterpolate` | **27.46s** |

So it is opt-in, never the default, and only offered below 1× — speeding up
discards frames and has nothing to interpolate.

### A photograph has no rate

Stills are excluded everywhere: no filter, no panel. "Speeding up" a still is
just a trim wearing a different name, and offering it would be a lie about what
it does.

### The ripple

Changing speed pushes whatever follows on the same track, so a clip that doubles
in length does not grow straight through its neighbour. Clips on other tracks,
and clips that start *before* this one ends — a deliberate overlap — are left
alone. The rule is a pure function in `render/speed.ts` rather than in the
store, so it is tested rather than looked at.

One known limit: durations are whole frames, so round-tripping through several
extreme speeds can shed a frame or two to rounding and to the clamp against the
available footage. Measured at three frames lost over four consecutive extreme
changes.

### What the harness could not see, and now can

The browser harness could only ever produce **images**, so half the editor was
invisible to it — playback rate, seeking, drift, trimming, and now speed. It
records a real canvas to a webm with `MediaRecorder` instead.

The first version of that recorder drew `seconds × fps` frames one per animation
frame, which on a 60Hz display recorded 180 frames in three seconds and produced
a three-second file the harness then announced as six. It now paces on the wall
clock and **measures the result back off the file**, because a harness that
misreports a duration sends you hunting a trimming bug that does not exist.

It immediately earned its keep: at quarter speed the 2× button was dead, because
the panel greyed out fast presets when it judged there was "not enough footage
left". That was simply wrong — speeding up never runs out of anything, it just
makes the clip shorter — and it left no way out of slow motion but the reset.

---

## 10. Text styles — the trending caption looks

The packs people buy are **not fonts**. Look closely at any of them and the same
small vocabulary is doing all the work:

- a gradient or **metallic** fill
- a coloured **outer glow**
- an **outline**
- a soft **shadow**
- and, over and over, a **second line treated completely differently** — heavy
  metallic caps with a light script underneath

"SUGAR" in metal with "Daddy" in green script is two paints and two faces, not
one exotic typeface.

### Style and font are two axes, on purpose

A style is a **recipe**; a font is a **face**. Keeping them independent is what
turns two dozen recipes across fifty faces into **twelve hundred looks** instead
of twelve hundred presets nobody could name or maintain.

No style names a font family it cannot guarantee is installed — a test enforces
that — so a style varies weight, slant, size and tracking, and the letters stay
whichever ones the user picked.

### How twenty-four styles are shown without drowning anyone

Not as a catalogue of somebody else's words. Every tile is **your** text in
**your** font, drawn by `drawTextOnto` — the very function that draws the real
thing and bakes the export. Change the font and all two dozen tiles change with
it. A tile that merely resembled the style would be worse than no tile: it would
be a promise the export does not keep.

### Why the first version showed "very few"

All twenty-four went into a short scrolling box **inside the inspector, which
already scrolls**. About five were visible and nothing indicated there were
nineteen more — reported, accurately, as *"why do I see very few?"*. A nested
scrollbar is close to invisible, and a library you cannot see the shape of may
as well not exist.

Now the inspector keeps six tiles for reaching a favourite quickly (always
including whichever one is currently on, or picking from the gallery and then
finding it nowhere in the panel is disorienting), and **Browse all 24** opens a
proper gallery: blurred backdrop, searchable, a three-column grid at a size
where the looks can be judged — and a **large hero preview over the actual
frame** that follows the pointer as it moves across the grid.

The hero matters more than it sounds. A thumbnail answers "what is this style";
it cannot answer "does this look right on MY shot", which is the only question
being asked. If the frame cannot be copied the card stays dark rather than
inventing a backdrop, since a fake background would flatter some styles and
sabotage others.

### Paint order is the whole trick

Glow, then shadow, then outline, then fill — each as its **own pass**. Canvas
applies a shadow to everything drawn in that pass, so setting a shadow and
stroking in one go grows a smeared copy of the outline, which is precisely what
makes a hand-rolled version of these looks read as cheap.

The glow is **several blurred passes, not one**: a single canvas shadow at a
large radius spreads its energy too thin to read as a glow. Redrawing the
blurred shape accumulates it, the way a compositor builds one.

A gradient is built around **that line's** measured box — its width and its cap
height — or a two-line style ramps across the wrong distance and the second line
comes out a flat slab of the end colour.

### Nothing leaves the frame

Long text **wraps** at the title-safe margin; it does not shrink away. The first
version scaled the whole block down until it fitted, which made a long headline
into a small headline — and worse, the on-picture editing box is HTML and wraps
by itself, so the editor showed something different from the render. Two answers
to one question is the bug, whichever is prettier.

Shrinking survives only as the fallback for a **single unbreakable word**, since
there is nowhere for that word to go and clipping it would hide what was written.
Measured on a 640x360 canvas with a safe box of 32..608:

| | ink | lines |
| --- | --- | --- |
| long text, no style | 41..599 | 2, wrapped |
| long text, styled | 38..600 | 2, wrapped |
| one 34-letter word | 31..608 | 1, shrunk to fit |
| short text | 259..382 | 1, centred |

### Subtitles got the same boundary

Two separate faults, found while adding it:

- The caption **preview** centred the line and applied **no horizontal margin at
  all**, so a long subtitle ran straight off both edges.
- The **export** declared a 6% margin and then set `WrapStyle: 2`, which tells
  libass *not to wrap* — so the margin it had just been given was ignored.

Both now use one shared `CAPTION_MARGIN`, the preview packs words into lines
that fit it, and the export asks libass for smart wrapping (`WrapStyle: 0`).

### What captions cannot inherit

Gradients, metallic fills and glows are **not expressible in `.ass`**, which is
how captions are burned in. Auto-captions can have the colour, weight, outline
and shadow parts of a style, and nothing more, until caption rendering moves onto
the same canvas path the text clips use.

## 11. Animated text — the frames that move, and only those

A trending caption is a still frame of something moving: words arriving one at a
time, a line springing up on the beat. A static style cannot imitate it, however
well drawn.

### The model

An animation is a very small pure function — `src/shared/render/textAnimation.ts`:

```
(progress, index, count) -> { dx, dy, scale, alpha }
```

Offsets are fractions of the font size, so an animation is independent of the
size, the face and the style. That is deliberate: **nine animations multiply the
library rather than adding to it**. Any animation works with any of the 42 styles
on any font.

`scope` says what a piece is — a `word`, a `char`, or the whole `block`.
`stagger` says how far apart consecutive pieces start, as a fraction of the
duration, which is the dial that turns one animation into a family of them.

### Why it stays cheap: bake the movement, hold the rest

The naive approach bakes a PNG per frame of the clip: **ninety files for a
three-second caption**, and ninety full-canvas encodes behind a feature the user
expects to be instant.

Only the frames that *move* are written. `animationFrames` decides how many, and
the last one is held for the rest of the clip by `tpad`. Measured in the app:

| animation | pieces | clip | frames baked |
| --- | --- | --- | --- |
| Pop | 3 words | 90 | **16** |
| Typewriter | 3 words | 90 | **4** |

Two facts make that safe, and both are tested rather than assumed:

- **Every animation settles exactly on `STILL`** by its last baked frame — for
  every piece, at every count. An animation that did not would be frozen
  mid-flight for the whole caption, and no test of the curves would have noticed.
- **`tpad=stop_mode=clone` preserves alpha.** Measured against the bundled
  binary: four frames at 30fps with `stop_duration=2`, trimmed, gave exactly 60
  frames of 2.000s with rgba `7f` still `7f`. Text is nothing but alpha, so a
  filter that flattened it would have been useless here.

### The export path

The baked frames land in `<clipId>.seq/%05d.png` and reach the render plan on the
asset as `frames: { pattern, count }`. `path` still points at the settled still,
so anything wanting one picture of the clip — a thumbnail, an older project —
finds one.

```
-start_number 0 -framerate <fps> -i <clipId>.seq/%05d.png
...
tpad=stop_mode=clone:stop_duration=<clip>,trim=duration=<clip>,setpts=PTS-STARTPTS
```

`-start_number 0` because the frames count from zero and **image2 looks for 1 by
default**. This build happens to find them anyway; a build that did not would
silently drop the first frame of every animation — the one that matters most.

The hold runs **before everything else** in the chain. Speed, motion, the fit,
rotation, opacity keyframes and every transition read clip-relative time and
assume a stream of exactly `duration` frames; a short one would have drifted them
all.

A matte shape gets the hold too. Footage seen through animated words is a shape
that is itself a sequence, and a shape that ran out part-way would leave the
footage with **no alpha at all** for the rest of the clip.

### Turning it off has to clean up

A clip whose animation is switched back to None must have its folder deleted and
`frames` dropped from the asset, or the export keeps replaying a move the editor
no longer shows. Verified in the harness: `frames` cleared, sequence gone.

### What the preview does

The same canvas painter, with a clock of `playhead - clip.start`. The cache
signature includes the frame **only while the movement lasts** — after that it
collapses to `settled` and the canvas is never redrawn again, so holding a still
caption costs nothing.

Measured in the harness, Pop on a 90-frame clip: lit pixels 0 → 196 → 381 → 615
over frames 0..8, then frames 20 and 45 hash **identically** — settled, exactly as
`tpad` will hold it.

## 12. Captions join the library

The 42 styles and 9 animations were reachable from a text clip and from nowhere
else. Captions — the most-seen type in a short video, and the thing the trending
reference packs are actually made of — could have none of them.

### Why: there were two painters

Captions were drawn twice, by two different pieces of code:

| | drew captions | drew text clips |
| --- | --- | --- |
| preview | `captionPreview.ts`, its own layout and wrapping | `drawTextOnto` |
| export | libass, from a generated `.ass` | `drawTextOnto` |

Every look would therefore have had to be built twice — so in practice it was
built once, for text clips, and captions went without. That is the whole
explanation, and it is not a caption problem; it is a **second painter** problem.

So there is now one painter and one description of a caption:

```
captionSpec(style, words, activeIndex) -> TextSpec     shared/captions/line.ts
drawTextOnto(ctx, spec, w, h, clock?)                  shared/render/textPaint.ts
```

The preview calls both. The export calls both. Neither knows anything else about
captions, which is the only arrangement under which they cannot drift apart.
`textPaint.ts` moved out of the renderer into `shared` for exactly this reason —
it is pure canvas work with no store and no window, and it now has three callers
in two processes.

### The one thing a text clip never needed

`TextSpec.highlight` — the word being spoken:

```ts
highlight?: { word: number; color?: string; scale?: number }
```

Deliberately not a style. The index changes every few frames, and it rides ON TOP
of whatever style the line already has: a chrome caption keeps its chrome, and
only the active word turns colour and grows. Measured in the app on a chrome
caption — 761 pixels of highlight yellow against 749 of chrome white, in the same
line.

It is resolved after wrapping, like the existing word accents, because which ROW
a word is in is not known until the rows exist. For a character-scope animation
the word index is expanded to every letter of that word, or a highlight on word
two lands on the second letter of word one.

### Which path an export takes

ASS is genuinely cheaper — libass runs inside the normal encode and costs nothing
extra — so it stays the answer for anything it can express. `captionNeedsCanvas`
decides, and it is a property of *these* captions rather than of the feature:

```ts
style.animated || style.textStyleId !== undefined || style.animationId !== undefined
```

Choosing a look or an animation moves captions to the Chromium frame server,
which is a second pass and slower. The panel now says so — it previously warned
only for the two presets marked `animated`.

### The tier-2 caption layer

One layer per **line**, not per word. The previous build emitted a layer per word
and placed each one by assuming a word is 2.2 font sizes wide — untrue of any real
font, so every caption was slightly mis-spaced in a way no style work could fix.
A line is one layer carrying a `TextSpec`, and the page measures it properly.

What genuinely varies per word survives as `wordFrames`: the frame each word
becomes the spoken one. The page resolves the active word per frame and hands the
painter a spec with `highlight` filled in.

Fonts reach that window as base64 data URLs inside the spec. It has no preload and
no store, so it cannot ask the app for a face the way the editor does; bytes in
the spec also avoid a fetch and a protocol handler. A face that will not load
falls back rather than failing the render — a caption in the wrong font is
recoverable, a black export is not.

### Verified in the browser, both paths

The graphics page was driven directly with a real spec, at 640x360:

| frame | ink | highlight |
| --- | --- | --- |
| 0 | 0 | — |
| 2 | 1218 | — |
| 6 | 4198 | 1088 (word 1) |
| 12 | 4778 | 979 — the pop overshoot |
| 20 | 4665 | 406 (word 2, a shorter word) |
| 45 | 4665 | 990 (word 3) |

The line arrives, overshoots, settles, and the highlight walks along it — and the
finished frame is centred to within **1 pixel** of the canvas centre, inside the
caption margin, in the lower third. The preview, measured the same way, shows the
same curve.

## 13. Styled captions stopped costing a second render

Captions that libass cannot burn in have to be drawn. The first version drew them
the expensive way, and it showed.

### What it used to do

1. Render the **whole video** to a temporary file — a full encode.
2. For every frame: `executeJavaScript` into an offscreen Chromium window, wait a
   **double `requestAnimationFrame`**, then `capturePage()` and `toBitmap()`.
3. **Decode that video again** and re-encode it with the frames overlaid.

Two encodes, one decode, and a browser screenshot per frame. The double rAF alone
is ~33ms, so a sixty-second video spent a minute waiting before any pixels were
compressed.

### What replaced it

Captions are painted on a canvas now, so none of that is needed. They are baked
in the renderer — where the fonts already live — and handed to the **existing
single-pass graph** as one more input:

```
-f concat -safe 0 -i captions.txt
[N:v]fps=FPS,format=rgba[cap];[vmix][cap]overlay=0:<band>:shortest=1[vcap]
```

Two observations do the work:

**A caption is mostly still.** Between one word lighting up and the next, every
frame is the same picture. The concat demuxer's `duration` holds one file for as
long as it is on screen, so 598 frames of a 60-word timeline bake **61 pictures**
— one per word, plus one blank that every gap reuses.

**A caption occupies a band.** Everything above it never changes, and compositing
is the single biggest cost in the render.

### Measured, at 1080×1920

Overlay cost, per ten seconds of video:

| | render |
| --- | --- |
| no captions at all | 1.75s |
| **band overlay, single pass** | **2.61s** |
| full-frame overlay, single pass | 5.15s |
| the old second pass *alone* | 4.44s |

And the band pays twice, because a PNG of it is cheaper to encode too: **13.8ms
full-frame against 3.8ms**.

The band is measured rather than guessed. The settled line is painted once and
its ink found — only a real paint knows how many rows the text wrapped into and
how far a glow spreads — then grown by exactly how far *this* animation throws a
word. `animationBounds` samples the curve rather than reading its endpoints,
because every good arrival overshoots past both. Checked against every baked
picture of a per-letter bounce: ink 892–1506, band 858–1628, nothing clipped.

### The bake, pipelined

Drawing a picture costs 0.13ms; turning it into a PNG costs 16ms, off-thread. So
awaiting each one leaves the encoder idle while the next is drawn. Four canvases
in flight:

| | 60 pictures |
| --- | --- |
| one at a time | 1000ms |
| two at a time | 502ms |
| **four at a time** | **264ms** |
| eight at a time | 250ms |

WebP was measured and rejected: 21ms lossless (and four times the bytes) or 91ms
lossy, against 16ms for PNG. Narrowing the band horizontally was measured and
rejected too — 16.2ms against 16.5ms, because the cost is the gradient's entropy,
not the pixel count.

### End to end, on twenty seconds of 1080×1920

| captions | old path | now |
| --- | --- | --- |
| a styled look | ~32s | **~6s** |
| plus a word-by-word pop | ~32s | **~8s** |
| plus a per-letter bounce | ~32s | **~9s** |

### A note on measuring

The pipelining appeared to do nothing on first measurement — 8584ms before and
after. It was a **stale module**: a dynamic `import()` of a path already imported
returns the cached copy, so the new code was never running. Cache-busting the
import showed the real figures above. A harness that reports confidently and
wrongly is worse than no harness, which is the third time that lesson has come up
in this codebase.

### What this leaves behind

`startTier2Render`, the frame server and the graphics page still exist and still
work — they are where a future graphics layer that genuinely needs a DOM would
go. Nothing routes to them: `needsFrameServer` returns false, and captions decide
between libass and the bake with `captionsNeedBaking`. The "check graphics
engine" button was removed from the captions panel, since it probed a subsystem
the feature beside it had stopped using.

## 14. Split screen and picture in picture

Two layouts that the transform could always express and that nobody could reach,
because there was no button for them.

### Neither one needed anything new in the renderer

A clip's transform already says how wide its box is (`scale`), how tall
(`scaleY`), where it sits (`x`, `y`, in half-canvas units) and whether it fills
that box or letterboxes inside it (`fit`). Those four went in for the film strip.
A split screen is the same idea with the panels stacked instead of side by side,
so `render/layout.ts` is arithmetic and nothing else — the clips carry the
numbers, and the preview and the export both already knew what to do with them.

The offset is the only part worth writing down. A box of 1/N the frame sits
centred by default and has to move to `slot/N` of the way down; in half-canvas
units that difference is:

```
(2·slot + 1)/N − 1
```

−0.5 and +0.5 for a two-way split, and ±2/3 with a zero in the middle for a
three-way — so a three-panel layout costs nothing extra. `cover` is not optional:
without it a landscape shot in a half-height panel becomes a thin band floating
in black, which is the exact failure the film strip hit.

A picture in picture is the same arithmetic with a gap from the edge. One
conversion matters: `scaleY` is measured against the HEIGHT, so 0.3 of the width
and 0.3 of the height are the same number and very different boxes in a 9:16
frame. A square inset has to convert through the aspect or it comes out tall.

### Rounded corners, which did need something new

Rounded corners are most of what separates an inset that looks placed from one
that looks pasted on, and the mask had only hard rectangles and ellipses. The
rectangle now takes an optional `radius` and switches to the standard rounded-box
distance:

```
clip(((r) - hypot(max(|x| − (rx − r), 0), max(|y| − (ry − r), 0))) / feather, 0, 1)
```

Pull the radius in from both half-extents, measure how far outside that inner box
the point sits on each axis, take the length of the pair. Near a flat edge one
term is zero and the sides stay straight; only at a corner do both contribute,
and there the result is the arc.

That depends on **`max` being available inside `geq`**, which is documented
nowhere obvious. Measured against the bundled binary before the code was written:
it is. The radius is a fraction of the SHORTER half-extent, so corners stay
circular instead of stretching into ovals on a box that is not square.

Because a mask is sized against the clip's own stream rather than the canvas — a
decision made back when masks first met PiP — the frame travels with the inset
when the inset is moved, which is what anyone would expect of it.

### Verified in the app, not just in tests

The circle and the rounded rectangle were both checked by differencing the
preview against the unmasked version, which isolates exactly what the mask cut:

| | pixels changed vs a square box | geometry predicts |
| --- | --- | --- |
| radius 0.35 | 130 | ~123 |
| circle | 999 | ~1005 |

The circle's cut region came back with a square bounding box, corners removed and
edge midpoints untouched — an inscribed circle, and not something a rounded
rectangle could be mistaken for.

One measurement error is worth recording, because it nearly sent me after a bug
that did not exist: the first attempt tested "is the corner cut?" against the
bounding box of the cut pixels themselves, which is circular — if little is cut,
the box shrinks to fit whatever was, and the corner test passes trivially. The
fix was to difference against a known-square render instead.

### What is deliberately not here

No split-screen *mode*. Both layouts write a box into an ordinary clip and stop,
so the escape hatch is to drag the clip, resize it, or press **Full frame** —
there is no state to leave and nothing hidden. Sheet 16's drop targets and
sheet 17's stock-image API are still open.

## 15. Four bugs from one editing session

A user playing with music and text animations hit an export crash and three
things that behaved unlike an editor. All four turned out to be separate.

### The crash

```
Invalid too big or non positive size for width '3210' or height '1808'
```

`crop` is the one filter whose arguments are checked against the real stream,
and it **refuses rather than clamps**. Two things were wrong:

**The arithmetic.** Crop dimensions were rounded to the NEAREST even number, and
rounding an odd number to the nearest even one rounds it UP — so a 3209-wide
source was asked for 3210 pixels. Both numbers in the error are exactly
`even()` of an odd dimension. Swept over every realistic source size crossed
with the three aspect ratios: **7566 of 15113 pairs — half — produced a crop
reaching outside the frame.**

**The belief.** Rounding down fixes the arithmetic but not the several ways the
app's idea of a source's size can be wrong: the probe reads `width`/`height`
from ffprobe and never looks at `side_data_list`, so a phone video's rotation is
dropped; a parallax clip arrives as a plane composite that has already been
scaled; a file re-exported at a different resolution under the same path keeps
the dimensions the project recorded.

So the crop is emitted as **expressions**, evaluated against what actually
arrives:

```
crop=w='min(1080,in_w)':h='min(606,in_h)':x='max(0,min(420,in_w-out_w))':y='…'
```

Measured: asking for 3210x1808 of a 1280x720 stream yields 1280x720 instead of
killing the export, and it survives inside a `filter_complex` with filters either
side — which is where the commas in those expressions could have gone wrong and
do not.

One correction worth recording: the first version of `safeCrop` pinned the
corner and took whatever width was left, which turned a 400x400 crop at x=1800
into a **120x80 sliver** — a different shape from the one the user framed. The
size is their choice; only the position may move.

### Overlays stacked sideways

> "when i try to add two layers like text on text or try to add image in the
> timeline, its add on the side of it of the same track, but the actual layers
> work different, its on top of each other be it any N layers"

`findFreeSlot` slides a colliding clip LATER until it fits. That is right for a
cut — two clips on one track are a sequence, which is what a track is — and
wrong for anything meant to sit ON something. `stackedSlot` climbs instead: the
asked-for track, then each track above it, then a new one. **The time never
moves**, because the moment is the whole point of the gesture.

Applied to text cards, stickers, props, titles, colour cards, adjustment layers
and sounds. Not to cuts, and not to dragging an existing clip.

It also generalised for free: sounds stack the same way, which is what sheet ⑤
meant by "adding music on top of each other".

One prerequisite fell out of it — `addTrack` built ids from a bare millisecond
timestamp, fine while the only way to make a track was clicking `+ Video`, and
a collision waiting to happen now that overlays add them in a loop.

### Captions vanishing from the preview but not the file

The preview took the **topmost** layer at the playhead as the caption source;
the export built from the **bottom** video track. So putting a text card over the
picture made captions disappear on screen while they still burned into the
export — a caption missing only where you can see it. Both sides now ask one
shared `captionSourceClip`.

Known limit, unchanged: a transcript belonging to a clip on an upper track is
still never read.

### Three things called Text

> "there are 3 slots we gave in our pipeline just for the captions… two options
> one for captions and one for the text cards they both same"

Five producers, not three — text cards, captions, title templates, library fonts,
and the transcript. The confusion was earned:

- The left-panel tab labelled **Text** was the **transcript**. Renamed.
- Captions and text cards genuinely share a painter, a style library and an
  animation library — `captionSpec` returns a `TextSpec`. They *are* the same
  thing rendered; what differs is where the words come from. Both panels now say
  so in one line.
- The caption panel exposed 6 of 16 style fields and could not be moved at all,
  while a text card had 10 and dragged anywhere — which is why text cards looked
  like the better captions. Position, margin and the base colour are now
  reachable; all three were already honoured end to end and simply had no
  control.
- Two "Size" sliders: points against a 1080 reference in one panel, per cent in
  the other. Both are per cent now, through the same shared component.
- `CaptionStyle.animated` predated the animation library and nothing read it, so
  the Kinetic preset advertised per-word motion with a badge and rendered
  perfectly still.
- "None" in either picker wrote `undefined` under the override key rather than
  removing it, leaving Reset permanently lit.
- Picking a caption preset wiped the chosen style and animation; picking a text
  preset kept them. They agree now — a preset resets the typography and keeps
  the look, which is the separation the style library is built on.

## 16. The rest of the sweep

The remaining findings from the same investigation, each verified against the
code before being acted on.

### Captions were timed against a timeline that did not exist

Both caption builders walked a cursor of accumulated durations —
`timelineCursorMs += clipDurationMs` — and never read `clip.start`. Those are the
same number only while every clip is packed against its neighbour from zero.
Leave a gap, or drag one clip later, and every caption after it drifts by the
size of the gap.

A test had encoded the bug and passed: it set `start: 30`, described the setup
correctly as "lands at 1s of timeline", and then asserted the cue began at
`0:00:00.00`.

Measured after the fix, on a clip sitting at frame 60 of a 30fps timeline: the
export's first cue is `0:00:02.00` and the preview shows captions across exactly
that span. Before, the export said zero while the preview said two seconds.

### Captions ignored a transcribed clip that had moved

`captionTrack` was "the lowest visible video track", full stop. That was a safe
assumption until overlays started stacking — which is now what happens whenever
two things are added at the same moment. A clip that had been transcribed and
then moved up a track produced no captions at all.

It now prefers the lowest track that actually HAS something transcribed on it,
falling back to the lowest. Two tracks captioning at once would be two people
talking over each other, so it still picks exactly one.

### Opening a project forgot which shape it was

`aspect` is a slice of its own, initialised to 16:9, and `loadProject` never
touched it — while every reframe decision reads `ASPECTS[aspect]` rather than
`project.settings`. So a saved 9:16 project reopened into a fresh session looked
correct, and the next clip dropped onto it was cropped to a horizontal rectangle
inside a vertical frame, with nothing on screen to explain why.

`aspectOf` matches on the ratio rather than exact pixels, so a project saved at
another resolution of the same shape still opens as that shape. The table moved
to `shared/render/aspect.ts` on the way, which is where it belonged: it is a
property of the project, not of the window looking at it.

### Generated cards kept stale dimensions

`rebakeGenerated` redraws text, colour and title PNGs at the current canvas size
after an aspect change, and updated only `path`. The asset kept whatever
dimensions it was created with — so the file was 1080x1920 while the project
still believed 1920x1080, and everything that measures against an asset's size
(the crop solver, the camera move's pre-scale) worked from the wrong number for
the rest of the session.

### Props landed on top of each other

`applyPropRule` consulted nothing at all — no `findFreeSlot`, no `overlapsOn`.
Every prop went onto the single overlay track at the frame its keyword hit, so
two keywords close together put two clips in the same place and only the later
one was ever visible. They stack now, threading a working project through the
fold so each prop sees the ones already placed.

### The crop handles showed numbers the export disagreed with

`CropOverlay` clamped in floating point and rounded afterwards, so a rectangle
dragged to the very edge could round back out past it. It runs its result
through the same `safeCrop` the render plan uses, so what the overlay draws is
what gets cut.

### Still open

Three findings were left deliberately:

- **The font library is inert.** Every other asset kind spreads drag handlers
  onto its tile; the font branch returns early with none, so the specimens
  cannot be dragged or clicked.
- **Nothing converts between the transcript and a text card.** Clicking a
  transcript line only moves the playhead; the spoken words still have to be
  retyped by hand.
- **Dragging a clip over an occupied region teleports it** past the blocker
  rather than stopping against it, because `moveClip` walks `findFreeSlot` on
  every pointer move.

---

## 17. The grid split — one photograph, cut into pieces

Sheet ① of the notebook, and the one sheet I had read backwards. I had assumed
it meant several photographs laid out in a grid; it says the opposite. One
picture, diced into 2, 3, 4, 5 … N pieces, each piece arriving on its own beat
until the photograph is whole.

That is a much better effect than the one I had imagined, and a cheaper one.

### Where it lives

`shared/render/grid.ts` is the geometry and `shared/automation/grid.ts` is the
timing. Between them they produce ordinary clips — a crop, a box, sometimes a
mask — and the renderer needed nothing new at all.

### Why crops and not masks

A piece could just as easily be the whole photograph with a rectangle masked out
of it. The pieces would then register perfectly with no arithmetic: every stream
is the full canvas, so a shape at 25% across means the same thing in all twenty.

It would also be twenty full-frame `geq` passes on every frame of the render.
`geq` is a per-pixel expression evaluated once per plane; a 4×5 grid at 1080x1920
would evaluate it about forty million times a frame. Cropping first means each
piece is a twentieth of the canvas, so the twenty shapes between them cost one
canvas — and a plain square piece needs no shape at all and emits no filter.

### Cutting on every beat, which everything else avoids

`cutPlan.ts` opens by saying never to cut on every beat, and this rule ignores
it. Both are right, because they are about different things.

The rule against beat-for-beat cutting is about SHOTS. A new shot every beat at
128 BPM is 128 shots a minute; nothing is on screen long enough to be read. A
grid piece is not a shot — the frame does not change, it fills in. There is
nothing to re-read, so the pulse is felt rather than chased. Twenty pieces at
128 BPM is nine seconds of a picture arriving in time with the music.

So this rule reads the beats directly rather than going through the planner.

### A count becomes a rectangle

The sheet asks for "2, 3, 4, 5, 6 … N", so a number has to become rows and
columns. Only a factor pair will do — one picture is being divided and every
piece must be used, so 5 cannot be a 2×3 with a hole in it. Among the factor
pairs, the one whose CELLS come out squarest wins, which is why the canvas
aspect is an input: in a 9:16 frame two pieces stack, in 16:9 the same two sit
side by side. Both are drawn on the sheet and neither needed to be an option.

Primes give strips. Five horizontal bands across a tall frame is a real effect,
and a five-piece grid is not a thing.

### Waves

"Some options on Grid: square, Circle, …… if possible Waves."

Possible, and it took three goes to get right.

**It has to be displacement, not width modulation.** Widening a piece by `sin`
moves its two edges in opposite directions, so the piece next door — widening by
the same amount at the same height — either overlaps it or leaves a gap. Sliding
both edges the same way instead makes one piece's right edge and its neighbour's
left edge literally the same curve.

**Each edge needs its own amplitude.** An `abs` about the centre can only
describe two edges that move together, which is right in the middle of a grid
and wrong at its border, where the outer edge has to stay straight — a wave
there carves notches out of the frame and shows the black behind it.

**The piece has to be cropped wider than its slot.** A cell can only draw inside
its own stream, so an edge that bulges outward has nowhere to land: the picture
stops at the box and every crest is shaved flat. The stream is widened by the
wave's reach and the crop widened to match. Without this the effect half-works,
which is worse than not working — the troughs interlock and the crests gap.

**And the phase comes from the canvas, not from the row.** Dividing the cycle
count by the number of rows is correct only while every stream is the same size,
and they are not: a piece in the middle of the grid is widened on both sides
while one at the border is widened on one. Counting in rows put a slightly
different frequency on the middle row — invisible inside a piece, and a visible
jog in the seam every time it crossed a row boundary.

Measured before any of it was written: `sin` and `PI` are both available to
`geq`, and a probe at 0.4W ± a 0.1W wave of two cycles put its edges at 40/360,
80/400 and 0/320 on the rows where the sine reads 0, +1 and −1. Predicted to the
pixel.

### Two bugs found on the way

**A turned clip was losing its corners.** `rotate` keeps the input's dimensions
unless told otherwise, and the diagonal of a rectangle is longer than its side —
so a square turned by any angle at all lost four triangles, 29% of its area at
45°. The preview never had this problem, because a canvas rotation carries the
whole rectangle with it, so the two had always disagreed about what a turned
clip looks like. `rotate` now grows its output to `rotw`/`roth` and the overlay
starts half the growth earlier to leave the picture where it was. This is not a
grid fix — every rotated prop and sticker in the app was being clipped.

Keyframed rotation has to be sized for its widest angle rather than its first,
because `rotate` fixes its output size when the graph is configured and never
revisits it: an expression there is evaluated once and quietly describes the
wrong frame for the rest of the clip.

**A 1.6px black line down the middle of the frame.** `clipBox` rounds a clip's
box to an even number of pixels and its position to a whole one. Working in
exact fractions and letting it round afterwards put the box up to a pixel from
where the shape inside it had been measured — which does not matter for a
sticker and matters a great deal here, where the shape's edge IS the join. The
rounding now happens once, in the grid, and everything downstream is told about
it. Pieces grow rather than shrink where the division is not exact, so
neighbours overlap by a pixel instead of parting by one.

### A test that lied about the answer

The first "is the cut wavy?" test looked for the colour boundary in the finished
grid and reported a dead straight line. The cut was fine. A wavy piece is
cropped WIDER than its slot — that headroom is the whole point — so each piece
carries a strip of its neighbour's content under the mask, and the detector was
finding the photograph's own edge sitting exactly where the picture put it.

Rendering ONE piece against the empty canvas makes the last lit pixel in a row
unambiguously the cut. Eight integration tests now render real frames: the
quadrants land where they came from, the seam holds, twenty pieces fill the
frame, the wave interlocks and genuinely moves, circles leave the corners empty,
and a turned clip keeps its corners and stays centred.

The canvas preview was checked against the same numbers rather than by eye: its
cut comes back at 89..125px where ffmpeg's comes back at 89..127. Preview and
export agree.

---

## 18. Speed ramps are one filter, not a stack of clips

Measured before building anything, because the answer decides the design.

Every editor I know of implements a speed ramp by cutting the clip into segments
and giving each one a constant rate — five or six steps, smoothed by eye. That
would have worked here and it would have been ugly: five clips on the timeline
where the user put one, and five places for a rounding error to show.

It is not necessary. `setpts` takes an expression in `T`, and a ramp is just a
time remap: if the rate goes from `s0` to `s1` linearly over `D` seconds of
source, the output time is the integral of `1/speed`, which comes out as

    output(T) = D/(s1 - s0) · ln( speed(T) / s0 )

`log` is available to `setpts`. Probed on 2s of 30fps source ramping 1× → 0.25×:

  - **Duration:** predicted 3.697s, ffmpeg returned **3.70s**.
  - **The mapping, frame by frame.** A source whose every frame is a flat grey of
    `N*4` makes "which frame is this?" readable as a number. At output 1s, 2s
    and 3s the ramp showed luma 100, 168 and 217 — source frames 25, 42 and 54,
    against a prediction of 25, 43 and 54. A constant stretch over the same
    duration would have shown 16, 32 and 49.

So the ramp is genuinely accelerating, one filter, one pass, no extra clips.

**Built 2026-09-26** as `Clip.ramp: { from, to }` (render/speed.ts). The
filter is `setpts='(D/(to−from))*log((from+(to−from)*(T−STARTT)/D)/from)/TB',fps=30`,
with D the footage the ramp plays (`duration × rampRate`, the log-mean of the
two ends). The render check (tests/integration/ramp.int.test.ts) reproduces
these numbers from the app's own plan: a 1× → 0.25× clip of 110 frames read
source frames **25, 42 and 54** at 1, 2 and 3 s, and the preview's
`sourceFrameAt` seeks to the same three. Two things the build had to add:
every decode window is sized by `sourceFramesFor`, so the ramp is a branch
there (a ramp decoding its OUTPUT length as source runs past T = D, where the
log goes negative); and a ramped clip's own sound is left out — `atempo`
cannot follow a curve.

---

## 19. What the adversarial pass found in §17

Sixteen confirmed defects in the grid split and the rotation change, from five
reviewers and twelve verifiers, every finding reproduced against the bundled
binary before it was accepted. One was dismissed as unreachable dead code.

Most of them were mine, and three are worth writing down properly.

### The shipped default did not work at all

`Landing: Pop in` is the default, and a pop-in attaches zoom keyframes. That
fires `zoomKeyframeFilter`, which sized zoompan from the WHOLE photograph — but
it runs after the crop has already cut the stream down to one cell. zoompan is
handed a fixed output size and stretches whatever arrives to fill it, so each
piece was squashed into the file's aspect and then centre-cropped by `cover`:
about 40% of itself at nearly two and a half times the right size, on every
frame, not merely during the animation.

Every one of my integration tests built with `'cut'`, which emits no zoom at
all. The one arrival the app ships as its default was the one nothing rendered.

The fix is one variable: size it from the post-crop stream. The same hole exists
in `motionFilter`, which already had an `overrideSize` parameter for parallax
planes and now gets the crop too.

### A test that passed against the bug

Rebuilding the pop-in test was a second lesson. The first version compared a
'pop' render against a 'cut' render pixel by pixel — and passed with the bug
deliberately put back. The fixture is four flat colours, and a squashed,
centre-cropped rectangle of solid red is still solid red.

The test now uses a striped picture and counts stripe edges, where a wrong
magnification is not a matter of opinion. Reintroducing the bug gives 4 stripes
where there should be 8, which is what a regression test is for.

### Growing the rotation broke every shape in the renderer

§17's rotation fix grew the frame so a turned clip keeps its corners. Every
stencil in this renderer is sized against the clip's BOX — a mask's `geq` reads
the stream's own `W` and `H`, a luma wipe is scaled to the box, a track matte is
canvas-sized and cropped to it — and `alphamerge` refuses two streams of
different sizes. So the growth broke masks, wipes and mattes on any rotated
clip, and where it did not fail outright it drew the shape at the wrong size in
the wrong place.

Two reviewers arrived at the same one-line answer independently: rotate AFTER
the shape is applied, not before. The stream still ends up grown and still lands
in the same place; only the moment it grows changes. It also gets the picture
right — the shape now turns with the photograph, which is what the preview's
canvas rotation always did.

The same growth displaced the `zoom-in` transition, which was written in canvas
pixels. It is now written against `iw`/`ih`, which fixes a second, older bug:
a picture-in-picture zoomed on used to be blown up to full frame.

### The grid was not on the beat

`arrivalFrames` subtracted the first beat so the grid would "start at zero". The
caller then adds the music clip's position — which the analysis is already
measured from. Every piece slid earlier by however far the first downbeat sits
into the track. The spacing stayed perfect and the grid looked completely fine;
it simply landed on nothing. On a song with a 900ms intro, every piece was 27
frames early.

`planCuts` has always emitted window-absolute times. This now does too.

### The rest

- **Dragging a piece threw it past the whole grid.** `moveClip` resolves a drag
  with `findFreeSlot`, which walks forward past everything it collides with.
  Grid pieces all overlap and all end on the same frame, so one frame's nudge in
  either direction sent a piece to the end of the assembly, where it played
  alone over black. `moveClip` now asks whether a clip is already stacked where
  it sits — if it is, it is a layer, not a link in a queue, and the asked-for
  position is honoured. The filmstrip had the same hazard and gets the same fix.
- **The grid and the reel fought over one lane.** Both anchored at the music,
  both on the first unlocked video track, and the reel's `findFreeSlot` walked
  past the entire grid — displacing every shot several seconds late, off the
  music it had just been cut to. The grid takes the topmost lane now, and
  neither Build button is live while the other rule is running.
- **A project swap mid-analysis wrote orphaned clips.** Analysing goes to the
  sidecar and takes seconds; opening another project in that window left twenty
  clips stamped with an asset the new project has never heard of. Saving is
  silent when the file already has a path, and re-opening a project whose clips
  name a missing asset throws rather than offering to relink — so this was a
  quiet way to lose a file. The photograph and the lane are re-checked after the
  await.
- **"All at once" was not.** It asked for N arrivals and then collapsed them,
  which put every piece on one frame but stretched the grid's length over N
  beats of nothing happening.
- **A dark hairline along every seam.** `maskExpression` runs its softness
  INWARD from the edge it is given, so two cells meeting at a join are both
  transparent along it, and `over` of two zeros is a zero. Half a feather of
  bias is not enough either — `over` of two half-covered edges comes to three
  quarters, a grey line rather than a black one. Each cell's shape is now grown
  by a full feather with the feather fraction shrunk to match, so coverage is 1
  at the cell's own edge and falls to 0 inside the neighbour's solid area. The
  cells that do not tile — a plain square, a circle — are deliberately left
  alone.
- **Odd crops lost a pixel.** The export runs every rectangle through
  `safeCrop`, which rounds a dimension DOWN to even. An odd crop therefore lost
  a source pixel the box still expected, and `cover` amplified the difference by
  the cell's aspect — a grid of narrow strips came out as a staircase, each
  strip at a slightly different magnification. Crops are now grown outward to
  whole even rectangles, the same "grow, never shrink" rule the boxes use.

---

## 20. What the reference reel measures at

A screen recording of a CapCut template by `cpttmplate`, sent as "this is what I
was imagining". 19.76s, 1180x2556, 59.94fps, with the template's music on it.
Everything below is measured off that file rather than described.

### The track

112.3 BPM. Autocorrelating the onset envelope gives periods at 1.057s, 0.534s
and 0.267s — a bar, a beat and an eighth. A sixteenth is 134ms, which at 30fps
is exactly four frames.

### Two phases, one primitive

**0 to 7.6s — the assembly.** One photograph diced into a **4x4 grid**, pieces
arriving in scattered order until the picture is whole. This is sheet ① exactly,
and it is the thing already built.

**7.6 to 19.8s — strips.** Continuous footage with vertical strips, horizontal
bands and diagonal wedges of a BRIGHTENED treatment flashing in and out. Not
shot cuts: the underlying footage runs on, and what changes is which strips are
showing the alternate grade. Sampling that section every 133ms — one sixteenth —
shows the strips moving one notch per frame sampled.

Both phases are the same primitive with different settings: a masked cell landing
on a beat. What differs is whether the cell accumulates or is momentary, whether
it is a grid cell or a full-height strip, and whether it shows the photograph or
a treated copy of it.

### How tightly it is actually synced

56 visual changes detected in the preview area, against 55 onsets in the audio.
After removing a constant +70ms screen-recording lag:

| grid | within one video frame (33ms) | median error |
|---|---|---|
| quarter note (534ms) | 23% | 114 ms |
| eighth note (267ms) | 45% | 42 ms |
| **sixteenth note (134ms)** | **73%** | **20 ms** |

20ms is one frame at 60fps. The remaining 27% are mostly camera movement inside
a shot rather than a change, plus a stretch where the recording caught an
Instagram advert scrolling past.

Brightness flashes were measured separately: 10 of them, **9 on the sixteenth
grid**, and they arrive in bursts — three on consecutive sixteenths, then a gap.
A triple-flash stutter, not an even pulse.

### Cut density

| | changes | rate |
|---|---|---|
| assembly, 0-7.6s | 14 | 1.8/s |
| strips, 7.6-19.8s | 42 | 3.5/s |

Gaps between changes, in sixteenths: during the assembly mostly **2** (an eighth)
with some 3s and 4s; during the strips mostly **1** (a sixteenth) then 2.

So it roughly doubles in rate once the picture is whole, and it never holds
still for longer than half a bar.

### What this proved wrong

**The cadence control could not express it.** `beatsPerCell` ran from 1 to 8
BEATS. The reference lands pieces on EIGHTHS, so the fastest setting the app had
was half the speed of the thing it was modelled on. Beats are now subdivided as
well as skipped — 0.25, 0.5, 1, 2 and 4 beats — and the default is twice a beat.

Subdivisions are interpolated between the detected beats rather than derived
from the tempo, so they follow the performance: a bar that drags takes its
eighths with it, where a rigid tempo grid would come loose exactly where the
music is most expressive.

**"Never cut on every beat" needed splitting in two.** The finding in
`cutPlan.ts` is about SHOTS and it stands — a new shot every beat is frantic.
But this template changes something four times a beat and does not read as
frantic at all, because what changes is a treatment over continuous footage, not
the shot. Those are different rules and the codebase was applying one of them to
both.

### Still not built

The strips phase. Momentary cells rather than accumulating ones, full-height
strips and diagonal wedges as cell shapes, a brightened duplicate as the cell's
content, and flash bursts on consecutive sixteenths. All of it sits on the grid
machinery that exists; none of it is reachable from the panel today.

---

## 21. Strips — the reference's second half

Built from the measurements in §20 rather than from an impression of them.

`shared/render/strips.ts` is the geometry and `shared/automation/strips.ts` is
the timing, and the first is deliberately thin: a strip IS a grid cell —
`gridCells` with one row, or one column — so columns and bands cost nothing new.
Everything that makes the two effects look different is a setting.

| | the grid | the strips |
|---|---|---|
| lifetime | accumulates | one subdivision, then gone |
| content | the photograph | a brightened copy of the shot |
| cadence | eighths | sixteenths |
| lands on | its own layer, alone | a layer above footage that keeps running |

### Why this may fire four times a beat

`cutPlan.ts` spends its whole preamble arguing against cutting even once a beat,
and this rule ignores that four times over. They do not conflict. The finding
there is about SHOTS — a new shot every beat is frantic because nothing is on
screen long enough to read. Nothing here changes the shot. The footage runs on
underneath and what changes is which slices of it are wearing a different grade,
so there is nothing to re-read and the rate is felt as rhythm.

Two different rules; the codebase had been applying one of them to both.

### The diagonal

Columns and bands are crops and boxes. A band at an angle is not a rectangle of
the source, so it is the whole frame with a turned rectangle masked out of it —
a per-pixel expression, affordable only because a flash is four frames long.

The part worth writing down is how a band moves sideways. `maskExpression`
rotates about the shape's centre, so sliding a band across the frame means
moving that centre along the band's own PERPENDICULAR: for a band at angle t, an
offset of p pixels is `(-p·sin t, p·cos t)`. Offsetting x alone slides the band
along its own length, which looks like nothing happening at all.

The rectangle is also made far longer than the frame, so its ends are never in
shot at any angle — a band whose end wanders into view reads as a floating box
rather than a sweep.

Four rendered tests cover it: the band comes back at the angle it was asked for
(checked at 30° and 62°, so the measurement tracks the parameter rather than
agreeing with one number), one of five bands covers between a tenth and a third
of the frame, five together leave less than 2.5% of it dark, and two
neighbouring bands overlap on under 8% of what they cover.

### What it does not do

The flashes take the shot's own asset, so what lights up is a treated copy of
the same picture — the effect depends on the viewer recognising it. They are
silent, they sit on the track above, and deleting every one of them leaves the
shot exactly as it was.

---

## 22. Cutting to the lyric

Beats are the metre. They are not where the expression is. A singer pushes
ahead of the beat or lays back behind it, and that displacement IS the
performance — so an edit placed on the beat during a vocal line reads as
mechanical, and the same edit placed on the sung syllable reads as though
someone was listening. This is the second source.

### Pulling the song apart, with the ffmpeg we already ship

`src/main/stems.ts`. Mid/side, and the two halves are not equally good, which
is worth saying rather than calling both of them "separation":

| | what it is | measured |
|---|---|---|
| **instrumental** | the side signal, L−R | centred tone **−29 dB**, panned tones untouched |
| **voice** | mid, high-passed at 200, low-passed at 8k, levelled | voice kept at full level, bass **−13 dB**, hard-panned content only **−3 dB** |

So the instrumental is a real cancellation — that is sheet ⑥'s "instrumental
only", done, with no new dependency. The voice is an EMPHASIS and the result
says so in a `quality` field, because speech recognition needs the words
legible rather than the stem pristine, and calling it "the vocals" would be a
lie the rest of the code would then believe.

Both halves come out of ONE ffmpeg invocation. Decoding a five-minute song twice
to write two files from the same input is the kind of waste that only shows up
later as "why is this slow".

A mono source has no side signal at all, so the chain forces stereo first —
otherwise a mono song comes back with a silent "instrumental" and no error. That
case has its own test.

**Demucs** is the real separation and lives in the sidecar as
`capabilities/stems.py`, optional because it brings torch — several hundred
megabytes for one feature. It is not in `requirements.txt`; there is a
`requirements-stems.txt` for people who want it. Absent, the sidecar reports the
capability degraded and the app falls back without being asked.

### Where the punch is

`shared/automation/lyrics.ts`. The granularity ladder, and where it stops:

| level | source | status |
|---|---|---|
| beat, bar, drop | librosa | built |
| **word** | Whisper word timestamps, on the voice track | built |
| **syllable** | the word's own spelling and span | built |
| phoneme | a forced aligner | **deliberately not** |

Phonemes are left out on the numbers rather than on effort. At 30fps one frame
is 33ms and phonemes sit 50–80ms apart, so the entire range of the thing is one
or two frames. It earns its keep for lip-sync. It does not pay for itself in a
music edit, where syllables are already finer than the eye resolves.

What DOES pay is which sound a word opens on. A plosive — p, b, t, d, k, g —
begins with the vocal tract sealed and then releases it, so it has a genuine
transient in it, the same shape as a drum hit. A word opening on a vowel has no
edge to cut on at all. That difference is worth more than any amount of extra
timing precision and it costs a lookup table, read off the spelling — which
sounds like a compromise and mostly is not, since the first sound of the written
word and of the sung one are the same sound.

### The hybrid, which is the whole point

Not a choice between beats and lyrics. `planCuts` now takes a third source:

- **structural moments first** — a drop is a bigger event than a word.
- **then lyrics**, at their own times.
- **then the grid** fills what is left.

Order is the entire mechanism. `push` refuses anything within 120ms of a cut
already placed, so whichever source goes first owns the moment. A lyric inserted
after the grid would lose to a grid cut two frames away and be silently replaced
by the mechanical version of itself — which is precisely the thing cutting to
the lyric exists to avoid.

The snap window is **16ms**, half a frame, and deliberately tiny. A vocal 30ms
off the beat is a performance and is left alone; one 8ms off is the same moment
and may as well be tidied. `offGridShare` reports how much of the vocal survived
un-quantised — if it comes back near zero the window is too wide and the edit has
been quantised into the thing it was supposed to be an alternative to.

**A lyric cut never gets a transition**, even when the caller asks for
transitions on everything. The reason to put an edit on a plosive is the
hardness of it; dissolving through that moment spends it.

---

## 23. The chain, end to end — and two bugs it exposed

"Cut to the words" in the reel panel. One toggle, four steps:

    split the song   ->  voice + instrumental (mid/side, §22)
    read the vocal   ->  words with their own timings
    weigh the words  ->  a plosive is an attack, a vowel is not
    plan             ->  a third source beside the grid and the structure

Nothing about it is required. A track with no words, a model that is not
installed, a transcription that comes back empty — each of those means the reel
is built on beats alone, which is what it did before any of this existed. The
toast says so and the build carries on.

Every shot is labelled with what it landed on, so the timeline reads back
against the song:

    section change
    on "Break"
    on "tonight"
    on "dance"
    on the drop
    on "gone"
    on the beat
    on the beat

"away", "and" and "over" are missing from that list, and should be: all three
open on a vowel and have no edge to cut on.

### The reel had been drifting off the beat all along

Driving the chain in the harness showed the lyric cuts landing near the words
rather than on them — and then showed something worse. The planner was exact;
the timeline was not:

| planned frame | 0 | 61 | 121 | 180 | 240 | 301 | 360 | 420 |
|---|---|---|---|---|---|---|---|---|
| **landed on** | 0 | 61 | 121 | 181 | 234 | 295 | 347 | 400 |

Cumulative, and worse the further in it went. `addTransition` closes the
timeline up around the overlap — the incoming clip slides back to meet the
outgoing one and **everything after it follows**. That is correct for a
hand-cut edit, where a transition consumes time and the rest closes up behind
it. For anything cut to music it is silently destructive: every start was
computed against a beat, and each transition drags all the later ones off it.

Note the two clips at 295 and 400 that have no transition of their own. They
were displaced by somebody else's.

At the default rate — a majority of cuts carrying a treatment, seven frames each
— a thirty-shot reel finishes close to **four seconds adrift** of the track it
was cut to. Nothing reported it, because every individual transition was doing
exactly what it said.

`anchorTransition` takes the overlap out of the OUTGOING clip's tail instead:
the previous clip plays a few frames longer and the incoming one stays where the
music put it. The renderer sees no difference — the incoming clip's first N
frames overlap the outgoing one either way — so the transition simply begins on
the beat rather than finishing near it. `addTransition` keeps its rippling for
the timeline UI, where it belongs.

### And a frame of slop underneath that

With the ripple gone, one frame of drift remained from the fourth shot on.
Shot lengths were measured from the millisecond gap between cuts while their
positions came from frames, and the two round independently — so a shot could
come out a frame too long, overlap the next, and send `findFreeSlot` off to
nudge that one a frame later. Measuring between the cuts' own FRAMES makes the
shots tile exactly, with nothing to resolve.

Both rules had it. Both are fixed, and the reel tiles exactly at 117 BPM, which
is a tempo whose beat divides into nothing.

### Where it lands now

| shot | error |
|---|---|
| on "Break" | −7 ms |
| on "tonight" | +3 ms |
| on "dance" | −15 ms |
| on "gone" | +8 ms |

Every one inside half a frame, which at 30fps is the floor. There is nothing
left to take out.

---

## 24. Speech, as a provider rather than an engine

Sheet ⑦ wants a narration video, and the voice is the part of it with a real
choice behind it: a model on this machine, or somebody's API. That choice is not
ours to make — a photographer on a plane wants the local one, someone who wants
a particular hosted voice wants theirs, and either should be able to change
their mind without the rest of the app noticing.

So speech is a PROVIDER. `shared/voice/provider.ts` is the contract and all the
decisions; it has no network, no filesystem and no ONNX in it, so what happens
is testable without any of them installed.

### Two behind one door

| | where | cost | key |
|---|---|---|---|
| **kokoro** | sidecar, ONNX Runtime | none per use | none |
| **hosted** | any OpenAI-shaped `/v1/audio/speech` | theirs | theirs |

Kokoro-82M was picked for the local slot on two grounds: it synthesises faster
than real time on a laptop CPU, and it has an ONNX build — so it runs on the
runtime the depth model already brought. Every other TTS worth using wants
torch. This costs a model file rather than a stack.

The hosted shape is worth singling out because **it is not only OpenAI's**.
Kokoro-FastAPI serves the same model over the same endpoint, so "ours or theirs"
is not even a fork in the road: the same voice can arrive either way and the
setting is really about where the compute happens. Point `baseUrl` at
`http://localhost:8880/v1` and the hosted provider is a local one.

Both return a wav on disk, so everything upstream imports an ordinary asset and
never learns which answered.

### The rules that matter

**`auto` prefers local.** Not because it is better — it is a small model and a
hosted voice may well beat it — but because a default that quietly starts
spending someone's credits is a bad default however good it sounds.

**An explicit choice is never substituted.** Someone who picked a specific
hosted voice and silently got the local model has been handed a different
performance without being told, which is worse than an error because it renders.
`auto` is the only setting allowed to fall back.

**When neither works, both reasons are reported.** "Kokoro is not installed" on
its own sends someone off to install a model when they had meant to use their
own API and simply had not pasted the key in yet.

**The key never leaves the main process, and never reaches a message.** A 4xx
body is worth showing — it is where "that model does not exist" and "you are out
of quota" live — so the body is shown with the key taken out of it, rather than
swallowed whole to be safe. `redactKey` is pure and tested for it.

**Speech is cached on what changes the audio**, which includes the provider that
actually ran but not the provider that was *chosen* — so switching from `auto`
to `kokoro` does not invalidate a cache that was already Kokoro's.

**Long text is split on sentences.** Every engine degrades on long input, and
hosted ones tend to return an error rather than a shorter take. Sentence
boundaries are where a voice would draw breath anyway, so the joins land where
the ear expects a pause.

### A note on what nearly shipped

Two source files ended up with a literal NUL byte in them — the separator
`speechKey` joins on, written by a script as a raw byte rather than an escape.
It compiled, it passed, and it was invisible in review. Both are escapes now,
and a sweep confirms nothing else in `src/` or `tests/` carries one.

---

## 25. The two ffmpegs

The first CI run on Windows found three problems in a row, and only the third
was interesting. The first two were packaging: a stray file named
`sidecar/:memory:.ses`, whose colon is illegal on Windows and made `git
checkout` fail outright with exit 128 — the code never ran at all — and a bare
`assets` line in `.gitignore`, which matches at every level and had silently
swallowed three real source files.

The third is a standing constraint and belongs here.

### `@ffmpeg-installer` ships a different ffmpeg per platform

| platform | package | `ffmpeg` field | what it actually is |
|---|---|---|---|
| macOS arm64 | 4.1.5 | `92718-g092cb17983` | reports itself as **4.4** |
| win32-x64 | 4.1.0 | `20181217-f22fcd4` | **master, 17 Dec 2018** |

That is not a guess about Windows: every render there died with

    [Parsed_anullsrc] Option 'd' not found

and `anullsrc` gained its duration option in ffmpeg **4.2**. So the floor is
below that.

**But "4.1" is the wrong way to think about it, and thinking that way costs
time.** The Windows binary is not the 4.1 *release* — the package's own `ffmpeg`
field says `20181217-f22fcd4`, a static nightly of ffmpeg **master** taken a
week after the 4.1 branch point. So the floor is a DATE: whatever had been
merged to master by **2018-12-17**.

`tpad` is the proof that the distinction matters. It first appears in the 4.2
release, so "added in 4.2" says it cannot be used here — and `holdFilter` has
emitted it since the beginning. It was merged on **30 October 2018**, before the
snapshot, so it is in the Windows build, and Windows CI renders with it happily.
An audit that judged by release number alone would have sent us rewriting code
that works.

The three that genuinely bite all landed in master *after* that December date,
which is why they are absent even though they are "only" 4.2 features. The rule
to apply: **an option is safe if it was MERGED before 2018-12-17**, whatever
release first carried it — and the release number is only a first approximation
of that.

The immediate fix was small — the option was never needed, because the output
already carries `-t`, which is what actually bounds the stream. Measured both
ways on the same graph: 4.00s with it and 4.00s without.

`adelay`'s `all` option went the same way, and that one had a trap in it.
Dropping `all=1` and leaving `adelay=500` would have been *worse than the error
it replaced*: a bare delay applies to the FIRST CHANNEL ONLY, so every clip with
a timeline offset would have played its left channel late and its right on time
— a desync that renders happily and sounds wrong. Measured on a stereo tone:

| form | left | right |
|---|---|---|
| `adelay=500:all=1` | delayed | delayed |
| `adelay=500\|500` | delayed | delayed |
| `adelay=500` | delayed | **still playing at −24dB** |

So the delay is repeated once per channel, eight times — enough for 5.1, and
harmless on stereo where the extras are ignored.

**The standing rule it leaves behind: anything reached for in a filter graph has
to exist in the OLDEST bundled build, not the newest.** Developing on 4.4 and
shipping 4.1 means a filter added in between works perfectly for months and then
fails for every Windows user, with an error nobody on the team can reproduce.

### Two escaping bugs that could only happen there

A path inside a filtergraph crosses TWO parsers, and they want different amounts
of escaping. Measured by creating a real file at a path containing each
character and seeing which form actually opened it:

| character | backslashes |
|---|---|
| `,` `[` `]` `;` | 1 — graph-level separators |
| `:` `=` | 2 — the graph parser eats one on the way past |
| `'` | 3 — a quote at both levels |
| space | 0 |

One backslash on a colon — the form every example shows, and the form this
codebase used — silently drops everything before it. On macOS nothing precedes
the first colon. On Windows it is the drive letter, so `C:/Users/…/captions.ass`
reached ffmpeg as `/Users/…/captions.ass` and every export touching a subtitle
file, a LUT or a look failed.

The concat demuxer has its own, different rule: backslash is an escape character
there, inside quotes as much as out, so `file 'C:\Users\…'` names a file with a
tab in it. Forward slashes throughout, and `'\''` for a literal quote.

An existing test asserted the broken escaping and had passed for months. That is
the third test in this project found encoding the bug it was meant to guard.

### `amix`'s `normalize`, and why the standard workaround is wrong

The third one, and the first that could not be fixed by deleting the option.

`amix` divides by its input count unless told otherwise: two clips and each is
halved, three and each is a third. `normalize=0` switches that off, and arrived
in **4.2**. It only appeared once a project had two audio streams, which is why
one test failed — *concatenates two trimmed clips* — while every single-clip
render passed.

Every forum gives the same pre-4.2 workaround: `dropout_transition=0` plus a
compensating `volume`. **It is wrong.** Measured, mixing a 3s tone with a 1s one
and reading the mean level in each second:

| form | 0–1s | 1–2s | 2–3s |
|---|---|---|---|
| `normalize=0` | −21.1 | −24.1 | −24.1 dB |
| `dropout_transition=0`, `volume=2` | −21.1 | **−18.1** | **−18.1** dB |
| neither | −27.1 | −28.8 | −25.8 dB |

The long tone alone measures −24.1 dB, so the middle row is **6 dB hotter than
its own source**. The moment the short input ends, amix renormalises to one
active stream — and the compensating `volume` then doubles something already
correct. The bottom row is worse still, and *ramps*, because the 2s dropout
transition is audible as a swell.

The fix is to remove the premise: pad every input to the full timeline first, so
nothing ever drops out, the divisor stays at N for the whole render, and
multiplying by N undoes it exactly.

    [dia]apad,atrim=end=3.000000[aoutp0];
    [oth]apad,atrim=end=3.000000[aoutp1];
    [aoutp0][aoutp1]amix=inputs=2:duration=longest:dropout_transition=0,volume=2[aout]

Summed against the `normalize=0` output with one inverted, the residual is
**−91.0 dB** — the 16-bit quantisation floor. The same samples. `apad`, `atrim`
and `volume` all predate 4.0 by years, so there is no version branch to keep in
step.

And, for the fourth time in this project, an existing test asserted the broken
form — `toContain('amix=inputs=2:duration=longest:normalize=0[aout]')`. It did
not merely miss the bug; it required it. It now asserts that both streams reach
the output and neither is halved, which is the behaviour, not the spelling.

### What makes this class catchable now

macOS allows a colon in a filename. So
`tests/integration/filterPath.int.test.ts` reproduces the drive-letter case
locally: it writes a real LUT at a path containing each awkward character and
checks ffmpeg opens it. Reverting the fix fails 5 of its 7 cases on a Mac.

Windows does *not* allow a colon, which is the joke at the centre of that file:
the two cases that build a directory named `x:y` cannot run on the one platform
that cannot avoid colons. They are skipped there and lose nothing, because every
path on a Windows runner is already `C:\…`. A `runIf` test asserts that drive
letter is present rather than assuming it.

The version floor used to have no local check — there is only one ffmpeg on this
machine. `tests/oldestFfmpeg.test.ts` is the substitute: it builds the graphs for
four project shapes and fails if any of them contains an option newer than 4.1,
naming the version and the pre-4.2 alternative. It is a blocklist, so it cannot
catch something nobody has thought of, but all three bugs above are in it and it
runs in 200ms on a Mac rather than four minutes on a Windows runner. It is
verified by mutation: putting `normalize=0` back fails three of its cases.

If ffmpeg is ever unified across platforms, delete that file rather than
maintaining it — the whole class goes with it.

### The same filter, a different answer: `chromakey`

The blocklist catches a filter or option that is MISSING on the old build. It
cannot catch one that is present on both and computes something different —
and `chromakey` does. The 2018 snapshot measures a key's distance as
`sqrt(du² + dv²) / 255`; the newer build divides by a further √2. At the same
Similarity the Windows export kept pixels the Mac export keyed out. Nothing
failed to run; five of CI's render checks failed on the numbers, and the √2
predicts every one of them exactly (#00b140 over pure green: the newer
formula 53, √2 gives 234, Windows gave 234).

A version check would have to know when the formula changed; a measurement
does not. The app keys one patch on the binary it has and reads the alpha
back (`keyScaleFromProbe`, `main/render/keyScale.ts`), then scales Similarity
and Soften — both distances — so either build keys what the model, and the
preview's shader, say. The render tests take the same probe
(`integration/output.ts keyScale()`).

The lesson is the one CI keeps teaching: a filter that EXISTS on both builds
has not been shown to AGREE on both. Anything the preview has to match
(`chromakey`, `eq`, `colorchannelmixer`, `despill`) needs its render check to
run on the Windows runner, not only on this Mac — and the runner's results
need reading. These went red for a day before anyone looked.

### 26. What a full platform audit found afterwards

Five independent lenses over the codebase, each finding adversarially refuted by
a second reader. **Four of eight claims survived.** The four that died are worth
as much as the four that lived, because each was plausible:

- **`tpad` is 4.2, so it breaks Windows** — refuted by the build-date fact
  above. The most expensive wrong answer available.
- **`minterpolate`'s `scd_threshold` defaults to 5.0 on the Windows build and
  10.0 on 4.4, so slow motion judders there** — the version facts were correct
  and the failure still did not reproduce. Rendering the real chain at both
  thresholds gave *byte-identical* output for a whip pan, mandelbrot pans at
  three speeds, testsrc2, per-frame noise, and a static-then-whip-pan at seven
  speeds. The 5–10 band means an average luma change of 13–26 levels, which
  ordinary motion never reaches.
- **The sidecar's `python3` fallback breaks on Windows** — `service.ts` already
  branches on win32, and nothing shipping reaches the fallback.
- **The `.venv/bin/python` test gate skips the sidecar suites on Windows** —
  true, but nothing creates that venv on *any* platform, so both runners skip
  identically.

What survived was smaller and duller than any of them, which is usually how it
goes:

| where | what |
|---|---|
| `maskTags.ts`, `stems.ts` | missing `windowsHide` — every other spawn in `src/main` has it. 412 console windows on a cold transition library |
| `maskTags.ts` | seven `.svg` masks have no decoder; the failure was never cached, so they re-spawned ffmpeg **every launch, on both platforms** |
| `Library.tsx`, `media.ts` | the renderer has no `node:path` and joined with a literal `/`, so a renderer-built path never string-equalled a `path.join` one on Windows and the audition dedup silently did nothing |

The last one is the interesting shape: both spellings *open the same file*, so
nothing broke — only the comparisons between them. `src/shared/assetPath.ts` now
does that join, and its test asserts agreement with `path.win32.join` rather
than asserting a literal, so the two sides of the IPC cannot drift apart.

One lens — every regex that parses ffmpeg's stderr, where CRLF was the obvious
suspect — read 46 files and found **nothing**. Worth recording, so nobody pays
for that search twice.

---

## 26. Audio fades — `afade`, and which curve is old enough

Fades were the last obvious hole in the audio path: no `afade` anywhere, and
the only way to soften an entry was to place four points on the drawn volume
envelope by hand.

**`afade` itself is not the risk.** The filter is from 2013, comfortably older
than the 2018-12-17 Windows snapshot (§25), and `t` / `st` / `d` are all
original options. What needed checking was the **curve**.

`-h filter=afade` lists nineteen of them in one flat list, and nothing about
`losi` announces that it is years newer than `tri`. But the list is an
**append-only enum**, so the index is the age ordering:

```
nofade -1   tri 0   qsin 1   esin 2   hsin 3   log 4   ipar 5   qua 6
cub 7   squ 8   cbr 9   par 10   exp 11   iqsin 12   ihsin 13
dese 14   desi 15   losi 16   sinc 17   isinc 18
```

`tri` and `qsin` are 0 and 1 — the filter's first commit. Everything with a
high index is a later addition, and the four at the top of the list
(`losi`, `nofade`, `sinc`, `isinc`) are now in `tests/oldestFfmpeg.test.ts`'s
blocklist. That is an argument from the binary's own output rather than from a
release note, which is the distinction §25 was written about.

**Which curve, measured.** A 4s 440Hz tone faded out over its last two
seconds, sampled in quarter-second windows against a flat control at −21.1 dB:

| curve | 10% in | 50% in | 85% in |
|---|---|---|---|
| `tri` | −1.9 dB | −7.8 dB | −17.6 dB |
| `qsin` | −0.4 dB | −4.6 dB | −13.7 dB |

Linear amplitude drops away early and then crawls, which is why a `tri`
fade-out on music sounds like someone pulling the plug halfway through. `qsin`
holds the level and then goes. It is the default here.

The full `qsin` fade-out shape, on a 6s tone fading over its last two, is
worth having written down so nobody has to re-measure to pick a test
threshold:

```
control −21.1   4.5s −22.5   5.0s −25.7   5.4s −30.2   5.7s −38.5   5.85s −44.5
```

**Where it goes in the chain, and why that is the whole correctness.**

```
aformat → aresample → atempo → volume → afade → adelay
```

*After* `volume` so a fade **multiplies** whatever the envelope drew rather
than replacing it — they are separate controls and both apply, as in any DAW.
*Before* `adelay` because `afade` is handed an absolute time, and until the
delay runs the clip's stream still begins at zero however far along the
timeline the clip sits. A fade written after the delay would need every time
offset by the clip's position, and getting that wrong pushes a fade-out's
start past the end of the stream, where **it silently does nothing**. That is
the same units trap the volume envelope hit, from the same cause.

**`afade=t=out` is told where the fade BEGINS**, not where it ends. A two
second fade on a six second clip is `st=4:d=2`. The mirror-image bug renders a
clip already silent for its last four seconds, which reads as the fade length
being ignored rather than as an off-by-a-start-time.

**Overlapping fades are made to meet, not rejected.** Trim a clip down under
fades that were already set and the two walk through each other; `afade=out`
would then start before `afade=in` finished and the clip would go quiet in the
middle and stay there. `clipFades` reduces both in proportion until they sum
to the clip exactly.

Six mutations checked, including both halves of the chain order. The
integration test measures decibels out of a rendered file rather than
asserting the filter string — §1 is the reason — and it runs on Windows CI,
which is what finally settles `qsin` on the 2018 build.

---

## 27. Crossfades — overlap IS the crossfade, and `acrossfade` is not needed

Two findings, and the second one deleted most of the work the first implied.

**Overlapping clips were 3 dB hot.** `anchorTransition` genuinely overlaps its
two clips — that overlap *is* the video dissolve — so for the length of every
dissolve both soundtracks played at once, at full. Rendered through the real
plan with 440Hz against 1170Hz and measured inside one file:

```
before overlap  -24.1     in overlap  -21.1     after  -24.1      jump +3.0 dB
```

Exactly what two uncorrelated signals summing gives, because that is what it
was. Nothing wrote a fade because nothing knew to.

*(The −24.1 against a raw file's −21.1 is not a second bug. It is the mono →
stereo upmix in `aformat=channel_layouts=stereo`, which is power-preserving
and therefore −3 dB per channel. The `mixFilters` pad-and-scale formula was
checked in isolation and is unity: A alone, A mixed with silence, and
`normalize=0` all measure −21.1.)*

**`acrossfade` is unnecessary.** An equal-power crossfade is just an overlap
with `afade=out` on one side and `afade=in` on the other — and `qsin` against
`qsin` sums flat. Measured over a two-second overlap:

| | 2.0s | 4.2s | 5.0s | 5.8s | 7.0s |
|---|---|---|---|---|---|
| source, no fade | −21.1 | −21.1 | −21.1 | −21.1 | — |
| overlap + `qsin`/`qsin` | −21.1 | −21.1 | −21.1 | −21.1 | −21.1 |
| **`acrossfade=c1=qsin:c2=qsin`** | −21.1 | −21.1 | −21.1 | −21.1 | −21.1 |
| overlap + `tri`/`tri` | −21.1 | −22.7 | **−23.9** | −21.5 | −21.1 |

The overlap-plus-fades row and ffmpeg's own `acrossfade` row are the same
numbers. So `acrossfade` buys nothing — and it would cost a great deal: it is
a **two-input filter that consumes both streams and emits one**, which would
force the audio graph from "delay each clip and mix them all" into "build a
concatenation chain per track". Every clip in this project is an independent
padded input into one `amix` (§25), and that structure is load-bearing for the
2018 Windows build.

The `tri` row is why the curve matters here rather than being taste: a linear
crossfade has a **2.8 dB hole** in the middle of every join.

**So the rule is: overlap on a track means crossfade**, derived at render in
`fadesWithNeighbours` rather than stored. It is true of every overlap however
it arose — a dropped transition, the crossfade action, a reel the automation
built — without any of them having to remember. An explicit fade always wins,
tested with `fadeIn: 0` specifically, since "no fade here despite the overlap"
is a real answer and the falsy one.

Neighbours are read **per track**. Two tracks overlapping is the whole point
of having two; treating that as an edit point would duck the music every time
a sound effect landed on it.

---

## 28. Loudness — `loudnorm`, and the two things it does behind your back

Without normalisation, how loud an export comes out is whatever the source
happened to be. Every platform measures the same way now — integrated LUFS,
ITU BS.1770 — so the fix is to hit a number instead of eyeballing a meter.

`loudnorm` merged in **3.1 (June 2016)**, comfortably inside the 2018-12-17
floor (§25). It is on the Windows build and the integration test runs there.

**Single pass is enough here.** Measured on this build, three sources spanning
twenty-six decibels, normalised in one pass and re-measured:

| source | before | after |
|---|---|---|
| quiet sine | −41.75 LUFS | **−14.04** |
| loud sine | −15.75 LUFS | **−14.04** |
| pink noise | −20.72 LUFS | **−14.01** |

Within 0.04 LU of target. The two-pass form — measure, then apply one static
gain with `linear=true` — is more transparent on dynamic material, but it
needs an analysis run over the whole timeline before the render can start, and
0.04 LU is far inside both what anyone can hear and what the platforms
re-normalise away. Two-pass is the refinement to reach for if drawn-envelope
material ever sounds squashed, not before.

Pink noise also came back at a true peak of **exactly −1.00 dBFS**, the `TP`
target, so the ceiling is honoured rather than approximated.

### The two traps

**It emits 192 kHz.** Every time, whatever went in. Nothing about the sound
reveals it — the file is simply four times the samples, disagreeing with
`settings.sampleRate` everywhere else in the app that reads it, and four times
the work for the AAC encoder. The rate has to be pinned back explicitly.

**A bare `aresample` after it fails.** Not a warning — the render dies:

```
[Parsed_aresample_1] Cannot select channel layout for the link between
                     filters Parsed_aresample_1 and format_out_0_0
Error reinitializing filters!
```

Nothing downstream can work out what came out of `loudnorm`, so the layout has
to be stated in the same breath. The fix is one filter:

```
loudnorm=I=-14:TP=-1:LRA=11,
aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo
```

*(A related failure cost ten minutes and is worth recording so nobody repeats
it: `loudnorm` on a MONO input, with or without a resample, fails with
"Failed to inject frame into filter network: Invalid argument". It looked at
first like short clips failing — a 0.8s file died — but a 0.8s STEREO file is
fine and an 8s mono one is not. Length was never the variable. Every clip is
forced to stereo before the mix here, so it cannot arise in this graph, and
the explicit `channel_layouts=stereo` makes sure of it.)*

### Where it goes, and where it must not

Last, on the finished mix. Normalising a clip before the music joins it would
target a number that stops being true the moment anything else is added.

**Never on the silence branch.** A project with no audio takes the `anullsrc`
path, and `loudnorm` measures silence at **−inf LUFS** — asking it for a
finite target is a request to amplify nothing by an unbounded amount.

### On by default, for new projects only

`DEFAULT_SETTINGS` carries −14 and a missing `loudness` means off. That
asymmetry is deliberate: two exports landing at different levels is the thing
being fixed, so the default has to be on — but switching it on for a project
someone has already finished would change how it sounds with nothing on screen
to say why.

The change broke six existing tests in `render.test.ts`, all of which assert
the MIXER's output label. They now build their fixture with normalisation off,
because each is about whether two streams reach the mixer or a muted clip is
dropped before it — not about what is appended afterwards.

## 29. The export's shape — codecs, bitrates, and a stretch nobody saw

B2 (docs/FIX.md). Everything here was measured on the bundled macOS binary;
the Windows one cannot be measured from a Mac, so the app probes itself there.

### Listed is not working

`h264_videotoolbox` is in `ffmpeg -encoders` on the bundled macOS build and
then fails to open a compression session (`-12908`), even with `-allow_sw 1` —
at least inside the development sandbox, which may be the cause and may not.
So nothing is offered on the strength of the list: `main/render/encoders.ts`
encodes ten real frames with each listed candidate, using `encoderArgs` itself
— the arguments the export will run — and offers only what succeeded. Cached
for the process.

`libx264`, `libx265` and `prores_ks` all encode with the arguments in
`render/encode.ts`, bitrate mode included. ProRes lands as `apch`
`yuv422p10le` in QuickTime. The container is named with `-f`, never left to the
extension: an MP4 cannot hold ProRes, and a name typed as `.mp4` before
switching codec must not be what decides.

### AAC at 320k writes less than at 256k

ffmpeg's native AAC encoder, on stereo white noise (the hardest thing to
compress, so a target is actually spent):

| asked | written |
|---|---|
| 192k | 195 kb/s |
| 256k | 260 kb/s |
| 320k | **248 kb/s** |

Pink noise at 320k: 244. So 320 is not offered — a setting labelled higher that
comes out lower is worse than no setting — and a stored 320 maps to 256
(`audioKbpsFor`). A sine at any setting writes ~74 kb/s, which is why a pure
tone cannot test this.

### A bitrate test needs a picture that costs something

A clean `testsrc2` at 320×240 needs about 0.6 Mbps even at CRF 14, so a 2 Mbps
cap never binds and a "bitrate is respected" test passes for the wrong reason.
Moving noise at 720p (`testsrc2` + `noise=alls=40:allf=t`) spends whatever it
is given.

### The camera move stretched tall photos

`kenBurnsFilter` runs its move at a working size capped for speed — and the cap
was `min(2560, w)` × `min(1440, h)`, each side on its own. That assumes a
landscape picture. A 3024×4032 phone photo in a 1080×1920 reel wants a working
height of ~1738 (canvas fit × zoom headroom); the height was cut to 1440 and the
width was not, so the photo went into `zoompan` at 1304×1440 — 0.906 instead of
0.75, **21 % too wide** — and came out stretched. Every Ken Burns on a tall
photo in a vertical reel, which is the wedding reel. The preview never went
through this path, so it looked right on screen.

Measured with a white square on black (`integration/motionAspect.int.test.ts`):
20.6 % out of square at 9:16, 137 % at 4K, and the landscape control fine. The
cap was never what bounded the cost anyway — `factor` already limits the working
picture to the canvas plus the headroom the deepest zoom needs — so it is gone,
and one factor scales both sides.

### White balance is `colorchannelmixer`, and it keeps alpha

B3. `colortemperature` merged in 2021 and is on the floor blocklist, so white
balance is per-channel gains on `colorchannelmixer` (2013). Measured on the
bundled binary, a `0x808080` grey at 50 % alpha in `yuva420p` through
`rr=1.208:gg=0.966:bb=0.725`: out comes `98 7a 5b 7f` — 152, 122, 91, alpha
kept. The grey decodes as 126 on the way in, and 126 × the gains is 152.2,
121.7, 91.4: the gains are applied exactly. `-filters` lists it `TSC`, so it
takes `enable` — an adjustment layer needs that — and `eq` is `T.C`.

### A mask used to throw away the clip's own alpha

Found while planning B3's chroma key, which has the same shape of problem.
Every alpha shape — sticker matte, clip matte, reveal mask, luma wipe — was
multiplied into one stencil and put on with `alphamerge`, which REPLACES alpha.
The clip's own transparency was never one of the shapes. Measured: a 4:3 blue
clip fitted into 16:9 over a red track, reveal mask covering the frame — the
fit's see-through side bars came out 0,0,0 where they should have shown the
red; without the mask they did. A half-transparent PNG went opaque the same
way. The clip's own alpha (`split`, `alphaextract`) is now the first shape and
everything multiplies into it (`integration/maskOwnAlpha.int.test.ts`).

### Chroma key — ffmpeg's arithmetic, written down so the preview can copy it

B3. `chromakey` (2015) and `despill` (2017), both older than the Windows
build. `render/chromaKey.ts` holds the model; the preview's shader and the
export's filters both take their numbers from it. Measured on the bundled
binary with patches of known colour (`integration/chromaKey.int.test.ts`):

- **A pixel's chroma is the stream's own U and V** — for a picture that
  arrived as RGB, swscale's BT.601 limited range: pure green is (54, 34).
- **The KEY colour is converted differently**: the full-range JPEG formula in
  10-bit fixed point (`RGB_TO_U`/`RGB_TO_V`, colorspace.h), so pure green keys
  at (44, 21). Copy the pixel formula for the key and every key is off.
  A consequence: a key picked off the screen itself sits about 0.03 of
  `similarity` from that screen, not 0. The default 0.12 covers it.
- **Distance** is `sqrt((du² + dv²) / (255² · 2))`, averaged over the 3×3
  neighbourhood; **alpha** is `clip((d − similarity) / blend, 0, 1) · 255`,
  TRUNCATED — or a hard cut at `similarity` when blend is 0. The model
  predicts every one of 18 patches × 5 keys within 4 levels.
- **`chromakey` REPLACES alpha**, like `alphamerge`. So the export keys a
  copy, keeps only its alpha, and multiplies it into the clip's own —
  straight after the fit, before the grade (a key measured on graded greens
  moves). It was first built as one of the late stencil shapes; a keyed clip
  that was then turned failed the whole export, because `finish` (the turn)
  runs before those shapes when there is no mask, and the box-sized key met a
  grown picture.
- **Despill**: `spill = max(g − (r·mix + b·(1−mix)), 0)`, and `green=−amount`
  takes that much out (200 → 90 at full, 145 at half); alpha kept.

**Preview parity, measured in the harness** (patch PNG over a black track,
alpha read back as displayed ÷ source): across 6 keys × 18 patches, soft
edges included, the WebGL shader is within 6/255 of the model; despill on
kept patches is exact. The shader's chroma coefficients are interpolated from
`PIXEL_U`/`PIXEL_V` rather than typed out a second time. Footage encoded
BT.709 keys on its own chroma in ffmpeg while the browser hands the shader
RGB, so on such a file the soft edge can sit a few percent differently — the
export is the one to trust.

The pick reads the preview canvas while it draws the clip RAW (no key, no
grade, no mask, nothing over it, full opacity) and averages a 7×7 square.

### `eq` drops the alpha plane — every graded clip lost its transparency

Found while testing the key. `eq` takes no pixel format with alpha, so ffmpeg
auto-inserts a conversion in front of it. Measured, a fully transparent pixel
through `format=yuva420p,eq=brightness=0.1,format=yuva420p`: alpha 0 in, 255
out. The same pixel through `colorchannelmixer`, `curves`, `lut3d`, `hue`,
`lutyuv` and `despill`: alpha 0 — only `eq` drops it. So brightness, contrast
or saturation on any clip with see-through parts made them solid: the bars a
fit leaves round a 4:3 picture came out black over the track below, a PNG
sticker became its rectangle. The preview never did this, so it looked right
on screen. `eq` is now wrapped — `split`, `alphaextract` before, `alphamerge`
after — so its colour is byte-for-byte what it was and only the alpha
changes. Cost, measured at 1080×1920: 0.59 s → 0.77 s for six seconds through
`eq` + encode alone, about 0.03 s per second of graded footage, paid only by
clips whose sliders are set (`integration/gradeAlpha.int.test.ts`).

### A keyframed opacity wrote over the alpha

`geq … a='<expression>'` REPLACED the clip's alpha with the opacity, so a
keyframed fade on a letterboxed clip had black bars for its whole length
(measured: 5,0,0 where the red track should show). Now
`a='alpha(X,Y)*(<expression>)/255'`. geq's `alpha()` is from 2013.

### A Grade layer with a look could not export

An adjustment layer's grade runs on the composited tracks below it. But the
clip chain also built its look on the layer's own never-drawn picture and left
it unconnected — `Filter lut3d has an unconnected output`, whole graph
refused, at any intensity. The graph test only ever read the string. Neither
the look nor the new `eq` wrap is built on an adjustment layer's own picture
now, and `integration/adjustment.int.test.ts` renders one.

### A moving mask — curves of `T` in `geq`, worked out once per row

B3. A mask's centre and size are keyframe tracks; the export writes each as a
`keyframeExpression` of `T` into the mask's `geq`. Measured on the bundled
binary:

- **`T` is the clip's own seconds** where the mask is drawn — on the clip's
  chain, before `setpts` moves it to its place — 0, 0.1, 0.2… at 10 fps, as
  the opacity keyframes already rely on.
- **`st(n, e)` / `ld(n)` work inside a quoted `filter_complex` argument, and so
  does `;`**: `st(0,32);if(lt(X,ld(0)),200,0)` is 200 to x=31, 0 from x=32.
  (A first probe looked wrong: `od` collapses repeated lines into `*`. Read
  with `od -v`.)
- **geq has no per-frame stage**, so a curve written in at every use is
  evaluated a dozen times per pixel. geq walks each row from x=0 and the
  variables persist between pixels, so the curves are stored at `X` = 0 and
  read back. 3 s at 1080×1920, four tracks of six keys:

  | | time |
  |---|---|
  | still mask | 11.4 s |
  | curves at every pixel | 26.8 s |
  | curves once per row | 13.4 s |

  The per-row picture is byte-identical to the per-pixel one over 180 frames.
- The still number is itself the finding: **a `geq` mask runs about 3.7×
  slower than real time at 1080×1920.** Not changed yet (FIX.md B3).

Rendered (`integration/maskKeyframes.int.test.ts`): a window keyed from a
quarter to three quarters across lands within a pixel of prediction on every
frame. A pixel-reading trap on the way: `-ss` returns the first frame AT OR
AFTER the time, so the middle of a clip's last frame is past it and reads as
the track below — sample a quarter-frame before the frame instead.

### RGB filters lose two levels on the packed route — run them planar

Every RGB-only filter the export uses — `colorchannelmixer` (white balance, and
the static opacity control), `curves`, `lut3d`, `despill` — is handed a
yuva420p stream, and ffmpeg converts for it. It picks PACKED `rgba`, and the
yuva420p ↔ rgba route loses levels. A mid grey from lavfi, read back as rgb24,
on the macOS build:

| route | grey |
|---|---|
| no filter | 126 |
| mixer 1,1,1, curves identity, lut3d identity, despill, opacity 0.5 — auto (rgba) | 124 |
| the same, each after an explicit `format=gbrap` and before `format=yuva420p` | 126 |

The warm balance on the auto route came out 150,120,89 against gains of
152.2,121.8,91.3; on gbrap 153,122,91. On the Windows build the auto route was
3–4 levels low in every channel of every balance (CI #79); a one-off probe on
the runner (CI #80) had a unity mixer turn 128 into 125 on the auto route, and
the warm balance land at 154,122,92 on gbrap against 154.6,123.7,92.7 — and,
unlike the Mac, an EXPLICIT `format=rgba` was exact there too, so it is the
format ffmpeg negotiates for itself that loses the levels. The keyframed
opacity's `geq` already runs planar and was exact. The preview loses nothing,
so the file was quietly darker than the screen, and white balance's own
5-level tolerance was too loose to notice two. `inRgb` in plan.ts wraps each
run of RGB filters in `format=gbrap … format=yuva420p` (`gbrp`/`yuv420p` on the
composite an adjustment layer grades), and `integration/rgbRoute.int.test.ts`
holds invisible settings to 1 level.

### Steady — vidstab on both builds, measured against deshake

B3. A 720×420 noise texture with a white marker, cropped to 640×360 at an
offset driven by a few low and high frequency sines — a hand-held wobble with a
known size — and the marker's centre found in every frame (`integration/steady`):

| | spread across | spread down | time, 4 s at 720p |
|---|---|---|---|
| as shot | 7.6 px | 6.0 px | — |
| `deshake` (defaults) | 4.1 | 4.1 | 1.5 s |
| `deshake` rx/ry 32 | worse: 7.3 / 13.3 on a grid texture | | |
| `vidstab` default | 1.4 | 2.4 | 0.8 s (+ analysis) |
| `vidstab` smoothing 30 | 0.5 | 0.6 | 0.7 s (+ analysis) |

A periodic texture (a grid) fools deshake's block matching — test on noise.
The 2018 Windows build lists `vidstabdetect` and `vidstabtransform` and runs
both (CI #83). The analysis must see the frames the render decodes, so it runs
with the plan's own `-ss/-t` input (`videoInputArgs`), and vidstabtransform goes
first in the chain, before `setpts`. `deshake` drops the alpha plane like `eq`
does (0 in, 255 out) — harmless where it sits, on decoded footage before any
padding exists.
