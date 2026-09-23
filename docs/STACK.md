# The model stack — verified September 2026

> Licenses below marked ✓ were read from the actual LICENSE file or official model card.
> Anything marked ⚠️ UNVERIFIED is a to-do, not a finding — do not ship on it.
>
> Context: this product is **open source and redistributed**, so a non-commercial or
> copyleft license on a bundled component is disqualifying, not a footnote.

---

## 0. Decisions taken

These override the recommendations below. Recorded here so the reasoning is visible and the
choice is reversible.

| Component | Chosen | Instead of | Consequence |
|---|---|---|---|
| **Matting** | **RobustVideoMatting** (GPL-3.0) | BiRefNet + SAM2 pipeline | **Forge's own license becomes GPL-3.0.** In exchange you get native temporal stability and skip open risk #3 entirely |
| **Depth** | **DepthAnything V2 Base/Large** (CC-BY-NC-4.0) | DAv2-Small (Apache-2.0) | Non-commercial: fine while Forge is free, must be swapped if it is ever sold |
| **Beat tracking** | **madmom** (models CC-BY-NC-SA 4.0) | Beat This! (MIT) | Same NC constraint. Also share-alike on derivatives |
| **Separation** | **Demucs** kept (MIT) | — | No constraint; clean |
| **TTS** | **Kokoro-82M** (Apache-2.0) | — | Clean, but still needs the espeak-ng fix (§1.2) |
| **ASR** | **Parakeet-TDT + Whisper**, two-tier | — | Confirmed best available (§2) |

**Why this is a reasonable trade:** choosing RVM removes the single largest piece of
unproven engineering in the whole project — the hand-built temporal-stability pipeline in §3
that does not exist off the shelf. That is real, immediate delivery risk traded for a
license constraint that only matters under conditions that do not yet apply.

**Engineering requirement that keeps it reversible:** every one of these sits behind a
single adapter interface in the sidecar (`matting`, `depth`, `beats`), selected by config.
Swapping RVM → BiRefNet, or madmom → Beat This!, must never be more than a config change
plus one adapter implementation. The permissive alternatives stay documented below as the
fallback tier precisely so that swap stays cheap.

---

## 1. The two landmines

These are the findings worth the whole research pass. Both are invisible until you read
transitive licenses, and both sit on the default happy path.

### 1.1 The multilingual forced aligner is non-commercial

`MahmoudAshraf/mms-300m-1130-forced-aligner` — the MMS-based aligner that WhisperX-style
pipelines reach for by default — is **CC-BY-NC-4.0** ✓.

This is nasty because WhisperX itself is BSD-2 ✓ and perfectly usable. The *weights* it
pulls for alignment are what poison it, and nothing in the code warns you. Forced alignment
is also the highest-accuracy word-timestamp path (±20-50ms), so it's exactly the thing
you'd reach for when caption timing looks sloppy.

**Route around it:** use ASR with native word timestamps (§2), or pair Whisper with a
permissively-licensed CTC aligner such as `facebook/wav2vec2-base-960h` (⚠️ Apache-2.0 per
HF, unverified this pass).

### 1.2 espeak-ng is GPL-3.0 — and it's inside your TTS

**espeak-ng is GPL-3.0-or-later** ✓. It is the grapheme-to-phoneme engine behind **Piper**
and behind **Kokoro's out-of-dictionary fallback**.

Piper's current repo is literally named **`piper1-gpl`** and is GPL-3.0 *because* it embeds
espeak-ng ✓. Bundle it and your entire application inherits GPL-3.0.

This is the single most likely thing to bite you, because Kokoro's model card says
Apache-2.0 and that's true — the trap is one dependency down, on a code path that only
triggers on unusual words.

**Fixes:** **OpenPhonemizer** (permissive, designed as a drop-in espeak replacement) or
`piper-without-espeak` (MIT, English only). **Budget real engineering time for this** — it's
the least glamorous and most likely-to-bite item in the stack.

---

## 2. ASR — two tiers, because of Indic

Three mechanisms produce word timings and they are *not* equivalent:

| Mechanism | Accuracy | Notes |
|---|---|---|
| Cross-attention DTW (whisper.cpp `--dtw`, faster-whisper) | ±100-300ms, drifts | Fine for transcript-driven editing; **not** for caption pop-on |
| CTC forced alignment (WhisperX) | ±20-50ms | Best — but the default multilingual aligner is NC (§1.1) |
| **Native transducer durations (Parakeet TDT)** | **±20-40ms, no second model** | Timing is a first-class decoder output, not a reconstruction |

