/**
 * The latest levels from the preview's mixer, for the meters to read.
 *
 * Not in the store, deliberately. Levels change on every animation frame, and
 * anything in the store re-renders everything subscribed to it — sixty full
 * renders a second of every panel that reads the project, to move a bar a few
 * pixels. The meters read this in their own animation loop and set a style
 * directly, so nothing in React re-renders at all.
 *
 * Written by the Preview's draw loop (the only place the mixer is stepped),
 * read by any number of meters.
 */

export interface PublishedLevels {
  master: number
  tracks: Record<string, number>
  /** When these were measured, in `performance.now()` milliseconds. */
  at: number
}

let latest: PublishedLevels = { master: 0, tracks: {}, at: 0 }

export function publishLevels(master: number, tracks: Record<string, number>, at: number): void {
  latest = { master, tracks, at }
}

/**
 * Levels older than this are silence.
 *
 * The mixer is only stepped while playing, so when playback stops the last
 * reading would otherwise sit on the meter forever — a frozen bar reading
 * −6 dB over a paused, silent preview.
 */
export const LEVELS_STALE_MS = 150

/**
 * A live INPUT on a track — the microphone, while a voice-over records.
 *
 * Kept apart from the mixer's readings because the two have different clocks:
 * the mixer only runs while the preview plays, and a microphone is live from
 * the moment it opens, count-in included. That is exactly when someone checks
 * their level, so the meter has to move before the take begins.
 */
const inputs = new Map<string, { peak: number; at: number }>()

export function publishInput(trackId: string, peak: number, at: number): void {
  inputs.set(trackId, { peak, at })
}

export function clearInput(trackId: string): void {
  inputs.delete(trackId)
}

export function readLevels(now: number): PublishedLevels {
  const base =
    now - latest.at > LEVELS_STALE_MS ? { master: 0, tracks: {}, at: now } : latest
  if (inputs.size === 0) return base
  // A live input wins over the track's playback reading: while recording, the
  // meter on the armed track is the microphone.
  const tracks = { ...base.tracks }
  for (const [id, reading] of inputs) {
    if (now - reading.at <= LEVELS_STALE_MS) tracks[id] = reading.peak
  }
  return { ...base, tracks }
}
