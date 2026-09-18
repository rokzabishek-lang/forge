#!/usr/bin/env node
/**
 * Turn the meme vault into sticker packs.
 *
 *   node scripts/build-stickers.mjs "Master_Viral_Meme_Stickers_COMPLETE 2" dist/stickers
 *
 * One directory per category, laid out the way `installPack` will leave it, so
 * each can be handed straight to `scripts/build-pack.mjs`:
 *
 *   dist/stickers/stickers-telugu/stickers/<key>.colour.mp4
 *                                         /<key>.matte.mp4
 *                                         /index.json
 *
 * What it does per sticker, and why — every number here is measured, and
 * `docs/STICKERS.md` has the workings:
 *
 * 1. **Find the subject.** `cropdetect` on the ALPHA, accumulated over the whole
 *    clip, because the subject moves and the box has to be the union over time.
 *    A clip with no box has no subject: 91 of the vault key to nothing at all,
 *    60 of them SpongeBob, and they are skipped rather than shipped blank.
 * 2. **Crop to it.** The reference sticker's subject is 942×542 of 1280×720, so
 *    cropping drops 45% of the pixels and the sticker stops being a person
 *    floating in an empty rectangle.
 * 3. **Key and despill.** `colorkey` beats `chromakey` here because the green is
 *    machine-generated and exact; `despill` takes the fringe to 0.00%.
 * 4. **Scale down to 512 on the long edge, never up.** A 384px subject
 *    upscaled to 512 is bigger bytes and no more detail.
 * 5. **Encode a pair**, colour + matte, recombined with `alphamerge` at render —
 *    which `plan.ts` already does for masks, and which the 2018 Windows ffmpeg
 *    can decode.
 * 6. **Keep the audio**, muted by default in the app. 92% of the vault is at
 *    conversational loudness or louder, and for a talking meme the sound is the
 *    joke. Costs 34%.
 * 7. **Decide one-shot vs loop** by comparing the first and last frame, so the
 *    app never has to ask.
 *
 * `04_Reels_Audio_Hooks_and_SFX` is not stickers — not one of its 105 files has
 * a green corner, and keying returns the whole frame. They are sound effects in
 * mp4 clothing, and come out as plain audio for the SFX library instead.
 */

import { execFile } from 'node:child_process'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path
const FFPROBE = require('@ffprobe-installer/ffprobe').path

/** The category that is sounds, not stickers. */
const SFX_CATEGORY = /^04_/
/** Below this in either axis there is no subject worth shipping. */
const MIN_SUBJECT = 16
/** A sticker is an overlay, not a background. */
const MAX_EDGE = 512
/** Less subject-time than this and it is dead air, not a sticker. */
const MIN_SPAN = 0.4
/** Below this on either axis, after scaling, it is a sliver not a subject. */
const MIN_OUTPUT = 24
/**
 * What it takes to call a clip a loop — and it is deliberately almost nothing.
 *
 * Measured across all 636: the first-to-last frame difference is ONE smooth
 * population, a hump at 20-50 with a thin tail to zero and no gap anywhere. So
 * there is no threshold that separates "authored to loop" from "happens to
 * start and end on a similar frame", because this vault contains no authored
 * loops at all — it is scraped meme footage, and a meme is a punchline.
 *
 * A first cut at 12 marked 129 of them as loops, including 40 of 63 accident
 * clips. Repeating a ten-second accident to fill a thirty-second clip is not
 * something anybody asked for.
 *
 * Both errors are recoverable with a toggle, but they are not equally bad: a
 * one-shot playing once never looks wrong, and a repeating punchline always
 * does. Hence near-identical AND short, which 6 of 636 meet. The mechanism
 * stays for packs that really are authored loops — sparkles, fire, confetti —
 * where the delta genuinely is near zero.
 */
const LOOP_DELTA = 2
const LOOP_MAX_MS = 3000

