# Where things are

A map of the app. Written because features that exist but cannot be found are
the same as features that do not exist — which is literally what happened twice:
"Put behind the subject" and the whole transition panel were both built, both
working, and both effectively invisible.

The window is four areas: **left panel**, **preview**, **inspector** (right), and
**timeline** (bottom).

---

## Left panel — what goes on the timeline

Four tabs across the top.

**Media** — your imported files as a **grid of thumbnails**, not a list of
names: a camera gives you IMG_4821 and DSC_0037, so the picture is the only
thing that identifies a shot and the name is a caption over it. Video shows a
frame from 0.5s in, because the first frame of a clip is very often black.

**Drag a tile onto the timeline** to say which track and when; double-click to
append it to the first track of the right kind. Drag one onto the **picture**
and a chip offers what it should become — see the preview below.

Three buttons above it make clips out of nothing:

| Button | What it makes |
|---|---|
| `+ Text` | A text clip. Type on the preview or in the inspector. |
| `+ Colour` | A flat card of colour — something for text to sit on, or a wash between shots. |
| `+ Grade` | An adjustment layer. Grades every track **below** it, for as long as it runs. |

**Library** — the shipped assets: transitions, stickers, props, sounds, titles.
Drag onto the timeline, or onto the picture. Transitions must be dropped on a
clip's incoming edge.

The **package button** beside the search box opens the **asset packs** — the
downloads that put things in here in the first place. It opens on its own the
first time the library is empty, which in an installed build is the first launch:
an installer ships no assets at all, so "Nothing here." is where most people
start and the offer has to be in it. See `docs/ASSETS.md`. Nothing in the editor
needs a pack; they add choices.

**Text** — title templates.

**Auto** — the automations. See §5.

---

## Preview — direct manipulation

Select a clip and you can work on it where you can see it.

- **Any clip**: a box with corner handles. Drag to move, corners to scale, the
  stalk above to rotate (hold shift for 15° steps).
- **A text clip**: click the words to edit them, drag to move, the corner dot to
  size the type. Enter commits, shift+enter is a new line, escape cancels.

- **A mask**: pick **Mask** or **Blur** in the tool strip and a shape appears on
  the picture. Drag inside it to move, the edge dots to resize along its own
  axes, the dot above to rotate (it snaps to the straight angles). Everything
  outside the shape is dimmed so the region reads at a glance, and the outline
  is drawn feathered, so softness is something you see rather than a number you
  imagine. Pressing the same tool again takes the mask off.

Anything you add — a sticker, a prop, a colour card, text, a title — lands
**under the playhead**, so the thing you just added is the thing on screen with
handles around it. If you later select a clip that sits at a different moment,
the preview says so and offers one click to go to it: a clip is only drawn while
the playhead is over it, and handles can only exist over a frame being drawn.

The tool strip runs down the left of the picture: Select, Reframe, Thirds, Safe
areas, **Text**, Mask, Blur — and Paint, which is greyed because painting pixels frame by
frame is a long way off and worth being honest about.

**Text** here means words ON this picture. `+ Text` in the left panel adds a
text clip to the timeline. Both make the same kind of clip; where you reach for
it is what says which you meant.

**Dropping onto the picture.** The canvas takes a drag from the pool or the
library. It lands on the top video track at the playhead, filled to the frame,
and a chip offers the other two readings: a corner **picture-in-picture**, or a
**blurred background** — which is sent underneath everything, since a blurred
copy drawn on top hides the shot it was meant to sit behind. Each choice writes
ordinary transform and mask values, so none of them is a mode and the result
stays draggable. A sound dropped here is refused: it has no appearance.

**Resizing is free-form.** Four corner handles move both axes independently and
four edge handles move one — drag a side for width, the top for height. Hold
shift on a corner to keep the proportions.

The split view (Source | Output) is in the inspector under **Preview**. Drag the
divider in the picture to compare; double-click it for an even split.

---

## Inspector — everything about the selected clip

Top to bottom. The panel scrolls; the export block at the bottom does not.

