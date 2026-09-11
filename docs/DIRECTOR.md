# The Director — how an LLM can decide edits precisely

> Answers the question: *can the LLM be a director that decides the edits and cuts?*
> Short answer: **yes, and reliably — but only if it is never allowed to emit a number.**

---

## 1. The core principle

The usual attempt is to ask the model for timestamps:

```
"Return the best clip as {"start": "00:04:31.2", "end": "00:05:28.9"}"
```

This fails, and it fails in a way that looks like it's working — you get plausible
timestamps that are a second or two off, cut mid-word, drift over a long transcript, and
change between runs.

It fails because of what LLMs are bad at:

| Bad at | Good at |
|---|---|
| Precise numeric values | Choosing among enumerated options |
| Arithmetic on timecodes | Semantic judgment ("this is the punchline") |
| Pixel/spatial coordinates | Labeling and classifying spans |
| Consistency over long sequences | Relative ordering / comparison |

Every column on the left is what an edit needs. Every column on the right is also what an
edit needs. So split them:

> **Deterministic code generates a menu of legal options, each with an ID.
> The LLM picks from the menu. Deterministic code turns the IDs back into exact frames.**

The model says *"cut at `S47`"*, not *"cut at 04:31.2"*. `S47` is a sentence boundary your
ASR already located to the millisecond. You get frame-accurate output from a model that
cannot count frames.

This one rule is what makes the difference between a director that's a demo and one that
ships.

---

## 2. Five layers of an edit — and who owns each

Not all editing decisions belong to the LLM. Assigning them wrongly is the second big
failure mode.

| Layer | Decision | Owner | Why |
|---|---|---|---|
| **Structure** | what to keep, where to cut | **LLM**, picking sentence-boundary IDs | Semantic — needs meaning |
| **Emphasis** | which words matter, where the hook is | **LLM**, labeling word-index ranges | Its single strongest skill here |
| **Coverage** | what b-roll to show over which span | **LLM**, proposing search queries | Semantic association |
| **Rhythm** | when cuts land | **Deterministic** — beat grid + shot-length profile | Timing is math, not judgment |
| **Framing** | where the crop looks | **CV only** — face + active-speaker detection | The LLM cannot see the video |

Two of these deserve emphasis because they're where people go wrong:

**Rhythm is not an LLM decision.** Cut timing comes from the beat grid and a shot-length
profile. The LLM's contribution is picking a *style* — `punchy` / `steady` / `calm` — which
selects a profile. It never emits a cut time.

**Framing is not an LLM decision at all.** This is exactly the failure you already hit:
auto-reframe cropping to dead centre where no one is speaking. No amount of LLM
sophistication fixes that, because the model never saw the frame. It's a computer-vision
problem — face detection, active-speaker detection, and *temporal smoothing of the crop
path* — and it's why the NLE has to exist as a correction surface. More in §6.

---

## 3. Baseline + diff: the director must never be a dependency

A shipped product cannot have "the LLM was weird today" as a failure mode.

```
1. Rules produce a BASELINE edit          → always works, never fails
2. LLM proposes a DIFF (list of ops)      → may fail, may be nonsense
3. Validate every op                      → schema + semantic checks
4. Apply what validates, drop the rest    → partial success is fine
5. Record what the director changed       → user can revert per-decision
```

If the model times out, OOMs, or hallucinates an ID that doesn't exist, you still export a
working video — just a less clever one. The AI is an *enhancement layer over a working
deterministic system*, never load-bearing.

Step 5 matters as much as the rest: every director decision should be individually
revertable in the NLE, labelled with the reason the model gave. That turns an opaque AI
edit into something a user can audit and fix, which is the difference between "magic that
sometimes ruins my video" and "a fast first draft."

---

## 4. The Edit Decision Schema

Every field is an **ID reference or an enum**. No raw times, no coordinates, no frame
numbers.

```jsonc
{
  "clip_id": "c_01",
  "ops": [
    // Structure — refs are sentence-boundary IDs from the ASR pass
    { "op": "set_bounds", "start_ref": "S47", "end_ref": "S62",
      "reason": "self-contained answer, opens on a question" },

    { "op": "remove_span", "from_ref": "S51", "to_ref": "S52",
      "reason": "tangent about scheduling, breaks the thread" },

    // Emphasis — refs are word indices from the word-level timestamps
    { "op": "hook",      "word_from": 128, "word_to": 140 },
    { "op": "emphasize", "word_from": 203, "word_to": 207, "level": "high" },

    // Coverage — the query is free text (fine: it's a search string, not a number)
    { "op": "broll", "from_ref": "S55", "to_ref": "S57",
      "query": "city skyline at night timelapse",
      "reason": "he's describing the move to the city" },

    // Style — enums only; these select deterministic profiles
    { "op": "style", "rhythm": "punchy", "caption_style": "bold_pop" }
  ]
}
```