**Tier 1 — European languages: `nvidia/parakeet-tdt-0.6b-v3`** (CC-BY-4.0 ✓, attribution
only) via **`onnx-asr`** (MIT ✓). Documents word- *and* character-level timestamps natively.
600M params, ~6.3% mean WER. `onnx-asr` covers CPU/CUDA/CoreML/DirectML and loads quantized
variants — **this is the PyTorch-free path, and the main reason to prefer Parakeet.**
Pre-exported weights: `istupakov/parakeet-tdt-0.6b-v3-onnx`. Needs ORT ≥ 1.25.

**Tier 2 — everything else, including Indic: Whisper** (`large-v3-turbo` or `small`, MIT)
via whisper.cpp or faster-whisper, DTW timestamps.

> **Parakeet v3 has zero Indian languages** ✓ — 25 European languages only. Given Indic
> support is in your requirements, Tier 2 is not optional.

**Indic-specific:** `ai4bharat/indic-conformer-600m-multilingual`, all 22 scheduled Indian
languages, MIT claimed ⚠️ UNVERIFIED — and **word-timestamp support unconfirmed**. Verify
both before committing; this is open risk #4.

**Caption-timing floor:** timing quality comes from the *alignment mechanism*, not model
size. Whisper `base` already gives acceptable DTW timing; its *text* is what you'd retype.
So **Whisper `small` (244M, ~180MB int8)** is the practical floor, and if timing needs to be
better, add a small CTC aligner rather than a bigger ASR.

**Do not ship NeMo.** Apache-2.0, but it drags in all of PyTorch — `onnx-asr` exists
precisely to avoid that.

---

## 3. Matting — nothing off the shelf works, so build the pipeline

| Model | Quality | Temporally stable? | License | |
|---|---|---|---|---|
| RobustVideoMatting | very good | **native** | **GPL-3.0** ✓ | ❌ |
| MatAnyone | excellent | **native** | **NTU S-Lab, non-commercial** ✓ | ❌ |
| RMBG-2.0 (BRIA) | excellent | no | **CC-BY-NC-4.0** ✓ | ❌ |
| **BiRefNet** | **best available** | **no — flickers** | **MIT** ✓ | ✅ |
| **MODNet** | mediocre on hair | weak | **Apache-2.0** (code + models) ✓ | ✅ fallback |
| **SAM 2.1** | binary mask, no alpha | **native memory bank** | **Apache-2.0** ✓ | ✅ as a *prior* |

> **There is no permissive, temporally-stable, high-quality video matting model in 2026.**
> Every model that solves flicker natively is license-blocked. You have to build stability
> yourself.

A correction to what I said earlier: BiRefNet's license *is* uniformly MIT ✓. The real
caveat is **training-data provenance** — the `-matting` and `-portrait` checkpoints are
trained on P3M-10k, Distinctions-646, AIM-500 and AM-2k, several of which are
research-only datasets. MIT weights, research-only data. **Use the general/HR checkpoints**
instead: slightly worse on hair, cleaner legally.

### The temporal-stability pipeline

This does not exist off the shelf. It is open engineering risk #3.

1. **Fix input resolution** — always 1024² letterboxed, never dynamic. Resolution jitter is
   itself a flicker source, *and* CoreML degrades on dynamic shapes (§7).
2. **Separate semantic core from boundary band.** Run **SAM 2.1** once with a click/box
   prompt; its memory bank propagates a *stable binary identity* across the clip. Erode and
   dilate that into a trimap.
3. **Run BiRefNet only on the boundary band.** It owns hair and edges and never gets to
   change its mind about the torso. Most perceived flicker is core-region flapping, not edge
   noise — this step alone kills roughly 80% of it.
4. **Motion-compensated temporal filter.** Warp α(t−1) into frame t with cheap optical flow
   (OpenCV DIS, BSD), then blend `α_t = w·α_t + (1−w)·warp(α_{t−1})`, raising `w` where flow
   confidence is low. **Naive EMA without warping smears moving hair** — the most common
   mistake here.
5. **Guided filter on alpha, RGB frame as guide.** Snaps the matte to real image edges so
   the boundary lands in the same place on consecutive frames. Cheap; removes shimmer.
6. **Hysteresis, not thresholding.** Separate on/off thresholds stop per-pixel popping at
   the fringe.

**CPU 1080p matting is not interactive.** Preview with MODNet at low resolution; bake final
with BiRefNet. This is the §2 of `research/architecture-plan-2026-09-11.md` "three speeds" split, made concrete.

---

## 4. Depth — the cheapest thing in the stack, if you frame it right

| Model | License | |
|---|---|---|
| **Depth Anything V2 Small** | **apache-2.0** ✓ | ✅ **this one** |
| Depth Anything V2 Base / Large | **CC-BY-NC-4.0** ✓ | ❌ |
| Apple Depth Pro | Apple proprietary, non-OSI ✓ | ❌ also ~1.9GB |

