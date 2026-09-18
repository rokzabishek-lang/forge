# The meme sticker library

The plan, and what the source material actually is — measured rather than
assumed, because the answer changed the plan.

## Why this exists

Forge's first niche is weddings and photography, but the audience that can be
reached *directly* is content creators, and the thing that reaches them is
memes. Resolve and CapCut will not come looking for us; a library of viral
stickers that drag onto a timeline is the kind of thing people find on their
own.

The vault was scraped and then run through background matting on rented GPUs —
a real investment of time and money, and the reason this document is careful
about what survived that process.

## What is on disk

Two folders at the repository root, **gitignored** (`.gitignore`), because they
are 2.7GB of other people's footage. Only the catalogue that describes them
should ever be committed, the same split `/assets` already makes.

| folder | what | files |
|---|---|---|
| `Master_Viral_Meme_Vault` | the scraped originals | 840 |
| `Master_Viral_Meme_Stickers_COMPLETE 2` | the same set, matted | 845 |

Eleven categories, and the mix is the point — Telugu and Hindi punchlines,
global editing memes, reels audio hooks, SpongeBob cutaways, fails, tech
titans, streamers, Indian TV debates, standup, Middle Eastern culture.

## What is ACTUALLY in there — all 845 measured

The section above says 845 stickers. **There are 646.** Every number below comes
from probing all of them, not from sampling one.

| | files | |
|---|---|---|
| **usable stickers** | **646** | a subject survives keying |
| sound effects, not stickers | 105 | all of `04_Reels_Audio_Hooks_and_SFX` |
| dead — keying leaves nothing | 91 | **60 of them SpongeBob** |
| unreadable | 3 | |

**`04_Reels_Audio_Hooks_and_SFX` is not stickers.** It is sound effects that
happen to be delivered as mp4, and it is the only category where **not one file
has a green corner** — keying returns the whole 1920×1080 frame every time,
because there is nothing to cut out. The names say it plainly: *Duck Quack*,
*The Purge Siren*, *Party Horn*, *Windows Error Crash*, *Sad Hamster Violin*.
94 of the 105 carry loud audio. These belong with the 23 SFX already in the
asset library, taking it to **128 sounds** — not in a sticker pack.

**SpongeBob is gone.** 60 of 72 key to nothing: the file is flat green for its
whole duration, subject and all. Verified frame by frame on one — 100% green at
eight timestamps across fourteen seconds. The matting removed everything. 12
survive.

### Every sticker has audio, and the audio is often the joke

All 845 carry an AAC stream, and **92% are at −30 dB mean or louder** (category
means run −9 to −26 dB, peaks at 0 dB). This document used to plan them as
silent overlays, which for *"Telugu Comedy Reaction Hook"* or *"What! what the
fu"* throws away the punchline.

**Decided: keep the audio, muted by default.** It rides inside `colour.mp4` and
costs **+34%** — 62 KB per sticker, 114 MB → **152 MB** for the set, about 15 MB
per category pack. A sticker lands silent with a toggle in the inspector.
Muting what shipped is a checkbox; unmuting what did not means rebuilding and
republishing every pack.

### Two ways of counting that were both wrong

Worth writing down, because both looked authoritative and both were measuring
the wrong thing.

**One frame is not a clip.** Sampling green coverage at t=1s called 226 files
blank. Sampling ten points across each clip's duration rescued **89** of them —
their subject simply appears later.

**Green coverage measures SIZE, not absence.** Of the 137 still called blank,
looking at the pictures showed tiny figures floating in a huge green field —
a 384×346 subject in a 1920×1080 frame is 97% green and perfectly usable, because
cropping to the alpha box is the next step anyway. Switching the test to *"does
keying produce a box at all"* rescued **46 more**. The authoritative test is the
alpha bounding box, which is what the pipeline computes regardless.

Both were caught by looking at the frames instead of the numbers.

### `ffmpeg` eats stdin

