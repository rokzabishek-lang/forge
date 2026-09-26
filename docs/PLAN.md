# Phase C — from a slideshow to a commercial: the plan

> **Status, 2026-09-23.** Phases A and B of `docs/FIX.md` are complete
> (`b8173de`); the editor is done. This file is the working plan for Phase C,
> the ad-maker, **with Phase D (the dressing) inside it**. `FIX.md` §C holds
> the agreed summary and the reasoning; this holds the steps — files, schemas,
> rules, tests, render checks, mutation targets and an exit bar per step —
> precise enough to start from cold on either machine. Nothing in C0–C5 is
> built yet. Measurements land in `docs/EVAL.md` as they are made.
>
> Reviewed adversarially before it was committed (workflow `wf_1c709575-eaa`:
> five lenses — code reality, the two ffmpegs, workability, what a small model
> can do, taste — and a refuter per finding; 36 confirmed, folded in). The
> old architecture plan that used to live at this path is
> `docs/research/architecture-plan-2026-09-11.md`.

---

## 0. The goal, and what "reliable" means here

The user's brief: ads that read like Apple, Nike and Puma spots and like film
trailers — not slideshows — from a handful of photos, a clip and a song, that
**someone can rely on**. Reliable is not "sometimes brilliant"; it is *never
embarrassing, always on the beat, always a playable file*, and better than the
standard cut whenever the model has anything to add.

Three bars, each measured, each in `docs/EVAL.md`:

