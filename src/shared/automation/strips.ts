import type { Clip, ColorAdjust, Frames } from '../timeline'
import { secondsToFrames } from '../timeline'
import { stripCell, type StripLayout } from '../render/strips'
import type { MusicAnalysis } from './cutPlan'
import { subdivide } from './grid'

/**
 * Strips flashing over footage that never stops.
 *
 * The other half of the reference template, and the half that is NOT a cut. The
 * shot runs on underneath; what changes is which slices of the frame are
 * showing a treated copy of it. That distinction is the whole reason this rule
 * is allowed to fire four times a beat when `cutPlan` spends its whole preamble
 * arguing against cutting even once a beat: the rule there is about SHOTS, and
 * nothing here changes the shot. Measured on the reference: 73% of its visual
 * changes land within one video frame of a sixteenth-note grid, and the second
 * half runs at 3.5 changes a second against the assembly's 1.8.
 *
 * Nothing here writes the footage. The strips go on a layer above whatever is
 * already on the timeline, which is what makes them an interruption rather than
 * an edit — delete every one of them and the shot underneath is untouched.
 */

export const STRIP_RULE = 'strips.flash'

/** What the flashed copy looks like against the shot underneath. */
export type StripLook = 'flash' | 'bleach' | 'shadow'

export const STRIP_LOOK_LABEL: Record<StripLook, string> = {
  flash: 'Blown out',
  bleach: 'Bleached',
  shadow: 'Crushed'
}

export const STRIP_LOOK_HINT: Record<StripLook, string> = {
  flash: 'Brighter and harder — the reference’s own look.',
  bleach: 'Bright and drained of colour, closer to paper.',
  shadow: 'Darker instead of brighter, for a bright shot.'
}

export const STRIP_LOOKS: Record<StripLook, ColorAdjust> = {
  // Lifted and hardened rather than merely brighter: raising brightness alone
  // gives a grey wash, and it is the contrast that makes it read as a flash.
  flash: { brightness: 0.34, contrast: 1.45, saturation: 0.75 },
  bleach: { brightness: 0.28, contrast: 1.15, saturation: 0.12 },
  shadow: { brightness: -0.3, contrast: 1.3, saturation: 0.6 }
}

export interface StripPlanOptions {
  fps: number
  source: { width: number; height: number }
  canvas: { width: number; height: number }
  layout: StripLayout
  /** How many slices the frame is divided into. */
  count: number
  /** How many of them light up on one hit. */
  perHit?: number
  look?: StripLook
  angle?: number
  /** Beats between hits. 0.25 is four a beat, which is where the reference is. */
  beatsPerHit?: number
  /**
   * How often a hit becomes a burst of three on consecutive subdivisions.
   *
   * 0 disables it. The reference's flashes were not an even pulse: ten of them,
   * nine on the sixteenth grid, arriving as triples with gaps between.
   */
  burstRate?: number
  analysis?: MusicAnalysis | null
  /** Seconds between hits when there is no music. */
  cadenceSeconds?: number
  startFrame?: Frames
  /** How long the flashes go on for. Defaults to the whole analysed window. */
  durationFrames?: Frames
}

export interface StripFlash {
  slot: number
  startFrame: Frames
  durationFrames: Frames
  reason: string
}

export const DEFAULT_STRIP_COUNT = 5
export const DEFAULT_BEATS_PER_HIT = 0.25
export const DEFAULT_BURST_RATE = 0.25

/**
 * A deterministic 0..1 from a hit index, so a rebuild is the same edit.
 *
 * Same reasoning as the grid's scatter: a user who rebuilds to change the music
 * and finds the flashes in different places has been handed a different edit,
 * not the same one re-rendered.
 */
function jitter(n: number, salt: number): number {
  const h = Math.sin((n + 1) * 91.7 + salt * 47.3) * 28711.5453
  return h - Math.floor(h)
}

