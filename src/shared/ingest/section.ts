/**
 * Clipping a range before the download.
 *
 * Sheet 12: "a duration range bar with two handles", and the reason given is
 * the right one — it "saves pulling an hour-long video for eight seconds of
 * it". yt-dlp does this natively with `--download-sections`, which needs an
 * ffmpeg, and gets ours.
 *
 * The part the sketch cannot know about is that there are two ways to cut, and
 * they are very different:
 *
 *   FAST   copy the streams and start at the nearest keyframe at or before the
 *          mark. No re-encode, so a 40-second clip out of an hour takes about
 *          as long as 40 seconds of video should. The cut lands EARLY by up to
 *          one keyframe interval — a few seconds on typical YouTube encoding.
 *
 *   EXACT  `--force-keyframes-at-cuts`, which re-encodes around the marks so
 *          the cut lands where the handle is. yt-dlp's own help calls it
 *          "slow due to needing a re-encode", and on 4K it is slow enough that
 *          a user will think the app has hung.
 *
 * Neither is the right default for every case, so this does not pick one. What
 * it does do is make FAST honest: the range is padded outward, so the material
 * the user marked is definitely inside the file even though the boundaries are
 * loose, and they can put the ends exactly where they want on the timeline
 * afterwards — which is a thing this app happens to be, and a reason the fast
 * path is usually the better answer here even though it is the less precise one.
 */

export interface Range {
  startMs: number
  endMs: number
}

export interface SectionPlan {
  /** Arguments to append to the yt-dlp command. Empty for the whole video. */
  args: string[]
  /** True when the boundaries are approximate and want trimming afterwards. */
  approximate: boolean
  /** What was actually asked for, so the caller can trim to it on the timeline. */
  requested: Range | null
}

/**
 * How far outside the marks to fetch on the fast path.
 *
 * Keyframe intervals on streaming encodes are commonly two to ten seconds. Ten
 * covers the usual worst case; the cost of being generous is a few seconds of
 * extra video, and the cost of being stingy is material the user marked and did
 * not get, which is the failure they would actually notice.
 */
export const PAD_MS = 10_000

/** yt-dlp wants plain seconds; three decimals is finer than any frame rate. */
function stamp(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3)
}

export function sectionPlan(range: Range | null, exact: boolean): SectionPlan {
  if (!range) return { args: [], approximate: false, requested: null }

  const start = Math.max(0, Math.min(range.startMs, range.endMs))
  const end = Math.max(range.startMs, range.endMs)

  // A zero-length or inverted range is a UI slip, not an instruction. Taking
  // the whole video is recoverable; downloading nothing looks like a failure.
  if (end - start < 1) return { args: [], approximate: false, requested: null }

  if (exact) {
    return {
      args: [
        '--download-sections',
        `*${stamp(start)}-${stamp(end)}`,
        '--force-keyframes-at-cuts'
      ],
      approximate: false,
      requested: { startMs: start, endMs: end }
    }
  }

  return {
    args: ['--download-sections', `*${stamp(start - PAD_MS)}-${stamp(end + PAD_MS)}`],
    approximate: true,
    requested: { startMs: start, endMs: end }
  }
}

/**
 * Where the requested range sits inside a fast-path download.
 *
 * The file begins at the padded mark, except near the top of the video where
 * there was less than a pad's worth of room to give. Clamping at zero is what
 * keeps the offset right in that case, and getting it wrong would put every
 * clip taken from the first ten seconds of a video out by however much padding
 * did not fit.
 */
export function offsetIntoDownload(range: Range): number {
  return Math.min(PAD_MS, Math.max(0, range.startMs))
}

/**
 * Where the requested range sits in the clip that was placed.
 *
 * Pure, and in shared/ rather than inline in the store, because the renderer
 * has no tests and this is arithmetic with three ways to be wrong — one of
 * which it was: when the asset turns out shorter than the offset, an unclamped
 * `inPoint` points past the end of the media and the clip renders nothing.
 *
 * HONEST LIMIT, worth stating because the code cannot fix it: on the fast path
 * the file begins at the nearest keyframe AT OR BEFORE the padded mark, and how
 * much earlier that is cannot be known from here. `PAD_MS` is therefore a lower
 * bound on the head, so a fast cut can still carry a little unmarked pre-roll.
 * That is the trade the fast path exists to make — the exact option re-encodes
 * at the marks precisely because it does not have this problem.
 */
export function trimToRequestedRange(
  requested: Range,
  assetDurationFrames: number,
  fps: number
): { inPoint: number; duration: number } {
  const start = Math.min(requested.startMs, requested.endMs)
  const end = Math.max(requested.startMs, requested.endMs)
  const frames = (ms: number): number => Math.max(0, Math.round((ms / 1000) * fps))

  const total = Math.max(1, Math.floor(assetDurationFrames))
  // Never past the last frame: a download shorter than the pad would otherwise
  // place a clip whose in-point is beyond its own media.
  const inPoint = Math.min(frames(offsetIntoDownload({ startMs: start, endMs: end })), total - 1)
  const duration = Math.max(1, Math.min(frames(end - start), total - inPoint))
  return { inPoint, duration }
}

/**
 * Read a mark a person typed: `90`, `1:30`, `1:30.5`, `01:02:03`.
 *
 * Returns null for anything it cannot read, so the field can say so rather
 * than silently becoming zero — `Number('1:30')` is NaN, and NaN milliseconds
 * reaching `--download-sections` is how a range stops meaning anything.
 */
export function parseMark(input: string): number | null {
  const text = input.trim()
  if (!text) return null
  if (!/^\d{1,3}(:[0-5]?\d){0,2}(\.\d{1,3})?$/.test(text)) return null

  const parts = text.split(':')
  if (parts.length > 3) return null
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0)
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
}

/** `1:05.2`, or `1:02:03.0` once there is an hour to show. */
export function formatMark(ms: number): string {
  const total = Math.max(0, ms) / 1000
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total - hours * 3600) / 60)
  const seconds = total - hours * 3600 - minutes * 60
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  const ss = seconds.toFixed(1).padStart(4, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}
