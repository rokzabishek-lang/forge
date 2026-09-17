# Ingest — getting media in from a link

Sheets ⑥ and ⑫, built as one thing: paste a link, pick what you want, get a clip
on the timeline. `SHEETS.md` called this "the largest single hole, and upstream
of everything that already works" — the lyric chain, beat sync and the grid all
need music *in*, and until this there was no way to get it in.

**Status:** the pure layer and the main process are built and tested. The body
of the "soon" tab in the source bar is not yet drawn.

---

## Where things are

| layer | file | what |
|---|---|---|
| shared | `ingest/url.ts` | every YouTube link shape → canonical URL + a **safe key** |
| shared | `ingest/format.ts` | the quality ladder → a yt-dlp selector, **AV1 excluded** |
| shared | `ingest/section.ts` | the range picker → `--download-sections`, exact or fast |
| shared | `ingest/progress.ts` | our `--progress-template`, folded into one monotonic bar |
| shared | `ingest/args.ts` | the whole argv, and how to read the two marked lines back |
| shared | `ingest/release.ts` | which yt-dlp asset per platform, checksum parsing |
| main | `ingest/binary.ts` | find or fetch yt-dlp, verified |
| main | `ingest/download.ts` | spawn, parse, kill the tree, clean up, hand back the file |
| main | `ipc.ts` | a second `JobQueue`, `ingest:status` / `start` / `collect` |

Everything with a decision in it is in `shared/`, where it runs in a unit test
with no binary, no network and no electron — 39 tests over the pure layer, and
the download path itself is exercised end to end against a fake yt-dlp
(`tests/fixtures/fake-yt-dlp.mjs`) that speaks the same lines, on both CI
platforms.

---

## Decisions, and why

**yt-dlp is fetched on first use, not bundled.** It rots — YouTube changes
something every few weeks and a pinned copy stops working until the next app
release, for a tool whose whole job is keeping up. The current release is
fetched into `<userData>/tools/`, verified against the `SHA2-256SUMS` yt-dlp
publishes, and can be refreshed without shipping anything. Same precedent as
the depth model and Kokoro's voice files. Order of preference: `FORGE_YTDLP`,
our managed copy, then a copy already on PATH.

**Downloads have their own queue.** The render queue runs one job at a time
because exports are CPU-bound. A download is network-bound; behind an export it
would wait for nothing, in front of one it would hold it up for nothing. Two
queues, one merged list — the Inspector's existing bar, speed column and cancel
button work for downloads with **no renderer changes at all**.

**The file is named from the video id, never the title.** Titles routinely
contain `| ? " :`, every one illegal on Windows and needing escapes in a
filtergraph. The title becomes the asset's display name, where it can say
anything. The on-disk stem is `<key>.<kind>-<quality>[.r<start>-<end>]`, so
two asks for the same thing are one file and a second paste costs nothing.

**AV1 is excluded from every format branch.** Our Windows ffmpeg is a master
snapshot from 2018-12-17 and can neither mux nor decode it, while YouTube offers
`av01` at every size. The last-resort branch was missing the exclusion and a test
caught it: a single pre-muxed stream needs no merging, so it dodges the muxing
problem — and then cannot be decoded at all.

**The range picker offers both cuts.** *Exact* passes
`--force-keyframes-at-cuts`, which re-encodes and is slow on 4K. *Fast* copies
streams and lands early by up to a keyframe interval, so it pads outward by ten
seconds and the ends are placed exactly on the timeline afterwards — which this
app happens to be. Neither is right for every case; the UI should say which is
which.

**Progress is one bar, not two.** Above 720p YouTube stores video and audio
separately, so yt-dlp downloads twice and each reports its own 0–100%. Summing
bytes stops the visible reset; clamping stops the figure dropping when the
audio's size becomes known. Slightly optimistic in the middle, exact at the ends.

**A cancelled download leaves nothing behind.** yt-dlp writes `.part`, `.ytdl`
and `.f137.mp4` fragments. They are removed *before* the promise settles — the
rule `ffmpeg/run.ts` arrived at the hard way — and the match is precise, so
cancelling `abc.video-1080p` never touches `abc.video-1080p.r60000-90000.mp4`,
which is a different finished download of the same video.

**Cancel kills the tree.** yt-dlp spawns its own ffmpeg to merge. `killProcess`
from `ffmpeg/run.ts` — `taskkill /f /t` on Windows — is shared rather than
copied a third time.

---

## Things measured against the real binary

yt-dlp 2026.08.19 on the development Mac. The network is blocked here, so
these are the checks that do not need it.

- **Every flag we emit parses.** The full argv, run with a bogus URL, gets past
  the option parser and fails at the extractor stage — which is the failure it
  should have. `--progress-template`, `--print after_move:…`, `-P` with `-o`,
  `--download-sections *50.000-100.000`, `--progress-delta` are all accepted.
- **`--print` implies `--quiet`, and quiet drops the progress lines.**
  `--progress` overrides it; drop that one flag and the bar sits at 0% until the
  end. Pinned in `tests/ingestArgs.test.ts`, mutation-checked.
- **`--print` can also imply `--simulate`.** `--no-simulate` is passed
  explicitly even though a later-stage print disables it, because a download
  that quietly simulates is the worst kind of success.
- **A wrong `--ffmpeg-location` only warns.** "ffmpeg-location … does not
  exist! Continuing without ffmpeg". So a bad path would not fail — it would
  yield an unmerged download. The path is `FFMPEG_PATH`, which
  `assertBinaries()` already checks at startup.
- **`libmp3lame` is present**, so the mp3 option is a real re-encode.
- **`mkv` and `webm` are accepted extensions**, so a merge that lands in either
  still probes.

## Not yet measured, and how to

The format selector is *reasoned*, not verified — the sandbox cannot reach
YouTube. On any machine that can, this checks it without downloading anything:

    yt-dlp --simulate --print "%(format_id)s %(vcodec)s %(acodec)s %(height)s %(ext)s" \
      -f "<the 2160p selector from format.ts>" "<a 4K URL>"

If it prints `vp9`/`opus` or `avc1`/`mp4a` and never `av01`, the selector is
right. `yt-dlp --version` on the Surface, after the first fetch, is the other
one: that is where a missing Visual C++ runtime would show, and a clean machine
is the only place it can.

## Still to build

- The tab body: URL field, the four rungs with "All formats" behind a
  disclosure (only formats we can decode; the rest greyed **with the reason**),
  video / audio / mp3, the two range handles and the preview box, exact/fast.
- The collect step in the store: on `done`, `collectIngest` → `importAssets`
  path, then place the clip; for a fast-path range, set in/out to the requested
  range. Two clicks from paste to clip is the number to hit.
- Stems after download: "instrumental" and "vocal" are the existing
  `audio:stems` call on the finished file, not a new pipeline.
- Nothing cleans `<userData>/downloads/`. It is the first cache in the app big
  enough for that to matter.
