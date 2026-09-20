# The card ring — photographs in 3D

`docs/REFERENCES.md` §2, the MachiCut recording. Photographs as cards on a
curved ring, turning. Its own control panel named every parameter worth having
and those names are kept here, because they came from a tool people use:
cards, radius, card size, **visible arc**, spin, tilt, roll.

---

## Why three.js, and why it was nearly not

That reference was written up as **"the furthest away of anything discussed"**,
and at the time that was true — because it assumed the effect had to be an
ffmpeg filtergraph. Twenty cards would have meant twenty animated `perspective`
filters, a camera model projecting each card's four corners, and a
back-to-front sort every frame: a small 3D engine driving ffmpeg.

`docs/PAPER.md` established the other route end to end — **compute it in JS,
draw it, bake numbered PNGs with alpha, drop the sequence on the timeline** —
and on that path the camera model is arithmetic.

The honest case for the dependency was never the ring. It is
`after-effects-3d-camera.mp4`, which `REFERENCES.md` calls *"half built, and
the hard half is the done half"*: the sidecar already cuts a photograph into
depth planes, and what is missing is driving them from a **camera** rather than
from a hand-set parallax amount. three.js is exactly that missing piece, on
assets already being generated. The ring is the cheaper thing built first to
prove the pipeline without depending on the depth model.

**Hand-rolled 2D was the real alternative** and would have covered the ring and
a card flip with no dependency at all. It cannot do the depth camera
convincingly — that needs true perspective through several planes at different
Z, which affine transforms cannot fake.

---

## What it cost, measured

| | |
|---|---|
| package on disk | 22 MB |
| **chunk actually shipped, gzipped** | **298 KB** |
| main bundle growth | **20 KB** (the carousel code, not three.js) |

The lazy import is **verified, not assumed**: `three.module-*.js` is its own
chunk and only loads for a project containing a ring.

**298 KB is higher than it should be, and the cause is our code.** An earlier
probe measured 129 KB tree-shaken. `loadThree()` hands back the *namespace* and
the scene reads `three.WebGLRenderer` off it — **Rollup cannot tree-shake
through property access on a namespace object**, so the whole library ships.
The probe used named imports, which shake.

Fixable with a small module of static named imports, loaded dynamically:

```ts
// threeScene.ts — static named imports, so Rollup can shake
import { WebGLRenderer, Scene, PerspectiveCamera } from 'three'
// carouselCanvas.ts
const { makeScene } = await import('./threeScene')
```

Worth about 170 KB. Left undone deliberately — it is a one-time fetch on a
chunk most projects never load.

---

## Where it lives

| file | what |
|---|---|
| `src/shared/render/carousel.ts` | **the geometry.** Imports no three.js at all |
| `src/renderer/src/carouselCanvas.ts` | three.js: meshes, textures, the bake |
| `src/renderer/src/components/CarouselPanel.tsx` | the controls |
| `clip.carousel` | the spec, beside `clip.text` and `clip.paper` |

Same split as paper, for the same reason: a GPU cannot tell you that a fan is
hanging off to one side or that the front card faces away. Those are
arithmetic. It also keeps the geometry inside `tsconfig.node.json`, which does
not compile the renderer.

---

## Four bugs worth keeping

**A closed ring and an open fan need different denominators.** On a full circle
the ends wrap, so the last card stops one step short of the first —
`i / cards`. On a partial arc both ends sit *on* the arc — `i / (cards - 1)`.
Using `cards` for both looks right and biases the whole fan sideways, so the
middle of frame is a gap: the one thing the viewer looks straight at.

**Depth ties must be compared against an epsilon.** Two mirrored cards are at
the same depth in arithmetic and a hair apart in floating point, so
`dz || index` never reaches the tie-break — the draw order flips on noise,
which is a flicker with no findable cause.

**The scene drew nothing.** `scene()` built meshes, positioned them and never
called `render`. `void root` had been written to quiet an unused-variable
warning instead of noticing nothing was being drawn with it. Four blank
canvases and a clean typecheck.

**The camera backed off twice too far**, so the ring filled a seventh of the
frame. In three.js `fov` is **vertical**: `tan(fov/2) × distance` is half the
frame's *height*, and half its width is that times the aspect. A horizontal
extent was fitted against the vertical half.

**And the test made the identical mistake, so it passed.** That is the fourth
time in this project a test has shared its code's misconception. It now checks
width and height separately at three aspect ratios, and asserts the ring
**fills** a decent share of the frame — because "does it fit" is true of a
speck.

---

## Rendering notes that are not obvious

**One WebGL context, shared and resized.** A browser allows around sixteen live
contexts and silently drops the oldest past that. A renderer per clip — or per
frame of a bake — exhausts it in seconds, and the symptom is earlier rings
going black for no visible reason.

**Textures are downscaled to 640px before upload.** A 4000×3000 photograph is
~48 MB as RGBA and twenty of them is nearly a gigabyte, which is how a card
ring takes a laptop down. A card is a few hundred pixels on screen; the rest is
memory spent on detail nobody can see.

**Draw order comes from the geometry, not from three.js.** `depthWrite` is off
because the cards are transparent, so painter's order decides what is in front
— and `carouselCards`' sort is the one that has been reasoned about and tested.
Letting three.js sort them would put a second, different opinion in the
pipeline.

**Cards fade by `facing` rather than being culled.** A card vanishing at the
edge of the arc pops, and a ring that pops reads as dropped frames.

---

## On the three lists

A clip that draws itself at the canvas size belongs on **all three** — the
preview's readiness gate, `setAspect`'s "do not auto-reframe generated
artwork" skip, and `rebakeGenerated`. Clippings cost four separate bugs by
being on none of them (`docs/PAPER.md`). The ring was put on all three before
it shipped.

---

## Not done

**The export is unverified on real hardware.** The harness fakes the disk
entirely, so the bake-to-PNG path has never run against a real filesystem for
a ring — exactly the gap that produced paper's ENOENT.

**The depth-plane camera**, which was the real justification for the
dependency. `ParallaxBake` already gives `layers` ordered far to near with a
`depth` 0..1 each; every layer becomes a textured plane at its own Z and the
camera flies through.

**Card flip**, which is now trivially reachable and was impossible before —
the app only had flat rotation.

**The tree-shaking fix** above, worth ~170 KB.