**Validation runs in two stages, and both are mandatory:**

1. **Schema validity** — guaranteed by constrained decoding (grammar / JSON-schema
   constrained sampling), so malformed JSON is impossible rather than merely unlikely.
2. **Semantic validity** — does `S47` exist? Is `S47` before `S62`? Is the resulting
   duration within the user's requested range? Is the removed span *inside* the bounds?
   Do the word indices fall within the chosen sentences? Constrained decoding guarantees
   *shape*, never *sense* — this second stage is not optional.

---

## 5. Multi-pass directing

Don't ask for the whole edit in one call. Small models degrade sharply as a task widens.
Four narrow passes beat one wide one, and each can be cached, retried, and evaluated
independently:

| Pass | Question | Context needed | Output |
|---|---|---|---|
| **1. Select** | which candidates are best? | ~8 candidate summaries | a ranking |
| **2. Refine** | exactly where does it start and end? | chosen window + neighbours | 2 boundary IDs |
| **3. Annotate** | what's the hook, what to emphasise, what b-roll? | just the chosen clip | emphasis + broll ops |
| **4. Style** | what treatment fits? | clip summary | 2 enums |

Pass 1 is **listwise ranking, not absolute scoring** — ask the model to order ~8 candidates,
not to score each 1-10. Relative judgment is far better calibrated in small models than
absolute judgment, and you sidestep the "everything is a 7" problem. Shuffle candidate
order between calls and merge rankings to cancel position bias.

---

## 6. Giving the director eyes — without a vision model

The director needs *some* awareness of the picture, but running a VLM per frame is off the
table at low compute. The answer: **don't feed it pixels, feed it CV output as text.**

```
Shot 12  [S47-S49]  close-up, 1 face (centre-left), low motion, speaker A
Shot 13  [S50-S53]  wide, 2 faces, high motion, scene change at S50
Shot 14  [S54-S58]  medium, 1 face (right), low motion, on-screen text detected
```

The model reasons over a structured description it can actually handle. This is cheap,
debuggable, and good enough for the decisions it's making ("don't put a caption over the
on-screen text in shot 14"). A VLM on a handful of keyframes is a reasonable v2 upgrade —
not v1.

---

## 7. Precision checklist

Everything that makes the output accurate, in one place:

1. **IDs, never numbers** — the model selects from a generated menu (§1)
2. **Constrained decoding** — schema-valid by construction
3. **Semantic validation** — IDs exist, ordering is sane, durations in range (§4)
4. **Snap to structure** — cut points snap to sentence boundaries → word boundaries → frame
   boundaries. A cut can never land mid-word, because mid-word isn't in the menu
5. **Persist decisions; don't rely on reproducible inference** — see §10.3. Model
   determinism does not survive a change of machine, backend, quantisation, or llama.cpp
   build, so "same project → same edit" must be a property of your *file format*, not of
   floating-point arithmetic
6. **Baseline fallback** — a failed director degrades to a working rules-based edit (§3)
7. **Human correction surface** — the NLE, with per-decision revert (§3, step 5)

---

## 8. Where the director will fail — plan for it

Be honest about the ceiling:

- **Humour and subtlety.** Small models reliably miss why something is funny.
- **Long-range narrative.** Callbacks, running jokes, arcs across an hour.
- **Anything visual.** It cannot see. §6 helps; it doesn't solve.
- **Emotional peaks** — and this one matters most for your target industry.