Any shell loop of the form `find … | while read f; do ffmpeg -i "$f" …; done`
silently corrupts itself: ffmpeg reads stdin, consuming the file list feeding
the loop, so alternate entries arrive truncated at the front and fail with
`No such file or directory` on a path that visibly exists. **Pass `-nostdin`.**
The app is not exposed to this — `src/main` spawns with argument arrays, never a
shell — but every measurement script in this document is.

## The measurement that changed the plan

**The matted stickers carry no alpha channel.**

    codec_name=h264  pix_fmt=yuv420p     (120 of 120 sampled)

H.264 4:2:0 cannot hold an alpha channel at all. The matting output was
composited onto green rather than saved with its matte, so the per-pixel
transparency the GPU time bought is not in these files.

**It is recoverable, and better than it sounds.** The background is not a filmed
green screen with uneven lighting and spill — it is machine-generated and
perfectly flat:

    all four corners: (0, 254, 0)     72% of the frame green-dominant

Keying that is the easy case. Measured on a real sticker with
`colorkey=0x00FE00:0.30:0.10`:

| | |
|---|---|
| fully transparent | 68.7% — the background, gone |
| fully opaque | 27.6% — the subject |
| soft edge | 3.6% — antialiased, not a jagged binary cut |
| green fringe left | 0.67% — small, and a despill pass takes it |

That 3.6% soft edge is the encouraging number: a bad key produces a hard
1-pixel boundary, and this one has a real gradient.

What is permanently lost is precision at the boundary. H.264 4:2:0 subsamples
chroma 2×2, so the subject/green edge is smeared across two-pixel blocks before
anything keys it. Hair and motion blur suffer most. The result is good, not
perfect.

**The original mattes are gone.** The RunPod instance that produced them was
terminated long before this was written, so keying the green is the only path —
do not spend time looking for a better source. The green files are the source.

### The recipe, measured

Every number below came from running the chain on a real sticker from the vault
(`107 - Telugu Comedy Reaction Hook 107_sticker.mp4`, 1280×720, 4.9s). Three of
the four findings are counterintuitive, which is why they are written down.

**`colorkey` beats `chromakey`.** The keyer meant for video left MORE green
(5.59% vs 3.38%) and a harder edge. The green here is machine-generated and
mathematically exact, so plain RGB distance wins over YUV chroma distance.

**`despill` is the entire fix for fringing** — 3.38% → **0.00%**. Not a
refinement; the thing that matters.

**`blend` is the only real dial, and 0.10 is the answer:**

| blend | subject | soft edge | |
|---|---|---|---|
| 0.02 | 29.5% | 1.44% | too hard, aliased |
| **0.10** | **28.3%** | **2.40%** | **widest edge before damage** |
| 0.20 | 21.1% | 9.41% | eating into the subject |
| 0.35 | **5.1%** | 25.3% | subject destroyed |

Past 0.10 the key stops softening the edge and starts dissolving the person. At
0.35 only 5% of the subject is still solid. Anyone "improving" the softness by
raising this is making it worse.

**The chain:**

    colorkey=0x00FE00:0.30:0.10
      → despill=type=green
      → alphaextract → erosion → boxblur=1:1     (pull in 1px, feather)
      → alphamerge

## The packing pipeline, and what it costs

Keying is only half of what makes these look like stickers. The other half is
the crop — measured on the same file, the subject occupies **942×542 of
1280×720**, so cropping to content drops **45% of the pixels** and the sticker
stops being a person floating in an empty rectangle.

Per sticker, one pass:

1. key → despill (above)
2. `cropdetect` on the ALPHA, across the whole clip — the subject moves, so the
   box is the union over time, not one frame
3. crop to it, scale to 512 on the long edge (a sticker is an overlay)
4. erode 1px + feather the matte
5. encode a PAIR: `colour.mp4` crf 23, `matte.mp4` crf 26 (greyscale, compresses
   hard), recombined with `alphamerge` at render — which `plan.ts` already does
6. compare first and last frame → store `loops` on the catalog entry
7. record name, category, dimensions, duration

