# The fix list — from the audit to a finished editor

`docs/COMPARISON.md` established what is missing, with a `file:line` for each
claim. This is the plan to close it, in the order a user hits it, and then
the two things that come after: measuring the Director on a real model, and
the pass that dresses its spine. Written to be precise enough to start from
cold on either machine.

**Three facts that shape every item below.**

1. **No fix here needs a new model.** One needs a new *component* — mask
   tracking needs a tracker (OpenCV, a library, not a model) — and it is the
   last item in its phase for that reason.
2. **Two ffmpegs.** Anything that emits a filter must be safe on the Windows
   build, a master snapshot from **2018-12-17** (`CLAUDE.md`). Filters named
   below carry their merge year; ones that need measuring on Windows say so.
   Measured on the macOS build on 2026-09-22: `chromakey`, `colorkey`,
   `despill`, `colorbalance`, `colorchannelmixer`, `deshake`, `vidstab*`,
   `sidechaincompress`, `geq`, `curves`, `lut3d` present; encoders `libx264`,
   `libx265`, `h264_videotoolbox`, `hevc_videotoolbox`, `prores_ks`, `aac`.
   `colortemperature` is present on macOS and **merged in 2021** — it is now
   on the floor blocklist (`tests/oldestFfmpeg.test.ts`).
3. **Every regression test is mutation-checked** — write it, put the bug
   back, watch it fail (`CLAUDE.md`).
4. **Anything that touches the render gets RENDERED, not just planned.** An
   assertion about a filter string proves the string; it does not prove ffmpeg
   accepts it. A3's very first render check found two fatal bugs in the duck
   that had been shipping under a passing string assertion. Render checks live
   in `tests/integration/*.int.test.ts`, use the helpers in
   `tests/integration/output.ts`, and leave what they rendered in
   **`tests/output/<check>/`** with a README — gitignored, rebuilt each run, so
   a failure can be looked at and played rather than only read about.

| phase | what | days | model? | new component? | Windows-floor risk |
|---|---|---|---|---|---|
| **A** | the editing surface — nine items a CapCut user hits in the first hour | ~9–12 | no | Web Audio (browser API) | none |
| **B** | audio surface · export shape · colour, key, masks, motion, transcript | ~9–13 | no | OpenCV for mask tracking only | `libx265`/hardware encoders, `vidstab` — measure on Windows |
| **C** | the Director, measured on a real model | 1 + ongoing | uses one | no | — |
| **D** | the dressing planner (pass 2) | ~3–4 (+ sticker index later) | uses one | bge-m3 embeddings for stickers, later | — |
| **E** | templates with slots; the market around them | design first | no | a server, later | — |

Days are working estimates for one person who knows the codebase, not
promises. A is deliberately before D: the Director's output lands on this
timeline, and a marketer judges the whole thing by whether they can then
nudge three clips together.

---

## Phase A — the editing surface

### A1. Split and trim honour clip speed — *bug* — **DONE**

**Where.** `src/shared/timeline.ts` `splitClip` (:869-884), `trimStart`
(:887-900), `trimEnd` (:901-907); callers `src/renderer/src/store.ts:964-1005`.
The correct maths already exists beside them: `sourceFrameFor` (:763) and
`maxDurationAtSpeed` (`src/shared/render/speed.ts:84`).

**Fix.** Source frames consumed are `timelineFrames × speed`, so:
- `splitClip`: right half `inPoint = clip.inPoint + round(leftDuration × speed)`.
- `trimStart`: `inPoint += round(delta × speed)`; the "not before the source
  starts" clamp becomes `delta ≥ −inPoint / speed`.
- `trimEnd`: ceiling is `start + maxDurationAtSpeed(clip, sourceDuration)`.