**Output** — aspect ratio, loudness, preview mode, captions, then the export
itself (`ExportSettings.tsx`, above the Export button):
**Size** 720p / 1080p / 4K on the chosen aspect; **Codec**, listing only the
encoders this machine test-encoded with at launch; **Quality** as High /
Standard / Small or a fixed **Bitrate** in Mbps, with an encode-speed row for
the software encoders; **Audio** AAC 128/192/256k; **File** .mp4 or .mov
(ProRes forces .mov); and, when the timeline has in/out marks, **Only between
the marks**. **Saved settings** below the button carry all of it.

**Captions** — four presets (Pop, Kinetic, Clean, Bold centre), then the *same*
**Style** and **Animation** libraries the text clips use: all 42 looks and all 9
animations, previewed on tiles showing a real caption with a word highlighted.
Then the font, size, words per line, and the highlight colour.

The word being spoken is lit and slightly larger, and the highlight rides on top
of whatever style is chosen — a chrome caption keeps its chrome and only the
spoken word changes colour.

A plain caption is burned in during the normal encode and costs nothing extra. A
styled or animated one is painted first — only the pictures that actually differ,
over only the band of the frame it occupies — and composited in the same pass. On
twenty seconds of 1080×1920 that is about six seconds against the thirty-two the
old two-pass path took.

**Clip** — duration, source in-point, reframe.

**Size, position and opacity** — the same values the preview handles change.

**Speed** (video and audio only) — 0.25× to 4× as presets, plus a rate slider.
The clip keeps its footage and changes how long it sits on the timeline, and
anything after it on that track moves along with it. Below 1× a **Smooth slow
motion** toggle appears, which invents the in-between frames instead of
repeating them — worth it for a hero shot, and roughly forty times slower to
export, so not for a whole reel. Stills have no speed control: a photograph has
no rate to change.

**Mask** — the numbers behind the shape on the picture: which shape, what
happens inside it (**Blur** / **Colour** / **Show**), blur amount, feather,
width, height, angle, and **Invert**. `Edit on picture` toggles the handles in
the preview; `Remove` takes the mask off. It sits directly above Colour on
purpose — in *Colour* mode those sliders apply only inside the shape, and the
Colour heading says so while that is true.

**Colour** — brightness, contrast, saturation, then **Looks**: seven one-click
grades (Warm Film, Golden Hour, Teal & Orange, Cool Cine, Faded, Bleach Bypass,
Noir) with an **Intensity** slider once one is on. `or load your own .cube…`
takes a LUT from any grading tool. You do not need to supply anything.

**Text** (text clips only) — five layout presets first (Title, Lower third,
Impact, Quote, Sticker), then the **Style** library: 42 looks — gradient,
metallic, chrome, neon, glow, two-tone, stacked 3D, highlight block, struck
through, glitch split, hollow, and a handful that style one WORD of the line
differently from the rest. Each tile shows your own words in your own font. Style
and font are separate axes, so any style works with any face. Six are shown
inline; **Browse all 42** opens a full gallery — blurred backdrop, search, and a
big preview over your actual frame that follows the pointer.

**Animation** — how the words arrive: Fade, Rise, Pop, Typewriter, Bounce, Wave,
Zoom out, Slide, Drop, or None. A strip above the chips plays the one you are
hovering, in your own font, style and words, so you can try all nine without
choosing any. A third independent axis: any animation works with any style on any
face.

Then the font picker, placement, size, tracking, weight, shadow, colour, caps and
**outline**.

Long text wraps inside the title-safe margin rather than running off the edge;
subtitles wrap to the same margin in both the preview and the export.

**Layout** — **Stacked** and **Side by side** split this clip with the one on the
track below: each takes half the frame and fills it, rather than letterboxing
inside it. Then four picture-in-picture shapes — same shape as the video, square,
circle, tall — which shrink the clip into a corner over whatever is underneath,
with rounded or circular edges so it looks placed rather than pasted on. A corner
grid appears once a clip is inset, and **Full frame** puts it back.

Neither is a mode. Both write a box into the clip's ordinary transform, so the
result stays draggable and resizable in the preview like anything else.

