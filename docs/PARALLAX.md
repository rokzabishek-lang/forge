# 2.5D parallax on stills

How to make a photograph move as though a camera moved through it, rather than
across it. This is the "3D zoom" effect CapCut ships, and for a wedding or
portrait reel it is the single highest-value thing we do not yet have.

---

## 1. Why Ken Burns is not enough

A Ken Burns move is affine: the whole photograph scales and translates as one
flat plane. Nothing occludes anything, so the brain reads it as a camera
pointed at a *print* of the scene. Parallax is the cue that says otherwise —
near things must traverse the frame faster than far things. Get that one cue
right and a still reads as a place; leave it out and it reads as a slideshow,
however well the cut lands on the beat.

This is why the motion repertoire in `reel.ts`, wide as it now is, tops out at
"nice slideshow". The ceiling is the flat plane, not the choreography.

## 2. The three ways to do it

### a) Per-pixel displacement ("depth warp")

Depth map → displace every pixel by `k · depth` as the virtual camera moves.
Per-pixel and per-frame, so in practice a WebGL fragment shader.

The failure mode is **stretching at depth discontinuities**: the background
behind the subject was never photographed, so the renderer smears the last
known pixel across the hole. Small moves hide it; large moves do not. The
quality of the result tracks the quality of the depth map almost entirely — the
industry summary is that a mediocre photo with an excellent depth map looks
good, while an excellent photo with a sloppy one "looks like a melting
hologram".

### b) Layered Depth Image + inpainting

Cut the image at its depth discontinuities into layers, then **hallucinate what
is behind each edge** with an inpainting network, so the hole has real content
in it. This is the Shih et al. approach (*3D Photography using Context-aware
Layered Depth Inpainting*, CVPR 2020) and the faster *One Shot 3D Photography*
that followed it. Best quality, largest camera moves, and three networks plus
a mesh renderer in the pipeline.

### c) Discrete planes (2–3 cutouts)

Threshold the depth map into foreground / midground / background, alpha-cut the
foreground, fill the hole behind it **once**, then animate each plane at its
own rate. Visually this is (b) with two layers instead of twelve, and at
slideshow camera speeds the difference is very hard to see.

## 3. What Forge should build: (c)

Not because it is the cheapest — because it is the only one that fits the
render-tier model without splitting into two implementations.

| | preview | render |
|---|---|---|
| **(a) depth warp** | WebGL shader | a *second* shader path, or a per-frame `remap` — and the two must match |
| **(c) planes** | three `drawImage` calls | three ffmpeg inputs with `zoompan` + `overlay` |

With planes, preview and render are **the same operation** — "show this
rectangle of the source, scaled to the output" — so there is no class of bug
where the export does not match what was on screen. That is worth more than the
extra fidelity of a warp, and it lands the whole feature on **tier 1**: no
Chromium pass, no neural net at render time. (See `PLAN.md` §3b — the tier is a
property of the request.)

`shared/render/motion.ts` holds the move table and the arithmetic; the renderer
compiles it into a `zoompan` expression, the preview feeds it to `drawImage`.
One integration test crops the source to the preview's rectangle and compares it
against the real render at the same instant, because "the same operation" is a
claim and claims should be tested.

It also degrades honestly. A plane that fails to separate is still a plane; it
just moves with its neighbour. A warp that fails melts.

### The bake

One pass per photo, cached by content hash, in the sidecar:

1. **Foreground matte.** For a portrait — which is nearly every wedding
   photo — segmentation beats a depth threshold, because depth alone will cut
   through an outstretched arm at the same distance as the background. Note
   that **the hard part of matting is a video problem**: temporal stability is
   what has no permissive solution (`STACK.md` §3). On a single still that
   constraint vanishes, and BiRefNet (MIT) is both better and licence-clean.
2. **Depth map** for everything else, to order the remaining planes.
3. **Hole fill.** For a 2–4% camera move the hole is tens of pixels wide.
   Telea inpainting (`cv2.inpaint`) is instant at that scale and good enough;
   a learned inpainter can be swapped in later *without changing the layer
   format*, which is the point of baking to layers rather than to a warp.

Output: 2–3 RGBA PNGs plus a JSON manifest of per-plane depth. That is the
whole interchange format, and it is inspectable — you can open the layers.

### Depth model

`STACK.md` §4 already lands on **Depth Anything V2 Small** (Apache-2.0; the
Base and Large checkpoints are CC-BY-NC-4.0). Worth knowing: the YOLO26 depth
heads now beat DAv2-Small on CPU ONNX throughput, at AGPL-3.0 — which given
`STACK.md` §0 already puts Forge at GPL-3.0 via RobustVideoMatting is not a new
constraint for a desktop app. Either is fine; start with DAv2-Small because it
is already in the plan, and treat depth as the adapter it was always specified
to be.

Note the requirement is **coarse layer boundaries, not metric depth**, so the
small checkpoint is not a compromise here.

## 4. Honest limits