const KEY = 'colorkey=0x00FE00:0.30:0.10,despill=type=green'

/* ------------------------------------------------------------------ shell */

/**
 * `-nostdin` on every ffmpeg, without exception.
 *
 * ffmpeg reads stdin, and a pool of them will happily consume whatever this
 * process is reading from — which corrupts a file list in a way that surfaces
 * as `No such file or directory` on a path that visibly exists.
 */
function ffmpeg(args) {
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-nostdin', '-hide_banner', ...args], { maxBuffer: 1 << 26 },
      (err, stdout, stderr) =>
        resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
  })
}

function ffprobe(args) {
  return new Promise((resolve) => {
    execFile(FFPROBE, args, { maxBuffer: 1 << 24 },
      (err, stdout) => resolve(err ? null : String(stdout).trim()))
  })
}

function rawFrame(file, seek, width, height) {
  const before = seek.sseof ? ['-sseof', seek.sseof] : ['-ss', seek.ss]
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-nostdin', '-v', 'error', ...before, '-i', file, '-vframes', '1',
      '-vf', `scale=${width}:${height}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
      { encoding: 'buffer', maxBuffer: 1 << 24 },
      (err, stdout) => resolve(err || stdout.length < width * height * 3 ? null : stdout))
  })
}

/* ------------------------------------------------------------------ names */

/**
 * A filename-safe key, and the title kept separately.
 *
 * The vault is named from YouTube titles, so 64 of them carry `|`, `"`, `?` or
 * `*` and cannot exist on Windows at all. Same split `src/shared/ingest/url.ts`
 * already makes for downloads: the file gets a safe key, the catalogue keeps
 * the title.
 */
function keyFor(file) {
  return basename(file)
    .replace(/\.mp4$/i, '')
    .replace(/_sticker$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'sticker'
}

function titleFor(file) {
  return basename(file)
    .replace(/\.mp4$/i, '')
    .replace(/_sticker$/i, '')
    .replace(/^\d+\s*[-–]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `01_Telugu_Memes_and_Punchlines` → `stickers-telugu-memes-and-punchlines`. */
function packIdFor(category) {
  const slug = category
    .replace(/^\d+_/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/, '')
  return `stickers-${slug}`
}

/* ------------------------------------------------------------------ probe */

async function probe(file) {
  const text = await ffprobe(['-v', 'error', '-show_entries',
    'stream=codec_type,width,height:format=duration', '-of', 'json', file])
  if (!text) return null
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  const video = (parsed.streams ?? []).find((s) => s.codec_type === 'video')
  if (!video) return null
  return {
    width: video.width,
    height: video.height,
    hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === 'audio'),
    durationMs: Math.round(parseFloat(parsed.format?.duration ?? '0') * 1000)
  }
}

/**
 * Where the subject is, in space and in time — both from one decode.
 *
 * The box comes from `cropdetect` accumulated over the whole clip, because the
 * subject moves and the box has to be the union. The time range comes from
 * `signalstats` on the same alpha: **YMAX, not YAVG.** A frame holding any
 * solid subject pixel has YMAX 255 and an empty one has 0, which is a clean
 * binary signal — where YAVG for a small subject in a 1920×1080 frame is a
 * fraction of one unit and indistinguishable from noise.
 *
 * Returns null when there is no subject at all, which is 91 of the vault.
 */
async function subject(file) {
  const { stderr, stdout } = await ffmpeg(['-i', file, '-vf',
    `${KEY},alphaextract,cropdetect=limit=8:round=2:reset=0,` +
    `signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-`,
    '-f', 'null', '-'])

  const crops = [...stderr.matchAll(/crop=(\d+):(\d+):(-?\d+):(-?\d+)/g)]
  const last = crops.at(-1)
  if (!last) return null
  const box = { w: +last[1], h: +last[2], x: +last[3], y: +last[4] }
  if (box.w < MIN_SUBJECT || box.h < MIN_SUBJECT || box.x < 0 || box.y < 0) return null

  // `frame:12 pts:… pts_time:0.4` then `lavfi.signalstats.YMAX=255`
  const frames = []
  let pending = null
  for (const line of stdout.split('\n')) {
    const at = line.match(/pts_time:([0-9.]+)/)
    if (at) { pending = parseFloat(at[1]); continue }
    const value = line.match(/YMAX=([0-9.]+)/)
    if (value && pending !== null) {
      frames.push({ at: pending, content: parseFloat(value[1]) > 200 })
      pending = null
    }
  }
  const run = longestRun(frames)
  if (!run) return null
  return { box, from: run.from, to: run.to }
}

/**
 * The longest stretch the subject is CONTINUOUSLY on screen.
 *
 * Not the outer envelope of every frame with content, which is what this did
 * first — and one SpongeBob card has a single stray frame of content at t=0,
 * then 1.8s of nothing, then the real subject at the end. Taking first-to-last
 * called that a 1.9s subject filling the whole clip, so it was neither trimmed
 * nor rejected, and shipped as 1.8 seconds of blank followed by a flash.
 *
 * A few empty frames inside a run are tolerated: a subject that blinks is still
 * one subject, and splitting on every gap would chop a flickering sticker into
 * fragments.
 */
function longestRun(frames) {
  const GAP = 3
  let best = null
  let start = null
  let lastContent = null
  let gap = 0
  for (const frame of frames) {
    if (frame.content) {
      if (start === null) start = frame.at
      lastContent = frame.at
      gap = 0
      continue
    }
    if (start === null) continue
    if (++gap > GAP) {
      const span = lastContent - start
      if (!best || span > best.to - best.from) best = { from: start, to: lastContent }
      start = null
      gap = 0
    }
  }
  if (start !== null && lastContent !== null) {
    const span = lastContent - start
    if (!best || span > best.to - best.from) best = { from: start, to: lastContent }
  }
  return best
}

/**
 * Trim a sticker to when its subject is actually on screen.
 *
 * Several of these are blank for most of their runtime — one SpongeBob card is
 * empty until 1.9s of 2.0s — and a sticker that shows nothing for the first two
 * seconds after it is dropped reads as broken, not as comic timing.
 *
 * A range covering most of the clip is left alone rather than shaved by a
 * frame. A range too SHORT is not trimmed either — it is rejected upstream,
 * because 0.1s of subject in a 2s clip is not a sticker with a slow start, it
 * is 1.9s of nothing.
 */
function trimRange(range, durationMs) {
  const duration = durationMs / 1000
  const span = range.to - range.from
  if (span > duration * 0.9) return null
  // A little air either side; the subject fading in is part of it.
  return { from: Math.max(0, range.from - 0.05), to: Math.min(duration, range.to + 0.05) }
}

/** Fit inside MAX_EDGE without ever enlarging, and keep both axes even. */
function targetSize(box) {
  const scale = Math.min(1, MAX_EDGE / Math.max(box.w, box.h))
  const even = (n) => Math.max(2, Math.round((n * scale) / 2) * 2)
  return { width: even(box.w), height: even(box.h) }
}

/**
 * Was this authored to loop?
 *
 * First frame against last. Near-identical means it was built to repeat, very
 * different means it is a one-shot — and the app stores the answer rather than
 * asking, because a user dragging a reaction onto a clip should not be shown a
 * dialog about playback semantics.
 *
 * Measured on the ENCODED sticker, not the source, so it describes what
 * actually ships — and the last frame is seeked with `-sseof`, which seeks from
 * the end. Computing it as `duration - 0.05` returned nothing for half of them:
 * the container's duration and its last decodable frame are not the same
 * instant, and the difference is more than a frame on a short clip.
 */
async function loopDelta(colour) {
  const [a, b] = await Promise.all([
    rawFrame(colour, { ss: '0' }, 32, 32),
    rawFrame(colour, { sseof: '-0.2' }, 32, 32)
  ])
  if (!a || !b) return null
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/* ------------------------------------------------------------------ build */

async function buildSticker(file, outDir) {
  const info = await probe(file)
  if (!info) return { file, skipped: 'unreadable' }

  const found = await subject(file)
  if (!found) return { file, skipped: 'no subject after keying' }
  const { box } = found

  // On screen for a blink: 1.9s of empty followed by a flash is not a sticker.
  if (found.to - found.from < MIN_SPAN) return { file, skipped: 'subject on screen under 0.4s' }

  const trim = trimRange(found, info.durationMs)
  const { width, height } = targetSize(box)
  /*
   * Checked AFTER scaling, not before.
   *
   * `MIN_SUBJECT` guards the source box, and a 1510×41 strip passes it happily
   * — then scales to 512×14, which is a sliver nobody can see. These are
   * subtitle bars that survived the key, not subjects.
   */
  if (width < MIN_OUTPUT || height < MIN_OUTPUT) {
    return { file, skipped: `too thin to be a subject (${width}x${height})` }
  }
  const key = keyFor(file)
  const colour = join(outDir, `${key}.colour.mp4`)
  const matte = join(outDir, `${key}.matte.mp4`)

  /*
   * `format=rgba` before the split, or the alpha is gone.
   *
   * Format negotiation runs backwards through the graph: the colour branch ends
   * at yuv420p, and without this the whole chain settles on a format with no
   * alpha channel and `alphaextract` fails with "Requested planes not
   * available" — after the key has already done its work.
   */
  const graph =
    `[0:v]${KEY},crop=${box.w}:${box.h}:${box.x}:${box.y},` +
    `scale=${width}:${height},format=rgba,split[c][a];` +
    `[c]format=yuv420p[colour];` +
    `[a]alphaextract,erosion,boxblur=1:1,format=yuv420p[matte]`

  const audio = info.hasAudio
    ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '96k']
    : ['-an']

  // Input seeking, so the trim is cheap and the audio follows the video.
  const seek = trim ? ['-ss', trim.from.toFixed(3), '-to', trim.to.toFixed(3)] : []

  const { err, stderr } = await ffmpeg([
    '-v', 'error', '-y', ...seek, '-i', file, '-filter_complex', graph,
    '-map', '[colour]', '-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
    '-pix_fmt', 'yuv420p', ...audio, colour,
    '-map', '[matte]', '-c:v', 'libx264', '-crf', '26', '-preset', 'medium',
    '-pix_fmt', 'yuv420p', '-an', matte
  ])
  if (err) return { file, skipped: `encode failed: ${stderr.split('\n')[0]}` }

  const delta = await loopDelta(colour)
  const finalMs = await probe(colour)
  const sizes = await Promise.all([stat(colour), stat(matte)])

  return {
    file,
    entry: {
      key,
      title: titleFor(file),
      colour: basename(colour),
      matte: basename(matte),
      width,
      height,
      durationMs: finalMs?.durationMs ?? info.durationMs,
      hasAudio: info.hasAudio,
      loops:
        delta !== null && delta < LOOP_DELTA && (finalMs?.durationMs ?? info.durationMs) <= LOOP_MAX_MS,
      loopDelta: delta === null ? null : Math.round(delta * 10) / 10
    },
    bytes: sizes[0].size + sizes[1].size,
    trimmed: trim ? { from: +trim.from.toFixed(2), to: +trim.to.toFixed(2), was: info.durationMs } : null,
    source: { width: info.width, height: info.height, box }
  }
}

/** A sound effect: the audio, without the video nobody will ever see. */
async function buildSfx(file, outDir) {
  const info = await probe(file)
  if (!info) return { file, skipped: 'unreadable' }
  if (!info.hasAudio) return { file, skipped: 'no audio' }
  const key = keyFor(file)
  const out = join(outDir, `${key}.m4a`)
  const { err, stderr } = await ffmpeg([
    '-v', 'error', '-y', '-i', file, '-vn', '-c:a', 'aac', '-b:a', '128k', out
  ])
  if (err) return { file, skipped: `encode failed: ${stderr.split('\n')[0]}` }
  const { size } = await stat(out)
  return { file, entry: { key, title: titleFor(file), file: basename(out), durationMs: info.durationMs }, bytes: size }
}

/* ------------------------------------------------------------------- main */

async function main() {
  const [vault, outRoot] = process.argv.slice(2)
  if (!vault || !outRoot) {
    console.error('usage: node scripts/build-stickers.mjs <vault-dir> <out-dir>')
    process.exit(1)
  }
  const only = process.argv.includes('--only')
    ? process.argv[process.argv.indexOf('--only') + 1]
    : null

  const categories = (await readdir(vault, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter((name) => !only || name.includes(only))
    .sort()

  const report = { built: 0, skipped: [], packs: [], startedAt: new Date().toISOString() }

  for (const category of categories) {
    const isSfx = SFX_CATEGORY.test(category)
    const packId = isSfx ? 'sfx-meme-sounds' : packIdFor(category)
    const kindDir = join(outRoot, packId, isSfx ? 'sfx' : 'stickers')
    await rm(join(outRoot, packId), { recursive: true, force: true })
    await mkdir(kindDir, { recursive: true })

    const files = (await readdir(join(vault, category)))
      .filter((n) => n.toLowerCase().endsWith('.mp4'))
      .map((n) => join(vault, category, n))
      .sort()

    process.stdout.write(`\n${category}  (${files.length} files${isSfx ? ', sounds' : ''})\n`)

    const queue = [...files]
    const results = []
    let done = 0
    const worker = async () => {
      for (;;) {
        const file = queue.shift()
        if (!file) return
        const result = isSfx ? await buildSfx(file, kindDir) : await buildSticker(file, kindDir)
        results.push(result)
        done++
        process.stdout.write(`\r  ${done}/${files.length}   `)
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))

    const kept = results.filter((r) => r.entry)
    const lost = results.filter((r) => r.skipped)
    const bytes = kept.reduce((n, r) => n + r.bytes, 0)

    // Sorted, so the index is stable and the archive is reproducible.
    kept.sort((a, b) => a.entry.key.localeCompare(b.entry.key))
    await writeFile(
      join(kindDir, 'index.json'),
      JSON.stringify({ version: 1, category, [isSfx ? 'sfx' : 'stickers']: kept.map((r) => r.entry) }, null, 2)
    )

    process.stdout.write(
      `\r  ${kept.length} kept, ${lost.length} skipped, ${(bytes / 1048576).toFixed(1)} MB\n`
    )
    report.built += kept.length
    report.packs.push({ packId, category, kept: kept.length, skipped: lost.length, bytes })
    for (const r of lost) report.skipped.push({ file: r.file, why: r.skipped })
    if (!isSfx) {
      const loops = kept.filter((r) => r.entry.loops).length
      report.packs.at(-1).loops = loops
    }
  }

  await mkdir(dirname(join(outRoot, 'report.json')), { recursive: true })
  await writeFile(join(outRoot, 'report.json'), JSON.stringify(report, null, 2))

  const total = report.packs.reduce((n, p) => n + p.bytes, 0)
  console.log(`\n${report.built} assets, ${(total / 1048576).toFixed(0)} MB across ${report.packs.length} packs`)
  console.log(`${report.skipped.length} skipped — see ${join(outRoot, 'report.json')}`)
  console.log('\nThen archive each one:')
  console.log(`  for d in ${outRoot}/*/; do node scripts/build-pack.mjs "$d" "dist/$(basename "$d").tar.gz"; done`)
}

await main()