On the reference file: **180 KB** silent (128 colour + 52 matte), **242 KB**
with audio, and 1.2 s to encode a 4.9 s clip.

**The whole vault, built: 636 stickers and 105 sounds, 220 MB across 11
archives, 22 minutes.**

That is well over the 152 MB this document first projected, and the reason is
duration, not the recipe. The reference clip is 4.9 s and **the median sticker
is 6.0 s, p90 is 12 s and the longest is 18 s** — so per-sticker cost runs to
346 KB, not 242 KB. Extrapolating a size from one file is extrapolating its
length.

| pack | stickers | compressed |
|---|---|---|
| Telugu memes & punchlines | 118 | 38 MB |
| Middle Eastern culture | 52 | 30 MB |
| Global editing memes | 89 | 26 MB |
| Global memes & streamers | 57 | 23 MB |
| Indian standup & reality TV | 54 | 22 MB |
| Epic fails & accidents | 63 | 22 MB |
| Hindi meme punchlines | 90 | 19 MB |
| Indian TV debates | 55 | 19 MB |
| Tech & business titans | 51 | 16 MB |
| **Meme sound effects** | 105 sounds | 6 MB |
| SpongeBob cutaways | 7 | 0.4 MB |

Each is its own download, so a 38 MB worst case is fine — the asset library
itself is 57 MB. Nobody fetches 220 MB.

The crop box on the reference file measures **942×542 of 1280×720**, reproducing
the figure above exactly, and the recombined pair measures **53.6% solid
subject, 4.9% soft edge, 0.00% green**. The recipe is sound; it was the count of
files it applies to that was wrong.

Verified by recombining the pair: **45% clean, 48.7% solid subject, 6% soft
edge, 0.00% green.** The subject fraction nearly doubled from 28% purely from
the crop.

Runtime is about 2s per sticker, so the whole vault is ~30 minutes unattended,
once.

**Do NOT bake the die-cut border into the pack.** It would double the size, and
the matte is already shipped — growing it into an outline is four filters at
render time on a single sticker. Ship one matte, offer the border as a toggle.

### So: key once, at import. Never at render.

Chroma keying every frame on every preview and every export is wasted work and
a quality question the user should never be asked. The library should be
converted once, on the way in, and stored with real transparency.

Alpha-capable formats, measured against the bundled ffmpeg (2s of 256×256):

| format | alpha | size |
|---|---|---|
| FFV1 | yes | 11 KB |
| **QuickTime RLE (`qtrle`)** | yes | 16 KB |
| PNG-in-MOV | yes | 43 KB |
| ProRes 4444 | yes | 62 KB |
| **VP9 / WebM** | **NO — silently dropped** | — |

That last row is a trap worth remembering: the encoder accepted `yuva420p`,
wrote `yuv420p` and reported nothing.

`qtrle` is lossless and compresses flat cartoon content extremely well, but
these stickers are photographic cutouts of people, which is its worst case. The
right storage for those is the one the renderer already understands: **a colour
`.mp4` beside a matte `.mp4`, recombined with `alphamerge`** — both H.264, both
small, both decodable by the 2018 Windows build, and `plan.ts` already does
exactly this for masks.

## Two problems in the source material

**64 filenames are illegal on Windows.** 110 `|`, 6 `"`, 4 `?`, 4 `*` — because
the files are named from YouTube titles:

    India vs Pakistan Media Debate 😂 | Full Funny Clash | AndhBh.mp4
    Arnab Goswami ft. || Arnab Goswami funny Moments || Arnab Go.mp4

These cannot be copied to the Surface, and git cannot check out a tree
containing them. The fix is the one `src/shared/ingest/url.ts` already applies
to downloads: **name the file from a safe key, keep the title as display
metadata**. The catalogue is where a title with a pipe in it belongs.

**Six originals are AV1.** The same codec the ingest format selector excludes,
for the same reason: the Windows ffmpeg is a 2018-12-17 master snapshot and
cannot decode it. They play here and not there.

## How a sticker should behave on the timeline

The question that matters once they are draggable: a 2-second animated sticker
lands on a 30-second clip. What duration does it take?

