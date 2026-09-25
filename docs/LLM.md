# The LLM part

What Forge asks a model to do, and — more usefully — what it decided **not**
to ask. Most of this file is rejected options, because the expensive mistakes
here are the plausible ones, and every one below was argued for before it was
dropped.

The design was settled in conversation and written down because a conversation
does not survive a new session. The section at the end, **Built**, says how
much of it exists and what changed on the way — read that before assuming
anything here is still only a plan.

---

## What this is for

**Ads and product demos**, not sheet ⑦'s narration video. The user brings a
few images, maybe a short product clip, a piece of music and some product
info, and gets back a cut ad.

That target was chosen over "AI video generator" deliberately. **An ad is a
constrained format** — 15 to 30 seconds, with a known skeleton: hook, problem,
product, proof, call to action. Constrained formats can be automated. A film
cannot, which is why every "AI movie maker" is bad and why an ad tool is a
real product.

It also plays to what already exists here: beat sync, transitions, the
one-photo reel (which *is* product demonstration), captions, stickers.

---

## The rule: decide, don't generate

Every automation in this codebase is a rule that writes ordinary, visible,
editable clips — beat-sync reel, grid split, props on keywords. None is a
black box. The LLM belongs **inside that frame**, as a smarter rule, not as a
new content pipeline bolted alongside.

That is not only tidiness. Forge already *understands* the user's footage in
ways other editors do not: Whisper transcripts with word timings, beats and
drops, depth, shot boundaries. A model on top of that is not a generator, it
is an assistant that can read.

**The one exception is narration and copy, which is genuinely generation.**
That is the hard part, and §"Copy" below is about nothing else.

---

## The architecture

### Everything is a plan

The model emits a **validated JSON edit plan**. The app checks it whole, then
applies it in **one transaction**. Not a sequence of tool calls.

Four reasons, and the second is the one that settles it:

1. **Turn count.** A 30-second ad is ~40 operations. As tool calls that is 40
   round trips; on a local model, minutes. As a plan it is one generation.
2. **Undo is transactional here.** `begin`/`commit` already wrap a gesture
   into one undo entry. Forty tool calls are forty mutations, and a model that
   goes wrong at step 25 leaves a half-edited timeline and 25 undos to press.
   A plan is **one** undo. Tool calls fight an architecture that already
   exists.
3. **Validation timing.** A plan is rejected *before anything is touched*.
   Tools fail halfway.
4. **Testability.** A plan is data — snapshot it, diff it, assert "this brief
   produces this plan". A 40-call sequence is very hard to test, in a codebase
   that tests everything.

And plainly: small local models lose the thread on long tool chains. Betting
on tools is betting against the no-per-use-cost constraint.

### Scoped passes over a shared spine

Not one giant prompt. Each feature gets its own small pass that sees only its
own catalogue — **and every pass reads the same spine**, so they agree about
what the video is.

| pass | LLM? | reads | produces |
|---|---|---|---|
| 0 — facts | no | librosa, TransNetV2, Whisper, asset list | beats, drops, sections, shots, word timings |
| 1 — **the spine** | yes | facts + assets + brief | segments with roles (hook/problem/product/proof/CTA) and cut points |
| 2 — transitions | yes | spine + beats + transition catalogue | transitions on specific cuts |
| 3 — captions | yes | spine + transcript + cuts + fonts | lines and placement |
| 4 — stickers | yes | spine + transcript + cuts + caption placement + sticker index | choices and timings |
| 5 — grade | yes | spine + look catalogue | one coherent look |

**Why scoped:** it changes which model you need. A 2B can pick transitions
from a list of twenty given beat data; it cannot direct an ad. Narrow scope is
the difference between needing a 13B and a 2B — which is the difference
between "local, no per-use cost" being real and being a slogan.

**Why the spine:** without it the passes are individually correct and
collectively incoherent. A whip-cut at 0:12 under a caption spanning
0:11–0:14. A warm grade with a cold sticker. **Incoherence is exactly the
difference between "automated" and "directed"**, which is the whole product
claim. The passes are also not independent — captions depend on cuts,
stickers depend on cuts *and* captions — so this is a pipeline with an order,
not a fan-out.

