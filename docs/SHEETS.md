# The notebook — 17 sheets

A transcription of the seventeen hand-drawn planning sheets, kept here so the
plan survives independently of any one conversation.

**This is a transcription, not the images.** The drawings themselves live in the
notebook and in the photographs; what follows is what is written and drawn on
each, close enough to work from. Where a phrase is the author's own it is
quoted. If a sheet needs to be looked at again — a layout judgement, something
ambiguous in a sketch — the photograph has to be re-sent; this file cannot
substitute for that.

Sheets are listed in the order they were photographed. Several carry their own
circled number in the notebook, which is given where it exists; some are
unnumbered. Status is against the working tree and is updated as things land.

---

## 1 — Sheet ⑩ · Reference style

> "when they uses ... so first we take split the preview side by side of the
> video and edit same. On the UI but in the backend we will send that wide for
> analyse so the depth analyse it Librosa and take also the music analyse it beat
> drop at the scene change and do the same for the user input media"

A reference video goes in; the app edits the user's footage the same way. The
preview splits side by side so the two can be compared. The backend analyses the
reference for depth, for music (beat, drop) and for scene changes, then applies
the same treatment.

Tools named in a box: **TransNetV2** (scene detection), **RVM** (Robust Video
Matting).

**Status — half built.** The split preview exists (source / split / out, with a
draggable divider). Beat analysis and depth analysis are real sidecar
capabilities. There is no reference-video ingest and no matching pipeline, and
neither TransNetV2 nor RVM is in the codebase.

---

## 2 — Sheet ⑪ · Paper animated

A frame containing a box labelled "Your Text" with loose vertical strokes around
it. Annotated:

> "Option II ⇒ Paper Animated (Reference: Paper Animated websites)"

**Status — not started.** Nothing in the code. The nearest thing is the text
style library, which has no paper or hand-drawn treatment among its looks. Worth
seeing the reference sites before building: "paper animated" covers several very
different looks.

---

## 3 — Sheet ⑨ · Library and search

A panel with tabs across the top: **Media | Library | Text | Auto**. Under
Library:

- Fonts, SFX, stickers, 3D props, memes, meme stickers, transitions
- A search box
- "Categories: Telugu, Hindi, trending …etc"
- A grid of nine tiles

Arrow to a note:

> "They both same but sticker has already done so it is nothing to user"

**Status — built, bar the font tiles.** Tabs and search were already there.
What this sheet asked for and did not have is now in:

**Meme stickers are a kind**, as `StickerMeta`'s second form. An emoji sticker
is one SVG named by codepoint; a meme sticker is a keyed video cut-out — colour
and matte, recombined with `alphamerge` — because H.264 4:2:0 cannot carry an
alpha channel. 636 of them ship, with sound. See `docs/STICKERS.md`.

**Categories exist**, and they are also the unit of download: ten packs, one per
category, so somebody editing Telugu content never fetches SpongeBob. The chip
row above the grid is built from what is INSTALLED rather than from the
manifest, appears only once there is more than one category to choose between,
and clears itself when you leave the Stickers tab.

The sheet's note — *"They both same but sticker has already done so it is
nothing to user"* — turned out to be the whole design. The keying, cropping,
loop decision and thumbnail all happen once when the pack is built; the user
drags a cut-out onto the timeline and has never been asked a question about any
of it.

**Still missing: the font tiles are inert.** Every other kind is draggable and
fonts have no handler.

---

## 4 — Sheet ⑦ · Narration video

A source bar across the top: **url | mp4 | mp3 | mp3/instrumental | Narration
video**. The narration panel:

- "Ask for the topic?" — a text field
- Duration: 1 min / 2 min / 3 min
- "Image? 1, 2, 3, 4"
- Music: a pool (track 1, track 2, track 3) plus upload

Then:

> "Backend LLM will create the narration and give the key word, searches to the
> related topic to the Pixel stock footage. and also LLM will tell which photo is
> first, 2nd, 3rd and edit direction."

**Status — not started.** The tab exists and is labelled "soon". Its own
description in the code reads: "Topic and length in, narration and a cut out. The
only part of the app that needs paid services." No LLM, no text-to-speech, no
stock-footage API.

---

## 5 — Sheet ⑥ · YouTube ingest

"Youtube Url / Upload mp4 bar" branching into **mp4** and **mp3**.

- mp3 → "Download mp3 and use Demucs to remove vocals" with options: vocals only
  / instrumental / beats only
