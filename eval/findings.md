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

**Memory:** LM Studio refused to load `gemma-4-e4b` beside the resident E2B —
"insufficient system resources" — so the second configuration waits until E2B
is unloaded. What the images add to time and memory is unmeasured until real
photos are supplied (`FORGE_EVAL_MEDIA`).