**Why it is worth the schema work:** you can ship one pass at a time.
Transitions alone is useful on day one.

### Failure

Every pass output is validated against its schema **and** against the project:
does this clip id exist, is this frame in range, does this transition ship,
does it fit the clip. An invalid pass is **rejected and the others kept** —
the same rule `docs/SIDECAR.md` already states:

> A missing capability degrades one feature, never the process.

The caption pass failing should cost captions, not the ad.

---

## The user places the assets

**The model never decides ordering or placement.** The user drops images into
numbered slots.

This is not a compromise, it is the product. Placement is where a wrong
decision is most obvious and most irritating; it is what the user has the
strongest opinion about, since it is their product; and it is trivially fast
to express by dragging. It is also **how CapCut templates work**, which is a
pattern with millions of users behind it.

It reframes the feature as a **smart template** rather than an *AI director* —
more achievable, and more trustworthy, because nobody is disappointed when a
template does what it says.

Auto is offered as a default that can be overridden. Somebody with twenty
images does not want to place twenty.

---

## Models

One multimodal model, not two. An **E2B-class multimodal Gemma** takes text
and images natively: one download, one capability.

**Vision matters for the narrative, not just for placement.** A model given
`product_shot_01.jpg` writes generic copy. A model that sees *a serum bottle
on marble in soft morning light* can write copy about what is actually there.
That is the stronger argument for multimodal, and it is why the images go to
the model at all.

**Florence-2 (0.23B, MIT, ONNX, CPU) for caption placement and OCR** — a
second, tiny model for the two jobs a chat-shaped multimodal is weak at:
exact coordinates, and reading text. OCR is the underrated one: it reads the
product name straight off the label, which is often the single most useful
fact in the image.

They are not a ladder and Florence is not a fallback for Gemma — it cannot
generate. They are two jobs: **Gemma sees for meaning, Florence sees for
precision.** If Gemma is absent, narration degrades off or goes hosted;
Florence does not cover it.

**YOLOv8 was dropped.** Florence does detection and grounding too, so it was a
second model for a job already covered. Its 80 COCO classes would also have
called a serum `bottle` — useful for *where*, useless for *what*. Depth is
already in the sidecar and may answer "where is the subject" without either.

**Memory, honestly:** E2B is ~2–3GB resident and **Electron is 1–2GB before
anything loads**. 8GB works, 16GB is comfortable. Worth knowing before
promising it to an old machine.

---

## Local and hosted

The provider contract already exists for speech (`src/shared/voice/provider.ts`)
and this follows its shape exactly: `local`, `hosted`, `auto`.

The tiers get **different input**:

- **local** — extracted text: transcript, Florence captions, detected objects
- **hosted** — the frames themselves, since a frontier model can see them

**Sampling correction, because "just send the video" is wrong arithmetic.** A
30s clip at 1fps is 30 images at ~1,500 tokens each — **~45,000 tokens a
call**, and two minutes is ~180,000, past some context limits and genuinely
expensive. Sample **one frame per shot**, not per second: TransNetV2 gives the
boundaries, a 30s ad has maybe 15 shots, and 15 images is ~22k tokens.
Arguably better input than 30 near-duplicates.

Key handling is already solved: `redactKey`, never logged, never in an error
message, never leaves the main process.

---

## Copy — the one genuinely hard part

Narration is generation, not decision, so the rule above does not save us.
Four moves, cheapest first:

1. **Distil the books, do not train on them.** Use a frontier model once to
   compress the 30 directing/marketing books into a compact playbook — hook
   patterns, retention structures, CTA forms — of a few thousand tokens. That
   becomes the local model's **system prompt**, permanently. Knowledge
   transfer without training: days, not months.
2. **Templates, because ad copy is formulaic.** *"The [product] that
   [benefit] without [pain]."* Filling slots is far more reliable than free
   generation — the same trick as the asset slots.