- mp4 → "Download mp4 if youtube link is pasted, ask for the quality available":
  4K, 1080p, 720p, 480p
- "Download only mp3 of the link 'NO'. From youtube mp4 = Download, MP3 = 'YES'"
- Boxed at the bottom: **"Download using YT-DLP"**

**Status — built.** The line that used to be here —
"neither yt-dlp nor Demucs appears anywhere" — was wrong about Demucs for some
time: `audio.stems` has been wired end to end in the sidecar, with a mid/side
fallback in `src/main/stems.ts`. Planning from that sentence would have rebuilt
it. The download half is now real too: `src/shared/ingest/` (links, formats,
progress, range clipping — pure, tested), `src/main/ingest/` (yt-dlp fetched on
first use and checksum-verified, downloads as queue jobs with the same bar and
cancel as exports), the IPC, and the panel itself. Paste a link and press Get:
two clicks to a clip on the timeline, with the four choices this sheet draws —
video, audio, instrumental, vocal — as one row rather than as four tabs leading
to the same screen. "beats only" is the one option here not offered: beat
detection already exists as its own capability and belongs on a clip, not as a
download format. See `docs/INGEST.md`.

---

## 6 — Sheet ⑤ · Timeline

Four lanes — **V, V, A, A** — each with an eye toggle; the audio lanes drawn with
waveforms, one of them showing a marked region. Two notes:

> "Controlling music. slow fade on slow On starting/ending"
>
> "+ Adding music on top of each other"

**Status — small gaps.** Multitrack, waveforms and per-clip volume are built.
Ducking is real — music drops under speech via `sidechaincompress`. Layering
works, and adding a second sound now stacks onto another track rather than
queueing after the first.

**"Controlling music" is now two separate things, and both are wanted.**
Ducking is the automatic one. The other is a **drawn volume envelope** on the
clip — the Ableton shape: grab the line, drag a point, quiet it *here* because
you say so. That is built: `volume` keyframes, drawn on the clip in the
timeline, compiled to `volume=…:eval=frame` (measured, EFFECTS.md §1). It is
also what makes the app interesting to DJs, who drop a clip into a set and
reach for the line rather than a menu.

**The sheet's waveform lanes are now real on the timeline too.** They were only
ever in the trimmer, so the envelope above was aimed at something invisible.
Full height on a sound file, the lower half on a video clip — see
WHERE-THINGS-ARE.md for the mapping, which is the whole of the difficulty: the
clip shows a *window* of the file, and getting that wrong draws a perfectly
convincing picture of the wrong moment.

**Fades are built too**, as a third control alongside the envelope and
ducking: grips at the clip's top corners, `afade` at render, multiplied with
the envelope rather than replacing it. The curve is `qsin` rather than linear
and the reason is measured — EFFECTS.md §26, which also records why the filter
sits between `volume` and `adelay` and nowhere else.

**Crossfades are built.** They were written up here as blocked — *"overlap on
one track is a ripple-insert problem the timeline cannot express yet"* — and
that was simply wrong, stated without looking. `anchorTransition` has always
overlapped its two clips; the model expressed overlap all along. Worse, that
overlap was going out **3 dB hot**, because two clips sharing frames both
played at full: every video dissolve, since dissolves existed.

So the rule now is that overlap on a track *means* crossfade, derived at
render. `crossfadeAt` makes the overlap by sliding the incoming clip back —
never by lengthening the outgoing one, which would need source past its out
point and would cross-fade into silence on any clip trimmed to the end of its
file. EFFECTS.md §27 has the measurements, including why `acrossfade` is not
used.

**Still missing:** no loudness normalisation, so two exports can land at
different levels.

---

## 7 — Sheet ④ · Section: "Auto"

A numbered list, boxed:

1. Beat Sync Reel + Add music — ticked, "100%"
2. Motion — "100%"
3. Depth Parallax
4. Transitions — "100%"
5. 3D Props
6. Film strip — "(I'm confused because you are working on)"
7. Build from photo — boxed
8. *(blank)*
9. *(blank)*

**Status — built.** All seven named are built, each as a rule that writes
ordinary visible clips. The film strip note can be struck: it is built, and has
been for a while — it lays several photos side by side as full-height panels and
pans the row as one.

Slots 8 and 9 are filled: split screen (sheet 16) and the **grid split** (sheet
18), one photograph diced into pieces that arrive on the beat.
**Silence-removal auto-cut** is the strongest remaining candidate for a tenth.

