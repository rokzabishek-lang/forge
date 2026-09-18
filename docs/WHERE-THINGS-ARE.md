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

**Media** — your imported files. `+ Import` brings in photos, video and music.
Double-click anything to drop it on the timeline at the playhead.

Three buttons above it make clips out of nothing:

| Button | What it makes |
|---|---|
| `+ Text` | A text clip. Type on the preview or in the inspector. |
| `+ Colour` | A flat card of colour — something for text to sit on, or a wash between shots. |
| `+ Grade` | An adjustment layer. Grades every track **below** it, for as long as it runs. |

**Library** — the shipped assets: transitions, stickers, props, sounds, titles.
Drag onto the timeline. Transitions must be dropped on a clip's incoming edge.

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

The split view (Source | Output) is in the inspector under **Preview**. Drag the
divider in the picture to compare; double-click it for an even split.

---

## Inspector — everything about the selected clip

Top to bottom. The panel scrolls; the export block at the bottom does not.

**Output** — aspect ratio, preview mode, captions.

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

**Exports** — pinned to the bottom, always reachable.

---

## Timeline

Video tracks are listed **highest first**, like every other editor: the track at
the top of the list draws on top of the picture. Audio sits below.

`+V` and `+A` add tracks. The eye hides a video track; the speaker mutes an audio
one — both exclude it from the export.

---

## The automations (Auto tab)

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