**Tests.** `tests/timeline.test.ts` covers speed 1 only. Add: split at 2× and
0.5× → the right half's first source frame equals `sourceFrameFor(clip,
frame)`; trim head at 2× keeps the frame under the cut still; trim tail at
4× stops at the real end of the media. Mutation: remove the speed term.

**What was actually built.** All three, as written, plus one thing the item did
not anticipate.

`splitClip` now takes its in-point straight from `sourceFrameFor(clip, frame)`
rather than recomputing the multiplication — which makes the code say what the
gesture means: *the right half opens on the frame the playhead was showing.*

`trimStart`'s clamp was wrong in **both** directions, not one. At 2× it handed
back ten timeline frames that five frames of footage could not fill; at 0.5× it
refused ten frames the same footage could have covered twice over. Both are
pinned.

And `sourceFrameFor` itself was a second copy of `sourceFrameAt`
(`render/speed.ts:73`) that had already drifted: it took `clip.speed` at face
value while every render path clamps it to `[MIN_SPEED, MAX_SPEED]`. A project
carrying `speed: 100` therefore previewed, captioned and split on one frame and
exported another. It delegates now, so the two cannot disagree again — which is
the same lesson as the rest of the item: the sum existed, in the right place,
and the bug was code that did not call it.

Five mutations, all killed, against a green 1610-test gate: the split's timeline
advance, the trim's timeline advance, the head-reach clamp, the tail ceiling,
and the unclamped local rate. Not migrated: a 2× clip split *before* this fix
has a wrong in-point saved in the project file, and nothing can tell that apart
from a deliberate one — re-trim it.

### A2. Transitions play in the preview — **DONE**

**Where.** `src/renderer/src/components/Preview.tsx:817-826` (the only
transition code: a linear alpha), `src/shared/transitions/registry.ts`.

**Fix.** Each `TransitionDef` gains a `preview(progress, ctx)` beside its
ffmpeg strings, returning `{ alpha?, dx?, dy?, scale? , mask? }`, built by the
SAME factory that builds the ffmpeg expression — `slide(axis, from)` already
returns the ffmpeg function; make it return both, from one set of numbers,
so they cannot disagree. The draw loop applies alpha, offset and the zoom
scale/crop to the incoming layer. Luma masks: load the mask image once
(cache by file), and each frame build the alpha stencil on a small offscreen
canvas with the same threshold-and-softness rule as `lumaAlphaExpression`
(`registry.ts:49`), then composite the incoming layer through it with
`destination-in`. Masks are small; this is cheap.

**Tests.** For every built-in: evaluate the ffmpeg `position` expression at
five progress points with a tiny evaluator (`if`, `lt`, `min`, `pow`, `t`,
`S`) and assert the JS `preview` gives the same offset within a pixel. For
the stencil: on a synthetic left-to-right gradient mask, the opaque fraction
rises monotonically from 0 to 1 across progress and equals the geq formula's
prediction at three points. Harness: drop five different transitions on one
cut and screenshot each at 50 % — they must differ.

**What was actually built.** All of it, and two things the item did not
anticipate — one a bug found on the way in, one a decision to take.

`TransitionDef` gains `preview(progress, ctx)` returning `{alpha, dx, dy,
scale}`, and each effect is now one `Effect` object carrying both spellings, so
`fadeIn`, `slide` and `punchIn` each emit their filters and their numbers from
one place. `both()` composes them, which is exactly what "slide and fade" and
"zoom in" are. The luma wipe's ramp is a third spelling of one formula:
`lumaAlphaRamp` is the line, `lumaAlphaExpression` is its geq, `lumaAlpha`
evaluates it, and `lumaAlphaMatrix` is the `feColorMatrix` the preview's
stencil runs on the GPU (`src/renderer/src/wipe.ts`) rather than a per-pixel
loop over an ImageData sixty times a second.

**The bug.** `position` REPLACED the clip's resting place in the render, and
every transition's expression rests at 0 — so sliding a picture-in-picture, a
corner logo or a shrunk title card on flew it to the top-left of the canvas and
left it there for the rest of the shot. It is an offset added to the box now,
which is also the only way the preview could agree with it: the draw loop has
nothing to offset from except the box.

**The decision, not taken here.** "Zoom in" does not zoom. `scale`+`crop` runs
on the clip's whole chain, so it is a constant 15 % punch-in that outlives its
own transition and leaves the shot permanently tighter — always has. The
preview now shows that rather than hiding it behind a dissolve, and a test pins
it deliberately. Making it animate means a time-varying zoom on the ffmpeg side
(`zoompan`, or a second overlay), and both halves must move together.

Nine mutations, all killed, against a green 1640-test gate. Measured in the
harness rather than assumed: five transitions on one cut at the same frame give
five distinct canvases; a slide enters fully off-canvas and settles; and the
real `feColorMatrix` Chromium builds gives, half way through a ripple mask,
49 % fully opaque and 40 % fully clear with an 11 % soft band between them —
a wipe, where a fade would have been 100 % partial. The harness entry now also
exposes `useCatalog`, because the 405 library wipes are otherwise unreachable
in the one place they can be watched running.

### A3. The mix is heard: envelope, fades, crossfades, ducking — **DONE**

**Where.** `Preview.tsx:576-730` (an `HTMLAudioElement` pool with flat
`element.volume`), `src/shared/render/audioFade.ts` (`clipFades`,
`fadesWithNeighbours`), `src/shared/render/keyframes.ts` (`valueAt`),
`src/shared/render/plan.ts:1444-1451` (the render's `sidechaincompress`).

**Fix.** One `AudioContext` for the preview. Each element →
`MediaElementAudioSourceNode` → a per-clip `GainNode` → a per-track
`GainNode` → master `GainNode` → `AnalyserNode` → destination.
`element.volume` stays 1; every level is a gain:

- per clip, each frame: `clip.volume × envelope × fade`, where `envelope =
  valueAt(keyframes.volume, frame)` (the export's own function) and `fade =
  fadeGainAt(fadesWithNeighbours(clip, prev, next), localFrame)` — a new
  pure function in `audioFade.ts` that evaluates the `qsin` curve, tested
  against the dB table already in that file's comment.
- per track: mute (and solo, B1), and a **duck** gain for tracks marked to
  duck: a follower reads the dialogue sources' level from an analyser and
  ramps the gain down/up with the same threshold, ratio, attack and release
  the render passes to `sidechaincompress` — move those constants into a
  shared module so both read one set.

**Tests.** `fadeGainAt` at head, tail, mid, and across an overlap (equal
power: the two gains squared sum to 1 within 1 %). Duck follower as a pure
state machine over a level series. Graph wiring is checked in the harness
by ear and by the meters (B1).

**What was actually built.** All of it — `PreviewMixer`
(`src/renderer/src/audioGraph.ts`) with a gain per clip, a gain per track and a
ducked bus, fed by `clip.volume × valueAt(envelope) × fadeGainAt(fades)` where
every one of those three is the function the export uses. Ducking settings moved
to `src/shared/render/duck.ts` so the filter string and the preview's follower
are built from one set of numbers.

**And the render check found two shipped bugs in the export, both fatal.**

1. **Ducking crashed every export that used it.** `sidechaincompress` will not
   negotiate its two inputs, and the graph refused to initialise: *"The
   following filters could not choose their formats"*. The clip chains end in
   `aformat=…,aresample=48000`, which looks sufficient and is not — `aresample`
   converts without pinning the rate for negotiation. Both inputs now carry an
   explicit `aformat=…:sample_rates=…` immediately before the filter.
2. **With that fixed, the music went silent at the last word.**
   `sidechaincompress` ends when its sidechain ends, so a voiceover finishing
   before the music took the music with it — measured at **−23.4 dB while the
   voice ran and −91 dB, digital silence, for every second after**. The key is
   padded to the full duration now; silence is below the threshold, so the music
   simply returns.

Neither was reachable by any existing test, because the duck was only ever
checked as a string. **The Director sets `duck: true` on the music track of
every ad it builds** (`director/apply.ts:363`), so every one of those exports
was failing.

Eleven mutations, all killed, against a green 1657-test gate — including both
shipped bugs, put back and caught by the render check. Rendered evidence in
`tests/output/mix/` (see A-note below).

### A4. Audio while scrubbing — **DONE**

**Where.** `Preview.tsx:696-701` pauses every element when not playing.

**Fix.** While paused and the playhead moves, each audible element seeks to
the target and plays a burst of ~80 ms through the graph, throttled to ~12
bursts a second — the way every NLE scrubs. A toggle in the Transport,
default on.

**What was actually built.** Exactly that. The decision of WHETHER to burst is
a pure function (`src/shared/render/scrub.ts`) taken once per sync rather than
per element — ten clips under the playhead each running their own throttle
would interleave into a continuous smear — and the burst plays through the A3
graph, so a scrub is heard at the clip's real level.

One bug the tests caught before it shipped: the "nothing has fired yet"
sentinel was `lastAt: 0`, which is indistinguishable from a clock reading of
zero, so the throttle skipped itself and let bursts through eight milliseconds
apart. It only ever engaged by luck. `-Infinity` now, and `NaN` for the frame so
a drag starting at frame 0 still counts as a move.

Five mutations, all killed.

### A5. Multi-select, clipboard, ripple delete, right-click — **DONE**

**Where.** `store.ts:302` `selectedClipId: string | null`; every consumer is
listed in the audit — `Timeline.tsx:40,415,459`, `Transport.tsx:37,85`,
`Toolbox.tsx:47`, `Inspector.tsx:53,162`, `Preview.tsx:261,1426`,
`CurvePanel.tsx:22`, `Waveform.tsx:27`, `TranscriptPanel.tsx:15`,
`App.tsx:172,176`.

**Fix — selection.** `selectedClipIds: string[]` with the first as the
primary; keep `selectedClipId` as a derived getter during the migration so
each consumer converts on its own. Shift/⌘-click toggles; pointer-down on an
empty lane starts a marquee and selects every clip it touches. Moving,
deleting, nudging (←/→ one frame, ⇧ ten) act on all, as one transaction.

**Fix — clipboard.** In-store `clipboard: { clips: Clip[]; anchor: Frames }`.
⌘C copies, ⌘X cuts, ⌘V pastes at the playhead keeping relative offsets and
tracks (a busy lane falls back to `stackedSlot` for layers and `findFreeSlot`
for sequence clips), ⌘D duplicates directly after the selection on the same
tracks. Ids are regenerated; a self-drawn clip (`text`, `paper`, `carousel`)
gets a fresh asset and a bake.

**Fix — ripple.** **Delete keeps leaving a gap, on purpose.** Everything the
automations place sits on a beat, a drop or a sung word, and rippling would
drag the rest of the reel off the music — the exact reason `anchorTransition`
exists (`timeline.ts:1084`). So: **⇧Delete = ripple delete** (Premiere's
key) — remove and close the gap on that clip's *own track*, shifting only
later clips on that track; clips that overlap others are layers and are not
moved. And **Close gap**: clicking a gap selects it; Delete removes it.

**Fix — right-click.** A clip menu: Cut, Copy, Duplicate, Delete, Ripple
delete, Split here, Detach audio (B1), Reveal in pool.

**Tests.** Pure store recipes: move many keeps relative offsets; paste at
the playhead; ripple shifts only same-track later clips and never a layered
clip; duplicate gets fresh ids and a fresh text asset. Mutation each.

**What was actually built.** All of it, as pure recipes in
`src/shared/edit/recipes.ts` that the store calls and hands to `update()`, so
each gesture is one undo entry however many clips it touched. Marquee selects
what it TOUCHES rather than what it encloses — on a zoomed timeline, enclosing
means dragging past both ends of every clip, which is off-screen in both
directions. Lane boxes are measured rather than computed from an index.

**Two deviations, both deliberate.** Nudge is on **Alt+arrow**, not the bare
arrows: those already step the playhead one frame, which is the more
fundamental gesture and predates this. Alt+arrow is Premiere's nudge, so it is
the convention rather than a compromise. And the right-click menu leaves out
*Reveal in pool* and *Detach audio*: the pool has no selection state for
anything to be revealed into (a feature of its own, not a menu item) and
detaching audio is B1. A menu item that does nothing is worse than an absent one.

**And a shipped undo bug, found by driving it in the harness.** Text editing
coalesced a burst of keystrokes by holding a transaction open — `begin()` on
the first keystroke, `commit()` from a 160 ms timer — and `pendingSnapshot` is
a single module-level variable. So for those 160 ms **every other edit in the
app silently joined that transaction and got no undo entry of its own**: type a
caption, drag a clip straight after, and one undo took back both. Type into two
clips in a row and the second `begin()` overwrote the first's snapshot, so undo
jumped back past unrelated work. Found by nudging a selection right after
setting some text and watching a clip disappear.

Bursts now collapse by REMOVING the entry each keystroke pushed, under three
conditions extracted to `src/shared/edit/coalesce.ts`: a burst is open, nothing
else has edited since (checked by history depth), and the top of the stack is
the entry this edit made (checked by identity). Measured in the harness
afterwards: a five-keystroke burst is one entry, typing-move-typing is three,
and one undo after the move takes back only the keystroke.

Thirteen mutations, all killed, against a green 1689-test gate — including the
shipped one. One survived the first run: the `duplicate` fixture was a
contiguous row, where "after the selection" and "the first free frame" are the
same place, so the test passed with the anchor deleted entirely.

### A6. The timeline follows the playhead; zoom to fit — **DONE**

**Where.** `Timeline.tsx:186` is the only `scrollLeft`, a read; `:353` is the
scroll container; `store.ts:3624` `revealClip` only moves the playhead.

**Fix.** A `useEffect` on `playhead`/`playing`: while playing, when the
playhead's pixel leaves the visible lane, page the lane so the playhead sits
at 10 % from the left (Premiere's page mode — no per-frame scroll jitter);
when paused and the playhead is set off-screen (seek, `revealClip`), centre it.
`⇧Z` fits the whole project. `revealClip` also scrolls the clip into view.

**What was actually built.** Exactly that, with the rule as a pure function
(`src/shared/edit/follow.ts`) so it can be tested without a DOM. It returns
**null** rather than a position when there is nothing to do, which is the
load-bearing part: assigning `scrollLeft` every frame — even to the value it
already holds — fights anyone dragging the scrollbar.

`revealClip` needed nothing extra: it already moves the playhead onto the clip,
and the follow effect reacts to that.

Eight mutations, all killed. One survived the first run because the fit test
said "less than or EQUAL to the width", which passes with the margin deleted —
it now pins the spare room as a range, since a project fitted flush ends with
its last clip against the edge and its trim handle half off-screen.

### A7. Nothing is lost: autosave, close guard, recovery, a File menu — **DONE**

**Where.** `src/main/index.ts:126-133` (no `close` handler; `before-quit` only
stops the sidecar); `App.tsx:179-197` (Save/Open as bare hotkeys); no
`Menu` anywhere in `src/main`; `newProject` (`store.ts:3878`) never called.

**Fix.**
- **Menu**: `Menu.buildFromTemplate` — File (New, Open…, Open Recent, Save,
  Save As…, Export…, Close), Edit (Undo, Redo, Cut, Copy, Paste, Duplicate,
  Delete, Select All), View (Zoom in/out/fit, Fullscreen preview), Help
  (Keyboard shortcuts). Items send `menu:command` to the renderer, which
  dispatches to the store; the renderer reports `canUndo/canRedo/dirty` back
  so items enable correctly. `app.addRecentDocument` on save and open.
- **Autosave**: every 60 s while `dirty`, `project:autosave` writes
  `userData/autosave/<projectId>.forge.json` atomically (write temp, rename).
  On launch, main lists autosaves newer than their saved file; the renderer
  offers *Recover*.
- **Close guard**: `mainWindow.on('close')` and `before-quit` ask the renderer
  whether it is dirty and show Save / Don't Save / Cancel.
- **Save As**: `project:save` with `forceDialog`.
- Undo/Redo arrows and a Save button in the header, so the keys are not the
  only way.

**What was actually built.** The menu, the autosave, the recovery banner, the
close guard, Save As, and a `⌘/` shortcuts sheet — which is what actually makes
the keyboard discoverable, and is worth more than the header arrows it replaces
in that role.

Two things the item did not anticipate, both found while building it:

- **Quitting walked straight past the close guard.** A window's `close` handler
  does not run for a quit that has already been accepted, so `⌘Q` — the gesture
  most people use to leave an app — was the one that lost their work. `before-quit`
  routes through the window's own guard now, so there is one dialog and one answer.
- **Saving from the close dialog had to be WAITED for.** The renderer owns the
  project and the save is asynchronous, so closing on the reply alone raced the
  write. The guard waits for `project:saved` and stays open if the write failed
  or the dialog was cancelled.

Projects gained an `id` (minted on load for files written before it existed), so
an autosave is keyed to the WORK rather than to a path — a project saved under a
new name is the same project. Saves are atomic now, write-then-rename: a crash
mid-save could previously leave a truncated project where a whole one had been.

**Also, at the user's request: saved export settings.** `ExportPreset` in
`src/shared/render/presets.ts`, persisted in a new `settings.json` beside the
autosaves. Three ship — reel, square, wide — so the picker is never empty, and
each carries a filename suffix because otherwise the second export of one edit
silently overwrites the first. This is also the unit a batch queue takes later
(`docs/MARKET.md` Stage 4).

Thirteen mutations, all killed. And the harness caught a crash before it
shipped: the App reports its menu state during the first render, and neither
fallback bridge had that method — so the whole window rendered into the error
boundary. Both bridges now answer the startup calls.

### A8. Missing media is visible and relinkable; projects travel — **DONE**

**Where.** `src/shared/project.ts:126-133` (asset-id check only, no
filesystem), `src/main/ipc.ts:1044-1070` (`project:open` checks only parallax
layers), `Preview.tsx:1174` (skips an unready layer silently).

**Fix.**
- Save `path` **and** `relativeTo` the project file's folder. On open try
  absolute, then relative-to-project, then the project's search folders.
- Assets that still resolve to nothing get a runtime `offline: true` (never
  serialised): pool tile badge, a red *Media offline — name* card in the
  preview instead of black, a striped clip on the timeline.
- **Relink…** on a tile or for the whole project: pick a file or a folder;
  match by basename, then by basename + size.
- Export refuses before queueing, naming the offline assets.

**What was actually built.** All four, with the decisions in
`src/shared/project/relink.ts` and only the filesystem work in main.

`relativeTo` is written on save for assets under the project's folder, and not
for anything outside it — `../../..` segments stop meaning anything the moment
either end moves, so those rely on relinking instead. `offline` is runtime-only
and stripped on the way out: a saved `offline: true` would mark an asset missing
on a machine where it is sitting right there.

Relink matches by basename, then by basename and size — and **leaves an
ambiguous asset alone rather than guessing**. A wrongly relinked clip is worse
than an offline one: it renders, it looks plausible, and nothing says it is the
wrong take. `IMG_0001.MOV` is the most common filename in the world.

Twelve mutations, all killed. Two survived the first run and both were the
code's fault rather than the tests': a `?? asset.relativeTo` fallback that read
as a safeguard and was dead code (the spread above it had already done the job),
and a zero-size guard my fixture could not reach — it takes exactly ONE
zero-byte file among several to show that a drawn asset would otherwise relink
itself to a truncated file and clear its own offline mark.

### A9. The first hour

**Where.** `DEFAULT_SETTINGS` 1920×1080 (`timeline.ts:656`); empty states
(`MediaPool.tsx:138`, `Preview.tsx:1503`, `Timeline.tsx:371`); external drops
handled only by the Media grid (`Timeline.tsx:379`, `Preview.tsx:1491`);
the tab named *Auto* (`LeftPanel.tsx:25`).

**Fix.** A New Project step (also File > New): aspect with **9:16 first**,
frame rate, name. Files dropped on the preview import; dropped on the
timeline import and land at the playhead on that lane. Empty states that say
what to do: the preview — *Drop pictures or a clip here, or press Direct*.
The Director shows Product and Direct with everything else under *More*. The
tab is renamed **Create** (templates and automations live there). A `?`
sheet lists the shortcuts.

---

## Phase B — the other three

### B1. The audio surface: gain, solo, meters, detach, video-track mute, voice-over

**Where.** Level clamps at `store.ts:3411`, `Inspector.tsx:768-775`,
`keyframes.ts:57`, `VolumeEnvelope.tsx:54`; `Track` has no `solo`
(`timeline.ts:618-632`); track headers show one toggle per kind
(`Timeline.tsx:313-333`); `plan.ts:583` drops a hidden video track's sound
with its picture; no `getUserMedia` anywhere.

**Fix.**
- **Gain** to 200 % (`max: 2` in the model and envelope; the Inspector shows
  dB, −∞ to +6). The export's `volume=` takes values above 1 already; the
  preview needs A3's `GainNode`, which is why A3 comes first.
- **Solo**: `Track.solo?: boolean`. Preview and `plan.ts`: when any track is
  solo, only solo tracks are heard — including video clips' own sound.
- **Video-track mute**: a speaker toggle on video tracks; `muted` on a video
  track drops its *audio only* (the dialogue-input filter at `plan.ts:1419`
  gains `!track.muted`); `hidden` keeps dropping both, and the tooltip says so.
- **Detach audio**: `detachAudio(clipId)` makes an audio clip on the nearest
  free audio lane with the same asset, `inPoint`, `duration`, `speed`,
  `volume`; the video clip gets `volume: 0` and `detached: true` so the render
  skips its sound. One undo.
- **Meters**: from A3's analysers — master in the Transport, per track on the
  header; peak hold, red at −1 dBTP.
- **Voice-over**: a record button on audio-track headers → `getUserMedia` →
  `MediaRecorder` (webm/opus) → main converts with the bundled ffmpeg to wav
  (safe on 2018) → asset → clip at the playhead; count-in; level on the
  meters. Ducking today keys off *video-track* sound, so `Track.dialogue?:
  boolean` marks an audio track as speech that ducks the music — on by
  default for a voice-over track.

### B2. Export has a shape: frame rate, size, codec, quality, hardware, range

**Where.** Encoder tail hardcoded at `plan.ts:1509-1516`; three canvases at
`aspect.ts:9-13`; `fps: 30` written by nothing (`timeline.ts:656`); the save
dialog filters to `mp4` (`ipc.ts:989`).

**Fix.**
- **Frame rate** in the New Project step and on the Output panel: 24, 25, 30,
  50, 60. Changing it on a populated project converts every frame value by
  the ratio and says so — frames are the unit, so this is arithmetic, not a
  re-edit.
- **Canvas**: add 4K (3840×2160, 2160×3840, 2160×2160) and 720p variants.
- **Codec**: H.264 (`libx264`) · H.265 (`libx265` — **measure the Windows
  build lists it**) · ProRes (`prores_ks` — measure Windows). **Hardware**:
  `h264_videotoolbox` on macOS (measured present); `h264_nvenc`, `h264_amf`,
  `h264_qsv` on Windows only if `-encoders` lists them **and** a ten-frame
  probe encode succeeds at startup (`probeEncoders()`, cached) — fall back to
  software with a note, as Premiere does.
- **Quality**: a CRF slider with three named presets, or a target bitrate
  (`-b:v`) for "upload at 8 Mbps"; audio 128/192/256/320 kbps; container
  mp4 or mov.
- **Range**: in/out points from A5 → `RenderRequest.range`; the plan trims
  its window.
- **Time remaining** from progress and elapsed, beside the speed string.

### B3. Colour, key, masks, motion, transcript

**Temperature and tint.** `ColorAdjust.temperature?` and `tint?` (−1..1) →
a 3×3 matrix on **`colorchannelmixer`** (2013) — *not* `colortemperature`,
which merged in 2021 and is blocklisted. The WebGL grade (`grade.ts`)
multiplies by the identical matrix; parity test on synthetic pixels between
the matrix maths and ffmpeg's output on a generated frame.

**Chroma key.** `Clip.key?: { color, similarity, blend, despill }` →
`chromakey` (2015) + `despill` (2017) in the clip chain before the overlay.
Preview: a WebGL shader with `chromakey`'s own distance formula; parity test
on a generated green frame — measure ffmpeg's alpha, compare the shader's.
Colour picker: click the preview to sample.

**Mask keyframes, then tracking.** Make mask `x/y/width/height` keyable
(`KeyedProperty` grows); `maskExpression` compiles piecewise-linear
expressions in `T` into `geq`, which exposes `T`; preview via `valueAt`.
Tracking comes after, as the one new component: OpenCV CSRT in the sidecar
(`opencv-python-headless`, BSD — a library, not a model) → `mask.track`
returns per-frame boxes → written as mask keyframes the user can then edit.

**Camera moves by hand.** An Inspector *Motion* section: the twelve moves,
amount, shake (amount, rate, decay, anchor), parallax when a bake exists →
`setMotion(clipId, motion | undefined)`. Rule: a camera move and zoom
keyframes are exclusive — choosing one clears the other, and the panel says
so — because both scale the picture and the render would compound them.

**Steady.** `deshake` (2013) as a clip toggle. `vidstab` two-pass only if
both builds carry `libvidstab` — measure Windows.

**Transcript editing.** Inline word editing in `TranscriptPanel`
(`editTranscriptWord(assetId, index, text)`); segments re-derive; caption
clips regenerate because they are derived from the transcript. A
*Vocabulary* field (brand and product names) passed to faster-whisper's
`initial_prompt` — Opus Clip sells this as *Brand Vocabulary*; here it is
free.

---

## Phase C — the Director, measured

`docs/LLM.md` calls the missing eval the quiet killer: until it exists, no
change to the prompt can be called an improvement. This phase builds it and
runs it. **No fine-tuning** — that is `LLM.md`'s fourth move, taken only if
the prompt path fails. "Tuning" here means prompt, menu and parameters.

**Fixtures.** Ten briefs in `tests/fixtures/director/`: each 4–8 stills, one
short clip, 30 s of music, a product line, a language (six English, two
Telugu, two Hindi). The same ten run against every configuration.

**Configurations.** Ollama `gemma4:e2b` and `qwen3.5:4b`, each with `think`
off and on; LM Studio `google/gemma-4-e2b`. The first question, before any
quality question: **does `format` hold with `think: false` on this Ollama
version** (issues #15260, #14645)?

**Recorded per run**, into `docs/EVAL.md`: JSON valid · validator verdict
and repairs · truncated? · prompt/output tokens · time to first token and
total · copy quality 1–5, judged blind by the user against the standard cut
· headline length vs `headlineCapacity` per language.

**Knobs.** Playbook wording; one worked example in the system prompt; menu
size (all candidates vs downbeats only); field order; `maxTokensFor`
constant; temperature 0 vs 0.2 for copy; images on with slot notes vs text
only; Telugu/Hindi — the 40-char cap is a Latin-script number, so measure
what fits a phone frame in those scripts and set per-language capacity.

**Exit.** The architecture is proven when one local configuration produces
a non-rejected plan on eight of ten briefs with copy the user rates ≥ 3.
If none does, the finding is written down before anything is retrained.

---

## Phase D — the dressing planner (pass 2)

The spine says *what* happens when. The planner says *how it looks*, from the
library the app already has — and it is where that library becomes the
product rather than a set of panels.

**Catalogue from code.** `src/shared/director/catalogue.ts` builds the menu
from the registries, never by hand: text styles (`textStyle.ts` ids with a
one-line intent each), text animations (`textAnimation.ts`), looks
(`looks.ts`), transition families (already), single-slot treatments — grid
split (`automation/grid.ts`), strip flashes (`strips.ts`), newspaper
clippings (`render/paper.ts`), one-photo framing (`onePhoto.ts`) — and SFX
by tag from the asset catalogue. Stickers wait for the semantic index
(`bge-m3`, because the titles are Telugu and Hindi; `LLM.md` §Rejected).

**Schema `dress@1`.** Per segment: `{ slot, textStyle, animation, treatment,
sfx: 'start' | 'punch' | 'none' }`; whole ad: `{ look, captionStyle }`. Enums
per request from the catalogue; `reasoning` first; flat.

**Validator.** A treatment fits its slot (grid and strips need a still or a
clip of at least a bar; clippings need a headline; one-photo framing needs
a subject bake); at most two treatments per ad and none on the hook or the
CTA (AUTOMATION.md §5 — sparse is the craft); a look is one adjustment layer
over the whole ad at an intensity; SFX on `punch` lands on the card's start
frame (the headline has no per-word timing yet — say so, do not fake it).

**Apply.** Reuses the rules' own pure functions; writes ordinary clips under
`director.dress`; one update, one undo, cleared with the rest.

**Order.** After Phase C says the spine works on a real model. The planner's
prompt includes the validated spine from `decisions`, so it is pass 2 in
fact, not in name.

---

## Phase E — templates with slots, and the market around them

This is the product idea: the *tone* picker for voice has a twin for ads —
a **style**, or template — and a template someone else made is worth money
to the person whose footage fills it.

### The format — build this first, it is also the Director's substrate

A **template is a `.forge` project with slot marks.** `Clip.slot?: { index,
kind: 'image' | 'video' | 'text', label }` on the clips a user may replace;
everything else — music, cut positions, transitions, text styles, looks — is
the template. *Save as template* marks the slots, strips the author's media
from them, keeps library assets (stickers, transitions, fonts) as catalogue
ids, declares aspect, frame rate and duration, and renders a preview mp4
locally. *Use template* lists the slots; the user drops media into each, or
the Director fills them — the template **is** a spine, which makes the
model's menu smaller still.

The project format is already versioned with a migration hook
(`src/shared/project.ts`), and `SCHEMA_VERSION` becomes a compatibility
promise the day a template leaves the machine it was made on.

### Not CapCut's templates

The pattern, yes; the files, no. CapCut's drafts are undocumented JSON known
only through reverse engineering, the assets inside them are CapCut's, and
CapCut's own help centre says desktop cannot even author the slots. Building
on that is a technical and a legal dead end. Forge's own format, with the
same slot idea, is a week of work and ours.

### Distribution — free packs first

The pack pipeline exists, is tested and has shipped: a manifest with sha256,
install, remove, progress (`assets:packs`). A template pack is a project
file plus its preview plus any bundled library references — a JSON on
GitHub away from a community gallery, with the author's locally rendered
preview as the thumbnail. **No server, no cloud render, no accounts.**

### The market — after there is a catalogue

Selling templates is how CapCut's ecosystem grew and how MotionVFX became
worth buying — Apple did, in March 2026. For wedding and event editors,
buying a proven highlight template and dropping in the footage turns hours
into minutes; the categories you named are the right shelves. It is also
compatible with the app being free and MIT: the market is a service, not
the code. The bottlenecks, plainly:

| bottleneck | what it means | the way through |
|---|---|---|
| **rights** | a template carries music, fonts, footage; the seller must have the right to redistribute them, and a marketplace lives or dies on takedowns | v1 templates may reference only library assets and the buyer's own media; author music only with a rights attestation; a licensed / CC music library is a prerequisite for paid templates |
| **money** | payments (Stripe, Razorpay/UPI), seller payouts and KYC, platform fee, refunds, GST/VAT, terms of service | an entity and a processor — not code, but real work before the first rupee |
| **format stability** | a bought template must open in next year's Forge | migrations become a promise; every schema change gets a migration and a test |
| **fonts** | system fonts do not travel | templates use bundled fonts, or declare a fallback |
| **aspect** | a 9:16 template used at 16:9 re-solves every reframe | templates declare their aspects; the store refuses others until re-solve is trusted |
| **copying** | a template is a JSON file — trivially shareable | accept it, as CapCut does; sell convenience, updates and the gallery |
| **discovery and trust** | search, categories, ratings, reports, previews | server-side, and only worth building over a catalogue that exists |
| **infrastructure** | hosting bundles with music inside, accounts, listings | start on the pack pipeline; add a server when the catalogue outgrows it |

**Sequence.** Format and *Use template* (it doubles as the Director's slot
UI) → free community packs through the existing pipeline → a music library
with rights → then payments. Charging comes when there is something worth
paying for and the rights to sell it.