3. **Hosted-only for narration**, if local copy is weak. One feature needing a
   key, exactly as the hosted voice already works.
4. **Fine-tune, only if 1–3 fail.** And then on **ad-copy pairs, not books**:
   brief → script, taglines, VSL scripts. 500–2,000 pairs at a narrow
   generation task is legitimate and well understood.

---

## Word-level timing is an input, and an underused one

Whisper already returns word timings, and a forced aligner would sharpen them.
For ads this is not just captions: it is **punch-word drops** — a sticker, a
cut or a text hit landing exactly on the stressed word rather than near it.
The transcript and the beat grid together are two clocks, and the passes
should be given both.

---

## Rejected, and why

**CPT on 30 books.** Thirty books is ~3–5M tokens; continued pretraining
normally uses billions. But scale is not even the real problem: **books about
directing teach a model to talk about directing.** The task is "given these
assets and this music, output a cut list with frame numbers" — a different
distribution. You would get a model that writes beautifully about pacing and
cannot produce a timeline. Distil them into a prompt instead.

**SFT from reconstructed EDLs.** Running TransNetV2 + librosa over 100–200 ads
to recover edit decisions is a genuinely clever idea and the corpus is worth
building. But it recovers **the output, not the input** — shot 1 was 0.8s, the
cut landed on beat 3 — and never what footage the editor had, what they
rejected, why, or the brief. So it cannot teach inputs → edit. It can only
teach what a well-cut ad's rhythm looks like.

**And if that is what you extract, you do not need a model for it.** Shot
lengths and cut-to-beat alignment rates are a **table**. Keep the corpus,
store it as a pacing prior, and let `cutPlan.ts` read it. A histogram is
deterministic, testable, instant and debuggable; a neural net reproducing
"cut every 1.2 beats with variance X" is none of those. 200 examples is also
far below the floor for SFT.

**RAG over the features.** Technically trivial — BGE runs on the ONNX runtime
already here — but aimed at the wrong corpus. A compact catalogue of every
feature and its parameters is ~3,000–10,000 tokens and **fits in the prompt**.
RAG is for corpora that are large, changing and not authored by you; this one
is none of those. It also introduces a failure nobody can see: if retrieval
misses a feature, the model produces a confident plan without it and **you
cannot tell whether it chose not to use that transition or never saw it.**

RAG *does* earn its place over **content** — the 636 stickers, embedded as
`title + category + transcribed punchline`. Large, growing, semantic match is
the point, and it cannot fit in a prompt. Note **BGE is English-centric and
the sticker titles are Telugu and Hindi**; `bge-m3` is multilingual but much
bigger.

**MCP.** Worth separating from tool calling: MCP is a *protocol for exposing
tools to external clients*. If the model lives inside Forge it buys overhead,
not capability. It earns its place only if Forge should be driveable from
outside — someone editing a reel by talking to Claude Desktop. Interesting,
but a different product.

---

## Open questions — to measure, not to assume

**Can a 2B write usable ad copy?** Asserted here, twice, that it cannot. That
was never measured, and asserting an engine's limits without running it is the
exact failure `CLAUDE.md` exists to prevent — the same shape as "`scale`
supports `eval=frame`" and "git is blocked on macOS". **Try it before
believing it.** A 15-second ad script is a few hundred tokens with a strong
system prompt and a template; that is not obviously beyond a small model.

**Is Gemma's spatial reasoning good enough?** Try it alone before adding
Florence. Only add Florence for a caption that must dodge a subject exactly,
or a product name to be read rather than guessed.

**Is depth enough for subject placement?** It is already in the sidecar. Check
before adding anything.

**How will any of this be evaluated?** The quiet killer. Ten test briefs,
render the automated cut against a hand cut, judge blind. **Until that exists,
no improvement downstream is measurable** — including whether a fine-tune ever
helped.

---

## Build order

1. **Slot-based asset placement.** No AI in it at all.
2. **The plan schema and its validator.** The primitive everything else needs.
3. **The spine pass.**
4. **One feature pass — transitions**, because the registry, the beat analysis
   and `setTransition` all exist. Only the schema, the validator and the
   prompt are new.