The NC/permissive split runs *within* the same model family — Small is Apache-2.0, Base and
Large are not. Easy to get wrong.

**The insight that makes this nearly free:** you need occlusion *ordering*, not a depth map.
So reduce the map to **one scalar per subject per frame** — the median depth inside the matte
— and apply hysteresis to that scalar. Ordering flicker collapses from a 2-million-pixel
problem to a 1-D problem with two subjects.

You can also compute depth at **quarter frame rate and interpolate** — ordering doesn't
change at 30Hz.

**Minimum viable: DAv2-Small, int8 ONNX ~25MB, at 256×256** (multiple of 14 for the ViT
patch grid). That's genuinely all this feature needs.

---

## 5. TTS

| | Model | License | Indic | ONNX | |
|---|---|---|---|---|---|
| **1** | **Kokoro-82M** | **Apache-2.0** ✓ | Hindi (9 langs, 54 voices) | ✅ ~80-92MB quantized | ✅ default — ⚠️ espeak-ng fallback (§1.2) |
| **2** | **Chatterbox** (Resemble) | **MIT** ✓ | Hindi, 23+ langs | no official export | ✅ best multilingual; Nano 110M runs 3× realtime on 8 CPU cores. Note built-in watermarking |
| **3** | **IndicF5** (AI4Bharat) | MIT ⚠️ | **11 Indian languages** | no | ⚠️ optional download; needs reference audio + transcript |
| **4** | Piper **voices** | voices mostly MIT/CC-BY ⚠️; runtime **GPL-3.0** ✓ | some | ✅ voices are ONNX | ⚠️ use the ONNX voice files with your *own* phonemizer. **Never bundle `piper1-gpl`** |
| — | **XTTS-v2 / Coqui** | **CPML, non-commercial** ✓ | — | — | ❌ **hard no.** Coqui shut down Jan 2024 — *no one exists to sell you a commercial license.* Unfixable |
| — | F5-TTS | weights CC-BY-NC-4.0 suspected ⚠️ | — | — | ⚠️ assume no until verified |
| — | Orpheus | Apache-2.0 ⚠️ | — | — | ❌ 3B — too heavy for local CPU |

The XTTS entry is worth dwelling on: it's the standard recommendation in most tutorials, and
it is permanently unusable for a commercial product because the licensor no longer exists.

---

## 6. Beat detection, VAD, separation

**Beat tracking — drop madmom.** Its LICENSE is *dual*: BSD-2 for code, **CC-BY-NC-SA 4.0
for the model files** ✓, with commercial use requiring written permission. madmom without
its models is an empty box. Shipping it commercially is among the most common license
violations in music software.

**Replacement: Beat This! (CPJKU, ISMIR 2024) — MIT for code *and* published weights** ✓.
Same lab as madmom, released properly. `small` checkpoints are **~8.1MB**. Runs on CPU. **No
documented ONNX export** — you'll do that yourself (open risk #2); it's a conv+transformer
stack that should trace cleanly, but treat it as unverified work.

**Millisecond-accurate beat grid** = Beat This! for *metrical structure* (~20ms hop) → **snap
each beat to the nearest spectral-flux onset peak within ±50ms**. The neural model gives you
the grid; the onset function gives you the sample-accurate transient. Neither alone suffices.
librosa's `beat_track` is DP tempo-locked and not accurate on variable tempo — use librosa
for onsets, not for the grid.

**VAD: Silero VAD, MIT** ✓, ships as a **~2MB ONNX**, ~1ms per 30ms chunk. No contest.
WebRTC VAD is energy/GMM-based and fires constantly on music — unusable for ducking music
under speech, which is your exact use case.

**Separation — my earlier conclusion confirmed, with one amendment.** Ducking → VAD (and in
an NLE the music is already a separate track, so you duck with a sidechain envelope driven
by VAD probability). Beat detection → onset detection (separating first typically *hurts*,
via artifacts).

**The amendment I got wrong:** separation has a real non-stems use — **running ASR on a
vocals-isolated stem materially improves WER on footage with loud music over dialogue.**
Worth exposing as "clean up dialogue before transcribing," not only as a stems feature.

Demucs is **MIT** ✓ (it was CC-BY-NC in earlier eras; current LICENSE is clean). ONNX exports
exist. Cost: **~36s for a 3-minute track on M4 Pro CPU** via ONNX; `htdemucs_ft` is a bag of
4 models, so ~4× that. **Opt-in, on-demand download, never on the import path** — 36s on a
fast Mac is 2-4 minutes on a mid Windows laptop.

---