**Its own. Never stretched.** Stretching a 2s reaction across 30s does not play
it slowly, it plays it at 1/15 speed — and with a meme the timing *is* the joke.
Three behaviours, and only two of them are offered:

- **One-shot** — plays once at natural speed and ends. Reactions, punchlines,
  gestures.
- **Loop** — repeats to fill the host clip. Ambient things: sparkles, fire,
  confetti.
- **Stretch** — never.

**And the app should choose, not ask.** Compare the first and last frame at
import: near-identical means it was authored to loop, very different means it is
a one-shot. Store the answer on the catalogue entry. The user drags a sticker
and it behaves correctly, having never seen a dialog — which is the difference
between a stack of features and one tool.

### Measured: this vault contains no loops

The method above is right and the answer for this source is **almost always
one-shot**. Across all 636, the first-to-last frame difference is one smooth
population — a hump at 20–50 with a thin tail to zero and **no gap anywhere**.
There is no threshold separating "authored to loop" from "happens to start and
end on a similar frame", because scraped meme footage contains no authored
loops. A meme is a punchline.

A first cut at delta < 12 called **129 of 636** loops, including **40 of 63
accident clips**. Repeating a ten-second accident to fill a thirty-second clip
is not something anybody asked for.

The two errors are not equally bad: a one-shot playing once never looks wrong,
a repeating punchline always does. So the rule is near-identical **and** short —
delta < 2 and under 3 s — which **6 of 636** meet. The mechanism stays for packs
that really are authored loops, which is what sparkles, fire and confetti will
be.

## Status

**Built: the pipeline and the catalog. Not built: placing one on the timeline.**

`scripts/build-stickers.mjs` walks the vault and emits one directory per
category, laid out the way `installPack` leaves it, so each goes straight to
`scripts/build-pack.mjs`:

    dist/stickers/stickers-telugu/stickers/<key>.colour.mp4
                                          /<key>.matte.mp4
                                          /index.json

Filenames come from a safe key with the title kept in the index, per "Two
problems in the source material" above — and `build-pack.mjs` refuses an illegal
name outright, so a pack that would break on Windows cannot be built.

`04_Reels_Audio_Hooks_and_SFX` goes to `sfx-meme-sounds` as plain `.m4a`. They
are ordinary sounds once the video is dropped — but the scanner did need one
change, because the files are numbered (`001-collect-item.m4a`) and a name
derived from that reads "001 collect item" 105 times over. It now prefers the
title the pack's index states, and takes the duration from it too, which
`SfxMeta` had always had a field for and never a value.

**Stripping a leading number in the fallback would have been wrong**: the
library's own `808 boom` becomes `boom`. An index prefix and a name that begins
with digits cannot be told apart by looking, so only a pack that states a title
gets one, and every hand-placed library is left exactly as it was.

### What the catalog knows

`StickerMeta` is now a union — `form: 'emoji'` for the codepoint SVGs,
`form: 'clip'` for a keyed pair — and `CATALOG_VERSION` is 2 so old caches are
thrown away rather than guessed at. A clip carries its matte, dimensions,
duration, `loops` and `hasAudio`.

The metadata comes from the pack's `index.json`, not from probing: a clip's
title and loop behaviour are decisions made once at build time and cannot be
read back off a filename, and probing 646 files on every scan would cost more
than the entire rest of the walk. A corrupt index costs its own pack's stickers
and nothing else, and an index naming a path outside its directory is refused.

### Three quality gates, each from a file that got through without them

- **No subject after keying** — 91 files, 60 of them SpongeBob.
- **Subject on screen under 0.4s** — the clip is dead air with a flash at one
  end. Found because `12 - Tomorrow` shipped 2.0s of blank: it has a single
  stray frame of content at t=0 and the rest at t=1.9, so taking the outer
  envelope of content frames called it a 1.9s subject filling the whole clip.
  **The measure is the longest CONTIGUOUS run**, not first-to-last.
