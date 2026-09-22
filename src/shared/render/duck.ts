/**
 * Ducking: music steps back when someone speaks.
 *
 * The export does it with `sidechaincompress`, keyed off the dialogue mix
 * (`plan.ts`). The preview cannot use that filter — it has no ffmpeg — so it
 * runs the same law over a level read from an `AnalyserNode` instead. Two
 * implementations of "how much quieter" is exactly the kind of pair that drifts
 * until the preview teaches a balance the export does not deliver, so the
 * settings live here, once, and both read them.
 *
 * What is NOT claimed: sample accuracy. ffmpeg's detector runs per sample and
 * the preview's runs per animation frame, so the preview's duck is the same
 * depth arriving at roughly the same moment, not the same waveform. That is the
 * honest limit of previewing a compressor in a browser, and it is enough for
 * the judgement people actually make here — *is the music too loud under the
 * voice*.
 */

/**
 * The one set of numbers.
 *
 * Measured by ear on narration over music and left alone since: a low threshold
 * so ordinary speech triggers it, a high ratio so the step is decisive, a fast
 * attack so the first syllable is not buried, and a slow release so the music
 * does not pump between words.
 */
export interface DuckSettings {
  /** Linear level above which the music starts to give way. */
  threshold: number
  /** How hard it gives way once it does. */
  ratio: number
  /** Milliseconds to come down. */
  attackMs: number
  /** Milliseconds to come back. */
  releaseMs: number
  makeup: number
}

export const DUCK: DuckSettings = {
  threshold: 0.03,
  ratio: 12,
  attackMs: 25,
  releaseMs: 400,
  makeup: 1
}

/** The filter the render uses, built from the settings above. */
export function duckFilter(settings: DuckSettings = DUCK): string {
  return (
    `sidechaincompress=threshold=${settings.threshold}:ratio=${settings.ratio}:` +
    `attack=${settings.attackMs}:release=${settings.releaseMs}:makeup=${settings.makeup}`
  )
}

/**
 * Where the gain wants to be for a given key level — the compressor's static
 * curve, before any attack or release.
 *
 * Below the threshold nothing happens. Above it, every dB over is reduced by
 * `1 - 1/ratio`, which is what a ratio means: at 12:1, twelve dB over the
 * threshold comes out one dB over.
 */
export function duckTarget(keyLevel: number, settings: DuckSettings = DUCK): number {
  const level = Math.max(0, keyLevel)
  if (level <= settings.threshold) return 1
  const overDb = 20 * Math.log10(level / settings.threshold)
  const reductionDb = overDb * (1 - 1 / Math.max(1, settings.ratio))
  return 10 ** (-reductionDb / 20)
}

/**
 * One step of the follower: where the gain is now, given where it was.
 *
 * A one-pole smoother, with the time constant chosen by DIRECTION — coming down
 * is the attack and going back up is the release. That asymmetry is the whole
 * character of a ducker: without it, either the first word is buried or the
 * music pumps between them.
 *
 * Pure, and stepped by an explicit `elapsedMs`, so it can be tested over a
 * series of levels without a clock and behaves identically whether the preview
 * is running at 60 frames a second or dropping to 20.
 */
export function duckStep(
  gain: number,
  keyLevel: number,
  elapsedMs: number,
  settings: DuckSettings = DUCK
): number {
  const target = duckTarget(keyLevel, settings)
  const timeMs = Math.max(1, target < gain ? settings.attackMs : settings.releaseMs)
  /*
   * `1 - e^(-dt/τ)` rather than a fixed step per frame.
   *
   * A fixed step would make the duck's speed depend on the frame rate, so a
   * busy timeline would duck more slowly than an idle one — the preview
   * changing its own mix depending on how hard it is working.
   */
  const alpha = 1 - Math.exp(-Math.max(0, elapsedMs) / timeMs)
  const next = gain + (target - gain) * alpha
  return Math.max(0, Math.min(1, next))
}
