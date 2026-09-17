import type { Clip, Frames, MediaAsset, Project } from '../timeline'

/**
 * Speed — slow motion, fast motion, and what each costs.
 *
 * The biggest single gap for short-form. A held beat in slow motion and a whip
 * through the boring part are the two edits that most reliably separate a reel
 * that plays from one that scrolls past, and neither was possible here.
 *
 * The model is the one every editor uses: the SOURCE RANGE stays put and the
 * clip's length on the timeline changes. Half speed makes a two-second clip
 * four seconds long and shows exactly the same footage. That is why changing
 * speed rewrites `duration` rather than `inPoint`.
 *
 *   source frames consumed = duration × speed
 *   timeline frames occupied = duration
 *
 * Measured against the bundled binary rather than assumed: taking 1s of source
 * at 0.25× produced 3.967s of output and 2s at 0.5× produced 3.984s, against a
 * wanted 4s — the residue is container rounding, and the render clamps total
 * length anyway.
 */

/** Below this the audio stretch stops being usable and the picture is a slideshow. */
export const MIN_SPEED = 0.1
export const MAX_SPEED = 8

/** The speeds people actually reach for, in the order a menu should offer them. */
export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const

/**
 * atempo's accepted range, measured: `[0.5 - 100]`.
 *
 * 0.4 is refused outright — "Value 0.400000 for parameter 'tempo' out of range"
 * — so anything slower has to be reached by chaining, which is why `atempoChain`
 * exists rather than a single filter.
 */
export const ATEMPO_MIN = 0.5

/**
 * A number for a filter graph: precise enough, with no trailing noise.
 *
 * `0.5000` and `0.5` behave identically, but one of them is readable in a log
 * and in a test assertion, and mixing the two forms in one chain makes the
 * graph look like two different pieces of code wrote it.
 */
function n(value: number): string {
  return String(Number(value.toFixed(4)))
}

export function clipSpeed(clip: Pick<Clip, 'speed'>): number {
  const raw = clip.speed
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 1
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, raw))
}

/** Emit nothing and pay nothing for the overwhelming majority of clips. */
export function isNormalSpeed(clip: Pick<Clip, 'speed'>): boolean {
  return Math.abs(clipSpeed(clip) - 1) < 0.001
}

/** How much of the source this clip eats — always in source frames. */
export function sourceFramesFor(clip: Pick<Clip, 'speed' | 'duration'>): Frames {
  return Math.max(1, Math.round(clip.duration * clipSpeed(clip)))
}

/**
 * Where a timeline frame lands in the source.
 *
 * The preview seeks with this, so a scrub lands on the frame the export would
 * show rather than somewhere nearby that happens to look similar.
 */
export function sourceFrameAt(clip: Pick<Clip, 'speed' | 'start' | 'inPoint'>, frame: Frames): Frames {
  return Math.round(clip.inPoint + (frame - clip.start) * clipSpeed(clip))
}

/**
 * The longest this clip can be on the timeline at a given speed.
 *
 * Slowing down costs nothing — less source covers more time. Speeding up eats
 * source faster, so the limit is however much footage is left after `inPoint`.
 * A still has no such limit: it can be held for as long as anyone likes.
 */
export function maxDurationAtSpeed(
  clip: Pick<Clip, 'inPoint'>,
  asset: Pick<MediaAsset, 'kind' | 'durationFrames'> | undefined,
  speed: number
): Frames {
  if (!asset || asset.kind === 'image') return Number.MAX_SAFE_INTEGER
  const available = Math.max(1, asset.durationFrames - clip.inPoint)
  return Math.max(1, Math.floor(available / Math.max(MIN_SPEED, speed)))
}

/**
 * The clip's new length when the speed changes, keeping the same footage.
 *
 * Half the speed, twice as long. This is the whole reason a speed control feels
 * like a speed control rather than a trim.
 */
export function durationAtSpeed(
  clip: Pick<Clip, 'speed' | 'duration' | 'inPoint'>,
  asset: Pick<MediaAsset, 'kind' | 'durationFrames'> | undefined,
  nextSpeed: number
): Frames {
  const source = clip.duration * clipSpeed(clip)
  const wanted = Math.max(1, Math.round(source / nextSpeed))
  return Math.min(wanted, maxDurationAtSpeed(clip, asset, nextSpeed))
}

