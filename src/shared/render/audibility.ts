/**
 * Who is heard, how loud, and on which bus.
 *
 * Every one of these was answered twice — once in the export (`plan.ts`) and
 * once in the preview's mixer (`Preview.tsx`) — and the two answers had already
 * begun to differ. A video track's `muted` flag was honoured by the preview and
 * ignored by the export, so a muted track played silently in the editor and
 * spoke in the file. "Is this dialogue" was `kind === 'video'` in both places,
 * which left no way to say that an audio track was a voice-over. And the level
 * ceiling was `1` in five separate places, one of which was the point where the
 * preview actually consumed it.
 *
 * So the rules live here, once, and both sides call them. A rule that exists in
 * one place cannot disagree with itself.
 */

import type { Track } from '../timeline'

/* ---------------------------------------------------------------- level */

/**
 * The loudest a clip may be made: 200 %, which is +6 dB.
 *
 * Above unity because quiet footage is the commonest audio problem there is —
 * a phone clip of a speech at the back of a hall — and a fader that stops at
 * 100 % has no answer for it. Not above 2 because past +6 dB a boost is
 * clipping more than it is lifting, and the right tool is the loudness
 * normaliser at export rather than a louder fader.
 *
 * The export's `volume=` accepted anything all along; it was the interface and
 * the preview that stopped at 1.
 */
export const MAX_GAIN = 2

/** A level into range. NaN and negatives are silence, not an error. */
export function clampGain(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(MAX_GAIN, value)
}

/** Below this a fader reads as −∞: nobody can hear −60 dB under anything. */
export const SILENT_DB = -60

/** Linear gain to decibels. Zero is −∞, returned as `-Infinity`. */
export function gainToDb(gain: number): number {
  if (!(gain > 0)) return Number.NEGATIVE_INFINITY
  return 20 * Math.log10(gain)
}

/** Decibels to linear gain. Anything at or below `SILENT_DB` is silence. */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db <= SILENT_DB) return 0
  return clampGain(10 ** (db / 20))
}

/** "+3.5 dB", "−12 dB", "−∞ dB" — the way a fader is read. */
export function formatDb(gain: number): string {
  const db = gainToDb(gain)
  if (!Number.isFinite(db) || db <= SILENT_DB) return '−∞ dB'
  const rounded = Math.round(db * 10) / 10
  // U+2212, a real minus: a hyphen is narrower and the column wobbles.
  if (rounded === 0) return '0 dB'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(Number.isInteger(rounded) ? 0 : 1)} dB`
}

/* ------------------------------------------------------- the fader curve */

/**
 * Where a level sits on a fader, 0 at the bottom and 1 at the top.
 *
 * Linear in DECIBELS, not in gain, because loudness is heard that way: equal
 * steps up a fader should sound like equal steps. A fader linear in gain spends
 * its top half between −6 dB and 0 and crams everything quieter into the bottom
 * few pixels — and with a ceiling of 2, unity would land exactly half-way,
 * making every existing envelope look like it had been turned down by half.
 *
 * `FADER_FLOOR_DB` is the bottom of the travel. Below −40 dB a sound is gone
 * under anything else in the mix, so the last stretch of the fader is simply
 * silence, which is where every desk puts −∞.
 *
 * Shared by the Inspector's level slider and the on-clip envelope, so the same
 * level is at the same height in both.
 */
export const FADER_FLOOR_DB = -40
const FADER_TOP_DB = 20 * Math.log10(MAX_GAIN)

export function faderPosition(gain: number): number {
  const g = clampGain(gain)
  if (g === 0) return 0
  const db = gainToDb(g)
  return Math.max(0, Math.min(1, (db - FADER_FLOOR_DB) / (FADER_TOP_DB - FADER_FLOOR_DB)))
}

/** The level at a fader position — the inverse of `faderPosition`. */
export function gainAtPosition(position: number): number {
  if (!Number.isFinite(position) || position <= 0) return 0
  const p = Math.min(1, position)
  return clampGain(10 ** ((FADER_FLOOR_DB + p * (FADER_TOP_DB - FADER_FLOOR_DB)) / 20))
}

/* ----------------------------------------------------------- who is heard */

/** True when any track is soloed — at which point only soloed tracks are heard. */
export function anySolo(tracks: readonly Track[]): boolean {
  return tracks.some((t) => t.solo === true)
}

/**
 * Whether this track's SOUND reaches the mix.
 *
 * - **Muted** drops the sound and nothing else. On a video track that means
 *   the picture still plays and its own audio does not — which is what a
 *   speaker icon on a video track promises, and what the export ignored.
 * - **Hidden** is a video track's picture toggle, and it drops the sound too:
 *   a track you cannot see is a track that is not in the edit. That is the one
 *   asymmetry, and the track header's tooltip says so.
 * - **Solo** is exclusive: when anything is soloed, everything that is not is
 *   silent — video tracks' own sound included, because a solo that let the
 *   dialogue through would not be isolating anything.
 *
 * A muted track that is also soloed stays muted. Solo narrows what is heard;
 * it never overrides a mute somebody set on purpose.
 */
export function isAudible(track: Track, tracks: readonly Track[]): boolean {
  if (track.muted) return false
  if (track.kind === 'video' && track.hidden) return false
  if (anySolo(tracks) && track.solo !== true) return false
  return true
}

/* ------------------------------------------------------------ which bus */

/**
 * The part a track's sound plays in the mix.
 *
 * - `dialogue` is what everything else steps back for. A video track's own
 *   sound always is — footage of someone talking is the commonest dialogue
 *   there is — and an audio track is when marked, which is what a voice-over
 *   recorded into the app is by default.
 * - `music` is what steps back: an audio track marked to duck.
 * - `other` is everything else, mixed at its own level with nothing ducking it.
 *
 * Dialogue wins over duck on an audio track marked both, because the two
 * requests are contradictory — a voice cannot duck under itself — and losing
 * the voice under the music is the worse of the two mistakes.
 */
export type AudioRole = 'dialogue' | 'music' | 'other'

export function audioRole(track: Track): AudioRole {
  if (track.kind === 'video') return 'dialogue'
  if (track.dialogue === true) return 'dialogue'
  if (track.duck === true) return 'music'
  return 'other'
}
