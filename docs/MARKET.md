# The market around Forge — templates people make, fill and sell

**Status: a future plan, not current work.** It begins when `docs/FIX.md`
Phases A–D are finished and stable — the editor has no known bugs, the
Director has been measured on a real model, and the dressing pass exists.
Written now so the idea survives the sessions between here and there, and
so every decision taken before then can be checked against it.

---

## 0. The idea

The app is free and open. The business is the **market around it**: a
wedding editor who has cut fifty highlight films saves one as a template;
a photographer who has never edited buys it, drops in their pictures, and
gets that cut — the same music, the same rhythm, the same text styles — in
minutes instead of hours. The author earns from every fill. The categories
are the niches the app already serves: weddings, photography, events,
product ads, and the Telugu and Hindi meme culture the sticker library came
from.

Three things make this more than a copy of CapCut's template gallery.
**The editor is local**, so a bought template renders on the buyer's
machine with nothing metered. **The Director can fill any template** — a
template is a spine, and filling slots from a brief is exactly the job it
was built for. And **every published template is a real human edit**, which
is the dataset `docs/LLM.md` said would write itself.

---

## 1. What a template is

A template is a **Forge project with slots marked**, saved in the same
versioned format every project already uses (`src/shared/project.ts`).

```ts
// on Clip — set only in a template, cleared on fill
slot?: {
  index: number                 // fill order, 1-based, shown to the filler
  kind: 'image' | 'video' | 'text'
  label: string                 // "hero shot", "the couple", "price line"
  hint?: string                 // "portrait works best", "under 4 s"
}
```

Everything without a slot mark is **the template**: cut positions, music,
transitions, text styles and animations, looks, motion, stickers, the
Director's own reasons if it built it. A template declares, once, in the
project file's header:

| field | why |
|---|---|
| `aspects` | which canvases it was made for; the store refuses others until re-solve is trusted |
| `fps`, `durationFrames` | so a filler knows what they are getting before they open it |
| `slots` summary | count by kind, so "needs 6 photos and 1 clip" is readable in a listing |
| `music` policy | `bundled` (library or author-owned with attestation) · `filler-supplies` (cuts re-planned by `planCuts` to their track) |
| `requires` | library packs it references by id (stickers, transitions, fonts), fetched on install if missing |
| `author`, `version`, `licence` | attribution, updates, and what a buyer may do |

**Save as template** marks the slots, strips the author's media from them
(keeping dimensions, so the layout survives), replaces system fonts with
bundled ones or declares a fallback, renders a preview mp4 locally at draft
quality, and writes the bundle: `template.forge.json` + `preview.mp4` +
`cover.jpg` + a manifest.

**Use template** opens it read-only, lists the slots in order with their
labels and hints, and fills them three ways: drag media onto a slot;
**Auto-fill** — the Director maps the pool onto the slots by kind and note;
or **Direct** — brief in, the Director fills slots *and* writes the text
slots. A filled video shorter than its slot gets the same honest treatment
the Director already gives (capped, noted). Then it is an ordinary project:
every clip editable, nothing hidden.

---

## 2. The two people

**The author** already edits. Their flow: finish an edit they are proud of →
*Save as template* → mark slots and write their labels → check the preview →
choose category, tags, aspects, price → publish. Later: see fills and
earnings; push an update (buyers are told, and keep the version they filled
with).

**The filler** may never have edited. Their flow: browse by category → watch
previews → get it (free) or buy it → *Use template* → drop their pictures
into six labelled boxes → Direct, or just export. Under ten minutes, on a
laptop, with no account needed for free templates and no upload of their
footage anywhere — the fill happens locally.

---

## 3. Stages and their prerequisites

### Stage 0 — before anything (this is FIX.md)

- A8: relative paths and relink, so a template made on one machine opens on
  another.
- A7: autosave and a stable, migrated project format — `SCHEMA_VERSION`
  becomes a promise the day a template leaves its machine.
- Phase C: the Director measured; Phase D: the dressing pass, so templates
  can carry looks and treatments the Director understands.