5. The eval.
6. Everything else, one pass at a time.

If step 4 works on a 2B with real footage, the architecture is proven and the
rest is repetition. If it does not, a week was spent finding out instead of
three months.

---

## Built — `spine@2`, 24–25 September 2026

`direct()` and the eval now run `spine@2` (docs/PLAN.md §5.2–5.6). C0
measured `spine@1` failing where it asked a small model to TIME the ad — every
rejection was the model running out of cuts — so the model no longer times
anything. It chooses a **recipe**, a **hero** among the gate's candidates, one
text style and animation for the ad, and per shot a role, a weight (quick /
normal / hold), a camera move, a speed and a headline. The rhythm engine
(`rhythm.ts`) decides every frame on every beat of the song.

| file | what |
|---|---|
| `src/shared/director/schema2.ts` | the flat plan; the enums are the UNION of the offered recipes' lists (one decode, built before the model answers) |
| `src/shared/director/prompt2.ts` | one constant playbook (a server caches it); the music as a sentence, the recipes with their roles, the heroes, the slots — no cut table |
| `src/shared/director/validate2.ts` | repairs what `spine@1` rejected: order, a choice from another recipe's list, a hero that is not a candidate, a speed on a still, a ramp on a clip that speaks; still rejects a cut-off answer or the wrong shape |
| `src/shared/director/baseline2.ts` | the standard cut, as a directed ad: the tone's recipe (or the pinned one), the gate's best hero |
| `src/shared/director/compose.ts` | the plan handed to the rhythm engine; headline room checked in graphemes after timing |
| `src/shared/director/apply2.ts` | the ad as clips: shots, transitions on the engine's boundaries, the black and end card on V1, the recipe's look as one adjustment layer below the cards, the cards, the music trimmed and ducked |
| `src/shared/director/run.ts` | `gridsFor`, `menu2For` (how many shots the music holds is asked of the engine itself), `settle2` — the answer to the ad, the SAME code for the app and the eval |

**The recipe is the user's too**: the panel's Recipe picker pins one (Auto
lets the model choose among them all; without a model the tone decides —
`recipeForTone`), and a pinned recipe is the only one the prompt offers and
the one the standard cut uses. The panel says which recipe directed the ad and
which picture it was built around.

**The drawn pictures** — cards, the black and the end card's colour card, and
the look layer's own transparent square — are drawn after the one update,
history-less, as `spine@1`'s cards always were. A look library that will not
list leaves the ad ungraded, with a note, rather than failing the run.

**The eval's prepared files cannot hold the menu** — a recipe carries its
pacing as a function, which JSON drops — so they hold what the menu is built
FROM (the beat analysis, the gated slots, a pinned recipe) and `menuOf`
rebuilds it with `menu2For`. Its renders now carry the black, the end card's
ground and the recipe's grade; only the headline cards (drawn by the renderer)
are missing, as before.

