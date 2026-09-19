/**
 * The timeline's own clock.
 *
 * **No media element is the clock.** The playhead advances from real time and
 * every picture and sound is driven to match it — which is the ordinary NLE
 * model, and the opposite of what this app did before.
 *
 * What it did before: `layers.find(l => l.element is a playing <video>)`,
 * bottom track upwards, and that element's `currentTime` *was* the playhead.
 * Two things fall out of that, and both are bugs nobody would find by reading:
 *
 *   - **A sticker becomes the clock.** Stickers are video elements. On a photo
 *     montage there is no video on the bottom track, so a 700ms reaction
 *     governs global time — and the first niche here is weddings and
 *     photography, where a montage of stills is the common case.
 *
 *   - **Music is never the clock.** The search only ever looked at video
 *     clips; audio-track elements live in a different pool it never consulted.
 *     So a montage with a music bed ran the playhead off wall time while the
 *     music played independently, and the two drifted. For an app whose
 *     headline is beat-synced editing, the picture sliding against the music
 *     is the one failure that matters most.
 *
 * Making the timeline authoritative deletes the question rather than answering
 * it. There is no "which element" any more, so neither bug has anywhere to
 * live, and the answer no longer changes depending on what happens to be under
 * the playhead.
 *
 * Pure: no DOM, no React, no `performance.now()` of its own — `now` is passed
 * in. That is what makes the rule testable, which the old one, buried inside a
 * `requestAnimationFrame` callback, was not.
 */

export interface ClockAnchor {
  /** A monotonic timestamp, in milliseconds, when the anchor was taken. */
  at: number
  /** Where the playhead was at that instant, in frames. */
  frame: number
}

export type ClockStep =
  /** Keep playing; put the playhead here. */
  | { kind: 'play'; frame: number }
  /** Reached the end with looping on: start again from zero. */
  | { kind: 'loop'; frame: number }
  /** Reached the end: stop, and rest on the last frame. */
  | { kind: 'stop'; frame: number }

/**
 * Where the playhead should be now.
 *
 * Accumulated from ONE anchor rather than added to frame by frame. Adding a
 * per-tick delta lets rounding error build up — at 60Hz that is sixty chances a
 * second to lose a fraction of a frame, and over a three-minute edit it walks
 * measurably away from the audio. Subtracting two timestamps cannot drift.
 */
export function frameAt(anchor: ClockAnchor, now: number, fps: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(anchor.at) || fps <= 0) return anchor.frame
  // A clock that appears to have gone backwards is a clock we do not trust;
  // holding still is better than jumping the playhead into the past.
  const elapsed = Math.max(0, now - anchor.at)
  return anchor.frame + Math.round((elapsed / 1000) * fps)
}

/**
 * One tick of playback: where to go, and whether to keep going.
 *
 * `end` is the project duration in frames — the last frame of the LAST clip on
 * any track, audio included, so a music bed outlasting the picture keeps the
 * timeline running rather than cutting it short.
 */
export function clockStep(
  anchor: ClockAnchor,
  now: number,
  fps: number,
  end: number,
  loop: boolean
): ClockStep {
  const frame = frameAt(anchor, now, fps)

  /*
   * An empty timeline stops at zero rather than looping forever.
   *
   * With `end` at 0 every frame is past the end, so a loop here would re-anchor
   * and re-enter on every tick — sixty state updates a second for a project
   * with nothing in it.
   */
  if (end <= 0) return { kind: 'stop', frame: 0 }

  if (frame >= end) return loop ? { kind: 'loop', frame: 0 } : { kind: 'stop', frame: end }
  return { kind: 'play', frame }
}

/**
 * Does the clock need re-anchoring before this tick?
 *
 * True when something OTHER than the clock moved the playhead — a scrub, Home,
 * clicking the ruler, revealing a clip. Without this the next tick computes
 * from the stale anchor and drags the playhead straight back, so scrubbing
 * during playback fights the user.
 *
 * It never came up before only because the media element overwrote the
 * playhead every tick regardless, which hid the stale anchor rather than
 * fixing it.
 */
export function needsReanchor(wrote: number | null, playhead: number): boolean {
  return wrote === null || wrote !== playhead
}
