## Findings

### Run 1 — Gemma 4 E2B in LM Studio, the spine as built (2026-09-23)

`google/gemma-4-e2b` on the user's Mac, `json_schema` strict, text only (images
are plumbed and not sent), ten briefs with synthetic media (their names, notes
and speech are what the spine reads — see `docs/PLAN.md` §3.1). Asked through the
harness relay because the development sandbox's shell cannot reach localhost.
Not yet rated by the user: the copy and preference columns are empty until
`npm run eval:rate`.

**The architecture holds on a 2B.** 10 of 10 answers were valid JSON in the
schema's shape, none truncated, every id on the menu — strict `json_schema` on
LM Studio does what `format` was meant to do on Ollama. 8–13 s a plan on this
Mac, ~800–930 prompt and 330–540 output tokens. 58 of 62 headlines fit the time
their shot gives them.

**It fails the C0 bar before any copy is rated: 7 of 10 landed.** And all three
rejections have ONE cause — the model used every slot and ran out of cuts
(`slot_N ends on cut_end, which is not after the segment before it`). That is
not a shape failure; it is the model shaping a pacing curve over the menu,
which is exactly what `spine@2` stops asking it to do (`PLAN.md` §5.2: "the
rhythm engine times; the model weights").

**The menus are too sparse to choose from.** 7–11 cuts for 6–8 photos, gaps up
to 5.5 s; `fashion-perfume` has 6 slots and 7 cuts, so using every photo leaves
no choice at all. `buildCutMenu` offers one candidate per `chooseBeatsPerCut`
step; C2's rhythm engine needs every beat as a candidate.

**The copy ignores the language.** All four Telugu and Hindi briefs came back
with every headline in English (24 of 24 in Latin script) — "language for all
copy: Telugu" is in the prompt and had no effect. The one knob that must be
tried first: the instruction in the system prompt, in the target language, and
a one-line example.

**The skeleton is applied to everything.** Every ad runs hook → problem →
product → proof → offer (→ cta), a wedding included ("Moments fade quickly" as
the problem of a wedding film). An **offer** segment appears in 6 of the 7
briefs that have no offer. The playbook's skeleton is doing this; recipes
(C2) replace it with a grammar per kind of ad.

**It asks for a transition on nearly every cut** — 3 or 4 of 5 boundaries in
most plans, capped by the validator at 60 %.

**The clip gets the long last shot, and the ad goes black.** Where the clip is
last in the user's order, the model gave it the longest segment: 1.1–3.0 s of
black after the footage in three ads. The validator reports it; nothing
prevents it. The rhythm engine will (a shot is never longer than its footage).

**The renders show the next slideshow tell: letterboxing.** A 4:5 or 1:1 photo
in a 9:16 ad sits between black bars (`tests/output/evalPipeline/shot2.png`).
Commercials fill the frame; the recipes must crop to fill, around the subject.

### Knob 1 — the language rule (2026-09-23)

The four Telugu and Hindi requests of run 1, re-asked with one change: a rule
in the system prompt, in the target script, with an example headline, and
the language named again as the last line of the user prompt. **24 of 24
headlines came back in the language's own script** (against 0 of 24). Two
new faults showed: an Arabic word inside a Telugu headline (a script leak),
and the brand "Paradise Spice" mistransliterated as "పరాధి స్పైస్". Adopted
into `prompt.ts` — the rule generic in the playbook so the system prompt stays
one cacheable prefix, the language and its script in the user prompt, brand
names kept as the brief writes them.

**Headline capacity counts the wrong thing for Indic scripts.** It counts code
points; a Telugu or Devanagari vowel sign or virama is a code point of its
own, so "పెళ్లి కూతురు సిద్ధం" counts 20 where a reader sees about 12, and was
dropped as too long. `PLAN.md` §9's per-language capacity is real, and it
should count grapheme clusters (`Intl.Segmenter`), then measure what fits.

### Run 2 — all ten with the language rule (2026-09-23)

The language rule holds on the full ten, brand names now left as written
("Paradise Spice biryani", "Chill Brew", "Swiggy"). English copy unchanged in
kind.

**And it found the worst failure yet.** Twice (`product-serum`,
`event-fest`, both English) the model stopped after ONE segment — its `why`
cut off by the schema's 60-character limit mid-sentence ("…students in
Hyderabad about"), after which it closed the whole plan — and the validator
passed `product-serum` as **used**: a 20-second brief became a one-second ad.
A one-line change to the system prompt was enough to tip two English briefs
into it. Two fixes, both in: the decoder allows a `why` 100 characters (the
panel still keeps 60; 7 of 115 `why`s had hit the old cap), and the validator
**rejects a plan that stops before 75 % of the ad** — the standard cut is the
honest answer. Re-scored under the new rule: run 1 **7/10**, run 2 **6/10**
landed — the two "used" one-second ads are rejections now, as they should
always have been.

### The eyes — a first look probe (2026-09-23)

Real photographs are still to come from the user, so this is a probe, not the
VLM half of C0: three frames from real footage (two men laughing; four men in
a festive courtyard; one man in a suit in a crowded courtroom) and a test
pattern, through the look pass on Gemma 4 E2B in LM Studio — image and strict
schema together work, **2.0–3.5 s and ~300 + ~65 tokens a picture** on this
Mac. The words were right from the first try ("two men laughing indoor
setting"). The lists were not, and three changes fixed most of it, one probe
each:

| probe | change | people (truth: 2, 4, 1, none) | test pattern | notes |
|---|---|---|---|---|
| 1 | as designed | one, one, one, none | "usable" | the counts contradicted the model's own words ("two men" → one) |
| 2 | people as counts (none/one/two/group), "count the subjects", words BEFORE the lists | two, two, one, none | "usable" | faster; the brief's product leaked into the words ("… wedding film") |
| 3 | the product named only for `product_visible` | two, two, one, none | **weak** | no leak |

So: the four-man scene is still counted as two — a small VLM counts the
foreground — and `hero` is lenient on anything but the obviously empty, which
is why it is only ever a filter beside the measurements.

**Memory:** LM Studio refused to load `gemma-4-e4b` beside the resident E2B —
"insufficient system resources" — so the second configuration waits until E2B
is unloaded. What the images add to time and memory is unmeasured until real
photos are supplied (`FORGE_EVAL_MEDIA`).

### The first real ad — the user's serum photos on Gemma 4 E2B (2026-09-26)

`npm run eval:real` (`tests/eval/real.eval.test.ts`): four Good Molecules
Hyaluronic Acid Serum listing photos (2000×2000, two on a white studio
backdrop, two with the shop's own text baked in) and a 143.6 BPM techno track,
brief "deep hydration that plumps fine lines", premium, 15 s, recipe left to
the model — through the whole Director, the headline cards drawn by the app's
own type renderer in the harness, rendered at 1080×1920 with the standard cut
beside it. Run `tests/output/eval/real-serum-e2b/` (README.md has everything).

**The eyes work on real pictures.** 2.5–4.0 s a photo, 299 + ~65 tokens; every
look named the product, the count was right (the model shot: "one"), the words
were concrete ("bottle serum dropper liquid glass cap label text"). `hero` was
"usable" for all four — a 2B does not rank, as expected, which is why it is
only a filter. **The plan landed first time** (8.5 s, 1215 + 335 tokens):
Product reveal, the woman with the bottle as hero, hook "Good Molecules
Serum" with "Serum" the punch word, "Shop now" on the hero, no repairs.

**Three findings, two fixed the same day:**

1. **The gate called both white-backdrop photos blown** (71 % and 61 % of
   their pixels clip to white, by design), so the box and the bottle on white
   could never be the hero and the prompt told the model they were "measured
   blown". Fixed: `vision.measure` now sets `backdropClip` apart — clipped
   white in regions touching the frame's edge (`scipy.ndimage.label`) — and
   the gate judges what clips INSIDE the picture (`gate.ts`, PLAN §4.2).
2. **The Hero style's end card drew SHOP NOW through the product's name**: the
   painter stepped from a small row to a big one by the small row's line
   height, and the big caps climbed over it. Fixed in `textPaint.ts` — each
   baseline steps by the row above's descent plus its own ascent — with
   `tests/textPaint.test.ts` driving the painter through a stand-in canvas.
3. **A square photo cover-cropped to 9:16 loses its sides**: the hook photo's
   "HOW TO LAYER" text and half the bottle were out of frame, the model shot's
   baked text too. Fixed the same day: a picture whose reframe would keep
   less than two thirds of it is shown whole over a blurred, darkened copy of
   itself on a lane the Director adds under the ad — the editor's own
   "Blurred background" drop (`apply2.ts` `BACKDROP_KEEP`, PLAN §5.5).
   Re-rendered from the same answer in `tests/output/eval/real-serum-e2b-backdrop/`:
   every photo whole, the copy soft above and below it.

Also: the photos were AVIF and the app could not import them at all
(EFFECTS.md §31, fixed the same day). Still open: the hook card "Good
Molecules Serum" sits over the photo's own baked "HOW TO LAYER" text — the
look's words say "label text", so the Director could learn to place a card
lower, or choose a cleaner hook. Not yet rated blind by the user.
