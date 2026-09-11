# Asset library — what we have and where it belongs

Catalogued from the existing `viral-director-studio` asset library. **1,803 entries.**

| Kind | Count | Format | Lands in |
|---|---|---|---|
| **Fonts** | 88 | ttf/otf/ttc | Captions + titles — Phase 2 |
| **Stickers** | 1,239 | Noto emoji SVG, named by codepoint | Overlays — Phase 4/6 |
| **Transitions** | 412 | 7 SVG + 405 grayscale luma masks | Transitions — Phase 4 |
| **Titles** | 50 | OpenShot/Inkscape SVG, 1920×1080 | Title cards — Phase 2/4 |
| **SFX** | 8 | WAV, 120 ms – 1.1 s | Beat-synced audio — Phase 4 |
| **Props** | 6 | 3D-rendered PNG | Overlays — Phase 4/6 |

Not yet catalogued (no read access this session, but present in the same tree):
`kokoro/` 316 MB, `models/` 256 MB, `onnx/` 64 MB, plus `audio/`, `presets/`, `profiles/`,
`textures/`, `videos/`, `social_ctas/`, `sample_photos/`.

---

## How the catalog works

A build-time scan (`scripts/scan-assets.mjs`) produces a manifest; the app never walks the
filesystem at startup. Entries store paths **relative to an assets root** resolved at
runtime, so "what assets exist" stays independent of "where they are installed" — the same
manifest serves dev and a packaged build.

```bash
node scripts/scan-assets.mjs <assets-root> assets/catalog.json
```

Output: 304 KB for 1,803 entries. Query helpers (`searchCatalog`, `entriesOfKind`,
`findEntry`) live in [`src/shared/assets/catalog.ts`](../src/shared/assets/catalog.ts) and are
pure, so the asset browser is testable without touching disk.

---

## Fonts — 88, split two ways

**77 bundled, 11 system.** The system set — Arial, Impact, Futura, Georgia, Tahoma, Verdana,
Comic Sans MS, Courier New, Copperplate, Trebuchet MS — already exists on macOS and Windows.
Referencing them by family name instead of shipping the file saves several MB and means the
app isn't redistributing someone else's font for zero benefit. The catalog records
`source: 'system' | 'bundled'` so the renderer knows whether to emit an `@font-face` or just
a `font-family`.

Three fonts declare a restriction in their own filename and are tagged `restricted`:
`Dunker_PERSONAL_USE_ONLY`, `FirstEncounter_PERSONAL_USE_ONLY`, `Mooligat Demo`. Tagged, not
excluded — the flag is there so the UI can group or filter them however you decide.

Fonts are consumed twice, and both paths need the file:
- **Graphics layer** — `@font-face` in the Chromium compositor
- **ffmpeg burn-in** — ASS `fontsdir`, or `drawtext fontfile=`

## Titles — 50 SVG templates, 49 with editable text

All 1920×1080, all carrying `<text>` nodes (1–2 slots each). This is the genuinely valuable
find: they aren't flat images, they're **templates**. Substitute the text content and render
in the graphics layer, and you get a designed title card driven by data — which is exactly
what the director needs to emit (`{"op": "title", "template": "title:gold-top", "text": "..."}`).

## Transitions — baseline and rich set

The 405 `extra` files are **720×576 grayscale JPEG luma masks**: pixel brightness determines
the order in which each pixel flips from A to B, so animating a threshold across the mask
produces the wipe.

Two tiers, deliberately:
- **Baseline — ffmpeg `xfade` built-ins.** ~21 transitions (fade, wipe, slide, circleopen,
  radial, pixelize, zoomin…), no asset files, works today. Listed in `BUILTIN_TRANSITIONS`.
- **Rich — the 405 luma masks.** Needs threshold animation. Cheap in the graphics layer
  (CSS `mask-image` or canvas compositing); fiddly in raw ffmpeg (`geq`/`maskedmerge`). Since
  the graphics layer is being built anyway for captions, that's where these belong.

Per `DIRECTOR.md` §11.1 the director picks a transition *by id* at a beat-grid *id* — so the
transition library is a menu, and both tiers are just entries in it.

## SFX — already supported

All eight are 120 ms – 1.1 s: whoosh, riser, impact, glitch, shutter, cyber scan, TV static,
808 boom. The standard viral vocabulary.

**These already work.** The audio-track mixing just added to the render plan positions clips
with `adelay` and mixes with `amix` — which is precisely how an SFX lands on a beat. Drop a
whoosh on the audio track at `beat_88` and it renders correctly today.

---

## Open decision — where the files live

The six catalogued directories total ~75 MB (transitions 46 MB, fonts 21 MB, stickers 8 MB).
Three options, none chosen yet:

1. **Commit into `assets/`** — simplest, but 75 MB of binaries in git history is heavy for an
   open-source repo. Git LFS mitigates it.
2. **Ship as a separate download** — small repo and installer, fetched on first run alongside
   the models. Consistent with the model strategy in `STACK.md` §8.
3. **Reference in place via config** — zero copying now, fine for development, not shippable.

Option 2 fits the existing plan best: the app already has to fetch ~600 MB of models on first
run, so an assets bundle rides along with the same download, progress and integrity
machinery. Nothing here is blocked in the meantime — the catalog's relative paths mean the
decision can be made later without rework.