---

## 8 — Sheet ③ · Transition library

> "transition effects, card slide, 3D moment parallax. Library"

A panel of six tiles, each showing "Aa" with a different motion arc, plus a
seventh labelled **"custom draw"** containing an S-curve.

> "(where we can use the preset here)"

**Status — small gaps.** Larger than the sheet: 8 hand-written transitions plus
**412 derived from the catalog's mask images**, auto-tagged by what they do,
grouped into families with a tag filter. The custom curve editor exists but
drives motion paths and colour, not transition easing — wiring it to transitions
is a small job, not a new system.

---

## 9 — Sheet ② · Caption styles and fonts

"Captions Styles ▽ [On/Off]". Then "Fonts:" and a grid of tiles — "Aa", "The Aa",
"THE Aa". Below:

- "Choose: size, opacity, position R/L/T/B"
- "Smart: Custom 5 ▽ | Custom 10 | Custom 20" with "font +" / "font −" steppers
  and "+ more"
- "(Random every 5, plus customisable)"
- "Remove toggle"

**Status — small gaps.** On/off, 45 styles, 9 animations, font picker, size,
words per line, position, margin and both colours are built, and the spoken word
lights up and grows. Still missing: **opacity**, the **Smart sets** (rotate
between 5 / 10 / 20 styles), **random every N**, and the **font +/− stepper**.

---

## 10 — Unnumbered · "Tools missing"

1. multitrack
2. smooth scrolling
3. drag trimming
4. splitting
5. snapping
6. audio controls
7. text overlays
8. transitions
9. undo/redo

**Status — built, all nine.** Undo is transactional, so a pointer drag or a burst
of typing is one step. This sheet is closed.

---

## 11 — Unnumbered · "hard"

> "hard: transitions for a photo syncing with music/video, photo syncing with the
> music, beat. Object tracking for text."

**Status — half.** The beat half is done: beats are analysed by the sidecar and
the reel rule plans cuts against them, deliberately not on every beat. **Object
tracking is not started** — nothing in the code tracks anything across frames.
The hardest item on all seventeen sheets; its own project.

---

## 12 — Unnumbered · Clip before download

"Video / youtube url" field, a **duration** range bar with two handles, and a
play preview box. To the right:

> "clip download ⇒ Mp4 ⇒ quality / MP3 = Download / Vocal only = Download /
> Instruments = Download"

**Status — built.** Adds something sheet 5
does not: **clipping a range before the download**, which saves pulling an
hour-long video for eight seconds of it. It went into the args layer from the
start rather than being bolted on: `src/shared/ingest/section.ts` offers both
cuts, because they are genuinely different — *exact* re-encodes at the marks
and is slow on 4K; *fast* copies streams and lands early by up to a keyframe,
so it pads outward and the ends are placed precisely on the timeline instead.
The two marks are typed rather than dragged: the video's length is unknown
until it is fetched, so a slider has no scale to be drawn against — the first
attempt rescaled under the pointer and a seven-pixel drag added four minutes.
The preview box beside them is still to draw.

---

## 13 — Unnumbered · Smart caption placement

"Captions → placement":

- **(A) Options:** sliders — ↑ ↓ ← →
- **(B) Option:** Smart placement

> "How smart placement work? so we are doing depth and matting and find the
> object so the caption ... even subject gets for the caption placement. Dead
> space = 'yes' / 'no'"

Then "Smart caption =" with three grids drawn: **set 3**, **set 5**, **set 10 /
set = all**, with "+ = Add" and "− = Remove".

**Status — not started.** Captions have top / middle / bottom and a margin, and
text cards drag freely. The depth bake the sheet points at genuinely exists —
that reasoning is right — but it is **stills-only** today and would need
extending to video first. No subject-aware placement, no dead-space detection.

---

## 14 — Unnumbered · Auto flip

> "By auto flip: when they uses / when the user has a landscape video we use it
> if ... Now we need to Add the Our biggest Assets ever LLM ⇒"

**Status — not started.** The mechanical half is built: changing aspect re-solves
every clip's reframe, there is a crop solver, and the rectangle can be dragged in
the preview. The deciding half is missing — nothing works out *where* the
interesting part of the frame is, so the crop is geometric rather than aware of
the subject. An LLM is one route; subject detection is cheaper and needs no
per-use cost.

---

## 15 — Sheet ① · The main layout

The full wireframe.