**Fill with the picture below** — the trailer look. The clip stops being drawn
and the picture on the track underneath shows only inside its shape. Retype the
word and the fill follows, and if the text is animated the footage arrives with
it — the letters carry the picture they are cut from.

**Put behind the subject** — splits the photo underneath into background and
subject, with this clip between them.

**Keyframes** — Zoom, Rotate, Opacity. The diamond adds a key at the playhead and
lights up when you are sitting on one; moving a slider between keys writes a new
one there. Each key eases `linear`, `smooth` or `hold`. One key is a value, two
or more animate.

**Motion path** — animated position, with presets, plus `Add point at playhead`.

**Transition in** — how this clip arrives. It appears whenever there is anything
underneath: the clip before it on the same track, **or a layer below it**. The
second case is how a grid reveal is built, and the panel says so when that is
what it is doing. Filter the masks by what they DO (grid, blinds, radial…)
rather than by name.

**Exports** — pinned to the bottom, always reachable. A running export shows
its speed and, after its first few seconds, the time left.

---

## Timeline

Video tracks are listed **highest first**, like every other editor: the track at
the top of the list draws on top of the picture. Audio sits below.

`+V` and `+A` add tracks. The eye hides a video track; the speaker mutes an audio
one — both exclude it from the export.

**A clip moves in both axes.** Drag it sideways in time and up or down through
the layers in one gesture, onto a lane of the same kind and never onto a locked
one. This did not exist until recently — the drag only read `clientX`, so a
clip could never leave the track it was born on. That is why picture-in-picture
felt pointless: there was no way to get a second video above a first one for it
to be in front OF.

**The waveform is drawn on the clip.** Any clip whose asset has sound shows it:
full height on a sound file, the **lower half** on a video clip, which is what
Premiere and Resolve both do and leaves the top for the name now and thumbnails
later. It stays on video clips because speech lives there — a one-camera
wedding's vows are V1's audio, not a separate track, and "cut just before he
says it" is the cut you would otherwise scrub blind for.

`ClipWaveform.tsx` draws it; `@shared/render/waveBars.ts` decides *what* to
draw and is where the hard part lives. A clip shows a **window** of its source —
trimmed at both ends, and consuming `duration × speed` frames of file per
frame of timeline — while the peaks array spans the whole file. Three things
that are easy to get wrong and impossible to see afterwards, because a waveform
of the wrong part of the sound looks exactly as convincing as the right one:

- index by the peaks' **own** `durationMs`, not the asset's `durationFrames` —
  a video whose container claims ten seconds can carry eight of sound
- **aggregate** buckets per column rather than sampling one, or a snare
  disappears and reappears as you zoom
- ask for buckets **proportional to the source** (`bucketsForSource`, 20/s,
  clamped 200–4000) — a fixed 600 over a ten-minute podcast is one a second, so
  a two-second answer cut out of it gets two bars

The canvas is capped at two pixels per available bucket and stretched with CSS,
so a ten-minute clip at maximum zoom is a few thousand pixels of canvas rather
than two hundred thousand — which a canvas cannot allocate at all.

**The volume line is drawn over it.** Click the line to add a point, drag a
point in time *and* level, double-click one to remove it. They are ordinary
`volume` keyframes — the same ones the inspector's curve editor writes —
compiled at render into `volume=…:eval=frame`, which is measured to work
(EFFECTS.md §1).

This is the **drawn** kind, the Ableton kind: *quiet here, because I say so*.
It is not ducking, which is automatic and lives on an audio track's `duck`
flag. Both should exist; they answer different questions.

**Fades are the third thing, and also separate.** Grips at the top corners of
any clip with sound: drag inwards to fade up or down, double-click to remove.
The shaded ramp is always drawn so a fade is visible without hunting; the
grips only appear on hover or when the clip is selected, because an
always-live target eleven pixels into the trim strip would quietly take a
slice of trimming away from every clip nobody is fading. The two fades cannot
pass each other — they meet and stop.

A fade **multiplies** the envelope rather than replacing it, which is what a
DAW does and why they are separate controls: softening an entry should not
mean redrawing a curve you already shaped. `audioFade.ts` has the `qsin`
measurement and EFFECTS.md §26 has the chain-order reasoning, which is the
whole correctness of it.