## 7. ONNX Runtime execution providers

**CoreML (Apple Silicon)** — all ✓ from official ORT docs:

- **Partitioning is the failure mode.** Unsupported ops split the graph and those partitions
  fall back to CPU; many small partitions is *slower than pure CPU*.
- Use **`ModelFormat: MLProgram`** (CoreML 5+). `NeuralNetwork` is legacy.
- **`RequireStaticInputShapes=1`** — dynamic shapes "may negatively impact performance."
  Fix every input resolution. Biggest single practical lever, and it aligns with the matting
  pipeline's fixed-1024² rule.
- **`ModelCacheDirectory` is mandatory.** Without it, "CoreML EP will compile and save to
  disk every time," costing "even minutes for a complicated model." For BiRefNet this is the
  difference between a usable and a broken first run.
- You **cannot** promise Neural Engine execution — `MLComputeUnits` "does not guarantee the
  entire model to be executed using ANE."
- Conv-heavy models (MODNet, Silero, Kokoro) map well. ViT/Swin (DAv2, BiRefNet) partially
  fall back — **measure per model.** ORT's CPU EP on M-series is strong via Accelerate/NEON;
  CoreML has to earn its place.

**Windows:** **DirectML is in "sustained engineering"** — not deprecated, but receiving no
new op work, with Microsoft steering toward Windows ML and on-demand EP packs (⚠️ formal
status unverified). **Do not make DirectML your only GPU story.** CUDA EP is reliable but
~1-2GB with cuDNN — optional download only.

---

## 8. Packaging — a ~150MB base install is achievable

| | Base installer | On-demand download |
|---|---|---|
| **macOS arm64** | ORT CPU + CoreML (in-box, no extra payload) | — |
| **Windows x64** | ORT CPU only | DirectML pack; CUDA pack (~1-2GB) |
| **Models** | Silero VAD 2MB + Beat This! small 8MB + DAv2-S int8 25MB + Kokoro q8 ~92MB + MODNet ≈ **~130MB** | Parakeet/Whisper (~600MB), BiRefNet (~900MB), Demucs (80-320MB), Chatterbox, IndicF5 |

Combined with never bundling LLM weights (`DIRECTOR.md` §10.1), the installer stays small
and everything heavy is a first-use fetch. That's the right shape for this product.

---

## 9. License verdict — disqualified

| Component | License | |
|---|---|---|
| RobustVideoMatting | **GPL-3.0** ✓ | ❌ |
| MatAnyone | **NTU S-Lab 1.0**, non-commercial ✓ | ❌ |
| RMBG-1.4 / 2.0 (BRIA) | **CC-BY-NC-4.0** ✓ | ❌ |
| madmom **models** | **CC-BY-NC-SA 4.0** ✓ | ❌ |
| MMS forced aligner | **CC-BY-NC-4.0** ✓ | ❌ |
| XTTS-v2 / Coqui weights | **CPML**, licensor defunct ✓ | ❌ unfixable |
| espeak-ng / `piper1-gpl` | **GPL-3.0** ✓ | ❌ as bundled |
| Depth Anything V2 Base/Large | **CC-BY-NC-4.0** ✓ | ❌ |
| Apple Depth Pro | Apple proprietary, non-OSI ✓ | ⚠️ avoid |
| F5-TTS weights | CC-BY-NC-4.0 suspected ⚠️ | ⚠️ verify first |

**Clean and confirmed:** BiRefNet (MIT ✓), MODNet (Apache-2.0 ✓), SAM 2.1 (Apache-2.0 ✓),
DAv2-Small (Apache-2.0 ✓), Parakeet-TDT-v3 (CC-BY-4.0 ✓ — add a NOTICE), onnx-asr (MIT ✓),
WhisperX code (BSD-2 ✓), Beat This! (MIT ✓), Silero VAD (MIT ✓), Demucs (MIT ✓), Kokoro
(Apache-2.0 ✓), Chatterbox (MIT ✓).

---

## 10. Open engineering risks, in order

1. **Replace espeak-ng with a permissive phonemizer.** Unglamorous, on the critical path,
   and it gates whether your TTS is shippable at all.
2. **ONNX-export Beat This! yourself.** No published export.
3. **Build the SAM2 + BiRefNet + flow-warped temporal matting pipeline.** Does not exist off
   the shelf; §3 is the design, not a library call.
4. **Confirm Indic ASR word-timestamp support.** IndicConformer's license and timestamp
   capability are both unverified, and Parakeet covers no Indian languages.

Plus, from `DIRECTOR.md` §10.4: **prototype Qwen3.5-4B's GGUF support early** — bleeding-edge
operator support is a bad dependency in a shipped desktop app.