- Source bar: **YT URL / upload | Mp4 | mp3 | mp3/Instrumental | Narration video**
- Left column: tabs **Medi | Lib | Txt | Auto**, and a row **text | colour |
  grade**, then "+ media"
- A vertical **Tool Box** strip
- **Preview** in the centre, with **source | split | out** beneath it
- Timeline: **V / V / A / A** with eye and lock toggles, transport controls and a
  timecode
- Right column: **Aspect ratio** 9:16 / 16:9 / 1:1 · **Caption** on/off with a
  Styles dropdown · **transition** · **Export**
- Below that: **LUT — Graph** with a curve drawn in it
- Marginal note with an arrow: "Thick Border"

**Status — built.** The app is this sheet. Every region is where it was drawn,
LUT graph included. Only the two source-bar tabs marked "soon" are outstanding.

---

## 16 — Sheet ⑩ · Split screen and reaction

"Split screen", under **Section: Auto**:

- **(A)** Split screen
- **(B)** Reaction (PiP) videos

> "when select this in the Preview it should split to P/top → different"
>
> "Users can drag top/bottom if they clips and we will blend with FFmpeg"

Two boxes drawn side by side, labelled "different" and "different".

**Status — built.** Stacked and side-by-side splits, any number of panels, each
filling its half rather than letterboxing. Written into the clip's ordinary
transform, so the result stays draggable. **Still open:** the drag-a-clip-into-a-
half drop targets — the split is applied from the Inspector, not by dropping.

---

## 17 — Sheet ⑨ · Picture in picture

> "Add PiP or upload Image. so when added user can add the PiP in that shot and
> also it has all emphasising custom drag and drop like sticker and other
> options: brightness, opacity, sizes, rotation and also how it show appears on
> the templates. Some like wider neat edges so it won't look amateur. And when we
> add Pixels API we can also provide them as well for the PiP images"

Three small shapes drawn — a circle, a square, a rectangle.

**Status — built, minus the API.** Four shapes (same-as-video, square, circle,
tall), five positions, rounded and circular edges via the mask, and every control
listed — drag, brightness, opacity, size, rotation. **Still open:** the stock
image API, which needs a key.

---

## 18 — Sheet ① (the second one) · Custom grid per photo

> "Upon Selected Image: 1, 2, 3, ……N / On each photo We ask the User for Custom
> Grid where user can select his Pixels Sizes something like if user selects 2"

Two diagrams: a box split down the middle (R | L), and the same box split across
the middle (T / B). Then a 4×5 grid drawn out. Below:

> "So, Just like with 3, 4, 5, 6…N and Some options on Grid: square, Circle,
> …… if possible Waves. and also rotating options (as we already have
> Everyth… So, we good,"

**This is one photograph cut into N pieces, not N photographs laid in a grid.**
Worth stating, because the two are easy to confuse and only one of them is on
this sheet. (Laying several pictures out together is sheet 16, the split screen.)

**Status — built.** `shared/render/grid.ts` and `shared/automation/grid.ts`. A
piece count becomes rows and columns by factor pair, chosen so the cells come
out squarest for the canvas — so two pieces stack in a vertical frame and sit
side by side in a horizontal one, exactly as drawn, without either being an
option anyone has to pick. Square, circle and wave cells; a gutter; a scattered
tilt; six reveal orders; three landings. The pieces arrive one per beat, or on
an even cadence when there is no music. See docs/EFFECTS.md §17.

**One correction to the sheet.** "rotating options (as we already have
everything)" is half right. Flat rotation exists and now works properly — it was
cutting the corners off every turned clip in the app, which is fixed. But the
X-tilt / Y-spin / Z-roll in the reference recordings is a PERSPECTIVE warp, a
different operation. `perspective` is in the bundled ffmpeg, does a real quad
warp, and animates on `on` — measured, five frames, five distinct hashes — so it
is reachable in the single-pass graph. It is not built.

---

## Where the gaps cluster

**Getting media in.** Both unfinished source-bar tabs plus the range-clip idea.
The largest single hole, and upstream of everything that already works.

**Models not yet added.** Scene detection, matting, object tracking, and the
deciding half of auto-flip. The sidecar already hosts three models (speech,
beats, depth), so each is an addition rather than a new system — and none needs a
paid service.

**Caption behaviour, as opposed to caption looks.** Smart placement, style
rotation, random-every-N, opacity. The looks are finished; how captions decide
things for themselves is not.

**Small finishing.** Audio fades and loudness.
The inert font tiles. Transcript-to-text-card conversion.
