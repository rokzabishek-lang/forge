# The references this project is built from

Everything Forge was measured against, and what each one settled. Written down
because the sources are photographs, screen recordings and conversations — none
of which survive a context being compacted, and two of which have already been
lost once.

**The paper sketches are in [SHEETS.md](SHEETS.md)**, all seventeen transcribed,
plus sheet ① for the grid split as an eighteenth. This file covers the moving
references.

---

## Where the files are

`references/recordings/`, beside this file, and deliberately **not** committed.
They are other people's work — Instagram reels and app screen-recordings kept
for study — and a hundred megabytes of video besides. `.gitignore` excludes
them. What they taught us is below, and that part *is* committed, so the
findings survive even if the files do not.

They were copied out of `~/Downloads`, which gets cleared.

| file | source | length |
|---|---|---|
| `capcut-grid-template.mp4` | CapCut template by `cpttmplate`, via Instagram | 19.76s |
| `machicut-card-ring.mp4` | MachiCut app, `machicut.en` | 7.71s |
| `after-effects-3d-camera.mp4` | After Effects, `editsbysriparna` | 30.06s |

---

## 1. `capcut-grid-template.mp4` — the one that set the pace

Sent as "look how music sync it was, that was my plan". A screen recording of a
CapCut template playing, with the template's own music on it.

**Everything below is measured off the file**, not impressions of it. The full
working is in [EFFECTS.md §20](EFFECTS.md); the short version:

- **112.3 BPM.** Autocorrelating the onset envelope gives 1.057s, 0.534s and
  0.267s — a bar, a beat, an eighth. A sixteenth is 134ms, which at 30fps is
  exactly four frames.
- **Two phases from one primitive.** 0–7.6s: one photograph diced into a **4×4
  grid**, pieces arriving scattered until the picture is whole. 7.6–19.8s:
  continuous footage with vertical strips, horizontal bands and diagonal wedges
  of a *brightened* copy flashing in and out. Not shot cuts — the shot runs on.
- **73% of visual changes land within one video frame of a sixteenth-note
  grid**, median error 20ms. Against a quarter-note grid it is 23%; against
  eighths, 45%.
- **Flashes arrive in triples** on consecutive sixteenths, not as an even pulse.
  Nine of ten on the grid.
- **Density doubles** once the picture is whole: 1.8 changes/sec during the
  assembly, 3.5 after.

**What it changed in the app.** The cadence control ran 1–8 *beats*; the
reference lands pieces on *eighths*, so the fastest setting we had was half the
speed of the thing it was modelled on. Beats are now subdivided as well as
skipped. It also forced splitting "never cut on every beat" in two: that rule is
about SHOTS and still holds, but this template changes something four times a
beat and does not read as frantic, because what changes is a treatment over
continuous footage.

---

## 2. `machicut-card-ring.mp4` — the 3D card carousel

Photos as cards on a curved ring in 3D, with the app's own controls visible on
screen. Worth keeping for the panel, which names every parameter:

> **RING** — Curvature 100%, Spacing, Fixed path size, Bow inward, Path
> **VISIBLE ARC** 40 · **Feather** 1 · **CARDS** 20, Cards facing
> **Corner** 40 · Border · Thickness
> **ROTATE** — X-tilt 20, Y-spin, Z-roll

**Status: not built.** The tilt/spin/roll here is a **perspective warp**, not the
flat `transform.rotation` the app has — a distinction worth holding onto,
because it looks like the same control and is not.

`perspective` is present in the bundled ffmpeg, does a real quad warp, and
animates per frame on `on` — the same variable `zoompan` uses and the keyframe
compiler already targets. Measured: five sampled frames, five distinct hashes.
So a 3D tilt is expressible in the single-pass graph. The card ring needs a
camera model on top of that, and is the furthest away of anything discussed.

---

## 3. `after-effects-3d-camera.mp4` — the one that "blew my mind"

Caption on the original: *"Recreated this animation for learning 3D."* Flat image
layers parked at different Z depths with a real perspective camera flying
between them; the viewport shows the wireframe planes edge-on and the camera
line running through.

**Status: half built, and the hard half is the done half.** Cutting a photograph
into depth planes is what the sidecar's depth bake already does
(`docs/PARALLAX.md`). What is missing is driving those planes from a *camera*
rather than from a hand-set parallax amount.

---

## What was measured against the bundled ffmpeg

Findings that cost real time to establish and would cost it again. Full context
in EFFECTS.md; kept here so they are findable.

| finding | detail |
|---|---|
| `even(n)` rounded **up** | the original crop crash; `evenDown` exists because of it |
| `crop` refuses rather than clamps | but accepts expressions over `in_w`/`in_h`, which survive inside a `filter_complex` |
| `tpad=stop_mode=clone` preserves alpha | rgba 7f stayed 7f |
| image2 starts at frame **1** | `-start_number 0` is required |
| concat demuxer ignores the **last** `duration` | so the final entry must be repeated |
| `geq` has `max`, `min`, `hypot`, `clip`, `abs`, `sin`, `PI` | time variable is `T`, not `t` |
| `perspective` animates on `on`, not `t` | `t` is not defined there |
| `drawbox` writes colour but **not alpha** | on a transparent base it is an invisible bar |
| `rotate` keeps the input's size | corners are cut unless `ow`/`roth` grow it |
| `setpts` takes `log()` | so a true continuous speed ramp is ONE filter, not a stack of clips |
| **two ffmpegs** | `@ffmpeg-installer` ships 4.4 on macOS arm64 and 4.1-or-older on Windows — see EFFECTS.md §25 |

---

## The project's own infrastructure

Facts that live nowhere else now that the repo exists.

- **Repository:** `https://github.com/rokzabishek-lang/forge` (private)
- **CI:** `.github/workflows/ci.yml` — macOS **and Windows**, every push:
  typecheck, the full suite *including* the ffmpeg integration tests, then the
  build. The integration tests are in CI on purpose: a runner's `D:\a\forge\forge`
  path is exactly the shape that breaks filter arguments.
- **The Windows machine** is a Surface, being reset at the time of writing. When
  it is ready, install the packaged `.exe` on it **before** installing any dev
  tools — a clean machine is a first-run test you only get once.
- Writes to `.git/` are blocked in the assistant's sandbox, so **commits and
  pushes are run by hand**.