**Two clips that draw themselves in 3D or on paper** are made from the Media
tab: `+ Newspaper clippings` and `+ Card ring`. Both bake to numbered PNG
sequences with alpha and land as ordinary clips, so nothing in the export
knows about either. See `docs/PAPER.md` and `docs/CAROUSEL.md` — and note the
rule both of them cost bugs to learn: **a clip drawn at the canvas size
belongs on three lists** (the preview's readiness gate, `setAspect`'s
no-auto-reframe skip, and `rebakeGenerated`).

**Loudness is in the Output panel, not the Sound row**, because it is a
property of the export rather than of a clip: every track and the music
measured together after the mix. Off / Social −14 / Podcast −16 / Broadcast
−23, on by default at −14 for new projects and off for anything saved before
it existed. EFFECTS.md §28 has the two things `loudnorm` does behind your
back, both of which are load-bearing.

**Overlap on a track means crossfade**, and that is derived rather than
stored — so it is true of a dropped video transition as much as of a
deliberate crossfade. Until this existed, every dissolve played both
soundtracks at full and measured 3 dB hot. Explicit fades still win.

The one audio control that is *not* on the clip is **Crossfade with the clip
before**, in the Inspector's Sound row, because it has to CREATE the overlap
it fades across and the drag that would do it is already taken: dragging a
clip onto its neighbour sequences it clear, which is load-bearing for stacked
layers like grids and filmstrips (see `moveClip`'s `stacked` check). So the
button makes the overlap — sliding the incoming clip back and closing the
track up behind it — and the grips on the clip shape it afterwards.

**What an overlay on a clip may take.** The envelope first shipped as a
full-bleed `absolute inset-0 z-10` div with `onPointerDown` on it, which is the
obvious way to make a line clickable — and it made **every clip with sound in
it immovable**: no dragging, no cross-track drag, no trimming, no selecting.
Clicking a clip added a volume point instead of picking it up. So: the
container is `pointer-events-none`, the line takes pointers back through a
transparent fat stroke (`pointerEvents: 'stroke'`), the dots opt in
individually, the trim handles sit at `z-20` above it all, and the waveform
never takes a pointer at all. `tests/clipOverlays.test.ts` guards each of
those against the source — jsdom implements neither stacking contexts nor
hit testing, so a mounted-component test would have certified the bug.

**Missing here, in the order you would notice:** no copy, paste or duplicate;
no multi-select; no markers; and no audio fades.

---

## The automations (Auto tab)

**Director** — first in the tab: an ad from your pictures, your music and a
line about the product. Only the product line is required. Your pictures are
listed in pool order with a field each for what is in them; the gear opens
the model settings (Auto / Ollama / an OpenAI-shaped server such as LM
Studio, with a write-only key field). Direct asks the model for a plan,
checks it, and places shots on V1, headline cards on the lane above,
transitions where the plan asked, and trims the music to the ad — as ONE
undo. When the model's plan cannot be used you get the standard cut and a
note saying why. Clear takes exactly its own work back, music included.
See `docs/LLM.md`.

**Beat-synced reel** — many photos cut to music. Pick the music range on the
waveform, set motion and transition rate, press Analyse & build.

**One photo** — one picture, one song, one caption. Turns a single photograph
into several shots by reframing it, and splits your caption into cards sized to
the tempo, each landing on a downbeat.

**Filmstrip** — photos as full-height panels in one long row, panning across
frame.

**Props on keywords** — fires 3D props on spoken words, from a transcript.

Every automation writes **ordinary clips**, labelled with why they fired. Clear a
rule and exactly its own output goes. Nothing is hidden, and nothing an
automation makes is harder to change than something you made yourself.

---

## Two things worth knowing

**Restart after a main-process change.** The renderer hot-reloads; the main
process and the sidecar do not.

**`npm run harness`** serves the interface as a web page on port 5199, with the
app services stubbed. It exists so the UI can be looked at and clicked without
launching the app. It cannot export, bake depth, or decode real media — those
calls throw with a message saying so rather than pretending.
