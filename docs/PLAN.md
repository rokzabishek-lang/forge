# Forge — architecture and implementation plan

> Status: design document. Model/library choices marked **[VERIFY]** were cut off by a
> rate limit before research completed — treat them as my priors (knowledge to May 2026),
> not as verified September 2026 facts. Everything not so marked is architecture, which
> does not depend on which model wins this quarter.

---

## 1. The one decision that makes this buildable

You described four products:

1. Long-form → short-form clip mining (Opus Clip style)
2. A real NLE with VFX, captions, b-roll, depth compositing
3. Beat-synced image → reel
4. Narration-driven generative video (TTS + stock footage)

They look like four apps. They are not. **All four produce the same artifact: a timeline.**

- Clip mining produces a timeline with one trimmed video clip + a caption track.
- Image→reel produces a timeline of image clips with beat-aligned transitions.
- Narration video produces a timeline of TTS audio + stock clips + captions.
- The NLE *edits* a timeline.
- Export *renders* a timeline.

So the spine of this product is a **Timeline IR** — a JSON document describing tracks,
clips, in/out points, transforms, effects and keyframes — plus exactly one renderer that
turns it into a video. Every AI pipeline is a *timeline generator*. The NLE is a
*timeline editor*. There is one render path, one preview path, one undo system.

Build the IR and the renderer first, and features 1/3/4 become "write a function that
emits JSON." Build the four features separately and you will write the render logic four
times, diverge four times, and never ship the NLE.

**This inverts your ordering.** You listed the AI pipelines first and the NLE as the thing
you need "so the user can control it." I'd build the timeline core *first*, because it is
what every pipeline writes into.

---

## 2. The three speeds

The single hardest constraint you named is "low compute," and it collides head-on with
DepthAnything + matting. A 60-second 1080p30 clip is 1,800 frames. Nothing neural runs
1,800 frames in real time on a laptop.

The resolution is to stop treating it as one problem. There are three different speeds,
with three different rules:

| | Speed | Resolution | Neural nets? | Runs when |
|---|---|---|---|---|
| **Preview** | must be ~real time | proxy (e.g. 480p) | **never** | while editing |
| **Bake** | seconds→minutes, backgrounded, cancellable, cached | full | yes | once per clip |
| **Render** | slower than real time is fine | full | **never** | on export |

The bake pass computes depth maps and alpha mattes **once per clip** and writes them to
disk. Preview and render then read *pre-computed assets*. No model ever runs in the render
path.

