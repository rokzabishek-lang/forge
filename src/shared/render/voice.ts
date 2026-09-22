/**
 * Voice effects — the chipmunk, the monster, the phone call.
 *
 * The staple of every meme edit, and the reason a lot of people open an editor
 * at all. CapCut puts these one tap away under the clip; here they are on the
 * clip's right-click menu beside speed, because they are the same kind of
 * decision: *this sound, but different*.
 *
 * **Pitch without tempo.** The trick is old and exact: `asetrate` replays the
 * samples at a different rate, which shifts pitch AND speed together, and
 * `atempo` then puts the speed back. The clip stays exactly as long as it was,
 * so nothing on the timeline moves — which matters here more than it does in a
 * DAW, because a clip that changed length would slide every cut after it off
 * the beat.
 *
 * **All four filters are safe on the 2018 Windows build**, measured on the
 * bundled binary rather than read off a release note: `asetrate`, `atempo`,
 * `highpass` and `lowpass` are all present, and all four predate the floor by
 * years. No new filter, no new dependency; see docs/EFFECTS.md §25 for why the
 * floor is a date.
 */

import { ATEMPO_MIN } from './speed'

export interface VoiceEffect {
  id: VoiceId
}

export type VoiceId = 'chipmunk' | 'bright' | 'deep' | 'monster' | 'phone' | 'radio'

export interface VoicePreset {
  id: VoiceId
  name: string
  /** What it sounds like, for the menu — a name alone does not decide anything. */
  hint: string
  /** Playback-rate ratio. 1 leaves the pitch alone. */
  pitch: number
  /** Band limits in Hz, for the ones that are a filter rather than a pitch. */
  band?: { low: number; high: number }
}

/**
 * Six, not sixteen.
 *
 * A list long enough to scroll is a list nobody reads; these are the ones that
 * actually get used, in the order they are reached for. Two up, two down, two
 * that are about the CHANNEL rather than the voice.
 */
export const VOICES: VoicePreset[] = [
  { id: 'chipmunk', name: 'Chipmunk', hint: 'Way up — the meme one', pitch: 1.55 },
  { id: 'bright', name: 'Bright', hint: 'A little up, still a person', pitch: 1.18 },
  { id: 'deep', name: 'Deep', hint: 'A little down, warmer', pitch: 0.84 },
  { id: 'monster', name: 'Monster', hint: 'Way down', pitch: 0.66 },
  {
    id: 'phone',
    name: 'Phone call',
    hint: 'Thin and boxy, like a call',
    pitch: 1,
    band: { low: 400, high: 3400 }
  },
  {
    id: 'radio',
    name: 'Radio',
    hint: 'Broadcast — no deep bass, no air',
    pitch: 1,
    band: { low: 200, high: 6000 }
  }
]

export function voiceById(id: string | undefined): VoicePreset | null {
  return VOICES.find((v) => v.id === id) ?? null
}

/**
 * Highest and lowest the pitch may go.
 *
 * Bounded by `atempo`, not by taste: undoing the speed change costs a tempo of
 * `1/pitch`, and atempo refuses anything below 0.5 — measured, see speed.ts. So
 * a pitch above 2 cannot be corrected by a single atempo, and the chain that
 * would be needed makes a voice sound like a fax machine long before then.
 */
export const MIN_PITCH = ATEMPO_MIN
export const MAX_PITCH = 1 / ATEMPO_MIN

/** A number for a filter graph: precise enough, with no trailing noise. */
function n(value: number): string {
  return String(Number(value.toFixed(4)))
}

/**
 * The filters for a voice effect, in chain order.
 *
 * `sampleRate` is the project's, and it has to be: `asetrate` sets an absolute
 * rate, so computing it from the wrong number would retune the clip by the
 * ratio between them. The closing `aresample` puts the stream back to the
 * project rate, without which every later filter — the fades, the delay, the
 * mix — would be running at a rate of its own.
 */
export function voiceFilters(
  effect: VoiceEffect | undefined,
  sampleRate: number
): string[] {
  const preset = voiceById(effect?.id)
  if (!preset || !(sampleRate > 0)) return []

  const out: string[] = []
  /*
   * Not clamped. Deliberately.
   *
   * A clamp here would quietly retune a preset that asked for the impossible,
   * and it would ship sounding wrong rather than failing — the mutation run
   * found it doing exactly nothing, because every preset is in range and the
   * only thing that could put one out of range is someone adding it.
   *
   * So the guard is the TEST: `voiceAndKinds.test.ts` holds every preset
   * inside `[MIN_PITCH, MAX_PITCH]` and fails the moment a new one is not.
   * The bounds stay exported for whatever adds the next preset to check
   * against.
   */
  const pitch = preset.pitch

  if (Math.abs(pitch - 1) >= 0.001) {
    out.push(`asetrate=${Math.round(sampleRate * pitch)}`)
    // Undo the speed the resampling introduced, so the clip is the same length.
    out.push(`atempo=${n(1 / pitch)}`)
    out.push(`aresample=${sampleRate}`)
  }

  if (preset.band) {
    out.push(`highpass=f=${preset.band.low}`)
    out.push(`lowpass=f=${preset.band.high}`)
  }

  return out
}
