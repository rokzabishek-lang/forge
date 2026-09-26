import type { SoundEvent } from '../director/recipes'
import { MAX_GAIN } from './audibility'

/**
 * How loud each sound the Director fires is, beside `duck.ts` for the same
 * reason: one set of numbers the export and the preview both read, so the mix
 * the editor plays is the mix the file has (docs/PLAN.md §6.1).
 *
 * A level is the sound's PEAK, in dBFS, when the music's fader is at unity —
 * the music is mastered to sit near full scale, so "−8 dB" is eight below the
 * music's loudest moments. Each file is normalised by its own measured peak
 * (`soundRoles.ts` `peakDb`, measured 2026-09-26: the library's peaks span
 * −0.2 to −16.9 dB), so a quiet swell and a hot boom both land where the
 * table says. The music is NOT ducked under a sound — a hit is meant to sit
 * on top of it; the silence is the music's own envelope.
 */
export const SOUND_LEVEL_DB: Record<Exclude<SoundEvent, 'silence'>, number> = {
  riser: -8,
  swell: -8,
  hit: -3,
  braam: -3,
  sub: -6,
  whoosh: -10
}

/** The ad's intensity dial moves every level by this much at its ends: a loud ad's hits two dB hotter, a calm ad's two quieter. */
export const SOUND_INTENSITY_DB = 4

/**
 * The most a file may be lifted to reach its level: the fader's own ceiling,
 * +6 dB, which the render clamps every clip to (`audibility.ts`) — a level
 * asked for above it would be written on the clip and never heard. A quiet
 * swell lands a few dB shy of its table level rather than boosted into hiss.
 */
export const MAX_SOUND_GAIN = MAX_GAIN

/** A riser or swell fades in over this share of its way to the peak. */
export const RISE_FADE_IN_SHARE = 0.2

/** After its peak a riser or swell is cut, faded over this many frames — nothing after the peak unless the recipe keeps the tail. */
export const PEAK_TAIL_FRAMES = 4

/** A hit's tail is kept, but no longer than this, faded over its last second. */
export const HIT_TAIL_MAX_SECONDS = 4
export const HIT_TAIL_FADE_SECONDS = 1

/** The silence: the music ramps to nothing over this many frames, and back over the same. */
export const SILENCE_RAMP_FRAMES = 4

/**
 * The fader for one placed sound: its level for the event, moved by the
 * ad's intensity, less the file's own peak, on top of the music's fader.
 */
export function soundGain(event: Exclude<SoundEvent, 'silence'>, peakDb: number, musicVolume: number, intensity = 0.5): number {
  const target = SOUND_LEVEL_DB[event] + (Math.max(0, Math.min(1, intensity)) - 0.5) * SOUND_INTENSITY_DB
  const gain = Math.pow(10, (target - peakDb) / 20)
  return Math.min(MAX_SOUND_GAIN, gain) * Math.max(0, musicVolume)
}
