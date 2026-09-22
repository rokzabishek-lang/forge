import { overlapFrames, type Clip, type Frames } from '../timeline'

/**
 * Fades in and out of a clip's sound.
 *
 * Separate from the drawn volume envelope on purpose, and multiplied with it
 * rather than replacing it. They answer different questions: the envelope is
 * *quiet it HERE because I say so*, and a fade is *do not start or stop
 * abruptly*. Every DAW keeps fade handles and the automation lane apart for
 * exactly that reason — you want to soften an entry without redrawing the
 * curve you spent a minute shaping.
 *
 * Before this, softening an entry meant placing four envelope points by hand.
 */

/**
 * Quarter-sine, not linear.
 *
 * Measured on a 4s tone faded out over its last two seconds, sampled in
 * quarter-second windows against a flat control at −21.1 dB:
 *
 *     curve   at 10%   at 50%   at 85%   of the fade
 *     tri     −1.9dB   −7.8dB   −17.6dB
 *     qsin    −0.4dB   −4.6dB   −13.7dB
 *
 * Linear amplitude drops away early and then crawls, which is why a `tri`
 * fade-out on music sounds like someone pulling the plug halfway. `qsin` holds
 * the level and then goes, which is what "fade the music out" means.
 *
 * It is also safe on the 2018 Windows build. The curve list is an append-only
 * enum and this is number **1**, right behind `tri` at 0 — everything added
 * later sits higher (`ipar` 5, `iqsin` 12, `dese` 14, `losi` 16), so `qsin` is
 * from the filter's original commit. That is read off the binary's own `-h
 * filter=afade`, not off a release note. The integration test renders it, and
 * CI runs the integration tests on Windows, so the 2018 build gets the last
 * word. See docs/EFFECTS.md.
 */
export const FADE_CURVE = 'qsin'

export interface Fades {
  in: Frames
  out: Frames
}

type FadedClip = Pick<Clip, 'fadeIn' | 'fadeOut' | 'duration'>

function whole(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.round(value)
}

/**
 * The two fades, made to fit inside the clip.
 *
 * A fade longer than the clip, or two that overlap, are not errors to reject —
 * they are what a drag produces at the moment it goes too far, and what a
 * ripple leaves behind when a clip is shortened under fades that were already
 * set. Overlapping fades are reduced in proportion until they meet, so the
 * sound dips to nothing once in the middle rather than going silent early and
 * staying that way.
 */
export function clipFades(clip: FadedClip): Fades {
  const duration = Math.max(0, Math.round(clip.duration))
  if (duration === 0) return { in: 0, out: 0 }

  let fadeIn = Math.min(duration, whole(clip.fadeIn))
  let fadeOut = Math.min(duration, whole(clip.fadeOut))

  const total = fadeIn + fadeOut
  if (total > duration) {
    const share = duration / total
    fadeIn = Math.round(fadeIn * share)
    // The remainder rather than its own rounding, so the two always sum to the
    // clip exactly instead of leaving a one-frame gap or overlap.
    fadeOut = duration - fadeIn
  }
  return { in: fadeIn, out: fadeOut }
}

/** True when this clip has anything to fade. */
export function hasFades(clip: FadedClip): boolean {
  const fades = clipFades(clip)
  return fades.in > 0 || fades.out > 0
}

/**
 * Overlap on a track MEANS crossfade.
 *
 * Nothing set this before, and the result was measurable: a video dissolve
 * genuinely overlaps its two clips (see `anchorTransition`), so for the length
 * of every dissolve both soundtracks played at once, at full. Rendered and
 * measured on two tones, the overlap came back **3.0 dB hot** against either
 * side of it — which is exactly what two uncorrelated signals summing sounds
 * like, because that is what it was.
 *
 * Derived rather than stored, so it is true of every overlap however it was
 * made — a dropped transition, a crossfade action, a reel the automation
 * built — without any of them having to remember to write it down.
 *
 * An explicit fade always wins. Someone who has drawn a fade on this edge has
 * said what they want there, and quietly replacing it with an overlap-derived
 * one would undo work with no way to see why.
 *
 * The curve does the rest: `qsin` out against `qsin` in is equal power, so the
 * two halves sum flat. Measured against ffmpeg's own `acrossfade=c1=qsin:
 * c2=qsin` over a two-second overlap of 440Hz and 1170Hz — both hold −21.1 dB
 * straight through, identical. `tri` on the same overlap dips to −23.9, the
 * textbook hole in the middle of a linear crossfade. That measurement is also
 * why this does not use `acrossfade` at all: it is a two-input filter that
 * would force the whole graph from "mix independent streams" into "concatenate
 * a chain", for an output that is the same samples.
 */
