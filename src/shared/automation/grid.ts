import type { Clip, Frames } from '../timeline'
import { secondsToFrames } from '../timeline'
import type { GridCell, GridSpec, RevealOrder } from '../render/grid'
import { gridCells, revealOrder } from '../render/grid'
import type { MusicAnalysis } from './cutPlan'

/**
 * A photograph assembling itself on the beat.
 *
 * The geometry is in render/grid.ts; this decides WHEN each piece lands. It is
 * the one place in the app where cutting on every single beat is the right
 * answer, and it is worth writing down why, because everything else here works
 * hard to avoid it.
 *
 * The rule against beat-for-beat cutting is about SHOTS. A new shot every beat
 * at 128 BPM is 128 shots a minute and the eye never settles anywhere long
 * enough to read a frame. But a grid piece is not a shot — the frame does not
 * change, it fills in. Nothing has to be re-read, so the rhythm is felt rather
 * than chased, and the pulse is the point. Twenty pieces at 128 BPM is nine
 * seconds of a picture arriving in time with the music.
 *
 * Which is why this rule reaches for the beats directly rather than going
 * through the cut planner. They are answering different questions.
 */

export const GRID_RULE = 'grid.split'

/** What a piece does when it lands. */
export type Arrival = 'cut' | 'pop' | 'fade'

export const ARRIVAL_LABEL: Record<Arrival, string> = {
  cut: 'Snap in',
  pop: 'Pop in',
  fade: 'Fade in'
}

export const ARRIVAL_HINT: Record<Arrival, string> = {
  cut: 'The piece is simply there on the beat. The hardest hit.',
  pop: 'A fast punch down onto the beat — lands a frame or two after the hit.',
  fade: 'Softer. For a quiet passage, or a photograph that does not want punching.'
}

export interface GridPlanOptions {
  fps: number
  /** The photograph, in its own pixels. */
  source: { width: number; height: number }
  canvas: { width: number; height: number }
  spec: GridSpec
  order: RevealOrder
  arrival?: Arrival
  /**
   * The music, when there is some. Without it the pieces arrive on an even
   * cadence instead, which is worth having: the effect should not be unusable
   * because nobody has dropped a song on the timeline yet.
   */
  analysis?: MusicAnalysis | null
  /**
   * Beats between arrivals. 1 lands a piece on every beat.
   *
   * Fractions are allowed and are the interesting half of the range: 0.5 is
   * twice a beat, 0.25 is four times. Measured off a reference template at
   * 112 BPM, the pieces land on EIGHTHS during the assembly — 73% of its
   * changes sit within one video frame of a sixteenth-note grid, and a whole
   * beat would have been half the rate it actually moves at.
   */
  beatsPerCell?: number
  /** Seconds between arrivals when there is no music. */
  cadenceSeconds?: number
  /** Where on the timeline the grid begins. */
  startFrame?: number
  /** How long the assembled picture holds once the last piece is in. */
  holdSeconds?: number
}

export interface GridPiece {
  cell: GridCell
  startFrame: Frames
  durationFrames: Frames
  /** Which arrival this is, 0-based — the reason line reads better with it. */
  ordinal: number
  reason: string
}

export const DEFAULT_HOLD_SECONDS = 1.2
export const DEFAULT_CADENCE_SECONDS = 0.25

/**
 * The cadences worth offering, in beats between arrivals.
 *
 * The fast half is the useful half. A piece per beat is the obvious setting and
 * it is slower than any template that actually goes around.
 */
export const CADENCES = [0.25, 0.5, 1, 2, 4] as const

export const CADENCE_LABEL: Record<number, string> = {
  0.25: 'Four a beat',
  0.5: 'Twice a beat',
  1: 'Every beat',
  2: 'Every 2 beats',
  4: 'Every bar'
}

/**
 * When each piece lands, and how long it stays.
 *
 * Every piece runs to the SAME end frame rather than for a fixed length. That
 * is what makes this an assembly instead of a flicker: a piece that arrives
 * first and leaves first would take the photograph apart again while the rest
 * of it was still being built.
 */
