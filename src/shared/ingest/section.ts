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