- A music library with redistribution rights, or the `filler-supplies`
  policy as the only one allowed for paid templates.

### Stage 1 — local templates (no network)

Save as template, Use template, slots panel, Auto-fill and Direct into a
template. Tested like every automation: a filled template produces
ordinary clips, one undo, cleared cleanly. This stage alone is worth
shipping: an author reuses their own cuts; an agency standardises on theirs.

### Stage 2 — free community templates (no server)

The pack pipeline exists and has shipped (`assets:packs`: manifest, sha256,
install, remove, progress). A template pack is one more entry in a manifest
hosted on GitHub, with the author's locally rendered preview as its
thumbnail. A *Templates* tab in the app lists them by category; install is
one click; removal is clean. Submission is a pull request or a form that
writes one — reviewed by a person against the rights rule below. No
accounts, no cloud render, no payments, no cost beyond hosting a few
megabytes each.

What Stage 2 tells us before any money moves: which categories people
fill, how long a fill takes, what breaks across machines and versions, and
whether authors show up at all.

### Stage 3 — the store

Only over a catalogue that exists. Adds accounts, listings, search,
ratings, reports, purchases, payouts, licences, updates, and analytics for
authors. Architecture in §6; money in §4; rights in §5.

### Stage 4 — the ecosystem

Brand kits (colours, logo, fonts applied to any template); template
variants per aspect; **remix lineage** (a template made from a template
credits its parent); requests and bounties ("a Telugu wedding invite
template, 9:16"); a creator programme (featured slots, revenue boosts for
consistent authors); bulk fill for agencies (the same template, forty
clients' photos, one queue); and the Director trained — if the eval ever
says training is needed — on the fills people kept.

---

## 4. Money

Numbers below are **assumptions to verify**, not facts; they are here so the
shape is visible.

| | proposal | verify against |
|---|---|---|
| free templates | always exist; the community stage is free by design | — |
| price range | ₹49–₹499 / $1–$8 per template; bundles per category | CapCut templates are free to fillers and pay authors per use ~; Envato items $10–$60 ~ |
| author share | **70 % to the author, 30 % to the platform** to start | Envato pays 55–87.5 % by exclusivity ~; app stores keep 15–30 % |
| processor | India: Razorpay / UPI; elsewhere: Stripe — or a **merchant of record** (Lemon Squeezy, Paddle, Gumroad) that handles GST/VAT and payouts for ~5–10 % | fee schedules change; read them the week before |
| tax | digital goods carry GST in India (18 %) and VAT abroad; a merchant of record collects it, a raw processor does not | an accountant, once |
| payouts | monthly, above a floor, with KYC — the merchant of record does this too | — |
| refunds | 7 days, no questions, capped per account; a fill that fails to open is always refunded | — |

**Why a merchant of record first.** Tax, invoices, payouts and KYC are the
work; a merchant of record does all of it for a fee, and the platform's own
processor can replace it later when volume makes the fee matter. The
alternative — an entity, a processor, GST registration, payout rails — is
months of non-code work before the first rupee.

**Costs.** Hosting bundles (a few MB each, tens of MB with music), a small
API, a database, a CDN: tens of dollars a month at the start. The
expensive thing is review — every paid template gets a human look (§5).

**What the platform does not sell:** compute. The fill renders on the
buyer's machine. This is the structural difference from every cloud tool in
`docs/COMPARISON.md`, and it means margin does not fall as usage rises.

---

## 5. Rights and trust

A marketplace lives or dies on this, so the rules are written before the
first listing.

**What may be inside a template.**
- Library assets by id — stickers, transitions, fonts, SFX the app ships or
  distributes as packs. Always allowed.
- The author's **own** footage and images, only as *examples* in slots
  (stripped on save) or as non-slot design elements they created.
- Music: from the platform's licensed library, or **none** (`filler-
  supplies`). Author-uploaded music is not allowed in paid templates until
  there is a rights-attestation flow and a takedown process to back it.
- No third-party brand marks, no celebrity likenesses, no footage the author
  cannot prove they own.

**Attestation.** Publishing a paid template means ticking, per asset class,
"I own this or have the right to distribute it", with the account on the
line. **Takedown**: a report form, a 72-hour response, the listing hidden on
receipt of a credible claim, restored on counter-notice. The author's share
on a taken-down item is held.

**Quality bar for paid listings.** Opens on both platforms; every slot
fills with an ordinary photo without breaking layout; preview matches the
result; labels and hints present; declared aspects true. Free listings need
only to open.

**Licence to the buyer.** Personal and commercial use of the *output*;
no resale of the template itself; the template file is not DRM'd — a bought
template is a JSON file and copying it is trivial, as CapCut's are. The
market sells convenience, updates and the gallery, not a lock.

**The filler's footage never leaves their machine.** Worth saying on the
store page, because it is the opposite of what every cloud tool does.

---

## 6. Architecture, when the store comes

Keep it small, and keep the app working when the store is down.

```
app (local) ── installs bundles ──▶ pack pipeline (exists)
   │                                     ▲
   │ browse / buy / publish              │ signed bundle URLs
   ▼                                     │
store API ── accounts, listings, search, ratings, reports, entitlements
   │
   ├── object storage + CDN for bundles and previews
   ├── Postgres for everything else
   └── merchant of record for money (or a processor, later)
```

- **Entitlements are files, not checks.** A purchase downloads the bundle
  plus a licence file; the app never phones home to open a template. Offline
  first, because the editor is.
- **Publishing is an upload of a bundle the app built**, including the
  preview it rendered. The server never renders video.
- **Versioning.** A template pins the `SCHEMA_VERSION` it was saved with;
  the app migrates forward on open, as it does for any project. Every
  schema change from Stage 1 onward ships with a migration and a test that
  opens a template from the previous version.
- **Search** is by category, tags, aspect, slot count, duration, language,
  music policy — the header fields, indexed. Semantic search over previews
  can come later.
- **Analytics for authors**: fills, sales, refunds, the aspects buyers chose.
  Nothing about the buyer's footage, which the server never sees.

---

## 7. How it feeds the Director

- **A template is a spine.** Filling one is the Director's narrowest job:
  the segments, cuts and styles are given; the model maps slots and writes
  the text slots. Templates make the local model *more* likely to succeed,
  not less.
- **Published templates are human edits with intent.** With the author's
  opt-in, the corpus of templates and the fills buyers kept is the
  preference data `docs/LLM.md` and `docs/research/architecture-plan-2026-09-11.md` said to collect before
  ever considering a fine-tune — arriving from normal use, labelled by what
  people paid for.
- **The eval grows on its own.** Each category's top templates are the
  hand cuts to judge the Director against.

---

## 8. What to measure

Stage 2: templates published per month; fills per template; time from
*Use template* to export (instrumented locally, reported only with consent);
cross-machine open failures; category demand. Stage 3: conversion from
preview to purchase; refund rate; author retention (second template);
takedowns per hundred listings; payout latency.

---

## 9. Risks, honestly

- **Nobody publishes.** Authors need a reason before buyers exist; seed
  the first fifty templates ourselves, per category, and pay the first
  external authors a flat fee.
- **Rights incidents early.** One viral takedown story ends a small market;
  hence the review bar and the music rule from day one.
- **Cross-version breakage.** A template that opens wrong after an update
  is a refund and a lost author; hence migrations with tests, every time.
- **The Director underdelivers on fills.** Then the market is still a
  market — drag-to-slot works without a model. The AI is the accelerator,
  not the product.
- **CapCut moves.** It already has the gallery, the users and free
  templates; it cannot have local rendering, an open format, or the
  editor's own automation filling the slots. Compete there.

---

## 10. Decisions to take before Stage 3, not now

1. Author share (70/30 proposed) and whether exclusivity pays more.
2. Merchant of record versus own processor for the first year.
3. Licence wording for buyers; whether agencies get a bulk licence.
4. The category set, and whether languages are categories or tags.
5. Minimum quality bar for paid listings, and who reviews.
6. Pricing in ₹ first or $ first, and regional pricing.
7. Whether authors may opt their templates into the Director's training set,
   and what they get for it.