/**
 * The picture, re-timed.
 *
 * `setpts` moves timestamps without changing the frame count, so on its own a
 * slowed clip would be the same frames spread thinner — a stream claiming 30fps
 * while delivering 7. The `fps` filter immediately afterwards restores the
 * count, which is what makes the rest of the chain see a perfectly ordinary
 * clip of exactly `duration` frames. Everything downstream is then untouched by
 * speed existing at all.
 *
 * `smooth` invents the in-between frames instead of repeating them. It is
 * beautiful and it is expensive: measured at 1080x1920, eight seconds of output
 * took 0.67s plainly and 27.46s interpolated — **41 times** slower. It is
 * therefore opt-in, and only offered when slowing down, since speeding up
 * discards frames and has nothing to interpolate.
 */
export function speedVideoFilter(speed: number, fps: number, smooth = false): string | null {
  if (Math.abs(speed - 1) < 0.001) return null
  const retime = `setpts=PTS/${n(speed)}`
  if (smooth && speed < 1) {
    return `${retime},minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`
  }
  return `${retime},fps=${fps}`
}

/**
 * The sound, re-timed, as a chain that stays inside atempo's range.
 *
 * atempo refuses anything below 0.5 — measured, not assumed — so quarter speed
 * is two halvings rather than one quarter. Each link is a real pitch-preserving
 * stretch, so the voice stays a voice instead of dropping an octave.
 */
export function atempoChain(speed: number): string[] {
  if (Math.abs(speed - 1) < 0.001) return []
  const steps: string[] = []
  let remaining = speed
  while (remaining < ATEMPO_MIN) {
    steps.push(`atempo=${n(ATEMPO_MIN)}`)
    remaining /= ATEMPO_MIN
  }
  // Anything above 1 is within range on its own; MAX_SPEED is far below 100.
  if (Math.abs(remaining - 1) >= 0.001) steps.push(`atempo=${n(remaining)}`)
  return steps
}

/** How a speed reads in the interface: "0.5×", "2×". */
export function formatSpeed(speed: number): string {
  const rounded = Math.round(speed * 100) / 100
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0$/, '')}×`
}

/**
 * A clip's speed changed, and the timeline tidied up after it.
 *
 * Pure, and in the shared layer rather than the store, for the same reason
 * `addTransition` lives there: the interesting part is not the click, it is what
 * happens to everything else. The ripple in particular is the sort of rule that
 * has to be tested rather than looked at.
 */
export function withClipSpeed(
  project: Project,
  clipId: string,
  speed: number,
  smoothSlow?: boolean
): Project {
  const clip = project.clips.find((c) => c.id === clipId)
  if (!clip) return project
  const asset = project.assets.find((a) => a.id === clip.assetId)
  // A photograph has no rate. "Speeding up" a still is just a trim wearing a
  // different name, and offering it would be a lie about what it does.
  if (!asset || asset.kind === 'image') return project

  const next = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))
  const duration = durationAtSpeed(clip, asset, next)
  const delta = duration - clip.duration
  const end = clip.start + clip.duration

  const retimed: Clip = (() => {
    if (Math.abs(next - 1) < 0.001) {
      // Back to normal: drop the fields rather than storing 1, so an untouched
      // clip serialises exactly as it always has.
      const { speed: _s, smoothSlow: _m, ...plain } = clip
      return { ...plain, duration }
    }
    return { ...clip, duration, speed: next, smoothSlow: smoothSlow ?? clip.smoothSlow }
  })()

  return {
    ...project,
    clips: project.clips.map((c) => {
      if (c.id === clipId) return retimed
      /*
       * Push what comes after it on the same track.
       *
       * A clip that doubles in length would otherwise grow straight through its
       * neighbour. The timeline does allow overlaps — transitions are built on
       * them — but an overlap nobody asked for is a collision, and this is meant
       * to be one gesture with one obvious result.
       */
      if (c.trackId !== clip.trackId || c.start < end) return c
      return { ...c, start: Math.max(0, c.start + delta) }
    })
  }
}