- **Under 24px after scaling** — `MIN_SUBJECT` guards the source box, and a
  1510×41 subtitle bar passes it happily, then scales to 512×14.

Everything else is trimmed to its content range, which is worth real time:
*Two very boring minutes later* goes 4018ms → 1267ms.

### Placing one, and drawing it

**Built.** A sticker drags from the Library onto the timeline like any other
asset and exports correctly.

The matte lives on the **asset**, as `MediaAsset.matte` — a property of the
file, travelling with every copy. `clip.matte` is an unrelated feature that
points at another clip on the timeline. Main resolves the pairing from the
catalog when the asset is placed, rather than trusting a path from the
renderer, and takes the title from the same entry: the filename is a safe key
like `13-tomorrow-for-sure` and the words live in the catalog.

**At render**, the matte is an extra input seeked exactly like the colour it
belongs to, turned into a grey stencil and multiplied into the same chain that
carries masks and wipes. Through the multiply rather than straight to
`alphamerge`, because `alphamerge` REPLACES alpha — a sticker that is also
masked would otherwise lose one of the two shapes.

**In the preview** the problem is different and was nearly a trap. The existing
matte compositor uses `destination-in`, which reads the shape's ALPHA. That
works for a text PNG, where the bright parts and the opaque parts are the same
parts. A sticker matte is opaque grey everywhere, so `destination-in` keeps the
whole rectangle — a green box pasted over the shot.

Canvas 2D has no luma-to-alpha operator, but it accepts an SVG filter, and
`feColorMatrix` writes alpha from a weighted sum of RGB. **Measured in the
harness: input luma 0/85/170/255 comes out as alpha 0/85/170/255 exactly**, on
the GPU, with no per-pixel pass. `color-interpolation-filters="sRGB"` is
load-bearing — the SVG default is linearRGB, which would gamma-shift the matte
and soften every edge.

Verified on a real sticker through that exact path: **63.8% solid subject, 4.1%
soft edge, 0.00% green visible**, and the picture checked by eye rather than by
the numbers.

### Seeing one in the Library

Each sticker ships a **cut-out still**, `<key>.thumb.webp`, taken from the
middle of the finished clip.

Without it the drawer is 636 blank tiles. The Library grid draws every asset
with an `<img>`, and a clip sticker is an mp4 — so the pack installs, the
catalog is right, and the user sees nothing, which is this project's favourite
kind of bug.

**WebP, not PNG.** These are photographic cut-outs, which is exactly PNG's worst
case. Measured on a real sticker at 128px:

| | |
|---|---|
| PNG | 25.6 KB → 15.5 MB for 636 |
| PNG, palette | 8.0 KB → 4.9 MB |
| **WebP q75** | **2.8 KB → 1.7 MB** |

Nine times smaller, and alpha survives (verified: 62.2% solid, 7.0% soft edge,
0.00% green, and looked at on a checkerboard). The bundled ffmpeg has no
libwebp, so ffmpeg composites the pair and `sharp` — already a dependency —
does the encode.

The tile also shows the **title** for a clip sticker, where an emoji tile shows
none: the character IS the emoji's name, but two reaction faces are only
distinguishable by their words.

### The sound, and two bugs it uncovered

A clip sticker lands with `volume: 0`, and the inspector grew a **Sound** row —
a mute toggle and a level — for any clip whose asset has audio.

That row had to exist, because shipping the audio without it turned out to be
worse than not shipping it:

**Nothing in the app could set `clip.volume`.** The render has always honoured
it (`volume=` in the audio chain) and no control anywhere wrote it, so every
clip played its source at full volume with no way to say otherwise. A sticker
landing muted would have been a sticker that could never be heard.

**The preview ignored it for video clips.** Only the audio-track pool applied
`clip.volume`; a video track's sound played at full volume whatever the clip
asked for, so the preview and the export disagreed. Invisible until stickers
arrived, because until then nothing ever set a volume to anything but 1.

### Still to build

`loops` is stored and not yet obeyed: every sticker plays once, which for this
vault is the right answer 630 times out of 636.