/** Where the hits fall, in frames from the start of the run. */
function hitFrames(options: StripPlanOptions): Frames[] {
  const { fps, analysis } = options
  const rate = Math.max(0.0625, options.beatsPerHit ?? DEFAULT_BEATS_PER_HIT)
  const divide = rate < 1 ? Math.max(1, Math.round(1 / rate)) : 1
  const step = rate < 1 ? 1 : Math.max(1, Math.round(rate))
  const span = options.durationFrames ?? 0

  if (!analysis || analysis.beats.length < 2) {
    const gap = Math.max(1, secondsToFrames(options.cadenceSeconds ?? 0.14, fps))
    const count = span > 0 ? Math.floor(span / gap) : 32
    return Array.from({ length: Math.max(1, count) }, (_, i) => i * gap)
  }

  const grid = subdivide(analysis.beats, divide)
  const out: Frames[] = []
  for (let i = 0; i < grid.length; i += step) {
    const frame = secondsToFrames(grid[i] / 1000, fps)
    if (span > 0 && frame >= span) break
    out.push(frame)
  }
  return out
}

/**
 * Which strips light up, and when.
 *
 * Not every subdivision gets a hit — the reference's gaps ran one and two
 * sixteenths, not a flash on every one, and a strip on every sixteenth without
 * a gap is a strobe rather than a rhythm.
 */
export function planStrips(options: StripPlanOptions): StripFlash[] {
  const { fps, layout, canvas, source } = options
  const count = Math.max(2, Math.round(options.count))
  const perHit = Math.max(1, Math.min(count, Math.round(options.perHit ?? 2)))
  const burstRate = Math.max(0, Math.min(1, options.burstRate ?? DEFAULT_BURST_RATE))
  const start = options.startFrame ?? 0

  const hits = hitFrames(options)
  if (hits.length < 2) return []

  // One subdivision long: a flash that outlives its own slot smears into the
  // next one and the grid stops being legible.
  const slotFrames = Math.max(1, Math.round(hits[1] - hits[0]))
  const flashes: StripFlash[] = []

  for (let h = 0; h < hits.length; h++) {
    // Leave gaps. Flashing on every subdivision is a strobe, not a rhythm.
    if (jitter(h, 3) > 0.62) continue

    const burst = burstRate > 0 && jitter(h, 11) < burstRate ? 3 : 1
    for (let b = 0; b < burst; b++) {
      const at = hits[Math.min(hits.length - 1, h + b)]
      if (b > 0 && at === hits[h]) break
      for (let k = 0; k < perHit; k++) {
        const slot = Math.floor(jitter(h * 7 + b * 3 + k, 23) * count) % count
        flashes.push({
          slot,
          startFrame: start + at,
          durationFrames: slotFrames,
          reason: burst > 1 ? `burst ${b + 1} of 3` : 'on the beat grid'
        })
      }
    }
    // A burst consumes the subdivisions it covers.
    if (burst > 1) h += burst - 1
  }

  // Sanity: a layout that cannot produce geometry produces no clips at all,
  // rather than clips pointing at nothing.
  if (!stripCell(layout, count, 0, source, canvas, options.angle)) return []
  void fps
  return flashes
}

/** The flashes, as ordinary clips on a layer of their own. */
export function stripClips(
  flashes: StripFlash[],
  options: StripPlanOptions,
  trackId: string,
  assetId: string
): Clip[] {
  const count = Math.max(2, Math.round(options.count))
  const look = STRIP_LOOKS[options.look ?? 'flash']
  const stamp = Date.now().toString(36)

  return flashes
    .map((flash, index) => {
      const cell = stripCell(
        options.layout,
        count,
        flash.slot,
        options.source,
        options.canvas,
        options.angle
      )
      if (!cell) return null
      const clip: Clip = {
        id: `strip-${index}-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
        assetId,
        trackId,
        start: Math.max(0, flash.startFrame),
        duration: flash.durationFrames,
        inPoint: 0,
        volume: 0,
        transform: cell.transform,
        color: { ...look },
        crop: cell.crop,
        generatedBy: { rule: STRIP_RULE, reason: flash.reason },
        ...(cell.mask ? { mask: cell.mask } : {})
      }
      return clip
    })
    .filter((c): c is Clip => c !== null)
}
