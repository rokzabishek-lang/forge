/**
 * Level meters: how a number becomes a bar you can trust.
 *
 * The preview has analysers on every track since A3, and nothing read them. So
 * the one question a mix raises — *is this about to clip* — had no answer short
 * of exporting and listening for distortion.
 *
 * A meter is not just the level. Drawn raw, a peak reading flickers at the frame
 * rate and is unreadable; the standard fix is ballistics, and they are the whole
 * design:
 *
 * - **Instant attack.** A peak is shown the frame it happens. A meter that eases
 *   up to a transient under-reads exactly the moment that matters.
 * - **Steady fall.** It comes back down at a fixed rate in dB per second, so the
 *   bar moves smoothly instead of strobing between readings.
 * - **Peak hold.** The highest recent peak stays marked for a second and a bit,
 *   so a single loud word that clipped is still visible after it has passed.
 *
 * Pure and clocked by the caller, so it tests as a series of readings.
 *
 * One honest limit: this reads SAMPLE peaks from an `AnalyserNode`, not true
 * peak (dBTP), which needs oversampling to catch the peaks between samples. The
 * red zone therefore starts at −1 dBFS rather than exactly at 0, which is the
 * margin broadcast practice leaves for the difference.
 */

/** The bottom of the scale. Quieter than this is drawn as nothing. */
export const METER_FLOOR_DB = -60

/** Red from here up: a sample peak within 1 dB of full scale. */
export const METER_CLIP_DB = -1

/** How long the peak marker holds before it begins to fall. */
export const METER_HOLD_MS = 1200

/** How fast the bar and a released hold fall back. */
export const METER_FALL_DB_PER_SECOND = 24

export interface MeterState {
  /** The bar, in dB. */
  level: number
  /** The peak marker, in dB. */
  hold: number
  /** When the marker was last pushed up, in the caller's milliseconds. */
  heldAt: number
}

export const METER_SILENT: MeterState = {
  level: METER_FLOOR_DB,
  hold: METER_FLOOR_DB,
  heldAt: Number.NEGATIVE_INFINITY
}

/** A linear sample peak, 0..1+, to dB on the meter's scale. */
export function peakToDb(peak: number): number {
  if (!(peak > 0)) return METER_FLOOR_DB
  return Math.max(METER_FLOOR_DB, 20 * Math.log10(peak))
}

/**
 * One reading in: where the bar and the marker are now.
 *
 * `elapsedMs` is clamped, because a tab that was in the background for ten
 * seconds hands in one enormous step — and a meter that fell ten seconds' worth
 * in one frame is correct, but one that fell by a NaN or a negative is not.
 */
export function meterStep(
  state: MeterState,
  peak: number,
  nowMs: number,
  elapsedMs: number
): MeterState {
  const reading = peakToDb(peak)
  const fall = (METER_FALL_DB_PER_SECOND * Math.max(0, Math.min(10_000, elapsedMs))) / 1000

  const level =
    reading >= state.level ? reading : Math.max(reading, state.level - fall, METER_FLOOR_DB)

  if (reading >= state.hold) return { level, hold: reading, heldAt: nowMs }

  const holding = nowMs - state.heldAt < METER_HOLD_MS
  // A released marker falls at the bar's rate but never below the bar: a hold
  // marker under the level it is marking would be marking nothing.
  const hold = holding ? state.hold : Math.max(level, state.hold - fall)
  return { level, hold, heldAt: state.heldAt }
}

/** Where a dB value sits along the bar, 0 at the floor and 1 at full scale. */
export function meterFraction(db: number): number {
  if (!Number.isFinite(db)) return 0
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (0 - METER_FLOOR_DB)))
}

export function isClipping(db: number): boolean {
  return db >= METER_CLIP_DB
}
