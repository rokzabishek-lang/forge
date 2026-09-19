/**
 * The bars of a waveform drawn on a timeline clip.
 *
 * Separate from the drawing because the drawing is the easy half. The hard half
 * is that a clip shows a WINDOW of its source — trimmed at both ends, and
 * consuming `duration × speed` frames of file per `duration` frames of
 * timeline — while the peaks array spans the whole file. Get that mapping wrong
 * and the picture is confidently, silently, of the wrong part of the sound.
 *
 * `src/main/waveform.ts` produces the peaks. This turns them into rectangles.
 */

export interface WaveBar {
  x: number
  width: number
  /** Distance from the top of the box, in pixels. */
  top: number
  height: number
}

export interface WaveBarsInput {
  /** Interleaved min/max pairs, -1..1 — exactly what `peaksFor` returns. */
  values: number[]
  buckets: number
  /**
   * How many frames of SOURCE the peaks array spans.
   *
   * Derived from the peaks' own `durationMs`, not from the asset's duration:
   * the array is indexed by position in the decoded audio stream, and a video
   * whose container says ten seconds can easily carry eight of sound. Indexing
   * by the longer number stretches the whole waveform.
   */
  analysedFrames: number
  /** Offset into the source of the clip's first frame. */
  inPoint: number
  /** Frames of source the clip shows — `duration × speed`. */
  sourceFrames: number
  width: number
  height: number
  /** Pixels per bar. Two is legible without drawing a bar per pixel. */
  barWidth?: number
  /** Fraction of the half-height a full-scale sample reaches. */
  headroom?: number
}

const DEFAULT_BAR = 2
const DEFAULT_HEADROOM = 0.86

/**
 * One bar per `barWidth` pixels, each the loudest thing in the slice of source
 * under it.
 *
 * Aggregating rather than sampling matters in both directions. Zoomed out, a
 * three-minute song is three hundred pixels of a three-thousand-bucket array:
 * taking every fifteenth bucket would show whichever fifteenth happened to land
 * there, so a snare could vanish entirely and the picture would flicker as you
 * zoomed. Zoomed in, several bars share one bucket and simply repeat it, which
 * is honest — there is no more detail in the array to show.
 */
export function clipBars(input: WaveBarsInput): WaveBar[] {
  const {
    values,
    buckets,
    analysedFrames,
    inPoint,
    sourceFrames,
    width,
    height,
    barWidth = DEFAULT_BAR,
    headroom = DEFAULT_HEADROOM
  } = input

  if (buckets <= 0 || values.length < 2) return []
  if (!(width > 0) || !(height > 0)) return []
  if (!(analysedFrames > 0) || !(sourceFrames > 0)) return []

  const usable = Math.min(buckets, Math.floor(values.length / 2))
  const mid = height / 2
  const step = Math.max(1, barWidth)
  const columns = Math.ceil(width / step)
  const bars: WaveBar[] = []

  for (let c = 0; c < columns; c++) {
    const u0 = (c * step) / width
    const u1 = Math.min(1, ((c + 1) * step) / width)

    const from = ((inPoint + u0 * sourceFrames) / analysedFrames) * usable
    const to = ((inPoint + u1 * sourceFrames) / analysedFrames) * usable

    let b0 = Math.floor(from)
    let b1 = Math.ceil(to)
    // A column narrower than one bucket still covers one.
    if (b1 <= b0) b1 = b0 + 1
    if (b1 <= 0 || b0 >= usable) continue
    // Past the end of the sound — a clip trimmed beyond where the audio stops
    // has nothing to draw there, and drawing the last bucket instead would
    // invent a tail that is not in the file.
    b0 = Math.max(0, b0)
    b1 = Math.min(usable, b1)

    let low = 1
    let high = -1
    for (let b = b0; b < b1; b++) {
      const min = values[b * 2]
      const max = values[b * 2 + 1]
      if (min < low) low = min
      if (max > high) high = max
    }
    if (high < low) continue

    const crest = mid - high * mid * headroom
    const trough = mid - low * mid * headroom

    /*
     * A near-silent bucket still gets a pixel, centred on where the signal
     * actually is rather than hanging below it. Growing the bar downwards from
     * its crest put every quiet bar half a pixel low, which over a quiet
     * passage reads as the whole waveform sagging off the centre line.
     */
    let top = crest
    let tall = trough - crest
    if (tall < 1) {
      top = (crest + trough) / 2 - 0.5
      tall = 1
    }
    bars.push({ x: c * step, width: step, top, height: tall })
  }

  return bars
}

/**
 * How many buckets to ask the main process for, given how long the source is.
 *
 * A fixed count is wrong at both ends: six hundred buckets over a ten-minute
 * podcast is one per second, so a two-second clip cut out of it gets two bars,
 * and six hundred over a half-second whip is far more than the pixels can show.
 * Twenty per second puts a bar every two or three pixels at ordinary timeline
 * zoom, which is where beats stop being visible if you go lower.
 */
export function bucketsForSource(durationFrames: number, fps: number): number {
  const seconds = durationFrames / Math.max(1, fps)
  if (!Number.isFinite(seconds) || seconds <= 0) return 200
  return Math.min(4000, Math.max(200, Math.round(seconds * 20)))
}