export function planGridSplit(options: GridPlanOptions): GridPiece[] {
  const {
    fps,
    source,
    canvas,
    spec,
    order,
    analysis = null,
    startFrame = 0,
    holdSeconds = DEFAULT_HOLD_SECONDS
  } = options

  const cells = gridCells(spec, source, canvas)
  if (cells.length === 0) return []

  const sequence = revealOrder(spec.rows, spec.cols, order)
  // "All at once" asks for ONE arrival, not a staggered list that is then
  // collapsed: asking for twenty and using the first would still stretch the
  // grid's length over twenty beats of nothing happening.
  const arrivals = arrivalFrames(order === 'together' ? 1 : cells.length, options)
  if (arrivals.length === 0) return []

  const last = arrivals[arrivals.length - 1]
  const hold = Math.max(1, secondsToFrames(holdSeconds, fps))
  const endFrame = last + hold

  return sequence.map((cellIndex, ordinal) => {
    const at = startFrame + (arrivals[Math.min(ordinal, arrivals.length - 1)] ?? 0)
    return {
      cell: cells[cellIndex],
      startFrame: at,
      durationFrames: Math.max(1, startFrame + endFrame - at),
      ordinal,
      reason: reasonFor(ordinal, analysis !== null)
    }
  })
}

/**
 * Arrival times in frames, relative to the start of the grid.
 *
 * On a beat when there is a track to read, and on an even cadence when there is
 * not. Beats run out before the pieces do on a short song, so the tail falls
 * back to the average gap rather than piling every remaining piece onto the
 * final beat — twenty pieces and eight beats should still be twenty arrivals.
 */
function arrivalFrames(count: number, options: GridPlanOptions): Frames[] {
  const { fps, analysis, beatsPerCell = 1 } = options
  const rate = Math.max(0.0625, beatsPerCell)
  /*
   * Below one beat the BEATS are subdivided; above it they are skipped.
   *
   * Two mechanisms because they are two different questions — how many places
   * there are to land, and which of them to use — and collapsing them into one
   * number would mean a half-beat cadence could only be reached by inventing a
   * beat that the analysis never found.
   */
  const divide = rate < 1 ? Math.max(1, Math.round(1 / rate)) : 1
  const step = rate < 1 ? 1 : Math.max(1, Math.round(rate))

  const cadence = Math.max(1, secondsToFrames(options.cadenceSeconds ?? DEFAULT_CADENCE_SECONDS, fps))
  if (!analysis || analysis.beats.length < 2) {
    return Array.from({ length: count }, (_, i) => Math.round(i * cadence * rate))
  }

  /*
   * Downbeats give the grid its footing when there are enough of them.
   *
   * A piece landing on beat two of the bar is on the music but not on its
   * pulse. Starting the sequence from a downbeat costs nothing and is the
   * difference between an assembly that feels placed and one that feels close.
   */
  const first = analysis.downbeats.length > 0 ? analysis.downbeats[0] : analysis.beats[0]
  const from = analysis.beats.findIndex((ms) => ms >= first - 1)
  const beats = subdivide(analysis.beats.slice(Math.max(0, from)), divide)

  /*
   * Times are WINDOW-ABSOLUTE, the same convention `planCuts` uses.
   *
   * The obvious thing is to subtract the first beat so the grid starts at zero,
   * and it is wrong: the caller adds the music clip's position on the timeline,
   * and the analysis is already measured from that same point. Re-basing slides
   * every piece earlier by however far the first downbeat sits into the track —
   * so the pieces stay evenly spaced, look plausible, and land on nothing at
   * all. The whole feature quietly stops being on the beat.
   *
   * `origin` survives only as the base for extrapolating past the last beat.
   */
  const out: Frames[] = []
  const origin = beats[0]
  for (let i = 0; i < count; i++) {
    const index = i * step
    if (index < beats.length) {
      out.push(secondsToFrames(beats[index] / 1000, fps))
      continue
    }
    // Past the end of the track: keep the same average gap going.
    const gap =
      beats.length > 1
        ? (beats[beats.length - 1] - origin) / Math.max(1, beats.length - 1)
        : 60_000 / Math.max(1, analysis.bpm)
    out.push(secondsToFrames((origin + index * gap) / 1000, fps))
  }
  return out
}