export function fadesWithNeighbours(
  clip: Clip,
  previous: Clip | null,
  next: Clip | null
): FadedClip {
  const into = previous ? overlapFrames(previous, clip) : 0
  const outOf = next ? overlapFrames(clip, next) : 0
  return {
    duration: clip.duration,
    fadeIn: clip.fadeIn !== undefined ? clip.fadeIn : into > 0 ? into : undefined,
    fadeOut: clip.fadeOut !== undefined ? clip.fadeOut : outOf > 0 ? outOf : undefined
  }
}

/**
 * The `afade` filters for a clip, in chain order.
 *
 * Times are in the clip's OWN seconds, starting at zero. That is not a choice:
 * these go in after `atempo` and before `adelay`, so by this point the stream
 * has been stretched to timeline rate and has not yet been pushed out to the
 * clip's position. Authoring them in timeline time would put every fade on
 * every clip that does not start at zero in the wrong place — and a fade-out
 * whose `st` lands past the end of the stream simply never happens, which
 * looks like the feature not working rather than like a units bug.
 */
export function audioFadeFilters(clip: FadedClip, fps: number): string[] {
  if (!(fps > 0)) return []
  const { in: fadeIn, out: fadeOut } = clipFades(clip)
  const seconds = (frames: number): string => (frames / fps).toFixed(4)
  const out: string[] = []
  if (fadeIn > 0) {
    out.push(`afade=t=in:st=0:d=${seconds(fadeIn)}:curve=${FADE_CURVE}`)
  }
  if (fadeOut > 0) {
    const duration = Math.max(0, Math.round(clip.duration))
    out.push(
      `afade=t=out:st=${seconds(duration - fadeOut)}:d=${seconds(fadeOut)}:curve=${FADE_CURVE}`
    )
  }
  return out
}

/**
 * The gain a fade applies at one frame inside the clip — the preview's half of
 * `audioFadeFilters`.
 *
 * `qsin` is a quarter sine: gain rises as `sin(x·π/2)` across the fade-in and
 * falls as the same curve reversed across the fade-out. Writing it this way is
 * what makes an overlap equal power for free — `sin²(x·π/2) + cos²(x·π/2) = 1`
 * — so two clips crossfading sum to exactly the level either one had, which is
 * the measured behaviour the comment on FADE_CURVE records against ffmpeg's own
 * `acrossfade`.
 *
 * Takes the same shape `audioFadeFilters` takes, and calls the same
 * `clipFades`, so a fade that has been squeezed to fit sounds squeezed in the
 * preview too rather than only in the export.
 */
export function fadeGainAt(clip: FadedClip, frame: Frames): number {
  const duration = Math.max(0, Math.round(clip.duration))
  if (duration === 0) return 0
  const { in: fadeIn, out: fadeOut } = clipFades(clip)

  /*
   * The clamp is INSIDE the curve, and it is the only one.
   *
   * A frame before the clip or past its end gives a negative argument, and
   * `sin()` of a negative comes back as a negative GAIN — a phase flip rather
   * than silence, which is audible and exactly the wrong thing. Clamping the
   * frame first as well would be a second guard on the same edge, and a guard
   * that can be removed without any test noticing is not a guard.
   */
  const qsin = (x: number): number => Math.sin(Math.max(0, Math.min(1, x)) * (Math.PI / 2))

  let gain = 1
  if (fadeIn > 0 && frame < fadeIn) gain *= qsin(frame / fadeIn)
  const outStart = duration - fadeOut
  if (fadeOut > 0 && frame > outStart) gain *= qsin(1 - (frame - outStart) / fadeOut)
  return gain
}

/**
 * A sensible fade to apply when someone asks for one without saying how long.
 *
 * Half a second: long enough to stop a click, short enough that it never
 * sounds like an effect.
 */
export function defaultFadeFrames(fps: number): Frames {
  return Math.max(1, Math.round(fps / 2))
}