**On weddings and photography specifically:** the emotional peak of a wedding is almost
never in the transcript. It's in the *audio* (vows breaking, crying, cheering, the room
going quiet) and in the *image* (the kiss, the first dance, a parent's face). A
transcript-driven director is close to blind here.

So for that niche the signal hierarchy inverts — audio events and CV do the finding, and
the LLM's role shrinks to labelling and ordering what they surface. That's a genuinely
different pipeline from podcast clipping, which is why it belongs at Phase 6 and not
earlier. Worth knowing now so the architecture leaves room: **the director interface should
take a list of scored candidate moments from *any* source** — transcript features, audio
events, or CV — not assume they came from a transcript.

---

## 9. What this means for the build

- The director is **not** a phase of its own. It's a component that appears in Phase 3
  (clip mining) and is reused in Phases 4-6.
- Its input is a **candidate table**; its output is a **validated op list**. Both are plain
  data structures, so the director is testable with zero models in the loop — feed it a
  fixture candidate table, assert on the ops. **Write those tests before the model
  integration**, because they're what let you swap models later without fear.
- Because every op is a diff against a baseline, you can ship Phase 3 with **no LLM at all**
  (baseline only), then add the director as a strict improvement. That's the safest
  possible sequencing, and I'd recommend exactly it.

---

## 10. The verified stack (September 2026)

Research-backed. Confidence noted per item; the low-confidence items are prototype-first.

### 10.1 Model and runtime

| | Choice | Why |
|---|---|---|
| **Model** | **Qwen3.5-4B**, Apache-2.0, 262K context | Clean license for redistribution; 4B is the measured quality knee |
| **Quantisation** | Q4_K_M GGUF (~2.5 GB) | Q5_K_M if download size allows |
| **Runtime** | **llama.cpp** (MIT) as a `llama-server` sidecar | Not Ollama — see below |
| **Constrained decoding** | llama.cpp **GBNF**, flat schemas, validate-and-retry | In-process, zero compile cost |
| **Weights** | **Downloaded on first run, never bundled** | Installer stays ~80 MB, and you never redistribute weights |
| **Fallback** | Ministral 3 8B or Qwen3-4B-Instruct-2507 (both Apache-2.0) | If Qwen3.5 GGUF support is rough — see §10.4 |

**Why not Ollama:** it's an *application*, not a library. System-wide install, a daemon on a
fixed port, its own global model store. You would collide with users' existing installs and
inherit its versioning. Its convenience is exactly the part you must not depend on.

**Why 4B and not 2B.** Within the same family, same training, adjacent sizes:

| | Qwen3.5-2B | Qwen3.5-4B |
|---|---|---|
| **IFEval** (instruction-following — the closest proxy to "obey my schema") | 61.2 | **89.8** |
| MMLU-Pro | 55.3 | 79.1 |

A 28-point IFEval gap between adjacent sizes is enormous, and instruction-following *is* the
director's core competence. Independent classification benchmarks put the knee in the same
place (1.7B: 50% → 4B: 66% → 8B: 66% — note 8B is flat-to-negative). **4B is both the floor
and the ceiling worth paying for.**

The one exception: if you later fine-tune on your own edit decisions, small models gain the
most from tuning, and a well-tuned 1B can beat a prompted 8B. Revisit size *after* you have
the dataset (§ `PLAN.md`), never before.

### 10.2 Schema design — the rule that decides output quality

There's a published contradiction on whether constrained decoding hurts reasoning (one paper
finds 10-30% degradation; another finds a 3-4% *improvement*). It resolves cleanly: **the
damage comes from field order, not from constraint.** A schema of `{"answer": int}` forces
the model to commit on its first decoded token with no room to think.

> **Every schema gets a short `reasoning` field FIRST, then the structured verdict.**

Capped at ~60 tokens for latency. This single rule is worth more than the model choice.

Supporting rules, all from llama.cpp's documented weaknesses:

- **Flat objects only.** No `oneOf` / `allOf` / `$ref` / nested regex — exactly where GBNF
  over-constrains and silently narrows the model's options.
- **Enums over free strings** for every label. Grammar-enforced enums are the
  highest-value constraint available on a 4B model.
- **Descriptive field names.** Field names act as an instruction channel — prefer
  `segments_ranked_most_to_least_compelling` over `out`. Free steering, zero tokens.
- **Always validate after generation and retry once.** A grammar guarantees *syntax*, never
  *sense* — nothing in GBNF prevents the model returning a segment ID that doesn't exist.
  This is §4's second validation stage, and it is not optional.

### 10.3 Determinism — architectural consequence

Temperature 0 is necessary and **wildly insufficient**. The dominant cause of variance is
batch-dependent kernel numerics: matmul, RMSNorm and attention produce different results
depending on the batch an op ran in. Making just three kernels batch-invariant achieved 100%
bitwise reproducibility in published work — at a 34-62% throughput cost.

Settings that get you most of the way on a desktop: `temperature=0`, `top_k=1`, `top_p=1`,
fixed seed, **`n_parallel=1` (single slot)**, fixed batch sizes, pinned GGUF hash, pinned
llama.cpp build. Single-slot sidesteps batch variance entirely and costs a desktop app
nothing.

**But even then, determinism holds only for the same binary on the same hardware with the
same backend.** A project opened on an M3 will not necessarily reproduce an edit made on an
RTX 4070. A quantisation change breaks it. A llama.cpp upgrade breaks it.

