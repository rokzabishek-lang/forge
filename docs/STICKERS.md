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

Measured output:

| | |
|---|---|
| per sticker | **187 KB** (133 colour + 54 matte) — **29% of the original** |
| all 845 | **~154 MB**, vs 539 MB raw |
| **one category pack** | **~14 MB** |

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

## Status

Not built. `AssetKind` already includes `'sticker'`, so the catalogue has a
place for these; what does not exist is the import conversion, the alpha
storage, the loop detection, or the drag-to-canvas path.