This is what makes the viral-VFX vision tractable. It also means the UI must be honest
about it: a clip arrives, the user sees a "analysing depth…" progress chip, and the depth
features unlock when it finishes. That is a normal, acceptable UX (it is what Resolve's
optical-flow and CapCut's auto-cutout do). What is *not* acceptable is a UI that appears
to offer the effect and then stutters.

### Bake cache design

- Store alpha mattes as a **grayscale video** next to the source, not a PNG sequence.
  Near-lossless single-channel H.264/FFV1 is ~1-2% of the source size; a PNG sequence for
  a 60s clip is thousands of files and cripples your filesystem. **[VERIFY]** exact codec
  choice — the tradeoff is matte edge quality vs size, and it needs a real test.
- Same for depth: single-channel video, 8-bit is usually enough for occlusion ordering.
- Key the cache on `hash(source file + model + model version + params)` so a model upgrade
  invalidates cleanly instead of silently serving stale mattes.
- Cache lives in `userData/bake/`, is fully disposable, and must be re-derivable. Never
  put anything in the cache that the project file depends on.

---

## 3. Your renderer already exists and it is Chromium

This is the second realisation worth more than any model choice.

ffmpeg **can** do: trim, concat, scale, crop, overlay, `alphamerge`/`maskedmerge`,
`xfade` transitions, burn ASS/SSA subtitles, audio mixing, sidechain ducking. That covers
a great deal.

ffmpeg **cannot** reasonably do: kinetic typography with easing curves, per-property
keyframe animation, 3D-transformed text, layered graphics with blend modes, anything
resembling a motion-graphics system. People who try end up writing unreadable
`filter_complex` graphs that are impossible to debug.

You are shipping an Electron app. **You already bundle a world-class 2D/3D compositor with
a text engine, WebGL, and CSS easing: Chromium.** The render pipeline therefore is:

```
                 ┌─ ffmpeg: decode source video ──────────────┐
timeline.json ──►├─ Chromium: render graphics layer per frame │──► ffmpeg: composite ──► out.mp4
                 │   (deterministic seek, RGBA PNG/raw)       │      + audio mix
                 └─ bake cache: subject matte, depth ─────────┘
```

The graphics layer is a normal web page that accepts `?frame=N`, renders that exact frame
deterministically, and is screenshotted. This is precisely how Remotion works, and it is
proven at production scale.

The "sandwich" effect then falls out naturally as a three-layer composite:

```
background (source video)
  └─ graphics layer (text, from Chromium, RGBA)
       └─ subject layer (source video masked by baked matte)
```

**Hard rule: the graphics layer must be a pure function of `(timeline, frame)`.** No
`Date.now()`, no `Math.random()` without a seeded PRNG, no animation driven by wall clock.
The moment rendering depends on real time, your export stops matching your preview and you
will lose days to it.

---

## 3b. Render tiers — always take the cheapest path that works

Not every overlay needs the same machinery. Routing each graphics request to the cheapest
renderer that can satisfy it is what keeps the app fast for the common case.

| Tier | Renderer | Handles | Cost |
|---|---|---|---|
| **1 — ASS** | ffmpeg + libass | Captions, word highlighting, outlines, shadows, positioning, simple fades | Near-free. No frame server, no compositing, no extra runtime |
| **2 — Chromium** | offscreen page → RGBA → ffmpeg | Kinetic typography, SVG title templates, stickers/props, blend modes, luma-mask transitions, 3D transforms | One render pass per frame |
| **3 — Chromium + bake** | tier 2 plus cached mattes/depth | Text behind a person, depth-ordered layering, anything needing per-pixel masks | Tier 2 plus a one-off neural bake per clip |

**The overwhelming majority of captions are tier 1.** A word-highlighted caption track needs
no depth model, no matting, no frame-by-frame rendering — libass draws it during the normal
encode. Only when a caption has to sit *behind* a subject does the request climb to tier 3,
which is where DepthAnything and RVM earn their cost.

Two consequences worth holding onto:

- **Tier 1 is also the fallback.** If the frame server fails or a model is missing, captions
  still render — degraded in style, never absent. Same baseline-plus-enhancement shape as the
  director (`DIRECTOR.md` §3).
- **The tier is a property of the request, not the feature.** "Captions" is not a tier; *this
  caption, with these options* is. The selector looks at what a request actually asks for —
  does it need a mask? a blend mode? per-property animation? — and picks accordingly. Which
  means adding an effect means teaching the selector one more rule, not building a
  parallel pipeline.

---

## 4. Honest feasibility assessment

### Achievable now, genuinely low compute

| Feature | Approach | Notes |
|---|---|---|
| Word-level captions | ASR with word timestamps → ASS karaoke tags or Chromium layer | **The highest-value feature in the whole product.** Ship it first |
| Clip scoring | deterministic features + small LLM rerank | §5 |
| Partial YouTube download | `yt-dlp --download-sections` | Real, large bandwidth saving. **[VERIFY]** reliability across formats |
| Beat grid | onset + beat tracking | ms-accurate enough for visual sync |
| BGM ducking | VAD → gain automation, or ffmpeg `sidechaincompress` | **You do not need Demucs for this** |
| Auto-reframe 16:9→9:16 | face/person detect → smoothed crop path | Smoothing matters more than the detector |
| Image→reel | Ken Burns + beat-aligned cuts | Cheap and looks great. Best effort/reward ratio in the product |
| TTS narration | small local TTS | **[VERIFY]** model choice |
| Stock media | Pexels/Pixabay/Openverse APIs | **[VERIFY]** commercial redistribution terms per source — this is a real legal detail, not a formality |
| SFX placement | library + beat/onset snapping | Trivial once the beat grid exists |

### Achievable, but must be baked (never real time)

| Feature | Why it's expensive |
|---|---|
| Text-behind-subject ("sandwich") | per-frame matting; temporal flicker is the real enemy, not speed |
| Depth-aware placement | per-frame depth inference |

**[VERIFY]** matting and depth model choice. Two license leads that surfaced before the
research died and must be checked properly: **RobustVideoMatting appears to be GPL-3.0**
(which would be viral for a commercial desktop product), and **BiRefNet variants appear
mostly MIT but not uniformly**. Do not pick either until the license is read from source.

### Harder than it looks — reframe before you build

**"Text on mountains / water / clouds."** Depth estimation will *not* give you this. Depth
gives you occlusion ordering — what is in front of what. It does not give you a stable
surface to pin text to; per-frame depth jitters, and text pinned to jittery depth swims.

What you actually want is **planar tracking** — track a region's homography across frames
(OpenCV feature tracking or optical flow) and transform the text by it. That is classic CV,
cheap, and solvable. Full camera solve / 3D scene reconstruction is a research project;
don't go there.

So: depth for *occlusion*, planar tracking for *placement*. Different tools, different
problems. Conflating them is the trap here.

**3D props and typography in the NLE.** Needs a WebGL layer in the compositor (three.js in
the graphics page). Fine architecturally — it's the same Chromium render path — but it is a
large feature. Later.

### Things I'd advise against

- **Fine-tuning a director model now.** §5.
- **Full source separation (Demucs) for ducking or beat detection.** You want drum/bass
  *onsets* and speech *presence*. Onset detection and VAD give you both at a tiny fraction
  of the cost. Keep Demucs as an opt-in power feature for actual stem extraction (e.g.
  "remove vocals from this BGM"), not as a pipeline stage everything waits on.
  **[VERIFY]** current Demucs CPU cost and lighter alternatives.
- **madmom** for beat tracking — **[VERIFY]**, but its license has historically been
  restrictive for commercial use. Check before adopting.
- **Shipping PyTorch.** ~2GB+ and a packaging nightmare. Prefer ONNX Runtime (~50MB) with
  exported models. This single choice is most of what "low compute" and "shippable
  installer" mean in practice. **[VERIFY]** which of your chosen models have solid ONNX
  exports — this should *drive* model selection, not be an afterthought.

---

## 5. The clip-mining pipeline — and why I'd change your design

Your proposal: chunk the transcript into 5-7k token windows, ask a 1-2B model to rate the
best clip in each, keep scores, rank globally.

Three problems with it:

1. **Fixed chunking biases the output.** Asking "best clip in this 6k block" yields roughly
   one clip per block whether or not the block contains anything good — and misses clips
   that straddle a boundary.
2. **1-2B is below the floor** for this judgment. **[VERIFY]** the current small-model
   landscape, but my strong prior is that 4-8B class is the realistic minimum for reliable
   structured reasoning, and that the gap between 2B and 7B on exactly this kind of task is
   large.
3. **Absolute 1-10 scores from small models are badly calibrated.** "Rate this 1-4" gives
   you noise that looks like signal — the same clip scores differently depending on
   position, phrasing, and what came before.

### What I'd build instead — candidate generation, cheap filter, LLM rerank

This is the standard two-stage retrieval pattern, and it's strictly better here:

**Stage 1 — candidate generation (deterministic, free).**
Build sentence boundaries from word timestamps. Slide windows at the user's requested
durations (30/60/90s) over sentence boundaries — never mid-sentence. A 40-minute podcast
yields a few thousand candidates. Costs nothing.

**Stage 2 — cheap feature scoring (deterministic, free).** Score every candidate on signals
that need no model:
- audio energy and energy *variance* (flat delivery is not clippable)
- speech rate and change in speech rate (emphasis)
- laughter / non-speech events
- question→answer span detection (a question followed by a strong answer is the single most
  reliable "clippable moment" pattern)
- starts-cleanly / ends-cleanly (does it open mid-thought?)
- speaker turn density
- filler-word density (negative signal)

Keep the top ~30-50. **This stage does most of the real work**, it's explainable, and it's
tunable without touching a model.

**Stage 3 — LLM rerank (listwise, not absolute).** Feed the LLM ~8 candidates at a time and
ask it to *rank* them, with a one-line reason each. Listwise ranking from a small model is
dramatically more reliable than absolute scoring, because relative judgment is easier than
calibration. Merge the rankings; keep the top N the user asked for.

**Stage 4 — only now download.** `yt-dlp --download-sections` for the winning timestamps
only. Exactly your instinct, and it's a good one.

**Stage 5 — emit a Timeline IR document per clip.** Video clip + caption track + reframe
crop path. The NLE opens it. The renderer renders it. No separate code path.

Store candidates and scores in SQLite in the sidecar — you'll want to replay scoring
against new heuristics without re-running ASR.

### The fine-tuning verdict

**Don't, yet.** Reasoning:

- You have no dataset. Fine-tuning needs labelled examples of good/bad clip decisions, and
  you'd be inventing them — encoding your guesses into weights, where they become much
  harder to inspect or change than a prompt and a feature weight.
- Most of the quality lives in Stage 2, which is not a model problem at all.
- **The dataset you actually want writes itself.** Which clips users keep, re-crop, publish,
  or delete is ground truth about clip quality, and it arrives free with usage. Instrument
  that from day one — it is the single most valuable thing you can do now *for* a future
  fine-tune.
- When you do train, the right target is probably **a ranking/reward model, not a
  generative one** — you want "is A better than B," which is a far smaller, better-posed
  learning problem than generating judgments, and it trains on pairwise preferences that
  your telemetry produces directly.

So: instrument now, fine-tune in v2 on real preferences.

---

## 6. Process architecture

```
┌──────────────────────────────────────────────┐
│ Electron main (Node)                         │
│  • window, project file I/O                  │
│  • ffmpeg job queue  ← already built         │
│  • sidecar lifecycle + progress relay        │
└───────────┬──────────────────────┬───────────┘
            │ IPC                  │ JSON-RPC / HTTP+WS
┌───────────▼──────────┐  ┌────────▼─────────────────┐
│ Renderer (Chromium)  │  │ Python sidecar           │
│  • NLE UI, timeline  │  │  • ASR, TTS              │
│  • canvas compositor │  │  • onset/beat, VAD       │
│  • graphics layer    │  │  • matte/depth bake      │
│    (= render engine) │  │  • LLM scoring           │
└──────────────────────┘  │  • SQLite                │
                          └──────────────────────────┘
```

The sidecar is a separate process for three reasons: Python AI work must never block the
UI; a crashing model must not take the app down; and it can be killed and restarted without
losing the project.

**Packaging the sidecar is your biggest unsolved engineering problem** — bigger than any
individual model. The realistic options:

- **Ship it bundled** (PyInstaller/briefcase): big installer, works offline immediately.
- **Download runtime + models on first run**: small installer, needs network, needs careful
  integrity checking and resumable downloads.
- **Hybrid** — ship ONNX Runtime and the small models, fetch the large ones on demand.

My recommendation is the hybrid, and it is the strongest argument for the ONNX-over-PyTorch
decision. **[VERIFY]** current ONNX Runtime execution-provider reliability on Apple Silicon
(CoreML) and Windows (DirectML) — this genuinely determines whether one codebase covers
both platforms or you maintain two paths.

---

## 7. Build order

Each phase ships something usable and reuses the spine. Resist reordering to chase a
feature — the dependencies here are real.

**Phase 0 — Timeline IR + renderer.** The JSON schema, pure functions over it (already
started in `src/shared/timeline.ts`), and a headless `timeline.json → mp4` renderer via
ffmpeg. Test it with hand-written JSON, no UI at all. *This is the foundation; nothing else
is meaningful without it.*

**Phase 1 — NLE shell.** Media pool, timeline UI (drag/trim/split/snap), canvas preview,
transport, undo/redo, project save/load, export via the existing job queue. **Undo/redo and
the project file format are Phase 1, not "later"** — retrofitting either into a mature
editor is brutal.

**Phase 2 — Captions.** ASR → word timestamps → styled animated captions through the
Chromium graphics layer. Highest user value, fully deterministic, and it proves the entire
sidecar → timeline → render path end to end on something that can't be fudged.

**Phase 3 — Clip mining** (your problem 1). All the infrastructure exists by now; this
phase is candidate generation, feature scoring, LLM rerank, and partial download.

**Phase 4 — Beat-sync image reel** (problem 3). Beat grid + transition library. Reuses
captions and the graphics layer.

**Phase 5 — Narration / generative** (problem 4). TTS + stock fetch + auto-assembly. This
is mostly a timeline *generator* by this point.

**Phase 6 — Depth/matte VFX** (problem 2's advanced half). Bake pipeline, sandwich
compositing, planar tracking for surface-pinned text.

Phase 2 is deliberately before Phase 3: captions are what users want most, and they force
you to get the sidecar, word-level timing, and deterministic rendering right while the
surface area is still small.

---

## 8. What carries over from what's already built

Working and verified today:

- Electron 44.3.0 + React 19 + TS scaffold, deps installed, Electron binary running
- ffmpeg/ffprobe resolution with the asar-unpack path handling (`src/main/ffmpeg/paths.ts`)
- ffprobe metadata reader (`probe.ts`)
- ffmpeg runner: `-progress` parsing, cancellation with the Windows `taskkill` path, partial-output
  cleanup (`run.ts`, `src/shared/progress.ts`)
- Concurrency-limited job queue against a generic executor interface (`queue.ts`)
- Output path resolution with collision and self-overwrite guards (`output.ts`)
- Frame-based timeline model (`src/shared/timeline.ts`)

All of it survives. **An NLE's export is exactly a job queue running ffmpeg with progress
and cancel** — that work was not wasted by the pivot.

Two known gaps:
- `src/renderer/src/main.tsx` imports an `App.tsx` that doesn't exist yet — the app won't
  start until Phase 1 begins.
- The bundled ffmpeg is **4.4 (2021)**, too old for an editor. Swap for a current static
  build; `paths.ts` is the single choke point, by design.

---

## 9. Decisions made

**1. The NLE is a correction surface, not a general editor.** Its job is to let the user see
and fix AI decisions *before* render. The concrete failure that motivates it: auto-reframe
cropping to dead centre where nobody is speaking, invisible until after export.

This usefully narrows Phase 1. Ranked by what actually has to be good:

- **Crop-path editing** — scrub the timeline, see the reframe rectangle, drag it, keyframe
  it. This is the #1 feature, not a nice-to-have.
- **Aspect switching** — 16:9 ↔ 9:16 ↔ 1:1 with the crop path re-solved per aspect.
- **Trim/split/reorder** on a single video + audio track.
- **Per-decision revert** of director ops (see `DIRECTOR.md` §3).

What Phase 1 does *not* need: multi-track compositing, transitions, effects racks. Those
arrive with Phases 4-6.

**2. yt-dlp is in.** Open-source project, no automated scraping at scale, user-initiated
single downloads. Accepted — no further flagging. Practical note: still handle 403/429/410
and format-unavailable gracefully, because they will happen on individual fetches regardless
of scale.

**3. Niche: wedding and photography are the target industry**, but the UI keeps all modes
available and specialisation waits until Phase 6. Important consequence — see `DIRECTOR.md`
§8: for weddings the signal hierarchy *inverts*. The emotional peak is in the audio (vows,
crying, cheering) and the image (the kiss, the first dance), not the transcript. So the
director interface must accept candidate moments from **any** source — transcript features,
audio events, or CV — never assume a transcript. That constraint is cheap to honour now and
expensive to retrofit.

**4. "Fully local" means no per-use API cost, not no network.** Local LLM, local Kokoro-class
TTS, local ONNX runtime, local Demucs; Pexels and yt-dlp use the network but cost nothing
per call. This resolves the sidecar API shape: **one local execution path, no cloud
fallback, no billing/quota logic.** Network is required only for fetching (stock media,
source video, first-run model download).

Since the project is **open source and redistributed**, model licensing becomes a hard
filter rather than a preference: Apache-2.0/MIT are clean; Gemma and Llama carry
non-OSI-approved use restrictions; GPL/AGPL components are disqualifying for anything
bundled. This is now a selection criterion in all outstanding **[VERIFY]** research.

---

## 10. Research — done, with four items still open

**Model and license research is complete and lives in two documents:**

- **[`STACK.md`](STACK.md)** — ASR, matting, depth, TTS, beat detection, VAD, separation,
  ONNX execution providers, packaging. Licenses read from actual LICENSE files.
- **[`DIRECTOR.md`](DIRECTOR.md) §10** — the director LLM, runtime, schema design,
  constrained decoding, determinism.

Supersedes the **[VERIFY]** markers above. Headlines that changed decisions:

- **Both license leads confirmed**: RobustVideoMatting is GPL-3.0; madmom's *models* are
  CC-BY-NC-SA (its code is BSD-2, which is how it fools people).
- **Two landmines neither of us anticipated**: the default multilingual forced aligner is
  CC-BY-NC-4.0, and **espeak-ng is GPL-3.0** — sitting inside both Piper and Kokoro's
  fallback path.
- **No permissive, temporally-stable video matting model exists.** The stability pipeline
  has to be built (`STACK.md` §3).
- **Gemma 4 is Apache-2.0** — my earlier objection applied only to Gemma 1-3.
- A **~150MB base install** is achievable with everything heavy as a first-use download.

### Still open

1. **Stock media APIs** — commercial redistribution terms, rate limits, attribution for
   Pexels/Pixabay/Openverse. Not yet researched; needed before Phase 5.
2. **`yt-dlp --download-sections` reliability** across formats. Needed before Phase 3.
3. **Indic ASR word timestamps** — `indic-conformer-600m-multilingual`'s license and
   timestamp support are both unverified, and Parakeet covers no Indian languages.
4. **Qwen3.5-4B GGUF maturity** — prototype before committing (`DIRECTOR.md` §10.4).
