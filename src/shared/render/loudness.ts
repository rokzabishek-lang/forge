/**
 * One export as loud as the next.
 *
 * Without this, how loud a video comes out is whatever the source happened to
 * be: a reel cut from a phone recording lands twenty decibels under one cut
 * from a mastered track, and the only way to find out is to watch them back to
 * back. Every platform measures loudness the same way now — integrated LUFS,
 * ITU BS.1770 — so the fix is to hit a number rather than to eyeball a meter.
 */

/** Integrated loudness targets worth offering, loudest first. */
export const LOUDNESS_TARGETS = [
  {
    lufs: -14,
    label: 'Social',
    hint: 'YouTube, Instagram, TikTok and Spotify all normalise to about this'
  },
  { lufs: -16, label: 'Podcast', hint: 'A little quieter, the usual spoken-word target' },
  { lufs: -23, label: 'Broadcast', hint: 'EBU R128, for anything going to television' }
] as const

/** The default for a new project. Absent on a project means OFF. */
export const DEFAULT_LOUDNESS = -14

/**
 * True peak ceiling, in dBFS.
 *
 * A decibel of headroom under full scale. Lossy encoders reconstruct a
 * waveform that can overshoot the samples they were given, so a file mastered
 * to exactly 0 clips once it is AAC — and every one of these goes out as AAC.
 */
export const TRUE_PEAK_CEILING = -1

/** Loudness range. 11 LU is loudnorm's own default and suits music and speech. */
const LOUDNESS_RANGE = 11

/** Targets outside this are not loudness normalisation, they are a volume bug. */
const MIN_TARGET = -40
const MAX_TARGET = -5

export function isLoudnessTarget(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_TARGET &&
    value <= MAX_TARGET
  )
}

/**
 * The filters that put the finished mix on target.
 *
 * Returns nothing when normalisation is off or the target is nonsense, so the
 * caller can splice the result in unconditionally and a project without it
 * produces exactly the graph it produced before.
 *
 * **`aformat` is not optional.** `loudnorm` resamples internally and emits
 * **192 kHz** — measured on this build, every time, whatever went in. Without
 * pinning the rate back, every export's audio would silently be 192 kHz
 * instead of the project's own rate: four times the samples into the AAC
 * encoder, and a file that disagrees with `settings.sampleRate` everywhere
 * else in the app reads it.
 *
 * The channel layout has to be pinned in the same breath. `loudnorm` followed
 * by a bare `aresample` fails outright — *"Cannot select channel layout for
 * the link between filters"* — because nothing downstream can work out what
 * came out of it. Every clip is forced to stereo before the mix, so the layout
 * here is never in doubt; saying so costs nothing and turns a class of render
 * failure into an impossibility.
 *
 * Single pass, deliberately. The two-pass form measures first and then applies
 * one static gain, which is more transparent — but it needs an analysis run
 * over the whole timeline before the render can start, and measured on this
 * build the single pass lands within **0.04 LU** of target across sources
 * spanning twenty-six decibels. That is far inside what anyone can hear, and
 * inside what the platforms re-normalise away regardless.
 */
export function loudnessFilters(target: number | undefined, sampleRate: number): string[] {
  if (!isLoudnessTarget(target)) return []
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return []
  return [
    `loudnorm=I=${target}:TP=${TRUE_PEAK_CEILING}:LRA=${LOUDNESS_RANGE}`,
    `aformat=sample_fmts=fltp:sample_rates=${Math.round(sampleRate)}:channel_layouts=stereo`
  ]
}