`spine@1` decisions already in a project still load, as history; its code
(`schema.ts`, `validate.ts`, `apply.ts`'s `applySpine`) stays for them and for
the C0 numbers in docs/EVAL.md.

---

## Built — 21–22 September 2026

The spine pass, end to end, with **no model run against it yet**. That last
clause is the important one: everything below is tested against fixtures and
a fake server, and clicked through in the harness with the baseline plan. The
first live measurement is still ahead, and it is the one that matters.

### Where it lives

| file | what |
|---|---|
| `src/shared/director/menu.ts` | slots, cut candidates, transition families — the MENU the model picks from |
| `src/shared/director/schema.ts` | the plan's JSON schema; `spineSchema(menu)` puts the menu's ids in as enums |
| `src/shared/director/conforms.ts` | a checker for the flat subset of JSON Schema; refuses drift outside it |
| `src/shared/director/validate.ts` | the semantic rows: repair where unambiguous, reject where not; emits a LAYOUT |
| `src/shared/director/baseline.ts` | the standard cut — always validates; the fallback and the harness's provider |
| `src/shared/director/prompt.ts` | the playbook (system) and the menu as tables (user); `maxTokensFor` |
| `src/shared/director/apply.ts` | plan → ordinary clips, in one project; `clearDirector` undoes exactly its own work |
| `src/shared/director/provider.ts` | the contract, as voice: `ollama` and `openai` (LM Studio, llama-server, hosted) |
| `src/main/director.ts` | the two HTTP clients, status, image encoding |
| `src/renderer/src/store.ts` `direct()` | the runner; `fillAssetPath` for history-less bakes |
| `src/renderer/src/components/Director.tsx` | the panel, first in the Auto tab |

### What changed from the design above, and why

The transitions pass was **folded into the spine**: each segment carries an
`enter` family (`cut` or one that is installed) and the app picks the member.
One call instead of two — on CPU each call is seconds of prefill — and a
ten-item enum instead of twenty-five ids to invent. The N-pass runner shape
survives for captions and stickers, which genuinely need the spine first.

Seven fields per segment: `slot`, `role`, `ends_at`, `enter`, `headline`,
`punch_word`, `why`. `punch_word` is the word copied verbatim, not an index —
models are bad at counting and good at copying — and it lands on
`TextSpec.highlight` with a colour AND a scale, because with neither the
accent is invisible. `why` goes on the clip as its reason (DIRECTOR.md §3
step 5). `role` gained `offer`.

The design was reviewed adversarially before implementation — 24 agents, 18
findings confirmed — and the ones that would have shipped as bugs:

- **The music trim was a one-way edit.** Shortening the user's music clip to
  the ad, with `clearGenerated` unable to see it, meant every later run built
  its menu from the shorter clip: the ad could only ever shrink. `Clip.
  directorTrim` records the original; `clearDirector` restores it; the runner
  clears BEFORE building the menu.
- **N background bakes were N undo entries.** Five cards, six presses of
  Undo, five doing nothing visible. `fillAssetPath` never touches history;
  `addTextClip` and `rebakePaper` use it too.
- **Orphaned card assets became slots.** `clearGenerated` removes clips, not
  assets; a baked card with no clip has a real path and passed every filter.
  Slots now exclude `size === 0` — the mark every self-drawn asset carries —
  and `clearDirector` removes the cards' assets with them.
- **`cut_end` came from the decode window**, which buildReel already knew can
  come back seconds short of the clip. It now comes from the timeline length
  and the length asked for, and the ad is never longer than asked.
- **Re-sort was never safe.** `ends_at` is positional; sorting segments by
  slot hands every span to a different picture. Out of order rejects.
- **A flat 450-token cap could not hold twelve segments.** ~95 tokens each;
  the budget grows with the menu.

### The rows (validate.ts)

Reject: truncated answer · wrong shape · slots out of order · `ends_at` unknown,
on the start, or not after the previous · a segment under 0.4 s · nothing
left. Repair with a note: unknown or duplicate slot dropped · video capped at
its footage AND the next segment enters with a cut · first segment, or an
uninstalled family, becomes a cut · more than 60% of cuts with a transition
loses the quietest · a headline longer than reading speed allows (16 chars/s,
never under a 1.2 s card's worth) is dropped · a punch word that is not a whole
word of its headline is cleared.

### Two things to measure first, tonight or whenever a model is at hand

**`think: false` with `format` drops the schema on Ollama** for Gemma 4 and
Qwen 3.5 — an open bug (ollama/ollama #15260, #14645). The runner asks once
with thinking off and, if prose comes back, once more with it on. Which mode
works on which version is unknown until tried. LM Studio's OpenAI shape is
the other route and does not have this bug; it may have others.

**Can a 2–4B write the copy?** The open question above, still open.

### Not built

The planner that DRESSES the spine — text styles and animations, SFX on the
punch word, a look, grid split / strips / ring as per-segment treatments,
stickers (which need the semantic index) — is the next pass, and it is where
the library the app already has becomes the product. Slot placement is pool
order; a reorder UI is still to come. Images are plumbed to both clients and
not yet sent.