- **Camera moves must stay small.** Past roughly 5% of frame width the fill
  shows. Cap the amount in the UI rather than letting the slider reach a range
  that looks broken.
- **Some photos have no subject.** A landscape, a flat-lay, a crowd at
  distance — there is nothing to separate. CapCut's version has the same
  constraint; it wants a recognisable face, pet or object. Detect the failure
  (matte covers <2% or >85% of frame) and fall back to an ordinary Ken Burns
  move rather than shipping a melted one.
- **Hair and veils** are the worst case, and a wedding reel is full of both.
  This is the thing to look at first on real photos.

## 5. What was built — 2026-09-11

All four steps are in. Notes from doing it:

1. **`depth.layers` in the sidecar.** 2–4s per photo, cached by content hash
   (instant on a repeat). Image decode and encode go through the bundled ffmpeg
   for the same reason audio does — one media pipeline, no compiled Python
   imaging dependency. scipy comes with librosa and does the clustering
   (1-D k-means at the image's own natural breaks, not fixed quantiles, so a
   photo with one plane is not forced into three), the morphology, and the hole
   fill via `distance_transform_edt`. No opencv.
2. **`motion: { kind: 'parallax' }` in the IR**, with the bake stored per *asset*
   on the project rather than per clip — two clips of the same photo share it.
3. **Preview** draws the planes to the same canvas the flat path uses. Note the
   preview did not show camera motion *at all* before this: a photo sat still on
   screen and moved in the export. Ken Burns and shake are previewed now too.
4. **Reel integration** picks parallax per shot where the bake separated, flat
   where it did not, and says `· depth` in the reason so it is visible which
   is which.

Three things worth remembering:

- **Verify the depth convention, do not assume it.** Depth Anything V2 emits
  disparity, so *higher is nearer* — checked on three real photographs (sky
  ~0.0, near ground 2.5–4.8). Backwards would put the background in front of the
  subject, silently.
- **A centred zoom moves a point in proportion to its distance from the
  centre.** The first version of the parallax test put its markers at different
  offsets and measured that geometry rather than the parallax. Physically
  correct, useless as a test.
- **Parallax reads as a bigger move than it is**, because the planes separate.
  The reel scales the amount to 0.7 of the flat move; matching it overshoots and
  starts to show the fill behind the nearest plane.

### Subject matting and anchored shake — 2026-09-12

The front plane now comes from **BiRefNet_lite (MIT, ~115MB fp16)** rather than a
depth threshold, when it finds something. That matters because a depth band is
not a person: it cuts through an outstretched arm at the same distance as the
wall, and on a portrait against a flat backdrop there is no depth spread to
cluster at all. A matted front plane is pinned to depth 1.0, and a bake with a
real cutout counts as `separated` whatever its depth spread says — a portrait
against a plain wall is precisely the case this exists for.

It degrades honestly. BiRefNet is **salient-object** segmentation, not a person
detector: on a street scene with no dominant subject it returned 0.2% coverage,
which falls outside `MIN_SUBJECT`, and the bake reports `subject: false` and
uses depth alone. Verified on both cases.

Cost: about 6-8s on top of the depth pass, so ~11-14s per photo instead of 2-4s.
Cached like everything else.

**Anchored shake** falls out of this almost for free: it is parallax with the
weighting inverted — near plane ~0, far plane full — so the subject is nailed
down and the scene takes the hit. It reads as force applied to the world rather
than to the camera. Two things worth knowing:

- It cannot expose the baked fill. A subject that does not move keeps covering
  exactly the same pixels, so the constraint that caps parallax travel
  (`MAX_PARALLAX_AMOUNT`) simply does not apply here.
- Shake now **decays**. Without an envelope the wobble ran for the whole shot:
  a rendered reel shook for 2.23 continuous seconds on its drop, which reads as
  a fault rather than a hit. It settles over ~0.16s into a slight punch-in.

The same cutout is what text-behind-subject needs — background planes, then the
text, then the front plane — so that is now mostly a compositing question rather
than a modelling one.

### Still open

- **Quality on real photographs is unverified.** The pipeline is proven; how it
  looks on a wedding photo is not, and hair and veils are the worst case.
- The backdrop's nearest-neighbour fill is visibly streaky in its deep interior.
  It is never *seen* — the planes in front cover it and only move a few percent —
  but a distance-weighted blur would make it defensible if a bigger move is ever
  wanted.
- `parallaxAssets` is decided at build time. Re-baking one photo means rebuilding
  the reel.

Sources:
[Web-Based Dynamic Paintings (2.5D pipeline)](https://arxiv.org/pdf/2311.15354) ·
[One Shot 3D Photography](https://arxiv.org/pdf/2008.12298) ·
[Depth Anything V2](https://depth-anything-v2.github.io/) ·
[DAv2 Small licence discussion](https://github.com/DepthAnything/Depth-Anything-V2/issues/320) ·
[YOLO26 depth](https://docs.ultralytics.com/models/yolo26) ·
[CapCut 3D zoom](https://www.capcut.com/explore/depth-map)
