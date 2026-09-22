/**
 * Hearing the sound while dragging the playhead.
 *
 * Every NLE does this, and it is not a nicety: finding the beat, the word or
 * the breath you want to cut on is done by ear, and a silent scrub means
 * guessing at a waveform and then playing back to check. Without it the only
 * way to place a cut on a downbeat is trial and error.
 *
 * The technique is the same everywhere — seek to the frame, let the sound run
 * for a moment, stop. What varies is how long the moment is and how often it
 * may repeat, and those two numbers are the whole design:
 *
 * - **Too short** and it is a click rather than a sound; a pitched note needs
 *   tens of milliseconds before it is recognisable at all.
 * - **Too long** and bursts overlap, which is heard as a stutter and, worse,
 *   lags behind the mouse — the sound stops belonging to where the playhead is.
 * - **Too often** and the seeks queue up faster than the decoder retires them.
 *
 * 80 ms at up to 12 a second: a burst is comfortably recognisable, and the
 * gap between bursts is longer than the burst itself, so a fast drag thins out
 * to a rhythmic sampling of the track rather than a smear.
 *
 * Pure, and driven by an explicit clock, so the throttle can be tested as a
 * sequence of decisions rather than by dragging something and listening.
 */

export const SCRUB_BURST_MS = 80

/** Twelve a second: bursts never overlap, and the gap is audible as a gap. */
export const SCRUB_BURSTS_PER_SECOND = 12
export const SCRUB_INTERVAL_MS = 1000 / SCRUB_BURSTS_PER_SECOND

export interface ScrubState {
  /** When the last burst started. */
  lastAt: number
  /** The frame it was fired for, so a still playhead does not re-fire. */
  lastFrame: number
}

/**
 * Nothing has fired yet, said in values rather than in a flag.
 *
 * `-Infinity` and not 0: a clock reading of 0 is a legitimate timestamp, and
 * treating it as "never" makes the throttle skip itself for as long as the
 * clock reads zero — which is every test, every harness run, and the first
 * moments of any page that resets `performance.now()`. It let bursts through
 * eight milliseconds apart, and the throttle only ever engaged by luck.
 *
 * `NaN` for the frame, because no frame equals it — so the first move of any
 * drag counts as a move, including a drag that starts at frame 0 or at some
 * negative frame a caller has not clamped.
 */
export const NO_SCRUB: ScrubState = { lastAt: -Infinity, lastFrame: Number.NaN }

/**
 * Whether to fire a burst now, and the state to carry forward.
 *
 * Returns the state unchanged when it declines, so a caller can assign
 * unconditionally and a declined frame cannot accidentally reset the throttle.
 */
export function scrubStep(
  state: ScrubState,
  frame: number,
  nowMs: number
): { burst: boolean; next: ScrubState } {
  /*
   * A playhead that has not moved is not a scrub.
   *
   * The draw loop runs on every animation frame whether anything changed or
   * not, so without this a preview sitting still on one frame would play the
   * same 80 ms twelve times a second, forever — a stuck note, and one that
   * would sound exactly like a bug in playback rather than like a scrub.
   */
  if (frame === state.lastFrame) return { burst: false, next: state }
  if (nowMs - state.lastAt < SCRUB_INTERVAL_MS) return { burst: false, next: state }
  return { burst: true, next: { lastAt: nowMs, lastFrame: frame } }
}