| bar | measured how | pass |
|---|---|---|
| **the plan is used** | ten fixed briefs × one local configuration | a non-rejected plan on ≥ 8 of 10, copy rated ≥ 3/5 blind by the user (C0's bar, from `LLM.md`) |
| **it beats the standard cut** | the user rates each recipe ad against the standard cut, blind | the recipe ad is preferred on ≥ 8 of 10 |
| **it reads as directed, not automatic** | the user rates each recipe ad beside a real reference spot of the same kind; when an ad "looks automatic" the rater records **why**, from a fixed list (`hero` · `hold` · `every-cut` · `rhythm` · `type` · `sound` · `copy` · `other`) plus a line | **zero** ads flagged for a *placement* reason (`hero`, `hold`, `every-cut`). No numeric bar against the reference: a handful of phone photos will not match a produced spot's production values, and pretending otherwise would measure the wrong thing. The reasons are what the tuning loop reads |
| **it never falls over** | every degraded mode in §9 rendered | every one produces a playable ad that still follows its recipe |

**The principle every step below follows — the model chooses, code composes.**
A 2–4B local model can be trusted to choose from a closed list, say what is in
a photo it is shown, mark the hero among photos it has seen, pick a style, and
— unmeasured until C0 — write six words. It cannot be trusted to time anything,
to shape a pacing curve over twelve shots, to rate one photo on an absolute
scale that means the same thing for the next, or to keep twelve individually
legal choices from compounding into something garish. So:

- **the model** picks the recipe, casts the photos into roles, marks the hero,
  says how much each shot matters, picks a move per shot and one type style
  for the ad from shortlists, writes the headline and the punch word;
- **code** owns every number — cut frames, hold lengths, the pacing curve, the
  black, the end card's dwell, where the two or three moments and the one
  treatment go, where every sound fires, the one grade — through **directing
  recipes**, deterministic grammars for a kind of ad.

A bad answer still lands on the beat, inside the rules, with the worst photo
never the hero. That is what makes the output something a marketer can rely
on, and it is also why the *baseline* ad (no model at all) gets better with
every recipe: the recipe directs even when nobody is choosing.

**The user's corrections, kept:** the **VLM is the Director's eyes** — an ad
uses few photos, so they are shown to it; **Florence-2 is for caption
placement**, a different job, and is not part of this; **the objective checks
are small vision beside the VLM** — sharpness, exposure, duplicates — and where
they disagree with the VLM on what they measure, the measurement wins.

---

## 1. What exists — the rails this is built on

Read before changing anything; every file here is tested and most are
render-checked.

| piece | where | what it gives C |
|---|---|---|
| the menu | `src/shared/director/menu.ts` — `buildSlots` (user order, `size>0`), `buildCutMenu` (beat grid + drops/sections/lyric cuts from `planCuts`, ≤ `MAX_CANDIDATES` 24, deduped at `MIN_SEGMENT_SECONDS` 0.4), `familyMenu` (installed families only) | the vocabulary of legal cuts — the rhythm engine's raw material |
| the plan | `schema.ts` — `spine@1`: `reasoning` first, `pace`, ≤ 12 segments of `{slot, role, ends_at, enter, headline, punch_word, why}`, per-request enums | the shape to grow into `spine@2` |
| the checker | `conforms.ts` (flat JSON Schema only — no `oneOf`, no conditionals), `validate.ts` (repair vs reject rows, `SegmentLayout`, `headlineCapacity` = 16 cps, `TRANSITION_SHARE` 0.6) | the two-stage validation to keep |
| apply | `apply.ts` — one `update()`, shots + cards + anchored transitions + music trim/duck, `clearDirector`, `decisionFor` → `DecisionRecord`; reads `plan.segments` at four sites and pairs each `Slot` with the clip it mints in its `shots` array | the single-undo, single-transaction shape every new pass must keep |
| the standard cut | `baseline.ts` — `baselineSpine`, `paceFor(tone)` (a tone → pace table) | always validates; becomes the recipe's default casting, with the recipe chosen the way `paceFor` chooses the pace |
| the prompt | `prompt.ts` — `PLAYBOOK` (system, cacheable), tables (user), `maxTokensFor` (~95 tokens a segment, calibrated on `spine@1`'s seven fields) | the first playbook to tune; the constant to re-measure |
| providers | `provider.ts` (pure), `src/main/director.ts` (Ollama `format`, OpenAI `json_schema strict`, `encodeImages` 640 px JPEG with EXIF rotate), `ipc.ts` `director:complete` forwards `images` | images are plumbed end to end and **never sent** (`store.ts` `direct()` sets none) |
| the runner | `store.ts` `direct()` — clear → menu → ask (think off, then on if prose) → validate → baseline on reject → apply → decision → card bakes | the loop the eval drives and C2 rewrites around the recipe; its think-off/think-on retry becomes a shared helper |
| facts | sidecar `audio.beats` (librosa: beats, downbeats, energy tiers 0–3, drops, build-ups, sections), `asr.transcribe` (word timings), `depth.layers` (planes + subject box, stills), `audio.stems`, `voice.speak`; `automation/lyrics.ts` (cut on the sung syllable) | the two clocks — beat grid and words |
| the toolkit the Director cannot reach yet | 42 text styles (`render/textStyle.ts`), 9 animations (`textAnimation.ts`: fade rise pop typewriter bounce wave zoom-out slide drop), 7 looks (`looks.ts`: warm-film golden-hour teal-orange cool-cine faded bleach-bypass noir), 9 transition families + 412 wipes, 12 moves + shake + parallax (`render/motion.ts`, `edit/camera.ts`), speed 0.1–8× (`speed.ts`), masks, key, Steady, adjustment layers, colour cards (`Clip.solid`), titles, the single-slot treatments (grid `render/grid.ts`, strips `strips.ts`, clippings `paper.ts`, one-photo framing `automation/onePhoto.ts`), the ring | everything C2 puts on the menu — and the registries the recipe tests read ids from |
| self-drawing kinds | `edit/recipes.ts` `drawsItself(clip)`; the same guard spelled out in `store.ts` (`setAspect`'s crop clear, `rebakeGenerated`'s targets), `render/chromaKey.ts` `isKeyable`, `render/steady.ts` `canSteady`, `edit/camera.ts` `canMoveCamera`; and `edit/clipKind.ts` `clipKind()`, which sorts the same fields into the timeline's colour legend | every new self-drawing clip kind must join **all seven** — the `clippings` omission once caused three bugs (`store.ts` says so above `rebakeGenerated`) |
| the bake rails | `src/renderer/src/carouselCanvas.ts` — ONE shared `WebGLRenderer`, three.js loaded on first use, draw at `t`, `writeTitleFrame(clipId, frame, png)` → numbered PNGs, `tpad` holds the last; `render/exportBake.ts` re-draws every generated clip at the EXPORT's shape into `<clip>-export` | C4 rides exactly this |
| cheap file keys | `src/main/stems.ts` `keyFor(path, size, mtimeMs)`, `src/main/transitions/maskTags.ts` (`size:mtime`) | the key the look cache uses. (The parallax bake keys differently — a full-content SHA1 on disk in `depth.py`, and nothing at all in the project map — so it is not the precedent) |
| measured, not built | speed ramp as one `setpts` with `log` (`EFFECTS.md` §18: predicted 3.697 s, got 3.70 s; frames 25/42/54 vs 25/43/54); `holdFilter` in `plan.ts` (`tpad=stop_mode=clone,trim,setpts`) holds a short PNG run to a clip's END — it has never held a middle frame and resumed | C2's ramp and freeze, each with the shape those facts allow |
| the eval seat | `tests/directorMain.test.ts` drives `main/director.ts` against a fake fetch with `setSettings` on a temporary file; `tests/integration/output.ts` renders into `tests/output/<check>/` and measures loudness with `meanVolumeDb(file, fromSeconds, seconds)` — a start and a window LENGTH (ffmpeg's `-t`), `volumedetect` over that span, returning `mean_volume` only — the A3 mix check's oracle | C0's harness reuses both; every audio render check below uses `meanVolumeDb` windows, because that is the oracle that exists and is proven. §6.4's peak check needs a sibling, `maxVolumeDb`, parsing `max_volume` from the same `volumedetect` output — a few lines, written with C3 |
| the UI without Electron | `npm run harness` (:5199, `src/renderer/src/harness/bridge.ts` stubs `window.forge`; `directorComplete` is a stub) | where every panel change is clicked before it ships |

Two facts that bound the design:

- **Two ffmpegs.** Every filter C emits is listed in §8 with its merge year
  against the Windows floor (2018-12-17) and whether it has run in CI yet;
  `tests/oldestFfmpeg.test.ts`'s blocklist gets each new shape. Anything
  three.js draws is a PNG overlay and does not touch the floor.
- **The sandbox cannot reach localhost**, so no model has ever been run
  against the Director. C0 is written here and **run by the user**; every
  later step re-runs it.

---

## 2. The order, and why

| step | what | days | needs | proves |
|---|---|---|---|---|
| **C0** | measure the Director as it is; measure the VLM on the fixture photos | 1–2 + the user's runs | a machine with Ollama or LM Studio | whether the architecture holds on a real local model; whether the eyes see |
| **C1** | eyes: the look pass, the objective checks, the quality gate | 3–4 | C0's VLM answer | the hero is never the worst photo; copy is about what is there |
| **C2** | recipes, `spine@2`, the rhythm engine, coherence, one treatment; ramp, freeze, black, end card, J/L | 5–6 (itemised in §5.8) | the menu (exists); C1 for face/hero holds (degrades without it) | the slideshow tell is gone: hierarchy, shape, a designed ending |
| **C3** | sound design: events fired by the recipe; the pack | 2–3 | C2's events; the pack decision | sound drives the picture |
| **C4** | the moments engine on three.js: four moments, baked on the ring's rails | 5–7 | C2 places them; independent to build | two or three designed moments an ad, preview = export |
| **C5** | evaluate and tune; degraded modes; per-language capacity | ongoing | everything | the four bars in §0 |

**C0 first, always.** Until the eval exists no change to the prompt can be
called an improvement (`LLM.md`). **C2 before C3 and C4** because both fire
on the recipe's events. **C1 and C2 can overlap**: the recipe paces by order
until the looks arrive, then by shot type. **C4 can be built while C2 is
under test** — its engine is independent; only its placement is the recipe's.
Total ~16–22 days plus the ongoing eval, as `FIX.md` estimates.

Every step ends the same way: typecheck green, the full suite green (written
to a file, `$?` checked — `CLAUDE.md`), the render check's output in
`tests/output/<check>/` looked at, the mutations listed killed, CI read at
github.com/spyki-a/forge/actions, the eval re-run when a model is at hand.

---

## 3. C0 — Measure the Director as it is · 1–2 days + the user's runs

**Question.** Does one local configuration produce a usable plan on eight of
ten briefs with copy the user rates ≥ 3? Before that: does Ollama's `format`
hold with `think: false` on this version (ollama/ollama #15260, #14645), or
does every first answer come back as prose? And — because C1 depends on it —
does the VLM describe the fixture photos correctly, how long does a full look
pass take, and what do images cost in memory on the Surface?

**No fine-tuning.** "Tuning" is the prompt, the menu and the parameters.

> **Built 2026-09-23, and run once** — `tests/eval/` (the pipeline, the relay,
> the fixtures' media), `tests/fixtures/director/*.json`, `scripts/eval-rate.mjs`
> and `eval-report.mjs`, `shared/director/run.ts` (the part of `direct()` the
> eval shares with the app), tests `evalHarness`, `directorRun` and the render
> check `integration/evalPipeline`. First result: `docs/EVAL.md`; findings
> `eval/findings.md`. As built, a brief is ONE file and its media are made by
> default — below.

### 3.1 Fixtures — `tests/fixtures/director/`

Ten briefs, one JSON file each: the brief `{product, benefit, audience, tone,
cta, seconds, language}`, the music's shape `{bpm, seconds, buildFrom,
dropAt}`, 5–7 stills and usually one clip under 8 s, each with the user's
note and its ground truth, and the photo the user would make the hero. Six
English, two Telugu, two Hindi. Mix by design: two wedding films and a wedding
studio's ad (the niche), three product sets, two events, one fashion, one food;
one set (`event-fest`) has camera file names and no notes at all — the case
eyes matter most for.

**The media are made, not committed**: a colour card per photo, a test-pattern
clip per video, a beat bed with a build and a drop per song (`tests/eval/
media.ts`). The spine reads each slot's NAME, note and speech — never its
pixels — so to the spine a card named `05_first_look.jpg` with the note
"first look, she's crying" is that photograph, and its colour tells a render
check which slot is on screen. Real photos of the same names in
`FORGE_EVAL_MEDIA/<brief>/` replace the cards, and are what the VLM half needs.

> **Built 2026-09-26 — the real run.** `FORGE_REAL=<folder> npm run eval:real`
> (`tests/eval/real.eval.test.ts`) takes the user's own pictures, one song and
> a `brief.json` through the whole Director — the measurements and the beats
> from the sidecar, one look request a picture, the gate, the spine, the rhythm
> engine — with the headline cards drawn by the app's own type renderer in the
> harness (`window.__forgeEvalCards`) and both ads rendered at 1080×1920, and
> writes a README of what the eyes saw and what landed. Four node steps
> (`looks`, `plan`, `score`, `render`) with the harness between them, the same
> relay the ten-brief eval uses. The first run is in `eval/findings.md`.

A committed test checks every brief names only Windows-legal basenames, and
the render check runs one brief through the whole pipeline in CI with a canned
answer, so a fixture can never rot unnoticed.

Each brief's `truth` and `hero` are the user's ground truth, written once when the set is
made: per photo `people` (none / one / couple / group), `shot` (wide / medium
/ close / detail), `product_visible` (yes / no) and one line of what is in it;
and for the set, **which photo the user would make the hero**. That last mark
is what the hero mechanism (§4.3) is scored against.

### 3.2 The harness — `npm run eval`

Not new machinery: a vitest file, `tests/eval/director.eval.test.ts`, that
`describe.skipIf`s itself unless `FORGE_EVAL` is set, and otherwise runs every
fixture through the real `main/director.ts` `complete()` (the seat
`directorMain.test.ts` already sits in, with `setSettings` pointing at a
temporary settings file) against the real server at localhost. Three
`package.json` scripts, all new:

    "eval":        "vitest run tests/eval/director.eval.test.ts",
    "eval:rate":   "node scripts/eval-rate.mjs",
    "eval:report": "node scripts/eval-report.mjs"

    FORGE_EVAL=ollama FORGE_EVAL_MODEL=gemma4:e2b FORGE_EVAL_THINK=off npm run eval
    FORGE_EVAL=openai FORGE_EVAL_MODEL=google/gemma-4-e2b npm run eval        # LM Studio

Per brief it builds the menu exactly as `direct()` does, by calling the same
functions — `musicFor`, `adSeconds`, `briefFor`, `menuFor` (moved out of the
store into `shared/director/run.ts` so both call one copy), the sidecar's
`audio.beats` through `SidecarClient`, and the request bodies
`openaiRequestBody` / `ollamaRequestBody` (moved out of `main/director.ts`
into `provider.ts` for the same reason) — asks, parses, validates, and —
always — applies to a project and **renders the ad and the standard cut** with
`plan.ts` into `tests/output/eval/<run>/renders/`. Node has no canvas, so the
eval's render is the shots and the music without the text cards; the
headlines are recorded as text and rated as text. Said plainly in the run's
README.

**Transport.** Three steps, each writing files: `FORGE_EVAL_STEP=prepare`
(requests), the ask, `FORGE_EVAL_STEP=score` (results). On the user's machine
`npm run eval` does all three from node. In the development sandbox the shell
is refused a connection to localhost, so the ask goes through the harness dev
server, which runs outside it: `vite.harness.config.ts` carries a proxy to the
model (`/__lm`) and a file endpoint scoped to `tests/output/eval/`
(`tests/eval/relay.ts`), and `window.__forgeEvalRelay('<run>')` in the harness
page posts each prepared body as it is and writes the raw answer back. The
bytes are the app's either way.

Recorded per brief, into `eval/runs/<stamp>-<provider>-<model>-<think>.json`
(small, committed by the user after a run):

| field | from |
|---|---|
| JSON parsed? · truncated? · first answer prose? | `parseModelJson`, `CompletionResult.truncated` |
| verdict: used / repaired (list) / rejected (why) | `validateSpine` |
| prompt tokens · output tokens · total ms | `CompletionResult` |
| every headline with its capacity and whether it fit | `headlineCapacity` |
| the plan and the layout | as applied |
| the model's `reasoning` | the plan |
| VLM answers per photo against `truth.json`; the set's hero candidates against the user's hero (when `FORGE_EVAL_IMAGES=1`) | the look pass prototype, §4.1's schema, one image a call |
| wall time of the whole look pass · per-call time · peak RSS of the model process, with images and without | the run |
| the user's ratings: copy 1–5; preferred to the standard cut? ; "looks automatic" reason code + line | `eval:rate` |

`scripts/eval-rate.mjs` shows the run's headlines shuffled with the baseline's
and asks the user for 1–5 each, blind; then, for each rendered pair, which of
the two mp4s they prefer (files renamed A/B), and whether either "looks
automatic" and why (the reason list in §0). It writes the answers into the
run. `scripts/eval-report.mjs` regenerates `docs/EVAL.md` from every run in
`eval/runs/`: one row per configuration, the ten briefs across, the counts
that matter (used / repaired / rejected · prose-first · median tokens and
seconds · look-pass seconds · copy mean · preferred count · automatic-reason
histogram · VLM accuracy · hero-candidate hit rate).

### 3.3 Configurations and knobs

Configurations, in this order: Ollama `gemma4:e2b` think off, then on;
Ollama `qwen3.5:4b` think off, then on; LM Studio `google/gemma-4-e2b`. The
first row answers the `format` question before any quality question is asked.

Knobs, one at a time, each a run: playbook wording; one worked example in the
system prompt; menu size (all candidates vs downbeats and structural cuts
only); field order; the `maxTokensFor` constant; temperature 0 vs 0.2 for the
copy; images on (with slot notes) vs text only; the 40-character headline cap
for Telugu and Hindi (§9 measures what fits).

### 3.4 Exit

- **The spine.** One configuration reaches ≥ 8 of 10 non-rejected with copy
  ≥ 3 → the architecture is proven; C1 begins on that configuration. None
  does → the finding is written into `EVAL.md` before anything else is tried,
  and the choice is the user's: a larger local model (the 8B class), the copy
  templates (`LLM.md` move 2), or a hosted model for the copy alone (decision
  §10.4).
- **The eyes.** ≥ 80 % of `people` and `shot` answers right, and the `words`
  line judged "about this photo" on ≥ 8 of 10 photos → C1 as designed. Below
  that, C1's look pass is still built (it is cheap) but the recipe paces by
  the objective checks and slot order, and the VLM's words are shown to the
  user rather than trusted for the hero.
- **The hero.** The user's hero is among the gate's candidates (§4.3) on ≥ 8
  of 10 sets. Below that, the candidate rule is loosened (any survivor with
  people, for wedding sets) before anything else changes.
- **The wait.** A full look pass (up to 8 stills plus up to 4 frames per
  clip, sequential, prefix cached) measured on the Surface. Bar: **≤ 60 s
  total, and the stage line moves at least every 15 s**. Over the bar, in
  this order: fewer frames per clip (2), then no video-slot looks, then the
  look pass runs in the background when photos are imported (as the parallax
  bake does) so the Direct button never waits on it.

**Tests and mutations** (the harness is code too): the manifest check; the
report builder over three fixture runs (counts, means, the reason histogram,
an empty run); the two synthetic briefs through the fake provider end to end
with a rendered mp4 whose frame at the second cut shows the second card's
colour. Mutation: drop the `truncated` field from the record and the report
must fail to build; drop a reason code and the histogram test must fail.

---

## 4. C1 — Eyes · 3–4 days

> **Built 2026-09-23, first part** — `vision.measure` in the sidecar
> (`capabilities/vision.py`, numpy/scipy, every photo measured at one 512-px
> size, flat pictures given no hash), `shared/director/look.ts` (look@1),
> `gate.ts`, `eyes.ts` (the cache on `Project.vision`, keyed by `size:mtime`),
> `ask.ts` (the think-off/think-on retry, now shared by the spine and the looks),
> IPC `vision:measure` and `media:fileKeys`, and `direct()` measuring, looking
> and gating before it builds the menu; the SLOTS table shows each look and any
> measured flag. Tests `directorGate`, `directorEyes`, `directorAsk`,
> `renderer/eyesStore`, render check `integration/vision`. Changed by the probe
> (`eval/findings.md`): `people` is a count (none / one / two / group), `words`
> come before the lists, the product is named only for `product_visible`.
> Not yet: looks for video slots (first frames per shot), and the hero as a
> spine field — that is `spine@2`, C2.

### 4.1 The look pass — `look@1`

One call per photo, one image per call, the model answering from closed lists
plus one short line. Small models answer better about one picture than about
eight, and one image is a few hundred tokens.

```jsonc
// src/shared/director/look.ts — lookSchema(): flat, reasoning first, enums only
{
  "reasoning": "…",                                     // ≤ 200 chars
  "words":   "…",                                       // ≤ 12 words of what is there — BEFORE the lists (probe 2)
  "people":  "none" | "one" | "two" | "group",           // a count of the subjects (probe 1: "couple" confused it)
  "shot":    "wide" | "medium" | "close" | "detail",
  "mood":    "warm" | "calm" | "joyful" | "dramatic" | "clean" | "dark",
  "product_visible": "yes" | "no" | "unsure",
  "hero":    "weak" | "usable" | "strong"               // a coarse bucket, used only as a FILTER (§4.3) — never ranked
}
```

- **`hero` is a filter, not a score.** `DIRECTOR.md` §10.5 is right that a
  small model cannot rate one item on a scale that means the same for the
  next; it can compare. So the per-photo bucket only decides who is a
  *candidate*, and the comparison is made where every photo is in view — the
  spine call's `hero` field (§5.2), with the looks of all slots in its table.
  C0 measures the filter (§3.4 "The hero").
- **Prompt**: `lookPrompt(brief)` — system: what each field means, one
  sentence each; user: the brief's product line and "describe this picture".
  Same for every photo, so the prefix caches.
- **Runs in main** through `complete({ …, images: [path] })` — plumbed today.
  The store's `lookAt(assetIds)` asks one at a time (CPU prefill is the
  cost; parallel calls on a CPU box slow each other down), with a stage
  string per photo. **The think-off / think-on retry** `direct()` does inline
  today (Ollama drops `format` under `think: false` for Gemma 4 and Qwen 3.5)
  moves into a shared helper, `askStructured(request)`, that both `direct()`
  and `lookAt()` call — a look that comes back as prose is asked again with
  thinking on, and a photo whose second answer is still prose gets no look
  and is said so in a note (the gate tolerates a missing look, §4.3).
- **Cached in the project**: `Project.looks?: Record<assetId, Look & { key,
  model, at }>` — `key` is the file's `size:mtime`, the cheap key `stems.ts`'s
  `keyFor` and `maskTags.ts` already use (a new scheme for the project; the
  parallax bake keys by content hash on disk and not at all in the project).
  A re-run looks only at photos with no look or a changed key; a retry never
  looks twice. `clearDirector` leaves looks alone — they are facts about the
  photos, not the director's work.
- **Into the menu**: `Slot.look?: Look`; the SLOTS table in `spinePrompt`
  gains a column: `slot_03  image  "IMG 4021"  — one, close, joyful, strong:
  "bride laughing, veil, window light"`.
- **Video slots**: the first frame of each shot — shots from `select`'s
  `scene` score (§8), at most four frames per clip, fewer if C0's wait bar
  says so; the looks are attached to the slot as a list. TransNetV2 stays out
  of scope.

### 4.2 The objective checks — `sidecar/forge_sidecar/capabilities/vision.py`

`vision.measure` over a list of paths, in the sidecar, with the numpy and
scipy already there (librosa brings scipy) — **no new dependency**. These are
the measurements OpenCV would make — the user's "small objective vision" —
done with what is installed; `opencv-python-headless` (~40 MB) comes in only
with mask tracking, later, and this module moves onto it then without its
callers noticing. Image decode through the bundled ffmpeg, as `depth.py` does
(`_decode_rgb`), at 512 px long side.

| measurement | how | reads as |
|---|---|---|
| sharpness | variance of `scipy.ndimage.laplace` on grey | soft below 0.35 × the set's median — **relative to the set**, because a soft-focus wedding set is a look, not ten rejects |
| exposure | mean luma; clipped fraction at < 8 and > 247; `backdropClip`, the clipped-white share in regions touching the frame's edge (`scipy.ndimage.label`) | too dark < 0.18 mean; blown > 6 % clipped **inside** — `brightClip − backdropClip`. Added 2026-09-26 from the first real run: a product on a white studio backdrop clips 61–71 % by design and was never a hero |
| duplicate | 64-bit dHash on 9×8 grey; Hamming ≤ 6 = near-duplicate | of the pair, keep the sharper; say which was left out |
| orientation | `ffprobe` (already in `depth.py`) | portrait / landscape / square — the recipe's framing rules read it |
| faces (footage only, later) | — | not in C1; `people` comes from the look |

Returned as `Measure` per asset; stored beside the look in `Project.looks`.
Registered in `OPTIONAL` as `("vision.measure", "vision")` so a machine
without scipy degrades to "no gate" rather than no Director.

### 4.3 The quality gate — `src/shared/director/gate.ts`

Pure. `gate(slots, looks, measures, recipe) → { slots: (Slot & { measure?:
Measure })[], heroCandidates: string[], leftOut: { slot, why }[] }` — the
measurement rides on each surviving slot, because the rhythm engine's drop
rule (§5.3 step 3) ranks by it:

1. a near-duplicate of a sharper photo is left out, named;
2. a soft, too-dark or blown photo is **never a hero candidate** and is
   pushed out of the hero's neighbourhood by the recipe; it stays in the ad
   unless the set has more than the recipe needs, in which case it is the
   first dropped, named;
3. hero candidates are the survivors whose look bucket is `usable` or
   `strong` and, for recipes that want people (wedding), `people ≠ none`;
   with no looks, the sharpest survivors with the most central exposure. The
   candidates go to the spine call as the `hero` enum; **the model chooses
   among them with every look in view** — that is the comparison, and it is
   the only ranking anywhere in the pass. **When the list is empty** — every
   photo soft or blown, or none with people in a wedding set — the filter
   loosens in a fixed order until it is not: first the recipe's people
   requirement is dropped, then the exposure exclusion (the sharpness one
   stays — blur is the one thing no hold survives), then the sharpest
   survivor is the sole candidate whatever its bucket; the note says the set
   had no clean hero and which rule gave way. The list is therefore never
   empty when there is at least one photo, and the baseline's "first
   candidate" is always defined;
4. **where the look and a measurement disagree on what the measurement
   measures, the measurement wins**: a photo the VLM calls `strong` and the
   Laplacian calls soft is not a candidate.

The Director panel shows `leftOut` as it shows `problems` today: "slot_04
left out — near-duplicate of slot_03 (slot_03 is sharper)".

### 4.4 Tests, render check, mutations

- `tests/directorLook.test.ts`: the schema is flat and `reasoning`-first
  (the conforms test extends to it); the menu row format; the cache key —
  same file, no second call; a changed mtime, one call; a prose-first fake
  answer is asked again with `think: true`; a prose-twice answer yields no
  look and a note.
- `tests/integration/vision.int.test.ts`: synthetic images through the real
  sidecar — a checkerboard vs the same through `boxblur=8` (2012, safe) →
  sharpness ratio > 10; a card at luma 20 → dark; a card at 250 → blown;
  two crops of one card → duplicate at distance ≤ 6; a rotated card vs the
  original → not a duplicate. Into `tests/output/vision/`.
- `tests/directorGate.test.ts`: every rule in 4.3 over fixture measures,
  including "soft `strong` is not a candidate", "the set of soft photos keeps
  all of them because the median is soft", and "no looks → sharpest
  survivors".
- Render check `tests/integration/gate.int.test.ts`: a five-card set where
  one card is a blurred duplicate, through the recipe baseline (C2) or, before
  C2, through `baselineSpine` with the gate applied → the rendered ad's hero
  span never shows the blurred card (frame sampling by the cards' colours).
- Mutations: absolute sharpness threshold instead of relative (the soft set
  test fails); duplicate keeps the softer; the disagreement rule inverted;
  the cache re-asks on every run; the retry helper skipped for looks.

---

## 5. C2 — Recipes, `spine@2` and the rhythm engine · 5–6 days

> **Built 2026-09-23, first part** — the five recipes as data
> (`shared/director/recipes/`), the rhythm engine (`rhythm.ts`: `rhythmGrid`,
> `layout`), tests `directorRecipes` and `directorRhythm` (three worked cases
> and a 500-ad sweep). As built, differing from the text below where the build
> taught otherwise:
> - **Ids are strings**, checked against the registries by a test — `as const`
>   on the text and look registries makes every nested array readonly.
> - **The legal cuts are every beat of the song**, not the model's thinned menu
>   (C0: 7–11 cuts for 6–8 photos); the structural preference is "within ONE
>   beat", since within half a beat of a beat is only that beat.
> - **Everything is in beat indices**: at 160 BPM a beat is 11.25 frames, less
>   than the shortest shot, so the shortest shot there is two beats — a
>   frame-based fit put boundaries between beats. The hero's floor is counted
>   in whole beats, rounded up.
> - **The fit scales the designed ad by one factor** (the hero at its target
>   and lead, the rest at the curve), then holds any shot that breaks a bound
>   AT the bound and re-solves: a clip at its footage, a shot at the shortest.
>   Holding at the minimum rather than failing is the difference between
>   compressing an ad 4 % and dropping a photo from it.
> - **A clip is never longer than its footage** — held in the fit, capped in
>   the snap, and trimmed after it with the ad ending a beat sooner. C0's
>   black-after-the-clip cannot happen.
> - **The hero's floor is hard until only the hook and the hero are left**;
>   before that a shot is dropped. The post-snap repair takes beats from as
>   many shots as it needs, one at a time.
> - A calm or premium brief that says wedding (in English, Telugu or Hindi
>   words) is a wedding without a model.
>
> **Built 2026-09-24, second part: `spine@2` without a model** —
> `schema2.ts`, `prompt2.ts`, `validate2.ts`, `baseline2.ts`, `compose.ts`,
> `apply2.ts`, each recipe's `roles`; tests `directorSpine2` and the render
> check `spine2Render` (the standard cut of a product reveal, applied and read
> back frame by frame). As built:
> - **One flat decode, so the enums are unions** across the recipes (styles,
>   animations, moves); the validator repairs a choice from another recipe to
>   the chosen recipe's own, where `spine@1` would have rejected it. It also
>   repairs order, an unknown recipe (to the tone's), a hero that is not a
>   candidate, a speed on a still, a ramp on a clip that speaks, and a punch
>   word not in its headline. It still rejects a cut-off answer, the wrong
>   shape, and a plan with no usable shot.
> - **The prompt gives the music in one sentence** and no table of cuts; the
>   playbook is one constant, so a server caches it.
> - **Headline room is counted in graphemes** after timing, and a line too
>   long for its card is dropped from a copy — the model's plan is not edited.
> - **The look is one adjustment layer below the cards**, so the type is not
>   graded; the black and the end card's colour card are on V1.
> - **The render check found an export bug**: a look at partial strength was
>   blended the wrong way round (`EFFECTS.md` §LUTs) — 0.75 exported as 0.25.
>   Fixed in `plan.ts` for both a clip's look and an adjustment layer's.
> - **The hero's floor holds when every other shot is at its minimum** (the
>   engine let it fall to 1.9 s of a 2 s floor there); a shot is dropped
>   instead, and a headlined shot is the last to go.
> - ~~`direct()`, the eval and the Director panel still run `spine@1`; no
>   Recipe picker~~ — **wired 2026-09-25** (below).
> - ~~ramps are noted and played at normal speed~~ — **built 2026-09-26**:
>   `Clip.ramp`, the §18 filter, `sourceFramesFor`'s ramp branch, the preview
>   seeking and playing along the curve; the Director ramps a clip 1× → 0.4×
>   (`DIRECTOR_RAMP`) when its recipe ramps and the clip does not speak
>   (tests/integration/ramp.int.test.ts: source frames 25/42/54 at 1/2/3 s).
> - ~~J/L cuts~~ — **J-cuts built 2026-09-26**: a clip that speaks, after a
>   still or muted footage, is heard 0.2 s (`J_CUT_SECONDS`) before it is seen —
>   its sound lifted onto a dialogue lane by `detachAudio`, led, the picture's
>   in-point moved as far so they stay in sync; refused with a note after a shot
>   with sound of its own, without the footage to lead with, when re-timed, or
>   when the earlier span is taken on the lane (tests/integration/jcut: the 0.2 s
>   before the cut at the clip's own level, silence before it; the refusal a
>   plain cut). L-cuts, the sound trailing, are not built.
> - ~~the hold clip~~ — **freezes built 2026-09-26**: `Clip.hold` shows its
>   in-point frame for its length (one frame decoded, trimmed to exactly one —
>   a 60 fps clip decodes two per project frame, measured — held with the tpad a
>   caption uses, no sound); `freezeFrame` makes the three clips and resumes on
>   the NEXT frame; the preview holds it paused. A split ramp is now two ramps
>   meeting at the rate under the cut. Building it found an export bug in every
>   clip's placement (EFFECTS.md §30): starts not exact in six decimals landed a
>   frame out — fixed. The Director places no freezes yet (C4's hits will).
> - **Not yet**: treatments are not drawn; no ramp control in the UI (the
>   Director is the only thing that ramps). Coherence (§5.4) is built — see there.
> - ~~stills are still letterboxed (C0)~~ — **fixed 2026-09-25**: every shot
>   gets the reframe every dropped clip gets (`solveCrop`, now shared), and the
>   export fills a picture within 1 % of its box's shape instead of padding it —
>   the even-pixel rounding had left a 2 px black column on every reframed photo
>   in the app, not only the Director's (tests/integration/reframeFill).
>
> **Built 2026-09-25, third part: wired in (§5.6)** — `direct()` runs
> `spine@2` through `run.ts`'s `gridsFor` / `menu2For` / `settle2`, the same
> functions the eval now uses; the Director panel has the **Recipe** picker
> (Auto or one recipe; a pinned recipe is the only one offered and the one the
> standard cut uses) and says which recipe directed the ad and which picture it
> was built around; the decision is recorded as `spine@2`; the store draws the
> black, the end card's ground and the look layer's transparent picture
> history-less. The eval prepares, asks and scores `spine@2` (a pinned recipe
> with `FORGE_EVAL_RECIPE`), and its renders now carry the black and the grade.
> `holds` — how many shots the music holds — is asked of the rhythm engine
> itself: the most it keeps, and the fewest that fill the ad.
> **Mutation check, C2: 51 of 51 caught** after four gaps were closed — the
> stretch limit (a design stretched 1.31× must fill, 1.79× must end early),
> the post-snap repair's giver order (reversed, it changed 299 of 3,000 random
> ads), Energy's curve run backwards (it climbs one beat a shot, inside the
> step test's one-beat tolerance — the ends are now compared too), and
> `hasSpeech` comparing seconds with milliseconds. C1's two survivors re-check
> as caught.

This is the step that removes the slideshow tell. Everything the research
found — a shape to the rhythm, hierarchy, motivated cuts, a designed ending,
type as its own beat, one grade — lives here as rules. It is also where Phase
D's ideas land: the catalogue is the registries (a recipe naming an id that is
not in one fails the suite), the treatments are placed by the recipe under
the validator's restraint rules, and the look is one.

### 5.1 A recipe is data — `src/shared/director/recipes/`

> **Retuned 2026-09-25 from the ad research** (docs/research/ad-references-2026-09-25.md):
> pacing is in SECONDS, snapped to the song's beats, so a recipe cuts the same
> at 90 and 160 BPM; each recipe has a `shortestSeconds` a crowded ad may
> not squeeze under (Energy and Trailer never cut a shot on every beat), an
> optional `maxStretch` (Fashion 2), and a `defaultSeconds` (a wedding is a
> 60 s teaser). The table below is the original design; the numbers in
> `recipes/index.ts` are the current ones.

(A different `recipes.ts` — `src/shared/edit/recipes.ts` — already holds the
editing gestures; the directing recipes are a folder under `director/`.)

```ts
// New derived id types, added with this step — today TextStyle.id, TextAnimation.id and
// Look.id are plain strings; TransitionFamily and MotionMove already exist as unions.
export type TextStyleId = (typeof TEXT_STYLES)[number]['id']          // textStyle.ts, `as const`
export type TextAnimationId = (typeof TEXT_ANIMATIONS)[number]['id']  // textAnimation.ts
export type LookId = (typeof LOOKS)[number]['id']                     // looks.ts

interface Recipe {
  id: 'wedding-highlight' | 'product-reveal' | 'energy' | 'trailer' | 'fashion'
  name: string; intent: string                    // one line, shown in the panel and to the model
  /** target shot length in BEATS at position p∈[0,1] of the body; the engine snaps to legal cuts */
  pacing: (p: number) => number
  hold: { hero: number; heroMinSeconds: number; faces: number }
  /** blackBeats in beats (a bar is four); `silence` only says whether the music mutes over the
   *  black — when it does, the mute runs from the last body cut through the black, never a length of its own */
  ending: { blackBeats: number; endCardSeconds: number; silence: boolean }
  moments: { budget: number; at: ('hero-reveal' | 'drop' | 'climax' | 'section')[]; kinds: MomentKind[] }
  treatments: { budget: 0 | 1 | 2; kinds: ('grid' | 'strips' | 'clipping' | 'framing')[]; at: ('hero' | 'drop' | 'section')[] }
  sound: { rules: SoundRule[]; maxHits: number }  // SoundRule = { event: 'riser'|'hit'|'whoosh'|'sub'|'silence', on: 'hero-reveal'|'drop'|'whip'|'before-black' }
  type: { styles: TextStyleId[]; animations: TextAnimationId[]; maxCards: number; endCard: 'names-date' | 'product-cta' | 'title-cta' }
  look: LookId | 'none'                           // one grade over the whole ad
  transitions: { families: TransitionFamily[]; stillsShare: number; footageShare: number }
  moves: { stills: (MotionMove | 'hold')[]; heroMove: 'push-in' | 'hold' | 'parallax' }
  speed: { heroSlow: boolean; ramp: boolean }     // footage only
  intensity: number                               // 0..1, the coherence dial's default
}
```

The five recipes, as the research described them; **the user picks the first
two** (suggested: *Wedding highlight* — the niche — and *Product reveal* — the
clearest grammar). Every value below is a starting point to be tuned by C5's
ratings, and every id is checked against its registry by a test.

| recipe | pacing (beats) | holds | ending | moments (≤) · treatment | sound | type | look |
|---|---|---|---|---|---|---|---|
| **Wedding highlight** | gentle build 4→2, one long hold on the couple | faces 1.5×; hero 2.5×, **never under 6 s** | soft swell, no hit; black half a bar (2 beats) in silence; end card names + date, 3 s | 2: light-burn at the hero reveal, depth-push into the hero · none | swell into hero; silence before black; `maxHits` 0 | `soft-fade` / `clean` · `fade` · lyric-timed cards when a transcript exists · 4 cards | `warm-film` |
| **Product reveal** | slow wides and details 4→2→1, hero 6 | hero 3×, never under 4 s | sub-drop on the reveal, black a bar (4 beats) in silence, end card product + CTA 2.5 s | 2: zoom-punch on the reveal, depth-push into the hero still · none | riser → sub on the reveal cut; `maxHits` 1 | `hero` / `cinematic` · `rise` · 3 cards | `cool-cine` |
| **Energy** | accelerating 2→1→½, release on the peak | hero 2× on the drop, never under 2 s | hit on black (1 beat), end card 2 s | 3: whip-blur on a drop, zoom-punch, light-burn on the release · 1 grid split on a still at a drop | hits on the strongest drops, whoosh under whips; `maxHits` 4 | `poster-3d` / `glitch` · `pop` · 5 cards | `teal-orange` |
| **Trailer** | three acts by sections: 30 % slow, 50 % rising, 20 % climax | title cards ≥ 1.5 s; hero 2×, never under 3 s | riser → braam on black (2 beats); title 2 s, then CTA 2 s | 3: light-burn on act 2, whip-blur in act 3, zoom-punch at the turn · 1 strips flash at the act-3 turn | risers into hits, sub on the last hit; `maxHits` 3 | `cinematic` / `hollow` · `zoom-out` · 4 cards | `bleach-bypass` |
| **Fashion / perfume** | slow throughout, 4–8, negative space | hero 2×, never under 5 s | fade to black (2 beats), minimal end card 3 s | 1: depth-push · none | none but silence; `maxHits` 0 | `hollow-accent` / `clean` · `fade` · 2 cards | `faded` |

Only the four moment kinds C4 builds appear above; `kinetic-type` joins a
recipe when §11's gate opens. A recipe naming a kind with no drawer is
repaired to its first drawable kind, with a note.

The fields the first table leaves out, per recipe:

| recipe | transitions (families · stills share · footage share) | still moves · hero move | speed (hero slow · ramp) | intensity |
|---|---|---|---|---|
| Wedding highlight | `light`, `dissolve` · 0.45 · structural only | slow pushes and pans, `hold` on faces · `parallax` when baked, else `hold` | yes · no | 0.4 |
| Product reveal | `dissolve` · 0.25 · structural only | `hold`, centred push · `push-in` | yes · yes | 0.5 |
| Energy | `whip`, `zoom`, `glitch` · 0.55 · structural only | pushes, shake on drops · `push-in` | no · yes | 0.85 |
| Trailer | `film`, `zoom`, `whip` · 0.4 · structural only | pulls, pans · `push-in` | yes · yes | 0.7 |
| Fashion / perfume | `dissolve`, `smooth` · 0.3 · structural only | `hold`, drift pans · `parallax` when baked, else `hold` | yes · no | 0.3 |

### 5.2 The plan grows — `spine@2`

```jsonc
{
  "reasoning": "…",
  "recipe": "<one of the recipes offered>",
  "hero":   "<slot id — from the gate's candidates only>",
  "style":  "<one text style, from the UNION of the offered recipes' shortlists>",   // whole ad
  "animation": "<one, likewise>",                                                     // whole ad
  "shots": [                                                                          // ≤ 12, slots in the user's order, may skip
    { "slot": "slot_03", "role": "hook|problem|product|proof|offer|cta",
      "weight": "quick" | "normal" | "hold",               // how much it matters — a WEIGHT, never a time
      "move":   "<from the union of the recipes' move lists, incl. hold>",
      "speed":  "normal" | "slow" | "ramp",                // footage only; stills are repaired to normal
      "headline": "…", "punch_word": "…", "why": "…" }
  ]
}
```

**`ends_at` is gone.** In `spine@1` the model chose a cut per segment; over
twelve segments that *is* shaping a pacing curve, which is exactly what the
principle says it cannot do — and every reject row about ordering and
shortness existed to catch it doing it badly. In v2 **the rhythm engine
times; the model weights.** `DIRECTOR.md` §11.1's point survives: the model
still chooses treatment — which shots, the hero, how much each matters, the
move, the style — and the beat grid is still the vocabulary. The rejected
alternative (keep `ends_at`, let the recipe re-time afterwards) would have the
model's timing and the recipe's fight in the validator, and the notes would
read as the app second-guessing the model on every shot.

**One decode, so the enums are unions.** `conforms.ts` allows no `oneOf` and
no conditional schema (`DIRECTOR.md` §10.2 — conditionals over-constrain a
small model), and the schema is built once before the model answers. So
`style`, `animation` and `move` can only be constrained to the **union** of
the offered recipes' shortlists; a value outside the *chosen* recipe's list is
legal at the decoder and must be repaired: **a `move` not in the chosen
recipe's `moves.stills` → `hold`; a `style` or `animation` not in its `type`
lists → the recipe's first.** (The two-call alternative — recipe first, then a
second call scoped to it — was rejected: a second CPU prefill for an answer
the repair gets right.) `style` and `animation` are **whole-ad fields**, as
Phase D's `captionStyle` was, so "one style per ad" is enforced by the shape
rather than by a repair that would throw the model's per-shot choices away.

**`role` has no `moment`.** Moments and the treatment are placed by the
engine at the recipe's structural positions (§5.3), never by the model; the
model's `weight: hold` is how it says a shot matters.

Validation shrinks to shape, order, enums, and the hero being a used slot and
a candidate; repairs: a still with `speed ≠ normal` → normal; a `hold` on a
photo the gate marked soft → normal with a note; a headline over capacity →
dropped (as now); `move`/`style`/`animation` outside the chosen recipe → as
above. **Fewer rejects by construction** is the reliability win.

**The baseline** (`baseline.ts`) becomes **recipe default casting**: the
recipe from a `brief.tone → recipe` table beside `paceFor` (`urgent` /
`energetic` → Energy, `premium` → Product reveal, `calm` → Fashion, `playful`
→ Energy, otherwise Wedding highlight when the set has people in its looks
and Product reveal when it does not); hero = the gate's first candidate;
weights normal; moves from the recipe's list by index; the recipe's first
style and animation. It always validates and is now a directed ad rather than
a beat-grid contact sheet. §9's "no model" row is this.

**`maxTokensFor` is re-measured.** Its ~95 tokens a segment was calibrated on
seven fields; a shot now carries eight, two of them longer enums. The test
that pins the cap for a `MAX_SEGMENTS` plan at worst-case enum length
(`directorPrompt.test.ts`) is rewritten for the new shape before any model
sees it — `LLM.md` records what a stale cap looks like: every long plan
truncated at segment five and blamed on the model.

### 5.3 The rhythm engine — `src/shared/director/rhythm.ts`

`layout(recipe, menu, plan, gate, options) → { segments: SegmentLayout[], events: Event[] }`.
Pure, deterministic, tested without a model. **Units:** the curve is in beats
(`60_000 / analysis.bpm` ms; the recipe's `tempo` constant when there is no
music). "Legal cut" means a `CutCandidate` on the menu.

1. **Reserve the ending** from the end backwards on beats: the end card's
   dwell (recipe seconds, snapped up to a beat, never under 1.5 s), then the
   black (recipe beats), then the last body cut. The ad is never longer than
   asked — `buildCutMenu`'s rule stands.
2. **Targets.** For shot *i* of *n* at position *p = i/(n−1)*, the raw target
   is `pacing(p)` beats, × 1.5 for `weight: hold`, × `hold.faces` for a face
   (look `people ≠ none`, shot medium/close), × 0.6 for `weight: quick`. The
   hero's target is `pacing(p_hero) × hold.hero`, **then raised to at least
   `hold.heroMinSeconds`** (Wedding 6 s — the research's emotional-beat hold),
   **then raised to at least 1.3 × the largest non-hero target** — a global
   rule, because on an accelerating curve a late hero's boosted target can
   still lose to an early shot's plain one, and "longest in the ad" is the
   whole point.
3. **Fit the window** — before anything is snapped. The body window is the
   music minus the ending (step 1). (a) While `hero + (n−1) ×
   MIN_SEGMENT_SECONDS` exceeds it, **drop a shot**: among the shots that are
   not the hero, not the hook and carry no headline, the one with the lowest
   sharpness (`Measure.sharpness` on the gated slot; ties broken by exposure
   distance from the middle of the band, then by later position); then the
   same rule among those with a headline; never the hero, never the hook.
   With no measures (no sidecar), the latest shot goes first. Each is named
   in a note. (b) If the hero alone with the hook's minimum and the ending
   still does not fit (a six-second song), **the floor yields to the
   window**: the hero takes the window minus the hook's minimum, and the note
   says the music was too short for the recipe's hold. (c) Then the non-hero
   targets are scaled proportionally so the body sums to the window exactly;
   the hero keeps its target. **Too few** shots for the music: the ad ends
   early on a beat, as it does today.
4. **Snap.** Each end lands on the **nearest legal cut at or after
   `MIN_SEGMENT_SECONDS`** from the shot's start; if a structural cut (drop,
   section, build-up end, lyric) lies within **half a beat** of that nearest
   cut, the structural cut is taken instead — stated as an ordered rule: (a)
   nearest legal; (b) structural within half a beat wins; (c) ties go to the
   earlier cut. Snapping may change lengths by under a beat, and step 3(c)
   may have scaled non-hero shots up, so **after snapping the hero's actual
   length is re-checked against the same global bound as step 2** — its floor,
   and 1.3 × the largest post-snap length among **all** other shots, not its
   neighbours. If it fell under either, the hero's end moves to the next
   legal cut and the difference is reclaimed from **whichever shot now holds
   that largest length** (its boundary re-snapped); when the hero is the last
   body shot, the shot *before* it gives up the difference instead (its end
   moves to the previous legal cut); when that shot would fall under
   `MIN_SEGMENT_SECONDS`, the difference comes out of the black, up to half of
   it; and when even that is exhausted the hero stays where it is and the
   note names the music as too short for the recipe's hold — step 3(b)'s
   escape valve.
5. **Moments** — the engine's decision, not the model's. At most
   `moments.budget`, at the recipe's positions in order: the hero's reveal
   cut, the strongest drop, a section change — never two on adjacent cuts,
   never within one bar of each other, never on the hook unless the recipe's
   `at` says so. Each is `Event { kind: 'moment', at: frame, moment:
   MomentKind, from: slotId, to: slotId }` for C4.
6. **The treatment** — likewise: at most `treatments.budget` (0 for most
   recipes), a single-slot treatment from the recipe's `kinds` at its `at`
   position, subject to **fits its slot** (grid and strips need a still or a
   clip of at least a bar; a clipping needs a headline; framing needs a
   subject bake), **never on the hook or the CTA**, and never on the same cut
   as a moment. `Event { kind: 'treatment', slot, treatment }`. The
   treatments' own pure planners (`grid.ts`, `strips.ts`, `paper.ts`,
   `onePhoto.ts`) are called at apply time with the shot's frames — that is
   Phase D's "catalogue from code": the recipe's menu IS the registries.
7. **Transitions** by the input mix (`AUTOMATION.md` §5b): a stills-only ad
   uses `stillsShare` of the *grid* boundaries; footage uses structural cuts
   only. The share replaces the flat `TRANSITION_SHARE`. Families come from
   the recipe's list; the member varies by index as now.
8. **Sound events** for C3, **down-selected like moments**: `riser` (or
   `swell`) ending on the hero-reveal frame; at most `sound.maxHits` `hit` /
   `sub` events on the strongest drop cuts the recipe names, never two within
   one bar; a `whoosh` centred on each whip the transition step actually
   placed; `silence` from the last body cut through the black.
9. **Cards**: a headline's card starts on its shot's first beat, lasts
   `max(1.5 s, chars / 16 cps)` snapped up to a beat, never past its shot;
   the end card is its own shot. `maxCards` per recipe; the extras are
   dropped from the quietest shots, named.

### 5.4 Coherence — `src/shared/director/coherence.ts`

> **Built 2026-09-26.** `cohere()` runs inside `run.ts` `settle2`, so the app
> and the eval both land a coherent ad. As built: the rhythm engine already
> guarantees most of the table by construction (moments a bar apart and never
> on a transition or the treatment's cut, hits a bar apart, whooshes a bar
> apart) and the validator the rest (moves, styles and animations outside the
> recipe; a ramp on a clip that speaks; now also a ramp in a recipe that does
> not ramp). What coherence adds: a whip beside a slowed or ramped shot becomes
> a cut and takes its whoosh; a hit and a whoosh within a bar lose the quieter
> cut's (a tie loses the whoosh); the same move on two stills in a row takes
> the recipe's next; glitch type or a glitch family over a warm look, and
> chrome, flames or neon type in a wedding, take the recipe's calm first. The
> intensity moves the camera amplitude, the look's strength, the type size
> (±10 %) and is recorded in the decision for C3 and C4's levels.

One `intensity` per ad (the recipe's default, nudged by the brief's tone:
`urgent`/`energetic` +0.15, `calm`/`premium` −0.15, clamped) sets the type
size ceiling, the look's strength on the adjustment layer, the moments'
amplitude and the sound levels **together**, so nothing is turned up alone.
A **clash table**, checked after layout and repaired with a note (`hasSpeech`
gains an `export` from `apply.ts` so this file uses the same speech test):

| never together | repair |
|---|---|
| `glitch` family or `glitch*` text with `warm-film`/`golden-hour` | the transition becomes the recipe's first family |
| `chrome*`, `flames`, `neon-*` text in a wedding recipe | the recipe's first style |
| a `slow` or `ramp` shot adjacent to a whip | the whip becomes a cut |
| two moments within one bar; a moment and the treatment on one cut | the later one is dropped |
| two hits or whooshes within one bar | the quieter cut's event is dropped |
| a move on the hero when `heroMove` is `hold` | hold |
| the same move on two consecutive stills | the second becomes the recipe's next move |
| a `ramp` on a clip that speaks (`hasSpeech`) | normal — atempo cannot follow a curve, and the words would smear |
| a `move`/`style`/`animation` outside the chosen recipe's lists (§5.2) | `hold` / the recipe's first |

### 5.5 Render-side pieces this step adds

All on filters listed in §8; each with a render check.

- **Speed ramp** — `Clip.ramp?: { from: number; to: number }` (footage only,
  0.25–4). `render/speed.ts` gains `rampVideoFilter(from, to, sourceSeconds,
  fps)` = the `setpts` `log` expression from `EFFECTS.md` §18 followed by
  `fps=`; `rampDuration(from, to, sourceSeconds)` (the closed form, linear in
  `sourceSeconds`); `rampSourceSeconds(from, to, outputSeconds)` (its
  inverse); and `sourceFrameAtRamp()` so the preview scrubs to the frame the
  export shows — the same one-rule pattern as `moveAt`. **`sourceFramesFor`
  gains a ramp branch**: today it is `duration × clipSpeed(clip)`, and every
  decode window is sized by it — `videoInputArgs`'s `-t` (the video inputs,
  and Steady's analysis pass through the same function), the clip-matte
  input block, the audio input block, and `main/render/steady.ts`'s own frame
  count — so a ramped clip with `clip.speed` unset would decode its *output*
  length as source and run past the footage. The branch derives the true
  source span from `rampSourceSeconds`, and every caller inherits it because
  the rule lives in the one function. A ramped clip's own sound is muted (`volume: 0`);
  the music carries the moment. `withClipRamp` sets `duration =
  rampDuration(...)` and ripples, as `withClipSpeed` does.
- **Freeze** — not one clip: `tpad` can only pad the START or the END of a
  stream, never hold a middle frame and resume (`-h filter=tpad`), and
  `holdFilter` has only ever extended a PNG run to a clip's end. So a freeze
  is **three clips**, the way cut-to-black is a clip: the shot up to the
  frame; a **hold clip** — `Clip.hold?: true`, `inPoint = atFrame`, its
  chain decoding one frame (`-frames:v 1`) and `holdFilter`ing it to the
  clip's length, the exact shape the caption path already renders; and the
  shot resuming from `atFrame`. All three `generatedBy: director.spine`. The
  preview draws the hold clip's in-point frame. A hit can land on a held
  frame.
- **Cut to black** — a `Clip.solid` black card, `generatedBy: director.spine`.
- **End card** — a text clip with the recipe's `endCard` shape (names + date
  from the brief for weddings; product + CTA otherwise), the ad's style and
  animation, `size` from `sizeFor`, dwell from the engine.
- **The look** — one adjustment clip over the whole ad (`adjustment: true`)
  with the recipe's look at `intensity`; B3 proved a graded adjustment layer
  exports.
- **Moves** — `motion` from the model's per-shot `move` (repaired to the
  recipe's list), the hero's `heroMove`; parallax when
  `project.parallax[asset].separated`. This **replaces** `apply.ts`'s
  internal `chooseMove(i, energy, previous, hasDepth)` heuristic for
  director shots; `chooseMove` stays for the reel.
- **The treatment** — the shot's frames handed to the treatment's own
  planner (`grid.ts` / `strips.ts` / `paper.ts` / `onePhoto.ts`), which
  writes ordinary clips as its Auto-tab automation does, `generatedBy:
  director.treatment`.
- **J/L cuts** — on footage with speech, the sound leads its picture by
  `jCutFrames` (a recipe constant, ~6 frames), in two steps: `detachAudio`
  lifts the sound onto a dialogue lane **at the same frames** (that is its
  contract, `edit/recipes.ts`); then the engine moves the new clip's `start`
  and `inPoint` back by `jCutFrames` and grows its `duration` by the same,
  only when `inPoint ≥ jCutFrames` (there must be that much lead-in in the
  file) and the shifted span is free on its lane (`overlapsOn` re-checked —
  `detachAudio` only checked the unshifted span). If `detachAudio` refuses
  (`no-sound`, `already-detached`, `no-room`) or the shifted span does not
  fit, the shot cuts normally and the note says so. Only where the previous
  shot is a still or muted footage, so nothing is covered.
- **Lyric cards** (wedding) — when the music has a transcript, card starts
  snap to `automation/lyrics.ts`'s sung-syllable cuts rather than the
  metronome.

### 5.6 Apply, decisions, panel

`applySpine` takes `spine@2` + the engine's layout and events; still one
`update()`, one undo. **The field diff it absorbs:** `plan.segments` →
`plan.shots` at its four read sites (the shot loop, the transition loop, the
card loop, the CTA check); `hero`, `style`, `animation` read from the plan's
top level; per-shot `weight`/`move`/`speed` read into the clip (`move` in
place of `chooseMove`); the `SegmentLayout` now comes from `rhythm.ts`, not
`validate.ts`. **Moment and treatment events name slots**; `applySpine`
resolves each `from`/`to` slot id to the clip it minted through the same
`shots` array it already pairs `Slot` with `Clip` in for transitions, and
writes `MomentSpec.from/to.clipId` from that. New clips carry
`generatedBy.rule` = `director.spine` | `director.copy` | `director.treatment`
| `director.sound` (C3) | `director.moment` (C4), all in `DIRECTOR_RULES` so
`clearDirector` takes everything. The decision record stores the recipe, the
plan, the layout and the events (`pass: 'spine@2'`); a `spine@1` record still
loads and is shown as history. The panel gains a **Recipe** picker (Auto = the
model's choice) and shows the recipe's one line and the hero it chose;
`direct()` gains stages "looking at the pictures", "laying out the <recipe>".

### 5.7 Tests, render checks, mutations

- `tests/directorRecipes.test.ts`: every id in every recipe exists in its
  registry (styles, animations, looks, families, moves, moment kinds,
  treatment kinds); `pacing` is defined on [0,1] and positive; the ending
  fits any music of ≥ 10 s; the second table's fields are all present.
- `tests/directorRhythm.test.ts`, over three synthetic beat grids (90, 120,
  160 BPM) and 3–12 shots: the hero's segment is the longest by ≥ 1.3× (and
  ≥ its `heroMinSeconds`) after snapping; the ending is reserved (black then
  end card, end card ≥ 1.5 s); shot lengths follow the curve's *shape* (for
  the accelerating recipes each body shot is ≤ the previous within a beat's
  tolerance, the hero excepted); moments ≤ budget, none adjacent, none within
  a bar, none on the hook; the treatment fits its slot and is never on the
  hook or CTA or a moment's cut; hits ≤ `maxHits`, none within a bar; the
  transition share for stills vs footage; every boundary is a menu cut; never
  longer than asked; too many shots drops the right ones and names them; the
  snap rule's three clauses each on a menu built to exercise them. A
  **property test**: 500 random menus × recipes × hero positions — **including
  the hero on the last body shot of an accelerating curve** — → the layout
  always validates and every invariant above holds.
- `tests/directorCoherence.test.ts`: every row of the clash table, including
  `recipe: wedding-highlight` with `style: hero` and an Energy-only move; and
  that intensity moves all four dials.
- `tests/directorSchemaV2.test.ts`: flat, `reasoning` first, enums per
  request, the unions; `maxTokensFor` holds a `MAX_SEGMENTS` plan at
  worst-case enum length; the baseline's tone → recipe table; a `spine@1`
  decision still loads.
- `tests/directorApply.test.ts` (rewritten for `plan.shots`): the four read
  sites; slot → clip resolution for moment and treatment events; the J-cut
  shift and each refusal path; a hold clip's fields.
- Render checks, into `tests/output/<check>/`:
  - `ramp.int.test.ts`: a 4 s numbered-grey source (longer than the 2 s the
    ramp consumes, so a wrong decode window runs past the intended frames
    instead of hitting the end of file and passing by accident) ramped
    1×→0.25× over 2 s of source → duration 3.70 ± 0.04 s and the frame at
    1 s, 2 s, 3 s reads luma for source frames 25/42/54 ± 1 — `EFFECTS.md`
    §18's own numbers as the oracle; and the preview's `sourceFrameAtRamp`
    agrees with each sampled frame.
  - `freeze.int.test.ts`: a numbered source split into the three clips at
    frame 30 with a 15-frame hold → frames 0–29 read 0–29, frames 30–44 all
    read 30, frame 45 reads 31 (the resume), and the clip boundaries fall
    where the engine said.
  - `recipe.int.test.ts`: the two chosen recipes over the synthetic fixtures
    (cards + beat bed) through the whole pipeline with the fake provider →
    the hero card's span is the longest and ≥ its floor (by sampling); the
    frames in the black are black; the end card is present for ≥ 1.5 s; the
    adjustment look is applied (a known grey card comes out at the look's
    measured value); every cut lands on a menu frame (frame differencing at
    the cut); the Energy run carries exactly one grid split, on a still, not
    on the hook.
  - `jcut.int.test.ts`: a tone-carrying clip after a silent card →
    `meanVolumeDb(file, cut − jCutFrames/fps, jCutFrames/fps)` is within 3 dB
    of the tone's level and the same-length window before it is under
    −60 dBFS — the `volumedetect`-over-a-span oracle A3's mix check already
    uses; plus the refusal path renders a plain cut.
- Mutations (each must fail one named test): the hero hold factor set to 1;
  the hero seconds floor removed; the 1.3× global rule removed (the late-hero
  property case fails); the black removed; end card under 1.5 s; the
  adjacency rule removed; the stills share swapped for the footage share;
  `log` sign wrong in the ramp; the ramp branch removed from
  `sourceFramesFor`; the hold clip decoding from frame 0; the J-cut shift
  applied without the `inPoint` check; a clash row deleted; `maxHits`
  ignored; the treatment allowed on the hook; intensity moving only the type;
  too-many-shots dropping the hero.

### 5.8 Where the 5–6 days go

| piece | days | net-new or restructuring |
|---|---|---|
| `spine@2` schema; `validate.ts` (most reject rows deleted, repairs added); `baseline.ts` (tone → recipe); `apply.ts` (`plan.shots`, top-level fields, slot → clip for events); the four director tests rewritten | 1.5 | restructuring — `ends_at` logic is deleted, not reworked |
| `rhythm.ts` with the property test | 1.5–2 | net-new |
| `coherence.ts` and the clash table | 0.5 | net-new, small |
| the seven render-side pieces (§5.5) with their render checks | 1–1.5 | thin glue over measured or shipped primitives — the ramp filter is measured, the hold clip is `holdFilter`'s shape, black/end card/moves/look/treatments are existing clips, J-cut is `detachAudio` plus a shift |
| panel, stages, decision record | 0.5 | glue |

---

## 6. C3 — Sound design · 2–3 days, and a pack

Firing is deterministic; the recipe names the events (§5.3 step 8) and this
step realises them. No per-cut model choice.

### 6.1 Events → clips — `src/shared/director/sound.ts`

`placeSound(events, pack, layout, fps) → Clip[]` on an audio lane the
director adds (or reuses) named *Sound design*, every clip `generatedBy:
director.sound`:

| event | placement | level (relative to the music's set level) |
|---|---|---|
| riser / swell | its measured **peak** lands on the target frame (§6.2); starts `peakSeconds` before, faded in over its first 20 %; anything after the peak is faded out over 4 frames unless the recipe keeps the tail | −8 dB |
| hit / braam | its measured peak lands on the frame (a braam's hit is 0.55 s into its file) | −3 dB |
| sub-drop | starts on the frame with the hit | −6 dB |
| whoosh | centred on the transition's midpoint | −10 dB |
| silence | the music's `volume` keyframes ramp to −∞ over 4 frames at the last body cut and return (or not) at the end card, as the recipe says | — |

Levels are constants in `render/soundLevels.ts`, beside `duck.ts`, measured
once (§6.4) and read by both the export and the preview mixer. The music is
**not** ducked under SFX — the hit is meant to sit on top; the silence is the
envelope, which the preview already plays (A3).

### 6.2 The sounds — the library first, then an open pack for the gaps

Each sound the recipe can fire carries `role: 'riser' | 'swell' | 'hit' |
'braam' | 'whoosh' | 'sub' | 'tick'` and `seconds` in the catalogue (a small
table keyed by file name, `src/shared/director/soundRoles.ts`, since the
library's catalogue entries carry no role today); `sound.ts` picks by role and
length, varying by index.

**What the library already has** (`assets/sfxx/`, the 23 sounds the library
pack ships; measured 2026-09-23 with librosa on the sidecar's interpreter —
peak time, attack, 30 dB decay, spectral centroid over the loud part, energy
below 100 Hz, level change across the sound):

| role | files | measured | verdict |
|---|---|---|---|
| **sub-drop / boom** | `cinematic_boom` 1.8 s, `bass_drop_sub` 1.5 s, `808_sub_boom` 0.95 s, `sub_bass_impact` 0.85 s, `sub_impact` 0.85 s | peak in the first 10 ms, 82–96 % of energy under 100 Hz, centroid falling to 34–51 Hz | **usable as is** — the Product reveal's sub on the reveal, the Energy/Trailer hit's low layer |
| **whoosh** | `swoosh_heavy` 0.65 s, `whoosh_fast` 0.35 s, `sword_swish` 0.30 s, `fast_whoosh` 0.26 s | peak mid-sound (0.12–0.34 s), 50–62 % energy above 4 kHz, flat level | **usable** — the peak sits mid-file, which is what "centred on the transition" needs; `swoosh_heavy` has body (19 % in 100–500 Hz) for the slower recipes |
| **tick / pulse** | `clock_tick` 0.08 s, `heartbeat_pulse` 0.6 s | — | usable for Trailer act 1 |
| **riser** | `riser_tension` 1.2 s — rises +13.9 dB, centroid 426 → 2140 Hz, peak at its last frame; `riser_climax` 1.1 s — peaks at 0.61 s and falls into the sub (65 % under 100 Hz), a swell-into-boom rather than a riser | `riser_tension` is a true riser but **1.2 s**; the recipes want 2–8 s | **gap**: long risers (2, 4, 8 s) |
| **swell** | — | — | **gap**: a soft 2–4 s swell for the Wedding highlight (no noise, no hit) |
| **braam / cinematic hit** | `cinematic_boom` is a boom (96 % sub), not a braam | — | **gap**: one braam and one mid-heavy hit for Trailer, later |
| not for the Director | `camera_shutter_click`, `shutter_click`, `cyber_scan`, `ding_chime`, `glitch_zap`, `glitch_data_stutter`, `page_turn`, `pop_bubble`, `record_scratch`, `tv_static_burst` | — | meme and UI sounds; stay in the library |

So the first two recipes need only **two things the library lacks**: long
risers (Product reveal) and a soft swell (Wedding highlight).

**The gaps, filled from Freesound — searched, verified, downloaded and
measured 2026-09-23** (workflow `wf_3f2f6693-c5b`: three searchers, a checker
per candidate reading its page; 11 of 30 candidates survived; the user said
"download them"). Freesound serves originals only to a signed-in account, so
these are its public HQ previews — MP3, 127–194 kb/s, 44.1/48 kHz — which are
fine to build and tune against under music and an AAC 192k export; the
originals (same pages) replace them before the pack ships, fetched by the user
signed in. Measured with the same script as the library:

| role | sound (page) | licence | length | measured | verdict |
|---|---|---|---|---|---|
| riser | syntheffects "Riser sound effect long" (685255) | CC0 | 3.75 s | rises +12.8 dB, **peak at 3.24 s**, stops dead after it | **keep** |
| riser | syntheffects "Riser sound effect short" (685256) | CC0 | 3.05 s | +13.5 dB, peak at 2.79 s | **keep** |
| riser | BeaconStudio "Cinematic Riser #3 subtle" (859482) | CC0 | 3.0 s | +11.5 dB, peak at 2.28 s, 39 % under 100 Hz — a low, quiet build | **keep** — Product reveal's riser |
| riser | Rizzard "Riser" (561207) | CC0 | 2.0 s | +11.2 dB, peak on its last frame | **keep** |
| swell | Fester993 "Guitar Swell" (564442) | CC0 | 3.06 s | blooms +12.6 dB to its end, 74 % in 100–500 Hz, no transient | **keep** — Wedding highlight's swell |
| swell | TheFlyFishingFilmmaker "Violin single note swell" (641703) | **CC-BY 4.0** — credit the author | 5.9 s | swells to a peak at 3.94 s, then fades | **keep**, credited |
| swell | Sub-d "Guitar swell 1" (47021) | CC0 | 14 s | peaks at 1.62 s, then an 8.7 s tail | keep for later — trim with a fade |
| braam | unfa "Braam" (647712) | CC0 | 10 s | hit at 0.55 s, 81 % under 100 Hz, long tail | keep — Trailer |
| riser + hit | deep_ "Riser Slam Boom" (770200) | CC0 | 8 s | a 2.5 s rise into a slam at 2.87 s, then a boom tail | keep — Trailer |
| riser | MajinLuu "Synth+White Noise Riser" (680514) | CC0 | 4.8 s | pitch sweeps up but the LEVEL does not (+0.7 dB); peaks at 1.76 s | **reject** — not a build |
| reverse | John Rayson "reverse cymbal" (23127) | CC0 | 2.0 s | peaks at 0.28 s and decays — it is not reversed | **reject** |

**What the measurement changed in the design:** a riser's loudest moment is
not its last frame — the long one peaks half a second before it ends. So
`soundRoles.ts` stores each file's measured **`peakSeconds`**, and §6.1's
placement lines the PEAK up with the event frame (a riser ends on the cut at
its peak; a braam's hit lands on the cut at 0.55 s in), never the file's
start or end. The table is re-measured by a test (`librosa` on the sidecar's
interpreter), so a replaced file cannot keep a stale peak.

They ship through the pack pipeline that exists (`assets:packs`, manifest with
sha256, install/remove) as `sfx-cinematic`, on the `sounds` group, with a
CREDITS entry for the CC-BY file. The fallback, only if a role is still
missing: synthesise it with the bundled ffmpeg in `scripts/make-sfx.mjs` —
ours and floor-safe, and thinner-sounding, which C5's `sound` reason code
would show.

### 6.3 Preview

Sound-design clips are ordinary audio clips, so the A3 mixer plays them and
the meters show them. Nothing new to build there — which is the point of
writing clips rather than a private list.

### 6.4 Tests, render check, mutations

- `tests/directorSound.test.ts`: a riser of 4 s for a hit at frame 120 at
  30 fps starts at frame 0 and ends at 120 exactly; a whoosh for a 10-frame
  transition at 100–110 is centred on 105; the silence envelope reaches −∞
  before the black's first frame and returns on the end card only when the
  recipe says so; the pack's roles and lengths are picked, varying by index;
  no pack → events dropped with one note, silence still fires.
- `tests/integration/soundDesign.int.test.ts`: a 10 s beat bed with a hit
  event at 3.0 s and a silence from 7.0 s → `meanVolumeDb` over
  a 0.1 s window at 3.0 s is ≥ 6 dB above the 0.4 s window from 2.5 s; the
  0.8 s window from 7.1 s measures under −60 dBFS; and the whole mix's peak,
  by the new `maxVolumeDb` sibling (`max_volume` from the same `volumedetect`
  run), is ≤ −1 dBFS after `loudnorm`. Into `tests/output/soundDesign/`. Run on both
  builds — it uses `adelay` without `all` and `amix` without `normalize`,
  the two options the floor test already forbids.
- `scripts/make-sfx.mjs`'s output checked by a test that every file opens,
  has the manifest's length within 50 ms and is mono 48 kHz.
- Mutations: the riser starts on the hit; the silence ramp removed; hit level
  applied to the music instead; the pack's role ignored (a riser where a hit
  was asked); `maxHits` ignored in the engine (the sound test's density case
  fails).

---

## 7. C4 — The moments engine on three.js · 5–7 days

**Why three.js, and why only for moments.** Every transition the app ships
is an ffmpeg filter, so it is limited to what a 2018 build can do and it is
previewed by a re-implementation (A2). The card ring proved another rail:
three.js draws into a canvas the preview shows live, and the export gets the
**same drawing baked to PNG frames** it overlays with `tpad` and `overlay` —
so preview and export cannot disagree, and the Windows ffmpeg does not
matter. What this buys is what a filter graph cannot do well: motion blur,
radial blur, additive light, a real perspective camera into depth planes,
type in 3D. What it must not become is a transition on every cut — two or
three **moments** an ad, placed by the recipe, or it is the cheap look the
research warned about.

### 7.1 The clip — `Clip.moment?: MomentSpec`

```ts
interface MomentSpec {
  kind: 'zoom-punch' | 'whip-blur' | 'light-burn' | 'depth-push' | 'kinetic-type'
  /** the two shots it bridges (a single-shot moment names one) — clip ids, resolved by applySpine from the engine's slot ids */
  from?: { clipId: string }; to: { clipId: string }
  seconds: number                 // 0.3–0.7 for cuts; 1.5–3 for a depth push
  intensity: number               // the coherence dial
  seed: number                    // for the procedural ones; stored, never Math.random at draw time
  text?: string                   // kinetic type
  version: number
}
```

The moment sits on the layer above the cut, spanning `[cut − a, cut + b]`
frames from `seconds`; the shots continue beneath it. Its frames are opaque
where it draws and its LAST frame equals the incoming shot's picture, so the
hand-off is invisible — a test pins that.

**A new self-drawing kind joins every guard.** `moment` is added to
`drawsItself` (`edit/recipes.ts`), to `store.ts`'s two spelled-out lists
(`setAspect`'s crop clear and `rebakeGenerated`'s targets — the `clippings`
omission there once caused three bugs), to `isKeyable`, `canSteady` and
`canMoveCamera`, and to `clipKind.ts`'s `clipKind()` as a `graphic`, so the
timeline colours it as one. A test asserts **membership** — a clip with
`.moment` is in each of the seven sets — rather than pinning the whole
expression, per `CLAUDE.md`, and is mutation-checked by leaving `moment` out
of each site.

### 7.2 Drawing and baking — `src/renderer/src/momentCanvas.ts`

Rides `carouselCanvas.ts`: the one shared `WebGLRenderer`, three.js loaded on
first use, `drawMoment(spec, textures, t)` a pure function of `(spec, t)`
(`seed` is in the spec; no clock, no `Math.random`), and
`bakeMomentSequence(spec, clipId, frames, fps)` → `writeTitleFrame` per frame
→ `tpad` holds the last, exactly as the ring. `exportBake.ts`'s `Bakers` gains
`moment`, so an export redraws it at the export's shape into `<clip>-export`.

**Textures are exact frames.** For a still, the picture (and its depth
planes for `depth-push`, from the parallax bake); for footage, the frames
across the moment's window pulled by a pre-pass in main —
`main/render/momentFrames.ts`, `ffmpeg -ss … -frames:v N -vf fps=<fps>,scale=…`
over `videoInputArgs` (shared with the plan, as Steady's analysis is — and
ramp-aware once §5.5 lands) into `userData/moments/<key>/`, keyed by asset
`size:mtime` + in-point + frames + size, reused by the preview and the bake.
The preview shows the moment live from the same textures (nearest frame by
`t`).

### 7.3 The four moments (and a fifth, later)

| kind | what it draws | frames | shader source |
|---|---|---|---|
| `zoom-punch` | radial blur toward the centre with a scale pop on the incoming shot; the outgoing falls away | 10–14 | written here; gl-transitions' `ZoomInCircles`/`CrossZoom` as the reference |
| `whip-blur` | directional blur along the whip axis on both shots, sliding; the blur length peaks mid-moment | 12 | written here |
| `light-burn` | procedural leak: two moving soft gradients plus grain, additive over the cut, peaking on the cut frame | 16 | written here; `seed` chooses the drift |
| `depth-push` | a perspective camera dollying INTO a photo's depth planes (the parallax bake's layers as textured quads at their depths), with a slow ease — the 2.5D move the flat `zoompan` parallax approximates | 45–90 | written here, on `carousel.ts`'s camera arithmetic |
| `kinetic-type` (later) | a headline set in 3D that the camera passes; one word per beat | — | after C5 shows the four above land |

gl-transitions is the starting point for the first two shaders (MIT); the
final shaders are ours and short. Nothing here needs a Windows probe.

### 7.4 Tests, harness check, render check, mutations

- `tests/moment.test.ts` (node, no GPU): frame counts from `seconds` and fps;
  `[cut − a, cut + b]` never exceeds either shot's footage (a moment over a
  capped video shrinks and says so); `seed` makes the same parameters twice;
  the export key is `<clip>-export`; the six-guard membership test above.
- Harness check (measured, in `npm run harness`): each moment drawn at t =
  0, 0.5, 1 → three different canvases; the frame at t = 1 equals the incoming
  texture within 2/255 mean; a `depth-push` at t = 0 equals the photo.
- `tests/integration/moment.int.test.ts`: a baked `zoom-punch` over two colour
  cards (the PNGs made by a node-side fake drawer that follows the same
  timing contract — this proves the bake, overlay and timing path, not the
  shader; the shader is proven in the harness check above) → the frame at the
  midpoint is neither card's colour, the frame after the moment's last frame
  is the incoming card exactly, and the frame before its first is the
  outgoing card exactly; the same at 9:16 and 16:9 export shapes (the
  `exportBake` lesson). Into `tests/output/moment/`.
- Bake time measured and written into `EFFECTS.md`: PNG frames per second
  on the Mac and the Surface for a 1080×1920 moment; the ring's bake is the
  yardstick.
- Mutations: the moment ends one frame late (the "frame after equals the
  incoming" check fails); `seed` ignored; the pre-pass pulls frames from the
  clip's start rather than its in-point; the export bakes at the project's
  shape; `moment` left out of one guard.

---

## 8. Every ffmpeg filter and option Phase C emits, against the floor

Measured or dated, never assumed (`CLAUDE.md`). The Windows build is a master
snapshot from **2018-12-17**; "safe" means merged before that. **"In CI"**
means a shape using it already runs in the Windows integration suite;
anything else is a dated claim until its render check has run there.

| filter / option | used by | merged | status |
|---|---|---|---|
| `setpts` with `log()` in the expression | C2 ramp | `setpts` 2010; `log` in `eval` 2011 | dated; **render-check in CI with C2** |
| `fps` after `setpts` | C2 ramp, as `speedVideoFilter` today | 2012 | in CI |
| `-frames:v 1` + `tpad=stop_mode=clone,trim,setpts` (`holdFilter`) | C2 hold clip; C4 holds the last PNG | `tpad` Oct 2018 (ships in 4.2) | in CI (captions) — the one-frame decode is the new part; **render-check with C2** |
| `select='gt(scene,T)'` + `showinfo` | C1 shot frames for footage | `select` 2011, its `scene` variable May 2012 / `showinfo` 2011 | **dated only — not used anywhere today**; `scdet` (2020) is not safe and is not used. Add the shape to `SHAPES` when C1 emits it |
| `boxblur` | C1's sidecar test only | 2012 | dated |
| `aevalsrc`, `sine`, `anoisesrc` | C3 pack synthesis (a script, not the export) | 2011 / 2013 / 2015 | dated; the script runs on the Mac |
| `highpass`, `lowpass`, `afade`, `volume` | C3 pack synthesis; `afade`, `volume` in the export already | 2012 / 2012 / 2013 / 2012 | `afade`, `volume` in CI |
| `adelay` (without `all`), `amix` (without `normalize`) | C3 sound-design clips, as today's mix | 2013 / 2012 | in CI; the two options are on the blocklist |
| `volumedetect` (via `meanVolumeDb`) | C2/C3 render-check oracle | 2012 | in CI (mix check) |
| `overlay` of a PNG sequence, `format=yuva420p` | C4, as the ring | 2010 | in CI |
| `zoompan` | C2 moves, as today | 2014 | in CI |
| `signalstats` | not used — exposure is measured in the sidecar | 2014 | — |
| `ebur128`, `astats` | **not used** — no helper exists for either; the oracle is `volumedetect` windows | — | — |
| `scdet`, `freezedetect`, `blurdetect`, `colortemperature` | **not used** | 2020 / 2019 / 2022 / 2021 | blocklisted or absent |

Every new shape (a ramped clip, a hold clip, a sound-design lane, a moment
overlay, the scene-frame pull) is added to `tests/oldestFfmpeg.test.ts`'s
`SHAPES` so the blocklist scans its graph.

---

## 9. Degraded modes — each rendered, each a test

The recipe is what makes degradation graceful: with nothing to choose, code
still composes.

| missing | what happens | test |
|---|---|---|
| no model (server down, prose twice, rejected) | recipe default casting (§5.2: the recipe from the tone table, hero from the gate) — the baseline is now a directed ad; the notice says which | `recipe.int.test.ts` with the fake provider refusing |
| no VLM (text-only model, or C0 said its eyes are poor) | no looks; the gate paces by measurements and order; hero candidates = the sharpest, best-exposed survivors | gate test "no looks" |
| no sidecar | no beats → the even grid (`DEFAULT_TARGET_SHOT_SECONDS`), the recipe's curve at its `tempo`; no gate → all pass; no depth → flat moves, no `depth-push` | rhythm test on the grid menu; moment test "no planes" |
| no music | the grid at the recipe's `tempo` (e.g. 100 BPM), silence events dropped, risers kept | rhythm test without analysis |
| three photos | the curve compresses; the hero still holds its floor; the end card still lands | rhythm test n=3 |
| twenty photos, 15 s | the engine drops the softest non-hero, non-hook, headline-less shots first and names them | rhythm test n=20 |
| a 60-character product name | the end card wraps by `sizeFor`; a headline over capacity is dropped, as now | validate test |
| Telugu / Hindi copy | **per-language headline capacity**, measured in the harness: render one card per script at the card size and read the glyph widths; the 40-character cap is a Latin-script number. Also checked: a bundled font covers the script, else the card falls back to the system font and the notice says so | harness measurement into `EVAL.md`; a test on the capacity table |
| `detachAudio` refuses, or the J-cut's shifted span does not fit | the shot cuts normally; one note | `directorApply.test.ts` refusal paths; `jcut.int.test.ts` renders the plain cut |
| the sound pack not installed | sound events dropped with one note; the silence envelope (no file needed) still fires | sound test "no pack" |
| WebGL unavailable | moments dropped with one note; the cut beneath remains | moment test |
| Windows | every render check in §5–§7 runs in CI on the 2018 build | CI, read after every push |

---

## 10. Decisions — taken 2026-09-23

1. **Who runs C0 — decided: here, against the user's LM Studio**
   (`google/gemma-4-e2b` on `127.0.0.1:1234`; `gemma-4-e4b` is also loaded
   and is the obvious second row). Measured on the way in: the development
   sandbox's shell is refused a connection to localhost ("Operation not
   permitted") while the in-app browser reaches it, so the eval's model calls
   go through the harness dev server, which runs outside the sandbox — see
   §3.2 *Transport*. On the user's own machine `npm run eval` calls the model
   directly. First probe: strict `json_schema` holds on Gemma 4 E2B in LM
   Studio (a three-field schema, enum respected, 48 + 54 tokens, 5.1 s) — and
   the headline came back ending in a stray `**`, the first copy note.
2. **The first two recipes — decided: Wedding highlight and Product
   reveal.** Energy, Trailer and Fashion follow in that order.
3. **The sound pack — decided: use the library's own sounds first, and fill
   the gaps from open-source packs** (the user: "we have sfx for this").
   Measured (§6.2): the library's 23 sounds cover hits, sub-drops, whooshes
   and ticks; they do not cover long risers, a soft swell or a braam. The
   ffmpeg-synthesised pack is the fallback only if no open pack fits.
4. **A hosted model for the copy alone — later**, after C0–C3; the copy
   templates (`LLM.md` move 2) are tried first if local copy fails C0.

---

## 11. Out of Phase C, on purpose

True match cuts, cutting on action and Nike-style synchronised split-screen
(need motion understanding across footage — manual or template features);
video subject tracking and mask tracking; reference-video matching (sheet ⑩);
templates and the market (Phase E — recipes are their seed); the sticker
semantic index (`bge-m3`) and stickers as a directed choice; Florence-2
(caption placement, its own item); TransNetV2; fine-tuning of any kind; a
10-bit pipeline; `kinetic-type` until the first four moments have been rated.

And one honest limit: no editor makes a soft reception photo look like a
product shot. What C makes reliable is that *good* input looks directed, the
worst photo is never the hero, and the file always plays.

---

## 12. Done means

- `docs/EVAL.md` shows one local configuration at ≥ 8/10 used with copy ≥ 3;
  the two first recipes preferred to the standard cut on ≥ 8/10, blind; and
  zero ads flagged "automatic" for a placement reason beside their reference
  spots.
- Every row of §9 has a rendered output in `tests/output/` and a test.
- Every filter in §8 marked "dated" has become "in CI" on the Windows build.
- Every regression test above has had its bug put back and failed.
- `EFFECTS.md` carries the measurements (ramp, the hold clip, moments' bake
  cost, sound levels), `WHERE-THINGS-ARE.md` the Recipe picker and the Sound
  design lane, `LLM.md` §Built the `spine@2` shape, `FIX.md` §D says exactly
  which of its ideas landed where, and this file's steps are marked DONE with
  what was actually built, as `FIX.md` does.