/**
 * Beats, with `n − 1` evenly spaced points inserted between each pair.
 *
 * Interpolated rather than derived from the tempo, so the subdivisions follow
 * the performance instead of an average: a drummer who drags through a bar
 * drags the eighths with them, and a grid placed on a rigid tempo grid would
 * come loose exactly where the music is most expressive.
 */
export function subdivide(beats: number[], n: number): number[] {
  const parts = Math.max(1, Math.round(n))
  if (parts === 1 || beats.length < 2) return beats
  const out: number[] = []
  for (let i = 0; i < beats.length - 1; i++) {
    const span = beats[i + 1] - beats[i]
    for (let k = 0; k < parts; k++) out.push(beats[i] + (span * k) / parts)
  }
  // The last beat has nothing after it to divide against, so it stands alone.
  out.push(beats[beats.length - 1])
  return out
}

function reasonFor(ordinal: number, onMusic: boolean): string {
  const which = `piece ${ordinal + 1}`
  return onMusic ? `${which} · on the beat` : `${which} of the grid`
}

/**
 * The pieces, as ordinary clips.
 *
 * All on ONE track and genuinely overlapping in time, which the renderer
 * composites without complaint — the same arrangement the filmstrip uses, and
 * it works for the same reason: the pieces never overlap in SPACE, so their
 * stacking order is not a question anyone has to answer.
 */
export function gridClips(
  pieces: GridPiece[],
  trackId: string,
  assetId: string,
  fps: number,
  arrival: Arrival = 'cut'
): Clip[] {
  const stamp = Date.now().toString(36)
  return pieces.map((piece, index) => {
    const clip: Clip = {
      id: `grid-${index}-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
      assetId,
      trackId,
      start: Math.max(0, piece.startFrame),
      duration: piece.durationFrames,
      inPoint: 0,
      volume: 1,
      transform: piece.cell.transform,
      color: { brightness: 0, contrast: 1, saturation: 1 },
      crop: piece.cell.crop,
      generatedBy: { rule: GRID_RULE, reason: piece.reason },
      ...(piece.cell.mask ? { mask: piece.cell.mask } : {}),
      ...arrivalKeys(arrival, piece.durationFrames, fps)
    }
    return clip
  })
}

/**
 * The animation a piece plays as it lands.
 *
 * Short — four or five frames. Anything longer and the piece is still moving
 * when the next beat arrives, which turns a grid assembling in time into a
 * grid permanently in motion, and the rhythm disappears into the blur.
 */
function arrivalKeys(
  arrival: Arrival,
  durationFrames: Frames,
  fps: number
): Pick<Clip, 'keyframes'> | Record<string, never> {
  if (arrival === 'cut') return {}
  const beat = Math.max(2, Math.round(fps * 0.14))
  const span = Math.min(beat, Math.max(1, durationFrames - 1))

  if (arrival === 'fade') {
    return {
      keyframes: {
        opacity: [
          { frame: 0, value: 0, ease: 'smooth' },
          { frame: span, value: 1 }
        ]
      }
    }
  }
  return {
    keyframes: {
      // Punching down from slightly too big reads as an impact; coming up from
      // too small reads as a bubble, which is a different and softer feeling.
      zoom: [
        { frame: 0, value: 1.18, ease: 'smooth' },
        { frame: span, value: 1 }
      ],
      opacity: [
        { frame: 0, value: 0, ease: 'smooth' },
        { frame: Math.max(1, Math.round(span / 2)), value: 1 }
      ]
    }
  }
}