**So don't build on it.** Persist the director's output — rankings, labels, reasoning — into
the project file as first-class data, stamped with model ID, quant hash and runtime build.
Re-run the model only when the user asks or the inputs actually change.

This is strictly better than reproducible inference: it survives version upgrades and
machine changes, it makes edits diffable and reviewable in the NLE, and it turns the
director's reasoning into something the user can read. Determinism becomes a debugging
convenience rather than a load-bearing guarantee.

### 10.4 Known risk — prototype this first

**Qwen3.5's GGUF maturity is the weakest link in this stack.** Its gated-DeltaNet hybrid
attention reportedly works but runs slower than expected and needs bleeding-edge llama.cpp;
the vision encoder also implies a separate `mmproj` file. A bleeding-edge operator
dependency inside a shipped desktop app is where 2am bug reports come from.

**Prototype the model integration before committing to it.** If it's rough, Ministral 3 8B
and Qwen3-4B-Instruct-2507 are Apache-2.0, architecturally conventional, and solid in GGUF
today. The director's interface is model-agnostic by design (§9), so this swap costs a
config change.

### 10.5 Listwise ranking — concrete parameters

- **8-10 candidates per call, hard cap.** Quality degrades past 10-15, and smaller models
  show *more* positional bias than large ones.
- **Sliding window with overlap, merged bottom-to-top** (the RankGPT pattern).
- **Opaque stable IDs** (`seg_a7f3`), never positional integers — denies the model a lazy
  "1,2,3" prior, and lets you *measure* position bias by re-running shuffled.
- **Aggregate 2-3 shuffled permutations** on the final top-N only. Full permutation
  self-consistency over every window is too slow for interactive use.
- **Pairwise tie-break** on the top 3-5, where the decision actually matters.

### 10.6 Performance note — you are prefill-bound, not generation-bound

Ranking and labelling emit tens of tokens over thousands of input tokens. Generation
throughput is nearly irrelevant; **prompt processing dominates.** On a CPU-only Windows
machine a ~3,000-token window may cost 10-30s of prefill.

Design for it: keep windows short, put the static system prompt and schema **first** so the
KV cache is reused across calls sharing that prefix, and show real progress on CPU-only
machines rather than appearing hung.

---

## 11. Revision — transitions, vision, and the combined decision

§2's five-layer table was too restrictive. Transitions are a creative decision and the
director should own them. The fix is not to abandon the ID principle — it's to split one
layer in two.

### 11.1 Rhythm splits into Timing and Treatment

| | Owner | What it decides |
|---|---|---|
| **Timing** | **Deterministic** — beat grid, onsets, scene detect | *Where a cut may legally land.* Produces a menu |
| **Treatment** | **LLM** | *Which* of those points to use, *what* transition, and whether this moment deserves one at all |

The beat grid does not decide the edit; it decides the **vocabulary** the edit is allowed to
speak in. The director picks from it:

```jsonc
{ "op": "transition", "at": "drop_64", "style": "whip_pan",   "reason": "bass drop, hero photo reveal" }
{ "op": "transition", "at": "down_52", "style": "cross_zoom", "reason": "section change, softer" }
{ "op": "cut",        "at": "beat_47" }
```

`drop_64` was located to the sample by audio analysis. The LLM never emits a time, so
precision is unchanged — but every creative choice is now the model's. This is the same
mechanism as §1, applied to a layer I had wrongly marked deterministic.

Framing stays CV-only, and you're right about the tools: **AutoFlip/PyAutoFlip** for speaker
tracking, **PySceneDetect or ffmpeg's native scene detect** for shot boundaries. Those feed
the event table below rather than the model.

### 11.2 The Event Table — the director's real input

This is the piece that makes "combined decisions" work, and it's the most important
addition to this document.

Every analyser writes into **one timeline-indexed table with stable opaque IDs**. Nothing is
modality-specific at the interface; the director sees one merged, sorted view:

```
id          kind        frame   detail
─────────────────────────────────────────────────────────────
shot_14     scene       3600    cut, medium shot
face_3      subject     3600    bbox track begins, subject A
w_1204      word        3612    "incredible"
beat_88     beat        3620    downbeat, 128 BPM
w_1208      word        3634    "moment"
drop_2      audio       3640    energy jump +14dB, section change
depth_3     depth       3640    subject A median depth 0.31 (front)
sil_22      silence     3700    620ms gap
```

Now a single op can reference several modalities at once, which is exactly what you were
describing:

```jsonc
{ "op": "caption_behind",
  "words": ["w_1204", "w_1208"],
  "subject": "face_3",
  "trigger": "beat_88",
  "reason": "emphasis word lands on the downbeat; subject is front-most so text sits behind" }
```

Word timing from ASR, occlusion from depth+matte, rhythm from the beat grid, placement from
CV — one decision, four analysers, still zero raw numbers. The event table is the contract;
everything else plugs into it.

**Two properties that matter:**

- **Extensible without touching the director.** A new analyser is new rows, not a new
  interface. When wedding-specific audio detection arrives (cheering, applause, vows), it
  emits `cheer_4` and the director can reference it immediately.
- **Testable with zero models.** Feed a fixture event table, assert on the ops. This is what
  lets you swap models later without fear (§9).

### 11.3 Photo → reel, concretely

1. **madmom** → beat grid, downbeats, section boundaries → `beat_*`, `down_*`, `drop_*`
2. **Demucs** (optional) → drum stem → sharper onsets for hit-level sync
3. **VLM pass over the photos** (§11.4) → hero shot, grouping, near-duplicates, suggested motion
4. **Director** → assigns photos to beat positions, picks transitions per position
5. **Deterministic** → converts to a timeline: clip per photo, Ken Burns, transition at exact frames

Step 4 is the only LLM call, and its whole output is IDs and enums.

### 11.4 The VLM on photos — agreed, with bounds

This is a good use of vision and I'd do it. The economics are completely different from
video: 20-40 photos, not 1,800 frames. Qwen3.5-4B carries a vision encoder, so it costs you
an `mmproj` file, not a second model.

**Ask it enumerated questions:** which image is the opening/hero shot · group these into
scenes · flag near-duplicates · which want a push-in vs a static hold · which direction
should the pan travel (subject sits left → pan from the right).

**Don't ask it for coordinates.** A 4B VLM will happily invent a bounding box. If you need
the subject's position, that's CV — and CV is better at it than any VLM.

### 11.5 Weddings and photography — where I think you're half right

You're right that x,y coordinates don't capture "is this a good wedding shot." But the fix
isn't to abandon CV — it's to use each tool for what it's actually for:

| Question | Tool |
|---|---|
| *Where* is the subject, how do I frame it? | CV — precise, cheap, per-frame |
| *When* did something happen? | Audio events — cheering, applause, crying, music swell, sudden quiet |
| *Is this shot any good?* | **VLM, on keyframes only** |

The affordability trick: run the VLM on **one keyframe per shot**, not per frame. PySceneDetect
on a 3-hour wedding gives you a few hundred shots — a few hundred VLM calls, batched, in the
background. That is completely tractable, and it's where "pixel understanding" actually
earns its cost.

And the ordering matters: **audio finds the moments, the VLM judges the shots, CV frames
them.** A wedding's emotional peak is in the room's sound long before it's in anything a
transcript or a bounding box can tell you.

### 11.6 Your chunking proposal — the second version is the right one

You offered two. They aren't equivalent.

**Option A** — slice by user duration with ±30s overlap, send with timestamps, LLM rates each
window, Python summarises afterwards.

**Option B** — summarise each candidate, assign IDs, ask the LLM to pick the best IDs subject
to the duration constraint.

**Option B is correct, and it's the same thing as listwise ranking (§10.5) — you arrived at
it independently.** Its advantage over A is exactly the calibration problem: rating windows
one at a time asks the model for an absolute score, which small models are bad at. Picking
best-of-N asks for a comparison, which they're good at.

Two refinements to combine the best of both:

1. **Keep your overlap — but for context, not for precision.** ±30s of surrounding transcript
   stops the model judging a window blind to what preceded it. It is *not* what prevents
   mid-word cuts — **sentence-boundary snapping** does that, and it does it exactly (§1). Use
   overlap for judgment quality, boundary snapping for frame accuracy. They solve different
   problems and you want both.
2. **Summarise deterministically where you can.** The summary that feeds ranking needs to be
   cheap and uniform. First sentence + last sentence + the cheap feature scores (energy
   variance, speech-rate change, question→answer, clean-open/clean-close) is often a *better*
   ranking input than an LLM-written summary, and it costs nothing. Reach for an LLM summary
   only where those features can't separate candidates.

So the final shape: your overlapping windows → deterministic feature scoring → top ~30 →
LLM-generated summaries only for those → listwise ranking 8-10 at a time with opaque IDs →
your duration constraint applied as a hard filter, not a prompt instruction.

Genre labelling fits naturally in the same call as the ranking — one extra enum field, no
extra pass.
